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
  src/viewers/            File viewers, one per kind (code, markdown, json, csv, media, notebook, binary...)
  src/ui/                 App-origin UI: home, sign-in, dashboard, file viewer, the dashboard script
  src/routes/api.ts       API middleware, JSON parsing and error responses
  src/operations/         Operation families and compatibility adapters; core.ts fixes stable order
  src/operations.ts       Operation types, validation and REST/MCP generation
  src/mcp/                Remote MCP server (/mcp): endpoint (index.ts), core tools (tools.ts), schemas
  src/app.ts              App-origin routes: home (./ui), /openapi.json, discovery routes, /claim, /mcp
  src/openapi.ts          OpenAPI 3.1 document for every route (operationId = MCP tool name)
  src/discovery.ts        /llms.txt, /llms-full.txt, /skill.md, /.well-known/agent-skills (generated)
  src/extensions.ts       Types for routes, MCP tools, UI slots, createDropway options
packages/cli              `dropway` CLI (npm package "dropway", Node 20+, zero runtime dependencies)
skills/dropway/SKILL.md   Agent Skill (`npx skills add TogetherWeOwn/dropway`); generated, `npm run skill:sync`
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
| `sources.ts` | Agent file sources (`content`, base64, `url` with an SSRF guard, `sha256` + upload links, `copyFrom`), `publishSources`, partial `updateSiteFiles`, `finalizeVersionByRef` |
| `site-ops.ts` | Site refs (slug, id or URL), version refs (`live`, `v3`, `3`, id), rename, access modes, paged file reads, `confirm` checks |
| `idempotency.ts` | Idempotency keys (KV, 24 h): replay the first result, 422 on a reused key with another body |
| `blobs.ts` | R2 storage at `blobs/<sha256>` (R2 verifies the hash on write), edge cache |
| `live.ts` | `live:<slug>` manifest in KV (D1 fallback, per-isolate 5 s cache) |
| `cleanup.ts` | Hourly cron: expire anonymous sites, purge deleted sites, drop stale uploads, delete orphan blobs |
| `events.ts` | Runs hooks and metering after the response (never throws) |

