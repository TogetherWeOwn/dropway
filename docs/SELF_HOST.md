# Self-hosting Dropway

Dropway runs on your own Cloudflare account: one Worker plus a D1 database, an R2 bucket and a KV
namespace (Analytics Engine creates its dataset on the first write). It is a single-tenant product:
you (the owner) plus the members and API keys you create. There is no signup and no billing.

You need:

- A Cloudflare account with R2 turned on (a one-time step in the dashboard under R2; the deploy
  cannot do it for you).
- For the button: a GitHub or GitLab account. For the command line: Node.js 22 or newer.
- The free Workers plan is enough to try it. Workers Paid is recommended for real use: the free
  plan's 10 ms of CPU per request is tight for zip uploads and large pages.

## Option 1: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/dropway)

Link: `https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/dropway`

What happens, per Cloudflare's [Deploy button docs](https://developers.cloudflare.com/workers/platform/deploy-buttons/):

1. Cloudflare copies this repository into your GitHub (or GitLab) account and connects it to
   Workers Builds, so every push to your copy redeploys.
2. It reads `wrangler.jsonc` and creates what it lists: the D1 database `dropway`, the R2 bucket
   `dropway-files` and a KV namespace. You can rename them on the setup page.
3. It asks for `ADMIN_BOOTSTRAP_KEY` (listed in `.dev.vars.example`; the help text comes from
   `cloudflare.bindings` in `package.json`). Use a long random string: `openssl rand -hex 32`.
4. It runs `npm run deploy`, which applies the D1 migrations and then deploys the Worker.

The button points at the repository root on purpose. The docs say Cloudflare "does not fully
support monorepos": a button for a subdirectory treats that folder as the whole repository, so it must
contain everything it needs. The Worker entry (`apps/worker`) imports `packages/*`, so
`wrangler.jsonc` sits at the root with `"main": "apps/worker/src/index.ts"`.

Changing settings later: edit the `vars` in `wrangler.jsonc` in your copy and push. Do not rely on
editing variables in the dashboard: the next `wrangler deploy` replaces dashboard variables with the
ones in `wrangler.jsonc` unless you set `"keep_vars": true`. Secrets (`ADMIN_BOOTSTRAP_KEY`,
`SIGNING_SECRET`) are kept across deploys.

## Option 2: Command line

```sh
git clone https://github.com/TogetherWeOwn/dropway && cd dropway
npm install
npx wrangler login
npx wrangler secret put ADMIN_BOOTSTRAP_KEY   # paste a long random string (openssl rand -hex 32)
npm run deploy
```

`npm run deploy` is safe to re-run for upgrades: it applies new migrations, then deploys.

