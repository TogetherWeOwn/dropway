# Dropway

Instant web hosting for AI agents and people, built entirely on Cloudflare.
Publish a file, a folder or a whole site to a live URL with one command or one
HTTP call. Every publish is an immutable version you can restore. MIT licensed;
runs on your own Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/dropway)
[![ci](https://github.com/TogetherWeOwn/dropway/actions/workflows/ci.yml/badge.svg)](https://github.com/TogetherWeOwn/dropway/actions/workflows/ci.yml)

Prefer not to self-host? A hosted version is coming.

> Status: early MVP. The REST API and the CLI work today. The MCP server and the dashboard are in progress.

## What you get

- **One-call publish**: a folder, a `.zip`, JSON, or a single raw file becomes a live URL.
- **Content-addressed, incremental deploys**: only files the instance does not already hold are
  uploaded; an identical republish reports `unchanged` and creates no version.
- **Immutable versions** with instant restore and stale-write protection (`baseVersionId`).
- **Files render in the browser**: HTML as a real page, Markdown as a formatted page with "View raw";
  `?raw=1` returns any file's source, folders without an index get a listing.
- **Agent-first**: CLI with JSON output and stable exit codes, REST API with `/openapi.json` and
  `/llms.txt`, MCP endpoint at `/mcp`. Every error has a stable `code` and a `hint`.
- **Scoped API keys** (`sites:read`, `sites:write`, `keys:write`, `members:write`, optional single-site
  restriction); only hashes are stored.
- **Single tenant**: an owner plus optional members. No signup and no billing.
- **Cheap and fast**: one Worker with D1, R2 (each file stored once, by SHA-256), KV and Analytics Engine.

## Quick start for agents

You need an instance URL and an API key. Self-host one in a few minutes (next section), then:

```sh
export DROPWAY_API=https://<your-instance>          # e.g. https://dropway.<you>.workers.dev
export DROPWAY_API_KEY=dw_...
```

### CLI

```sh
npx dropway publish ./dist --json          # prints {"ok":true,"url":"https://...", ...}
npx dropway publish ./dist --site docs     # update the site "docs" (created if missing)
npx dropway versions docs                  # every version; restore with: npx dropway restore docs v2
```

Only changed files are uploaded, the command exits non-zero with a machine-readable error when
something is wrong, and `--wait` returns only once the URL serves the new version. Full reference:
[packages/cli/README.md](packages/cli/README.md). (The npm package is being prepared; until it is
published, run `node packages/cli/bin/dropway.mjs` from a clone after `npm install`.)

### curl

```sh
curl "$DROPWAY_API/api/v1/publish" \
  -H "Authorization: Bearer $DROPWAY_API_KEY" \
  -F "index.html=@index.html" -F "assets/app.js=@dist/assets/app.js"
# -> { "url": "https://<your-instance>/s/bright-otter-x7k2/", "version": { "number": 1, ... }, ... }

# A build folder as a zip, into a named site:
(cd dist && zip -qr ../site.zip .)
curl "$DROPWAY_API/api/v1/publish?slug=my-site" \
  -H "Authorization: Bearer $DROPWAY_API_KEY" \
  -H "Content-Type: application/zip" --data-binary @site.zip
```

For large sites use the manifest flow (send hashes, upload only what is missing, finalize). It is
described in `GET /llms.txt` and `GET /openapi.json` on your instance.

### MCP

The MCP endpoint is `https://<your-instance>/mcp` (Streamable HTTP), authenticated with the same API key.

Claude Code:

```sh
claude mcp add --transport http dropway "$DROPWAY_API/mcp" --header "Authorization: Bearer $DROPWAY_API_KEY"
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "dropway": {
      "url": "https://<your-instance>/mcp",
      "headers": { "Authorization": "Bearer ${env:DROPWAY_API_KEY}" }
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "inputs": [{ "type": "promptString", "id": "dropway-key", "description": "Dropway API key", "password": true }],
  "servers": {
    "dropway": {
      "type": "http",
      "url": "https://<your-instance>/mcp",
      "headers": { "Authorization": "Bearer ${input:dropway-key}" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.dropway]
url = "https://<your-instance>/mcp"
bearer_token_env_var = "DROPWAY_API_KEY"
```

Claude Desktop and other clients that only start local servers, through
[`mcp-remote`](https://github.com/geelen/mcp-remote):

```json
{
  "mcpServers": {
    "dropway": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-instance>/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer dw_..." }
    }
  }
}
```

Agents that can run a shell should prefer `npx dropway publish <dir> --json`: no file bytes pass
through the model.

## Self-host on your Cloudflare account

1. Click **Deploy to Cloudflare** above. Cloudflare copies this repository to your GitHub account,
   creates the D1 database, R2 bucket and KV namespace, applies the database migrations and deploys
   the Worker. Set `ADMIN_BOOTSTRAP_KEY` to a long random string (`openssl rand -hex 32`) when asked.
   (Your account needs R2 enabled once in the dashboard.)
2. Create the owner and save their key:

   ```sh
   DROPWAY_BOOTSTRAP_KEY=<your bootstrap key> npx dropway setup --api https://<your-worker>.workers.dev --email you@example.com
   ```

   or with curl: `curl -X POST https://<your-worker>.workers.dev/api/v1/setup -H "Authorization: Bearer <bootstrap key>" -H "Content-Type: application/json" -d '{"email":"you@example.com"}'`
3. Publish: `npx dropway publish ./dist`.

Sites are served at `https://<your-worker>.workers.dev/s/<name>/` out of the box. With a domain of
your own, each site can get its own origin (`https://<name>.your-sites-domain.com`). Command-line
deploys, configuration, serving modes and upgrades: [docs/SELF_HOST.md](docs/SELF_HOST.md).

## API reference

Every instance describes itself:

- `GET /openapi.json`: OpenAPI 3.1 for the REST API (`/api/v1`)
- `GET /llms.txt`: a short guide for language models
- `GET /api/v1/me`: who your key is and what it may do

## Docs

- [Self-hosting and configuration](docs/SELF_HOST.md)
- [CLI reference](packages/cli/README.md)
- [Architecture and extension points](docs/ARCHITECTURE.md)
- [Notes for coding agents working on this repo](AGENTS.md)

## Development

Node.js 22 or newer.

```sh
npm install
npm run check      # open-core guard, typecheck, all tests
npm test           # Workers-runtime tests (D1, R2, KV emulated) + CLI tests against a local Worker
npm run dev        # wrangler dev; put ADMIN_BOOTSTRAP_KEY in .dev.vars
```

This repository is the complete single-tenant product. CI fails if billing, pricing or payment code,
or code from a hosted service, lands here (`scripts/guard-open-core.mjs`).

## License

[MIT](LICENSE)
