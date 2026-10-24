import { Hono, type Context } from "hono";
import { appOrigin, type DropwayContext } from "@dropway/core";
import type { DropwayEnv } from "./env";
import type { McpHandlerFactory, McpToolDefinition, UiSlots } from "./extensions";
import { APP_PAGE_CSP, escapeHtml } from "./html";
import { buildOpenApi } from "./openapi";
import type { OperationDefinition } from "./operations";
import { agentSkillsIndex, legacySkillsIndex, llmsFullTxt, llmsTxt, skillInstance, skillMarkdown, SKILL_NAME } from "./discovery";
import { homePage, installUi } from "./ui";
import { nameCode, tok } from "./ui/code";
import { appStatePage, uiSlotsOf } from "./ui/shell";
import { installTransferPages } from "./transfers";
import { installEncrypted } from "./encrypted";
import { LEGACY_SKILL_NAME } from "./legacy-brand";

/**
 * App-origin pages: home, /openapi.json, /llms.txt, /health, /claim, /mcp,
 * plus the dashboard and file viewer (./ui). Embedding apps replace the home
 * page with uiSlots.landing and add pages with uiSlots.pages; the MCP server
 * plugs in through createDropway({ mcp }).
 */

function pageHeaders(): Record<string, string> {
  return { "Content-Security-Policy": APP_PAGE_CSP, "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", Vary: "Cookie" };
}

/** /llms.txt lives in ./discovery; re-exported here for compatibility. */
export { llmsTxt } from "./discovery";

/** Install the core app-origin routes on `app` (which may already hold extension routes). */
export function createAppRouter(opts: { app: Hono<DropwayEnv>; uiSlots: UiSlots; mcp?: McpHandlerFactory | undefined; mcpTools: readonly McpToolDefinition[]; operations: readonly OperationDefinition[] }) {
  const app = opts.app;
  const availableToolNames = (dw: DropwayContext) => new Set(opts.mcpTools.filter((tool) => !tool.enabled || tool.enabled(dw)).map((tool) => tool.name));

  for (const page of opts.uiSlots.pages) app.get(page.path, (c) => page.handler(c));
  installUi(app, opts.uiSlots);
  installTransferPages(app);
  installEncrypted(app);

  app.get("/", (c) => (opts.uiSlots.landing ? opts.uiSlots.landing(c) : homePage(c)));
  app.get("/health", (c) => c.json({ ok: true, service: "dropway" }));
  app.get("/openapi.json", (c) => {
    const dw = c.get("dw");
    const available = availableToolNames(dw);
    return c.json(buildOpenApi(appOrigin(dw), dw.config.instanceName, dw.config.anonymous.enabled, opts.operations, available), 200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" });
  });
  // Agent discovery (./discovery): llms.txt, llms-full.txt, the skill and its well-known indexes.
  const markdown = { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
  const describedBy = (o: string) => ({ Link: `<${o}/llms.txt>; rel="describedby"; type="text/markdown", <${o}/openapi.json>; rel="service-desc"` });
  app.get("/llms.txt", (c) => {
    const dw = c.get("dw");
    return c.body(llmsTxt(appOrigin(dw), dw.config, opts.mcpTools, opts.operations, availableToolNames(dw)), 200, markdown);
  });
  app.get("/llms-full.txt", (c) => {
    const dw = c.get("dw");
    return c.body(llmsFullTxt(appOrigin(dw), dw.config, opts.mcpTools, opts.operations, availableToolNames(dw)), 200, markdown);
  });
  const skill = (c: Context<DropwayEnv>) => {
    const name = c.req.param("name");
    if (name !== undefined && name !== SKILL_NAME && name !== LEGACY_SKILL_NAME) return c.notFound();
    return c.body(skillMarkdown(skillInstance(c.get("dw"))), 200, { ...markdown, ...describedBy(appOrigin(c.get("dw"))) });
  };
  app.get("/skill.md", skill);
  app.get("/.well-known/agent-skills/:name/SKILL.md", skill);
  app.get("/.well-known/skills/:name/SKILL.md", skill);
  app.get("/.well-known/agent-skills/index.json", async (c) => c.json(await agentSkillsIndex(c.get("dw")), 200, { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" }));
  app.get("/.well-known/skills/index.json", (c) => c.json(legacySkillsIndex(c.get("dw").config.instanceName), 200, { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" }));
  app.get("/claim", (c) => {
    const slug = c.req.query("slug") ?? "";
    const dw = c.get("dw");
    const o = appOrigin(dw);
    const curl = `curl -X POST ${o}/api/v1/sites/${slug}/claim \\
  -H "Authorization: Bearer $KOFRA_API_KEY" -H "Content-Type: application/json" \\
  -d '{"claimToken":"dwc_..."}'`;
    const html = appStatePage(dw, c.req.url, {
      title: "Claim a site",
      code: "CLAIM",
      heading: "Keep this site",
      // The site name and "#token=" are code.k-tok: each moves to the next line whole, never split at a hyphen.
      message: `Anonymous sites expire. To keep ${nameCode(slug)}, call the API with an API key of this instance and the claim token (the part of this link after ${tok("#token=")}):`,
      // No script on this page, so no Copy button: the command wraps (all of it shows) and one click selects it.
      extra: `<div class="k-codeblock"><div class="k-codeblock-h"><span class="k-k">Claim with curl</span><span class="k-small">One click selects the command</span></div><pre class="k-wrapped k-pick" tabindex="0" role="region" aria-label="Claim with curl">${escapeHtml(curl)}</pre></div>`,
      signIn: uiSlotsOf(c).session?.signInPath,
      footerLinks: uiSlotsOf(c).footerLinks,
    });
    return c.html(html, 200, pageHeaders());
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
