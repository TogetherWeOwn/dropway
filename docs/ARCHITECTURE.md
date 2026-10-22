# Dropway architecture

Dropway publishes files, folders and sites to live URLs. It runs entirely on
Cloudflare: one Worker, D1 for metadata, R2 for file bytes, KV for the hot
"what is live" cache, Analytics Engine for hits.

This repository is the **complete single-tenant product** (MIT). It has no
plans, prices, billing, payment code or public signup. A hosted, multi-tenant
service can be built *on top* of it by calling `createDropway()` with its own
adapters, routes and UI. The extension points below exist for that. Nothing
here imports such a layer, and such a layer never copies files from here.

## Layout

```
wrangler.jsonc            Self-host deploy config (repo root on purpose: the Deploy to
                          Cloudflare button treats the chosen folder as the whole repo)
apps/worker/src/index.ts  The single-tenant Worker: createDropway() with defaults
packages/core             @dropway/core: service layer (no HTTP framework)
  migrations/             D1 schema (applied by `npm run deploy`)
  src/config.ts           Vars/secrets -> DropwayConfig
  src/context.ts          DropwayContext (what every service takes) + URL helpers
  src/principal.ts        Principal (who is calling), roles, scopes
  src/adapters.ts         Extension interfaces: identity, policy, metering, hooks
  src/errors.ts           ApiError (status, code, message, hint, details)
  src/lib/                crypto, mime, paths, slugs, file-type detection
  src/services/           ALL business logic (see below)
packages/server           @dropway/server: createDropway() Hono app factory
  src/create.ts           createDropway(): wiring, dispatch, cron
  src/route-sites.ts      Decides "site request" vs "app request" (modes, Referer)
  src/serve.ts            Serves site files (index resolution, ranges, ETags, password, headers)
  src/path-rewrite.ts     Path mode: prefixes root-relative URLs in HTML/CSS
  src/viewers/            File viewers (markdown, listing); add more here
  src/routes/api.ts       REST API v1 (thin)
  src/app.ts              App-origin pages: landing, /openapi.json, /llms.txt, /claim, /mcp slot
  src/openapi.ts          OpenAPI 3.1 document
  src/extensions.ts       Types for routes, MCP tools, UI slots, createDropway options
packages/cli              `dropway` CLI (npm package "dropway", Node 20+, zero runtime dependencies)
scripts/guard-open-core.mjs  CI guard: no billing, pricing, payment or hosted-service code in this repo
test/                     vitest + @cloudflare/vitest-plugin (runs inside workerd)
```

## Rule: logic lives in services, every surface is thin

All behaviour lives in `packages/core/src/services/*.ts`. A service takes a
`DropwayContext` (`dw`) and a `Principal`, enforces permissions itself, and
throws `ApiError` with a stable `code` and a `hint` for the caller.

| Service | What it does |
|---|---|
| `identity.ts` | Default identity adapter: `Authorization: Bearer` API key (`dw_`), claim token (`dwc_`) or bootstrap secret |
| `keys.ts` | Create, list, revoke scoped API keys (only a SHA-256 is stored) |
| `tenants.ts` | First-run setup (bootstrap key creates the owner), members, owner recovery |
| `sites.ts` | Create, list, update, delete and claim sites; settings; access checks (`getSiteFor`) |
| `deploys.ts` | Manifest validation, content-addressed upload, atomic finalize, versions, restore, read-back |
| `publish.ts` | One-shot publish (multipart, JSON, zip, raw) built on `deploys.ts` |
| `blobs.ts` | R2 storage at `blobs/<sha256>` (R2 verifies the hash on write), edge cache |
| `live.ts` | `live:<slug>` manifest in KV (D1 fallback, per-isolate 5 s cache) |
| `cleanup.ts` | Hourly cron: expire anonymous sites, purge deleted sites, drop stale uploads, delete orphan blobs |
| `events.ts` | Runs hooks and metering after the response (never throws) |

The REST routes (`packages/server/src/routes/api.ts`) only parse input, call
one service and shape JSON. **The MCP server and the CLI's server side must call
the same services**, never the REST API over HTTP, so permissions, limits and
errors are identical everywhere.

## Request flow

```
fetch(request)
  -> createDropway builds dw (config cached per env, adapters, hooks, waitUntil)
  -> routeSiteRequest(dw, request)
       site      -> serveSite()       (packages/server/src/serve.ts)
       redirect  -> 301/307           (trailing slash, other origin, Referer fallback)
       app       -> Hono app: /api/v1/* (identity adapter resolves the principal),
                    /, /openapi.json, /llms.txt, /claim, /mcp, UI pages
```

### Where sites are served (config `SITES_MODE`)

| Mode | Site URL | Isolation |
|---|---|---|
| `subdomain` | `https://<slug>.<SITES_DOMAIN>/` | Each site its own origin. Recommended once a domain exists |
| `path` + `SITES_ORIGIN` | `<SITES_ORIGIN>/<slug>/` (second Worker deployment, same code) | Sites share one origin, separate from the app. Not sandboxed by default (`SITES_SANDBOX=true` to sandbox) |
| `path` (self-host default) | `<APP_ORIGIN>/s/<slug>/` | Shares the app origin, so always served with a CSP `sandbox` (opaque origin: no cookies, storage or service workers) |

Path mode is interim. Root-relative URLs (`/assets/app.js`) would escape the
`/<slug>/` prefix, so:

1. HTML and CSS are rewritten on the way out (`path-rewrite.ts`, streaming
   `HTMLRewriter`): `/x` becomes `/s/<slug>/x`. `?raw=1` returns the stored bytes.
