import {
  accessModeOf,
  appOrigin,
  claimSite,
  createApiKey,
  createMember,
  createSite,
  deleteSite,
  deleteVersion,
  describeSite,
  finalizeVersionByRef,
  getDeployStatus,
  getMember,
  getSiteByRef,
  getTenant,
  listApiKeys,
  listFiles,
  listMembers,
  listSites,
  listVersions,
  parseSettings,
  publishSources,
  readFileSlice,
  removeMember,
  renameSite,
  requireConfirm,
  resolveSiteSlug,
  resolveVersionRef,
  restoreVersion,
  revokeApiKey,
  serializeMember,
  serializeTenant,
  setSiteAccess,
  siteUrl,
  updateMember,
  updateSite,
  updateSiteFiles,
  type DropwayContext,
  type Principal,
  type SiteRow,
} from "@dropway/core";
import type { McpToolDefinition } from "../extensions";
import { CONFIRM_SLUG, FILE_INPUT, PUBLISH_OUT, SETTINGS_INPUT, SITE_OUT, SITE_REF, VERSION_OUT, VERSION_REF, obj } from "./schemas";

/**
 * The core MCP tools. Names, scopes and annotations follow docs/SPEC.md section 9.2.
 * Every handler is a thin call into @dropway/core, so MCP, REST and the dashboard
 * share permissions, limits and errors.
 */

const ANY = { type: "object" } as const;
const ANY_OR_NULL = { type: ["object", "null"] } as const;
const LIST = { type: "array" } as const;
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

async function siteOut(dw: DropwayContext, site: SiteRow) {
  return { ...(await describeSite(dw, site)), access: { mode: accessModeOf(site) } };
}

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
const settingsFrom = (a: Record<string, unknown>) => {
  const picked: Record<string, unknown> = {};
  for (const k of Object.keys(SETTINGS_INPUT)) if (a[k] !== undefined) picked[k] = a[k];
  return parseSettings(picked);
};

function publishSummary(r: any, verb = "Published"): string {
  const v = r.version ? `v${r.version.number}` : "";
  if (r.status === "unchanged") return `Nothing changed: ${r.slug} ${v} already has exactly these files. ${r.url}`;
  if (r.status === "awaiting_upload") return `${r.slug} ${v} is waiting for ${r.files.pending} upload(s): PUT each upload.items[].url, then call finalize_version.`;
  const f = r.files;
  return `${verb} ${r.slug} ${v} (${f.total} files: ${f.stored} new, ${f.reused} reused${f.fetched ? `, ${f.fetched} fetched` : ""}): ${r.url}`;
}

function whoamiPrincipal(p: Principal) {
  if (p.kind === "member") return { kind: "member" as const, memberId: p.memberId, role: p.role, scopes: [...p.scopes], keyId: p.keyId, siteRestriction: p.siteId, via: p.via };
  if (p.kind === "claim") return { kind: "claim_token" as const, siteId: p.siteId };
  return { kind: p.kind };
}