On the first run nothing exists yet, so it deploys once (Wrangler's
[automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
creates the D1 database, R2 bucket and KV namespace and writes their IDs back into `wrangler.jsonc`),
applies the migrations, and deploys again. Commit the updated `wrangler.jsonc` in your copy.

Name clashes: Wrangler connects to an existing D1 database or R2 bucket with the same name instead
of creating one. If your account already has a `dropway` database or a `dropway-files` bucket that
belongs to something else, change `name`, `database_name` and `bucket_name` in `wrangler.jsonc` first.

## Member browser sign-in

After setup, an existing member with a full-role, unrestricted key can request a
one-use sign-in link (15-minute expiry):

```sh
curl -X POST "$DROPWAY_URL/api/v1/login-links" \
  -H "Authorization: Bearer $DROPWAY_API_KEY" -H 'Content-Type: application/json' -d '{}'
```

Open the returned secret `url` in the intended person's browser. Administrators may
specify `memberId` for another existing member, but cannot grant greater authority.
Restricted API keys cannot become full-role browser sessions. Use an HTTPS app origin.
`/dashboard/sessions` lists sessions, revokes selected sessions and signs out. Sessions
last 30 days and slide with activity. Removing a member invalidates their sessions.
API-key sign-in and the resource dashboard remain available; ordinary REST resources
and MCP use bearer tokens, not cookies. No persistent API key is minted by browser login.

Email sign-in is optional: configure a Cloudflare Email Service `send_email` binding
named `EMAIL` and `EMAIL_FROM` with a sender on your verified sending domain. Without a
sender override the adapter uses `noreply@<app-host>` (which must be a verified sending
host for delivery). Existing members receive a six-digit code with five tries and a
15-minute expiry. Resending during that interval does not reset the budget. Without
`EMAIL` or an embedding `EmailAdapter`, the UI hides email sign-in and both operations
return `feature_unavailable`. Delivery uses the current
[Cloudflare Email Service structured Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/),
not an HTTP API credential or an implicit signup flow.

Optional Cloudflare Access: configure **both** `ACCESS_TEAM_DOMAIN` (team hostname or
HTTPS team origin, such as `example.cloudflareaccess.com`) and `ACCESS_AUD` (application
audience). The default identity verifies RS256 signatures using that team's fixed JWKS
endpoint, issuer, audience and expiry, then maps a unique existing active member email.
An unsigned token or an email header alone grants no authority. Access never creates a
member implicitly. An explicit bearer credential takes precedence.

Anonymous claim links keep proof in their URL fragment. Opening the claim page keeps
it in this tab across sign-in and sends it only when submitting the actual claim form.
Browser cookie writes require exact app `Origin` **and** `Sec-Fetch-Site: same-origin`;
SameSite alone does not protect workers.dev sibling origins. Embedding-cookie deployments
still need their own security verification. Do not activate a release before its required
independent review/security and deployment checks pass.

## First run: create the owner

With the CLI (it saves the owner key in `~/.config/dropway/credentials.json`, mode 0600):

```sh
DROPWAY_BOOTSTRAP_KEY=<your bootstrap key> npx dropway setup --api https://<worker>.<you>.workers.dev --email you@example.com
npx dropway whoami
npx dropway publish ./some-folder
```

With curl:

```sh
curl -X POST https://<worker>/api/v1/setup \
  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_KEY" \
  -H "Content-Type: application/json" -d '{"email":"you@example.com"}'
# -> { "apiKey": { "key": "dw_..." }, ... }   (shown once)
```

Setup works once. If you lose the owner key, `POST /api/v1/setup/recover` with the bootstrap key mints
a new one. Add people with `POST /api/v1/members` (each gets their own key) and create narrower keys
(for CI or an MCP client) with `POST /api/v1/keys`, e.g.
`npx dropway api POST /keys --data '{"name":"ci","scopes":["sites:read","sites:write"]}'`.

## Configuration

Variables go in `vars` in `wrangler.jsonc`; secrets with `npx wrangler secret put <NAME>`.

| Name | Default | Meaning |
|---|---|---|
| `ADMIN_BOOTSTRAP_KEY` (secret) | none | Creates the owner on first run; mints recovery owner keys |
| `SIGNING_SECRET` (secret) | bootstrap key | HMAC secret for password cookies and IP hashing |
| `INSTANCE_NAME` | `Dropway` | Shown in pages and API responses |
| `APP_ORIGIN` | request origin | Public origin of the app and API |
| `LEGACY_APP_ORIGINS` | empty | Former app origins (comma-separated), after a move to a new `APP_ORIGIN`. See [Moving the app](#moving-the-app-to-a-new-origin) |
| `LEGACY_DEPRECATED_AT` | none | Date of that move (ISO 8601 or Unix seconds), sent as `Deprecation: @<seconds>`; unset = no `Deprecation` header (the successor `Link` is still sent) |
| `SITES_MODE` | `path` | `path` or `subdomain` (see below) |
| `SITES_DOMAIN` | empty | Subdomain mode: sites at `https://<name>.<SITES_DOMAIN>/` |
| `SITES_ORIGIN` | empty | Path mode: origin of a second, sites-only deployment of the same Worker. Ignored in subdomain mode |
| `LEGACY_SITES_ORIGINS` | empty | Former path-mode sites origins (comma-separated): `<origin>/<name>/<path>` answers `308` to the site's current URL, path and query kept (not cached) |
| `SITES_SANDBOX` | `auto` | `auto`: on a separate sites origin, sandbox anonymous sites only. `true`: sandbox every site. `false`: none. Always on when sites share the app origin |
| `ANONYMOUS_PUBLISH` | `false` | Allow publishing without a key (sites expire; a claim token is returned) |
| `ANON_TTL_HOURS` | `24` | Lifetime of anonymous sites |
| `ANON_SITES_PER_HOUR` | `60` | New anonymous sites per IP per hour |
| `ANON_MAX_FILE_BYTES` / `ANON_MAX_SITE_BYTES` | 25 MB / 250 MB | Caps for anonymous sites |
| `MAX_FILE_BYTES` | 100 MB | Largest file |
| `MAX_FILES` | 2500 | Most files per version |
| `MAX_SITE_BYTES` | 10 GB | Largest version |
| `ONESHOT_MAX_BYTES` | 25 MB | Largest one-shot `POST /api/v1/publish` body (bigger sites use the manifest flow, which the CLI always uses) |

## Where sites are served

| | A. Path mode (default) | B. Second Worker on workers.dev | C. Subdomain mode (your domain) |
|---|---|---|---|
| Site URL | `https://<worker>/s/<name>/` | `https://<worker>-sites.<you>.workers.dev/<name>/` | `https://<name>.<your-sites-domain>/` |
| Setup | none | one extra deploy | a domain on Cloudflare, one DNS record, one route |
| Isolation | sites share the app origin, so they are always sandboxed | sites are separated from the app, not from each other | every site is its own origin |
| Limits for pages | no cookies, `localStorage` or service workers (sandbox); root-relative import specifiers and `location.href = "/x"` do not resolve | sites share one origin's storage (anonymous sites are sandboxed) | none |
| Use when | trying it out, personal use | a team that trusts its publishers, before buying a domain | untrusted publishers, or as soon as you have a domain |

### A. Path mode

Nothing to do. Sites are served under `/s/<name>/` on the same Worker with a CSP sandbox, so a page
can never read the app's storage. Root-relative URLs in HTML and CSS (`/assets/app.js`) are rewritten
to stay inside the site, and a small script at the top of each page does the same for URLs built in
JavaScript (`fetch("/data.json")`, `img.src = "/x.png"`, XHR, `innerHTML`). Import specifiers
(`import "/x.js"`), `location.href = "/x"` and `history.pushState("/x")` are not rewritten: use
relative URLs there, or subdomain mode.

### B. A second deployment for sites

1. In `wrangler.jsonc` set `"APP_ORIGIN": "https://<worker>.<you>.workers.dev"` and
   `"SITES_ORIGIN": "https://<worker>-sites.<you>.workers.dev"`, then `npm run deploy`.
2. Deploy the same code and bindings under a second name: `npx wrangler deploy --name <worker>-sites`.

Both Workers share the same D1, R2 and KV. The app redirects `/s/<name>/...` to the sites origin and
never serves user content itself. Both also run the hourly cleanup cron; each cleanup step re-checks
state before changing it, so running it twice is safe.

### C. Subdomain mode with your own domain

Use a domain for sites that is a different registrable domain from the app (for example the app on
`dropway.<you>.workers.dev` or `dropway.example.com`, sites on `example-sites.com`), so a published page
can never set or read the app's cookies.

1. **Add the domain** to your Cloudflare account (a full zone, so Cloudflare serves its DNS).
2. **Wildcard DNS record**: type `AAAA`, name `*`, IPv6 address `100::`, proxy status **Proxied**.
   `100::` is the documented placeholder for hostnames that only run a Worker
   ([routes docs](https://developers.cloudflare.com/workers/configuration/routing/routes/)); wildcard
   records can be proxied on every plan
   ([wildcard DNS docs](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)).
3. **Configure the Worker** in `wrangler.jsonc`:

   ```jsonc
   "workers_dev": true,   // keep the app on workers.dev; adding routes turns it off otherwise
   "routes": [{ "pattern": "*.example-sites.com/*", "zone_name": "example-sites.com" }],
   "vars": {
     "APP_ORIGIN": "https://dropway.<you>.workers.dev",
     "SITES_MODE": "subdomain",
     "SITES_DOMAIN": "example-sites.com"
     // ...keep the other vars; clear SITES_ORIGIN (subdomain mode ignores it)
   }
   ```

   It must be a route, not a Custom Domain: Custom Domains
   ["do not support wildcard DNS records"](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
4. **Deploy**: `npm run deploy`, or push to your copy if you used the button.
5. **Check**: `curl -sI https://anything.example-sites.com/` answers from Dropway (404, no such site),
   and a new publish returns `https://<name>.example-sites.com/`. Old `/s/<name>/` links on the app
   redirect to the new URLs. If sites were on a second Worker before (option B), set
   `LEGACY_SITES_ORIGINS` to its old origin so `<old origin>/<name>/...` links redirect too, and
   clear `SITES_ORIGIN`: subdomain mode ignores it (left set, it does not stop those redirects).

In subdomain mode `www.<SITES_DOMAIN>` redirects to the app, and reserved names (`files`, `fallback`,
`customers`, `api`, ...) are never served as sites. Site names are at most 56 characters, so a version
preview host `<name>--v<N>` still fits one DNS label. Password-protected sites use a `__Host-` cookie,
send no CORS headers and `Cross-Origin-Resource-Policy: same-origin`, and refuse (`403`) non-navigation
requests from other sites (`Sec-Fetch-Site: same-site` or `cross-site`): sibling `<name>.<SITES_DOMAIN>`
hosts are the same site until the domain is on the Public Suffix List. A password entered in the
dashboard's file viewer (a cross-site frame) sets a partitioned cookie for that frame only.

TLS: Universal SSL covers the apex and first-level subdomains only
([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)).
Site names are single labels, so `<name>.example-sites.com` is covered. Do not use a deeper
`SITES_DOMAIN` such as `sites.example.com`: `<name>.sites.example.com` would need an advanced
certificate.

To put the app itself on your domain too, add a Custom Domain route such as
`{ "pattern": "dropway.example.com", "custom_domain": true }` and set `APP_ORIGIN` to match.

### Moving the app to a new origin

Keep `"workers_dev": true`, set `APP_ORIGIN` to the new origin and list the old one in
`LEGACY_APP_ORIGINS` (for example `"https://dropway.<you>.workers.dev"`). On the old origin:

- `/api/*`, `/mcp`, `/health`, `/.well-known/*`, `/llms.txt`, `/llms-full.txt`, `/openapi.json` and
  `/skill.md` keep answering, with `Deprecation` and `Link: <new URL>; rel="successor-version"`
  headers. They are not redirected: HTTP clients drop the `Authorization` header on a cross-origin
  redirect, so a redirected agent would get 401. The CLI prints a one-line note with the new address.
- Other `GET`/`HEAD` requests (pages, the dashboard, sign-in links) answer `308` to the same path and
  query on the new origin. The redirect is not cached, so moving back works at once. It carries
  `Access-Control-Allow-Origin: *` (never credentials), so cross-origin reads of published files at
  their old URLs (`/s/<site>/...`) follow it; the new origin decides whether the read is allowed.
  Other methods (webhooks, form posts) are served in place.
- Browser sessions are per host: people sign in again on the new origin.

## Upgrades, backups, removal

- **Upgrade**: pull the latest code (or sync your copy on GitHub), then `npm run deploy` (pushing
  your copy does this through Workers Builds). Migrations are additive and run before the new code.
- **Backups**: D1 Time Travel restores the database to any minute in the last 30 days (7 on the free
  plan). R2 objects are immutable and named by their SHA-256.
- **Removal**: delete the Worker(s), the D1 database, the R2 bucket and the KV namespace in the dashboard.

## Verify a deployment

```sh
npx dropway whoami --api https://<worker>          # instance reachable, key accepted
curl -s https://<worker>/openapi.json | head -c 200  # the API describes itself
```