2. Anything left (URLs built in JavaScript) is resolved by the `Referer`: if the
   referring page belongs to site X and X has the file, the request gets a 307
   to X's URL. Browsers send no Referer from sandboxed pages, so on the shared
   origin only (1) applies. Use relative URLs, or subdomain mode.

### Viewing files

`serveFile` picks a viewer from `packages/server/src/viewers` when a browser
navigates to a file (`Sec-Fetch-Dest: document`, or `Accept: text/html`), or
with `?view=1`. Sub-resource requests (`fetch`, `<img>`, `<script>`) always get
raw bytes, so sites keep working. `?raw=1` returns raw bytes for any file (HTML
and other text as `text/plain`, so it shows source). `?download=1` downloads it.

**To add a viewer** (images, PDF, video, CSV, JSON, code, notebooks...): create
`packages/server/src/viewers/<name>.ts` exporting a `Viewer`, match on
`file.kind` (from `detectFileKind` in `@dropway/core`), and add it to `VIEWERS`
in `viewers/index.ts`. Viewer pages get a no-script CSP by default
(`VIEWER_CSP`); a viewer that needs scripts sets its own CSP header. Always link
"View raw" to `vc.rawUrl`. Directory listings are in `viewers/listing.ts`.

## Data model (D1, `packages/core/migrations`)

- `tenants`: exactly one in this build (created by `POST /api/v1/setup`).
- `members`: owner / admin / member of a tenant; `external_ref` links an outer identity system.
- `api_keys`: SHA-256 of the key, `scopes` (`sites:read sites:write keys:write members:write`), optional `site_id` restriction.
- `sites`: `tenant_id` NULL = anonymous (then `claim_token_hash`, `expires_at`).
- `versions`: immutable manifests; `status` pending|ready; `manifest_hash` (identical republish = `unchanged`); `base_version_id` (409 `version_conflict`).
- `version_files`: path -> sha256, size, content type.
- `blobs` + `blob_scopes`: bytes exist once in R2; a scope (`t:<tenant>` or `s:<anonymous site>`) skips an upload only for bytes it has proven it holds, so dedupe never reveals another owner's files.

Never edit an applied migration; add `000N_*.sql`. Extensions keep their own
tables in their own migrations or their own D1 database.

## Extension points: `createDropway(options)`

```ts
import { createDropway } from "@dropway/server";

export default createDropway({
  config: { multiTenant: true },               // or (env) => ({ ... }); overrides vars
  adapters: {
    identity,   // resolve(request, dw) -> Principal (sessions, OAuth, tenant selection...)
    policy,     // limits(principal, owner, dw); beforeCreateSite; beforeDeploy (throw ApiError to refuse)
    metering,   // record(UsageEvent, dw), called after the response; default no-op
  },
  hooks: [{ onPublish, onDelete, onRequest }], // after the response; errors are logged only
  apiMiddleware: [/* Hono middleware on /api/*, after the principal is resolved */],
  routes: [({ api, app }) => { api.get("/extra", handler); }], // registered BEFORE core routes (can override)
  mcpTools: [/* McpToolDefinition: name, description, JSON Schema, scopes, handler(args, { dw, principal }) */],
  mcp: (tools) => (c) => handleMcp(c, tools),  // mounts at /mcp; without it /mcp answers 501
  uiSlots: { navItems: [], pages: [{ path, title, handler }], landing, headHtml },
  viewers: [/* extra viewers, tried before core ones */],
  scheduled: async (dw, controller) => { /* extra cron work */ },
});
```

`dropway.context(env, ctx)` builds a `DropwayContext` outside a request (queue
consumers, scripts, tests). Inside routes, use `c.get("dw")` and
`c.get("principal")`.

### Where to add things

- **A REST endpoint (core):** service function in `packages/core/src/services`,
  thin route in `packages/server/src/routes/api.ts`, path in `openapi.ts`, a
  line in `llms.txt` (`app.ts`), a test in `test/`.
- **MCP:** implement the MCP server as an `McpHandlerFactory` (Cloudflare Agents
  SDK, Streamable HTTP) and core tools as `McpToolDefinition`s in
  `CORE_MCP_TOOLS` (`packages/server/src/create.ts`). Each tool handler calls
  services with `ctx.dw` and `ctx.principal`, which the MCP handler resolves with
  `dw.adapters.identity.resolve(request, dw)`. Then pass `mcp` in `apps/worker`.
- **Dashboard pages:** register through `uiSlots.pages` / `uiSlots.landing`. Use
  `APP_PAGE_CSP` or a stricter CSP. Never render user content on the app origin.
- **CLI:** `packages/cli` talks to the REST API (it runs on users' machines). The upload protocol
  (`src/publish.ts`, `src/client.ts`) uses only `fetch`, so `test/cli-publish.test.ts` runs it against
  the real Worker inside workerd; `packages/cli/test` covers the rest, end to end against a local Worker.
  A new REST endpoint usually needs no CLI change: `dropway api <METHOD> <path>` reaches it.

## Conventions

- TypeScript strict, `verbatimModuleSyntax`; packages export TypeScript source
  (bundled by wrangler/esbuild and vite), no build step.
- Errors: `ApiError(status, code, message, hint, details)`; codes are snake_case
  and stable; hints say what to do next.
- No SaaS concepts in this repo: no plans, prices, billing, quotas beyond
  admin-set config, and no signup. Those belong to a layer built on the
  extension points.
- Tests: `npm test` (runs in workerd with real D1/R2/KV emulation). `npm run typecheck`.

## Deploying

- Self-host: Deploy to Cloudflare button, or `npm run deploy` (see `docs/SELF_HOST.md`).
- Maintainers: the root `wrangler.jsonc` is the self-host template. Do not deploy
  it to an account that runs a hosted Dropway: its worker and resource names
  (`dropway`, `dropway-files`) may collide. Use a separate config for test instances.