The registry operations (`packages/server/src/operations/`) only parse input,
call a service and shape JSON. **The MCP server and the CLI's server side must call
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
                    /, /openapi.json, /llms.txt, /llms-full.txt, /skill.md,
                    /.well-known/agent-skills/*, /claim, /mcp, UI pages
```

### Where sites are served (config `SITES_MODE`)

| Mode | Site URL | Isolation |
|---|---|---|
| `subdomain` | `https://<slug>.<SITES_DOMAIN>/` | Each site its own origin. Recommended once a domain exists |
| `path` + `SITES_ORIGIN` | `<SITES_ORIGIN>/<slug>/` (second Worker deployment, same code) | Sites share one origin, separate from the app. By default (`SITES_SANDBOX=auto`) only anonymous sites are sandboxed; `true` sandboxes every site, `false` none |
| `path` (self-host default) | `<APP_ORIGIN>/s/<slug>/` | Shares the app origin, so always served with a CSP `sandbox` (opaque origin: no cookies, storage or service workers) |

Path mode is interim. Root-relative URLs (`/assets/app.js`) would escape the
`/<slug>/` prefix, so:

1. HTML and CSS are rewritten on the way out (`path-rewrite.ts`, streaming
   `HTMLRewriter`): `/x` becomes `/s/<slug>/x`. `?raw=1` returns the stored bytes.
2. Anything left (URLs built in JavaScript) is resolved by the `Referer`: if the
   referring page belongs to site X and X has the file, the request gets a 307
   to X's URL.
3. Sandboxed pages have an opaque origin and browsers send them no `Referer`
   at all, whatever the `Referrer-Policy` (measured in Chrome 151), so (2) cannot
   work there. Instead their HTML gets a small inline script at the top of
   `<head>` (`path-shim.ts`) that applies the rule of (1) in the browser:
   root-relative URLs passed to `fetch`, `Request`, `XMLHttpRequest`,
   `EventSource`, `sendBeacon`, `window.open`, element URL properties,
   `setAttribute` and elements inserted later get the site prefix. Not covered:
   import specifiers, CSS set from JS, `location.href = "/x"` and
   `history.pushState("/x")`. Use relative URLs there, or subdomain mode.

### Viewing files

`serveFile` asks `findViewer(file, live, viewers, mode)` (`packages/server/src/viewers`)
for a rendered view. The mode comes from the request:

| Request | Mode | What it gets |
|---|---|---|
| Top-level navigation (`Sec-Fetch-Dest: document`, or `Accept: text/html`) | `document` | The view for the file's kind; HTML is served as the page itself; binaries download |
| Navigation inside an `<iframe>` | `frame` | Same, except images, PDFs, video and audio get raw bytes, so a site embedding its own PDF keeps working |
| `?view=1` | `view` | Always a view when one exists: HTML gets the viewer frame (bar + page in an iframe), binaries an info page |
| `?view=source` | `source` | Highlighted source of any text file, HTML and SVG included |
| `fetch()`, `<img>`, `<script>`... | none | Raw bytes, always |

`?raw=1` returns the stored bytes (text types as `text/plain`), `?download=1`
downloads, `&embed=1` drops the viewer bar (the app-origin viewer frames views
and has its own toolbar).

Every view shares one bar (`viewers/chrome.ts`: kind, path, size, type; view
tabs; Download; Files) built from plain links, so it works with JavaScript off.
View pages get `VIEWER_CSP` (no scripts). The code view adds one static inline
script (Copy, `#L10-L20` ranges) allowed by its SHA-256 hash, which stays valid
across 304 responses, unlike a nonce. User markup (Markdown, notebook HTML)
goes through `viewers/sanitize.ts`, an allowlist sanitizer on `HTMLRewriter`.
Expensive output (highlighting, Markdown, JSON trees, CSV tables) is cached by
content in `viewers/cache.ts` (`render/<viewer>@<version>/<variant>/<sha256>`:
isolate memory, then the Cache API).

Syntax highlighting is highlight.js core plus about 80 languages registered in
`viewers/hljs.js` (about 106 KB gzipped). That file is plain JavaScript with
its own `hljs.d.ts` because highlight.js's types pull in the DOM lib.

**To add a viewer:** create `packages/server/src/viewers/<name>.ts` exporting a
`Viewer` (`id`, `version`, `maxBytes`, `matches(file, live, mode)`, `render(vc)`),
match on `file.kind` (from `detectFileKind` in `@dropway/core`) and the mode,
wrap the body with `viewerPage()` from `viewers/chrome.ts`, and add it to
`VIEWERS` in `viewers/index.ts` before the code/binary fallbacks. Embedding apps
pass extra viewers in `createDropway({ viewers })`; they run first.

### App-origin UI (`packages/server/src/ui`)

| Path | Page |
|---|---|
| `/` | Home: what this instance is, publish from the browser, curl/CLI/MCP snippets (`uiSlots.landing` replaces it) |
| `/login` | Sign in with an API key; first-run setup and owner recovery with the bootstrap secret |
| `/dashboard` | Sites |
| `/dashboard/sites/:slug` | Versions (restore, delete), files of any version (view, download), settings, delete |
| `/dashboard/publish` | Drag-and-drop publish: folder, files or a zip |
| `/dashboard/keys` | Create and revoke scoped API keys |
| `/dashboard/settings` | Account, members, instance configuration, `uiSlots.settingsSections` |
| `/v/:slug/*path` (`/view/...` redirects) | File browser: tree, view tabs, and the file in a sandboxed iframe on the sites origin |

Pages are server-rendered shells. One first-party script,
`/__dropway/ui/app-<hash>.js`, fills in data from the public REST API, using the
API key the person signed in with (sessionStorage, or localStorage when they tick
"keep me signed in"; no cookies). The script is the source text of
`dropwayClient()` in `ui/client.ts`, so there is no build step and nothing for an
embedding app to configure. Keep that function self-contained and build DOM with
its `h()` helper, never `innerHTML`.

App pages use `appScriptCsp()`: scripts from `'self'` only, frames, images and
`connect-src` limited to this origin and the sites origin, `frame-ancestors 'none'`.
The dashboard never renders user content on the app origin: files open in an
iframe on the sites origin (with `allow-same-origin` only when that origin is
not the app origin), and downloads go through a forced-download blob.

Drag-and-drop publishing hashes files in the browser (SHA-256), sends the
manifest to `POST /api/v1/sites/:slug/deploys`, uploads only the blobs the
server reports missing (4 at a time, retried on 429/5xx), then finalizes. A
single `.zip` goes to `POST /api/v1/publish` instead. `.git/`, `node_modules/`,
`.env*` and OS clutter are skipped and listed.

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

`@dropway/server` exports `EXTENSION_API_VERSION = 2` for this public embedding
contract. Update it and the Extension API section in `CHANGELOG.md` when changing
the contract. `test/extension-contract.test.ts` exercises every existing extension
point with fake adapters and real emulated D1/R2/KV bindings; it runs in public CI.

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
  operations: [/* defineOperation: zod input/output, service handler, REST path, MCP and CLI metadata */],
  mcpTools: [/* compatibility escape hatch: MCP-only tools, or replacement by name */],
  mcp: createMcpEndpoint({ name, instructions }), // optional: the default endpoint is mounted at /mcp already
  uiSlots: { navItems: [], pages: [{ path, title, nav, handler }], landing, headHtml, banner, settingsSections, session },
  viewers: [/* extra viewers, tried before core ones */],
  scheduled: async (dw, controller) => { /* extra cron work */ },
});
```

`dropway.context(env, ctx)` builds a `DropwayContext` outside a request (queue
consumers, scripts, tests). Inside routes, use `c.get("dw")` and
`c.get("principal")`.

### Where to add things

- **An API operation (core):** service function in `packages/core/src/services`,
  then one `defineOperation()` in the relevant `packages/server/src/operations/`
  family (listed in `core.ts`) with
  Zod input/output schemas, a thin service handler, method/path, scopes,
  description, examples, annotations and optional CLI metadata. REST, OpenAPI,
  MCP and the command table are generated; do not add a second route or tool.
  Raw-byte/bootstrap endpoints have an explicit `mcp.exclude` reason.
  Tests in `test/` enforce registration, metadata and stable tool ordering.
  `npm run openapi:lint` independently validates the generated document in CI.
- **An API operation (extension):** pass `defineOperation()` results through
  `createDropway({ operations })`. Definitions replace by id without reordering;
  each app gets its own registry and generated discovery. See `docs/OPERATIONS.md`.
- **An MCP-only tool (compatibility):** `createDropway({ mcpTools })` remains an
  escape hatch; tools replace by name. Prefer operations for new capabilities.
  The MCP endpoint still resolves identity, enforces scope checks and applies
  idempotency, toolset/read-only filtering and ApiError shaping. See `docs/MCP.md`.
- **Dashboard pages:** register through `uiSlots.pages` (with `nav: true` for a
  navigation link) and render them with `renderAppPage(c, { title, page, body })`
  from `@dropway/server`, which adds the dashboard frame, navigation, banner and
  CSP. `uiSlots.banner` shows a notice above every app page;
  `uiSlots.settingsSections` adds sections to `/dashboard/settings`.
  `uiSlots.session = { signInPath, signOutPath }` tells the dashboard that the
  embedding app signs people in with cookie sessions (its identity adapter must
  resolve them for `/api/v1` and refuse cross-origin writes). App cookies must use
  `__Host-` names; cookie-authenticated state-changing requests require both exact
  app `Origin` and `Sec-Fetch-Site: same-origin`, not just `SameSite` cookies.
  API-key sign-in at `/login` keeps working and issues no app cookie. The R-15
  tests pin the current bearer-only and site-cookie surfaces; real app-cookie
  issuance and authenticated-write integration tests remain deferred / not run
  until R-21, before session activation. Embedding-cookie activation likewise
  requires those real integration tests; the current tests are not approval.
  Never render user content on the app origin.
- **CLI:** `packages/cli` talks to the REST API (it runs on users' machines). The upload protocol
  (`src/publish.ts`, `src/client.ts`) uses only `fetch`, so `test/cli-publish.test.ts` runs it against
  the real Worker inside workerd; `packages/cli/test` covers the rest, end to end against a local Worker.
  A new REST endpoint usually needs no CLI change: `dropway api <METHOD> <path>` reaches it.

## Built-in member sign-in

`services/sessions.ts` owns hashed login links (15 minutes, atomic one-use exchange),
30-day sliding/revocable sessions, member authorization and the strict browser-write
header check. `services/email-signin.ts` owns existing-member code challenges (five tries,
15 minutes, HMAC hashes, no signup). `services/access-identity.ts` verifies RS256 Access
assertions against configured team JWKS, issuer, audience and time claims before mapping
an existing unique member email. Unsafe Access-derived REST/MCP requests require both
exact app Origin and same-origin Fetch Metadata even when a proxy strips cookies.
Explicit bearer credentials always take precedence and keep their non-browser contract.

The default identity adapter still ignores cookies on ordinary REST resource routes and
MCP. Thin `/api/v1/auth/*` browser-auth handlers explicitly resolve the built-in session;
claim uses `GET /claim` plus `POST /claim`, calling the same core claim service as REST/MCP.
Cookie writes require exact `Origin` AND `Sec-Fetch-Site: same-origin`, not SameSite alone.
Session reads without both headers do not slide D1 expiry or refresh browser cookies.
The session/claim script deliberately calls `POST /api/v1/auth/sessions/refresh`, which
naturally carries Origin. It renews the same cookie and D1 authority together after an
hour; before then it is a no-op. This cookie-only operation skips unrelated bearer
identity resolution (and API-key last-use writes), not its core session/browser checks.
Login-link requests carrying browser Fetch Metadata show the destination member and a
native confirmation form; its guarded `POST /login/confirm` consumes the unspent proof.
Headerless programmatic GET exchanges retain the one-use issuer contract. The login
page is no-store/no-referrer; router diagnostics redact URL queries and credential tokens.
Auth API operations are registered alongside other core operations, with browser-only
MCP exclusions; the shared services enforce their real session or email proof.
`/dashboard/sessions` lists/revokes sessions and signs out. The existing resource dashboard
continues using API keys; no session is converted into a persistent API key. The claim
script keeps fragment proof in tab storage across sign-in and sends it only in the claim
POST. No user content runs on these pages. API-key sign-in remains cookie-free.

`adapters.email.send(message, dw)` optionally overrides delivery. Without it, `EMAIL.send`
(Cloudflare Email Service) delivers; without either, email options are hidden and the
operations return `feature_unavailable`. Enabled email-code requests require both browser
headers even without cookies, before challenge creation or delivery, for known and unknown
emails alike. `EMAIL_FROM` sets the verified sender. Embedding
cookie adapters and `uiSlots.session` remain separate and require their own security proof.

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
