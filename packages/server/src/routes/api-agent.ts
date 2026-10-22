import type { Context, Hono } from "hono";
import {
  accessModeOf,
  describeSite,
  getDeployStatus,
  getSiteByRef,
  idempotencyScope,
  renameSite,
  resolveVersionRef,
  setSiteAccess,
  siteUrl,
  updateSiteFiles,
  validateIdempotencyKey,
  withIdempotency,
} from "@dropway/core";
import type { DropwayEnv } from "../env";
import { readJson } from "./api";

/**
 * REST twins of the agent operations added with the MCP server, so every MCP tool
 * has a REST route with the same name (OpenAPI operationId = MCP tool name):
 * update_site_files, set_site_access, rename_site, get_version.
 * Thin: parse, call the @dropway/core service, shape JSON.
 */
export function installAgentApiRoutes(api: Hono<DropwayEnv>) {
  const D = (c: Context<DropwayEnv>) => c.get("dw");
  const P = (c: Context<DropwayEnv>) => c.get("principal");

  api.patch("/sites/:slug/files", async (c) => {
    const dw = D(c);
    const p = P(c);
    const body = await readJson(c);
    const key = validateIdempotencyKey(c.req.header("idempotency-key"));
    const { result, replayed } = await withIdempotency(dw, { scope: idempotencyScope(p), operation: "rest:update_site_files", key, input: { site: c.req.param("slug"), body } }, () =>
      updateSiteFiles(dw, p, c.req.param("slug"), {
        files: body.files,
        delete: body.delete,
        move: body.move,
        baseVersionId: body.baseVersionId,
        message: body.message,
        client: c.req.header("x-dropway-client") ?? null,
        source: "api",
      }),
    );
    return c.json(replayed ? { ...result, replayed: true } : result, result.status === "awaiting_upload" ? 202 : 200);
  });

  api.put("/sites/:slug/access", async (c) => {
    const body = await readJson(c);
    const out = await setSiteAccess(D(c), P(c), c.req.param("slug"), { mode: body.mode, password: body.password });
    return c.json({ site: { ...(await describeSite(D(c), out.site)), access: { mode: out.mode } }, access: { mode: out.mode } });
  });

  api.post("/sites/:slug/rename", async (c) => {
    const body = await readJson(c);
    const out = await renameSite(D(c), P(c), c.req.param("slug"), body.newSlug ?? body.slug);
    return c.json({
      renamed: out.renamed,
      oldSlug: out.oldSlug,
      slug: out.site.slug,
      url: siteUrl(D(c), out.site.slug),
      site: { ...(await describeSite(D(c), out.site)), access: { mode: accessModeOf(out.site) } },
    });
  });

  api.get("/sites/:slug/versions/:version", async (c) => {
    const site = await getSiteByRef(D(c), P(c), c.req.param("slug"));
    const v = await resolveVersionRef(D(c), site, c.req.param("version"));
    const status = await getDeployStatus(D(c), site, v.id);
    return c.json({ site: site.slug, version: status.deploy, missing: status.missing });
  });
}
