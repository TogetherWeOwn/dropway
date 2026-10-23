/** Browser and discovery routes are not registry API operations. */
type Json = Record<string, any>;
const page = (operationId: string, summary: string, metadata: Json): Json => ({ operationId, summary, description: summary, ...metadata });
export const PAGE_PATHS: Json = {
  "/mcp": {
    post: page("mcp", "Remote MCP server (Streamable HTTP, stateless)", {
      tags: ["agents"],
      description:
        'JSON-RPC over Streamable HTTP (MCP 2026-07-28, and 2025-era clients through the stateless lane). Same API keys as REST. Narrow the tool list with ?toolsets=core,sites,versions,keys,members and ?read_only=1. Example: claude mcp add --transport http dropway <origin>/mcp --header "Authorization: Bearer dw_..."',
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: "A JSON-RPC 2.0 request." } } } },
      "x-mcp-exclude": "this is the MCP endpoint itself",
      responses: {
        "200": { description: "JSON-RPC response (application/json or text/event-stream)." },
        "401": { description: "Missing or invalid API key (WWW-Authenticate: Bearer)." },
      },
    }),
  },
  "/": {
    get: page("landing", "Landing page (HTML)", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "browser page",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/health": {
    get: page("health", "Health check", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "monitoring",
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, service: { type: "string" } } } } },
        },
      },
    }),
  },
  "/claim": {
    get: page("claim_page", "Claim page for anonymous sites (token in the URL fragment)", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "browser page; use claim_site",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/login": {
    get: page("login_page", "Sign-in page (API key; first-run setup)", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
    post: page("login_form_fallback", "Where the sign-in forms post before the page script has loaded: redirects back to /login and ignores the body", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page",
      responses: { "303": { description: "Redirect to /login?retry=1" } },
    }),
  },
  "/dashboard": {
    get: page("dashboard_page", "Dashboard: sites list", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page; use list_sites",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/dashboard/": {
    get: page("dashboard_page_slash", "Redirects to /dashboard", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "redirect",
      responses: { "301": { description: "Redirect" } },
    }),
  },
  "/dashboard/sites/{slug}": {
    get: page("dashboard_site_page", "Dashboard: one site (versions, files, settings)", {
      tags: ["pages"],
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Site slug, e.g. bright-otter-x7k2 (routes marked as such also accept a site id).",
        },
      ],
      security: [],
      "x-mcp-exclude": "browser page; use get_site",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/dashboard/publish": {
    get: page("dashboard_publish_page", "Dashboard: drag-and-drop publish", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page; use publish_site",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/dashboard/keys": {
    get: page("dashboard_keys_page", "Dashboard: API keys and members", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page; use list_api_keys",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/dashboard/settings": {
    get: page("dashboard_settings_page", "Dashboard: instance settings", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/v/{slug}": {
    get: page("file_browser_root", "Redirects to /v/{slug}/", {
      tags: ["pages"],
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Site slug, e.g. bright-otter-x7k2 (routes marked as such also accept a site id).",
        },
      ],
      security: [],
      "x-mcp-exclude": "redirect",
      responses: { "301": { description: "Redirect" } },
    }),
  },
  "/v/{slug}/{path}": {
    get: page(
      "file_browser_page",
      "File browser: file tree plus a rendered, source or raw view of one file (rendered in a sandboxed frame on the sites origin)",
      {
        tags: ["pages"],
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Site slug, e.g. bright-otter-x7k2 (routes marked as such also accept a site id).",
          },
          { name: "path", in: "path", required: true, schema: { type: "string" }, description: "File path inside the site (may be empty or contain slashes)" },
        ],
        security: [],
        "x-mcp-exclude": "browser page; use read_file",
        responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
      },
    ),
  },
  "/view/{slug}/{path}": {
    get: page("file_browser_legacy", "Redirects to /v/{slug}/{path}", {
      tags: ["pages"],
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Site slug, e.g. bright-otter-x7k2 (routes marked as such also accept a site id).",
        },
        { name: "path", in: "path", required: true, schema: { type: "string" }, description: "File path" },
      ],
      security: [],
      "x-mcp-exclude": "redirect",
      responses: { "301": { description: "Redirect" } },
    }),
  },
  "/__dropway/ui/{file}": {
    get: page("dashboard_script", "Dashboard script (content-hashed name, cached immutable)", {
      tags: ["pages"],
      parameters: [{ name: "file", in: "path", required: true, schema: { type: "string" }, description: "Script file name" }],
      security: [],
      "x-mcp-exclude": "static asset",
      responses: { "200": { description: "JavaScript", content: { "text/javascript": { schema: { type: "string" } } } } },
    }),
  },
  "/openapi.json": {
    get: page("openapi", "This document", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
    }),
  },
  "/llms.txt": {
    get: page("llms_txt", "Agent quick reference (llms.txt)", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/llms-full.txt": {
    get: page("llms_full_txt", "Full agent reference: every endpoint, MCP tool and error code", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/skill.md": {
    get: page("skill", "Agent Skill (SKILL.md) for this instance", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/.well-known/agent-skills/index.json": {
    get: page("agent_skills_index", "Agent Skills discovery index (v0.2.0) for `npx skills add <origin>`", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
    }),
  },
  "/.well-known/agent-skills/{name}/SKILL.md": {
    get: page("agent_skill_file", "A skill listed in the discovery index", {
      tags: ["agents"],
      parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" }, description: "Skill name (dropway)" }],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/.well-known/skills/index.json": {
    get: page("agent_skills_index_legacy", "Legacy skills discovery index (v0.1.0)", {
      tags: ["agents"],
      security: [],
      deprecated: true,
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
    }),
  },
  "/.well-known/skills/{name}/SKILL.md": {
    get: page("agent_skill_file_legacy", "A skill listed in the legacy index", {
      tags: ["agents"],
      parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" }, description: "Skill name (dropway)" }],
      security: [],
      deprecated: true,
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
};
