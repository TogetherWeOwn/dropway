import { createMcpHandler } from "agents/mcp/server";
import { McpServer, fromJsonSchema, localhostAllowedOrigins } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import {
  ApiError,
  appOrigin,
  idempotencyScope,
  validateIdempotencyKey,
  withIdempotency,
  type DropwayContext,
  type Principal,
} from "@dropway/core";
import type { DropwayEnv } from "../env";
import type { McpHandlerFactory, McpToolDefinition } from "../extensions";
import { IDEMPOTENCY_KEY } from "./schemas";
import { requireOperationScopes } from "../operations";
import { withLegacyHeaderNames } from "../legacy-brand";

/**
 * Remote MCP server at /mcp: Streamable HTTP, stateless, built with createMcpHandler
 * from the Cloudflare Agents SDK (agents/mcp/server) and @modelcontextprotocol/server 2.x.
 *
 * - Every request builds a fresh McpServer (no session, no Durable Object). 2026-07-28
 *   clients use the per-request envelope; 2025-era clients use the stateless legacy lane.
 * - Auth: `Authorization: Bearer dw_...` (or a dwc_ claim token), resolved by the same
 *   identity adapter as the REST API. Missing or bad credentials get 401 + WWW-Authenticate.
 * - Tools come from dropway.mcpTools (core + extensions). Narrow them with
 *   ?toolsets=core,keys (or X-Kofra-Toolsets) and ?read_only=1 (or X-Kofra-Read-Only).
 */

export const MCP_SERVER_VERSION = "0.1.0";

export interface McpEndpointOptions {
  /** Server name sent in initialize/discover. Default "kofra". */
  name?: string;
  /** Replace the server instructions. */
  instructions?: (dw: DropwayContext) => string;
  /**
   * Browser Origin hostnames allowed to call /mcp. Default: localhost and the app's own
   * hostname. Calls without an Origin header (every non-browser MCP client) are always allowed.
   */
  allowedOriginHostnames?: string[] | "*";
}

type CompiledTool = {
  def: McpToolDefinition;
  input: ReturnType<typeof fromJsonSchema>;
  output: ReturnType<typeof fromJsonSchema> | undefined;
};

/** Server instructions (kept under 4,096 characters; a test checks). */
export function mcpInstructions(dw: DropwayContext): string {
  const o = appOrigin(dw);
  return `${dw.config.instanceName} publishes files, folders and small static sites to live URLs. Every publish is an immutable version you can roll back.

How to work:
- Publish: publish_site with files [{path, ...one source}]. Sources: content (text; base64 only for small binaries), url (the server downloads a public https URL; best for big or binary files already online), sha256+size (then PUT the bytes to the returned upload link and call finalize_version), copyFrom (reuse a file you already published). Put index.html (or index.md / README.md) at the root.
- Share the url field exactly as returned. Never build site URLs yourself; their shape depends on the instance.
- Edit: update_site_files writes, deletes or moves some files and keeps the rest. Pass baseVersionId from your last result; version_conflict means someone published since: re-read, re-apply, retry.
- Roll back: list_versions, then restore_version ("v3", "3" or an id).
- Check your work: list_files and read_file (text, or base64 for binaries; paged with offset).
- Destructive tools (delete_site, delete_version, remove_member) need confirm set to the slug (or the member's email).
- Writes take an optional idempotencyKey: reuse the same key when retrying the same call and you get the first result instead of a duplicate.
- Errors come back as results with isError: "<code>: <message> Fix: <hint>". Follow the hint.
- People opening a site get rendered views of Markdown and other files; add ?raw=1 to any file URL for the raw bytes.
- Many or large local files and a shell? Use the REST manifest flow (${o}/llms.txt) so bytes never pass through the model.
Docs: ${o}/llms.txt, ${o}/openapi.json, skill ${o}/skill.md.`;
}

