import { Hono } from "hono";
import { appOrigin, type DropwayConfig } from "@dropway/core";
import type { DropwayEnv } from "./env";
import type { McpHandlerFactory, McpToolDefinition, UiSlots } from "./extensions";
import { APP_PAGE_CSP, escapeHtml, htmlPage } from "./html";
import { buildOpenApi } from "./openapi";
import { homePage, installUi } from "./ui";

/**
 * App-origin pages: home, /openapi.json, /llms.txt, /health, /claim, /mcp,
 * plus the dashboard and file viewer (./ui). Embedding apps replace the home
 * page with uiSlots.landing and add pages with uiSlots.pages; the MCP server
 * plugs in through createDropway({ mcp }).
 */

function pageHeaders(): Record<string, string> {
  return { "Content-Security-Policy": APP_PAGE_CSP, "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };
}

export function llmsTxt(origin: string, config: DropwayConfig): string {
  return `# ${config.instanceName}

> Instant web hosting for AI agents. Publish a file, folder or site to a live URL with one HTTP call. Every publish is an immutable version.

Base URL: ${origin}
Auth: \`Authorization: Bearer dw_...\` (API key from the instance owner).${config.anonymous.enabled ? " Anonymous publishing is enabled: without a key, sites expire after 24 hours and a claimToken is returned." : " Anonymous publishing is disabled on this instance."}
Errors: JSON \`{ "error": { "code", "message", "hint" } }\`. Follow the hint.

## Publish
- One call: \`curl ${origin}/api/v1/publish -H "Authorization: Bearer $KEY" -F "index.html=@index.html" -F "assets/app.js=@assets/app.js"\` (form field name = file path). Also accepts a .zip body, JSON \`{"files":[{"path","content"}]}\`, or one raw file with \`?path=name.ext\`.
- Same site again: add \`slug=<slug>\` (form field or query). Identical content returns \`unchanged: true\`.
- Share the \`url\` from the response exactly as returned.

## Incremental deploys (large sites)
1. \`POST /api/v1/sites/{slug}/deploys\` with \`{"files":[{"path","size","sha256","contentType"}]}\` (create the site first with \`POST /api/v1/sites {"slug":...}\`).
2. \`PUT /api/v1/blobs/{sha256}\` with the raw bytes of each file listed in \`uploads\`.
3. \`POST /api/v1/sites/{slug}/deploys/{id}/finalize\` makes the version live atomically.
Pass \`baseVersionId\` to avoid overwriting someone else's newer publish (409 version_conflict).

## Manage
- \`GET /api/v1/sites\`, \`GET|PATCH|DELETE /api/v1/sites/{slug}\` (settings: title, description, spa, renderMarkdown, crossOriginIsolation, password)
- \`GET /api/v1/sites/{slug}/versions\`, \`POST /api/v1/sites/{slug}/versions/{id}/restore\`
- \`GET /api/v1/sites/{slug}/files\`, \`GET /api/v1/sites/{slug}/files/{path}\` (raw bytes, ETag = sha256)
- \`POST /api/v1/keys\` (scopes: sites:read, sites:write, keys:write, members:write; optional \`site\` restriction)

## Viewing
- Browsers get rendered views for Markdown; \`?raw=1\` returns any file's raw bytes (HTML as source), \`?download=1\` downloads it, \`?view=1\` forces the rendered view.

## Docs
- OpenAPI: ${origin}/openapi.json
- MCP (Streamable HTTP): ${origin}/mcp
- Source: https://github.com/TogetherWeOwn/dropway
`;
}

/** Install the core app-origin routes on `app` (which may already hold extension routes). */
export function createAppRouter(opts: { app: Hono<DropwayEnv>; uiSlots: UiSlots; mcp?: McpHandlerFactory | undefined; mcpTools: readonly McpToolDefinition[] }) {
  const app = opts.app;

  for (const page of opts.uiSlots.pages) app.get(page.path, (c) => page.handler(c));
  installUi(app, opts.uiSlots);

  app.get("/", (c) => (opts.uiSlots.landing ? opts.uiSlots.landing(c) : homePage(c)));
  app.get("/health", (c) => c.json({ ok: true, service: "dropway" }));
  app.get("/openapi.json", (c) => {
    const dw = c.get("dw");
    return c.json(buildOpenApi(appOrigin(dw), dw.config.instanceName), 200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" });
  });
  app.get("/llms.txt", (c) => {
    const dw = c.get("dw");
    return c.text(llmsTxt(appOrigin(dw), dw.config), 200, { "Cache-Control": "public, max-age=300" });
  });
  app.get("/claim", (c) => {
    const slug = c.req.query("slug") ?? "";
    const o = appOrigin(c.get("dw"));
    const body = `<main class="dw-system"><div class="dw-code">CLAIM</div><h1>Keep this site</h1>
<p>Anonymous sites expire. To keep <code>${escapeHtml(slug)}</code>, call the API with an API key of this instance and the claim token (the part of this link after <code>#token=</code>):</p>
<pre style="white-space:pre-wrap;word-break:break-all;background:var(--code);padding:1rem;border-radius:8px">curl -X POST ${escapeHtml(o)}/api/v1/sites/${escapeHtml(slug)}/claim \\
  -H "Authorization: Bearer $DROPWAY_API_KEY" -H "Content-Type: application/json" \\
  -d '{"claimToken":"dwc_..."}'</pre></main>`;
    return c.html(htmlPage({ title: "Claim a site", body }), 200, pageHeaders());
  });

  const mcpHandler = opts.mcp?.(opts.mcpTools);
  app.all("/mcp", (c) => {
    if (mcpHandler) return mcpHandler(c);
    return c.json(
      { error: { code: "mcp_not_enabled", message: "This build has no MCP server mounted.", hint: "Use the REST API (see /openapi.json) or update the instance." } },
      501,
    );
  });
  app.all("/mcp/*", (c) => (mcpHandler ? mcpHandler(c) : c.notFound()));
  return app;
}
