# Dropway

Instant web hosting for AI agents and people, built entirely on Cloudflare.
Publish a file, a folder or a whole site to a live URL with one HTTP call. Every
publish is an immutable version you can restore. MIT licensed and self-hostable
on your own Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/dropway)

> Status: early MVP. The REST API and the remote MCP server are usable today; the dashboard and CLI are in progress.

## What you get

- **One-call publish**: multipart files, a `.zip`, JSON, or a single raw file -> live URL.
- **Incremental, content-addressed deploys**: send a manifest of `{path, size, sha256}`, upload only what changed, finalize atomically. Identical republishes are detected (`unchanged: true`).
- **Immutable versions** with instant restore, optimistic concurrency (`baseVersionId`), per-version delete.
- **Viewers**: Markdown renders as a page in browsers; `?raw=1` gives any file's raw bytes (HTML as source); folders without an index get a listing.
- **Scoped API keys** (`sites:read`, `sites:write`, `keys:write`, `members:write`, optional single-site restriction); only hashes are stored.
- **Single tenant**: an owner plus optional members. No signup, no billing.
- **Built for agents**: a remote MCP server at `/mcp` with a tool for every capability, an installable Agent Skill (`npx skills add TogetherWeOwn/dropway`), `/openapi.json`, `/llms.txt` and `/llms-full.txt` on every instance. Every error has a stable `code` and a `hint`; writes take idempotency keys.
- **Cheap and fast**: one Worker; D1, R2 (bytes stored once by SHA-256), KV, Analytics Engine.

## Quick start (your own instance)

1. Click **Deploy to Cloudflare** above. When asked, set `ADMIN_BOOTSTRAP_KEY` to a long random string (`openssl rand -hex 32`).
2. Create the owner and get an API key:

```sh
curl -X POST https://<your-worker>.workers.dev/api/v1/setup \
  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_KEY" \
  -H "Content-Type: application/json" -d '{"email":"you@example.com"}'
# -> { "apiKey": { "key": "dw_..." }, ... }   (shown once)
```

3. Publish:

```sh
export DROPWAY_API_KEY=dw_...
curl https://<your-worker>.workers.dev/api/v1/publish \
  -H "Authorization: Bearer $DROPWAY_API_KEY" \
  -F "index.html=@index.html" -F "assets/app.js=@dist/assets/app.js"
# -> { "url": "https://<your-worker>.workers.dev/s/bright-otter-x7k2/", ... }
```

Publish a build folder as a zip, or update an existing site by name:

```sh
(cd dist && zip -qr ../site.zip .)
curl "https://<your-worker>.workers.dev/api/v1/publish?slug=my-site" \
  -H "Authorization: Bearer $DROPWAY_API_KEY" \
  -H "Content-Type: application/zip" --data-binary @site.zip
```

Connect an agent over MCP (same API key):

```sh
claude mcp add --transport http dropway https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer $DROPWAY_API_KEY"
```

## Docs

- [Self-hosting and configuration](docs/SELF_HOST.md)
- [Architecture and extension points](docs/ARCHITECTURE.md)
- [Agents: MCP server, REST twins, skill](docs/MCP.md)
- API: `GET /openapi.json`, `/llms.txt` and `/llms-full.txt` on any instance

## Development

```sh
npm install
npm test           # vitest inside the Workers runtime (D1, R2, KV emulated)
npm run typecheck
npm run dev        # wrangler dev; put ADMIN_BOOTSTRAP_KEY in .dev.vars
```

## License

MIT
