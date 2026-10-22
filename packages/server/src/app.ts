import { Hono, type Context } from "hono";
import { appOrigin, isSetUp, siteUrl, type DropwayConfig } from "@dropway/core";
import type { DropwayEnv } from "./env";
import type { McpHandlerFactory, McpToolDefinition, UiSlots } from "./extensions";
import { APP_PAGE_CSP, escapeHtml, htmlPage } from "./html";
import { buildOpenApi } from "./openapi";

/**
 * App-origin pages: landing, /openapi.json, /llms.txt, /health, /claim, /mcp.
 * The dashboard/viewer work replaces the landing via uiSlots.landing and adds
 * pages via uiSlots.pages; the MCP work plugs in through createDropway({ mcp }).
 */

const LANDING_CSS = `
.dw-land{max-width:46rem;margin:0 auto;padding:4rem 1.25rem 5rem}
.dw-land h1{font-size:2.4rem;line-height:1.1;margin:0 0 .75rem;letter-spacing:-.02em}
.dw-land .lede{font-size:1.15rem;color:var(--muted);margin:0 0 2.5rem}
.dw-land h2{font-size:1.05rem;margin:2.25rem 0 .6rem}
.dw-land pre{background:var(--code);padding:1rem;border-radius:10px;overflow:auto;line-height:1.5;font-size:.85rem;white-space:pre-wrap;word-break:break-all}
.dw-land .note{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:.75rem 1rem;background:var(--card)}
.dw-land footer{margin-top:3rem;color:var(--muted);font-size:.9rem}
`;

function pageHeaders(): Record<string, string> {
  return { "Content-Security-Policy": APP_PAGE_CSP, "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };
}

function exampleSiteUrl(config: DropwayConfig, origin: string): string {
  return siteUrl({ config, requestUrl: new URL(origin) }, "bright-otter-x7k2");
}

async function landing(c: Context<DropwayEnv>, headHtml: string): Promise<Response> {
  const dw = c.get("dw");
  const o = appOrigin(dw);
  const name = escapeHtml(dw.config.instanceName);
  const setUp = await isSetUp(dw).catch(() => true);
  const anon = dw.config.anonymous.enabled;
  const e = (s: string) => escapeHtml(s);
  const body = `<main class="dw-land">
<h1>${name}</h1>
<p class="lede">Publish a file, a folder or a whole site to a live URL in one call. Built for AI agents and people, running entirely on Cloudflare.</p>
${
  setUp
    ? ""
    : `<p class="note"><strong>This instance is not set up yet.</strong> Create the owner with the bootstrap secret you configured (ADMIN_BOOTSTRAP_KEY):</p>
<pre>curl -X POST ${e(o)}/api/v1/setup \\
  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_KEY" \\
  -H "Content-Type: application/json" -d '{"email":"you@example.com"}'</pre>`
}
<h2>Publish a page</h2>
<pre>curl ${e(o)}/api/v1/publish \\
  -H "Authorization: Bearer $DROPWAY_API_KEY" \\
  -F "index.html=@index.html"</pre>
<p>The response contains <code>url</code>, for example <code>${e(exampleSiteUrl(dw.config, o))}</code>.${
    anon ? " Without an API key the site is anonymous and expires after 24 hours." : " This instance requires an API key."
  }</p>
<h2>Publish a folder or a build</h2>
<pre>cd dist &amp;&amp; zip -qr ../site.zip . &amp;&amp; cd ..
curl ${e(o)}/api/v1/publish -H "Authorization: Bearer $DROPWAY_API_KEY" \\
  -H "Content-Type: application/zip" --data-binary @site.zip</pre>
<h2>Update the same site</h2>
<pre>curl ${e(o)}/api/v1/publish?slug=my-site -H "Authorization: Bearer $DROPWAY_API_KEY" \\
  -F "index.html=@index.html" -F "notes.md=@notes.md"</pre>
<p>Every publish is an immutable version; restore any of them with <code>POST /api/v1/sites/:slug/versions/:id/restore</code>. Markdown renders as a page for browsers; add <code>?raw=1</code> to any file for its raw bytes.</p>
<h2>Large sites: incremental deploys</h2>
<p>Send a manifest of <code>{path, size, sha256}</code> to <code>POST /api/v1/sites/:slug/deploys</code>, upload only the files it reports missing with <code>PUT /api/v1/blobs/:sha256</code>, then <code>POST .../finalize</code>. Unchanged files are never uploaded twice.</p>
<h2>For agents</h2>
<p><a href="/openapi.json">OpenAPI</a> · <a href="/llms.txt">llms.txt</a> · MCP endpoint at <code>${e(o)}/mcp</code></p>
<footer>Open source (MIT): <a href="https://github.com/TogetherWeOwn/dropway">github.com/TogetherWeOwn/dropway</a>. Self-host it on your own Cloudflare account.</footer>
</main>`;
  return c.html(htmlPage({ title: dw.config.instanceName, css: LANDING_CSS, body, head: headHtml }), 200, pageHeaders());
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

  app.get("/", (c) => (opts.uiSlots.landing ? opts.uiSlots.landing(c) : landing(c, opts.uiSlots.headHtml ?? "")));
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
