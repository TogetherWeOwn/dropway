/**
 * OpenAPI 3.1 description of every route this instance serves (served at /openapi.json).
 *
 * operationId = the MCP tool name (snake_case), so REST, MCP and docs use one vocabulary.
 * Each operation says how it maps to MCP: `x-mcp-tool` names the tool, or `x-mcp-exclude`
 * gives the reason it has none (raw bytes, bootstrap-only, browser pages).
 * A test checks that every Hono route has an entry here. Extensions add their own paths
 * by post-processing buildOpenApi()'s result.
 */

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Json, description = "OK") => ({ description, content: { "application/json": { schema } } });
const text = (description: string, type = "text/plain") => ({ description, content: { [type]: { schema: { type: "string" } } } });
const slugParam = { name: "slug", in: "path", required: true, schema: { type: "string" }, description: "Site slug, e.g. bright-otter-x7k2 (routes marked as such also accept a site id)." };
const pathParam = (name: string, description: string) => ({ name, in: "path", required: true, schema: { type: "string" }, description });
const query = (name: string, schema: Json, description?: string) => ({ name, in: "query", required: false, schema, ...(description ? { description } : {}) });
const idempotencyHeader = { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 255 }, description: "Retry-safe writes: the same key and body within 24 h replays the first result." };
const body = (schema: Json, required = true) => ({ required, content: { "application/json": { schema } } });
const errors = { default: json(ref("Error"), "Error: { error: { code, message, hint?, details? }, requestId }") };

interface OpOptions {
  tags: string[];
  description?: string;
  params?: Json[];
  requestBody?: Json;
  responses?: Json;
  /** false = no credential needed. */
  security?: boolean;
  /** MCP tool with the same behaviour (defaults to the operationId). */
  mcpTool?: string;
  /** Why there is no MCP tool. */
  mcpExclude?: string;
  deprecated?: boolean;
}

function op(operationId: string, summary: string, o: OpOptions) {
  return {
    operationId,
    summary,
    tags: o.tags,
    ...(o.description ? { description: o.description } : {}),
    ...(o.params ? { parameters: o.params } : {}),
    ...(o.requestBody ? { requestBody: o.requestBody } : {}),
    ...(o.security === false ? { security: [] } : {}),
    ...(o.deprecated ? { deprecated: true } : {}),
    ...(o.mcpExclude ? { "x-mcp-exclude": o.mcpExclude } : { "x-mcp-tool": o.mcpTool ?? operationId }),
    responses: { ...(o.responses ?? { 200: json({ type: "object" }) }), ...errors },
  };
}

const settingsProps = {
  title: { type: ["string", "null"], maxLength: 200 },
  description: { type: ["string", "null"], maxLength: 2000 },
  spa: { type: "boolean", description: "Serve index.html for unknown paths (single-page apps)." },
  renderMarkdown: { type: "boolean", description: "Render .md files as HTML pages for browsers (default true)." },
  crossOriginIsolation: { type: "boolean", description: "Send COOP/COEP headers (needed for SharedArrayBuffer, threaded WASM)." },
  password: { type: ["string", "null"], description: "Visitor password; null removes it. Needs an API key." },
};

const fileInput = {
  type: "object",
  required: ["path"],
  description: "A path plus exactly one source: content (+encoding), url (+headers), sha256 (+size) or copyFrom.",
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    encoding: { enum: ["utf8", "base64"] },
    url: { type: "string", format: "uri", description: "Public https URL the server downloads." },
    headers: { type: "object", additionalProperties: { type: "string" } },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    size: { type: "integer", minimum: 0 },
    copyFrom: { type: "object", properties: { site: { type: "string" }, version: { type: "string" }, path: { type: "string" } } },
    contentType: { type: "string" },
  },
};

