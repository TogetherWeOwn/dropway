# Changelog

## Unreleased

### Renamed: Dropway is now Kofra

- User-visible names: product name, docs, UI copy, the default `INSTANCE_NAME` (`Kofra`), the CLI
  command `kofra` (the `dropway` command stays as an alias), environment variables `KOFRA_*`,
  response and request headers `X-Kofra-*`, the Agent Skill and MCP server name `kofra`.
- Still accepted: `DROPWAY_*` variables (a `KOFRA_*` variable wins), `X-Dropway-*` request headers,
  and the skill URLs under `dropway`. Responses send every `X-Kofra-*` header as `X-Dropway-*` too.
- Unchanged on purpose: Worker, D1, R2, KV and Analytics names, database tables, cookie and storage
  names, reserved paths (`/__dropway/`), CLI files (`dropway.json`, `.dropwayignore`,
  `~/.config/dropway`), the `@dropway/*` workspace packages and `createDropway()`.
- `scripts/rebrand.mjs` applies the rename and can be re-run after a rebase.

### Moving the app to a new origin

- `LEGACY_APP_ORIGINS` (and `LEGACY_DEPRECATED_AT`): former app origins keep serving the REST API,
  MCP, `/health`, `/.well-known/*` and the agent documents with `Deprecation` and
  `Link: rel="successor-version"` headers, and never redirect them (clients drop `Authorization` on
  cross-origin redirects). Other `GET`/`HEAD` requests 308 to `APP_ORIGIN`, uncached, with
  `Access-Control-Allow-Origin: *` so cross-origin reads of published files follow the redirect.
  New config fields `legacyAppOrigins` and `legacyDeprecatedAt`.
- The CLI notes once per run when an instance answers with those headers, naming the new address.
- The product name comes from `INSTANCE_NAME` in the served skill (heading, description, homepage),
  both skills indexes and the MCP server instructions. The skill's `name` does not follow
  `INSTANCE_NAME` (it is `kofra` after the rename above).

### File deliveries

- Add `create_transfer`, `get_transfer`, `update_transfer` and `revoke_transfers` to
  the operation registry. `dropway api <operationId> --data ...` now uses the
  advertised operation instead of treating its name as a URL.
- Transfer messages and password forms stay on the app origin; immutable files
  download from a separate sites host, with attachment, nosniff and no-store headers.
  Password grants expire after 15 minutes and are bound to the current digest.
- Add sender-owned slug reservations, per-file and recipient counts, conditional
  lifecycle mutations, hourly expiry claims and held-byte retention. Revocation
  does not release storage; manifest purge does, once, after a 24-hour retention.
- `TRANSFER_MAX_EXPIRY_DAYS` defaults to 30 and is capped at 3,650. Policy adapters
  may lower it. Transfer creation is refused without an isolated sites origin.
- MCP discovery uses operation summaries to preserve the tool inventory budget;
  full descriptions remain in OpenAPI and the full agent reference.

### Member browser sign-in

- Add one-use 15-minute member login links, revocable 30-day sliding
  `__Host-dw_session` cookies, optional email codes through `EmailAdapter`/`EMAIL`
  (five tries, 15 minutes), RS256 Cloudflare Access identity for existing members,
  and signed-in anonymous-site claiming. Ordinary REST resources remain bearer-only;
  explicit browser auth and claim writes require exact app `Origin` **and**
  `Sec-Fetch-Site: same-origin`. API-key sign-in stays cookie-free.
- Any Fetch Metadata or explicit HTML/XHTML Accept selects read-only identity
  confirmation before a login link is consumed; malformed Accept is refused. Real
  metadata-less non-HTML programmatic exchanges remain supported. Confirmation
  inspection cannot renew a session. Untrusted session reads cannot slide authority or refresh cookies;
  first-party pages use a guarded POST to renew D1 and the same cookie after an hour.
  Access-derived unsafe calls and enabled email-code requests enforce both browser
  headers, regardless of Cookie presence. Explicit bearer clients remain independent.
- Preserve proof on origin/transport refusal, redact diagnostic URL queries/tokens,
  and let failed email delivery retry without resetting verification budgets.
- Bound sign-in/claim URL-encoded forms at 65,536 wire bytes before proof, delivery,
  ownership or session-refresh effects. Reject declared oversize before reading,
  cancel streaming overflow, and preserve the separate JSON and disabled-email contracts.
- Make token-free login explicitly no-store while retaining its native email form referrer
  policy; keep token confirmation/claim/session pages no-referrer. Sanitize missing-blob
  diagnostics with the same query/token redaction as outer errors.
- Add migration `0004_sessions.sql`; apply it before upgrading the Worker.
  Numbers 0002 and 0003 remain reserved for their separate roadmap features.

### Extension API

- Bump `EXTENSION_API_VERSION` to 3: add optional `Limits.transferMaxExpiryDays`,
  `DropwayHooks.onEvent` for transfer lifecycle events, public transfer services
  and transfer expiry/purge counts in `CleanupReport`. Existing adapters keep
  working; omitted delivery limits use the instance ceiling.
