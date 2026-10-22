import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ConfigOverrides, DropwayAdapters, DropwayContext, DropwayHooks, Principal, Scope } from "@dropway/core";
import type { DropwayEnv, ServerBindings } from "./env";
import type { Viewer } from "./viewers";

/**
 * Extra REST routes. Called once at startup with the API router (mounted at
 * /api/v1, principal already resolved, errors already JSON) and the app router
 * (app origin root). Extension routes are registered BEFORE core routes, so an
 * extension can replace a core route by registering the same method + path.
 * Keep routes thin: parse input, call a service, shape JSON.
 */
export type RouteExtension = (routers: { api: Hono<DropwayEnv>; app: Hono<DropwayEnv> }) => void;

/** What an MCP tool handler receives. */
export interface McpToolContext {
  dw: DropwayContext;
  principal: Principal;
  request: Request;
  /** Who is calling, for attribution: MCP clientInfo ("claude-code/2.1"), X-Dropway-Client or User-Agent. */
  client: string | null;
  /** The idempotencyKey argument, when the tool takes one (already applied by the server). */
  idempotencyKey: string | null;
}

/**
 * An MCP tool contributed by core or an extension. The MCP server (packages/server/src/mcp,
 * built on the Cloudflare Agents SDK) registers every tool in dropway.mcpTools.
 * Handlers must call @dropway/core services, never fetch the REST API.
 *
 * Handlers return a plain JSON object. The server sends it as `structuredContent`,
 * plus a text block (one plain-English line from `summarize`, then the compact JSON)
 * and a `resource_link` when the result has a `url`. Throw an ApiError for business
 * errors; the server turns it into an `isError: true` result with code, message and hint.
 */
export interface McpToolDefinition {
  /** snake_case; the same name as the REST operationId when there is one. */
  name: string;
  title?: string;
  /** Written for models: when to use it, what it returns, the common mistake. Under 4,096 characters. */
  description: string;
  /** JSON Schema (type: "object") for the arguments. Keep it flat (no oneOf) for model compatibility. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema (type: "object") of the result. Recommended; clients validate structuredContent against it. */
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Scopes the caller must hold (checked before the handler runs). */
  scopes?: Scope[];
  /** Group used by ?toolsets= narrowing ("core", "sites", "versions", "keys", "members", or your own). Default "extra". */
  toolset?: string;
  /** Ask clients that defer tool loading to always load this tool (`_meta["anthropic/alwaysLoad"]`). */
  alwaysLoad?: boolean;
  /**
   * Accept an `idempotencyKey` argument: a repeat call with the same key and arguments
   * replays the first result instead of running again (24 hours).
   */
  idempotent?: boolean;
  /** Remove secrets from a result before it is stored for idempotent replay. */
  redactForReplay?(result: unknown): unknown;
  /** Only list the tool when this returns true (e.g. a feature switched on in config). */
  enabled?(dw: DropwayContext): boolean;
  /** One plain-English line describing a successful result. */
  summarize?(result: any, args: Record<string, unknown>): string;
  handler(args: Record<string, unknown>, ctx: McpToolContext): Promise<unknown>;
}

/**
 * Serves the MCP endpoint. createDropway mounts it at /mcp on the app origin.
 * Receives the tools to expose (core + extensions).
 */
export type McpHandlerFactory = (tools: readonly McpToolDefinition[]) => (c: Context<DropwayEnv>) => Promise<Response>;

export interface NavItem {
  label: string;
  href: string;
  /** Lower sorts first. Core items use 0-99. */
  order?: number;
}

export interface UiPage {
  /** Path on the app origin, e.g. "/dashboard/billing". */
  path: string;
  title: string;
  /** Show in the dashboard navigation. */
  nav?: boolean;
  handler(c: Context<DropwayEnv>): Response | Promise<Response>;
}

/** Dashboard/UI extension slots. The dashboard reads these to build its navigation and pages. */
export interface UiSlots {
  navItems: NavItem[];
  pages: UiPage[];
  /** Replace the app-origin landing page (GET /). */
  landing?: (c: Context<DropwayEnv>) => Response | Promise<Response>;
  /** Extra HTML injected into <head> of Dropway-rendered app pages. */
  headHtml?: string;
}

export interface CreateDropwayOptions {
  /** Config overrides on top of Worker vars. A function receives the bindings. */
  config?: ConfigOverrides | ((env: ServerBindings) => ConfigOverrides);
  /** Replace any adapter; unspecified ones use the open-source defaults. */
  adapters?: Partial<DropwayAdapters>;
  /** Event hooks (one object or several). */
  hooks?: DropwayHooks | DropwayHooks[];
  /** Middleware run on /api/* after the principal is resolved and before routes. */
  apiMiddleware?: MiddlewareHandler<DropwayEnv>[];
  /** Extra REST/app routes. */
  routes?: RouteExtension[];
  /** Extra MCP tools, appended to the core tools. */
  mcpTools?: McpToolDefinition[];
  /** The MCP endpoint implementation. Default: the built-in server, createMcpEndpoint() (packages/server/src/mcp). */
  mcp?: McpHandlerFactory;
  /** Dashboard/UI slots. */
  uiSlots?: Partial<UiSlots>;
  /** Extra file viewers, tried before the core ones. */
  viewers?: Viewer[];
  /** Extra cron work (runs after core cleanup). */
  scheduled?: (dc: DropwayContext, controller: ScheduledController) => Promise<void>;
}
