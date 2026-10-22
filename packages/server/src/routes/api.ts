import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import {
  ApiError,
  anonymousDisabled,
  appOrigin,
  badRequest,
  claimSite,
  createApiKey,
  createDeploy,
  createMember,
  createSiteWithDeploy,
  deleteSite,
  deleteVersion,
  describeSite,
  finalizeDeploy,
  getDeployStatus,
  getFile,
  getMember,
  getSiteFor,
  getTenant,
  isHtml,
  isTextual,
  listApiKeys,
  listFiles,
  listMembers,
  listSites,
  listVersions,
  normaliseFilePath,
  notFound,
  parsePublishRequest,
  parseSettings,
  publishFiles,
  readBlob,
  recoverOwnerKey,
  removeMember,
  restoreVersion,
  revokeApiKey,
  serializeMember,
  serializeSite,
  serializeTenant,
  setupInstance,
  siteUrl,
  updateMember,
  updateSite,
  uploadBlob,
} from "@dropway/core";
import type { DropwayEnv } from "../env";

/**
 * REST API v1, mounted at /api/v1 on the app origin.
 * Routes stay thin: parse input, call a service from @dropway/core, shape JSON.
 * The MCP server calls the same services, so both surfaces behave the same.
 */

export async function readJson(c: Context<DropwayEnv>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw badRequest("invalid_json", "The request body must be a JSON object.", "Send Content-Type: application/json with an object body.");
}

const P = (c: Context<DropwayEnv>) => c.get("principal");
const D = (c: Context<DropwayEnv>) => c.get("dw");
const clientOf = (c: Context<DropwayEnv>) => c.req.header("x-dropway-client") ?? null;

export function apiErrorResponse(c: Context<DropwayEnv>, err: unknown): Response {
  const requestId = c.get("requestId");
  if (err instanceof ApiError) {
    if (err.status === 429 && err.details?.retryAfterSeconds) c.header("Retry-After", String(err.details.retryAfterSeconds));
    return c.json(err.toJSON(requestId), err.status as 400);
  }
  console.error(JSON.stringify({ event: "api_error", requestId, path: c.req.path, error: String(err), stack: (err as Error)?.stack }));
  return c.json(new ApiError(500, "internal_error", "Something went wrong on our side.", "Retry the request; if it keeps failing, report the requestId.").toJSON(requestId), 500);
}

/** CORS, principal resolution (identity adapter), error shaping, then extension middleware. */
export function installApiMiddleware(api: Hono<DropwayEnv>, middleware: MiddlewareHandler<DropwayEnv>[]) {
  api.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Authorization", "Content-Type", "X-Dropway-Path", "X-Dropway-Client", "If-None-Match"],
      allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["ETag", "X-Request-Id", "X-Dropway-Version", "X-Dropway-Content-Type", "Retry-After"],
      maxAge: 86400,
    }),
  );
  // Resolve the caller once, through the identity adapter.
  api.use("*", async (c, next) => {
    const dw = D(c);
    c.set("principal", await dw.adapters.identity.resolve(c.req.raw, dw));
    await next();
    c.header("X-Request-Id", c.get("requestId"));
  });
  for (const mw of middleware) api.use("*", mw);
  api.onError((err, c) => apiErrorResponse(c, err));
}