- Also in version 3: optional `EmailAdapter`, the optional Cloudflare Email Service
  binding, and `emailFrom`, `accessTeamDomain`, `accessAud` configuration. Existing
  identity overrides and embedding-session slots remain independent of built-in
  browser auth; their deployments need their own cookie security verification.
- Extend the version 2 contract with public core
  `AtomicWriteExtension`, `SiteNameMutation` and optional
  `PolicyAdapter.siteNameMutation`: every concrete site create/rename candidate
  composes core and extension SQL in one same-D1 batch. SQL refusal rolls back
  all statements; only precise 409 `slug_taken` conflicts retry generated names.
  Legacy `beforeCreateSite` remains a non-atomic, once-per-create preflight.
- Fence rename identity/previous name inside its batch; stale preparation fails
  with 409 `site_changed`, without extension residue or cache changes.
- Export `createTenantWithOwner`, `CreateTenantWithOwnerInput` and
  `CreateTenantWithOwnerOptions` for low-level atomic tenant/owner/extension SQL.
  Existing helpers retain field rules; setup uses the new helper. Key minting,
  setup admission races and cross-database/storage/network effects are excluded.
- Pin the additive types, deterministic competing-writer/rollback/cache behavior
  and version in independent disposable workerd/D1 acceptance tests. No core
  schema changes or additional public routes.
- Bump `EXTENSION_API_VERSION` to 2: add `defineOperation()`, typed operation
  definitions/contexts, `createDropway({ operations })` and `dropway.operations`.
  Operation input/output schemas drive REST validation, OpenAPI 3.1, MCP tools,
  CLI command metadata and instance-local discovery documents. Existing route
  and MCP-tool extension escape hatches remain available.
- Keep pre-registry REST payloads, status codes, raw streaming and paths through
  explicit transport adapters. Model-friendly JSON publishing and file reading
  are also available at `/api/v1/publish-sources` and `/api/v1/read-file`.
- Add public `GET /api/v1/operations` and Redocly validation in CI, including
  required summaries, descriptions, examples and JSON error responses.
- Enforce declared authorization before custom HTTP adapters; explicitly retain
  bootstrap setup/recovery and anonymous publishing. Decode numeric/boolean URL
  scalars, including nullable fields, without letting JSON override path resources.
- Bound JSON metadata bodies before parsing (8 MiB default, configurable per
  generated operation), cancel oversized streams and reject raw-body automatic
  replay definitions that cannot distinguish changed bytes. Preserve Hono body
  inspection by API middleware, rechecking cached bodies against the JSON budget.
- Partition member idempotency replay by credential and current authorization,
  including tenant/site restrictions, role and scopes. Older member records
  expire unused; retries spanning the upgrade may execute again.

- Introduced `EXTENSION_API_VERSION` in `@dropway/server` at version 1.
  Extension API changes must update this version and this section.
- Cover existing identity, policy limits and refusals, all five metering events,
  all three hooks, API middleware, route overrides and app routes, contexts,
  MCP tools and endpoint replacement, UI slots, viewers and scheduled work in
  `test/extension-contract.test.ts`, using fake adapters and real emulated storage.

### Subdomain mode hardening

- `LEGACY_SITES_ORIGINS` (config `legacySitesOrigins`): a former path-mode sites origin answers
  `<origin>/<slug>/<rest>?q` with `308` to the site's current URL, uncached; absolute paths from an old
  page follow its Referer (`307`). `SiteRoute` redirects may now have status `308`.
- Reserved labels in subdomain mode: `www.<SITES_DOMAIN>` 301s to the app; other reserved or malformed
  labels are never looked up as sites (404). `kofra`, `fallback` and `customers` join `RESERVED_SLUGS`.
- Password gate: `__Host-dw_pw_<slug>` cookie in subdomain mode; a password entered inside a frame
  (the dashboard file viewer, cross-site once sites have their own domain) sets a partitioned
  `SameSite=None` cookie, and the form may be framed by the app origin only (`frame-ancestors`).
- Password-protected responses send no `Access-Control-Allow-Origin` (also on preflights) and
  `Cross-Origin-Resource-Policy: same-origin` (unless sandboxed); non-navigation requests with
  `Sec-Fetch-Site: same-site` or `cross-site` get 403. Public sites are unchanged.
- New site names are at most 56 characters (`MAX_SLUG_LENGTH`), so `<slug>--v<N>` fits one DNS label.
  Existing longer names keep working.

### Open-core guard

- Scan npm shrinkwrap and legacy nested npm dependencies, Yarn, pnpm and Bun
  text lockfiles for excluded SDKs, in addition to modern npm lockfiles. Check
  `npm:` alias targets in manifests and lockfiles as well as dependency names.
  Reject binary `bun.lockb` with instructions to regenerate an auditable text lockfile.