function compile(tools: readonly McpToolDefinition[]): CompiledTool[] {
  const byName = new Map<string, McpToolDefinition>();
  for (const t of tools) byName.set(t.name, t); // later definitions (extensions) replace earlier ones
  return [...byName.values()].map((def) => {
    let schema = def.inputSchema;
    if (def.idempotent) {
      const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
      schema = { ...schema, properties: { ...props, idempotencyKey: IDEMPOTENCY_KEY } };
    }
    return { def, input: fromJsonSchema(schema), output: def.outputSchema ? fromJsonSchema(def.outputSchema) : undefined };
  });
}

function truthy(v: string | null | undefined): boolean {
  return !!v && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/** Which tools this request sees: enabled for the instance, in the requested toolsets, read-only if asked. */
export function selectTools<T extends { def: McpToolDefinition } | McpToolDefinition>(tools: readonly T[], dw: DropwayContext, request: Request): T[] {
  const url = new URL(request.url);
  const wanted = (url.searchParams.get("toolsets") ?? request.headers.get("x-kofra-toolsets") ?? "all")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const all = wanted.length === 0 || wanted.includes("all");
  const readOnly = truthy(url.searchParams.get("read_only") ?? request.headers.get("x-kofra-read-only"));
  return tools.filter((t) => {
    const def: McpToolDefinition = "def" in t ? t.def : t;
    if (def.enabled && !def.enabled(dw)) return false;
    if (!all && !wanted.includes((def.toolset ?? "extra").toLowerCase())) return false;
    if (readOnly && !def.annotations?.readOnlyHint) return false;
    return true;
  });
}

function clientName(server: McpServer, request: Request): string | null {
  const info = server.server.getClientVersion?.();
  if (info?.name) return `${info.name}${info.version ? `/${info.version}` : ""}`.slice(0, 120);
  const header = request.headers.get("x-kofra-client");
  if (header) return header.slice(0, 120);
  const ua = request.headers.get("user-agent");
  return ua ? ua.split(/\s+/)[0]!.slice(0, 120) : null;
}

function errorText(err: ApiError, requestId: string): string {
  const json = err.toJSON(requestId);
  return `${err.code}: ${err.message}${err.hint ? ` Fix: ${err.hint}` : ""}\n${JSON.stringify(json)}`;
}

function toApiError(e: unknown, tool: string, requestId: string): ApiError {
  if (e instanceof ApiError) return e;
  console.error(JSON.stringify({ event: "mcp_tool_error", tool, requestId, error: String(e), stack: (e as Error)?.stack }));
  return new ApiError(500, "internal_error", "Something went wrong on our side.", "Retry once; if it keeps failing, report the requestId.", { retryable: true });
}

function scopeCheck(principal: Principal, def: McpToolDefinition): void {
  requireOperationScopes(principal, def.scopes ?? [], def.name);
}

function buildServer(compiled: CompiledTool[], ctx: { dw: DropwayContext; principal: Principal; request: Request; requestId: string }, options: McpEndpointOptions): McpServer {
  const { dw, principal, request, requestId } = ctx;
  const server = new McpServer(
    { name: options.name ?? "kofra", title: dw.config.instanceName, version: MCP_SERVER_VERSION, websiteUrl: appOrigin(dw) },
    { instructions: (options.instructions ?? mcpInstructions)(dw) },
  );
  for (const { def, input, output } of compiled) {
    server.registerTool(
      def.name,
      {
        ...(def.title ? { title: def.title } : {}),
        description: def.description,
        inputSchema: input,
        ...(output ? { outputSchema: output } : {}),
        ...(def.annotations ? { annotations: def.annotations } : {}),
        ...(def.alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
      },
      async (rawArgs: unknown) => {
        const args = { ...((rawArgs ?? {}) as Record<string, unknown>) };
        try {
          scopeCheck(principal, def);
          const idempotencyKey = def.idempotent ? validateIdempotencyKey(args.idempotencyKey) : null;
          delete args.idempotencyKey;
          const toolCtx = { dw, principal, request, client: clientName(server, request), idempotencyKey };
          const { result, replayed } = await withIdempotency(
            dw,
            { scope: idempotencyScope(principal), operation: `mcp:${def.name}`, key: idempotencyKey, input: args, redactForReplay: def.redactForReplay as ((r: unknown) => unknown) | undefined },
            () => def.handler(args, toolCtx),
          );
          const data: Record<string, unknown> = result && typeof result === "object" && !Array.isArray(result) ? { ...(result as Record<string, unknown>) } : { result };
          if (replayed) data.replayed = true;
          let line: string;
          try {
            line = def.summarize ? def.summarize(data, args) : `${def.name}: done.`;
          } catch {
            line = `${def.name}: done.`;
          }
          if (replayed) line = `Replayed the first result for this idempotencyKey. ${line}`;
          const content: Array<Record<string, unknown>> = [{ type: "text", text: `${line}\n${JSON.stringify(data)}` }];
          if (typeof data.url === "string") {
            content.push({ type: "resource_link", uri: data.url, name: typeof data.slug === "string" ? data.slug : data.url, description: "Live URL. Share it exactly as returned." });
          }
          return { content, structuredContent: data } as never;
        } catch (e) {
          const err = toApiError(e, def.name, requestId);
          return { isError: true, content: [{ type: "text", text: errorText(err, requestId) }] } as never;
        }
      },
    );
  }
  return server;
}

const CORS = {
  origin: "*",
  headers: withLegacyHeaderNames(["Content-Type", "Accept", "Authorization", "mcp-session-id", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name", "Last-Event-ID", "X-Kofra-Client", "X-Kofra-Toolsets", "X-Kofra-Read-Only"]).join(", "),
  methods: "GET, POST, DELETE, OPTIONS",
  exposeHeaders: "mcp-session-id, WWW-Authenticate, X-Request-Id",
  maxAge: 86400,
};

function authError(dw: DropwayContext, err: ApiError, requestId: string): Response {
  const o = appOrigin(dw);
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "WWW-Authenticate, X-Request-Id",
    "X-Request-Id": requestId,
  });
  if (err.status === 401) {
    headers.set("WWW-Authenticate", `Bearer realm="${dw.config.instanceName}", error="invalid_token", error_description="${err.message.replace(/"/g, "'")}"`);
  }
  const body = err.toJSON(requestId);
  body.error.hint ??= `Connect with an API key: claude mcp add --transport http kofra ${o}/mcp --header "Authorization: Bearer dw_..."`;
  return new Response(JSON.stringify(body), { status: err.status, headers });
}

/**
 * The default MCP endpoint. createDropway() mounts it at /mcp unless options.mcp
 * replaces it. Extensions add tools through createDropway({ mcpTools }).
 */
export function createMcpEndpoint(options: McpEndpointOptions = {}): McpHandlerFactory {
  return (tools) => {
    const compiled = compile(tools);
    return async (c: Context<DropwayEnv>) => {
      const dw = c.get("dw");
      const request = c.req.raw;
      const requestId = c.get("requestId");
      const appHost = new URL(appOrigin(dw)).hostname;
      const handlerOptions = {
        route: "/mcp",
        corsOptions: CORS,
        allowedOriginHostnames: options.allowedOriginHostnames ?? [...localhostAllowedOrigins(), appHost],
        onerror: (e: Error) => console.error(JSON.stringify({ event: "mcp_transport_error", requestId, error: String(e) })),
      };
      if (request.method === "OPTIONS") {
        return createMcpHandler(() => new McpServer({ name: "kofra", version: MCP_SERVER_VERSION }), handlerOptions).fetch(request);
      }
      let principal: Principal;
      try {
        principal = await dw.adapters.identity.resolve(request, dw);
        if (principal.kind === "anonymous") {
          throw new ApiError(401, "unauthorized", "The MCP endpoint needs an API key.", undefined);
        }
        if (principal.kind === "bootstrap") {
          throw new ApiError(403, "forbidden", "The bootstrap key can only set up the instance.", "Use the owner API key returned by POST /api/v1/setup.");
        }
      } catch (e) {
        if (e instanceof ApiError) return authError(dw, e, requestId);
        throw e;
      }
      const visible = selectTools(compiled, dw, request);
      const handler = createMcpHandler(() => buildServer(visible, { dw, principal, request, requestId }, options), handlerOptions);
      const res = await handler.fetch(request);
      const headers = new Headers(res.headers);
      headers.set("X-Request-Id", requestId);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    };
  };
}
