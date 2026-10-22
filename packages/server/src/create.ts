import { Hono } from "hono";
import {
  ApiError,
  appOrigin,
  defaultIdentity,
  defaultPolicy,
  noopMetering,
  resolveConfig,
  runCleanup,
  type DropwayAdapters,
  type DropwayConfig,
  type DropwayContext,
  type DropwayHooks,
} from "@dropway/core";
import { createAppRouter } from "./app";
import type { DropwayEnv, ServerBindings } from "./env";
import type { CreateDropwayOptions, McpToolDefinition, UiSlots } from "./extensions";
import { escapeHtml, htmlPage } from "./html";
import { apiErrorResponse, installApiMiddleware, installApiRoutes } from "./routes/api";
import { redirectResponse, routeSiteRequest } from "./route-sites";
import { SITE_SANDBOX, serveSite, systemResponse } from "./serve";
import { bindUiSlots } from "./ui/shell";
import { VIEWERS, type Viewer } from "./viewers";

export interface Dropway {
  /** Worker fetch handler: export default { fetch: dropway.fetch, scheduled: dropway.scheduled }. */
  fetch(request: Request, env: ServerBindings, ctx: ExecutionContext): Promise<Response>;
  /** Worker cron handler: core cleanup, then options.scheduled. */
  scheduled(controller: ScheduledController, env: ServerBindings, ctx: ExecutionContext): Promise<void>;
  /** App-origin router (REST API mounted at /api/v1). Useful for tests and composition. */
  app: Hono<DropwayEnv>;
  /** MCP tools exposed by this instance (core + extensions). */
  mcpTools: readonly McpToolDefinition[];
  uiSlots: UiSlots;
  viewers: readonly Viewer[];
  adapters: DropwayAdapters;
  /** Build a service context outside a request (cron, queue consumers, scripts, tests). */
  context(env: ServerBindings, ctx: Pick<ExecutionContext, "waitUntil">, requestUrl?: URL | null): DropwayContext;
}

/** Core MCP tools. Filled in by the MCP module; extensions append theirs. */
export const CORE_MCP_TOOLS: McpToolDefinition[] = [];

const contexts = new WeakMap<Request, DropwayContext>();

/**
 * Build a Dropway Worker. The open-source entry (apps/worker) calls this with no
 * options; a hosted layer passes adapters, hooks, routes, MCP tools and UI slots.
 */
export function createDropway(opts: CreateDropwayOptions = {}): Dropway {
  const hooks: readonly DropwayHooks[] = opts.hooks ? (Array.isArray(opts.hooks) ? opts.hooks : [opts.hooks]) : [];
  const adapters: DropwayAdapters = {
    identity: opts.adapters?.identity ?? defaultIdentity,
    policy: opts.adapters?.policy ?? defaultPolicy,
    metering: opts.adapters?.metering ?? noopMetering,
  };
  const uiSlots: UiSlots = { navItems: [], pages: [], ...opts.uiSlots };
  const mcpTools: readonly McpToolDefinition[] = [...CORE_MCP_TOOLS, ...(opts.mcpTools ?? [])];
  const viewers: readonly Viewer[] = [...(opts.viewers ?? []), ...VIEWERS];

  const configs = new WeakMap<object, DropwayConfig>();
  const configFor = (env: ServerBindings): DropwayConfig => {
    let c = configs.get(env);
    if (!c) {
      const overrides = typeof opts.config === "function" ? opts.config(env) : (opts.config ?? {});
      c = resolveConfig(env, overrides);
      configs.set(env, c);
    }
    return c;
  };
  const context = (env: ServerBindings, ctx: Pick<ExecutionContext, "waitUntil">, requestUrl: URL | null = null): DropwayContext => ({
    env,
    config: configFor(env),
    adapters,
    hooks,
    requestUrl,
    waitUntil: (p) => ctx.waitUntil(p),
  });

  // Order matters: API middleware, then extension routes, then core routes,
  // so extensions see the resolved principal and can override core routes.
  const api = new Hono<DropwayEnv>();
  installApiMiddleware(api, opts.apiMiddleware ?? []);
  const appRoutes = new Hono<DropwayEnv>();
  for (const extend of opts.routes ?? []) extend({ api, app: appRoutes });
  installApiRoutes(api);
  const app = new Hono<DropwayEnv>();
  app.use("*", async (c, next) => {
    c.set("dw", contexts.get(c.req.raw) ?? context(c.env, c.executionCtx, new URL(c.req.url)));
    c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
    bindUiSlots(c, uiSlots);
    await next();
  });
  app.route("/api/v1", api);
  app.route("/", createAppRouter({ app: appRoutes, uiSlots, mcp: opts.mcp, mcpTools }));
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json(
        new ApiError(404, "route_not_found", `No API route for ${c.req.method} ${c.req.path}.`, `See ${appOrigin(c.get("dw"))}/openapi.json for every endpoint.`).toJSON(c.get("requestId")),
        404,
      );
    }
    return c.html(htmlPage({ title: "Not found", body: `<main class="dw-system"><div class="dw-code">404</div><h1>Not found</h1><p><a href="/">Home</a></p></main>` }), 404);
  });
  app.onError((err, c) => {
    if (c.req.path.startsWith("/api/")) return apiErrorResponse(c, err);
    console.error(JSON.stringify({ event: "app_error", path: c.req.path, error: String(err), stack: (err as Error)?.stack }));
    return c.text("Internal error", 500);
  });

  async function fetch(request: Request, env: ServerBindings, ctx: ExecutionContext): Promise<Response> {
    const dw = context(env, ctx, new URL(request.url));
    try {
      const route = await routeSiteRequest(dw, request);
      switch (route.kind) {
        case "site":
          return await serveSite(request, dw, route.slug, route.path, route.mode, viewers);
        case "redirect":
          return redirectResponse(route);
        case "sites_home":
          return sitesHome(dw);
        case "sites_not_found":
          return systemResponse(dw, request, { kind: "path", base: "/", sandbox: true, rewrite: null }, null, 404, "404", "Nothing is published here", "There is no site at this address. See {app}.");
        case "app":
          contexts.set(request, dw);
          return await app.fetch(request, env, ctx);
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "serve_error", url: request.url, error: String(e), stack: (e as Error)?.stack }));
      return new Response("Internal error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
  }

  async function scheduled(controller: ScheduledController, env: ServerBindings, ctx: ExecutionContext): Promise<void> {
    const dw = context(env, ctx, null);
    await runCleanup(dw);
    await opts.scheduled?.(dw, controller);
  }

  return { fetch, scheduled, app, mcpTools, uiSlots, viewers, adapters, context };
}

function sitesHome(dw: DropwayContext): Response {
  const o = appOrigin(dw);
  const page = htmlPage({
    title: dw.config.instanceName,
    body: `<main class="dw-system"><div class="dw-code">SITES</div><h1>${escapeHtml(dw.config.instanceName)} sites</h1><p>This address serves published sites at <code>/&lt;site&gt;/</code>. To publish your own, see <a href="${escapeHtml(o)}">${escapeHtml(o)}</a>.</p></main>`,
  });
  return new Response(page, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; ${SITE_SANDBOX}`,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