export const CORE_MCP_TOOLS: McpToolDefinition[] = [
  // ------------------------------------------------------------------ core
  {
    name: "whoami",
    title: "Who am I",
    toolset: "core",
    alwaysLoad: true,
    description:
      "Describe this Dropway instance and your credential: who you are (member, role, scopes, single-site restriction), the instance URLs (app, API, MCP, how site URLs look), whether anonymous publishing is on, and the size limits that apply to you. Call it first when unsure what you may do.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: obj({ principal: ANY, tenant: ANY_OR_NULL, member: ANY_OR_NULL, instance: ANY, limits: ANY }, ["principal", "instance", "limits"]),
    annotations: RO,
    async handler(_args, { dw, principal }) {
      const o = appOrigin(dw);
      const tenantId = principal.kind === "member" ? principal.tenantId : null;
      const limits = await dw.adapters.policy.limits(principal, { siteId: principal.kind === "claim" ? principal.siteId : null, tenantId }, dw);
      return {
        principal: whoamiPrincipal(principal),
        tenant: principal.kind === "member" ? serializeTenant(await getTenant(dw, principal.tenantId)) : null,
        member: principal.kind === "member" ? serializeMember(await getMember(dw, principal.memberId)) : null,
        instance: {
          name: dw.config.instanceName,
          appOrigin: o,
          api: `${o}/api/v1`,
          mcp: `${o}/mcp`,
          openapi: `${o}/openapi.json`,
          llms: `${o}/llms.txt`,
          skill: `${o}/skill.md`,
          sitesMode: dw.config.sitesMode,
          exampleSiteUrl: siteUrl(dw, "bright-otter-x7k2"),
          anonymousPublish: dw.config.anonymous.enabled,
          accessModes: ["public", "password"],
          fileSources: ["content", "url", "sha256", "copyFrom"],
        },
        limits,
      };
    },
    summarize: (r) =>
      r.principal.kind === "member"
        ? `You are a ${r.principal.role} of ${r.instance.name} (${r.instance.appOrigin}) with scopes ${r.principal.scopes.join(", ")}${r.principal.siteRestriction ? ", restricted to one site" : ""}.`
        : `You hold a claim token for one anonymous site on ${r.instance.name}.`,
  },
  {
    name: "publish_site",
    title: "Publish a site",
    toolset: "core",
    alwaysLoad: true,
    idempotent: true,
    scopes: ["sites:write"],
    description:
      "Publish files to a live URL in one call. Without `site` a new site with a generated name is created; with `site` set to a slug you own, ALL its files are replaced by `files` (a new immutable version); with a new slug, a site of that name is created. Each file needs a path plus one source: content (text, or base64 for small binaries), url (the server downloads a public https URL), sha256+size (bytes already stored or uploaded afterwards), or copyFrom. Returns status (live, unchanged or awaiting_upload), the live `url` to share exactly as returned, the version, and next steps. To change only some files of an existing site use update_site_files instead. Put index.html (or index.md / README.md) at the root so the URL opens a page.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", minItems: 1, items: FILE_INPUT, description: "Every file of the site." },
        site: { type: "string", description: "Optional. Slug, id or URL of your existing site to replace, or a new slug (3-63 chars: a-z, 0-9, single hyphens)." },
        ...SETTINGS_INPUT,
        password: { type: "string", minLength: 4, maxLength: 200, description: "Optional visitor password (see set_site_access)." },
        message: { type: "string", maxLength: 200, description: "Short note about this version, like a commit message." },
        baseVersionId: { type: "string", description: "Fail with version_conflict if the live version is no longer this one (protects someone else's newer publish)." },
      },
      required: ["files"],
      additionalProperties: false,
    },
    outputSchema: PUBLISH_OUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async handler(a, { dw, principal, client }) {
      return publishSources(dw, principal, { ...a, files: a.files, client, source: "mcp" });
    },
    summarize: (r) => publishSummary(r, r.created ? "Created" : "Published"),
  },
  {
    name: "update_site_files",
    title: "Change some files",
    toolset: "core",
    idempotent: true,
    scopes: ["sites:write"],
    description:
      "Add, replace, delete or move some files of an existing site; every other file carries over unchanged (nothing is re-sent). `files` uses the same sources as publish_site; `delete` takes paths (a trailing / deletes a folder); `move` takes {from, to}. Pass baseVersionId (the version id from your last result) so a newer publish by someone else fails with version_conflict instead of being overwritten; on conflict, read the live files and retry with the new id. Returns the same result as publish_site plus `changes`.",
    inputSchema: {
      type: "object",
      properties: {
        site: SITE_REF,
        files: { type: "array", items: FILE_INPUT, description: "Files to add or replace." },
        delete: { type: "array", items: { type: "string" }, description: 'Paths to delete, e.g. ["old.html", "drafts/"].' },
        move: {
          type: "array",
          items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false },
          description: "Renames inside the site.",
        },
        baseVersionId: { type: "string", description: 'The version your change is based on ("live", "v3" or an id). Default: the live version.' },
        message: { type: "string", maxLength: 200 },
      },
      required: ["site"],
      additionalProperties: false,
    },
    outputSchema: PUBLISH_OUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async handler(a, { dw, principal, client }) {
      return updateSiteFiles(dw, principal, a.site, { files: a.files, delete: a.delete, move: a.move, baseVersionId: a.baseVersionId, message: a.message, client, source: "mcp" });
    },
    summarize: (r) => publishSummary(r, "Updated"),
  },
  {
    name: "finalize_version",
    title: "Make an uploaded version live",
    toolset: "core",
    scopes: ["sites:write"],
    description:
      "Make a pending version live after you uploaded its missing files (publish_site or update_site_files returned status awaiting_upload with upload.items). Safe to call again. If bytes are still missing, the error lists fresh upload items.",
    inputSchema: { type: "object", properties: { site: SITE_REF, versionId: VERSION_REF }, required: ["site", "versionId"], additionalProperties: false },
    outputSchema: PUBLISH_OUT,
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      return finalizeVersionByRef(dw, principal, a.site, a.versionId);
    },
    summarize: (r) => `${r.replayed ? "Already live" : "Live"}: ${r.slug} v${r.version?.number}: ${r.url}`,
  },
  {
    name: "get_site",
    title: "Get a site",
    toolset: "core",
    scopes: ["sites:read"],
    description: "Show one site: live URL, title, settings (spa, renderMarkdown, crossOriginIsolation), access mode, expiry, and the live version (number, file count, size, who published it and when).",
    inputSchema: { type: "object", properties: { site: SITE_REF }, required: ["site"], additionalProperties: false },
    outputSchema: obj({ site: SITE_OUT }, ["site"]),
    annotations: RO,
    async handler(a, { dw, principal }) {
      return { site: await siteOut(dw, await getSiteByRef(dw, principal, a.site)) };
    },
    summarize: (r) => `${r.site.slug}: ${r.site.currentVersion ? `v${r.site.currentVersion.number}, ${r.site.currentVersion.fileCount} files` : "nothing published yet"}, ${r.site.access.mode}: ${r.site.url}`,
  },
  {
    name: "list_sites",
    title: "List sites",
    toolset: "core",
    scopes: ["sites:read"],
    description: "List your sites, newest first, with their live URLs and live versions. Pages of up to 200; pass nextCursor back as cursor for the next page.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." }, cursor: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: obj({ sites: { type: "array", items: SITE_OUT }, nextCursor: { type: ["string", "null"] } }, ["sites"]),
    annotations: RO,
    async handler(a, { dw, principal }) {
      return listSites(dw, principal, { limit: a.limit as number | undefined, cursor: str(a.cursor) ?? null });
    },
    summarize: (r) => `${r.sites.length} site(s)${r.nextCursor ? " (more: pass nextCursor)" : ""}.`,
  },
  {
    name: "list_files",
    title: "List files",
    toolset: "core",
    scopes: ["sites:read"],
    description:
      "List the files of a site version (default: live): path, size, sha256, content type, viewer kind, the public `url` of each file and its `rawUrl` in the API. Filter with prefix; pages of up to 1000 (pass nextCursor back as cursor).",
    inputSchema: {
      type: "object",
      properties: {
        site: SITE_REF,
        version: VERSION_REF,
        prefix: { type: "string", description: 'Only paths starting with this, e.g. "assets/".' },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Default 200." },
        cursor: { type: "string" },
      },
      required: ["site"],
      additionalProperties: false,
    },
    outputSchema: obj({ site: { type: "string" }, version: { anyOf: [VERSION_OUT, { type: "null" }] }, files: { type: "array", items: ANY }, total: { type: "integer" }, nextCursor: { type: ["string", "null"] } }, ["files"]),
    annotations: RO,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site);
      const version = a.version === undefined ? null : await resolveVersionRef(dw, site, a.version);
      const listed = await listFiles(dw, site, version?.id ?? null);
      const prefix = str(a.prefix) ?? "";
      const matching = prefix ? listed.files.filter((f) => f.path.startsWith(prefix)) : listed.files;
      const start = Math.max(0, Number(a.cursor ?? 0) || 0);
      const limit = Math.min(1000, Math.max(1, Number(a.limit ?? 200) || 200));
      const page = matching.slice(start, start + limit);
      return { site: site.slug, version: listed.version, files: page, total: matching.length, nextCursor: start + limit < matching.length ? String(start + limit) : null };
    },
    summarize: (r) => `${r.total} file(s) in ${r.site}${r.version ? ` v${r.version.number}` : ""}${r.nextCursor ? `; showing ${r.files.length}` : ""}.`,
  },
  {
    name: "read_file",
    title: "Read a file",
    toolset: "core",
    scopes: ["sites:read"],
    description:
      "Read back one published file. Text types return UTF-8 text; images and other binaries return base64 (force either with encoding). Reads up to 64 KB by default (max 1 MB per call); when truncated, call again with offset = nextOffset. Use it to check what you published.",
    inputSchema: {
      type: "object",
      properties: {
        site: SITE_REF,
        path: { type: "string", description: 'File path, e.g. "index.html".' },
        version: VERSION_REF,
        encoding: { type: "string", enum: ["auto", "text", "base64"], description: 'Default "auto".' },
        offset: { type: "integer", minimum: 0, description: "Byte offset to start at. Default 0." },
        length: { type: "integer", minimum: 1, maximum: 1048576, description: "Bytes to read. Default 65536." },
      },
      required: ["site", "path"],
      additionalProperties: false,
    },
    outputSchema: obj(
      {
        path: { type: "string" },
        versionId: { type: "string" },
        contentType: { type: "string" },
        kind: { type: "string" },
        size: { type: "integer" },
        sha256: { type: "string" },
        encoding: { type: "string" },
        offset: { type: "integer" },
        length: { type: "integer" },
        truncated: { type: "boolean" },
        nextOffset: { type: ["integer", "null"] },
        content: { type: "string" },
        url: { type: "string" },
        rawUrl: { type: "string" },
      },
      ["path", "content", "encoding", "size"],
    ),
    annotations: RO,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site);
      const version = a.version === undefined ? null : await resolveVersionRef(dw, site, a.version);
      return readFileSlice(dw, site, a.path, { version, offset: a.offset, length: a.length, encoding: a.encoding });
    },
    summarize: (r) => `${r.path}: ${r.size} bytes ${r.contentType}${r.truncated ? `, showing bytes ${r.offset}-${r.offset + r.length} (next offset ${r.nextOffset})` : ""}.`,
  },
  {
    name: "list_versions",
    title: "List versions",
    toolset: "core",
    scopes: ["sites:read"],
    description: "List the immutable versions of a site, newest first: number, live flag, file count, size, source, client and message. Restore any of them with restore_version.",
    inputSchema: { type: "object", properties: { site: SITE_REF, limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 50." } }, required: ["site"], additionalProperties: false },
    outputSchema: obj({ site: { type: "string" }, liveVersionId: { type: ["string", "null"] }, versions: { type: "array", items: VERSION_OUT } }, ["versions"]),
    annotations: RO,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site);
      return { site: site.slug, liveVersionId: site.current_version_id, versions: await listVersions(dw, site, { limit: a.limit as number | undefined }) };
    },
    summarize: (r) => `${r.versions.length} version(s) of ${r.site}; live is ${r.versions.find((v: any) => v.live)?.number ? `v${r.versions.find((v: any) => v.live).number}` : "none"}.`,
  },
  {
    name: "restore_version",
    title: "Restore a version",
    toolset: "core",
    scopes: ["sites:write"],
    description: 'Make an older version live again (instant rollback; nothing is copied). version accepts "v3", "3" or a version id. Restoring the version that is already live is a harmless no-op.',
    inputSchema: { type: "object", properties: { site: SITE_REF, version: VERSION_REF }, required: ["site", "version"], additionalProperties: false },
    outputSchema: obj({ restored: { type: "boolean" }, alreadyLive: { type: "boolean" }, version: VERSION_OUT, url: { type: "string" }, slug: { type: "string" } }, ["restored", "version", "url"]),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site, "sites:write");
      const version = await resolveVersionRef(dw, site, a.version);
      const out = await restoreVersion(dw, principal, site, version.id);
      return { ...out, slug: site.slug, url: siteUrl(dw, site.slug) };
    },
    summarize: (r) => (r.alreadyLive ? `v${r.version.number} of ${r.slug} was already live: ${r.url}` : `Restored ${r.slug} to v${r.version.number}: ${r.url}`),
  },
  {
    name: "update_site_settings",
    title: "Change site settings",
    toolset: "core",
    scopes: ["sites:write"],
    description:
      "Change a site's title, description or serving settings: spa (unknown paths serve index.html, for single-page apps), renderMarkdown (browsers see .md rendered; false serves raw), crossOriginIsolation (COOP/COEP headers for SharedArrayBuffer). Only the fields you pass change. Passwords: set_site_access.",
    inputSchema: { type: "object", properties: { site: SITE_REF, ...SETTINGS_INPUT }, required: ["site"], additionalProperties: false },
    outputSchema: obj({ site: SITE_OUT }, ["site"]),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const slug = await resolveSiteSlug(dw, a.site);
      return { site: await siteOut(dw, await updateSite(dw, principal, slug, settingsFrom(a))) };
    },
    summarize: (r) => `Updated ${r.site.slug}: spa ${r.site.settings.spa}, renderMarkdown ${r.site.settings.renderMarkdown}, crossOriginIsolation ${r.site.settings.crossOriginIsolation}.`,
  },
  {
    name: "set_site_access",
    title: "Set who can open a site",
    toolset: "core",
    scopes: ["sites:write"],
    description:
      'Set a site\'s access mode. "public": anyone with the link. "password": visitors must enter the password (stored hashed; changing it signs everyone out). Modes "restricted" and "private" are not available on this edition yet and return feature_unavailable.',
    inputSchema: {
      type: "object",
      properties: {
        site: SITE_REF,
        mode: { type: "string", enum: ["public", "password", "restricted", "private"] },
        password: { type: "string", minLength: 4, maxLength: 200, description: 'Required for mode "password".' },
      },
      required: ["site", "mode"],
      additionalProperties: false,
    },
    outputSchema: obj({ site: SITE_OUT, access: ANY }, ["site", "access"]),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const out = await setSiteAccess(dw, principal, a.site, { mode: a.mode, password: a.password });
      return { site: await siteOut(dw, out.site), access: { mode: out.mode } };
    },
    summarize: (r) => `${r.site.slug} is now ${r.access.mode === "password" ? "password-protected" : "public"}: ${r.site.url}`,
  },
  {
    name: "delete_site",
    title: "Delete a site",
    toolset: "core",
    scopes: ["sites:write"],
    description: "Delete a site and all its versions. Its URL stops working at once and the slug becomes free. Set confirm to the site's slug.",
    inputSchema: { type: "object", properties: { site: SITE_REF, confirm: CONFIRM_SLUG }, required: ["site", "confirm"], additionalProperties: false },
    outputSchema: obj({ deleted: { type: "boolean" }, slug: { type: "string" } }, ["deleted", "slug"]),
    annotations: DESTROY,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site, "sites:write");
      requireConfirm(a.confirm, site.slug);
      return deleteSite(dw, principal, site.slug);
    },
    summarize: (r) => `Deleted ${r.slug}.`,
  },
  {
    name: "claim_site",
    title: "Claim an anonymous site",
    toolset: "core",
    scopes: ["sites:write"],
    enabled: (dw) => dw.config.anonymous.enabled,
    description: "Move an anonymous site (published without a key, so it expires) into your account using the claimToken from its publish response. It stops expiring and the claim token stops working.",
    inputSchema: { type: "object", properties: { site: SITE_REF, claimToken: { type: "string", pattern: "^dwc_" } }, required: ["site", "claimToken"], additionalProperties: false },
    outputSchema: obj({ claimed: { type: "boolean" }, site: SITE_OUT }, ["claimed", "site"]),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const site = await claimSite(dw, principal, await resolveSiteSlug(dw, a.site), a.claimToken);
      return { claimed: true, site: await siteOut(dw, site) };
    },
    summarize: (r) => `Claimed ${r.site.slug}; it no longer expires: ${r.site.url}`,
  },

  // ------------------------------------------------------------------ sites
  {
    name: "create_site",
    title: "Create an empty site",
    toolset: "sites",
    idempotent: true,
    scopes: ["sites:write"],
    description: "Reserve a site (optionally with a chosen slug and settings) without publishing files yet. Usually you do not need this: publish_site creates the site and publishes in one call.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "3-63 chars: a-z, 0-9, single hyphens. Omit for a generated name." }, ...SETTINGS_INPUT },
      additionalProperties: false,
    },
    outputSchema: obj({ site: SITE_OUT, url: { type: "string" }, slug: { type: "string" } }, ["site", "url"]),
    annotations: CREATE,
    async handler(a, { dw, principal }) {
      const { site } = await createSite(dw, principal, { slug: str(a.slug) ?? null, ...settingsFrom(a) });
      return { site: await siteOut(dw, site), slug: site.slug, url: siteUrl(dw, site.slug) };
    },
    summarize: (r) => `Created empty site ${r.slug}; publish files with publish_site (site: "${r.slug}").`,
  },
  {
    name: "rename_site",
    title: "Rename a site",
    toolset: "sites",
    scopes: ["sites:write"],
    description: "Give a site a new slug, which changes its URL. The old URL stops working immediately (no redirect yet), so update any links you shared.",
    inputSchema: {
      type: "object",
      properties: { site: SITE_REF, newSlug: { type: "string", description: "3-63 chars: a-z, 0-9, single hyphens." } },
      required: ["site", "newSlug"],
      additionalProperties: false,
    },
    outputSchema: obj({ renamed: { type: "boolean" }, oldSlug: { type: "string" }, slug: { type: "string" }, url: { type: "string" }, site: SITE_OUT, warnings: LIST }, ["renamed", "slug", "url"]),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const out = await renameSite(dw, principal, a.site, a.newSlug);
      return {
        renamed: out.renamed,
        oldSlug: out.oldSlug,
        slug: out.site.slug,
        url: siteUrl(dw, out.site.slug),
        site: await siteOut(dw, out.site),
        warnings: out.renamed ? [{ code: "old_url_gone", message: `${siteUrl(dw, out.oldSlug)} no longer works.` }] : [],
      };
    },
    summarize: (r) => (r.renamed ? `Renamed ${r.oldSlug} to ${r.slug}: ${r.url}` : `${r.slug} already has that name.`),
  },

  // ------------------------------------------------------------------ versions
  {
    name: "get_version",
    title: "Get a version",
    toolset: "versions",
    scopes: ["sites:read"],
    description: 'Show one version ("live", "v3", "3" or an id): status, number, file count, size, source, client, message. For a pending version, `missing` lists the sha256 of files still to upload.',
    inputSchema: { type: "object", properties: { site: SITE_REF, version: VERSION_REF }, required: ["site", "version"], additionalProperties: false },
    outputSchema: obj({ site: { type: "string" }, version: VERSION_OUT, missing: { type: "array", items: { type: "string" } } }, ["version"]),
    annotations: RO,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site);
      const v = await resolveVersionRef(dw, site, a.version);
      const status = await getDeployStatus(dw, site, v.id);
      return { site: site.slug, version: status.deploy, missing: status.missing };
    },
    summarize: (r) => `${r.site} v${r.version.number}: ${r.version.status}${r.version.live ? ", live" : ""}, ${r.version.fileCount} files${r.missing.length ? `, ${r.missing.length} missing` : ""}.`,
  },
  {
    name: "delete_version",
    title: "Delete a version",
    toolset: "versions",
    scopes: ["sites:write"],
    description: "Permanently delete one version that is not live (for example one that leaked a secret). The live version cannot be deleted: restore or publish another first. Set confirm to the site's slug.",
    inputSchema: { type: "object", properties: { site: SITE_REF, version: VERSION_REF, confirm: CONFIRM_SLUG }, required: ["site", "version", "confirm"], additionalProperties: false },
    outputSchema: obj({ deleted: { type: "boolean" }, id: { type: "string" } }, ["deleted", "id"]),
    annotations: DESTROY,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site, "sites:write");
      requireConfirm(a.confirm, site.slug);
      const v = await resolveVersionRef(dw, site, a.version);
      return deleteVersion(dw, site, v.id);
    },
    summarize: (r) => `Deleted version ${r.id}.`,
  },

  // ------------------------------------------------------------------ keys
  {
    name: "list_api_keys",
    title: "List API keys",
    toolset: "keys",
    scopes: ["keys:write"],
    description: "List active API keys (never the secrets): id, name, prefix, scopes, site restriction, expiry, last use. all=true lists every member's keys (needs members:write).",
    inputSchema: { type: "object", properties: { all: { type: "boolean" } }, additionalProperties: false },
    outputSchema: obj({ keys: { type: "array", items: ANY } }, ["keys"]),
    annotations: RO,
    async handler(a, { dw, principal }) {
      return { keys: await listApiKeys(dw, principal, { all: a.all === true }) };
    },
    summarize: (r) => `${r.keys.length} active key(s).`,
  },
  {
    name: "create_api_key",
    title: "Create an API key",
    toolset: "keys",
    idempotent: true,
    scopes: ["keys:write"],
    description:
      'Create a scoped API key, for example a read-only key or a key limited to one site to hand to another agent. Scopes: sites:read, sites:write, keys:write, members:write (never wider than your own key). The secret `key` is shown ONCE in this result; store it. A replayed idempotent call returns key: null.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 120 },
        scopes: { type: "array", items: { type: "string", enum: ["sites:read", "sites:write", "keys:write", "members:write"] }, description: "Default: all scopes you hold." },
        site: { type: "string", description: "Restrict the key to this one site (slug)." },
        expiresInDays: { type: "number", exclusiveMinimum: 0 },
        memberId: { type: "string", description: "Create the key for another member (needs members:write)." },
      },
      additionalProperties: false,
    },
    outputSchema: obj({ id: { type: "string" }, key: { type: ["string", "null"] }, scopes: { type: "array", items: { type: "string" } }, siteId: { type: ["string", "null"] } }, ["id"]),
    annotations: CREATE,
    redactForReplay: (r: any) => ({ ...r, key: null, note: "Replayed: the secret was shown only in the first response. If it is lost, revoke this key and create a new one." }),
    async handler(a, { dw, principal }) {
      const site = a.site === undefined ? undefined : await resolveSiteSlug(dw, a.site);
      return { ...(await createApiKey(dw, principal, { name: a.name, scopes: a.scopes, expiresInDays: a.expiresInDays, memberId: a.memberId, site })), note: "Store key now; it is shown only once." };
    },
    summarize: (r) => `Created key ${r.id} (${(r.scopes ?? []).join(", ")})${r.key ? "; the secret is in `key`, shown once" : ""}.`,
  },
  {
    name: "revoke_api_key",
    title: "Revoke an API key",
    toolset: "keys",
    scopes: ["keys:write"],
    description: "Revoke an API key by id (from list_api_keys). It stops working at once. You can revoke your own keys, or anyone's with members:write.",
    inputSchema: { type: "object", properties: { id: { type: "string", pattern: "^key_" } }, required: ["id"], additionalProperties: false },
    outputSchema: obj({ revoked: { type: "boolean" }, id: { type: "string" } }, ["revoked", "id"]),
    annotations: DESTROY,
    async handler(a, { dw, principal }) {
      return revokeApiKey(dw, principal, String(a.id));
    },
    summarize: (r) => `Revoked key ${r.id}.`,
  },

  // ------------------------------------------------------------------ members
  {
    name: "list_members",
    title: "List members",
    toolset: "members",
    scopes: ["sites:read"],
    description: "List the members of this instance: id, email, name, role (owner, admin, member).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: obj({ members: { type: "array", items: ANY } }, ["members"]),
    annotations: RO,
    async handler(_a, { dw, principal }) {
      return { members: await listMembers(dw, principal) };
    },
    summarize: (r) => `${r.members.length} member(s).`,
  },
  {
    name: "add_member",
    title: "Add a member",
    toolset: "members",
    idempotent: true,
    scopes: ["members:write"],
    description: "Add a person or agent as a member (role member or admin; owners need an owner key). Returns their first API key, shown ONCE: hand it to them.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string" },
        name: { type: "string", maxLength: 120 },
        role: { type: "string", enum: ["owner", "admin", "member"], description: 'Default "member".' },
        scopes: { type: "array", items: { type: "string", enum: ["sites:read", "sites:write", "keys:write", "members:write"] } },
      },
      additionalProperties: false,
    },
    outputSchema: obj({ member: ANY, apiKey: ANY }, ["member", "apiKey"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    redactForReplay: (r: any) => ({ ...r, apiKey: { ...r.apiKey, key: null }, note: "Replayed: the secret was shown only in the first response." }),
    async handler(a, { dw, principal }) {
      return { ...(await createMember(dw, principal, { email: a.email, name: a.name, role: a.role, scopes: a.scopes })), note: "Give apiKey.key to the new member; it is shown only once." };
    },
    summarize: (r) => `Added ${r.member.email ?? r.member.id} as ${r.member.role}.`,
  },
  {
    name: "update_member",
    title: "Change a member",
    toolset: "members",
    scopes: ["members:write"],
    description: "Change a member's name or role. Only owners can grant or remove the owner role, and an instance always keeps one owner.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", pattern: "^mem_" }, name: { type: ["string", "null"] }, role: { type: "string", enum: ["owner", "admin", "member"] } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: obj({ member: ANY }, ["member"]),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      return { member: await updateMember(dw, principal, String(a.id), { name: a.name, role: a.role }) };
    },
    summarize: (r) => `${r.member.email ?? r.member.id} is now ${r.member.role}.`,
  },
  {
    name: "remove_member",
    title: "Remove a member",
    toolset: "members",
    scopes: ["members:write"],
    description: "Remove a member and revoke all their API keys. Their sites stay. Set confirm to the member's email (or id when they have no email).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", pattern: "^mem_" }, confirm: { type: "string", description: "The member's email (or id if they have none)." } },
      required: ["id", "confirm"],
      additionalProperties: false,
    },
    outputSchema: obj({ removed: { type: "boolean" }, id: { type: "string" } }, ["removed", "id"]),
    annotations: DESTROY,
    async handler(a, { dw, principal }) {
      const id = String(a.id);
      const m = (await listMembers(dw, principal)).find((x) => x.id === id);
      if (m) requireConfirm(a.confirm, m.email ?? m.id, "the member's email");
      return removeMember(dw, principal, id);
    },
    summarize: (r) => `Removed member ${r.id} and revoked their keys.`,
  },
];
