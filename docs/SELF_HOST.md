# Self-hosting Dropway

Dropway runs on your own Cloudflare account: one Worker plus a D1 database, an
R2 bucket and a KV namespace. The free Workers plan is enough to start.

## Option 1: Deploy to Cloudflare button

Open `https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/dropway`.
Cloudflare forks the repository into your GitHub account, creates the D1
database, R2 bucket and KV namespace, applies the database migrations and
deploys the Worker. Set `ADMIN_BOOTSTRAP_KEY` when asked.

## Option 2: Command line

```sh
git clone https://github.com/TogetherWeOwn/dropway && cd dropway
npm install
npx wrangler login
npx wrangler secret put ADMIN_BOOTSTRAP_KEY   # paste a long random string
npm run deploy                                # creates resources on first run, applies migrations, deploys
```

`npm run deploy` is safe to re-run for upgrades: it applies new migrations first, then deploys.

## First run

```sh
curl -X POST https://<worker>/api/v1/setup \
  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_KEY" \
  -H "Content-Type: application/json" -d '{"email":"you@example.com"}'
```

This creates the owner and returns a full-scope API key (shown once). It works
once. If you lose the owner key, `POST /api/v1/setup/recover` with the bootstrap
key mints a new one. Add people with `POST /api/v1/members` (each gets their own
key) and create narrower keys with `POST /api/v1/keys`.

## Configuration (vars in `wrangler.jsonc`, secrets with `wrangler secret put`)

| Name | Default | Meaning |
|---|---|---|
| `ADMIN_BOOTSTRAP_KEY` (secret) | none | Creates the owner on first run; mints recovery owner keys |
| `SIGNING_SECRET` (secret) | bootstrap key | HMAC secret for password cookies and IP hashing |
| `APP_ORIGIN` | request origin | Public origin of the app and API |
| `SITES_MODE` | `path` | `path` or `subdomain` |
| `SITES_DOMAIN` | empty | Subdomain mode: sites at `https://<slug>.<SITES_DOMAIN>/` |
| `SITES_ORIGIN` | empty | Path mode: origin of a second, sites-only deployment of the same Worker |
| `SITES_SANDBOX` | `false` | Sandbox sites on a separate `SITES_ORIGIN` (always on when sites share the app origin) |
| `ANONYMOUS_PUBLISH` | `false` | Allow publishing without a key (sites expire, claim token returned) |
| `ANON_TTL_HOURS` | `24` | Lifetime of anonymous sites |
| `ANON_SITES_PER_HOUR` | `60` | Anonymous sites per IP per hour |
| `MAX_FILE_BYTES` | 100 MB | Largest file |
| `MAX_FILES` | 2500 | Most files per version |
| `MAX_SITE_BYTES` | 10 GB | Largest version |
| `ONESHOT_MAX_BYTES` | 25 MB | Largest one-shot `POST /api/v1/publish` body (use the manifest flow above this) |

## Serving modes

- **Path mode (default):** sites are served at `/s/<slug>/` on the same Worker,
  with a CSP sandbox so they can never read the app's storage. Root-relative
  URLs in HTML and CSS are rewritten to stay inside the site. URLs built in
  JavaScript at runtime must be relative. Sandboxed pages cannot use cookies,
  localStorage or service workers.
- **Subdomain mode (recommended with a domain):** every site gets its own
  origin. Add a domain to Cloudflare, then:
  1. DNS: a proxied wildcard record `*` (for example `AAAA *  100::`).
  2. In `wrangler.jsonc`: `"SITES_MODE": "subdomain"`, `"SITES_DOMAIN": "example-sites.com"`, and
     `"routes": [{ "pattern": "*.example-sites.com/*", "zone_name": "example-sites.com" }]`.
  3. `npm run deploy`. Universal SSL covers first-level wildcards.
  Use a different registrable domain for sites than for the app.
