# Changelog

## Unreleased

### Moving the app to a new origin

- `LEGACY_APP_ORIGINS` (and `LEGACY_DEPRECATED_AT`): former app origins keep serving the REST API,
  MCP, `/health`, `/.well-known/*` and the agent documents with `Deprecation` and
  `Link: rel="successor-version"` headers, and never redirect them (clients drop `Authorization` on
  cross-origin redirects). Other `GET`/`HEAD` requests 308 to `APP_ORIGIN`, uncached, with
  `Access-Control-Allow-Origin: *` so cross-origin reads of published files follow the redirect.
  New config fields `legacyAppOrigins` and `legacyDeprecatedAt`.
- The CLI notes once per run when an instance answers with those headers, naming the new address.
- The product name comes from `INSTANCE_NAME` in the served skill (heading, description, homepage),
  both skills indexes and the MCP server instructions. The skill's `name` stays `dropway`.

### Scopes, policy and usage

- Add `sites:delete`, `data:write`, `secrets:write` and `admin`. Owners/admins may hold
  every scope; members may hold read/write/delete, key management and data write.
  Migration `0002_scopes_usage.sql` gives existing write keys deletion permission;
  newly minted write-only keys cannot delete sites, versions or folders.
- Export `CAPABILITIES`, `QUOTA_KEYS` and optional policy `capability`, `quota` and
  `beforeOperation` hooks. Missing bindings remain unavailable even when an adapter
  allows a capability. Password create/update preserves an adapter's exact error.
- Add admin `QUOTA_*` configuration (`null`/unset = unlimited, `0` = no new resource).
  Sites and unique finalized storage are enforced on create/deploy/claim, with
  transaction-local quota checks at creation, claim and finalize.
- Reject inconsistent per-hash manifest sizes and reuse sizes that disagree with
  the caller's verified bytes, before recording a version. Accounting uses verified
  blob sizes when available, without exposing another tenant's storage.
- Add retry-safe `usage_counters`, `recomputeUsage()` and nightly attributed
  `storage_snapshot` metering. Pending uploads do not count; retained ready versions
  do, with a shared hash charged once per tenant until its last active reference is removed.
- REST and MCP `whoami` include capability decisions, size/resource limits and usage.
  Add `delete_folder` to the registry; deleting an organizer keeps its sites.

### Extension API

- Bump `EXTENSION_API_VERSION` to 3. `beforeDeploy` now receives `newBytes`, and
  `deleteVersion(dc, principal, site, versionId)` now enforces deletion permission.
  Config gains `quotas`; REST compatibility adapters validate input before policy
  and may supply `http.parseInput` and a logical `http.policyId`. Raw publishing
  uses `publish_site` for policy on both transports, after parsing and before writes.
  Generated MCP tools also recheck authorization/capability/policy before exposing
  cached results via the optional `beforeReplay` tool guard; no handler is rerun.
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

- Export `EXTENSION_API_VERSION = 1` from `@dropway/server`, identifying the
  current public embedding contract. Extension API changes must update this
  version and this section.
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
