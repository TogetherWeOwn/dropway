/**
 * Hand-written OpenAPI 3.1 description of the core REST API (served at /openapi.json).
 * Extensions add their own paths through createDropway({ routes }) and may
 * extend this document by post-processing buildOpenApi()'s result.
 */

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Json, description = "OK") => ({ description, content: { "application/json": { schema } } });
const slugParam = { name: "slug", in: "path", required: true, schema: { type: "string" }, description: "Site name, e.g. bright-otter-x7k2" };
const idParam = (name: string, d: string) => ({ name, in: "path", required: true, schema: { type: "string" }, description: d });
const body = (schema: Json, required = true) => ({ required, content: { "application/json": { schema } } });
const errors = { default: json(ref("Error"), "Error: { error: { code, message, hint?, details? }, requestId }") };

function op(summary: string, opts: { tags: string[]; operationId: string; description?: string; params?: Json[]; requestBody?: Json; responses?: Json; security?: boolean }) {
  return {
    summary,
    operationId: opts.operationId,
    tags: opts.tags,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.params ? { parameters: opts.params } : {}),
    ...(opts.requestBody ? { requestBody: opts.requestBody } : {}),
    ...(opts.security === false ? { security: [] } : {}),
    responses: { ...(opts.responses ?? { 200: json({ type: "object" }) }), ...errors },
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

export function buildOpenApi(origin: string, instanceName: string): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: `${instanceName} API`,
      version: "1.0.0",
      description:
        "Publish files, folders and sites to live URLs. Authenticate with `Authorization: Bearer dw_...`. Errors always carry a stable `code` and a `hint` saying what to do next. Fastest path: POST /api/v1/publish with multipart files.",
    },
    servers: [{ url: origin }],
    security: [{ bearer: [] }],
    tags: [
      { name: "publish", description: "One-shot publishing" },
      { name: "sites", description: "Sites and settings" },
      { name: "deploys", description: "Content-addressed incremental deploys" },
      { name: "versions", description: "Immutable versions and restore" },
      { name: "files", description: "Read back published files" },
      { name: "access", description: "Setup, members and API keys" },
    ],
    paths: {
      "/api/v1/publish": {
        post: op("Publish files in one call and get a live URL", {
          tags: ["publish"],
          operationId: "publish",
          description:
            'Accepts multipart/form-data (field name = file path, e.g. -F "assets/app.js=@dist/assets/app.js"; or field `files[]` with filenames; a single .zip is unpacked), application/json ({"files":[{"path","content","encoding?":"base64"}]}), a .zip body, or one raw file body named by ?path= or X-Dropway-Path. Settings and `slug` may be sent as form fields, JSON fields or query parameters. With an existing `slug` you own, publishes a new version of it. Byte-identical content returns unchanged:true.',
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": { schema: { type: "object", additionalProperties: { type: "string", format: "binary" } } },
              "application/json": { schema: ref("JsonPublish") },
              "application/zip": { schema: { type: "string", format: "binary" } },
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          params: [
            { name: "slug", in: "query", schema: { type: "string" } },
            { name: "path", in: "query", schema: { type: "string" }, description: "File name for a single raw body." },
          ],
          responses: { 201: json(ref("PublishResult"), "Created a new site"), 200: json(ref("PublishResult"), "Published a new version of an existing site") },
        }),
      },
      "/api/v1/sites": {
        get: op("List sites", {
          tags: ["sites"],
          operationId: "listSites",
          params: [
            { name: "limit", in: "query", schema: { type: "integer", maximum: 200 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: json({ type: "object", properties: { sites: { type: "array", items: ref("Site") }, nextCursor: { type: ["string", "null"] } } }) },
        }),
        post: op("Create a site (optionally with a deploy manifest)", {
          tags: ["sites"],
          operationId: "createSite",
          description: "Without Authorization (only when the instance allows anonymous publishing) the site expires and a claimToken is returned.",
          requestBody: body({ type: "object", properties: { slug: { type: "string" }, files: { type: "array", items: ref("ManifestEntry") }, ...settingsProps } }, false),
          responses: { 201: json({ type: "object", properties: { site: ref("Site"), url: { type: "string" }, claimToken: { type: "string" }, deploy: ref("Deploy") } }) },
        }),
      },
      "/api/v1/sites/{slug}": {
        get: op("Get a site", { tags: ["sites"], operationId: "getSite", params: [slugParam], responses: { 200: json({ type: "object", properties: { site: ref("Site") } }) } }),
        patch: op("Update site settings", {
          tags: ["sites"],
          operationId: "updateSite",
          params: [slugParam],
          requestBody: body({ type: "object", properties: settingsProps }),
          responses: { 200: json({ type: "object", properties: { site: ref("Site") } }) },
        }),
        delete: op("Delete a site", { tags: ["sites"], operationId: "deleteSite", params: [slugParam] }),
      },
      "/api/v1/sites/{slug}/claim": {
        post: op("Claim an anonymous site into your tenant", {
          tags: ["sites"],
          operationId: "claimSite",
          params: [slugParam],
          requestBody: body({ type: "object", required: ["claimToken"], properties: { claimToken: { type: "string" } } }),
        }),
      },
      "/api/v1/sites/{slug}/deploys": {
        post: op("Start a deploy from a file manifest", {
          tags: ["deploys"],
          operationId: "createDeploy",
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
        }),
      },
      "/api/v1/sites/{slug}/deploys/{id}": {
        get: op("Deploy status (missing files)", { tags: ["deploys"], operationId: "getDeploy", params: [slugParam, idParam("id", "Deploy (version) id")] }),
      },
      "/api/v1/sites/{slug}/deploys/{id}/finalize": {
        post: op("Make a deploy live (atomic, idempotent)", { tags: ["deploys"], operationId: "finalizeDeploy", params: [slugParam, idParam("id", "Deploy (version) id")] }),
      },
      "/api/v1/blobs/{sha256}": {
        put: op("Upload one file's raw bytes", {
          tags: ["deploys"],
          operationId: "uploadBlob",
          description: "Body = the exact file bytes, with Content-Length. The SHA-256 is verified. Only files listed as missing by a pending deploy you control are accepted.",
          params: [idParam("sha256", "Lowercase hex SHA-256 of the file")],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        }),
      },
      "/api/v1/sites/{slug}/versions": {
        get: op("List versions (newest first)", { tags: ["versions"], operationId: "listVersions", params: [slugParam] }),
      },
      "/api/v1/sites/{slug}/versions/{id}/restore": {
        post: op("Make an older version live again", { tags: ["versions"], operationId: "restoreVersion", params: [slugParam, idParam("id", "Version id")] }),
      },
      "/api/v1/sites/{slug}/versions/{id}": {
        delete: op("Permanently delete a non-live version", { tags: ["versions"], operationId: "deleteVersion", params: [slugParam, idParam("id", "Version id")] }),
      },
      "/api/v1/sites/{slug}/files": {
        get: op("List the files of the live (or ?version=) version", { tags: ["files"], operationId: "listFiles", params: [slugParam, { name: "version", in: "query", schema: { type: "string" } }] }),
      },
      "/api/v1/sites/{slug}/files/{path}": {
        get: op("Read one file's raw bytes (ETag = sha256)", {
          tags: ["files"],
          operationId: "readFile",
          params: [slugParam, idParam("path", "File path, segments percent-encoded"), { name: "version", in: "query", schema: { type: "string" } }],
          responses: { 200: { description: "Raw bytes. Text types are returned as text/plain; the stored type is in X-Dropway-Content-Type." } },
        }),
      },
      "/api/v1/me": { get: op("Who am I", { tags: ["access"], operationId: "me" }) },
      "/api/v1/setup": {
        post: op("First run: create the owner (bootstrap key only)", {
          tags: ["access"],
          operationId: "setup",
          description: "Authorization: Bearer <ADMIN_BOOTSTRAP_KEY>. Creates the tenant, its owner and a full-scope owner API key. Works once on a single-tenant instance.",
          requestBody: body({ type: "object", properties: { email: { type: "string" }, name: { type: "string" }, tenantName: { type: "string" } } }, false),
        }),
      },
      "/api/v1/setup/recover": { post: op("Mint a new owner key (bootstrap key only)", { tags: ["access"], operationId: "recoverOwnerKey" }) },
      "/api/v1/members": {
        get: op("List members", { tags: ["access"], operationId: "listMembers" }),
        post: op("Add a member (returns their first API key)", {
          tags: ["access"],
          operationId: "createMember",
          requestBody: body({ type: "object", properties: { email: { type: "string" }, name: { type: "string" }, role: { enum: ["owner", "admin", "member"] }, scopes: ref("Scopes") } }),
        }),
      },
      "/api/v1/members/{id}": {
        patch: op("Change a member's name or role", { tags: ["access"], operationId: "updateMember", params: [idParam("id", "Member id")] }),
        delete: op("Remove a member and revoke their keys", { tags: ["access"], operationId: "removeMember", params: [idParam("id", "Member id")] }),
      },
      "/api/v1/keys": {
        get: op("List your API keys (?all=1 for the whole tenant with members:write)", { tags: ["access"], operationId: "listKeys" }),
        post: op("Create an API key", {
          tags: ["access"],
          operationId: "createKey",
          description: "Keys are never wider than the caller's key or the target member's role. `site` restricts the key to one site.",
          requestBody: body(
            { type: "object", properties: { name: { type: "string" }, scopes: ref("Scopes"), expiresInDays: { type: "number" }, memberId: { type: "string" }, site: { type: "string" } } },
            false,
          ),
        }),
      },
      "/api/v1/keys/{id}": { delete: op("Revoke an API key", { tags: ["access"], operationId: "revokeKey", params: [idParam("id", "Key id")] }) },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "API key (dw_...), claim token (dwc_...) or, for setup only, the bootstrap key." } },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, hint: { type: "string" }, details: { type: "object" } }, required: ["code", "message"] },
            requestId: { type: "string" },
          },
        },
        Scopes: {
          oneOf: [{ type: "array", items: { enum: ["sites:read", "sites:write", "keys:write", "members:write"] } }, { type: "string", description: '"*" or space-separated scopes' }],
        },
        ManifestEntry: {
          type: "object",
          required: ["path", "size", "sha256"],
          properties: { path: { type: "string" }, size: { type: "integer" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, contentType: { type: "string" } },
        },
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
      },
    },
  };
}