/** Core REST routes. Call after extension routes so extensions can override them. */
export function installApiRoutes(api: Hono<DropwayEnv>) {
  // ------------------------------------------------------------ index + identity

  api.get("/", (c) => {
    const o = appOrigin(D(c));
    return c.json({
      name: `${D(c).config.instanceName} API`,
      version: "v1",
      openapi: `${o}/openapi.json`,
      llms: `${o}/llms.txt`,
      quickstart: `curl -H "Authorization: Bearer $DROPWAY_API_KEY" -F "index.html=@index.html" ${o}/api/v1/publish`,
    });
  });

  api.get("/me", async (c) => {
    const p = P(c);
    const dw = D(c);
    if (p.kind === "member") {
      return c.json({
        principal: "member",
        tenant: serializeTenant(await getTenant(dw, p.tenantId)),
        member: serializeMember(await getMember(dw, p.memberId)),
        keyId: p.keyId,
        scopes: p.scopes,
        siteRestriction: p.siteId,
      });
    }
    if (p.kind === "claim") return c.json({ principal: "claim_token", siteId: p.siteId });
    return c.json({ principal: p.kind, anonymousPublish: dw.config.anonymous.enabled });
  });

  // ------------------------------------------------------------ setup (bootstrap key)

  const setup = async (c: Context<DropwayEnv>) => {
    const body = await readJson(c);
    const out = await setupInstance(D(c), P(c), body);
    return c.json({ ...out, note: "Store apiKey.key now; it is shown only once. Use it as `Authorization: Bearer <key>`." }, 201);
  };
  api.post("/setup", setup);
  /** Alias kept for the original API sketch: creates the owner on first run. */
  api.post("/accounts", setup);
  api.post("/setup/recover", async (c) => c.json({ ...(await recoverOwnerKey(D(c), P(c))), note: "Store apiKey.key now; it is shown only once." }, 201));

  // ------------------------------------------------------------ members

  api.get("/members", async (c) => c.json({ members: await listMembers(D(c), P(c)) }));
  api.post("/members", async (c) => c.json({ ...(await createMember(D(c), P(c), await readJson(c))), note: "Give apiKey.key to the new member; it is shown only once." }, 201));
  api.patch("/members/:id", async (c) => c.json({ member: await updateMember(D(c), P(c), c.req.param("id"), await readJson(c)) }));
  api.delete("/members/:id", async (c) => c.json(await removeMember(D(c), P(c), c.req.param("id"))));

  // ------------------------------------------------------------ API keys

  api.get("/keys", async (c) => c.json({ keys: await listApiKeys(D(c), P(c), { all: c.req.query("all") === "1" || c.req.query("all") === "true" }) }));
  api.post("/keys", async (c) => {
    const body = await readJson(c);
    const key = await createApiKey(D(c), P(c), body);
    return c.json({ ...key, note: "Store key now; it is shown only once." }, 201);
  });
  api.delete("/keys/:id", async (c) => c.json(await revokeApiKey(D(c), P(c), c.req.param("id"))));

  // ------------------------------------------------------------ one-shot publish

  api.post("/publish", async (c) => {
    const dw = D(c);
    const p = P(c);
    if (p.kind === "anonymous" && !dw.config.anonymous.enabled) throw anonymousDisabled();
    const lim = await dw.adapters.policy.limits(p, { siteId: null, tenantId: p.kind === "member" ? p.tenantId : null }, dw);
    const input = await parsePublishRequest(dw, c.req.raw, lim.oneShotMaxBytes);
    const out = await publishFiles(dw, p, input, { client: clientOf(c) });
    return c.json(out, out.created ? 201 : 200);
  });

  // ------------------------------------------------------------ sites

  api.post("/sites", async (c) => {
    const dw = D(c);
    const p = P(c);
    const body = await readJson(c);
    // Validates `files` before the site exists and removes the site again if its deploy fails.
    const { site, claimToken, deploy } = await createSiteWithDeploy(dw, p, { slug: (body.slug as string | undefined) ?? null, ...parseSettings(body) }, body.files, {
      message: body.message,
      client: clientOf(c),
      source: "api",
    });
    const out: Record<string, unknown> = { site: serializeSite(dw, site, null), url: siteUrl(dw, site.slug) };
    if (claimToken) {
      out.claimToken = claimToken;
      out.claimUrl = `${appOrigin(dw)}/claim?slug=${site.slug}#token=${claimToken}`;
      out.expiresAt = site.expires_at ? new Date(site.expires_at).toISOString() : null;
      out.note = "Anonymous site: it expires. Use `Authorization: Bearer <claimToken>` for deploys and uploads to it.";
    }
    if (deploy) out.deploy = deploy;
    return c.json(out, 201);
  });

  api.get("/sites", async (c) => c.json(await listSites(D(c), P(c), { limit: Number(c.req.query("limit")) || undefined, cursor: c.req.query("cursor") ?? null })));

  api.get("/sites/:slug", async (c) => {
    const site = await getSiteFor(D(c), P(c), c.req.param("slug"));
    return c.json({ site: await describeSite(D(c), site) });
  });

  api.patch("/sites/:slug", async (c) => {
    const site = await updateSite(D(c), P(c), c.req.param("slug"), parseSettings(await readJson(c)));
    return c.json({ site: await describeSite(D(c), site) });
  });

  api.delete("/sites/:slug", async (c) => c.json(await deleteSite(D(c), P(c), c.req.param("slug"))));

  api.post("/sites/:slug/claim", async (c) => {
    const body = await readJson(c);
    const site = await claimSite(D(c), P(c), c.req.param("slug"), body.claimToken);
    return c.json({ claimed: true, site: await describeSite(D(c), site) });
  });

  // ------------------------------------------------------------ deploys (manifest flow)

  api.post("/sites/:slug/deploys", async (c) => {
    const dw = D(c);
    const p = P(c);
    let site = await getSiteFor(dw, p, c.req.param("slug"), "sites:write");
    const body = await readJson(c);
    const settings = parseSettings(body);
    if (Object.keys(settings).length) site = await updateSite(dw, p, site.slug, settings);
    const out = await createDeploy(dw, p, site, body.files, { message: body.message, client: clientOf(c), baseVersionId: body.baseVersionId, source: "api" });
    return c.json(out, out.unchanged ? 200 : 201);
  });

  api.get("/sites/:slug/deploys/:id", async (c) => {
    const site = await getSiteFor(D(c), P(c), c.req.param("slug"));
    return c.json(await getDeployStatus(D(c), site, c.req.param("id")));
  });

  api.post("/sites/:slug/deploys/:id/finalize", async (c) => {
    const dw = D(c);
    const site = await getSiteFor(dw, P(c), c.req.param("slug"), "sites:write");
    const result = await finalizeDeploy(dw, P(c), site, c.req.param("id"));
    const fresh = await getSiteFor(dw, P(c), site.slug);
    return c.json({ url: siteUrl(dw, site.slug), live: result.live, replayed: result.replayed, site: await describeSite(dw, fresh), warnings: result.warnings });
  });

  api.on(["PUT", "POST"], "/blobs/:sha256", async (c) => {
    const len = c.req.header("content-length");
    const out = await uploadBlob(D(c), P(c), c.req.param("sha256"), c.req.raw.body, len === undefined ? null : Number(len), c.req.header("content-type") ?? null);
    return c.json(out, out.existed ? 200 : 201);
  });

  // ------------------------------------------------------------ versions

  api.get("/sites/:slug/versions", async (c) => {
    const site = await getSiteFor(D(c), P(c), c.req.param("slug"));
    return c.json({ currentVersionId: site.current_version_id, versions: await listVersions(D(c), site, { limit: Number(c.req.query("limit")) || undefined }) });
  });

  api.post("/sites/:slug/versions/:id/restore", async (c) => {
    const dw = D(c);
    const site = await getSiteFor(dw, P(c), c.req.param("slug"), "sites:write");
    const out = await restoreVersion(dw, P(c), site, c.req.param("id"));
    return c.json({ ...out, url: siteUrl(dw, site.slug) });
  });

  api.delete("/sites/:slug/versions/:id", async (c) => {
    const site = await getSiteFor(D(c), P(c), c.req.param("slug"), "sites:write");
    return c.json(await deleteVersion(D(c), site, c.req.param("id")));
  });

  // ------------------------------------------------------------ read-back

  api.get("/sites/:slug/files", async (c) => {
    const site = await getSiteFor(D(c), P(c), c.req.param("slug"));
    return c.json(await listFiles(D(c), site, c.req.query("version") ?? null));
  });

  api.on(["GET", "HEAD"], "/sites/:slug/files/:path{.+}", async (c) => {
    const dw = D(c);
    const site = await getSiteFor(dw, P(c), c.req.param("slug"));
    const path = normaliseFilePath(c.req.param("path"));
    const versionId = c.req.query("version") ?? site.current_version_id;
    const file = await getFile(dw, site, path, versionId);
    if (!file) throw notFound("file_not_found", `No file "${path}" in this version.`, "List files with GET /api/v1/sites/:slug/files.");
    const headers: Record<string, string> = {
      // Never render user content on the app origin: textual types come back as text/plain.
      "Content-Type": isTextual(file.content_type) || isHtml(file.content_type) ? "text/plain; charset=utf-8" : file.content_type,
      "X-Dropway-Content-Type": file.content_type,
      "X-Dropway-Version": versionId ?? "",
      "Content-Length": String(file.size),
      ETag: `"${file.sha256}"`,
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    };
    if (c.req.method === "HEAD") return c.body(null, 200, headers);
    if (c.req.header("if-none-match") === `"${file.sha256}"`) return c.body(null, 304, headers);
    const blob = await readBlob(dw, file.sha256, file.size);
    if (!blob) throw new ApiError(502, "blob_missing", "The file is listed but its contents could not be read.", "Retry shortly.");
    return new Response(blob.body, { status: 200, headers });
  });
}