/** The OpenAPI document for an instance at `origin`. */
export function buildOpenApi(origin: string, instanceName: string): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: `${instanceName} API`,
      version: "1.0.0",
      description:
        "Publish files, folders and sites to live URLs. Authenticate with `Authorization: Bearer dw_...`. Errors always carry a stable `code` and a `hint` saying what to do next. Fastest path: POST /api/v1/publish with multipart files. Every operationId is also an MCP tool name at /mcp (see x-mcp-tool).",
      license: { name: "MIT", url: "https://github.com/TogetherWeOwn/dropway/blob/main/LICENSE" },
    },
    externalDocs: { description: "Agent docs (llms.txt)", url: `${origin}/llms.txt` },
    servers: [{ url: origin }],
    security: [{ bearer: [] }],
    tags: [
      { name: "publish", description: "One-shot publishing and partial updates" },
      { name: "sites", description: "Sites, settings and access" },
      { name: "files", description: "Read back published files" },
      { name: "versions", description: "Immutable versions, uploads and restore" },
      { name: "keys", description: "Scoped API keys" },
      { name: "members", description: "Members of this instance" },
      { name: "setup", description: "First run (bootstrap key)" },
      { name: "agents", description: "MCP server and agent discovery documents" },
    ],
    paths: {
      // ------------------------------------------------------------------ discovery + identity
      "/api/v1": {
        get: op("api_index", "API index with links to the docs", { tags: ["agents"], security: false, mcpExclude: "discovery document; use whoami" }),
      },
      "/api/v1/me": {
        get: op("whoami", "Who am I: principal, tenant, member, scopes", { tags: ["keys"], responses: { 200: json(ref("Whoami")) } }),
      },
      "/api/v1/setup": {
        post: op("setup_instance", "First run: create the owner (bootstrap key only)", {
          tags: ["setup"],
          description: "Authorization: Bearer <ADMIN_BOOTSTRAP_KEY>. Creates the tenant, its owner and a full-scope owner API key. Works once on a single-tenant instance.",
          requestBody: body({ type: "object", properties: { email: { type: "string" }, name: { type: "string" }, tenantName: { type: "string" } } }, false),
          mcpExclude: "needs the bootstrap key, which MCP never accepts",
          responses: { 201: json({ type: "object" }, "Owner created; apiKey.key is shown once") },
        }),
      },
      "/api/v1/accounts": {
        post: op("setup_instance_legacy", "Alias of POST /api/v1/setup", { tags: ["setup"], deprecated: true, mcpExclude: "alias of setup_instance" }),
      },
      "/api/v1/setup/recover": {
        post: op("recover_owner_key", "Mint a new owner key (bootstrap key only)", { tags: ["setup"], mcpExclude: "needs the bootstrap key" }),
      },

      // ------------------------------------------------------------------ publish
      "/api/v1/publish": {
        post: op("publish_site", "Publish files in one call and get a live URL", {
          tags: ["publish"],
          description:
            'Accepts multipart/form-data (field name = file path, e.g. -F "assets/app.js=@dist/assets/app.js"; or field `files[]` with filenames; a single .zip is unpacked), application/json ({"files":[{"path","content","encoding?":"base64"}]}), a .zip body, or one raw file body named by ?path= or X-Dropway-Path. Settings and `slug` may be sent as form fields, JSON fields or query parameters. With an existing `slug` you own, publishes a new version of it. Byte-identical content returns unchanged:true. The MCP tool publish_site also accepts url, sha256 and copyFrom file sources.',
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": { schema: { type: "object", additionalProperties: { type: "string", format: "binary" } } },
              "application/json": { schema: ref("JsonPublish") },
              "application/zip": { schema: { type: "string", format: "binary" } },
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          params: [query("slug", { type: "string" }), query("path", { type: "string" }, "File name for a single raw body.")],
          responses: { 201: json(ref("PublishResult"), "Created a new site"), 200: json(ref("PublishResult"), "Published a new version of an existing site") },
          security: true,
        }),
      },

      // ------------------------------------------------------------------ sites
      "/api/v1/sites": {
        get: op("list_sites", "List sites", {
          tags: ["sites"],
          params: [query("limit", { type: "integer", minimum: 1, maximum: 200 }), query("cursor", { type: "string" })],
          responses: { 200: json({ type: "object", properties: { sites: { type: "array", items: ref("Site") }, nextCursor: { type: ["string", "null"] } } }) },
        }),
        post: op("create_site", "Create a site (optionally with a deploy manifest)", {
          tags: ["sites"],
          description: "Without Authorization (only when the instance allows anonymous publishing) the site expires and a claimToken is returned.",
          requestBody: body({ type: "object", properties: { slug: { type: "string" }, files: { type: "array", items: ref("ManifestEntry") }, ...settingsProps } }, false),
          responses: { 201: json({ type: "object", properties: { site: ref("Site"), url: { type: "string" }, claimToken: { type: "string" }, deploy: ref("Deploy") } }) },
        }),
      },
      "/api/v1/sites/{slug}": {
        get: op("get_site", "Get a site", { tags: ["sites"], params: [slugParam], responses: { 200: json({ type: "object", properties: { site: ref("Site") } }) } }),
        patch: op("update_site_settings", "Update site settings", {
          tags: ["sites"],
          params: [slugParam],
          requestBody: body({ type: "object", properties: settingsProps }),
          responses: { 200: json({ type: "object", properties: { site: ref("Site") } }) },
        }),
        delete: op("delete_site", "Delete a site", { tags: ["sites"], params: [slugParam], description: "The MCP tool also requires confirm = slug." }),
      },
      "/api/v1/sites/{slug}/claim": {
        post: op("claim_site", "Claim an anonymous site into your tenant", {
          tags: ["sites"],
          params: [slugParam],
          requestBody: body({ type: "object", required: ["claimToken"], properties: { claimToken: { type: "string" } } }),
        }),
      },
      "/api/v1/sites/{slug}/rename": {
        post: op("rename_site", "Give a site a new slug (its URL changes; the old URL stops working)", {
          tags: ["sites"],
          params: [slugParam],
          requestBody: body({ type: "object", required: ["newSlug"], properties: { newSlug: { type: "string" } } }),
          responses: { 200: json({ type: "object", properties: { renamed: { type: "boolean" }, oldSlug: { type: "string" }, slug: { type: "string" }, url: { type: "string" }, site: ref("Site") } }) },
        }),
      },
      "/api/v1/sites/{slug}/access": {
        put: op("set_site_access", "Set who can open a site (public or password)", {
          tags: ["sites"],
          description: 'mode "public" or "password" (with password). "restricted" and "private" answer 501 feature_unavailable on this edition.',
          params: [slugParam],
          requestBody: body({ type: "object", required: ["mode"], properties: { mode: { enum: ["public", "password", "restricted", "private"] }, password: { type: "string", minLength: 4, maxLength: 200 } } }),
          responses: { 200: json({ type: "object", properties: { site: ref("Site"), access: { type: "object", properties: { mode: { type: "string" } } } } }) },
        }),
      },

      // ------------------------------------------------------------------ files
      "/api/v1/sites/{slug}/files": {
        get: op("list_files", "List the files of the live (or ?version=) version", { tags: ["files"], params: [slugParam, query("version", { type: "string" }, "Version id.")] }),
        patch: op("update_site_files", "Write, delete or move some files; everything else carries over", {
          tags: ["publish"],
          description:
            "`files` uses the same sources as MCP publish_site (content, url, sha256+size, copyFrom). `delete` takes paths (trailing / = folder); `move` takes {from, to}. Pass baseVersionId to get 409 version_conflict instead of overwriting a newer publish. Answers 202 with upload items when sha256-only files still need uploading.",
          params: [slugParam, idempotencyHeader],
          requestBody: body({
            type: "object",
            properties: {
              files: { type: "array", items: fileInput },
              delete: { type: "array", items: { type: "string" } },
              move: { type: "array", items: { type: "object", required: ["from", "to"], properties: { from: { type: "string" }, to: { type: "string" } } } },
              baseVersionId: { type: "string", description: '"live", "v3", "3" or a version id.' },
              message: { type: "string", maxLength: 200 },
            },
          }),
          responses: { 200: json(ref("AgentPublishResult")), 202: json(ref("AgentPublishResult"), "Waiting for uploads (upload.items), then finalize") },
        }),
      },
      "/api/v1/sites/{slug}/files/{path}": {
        get: op("read_file", "Read one file's raw bytes (ETag = sha256)", {
          tags: ["files"],
          params: [slugParam, pathParam("path", "File path, segments percent-encoded"), query("version", { type: "string" })],
          responses: { 200: { description: "Raw bytes. Text types are returned as text/plain; the stored type is in X-Dropway-Content-Type." } },
          description: "The MCP tool read_file returns text or base64 in JSON and pages with offset/length.",
        }),
        head: op("read_file_head", "File metadata only (size, type, ETag)", {
          tags: ["files"],
          params: [slugParam, pathParam("path", "File path, segments percent-encoded"), query("version", { type: "string" })],
          responses: { 200: { description: "Headers only." } },
          mcpExclude: "HEAD variant of read_file",
        }),
      },

      // ------------------------------------------------------------------ versions and uploads
      "/api/v1/sites/{slug}/deploys": {
        post: op("create_version", "Start a version from a file manifest (upload only what is missing)", {
          tags: ["versions"],
          description: "Send every file's path, size and sha256. The response lists only the files the server does not have yet (`uploads`). PUT each, then finalize.",
          params: [slugParam],
          requestBody: body({
            type: "object",
            required: ["files"],
            properties: {
              files: { type: "array", items: ref("ManifestEntry") },
              message: { type: "string" },
              baseVersionId: { type: "string", description: "Fail with 409 version_conflict if the live version is no longer this one." },
              ...settingsProps,
            },
          }),
          responses: { 201: json(ref("Deploy")), 200: json(ref("Deploy"), "unchanged: the manifest equals the live version") },
          mcpExclude: "MCP publish_site covers it (sha256 sources return upload links)",
        }),
      },
      "/api/v1/sites/{slug}/deploys/{id}": {
        get: op("get_deploy", "Pending version status (missing files)", { tags: ["versions"], params: [slugParam, pathParam("id", "Version id")], mcpTool: "get_version", deprecated: true }),
      },
      "/api/v1/sites/{slug}/deploys/{id}/finalize": {
        post: op("finalize_version", "Make an uploaded version live (atomic, idempotent)", { tags: ["versions"], params: [slugParam, pathParam("id", "Version id")] }),
      },
      "/api/v1/blobs/{sha256}": {
        put: op("upload_blob", "Upload one file's raw bytes", {
          tags: ["versions"],
          description: "Body = the exact file bytes, with Content-Length. The SHA-256 is verified. Only files listed as missing by a pending version you control are accepted.",
          params: [pathParam("sha256", "Lowercase hex SHA-256 of the file")],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          mcpExclude: "raw bytes never pass through the model; PUT them from a shell (curl lines are in upload.items)",
        }),
        post: op("upload_blob_post", "Same as PUT", { tags: ["versions"], params: [pathParam("sha256", "Lowercase hex SHA-256 of the file")], deprecated: true, mcpExclude: "alias of upload_blob" }),
      },
      "/api/v1/sites/{slug}/versions": {
        get: op("list_versions", "List versions (newest first)", { tags: ["versions"], params: [slugParam, query("limit", { type: "integer", minimum: 1, maximum: 500 })] }),
      },
      "/api/v1/sites/{slug}/versions/{id}": {
        get: op("get_version", "Get one version: status, counts, missing uploads", {
          tags: ["versions"],
          params: [slugParam, pathParam("id", 'Version: "live", "v3", "3" or a version id')],
          responses: { 200: json({ type: "object", properties: { site: { type: "string" }, version: ref("Version"), missing: { type: "array", items: { type: "string" } } } }) },
        }),
        delete: op("delete_version", "Permanently delete a non-live version", { tags: ["versions"], params: [slugParam, pathParam("id", "Version id")], description: "The MCP tool also requires confirm = slug." }),
      },
      "/api/v1/sites/{slug}/versions/{id}/restore": {
        post: op("restore_version", "Make an older version live again", { tags: ["versions"], params: [slugParam, pathParam("id", "Version id")] }),
      },

      // ------------------------------------------------------------------ keys and members
      "/api/v1/keys": {
        get: op("list_api_keys", "List your API keys (?all=1 for the whole tenant with members:write)", { tags: ["keys"], params: [query("all", { type: "string", enum: ["1", "true"] })] }),
        post: op("create_api_key", "Create an API key", {
          tags: ["keys"],
          description: "Keys are never wider than the caller's key or the target member's role. `site` restricts the key to one site.",
          requestBody: body(
            { type: "object", properties: { name: { type: "string" }, scopes: ref("Scopes"), expiresInDays: { type: "number" }, memberId: { type: "string" }, site: { type: "string" } } },
            false,
          ),
          responses: { 201: json({ type: "object" }, "Created; key is shown once") },
        }),
      },
      "/api/v1/keys/{id}": { delete: op("revoke_api_key", "Revoke an API key", { tags: ["keys"], params: [pathParam("id", "Key id")] }) },
      "/api/v1/members": {
        get: op("list_members", "List members", { tags: ["members"] }),
        post: op("add_member", "Add a member (returns their first API key)", {
          tags: ["members"],
          requestBody: body({ type: "object", properties: { email: { type: "string" }, name: { type: "string" }, role: { enum: ["owner", "admin", "member"] }, scopes: ref("Scopes") } }),
          responses: { 201: json({ type: "object" }, "Created; apiKey.key is shown once") },
        }),
      },
      "/api/v1/members/{id}": {
        patch: op("update_member", "Change a member's name or role", { tags: ["members"], params: [pathParam("id", "Member id")] }),
        delete: op("remove_member", "Remove a member and revoke their keys", { tags: ["members"], params: [pathParam("id", "Member id")], description: "The MCP tool also requires confirm = the member's email." }),
      },

      // ------------------------------------------------------------------ app origin: MCP, docs, pages
      "/mcp": {
        post: op("mcp", "Remote MCP server (Streamable HTTP, stateless)", {
          tags: ["agents"],
          description:
            "JSON-RPC over Streamable HTTP (MCP 2026-07-28, and 2025-era clients through the stateless lane). Same API keys as REST. Narrow the tool list with ?toolsets=core,sites,versions,keys,members and ?read_only=1. Example: claude mcp add --transport http dropway <origin>/mcp --header \"Authorization: Bearer dw_...\"",
          requestBody: body({ type: "object", description: "A JSON-RPC 2.0 request." }),
          responses: { 200: { description: "JSON-RPC response (application/json or text/event-stream)." }, 401: { description: "Missing or invalid API key (WWW-Authenticate: Bearer)." } },
          mcpExclude: "this is the MCP endpoint itself",
        }),
      },
      "/": { get: op("landing", "Landing page (HTML)", { tags: ["agents"], security: false, responses: { 200: text("HTML", "text/html") }, mcpExclude: "browser page" }) },
      "/health": {
        get: op("health", "Health check", { tags: ["agents"], security: false, responses: { 200: json({ type: "object", properties: { ok: { type: "boolean" }, service: { type: "string" } } }) }, mcpExclude: "monitoring" }),
      },
      "/claim": { get: op("claim_page", "Claim page for anonymous sites (token in the URL fragment)", { tags: ["agents"], security: false, responses: { 200: text("HTML", "text/html") }, mcpExclude: "browser page; use claim_site" }) },
      "/openapi.json": { get: op("openapi", "This document", { tags: ["agents"], security: false, mcpExclude: "discovery document" }) },
      "/llms.txt": { get: op("llms_txt", "Agent quick reference (llms.txt)", { tags: ["agents"], security: false, responses: { 200: text("Markdown", "text/markdown") }, mcpExclude: "discovery document" }) },
      "/llms-full.txt": {
        get: op("llms_full_txt", "Full agent reference: every endpoint, MCP tool and error code", { tags: ["agents"], security: false, responses: { 200: text("Markdown", "text/markdown") }, mcpExclude: "discovery document" }),
      },
      "/skill.md": {
        get: op("skill", "Agent Skill (SKILL.md) for this instance", { tags: ["agents"], security: false, responses: { 200: text("Markdown", "text/markdown") }, mcpExclude: "discovery document" }),
      },
      "/.well-known/agent-skills/index.json": {
        get: op("agent_skills_index", "Agent Skills discovery index (v0.2.0) for `npx skills add <origin>`", { tags: ["agents"], security: false, mcpExclude: "discovery document" }),
      },
      "/.well-known/agent-skills/{name}/SKILL.md": {
        get: op("agent_skill_file", "A skill listed in the discovery index", { tags: ["agents"], security: false, params: [pathParam("name", "Skill name (dropway)")], responses: { 200: text("Markdown", "text/markdown") }, mcpExclude: "discovery document" }),
      },
      "/.well-known/skills/index.json": {
        get: op("agent_skills_index_legacy", "Legacy skills discovery index (v0.1.0)", { tags: ["agents"], security: false, deprecated: true, mcpExclude: "discovery document" }),
      },
      "/.well-known/skills/{name}/SKILL.md": {
        get: op("agent_skill_file_legacy", "A skill listed in the legacy index", { tags: ["agents"], security: false, deprecated: true, params: [pathParam("name", "Skill name (dropway)")], responses: { 200: text("Markdown", "text/markdown") }, mcpExclude: "discovery document" }),
      },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "API key (dw_...), claim token (dwc_...) or, for setup only, the bootstrap key." } },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: { code: { type: "string" }, message: { type: "string" }, hint: { type: "string" }, details: { type: "object", description: "Validation errors list every bad field in details.fields." } },
              required: ["code", "message"],
            },
            requestId: { type: "string" },
          },
        },
        Scopes: {
          oneOf: [{ type: "array", items: { enum: ["sites:read", "sites:write", "keys:write", "members:write"] } }, { type: "string", description: '"*" or space-separated scopes' }],
        },
        Whoami: {
          type: "object",
          properties: { principal: { type: "string" }, tenant: { type: "object" }, member: { type: "object" }, keyId: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, siteRestriction: { type: ["string", "null"] } },
        },
        ManifestEntry: {
          type: "object",
          required: ["path", "size", "sha256"],
          properties: { path: { type: "string" }, size: { type: "integer" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, contentType: { type: "string" } },
        },
        FileInput: fileInput,
        JsonPublish: {
          type: "object",
          required: ["files"],
          properties: {
            slug: { type: "string" },
            files: {
              type: "array",
              items: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" }, encoding: { enum: ["utf8", "base64"] }, contentType: { type: "string" } } },
            },
            message: { type: "string" },
            baseVersionId: { type: "string" },
            ...settingsProps,
          },
        },
        Version: {
          type: "object",
          properties: {
            id: { type: "string" },
            number: { type: "integer" },
            status: { enum: ["pending", "ready"] },
            live: { type: "boolean" },
            fileCount: { type: "integer" },
            totalBytes: { type: "integer" },
            source: { type: "string" },
            client: { type: ["string", "null"] },
            message: { type: ["string", "null"] },
            createdAt: { type: "string" },
            finalizedAt: { type: ["string", "null"] },
          },
        },
        Site: {
          type: "object",
          properties: {
            slug: { type: "string" },
            url: { type: "string", description: "Share this URL as returned; never construct it." },
            title: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            anonymous: { type: "boolean" },
            expiresAt: { type: ["string", "null"] },
            settings: { type: "object" },
            currentVersionId: { type: ["string", "null"] },
            currentVersion: { oneOf: [ref("Version"), { type: "null" }] },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
            links: { type: "object" },
          },
        },
        Deploy: {
          type: "object",
          properties: {
            unchanged: { type: "boolean" },
            deploy: ref("Version"),
            missing: { type: "array", items: { type: "string" } },
            uploads: {
              type: "array",
              items: { type: "object", properties: { sha256: { type: "string" }, size: { type: "integer" }, paths: { type: "array", items: { type: "string" } }, method: { const: "PUT" }, url: { type: "string" }, headers: { type: "object" } } },
            },
            finalizeUrl: { type: ["string", "null"] },
            next: { type: "string", description: "Plain-English next step." },
          },
        },
        PublishResult: {
          type: "object",
          properties: {
            url: { type: "string" },
            slug: { type: "string" },
            created: { type: "boolean" },
            unchanged: { type: "boolean" },
            site: ref("Site"),
            version: ref("Version"),
            files: { type: "array", items: { type: "string" } },
            uploaded: { type: "integer" },
            reused: { type: "integer" },
            warnings: { type: "array", items: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } },
            claimToken: { type: "string", description: "Anonymous publishes only; shown once." },
            expiresAt: { type: ["string", "null"] },
          },
        },
        AgentPublishResult: {
          type: "object",
          description: "Result of MCP publish_site / update_site_files and REST PATCH .../files.",
          properties: {
            status: { enum: ["live", "unchanged", "awaiting_upload"] },
            url: { type: "string" },
            slug: { type: "string" },
            site: ref("Site"),
            version: { oneOf: [ref("Version"), { type: "null" }] },
            files: { type: "object", properties: { total: { type: "integer" }, stored: { type: "integer" }, reused: { type: "integer" }, fetched: { type: "integer" }, pending: { type: "integer" } } },
            upload: { type: "object", properties: { versionId: { type: "string" }, expiresAt: { type: "string" }, items: { type: "array", items: { type: "object" } }, finalize: { type: "object" } } },
            changes: { type: "object" },
            warnings: { type: "array", items: { type: "object" } },
            next: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  };
}
