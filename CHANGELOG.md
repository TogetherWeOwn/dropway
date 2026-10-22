# Changelog

## Unreleased

### Moving the app to a new origin

- `LEGACY_APP_ORIGINS` (and `LEGACY_DEPRECATED_AT`): former app origins keep serving the REST API,
  MCP, `/health`, `/.well-known/*` and the agent documents with `Deprecation` and
  `Link: rel="successor-version"` headers, and never redirect them (clients drop `Authorization` on
  cross-origin redirects). Other `GET`/`HEAD` requests 308 to `APP_ORIGIN`, uncached.
  New config fields `legacyAppOrigins` and `legacyDeprecatedAt`.
- The CLI notes once per run when an instance answers with those headers, naming the new address.
- The product name comes from `INSTANCE_NAME` in the served skill (heading, description, homepage),
  both skills indexes and the MCP server instructions. The skill's `name` stays `dropway`.

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
