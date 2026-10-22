# Changelog

## Unreleased

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

### Extension API

- Export `EXTENSION_API_VERSION = 1` from `@dropway/server`, identifying the
  current public embedding contract. Extension API changes must update this
  version and this section.
- Cover existing identity, policy limits and refusals, all five metering events,
  all three hooks, API middleware, route overrides and app routes, contexts,
  MCP tools and endpoint replacement, UI slots, viewers and scheduled work in
  `test/extension-contract.test.ts`, using fake adapters and real emulated storage.

### Open-core guard

- Scan npm shrinkwrap and legacy nested npm dependencies, Yarn, pnpm and Bun
  text lockfiles for excluded SDKs, in addition to modern npm lockfiles. Check
  `npm:` alias targets in manifests and lockfiles as well as dependency names.
  Reject binary `bun.lockb` with instructions to regenerate an auditable text lockfile.
