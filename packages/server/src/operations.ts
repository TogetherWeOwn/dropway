import { z } from "zod";
import type { Context, Hono } from "hono";
import { ApiError, requireMember, type DropwayContext, type Principal, type Scope } from "@dropway/core";
import type { DropwayEnv } from "./env";
import type { McpToolDefinition } from "./extensions";
import { readJson } from "./routes/api";

export interface OperationContext {
  dw: DropwayContext;
  principal: Principal;
  request: Request;
  client: string | null;
  idempotencyKey: string | null;
}

export interface OperationDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: string;
  toolset: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  aliases?: { method: string; path: string }[];
  scopes: Scope[];
  anonymous?: boolean;
  summary: string;
  description: string;
  input: I;
  output: O;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  mcp?: { alwaysLoad?: boolean } | { exclude: string };
  cli?: { command: string[]; positional?: string[] };
  confirm?: "slug" | "name" | "email" | "domain";
  rawBody?: boolean;
  examples?: { input: unknown; output: unknown }[];
  handler(input: z.infer<I>, ctx: OperationContext): Promise<z.infer<O>>;
  /** Wire compatibility for pre-registry REST clients. Never used by MCP. */
  http?: {
    input?: z.ZodType;
    output?: z.ZodType;
    handler?: (c: Context<DropwayEnv>) => Response | Promise<Response>;
    status?: number;
    statuses?: number[];
    responseType?: string;
    contentTypes?: string[];
    wildcard?: boolean;
    examples?: { input: unknown; output: unknown }[];
  };
  /** Existing tool presentation and retry behavior; schemas and handler come from this operation. */
  tool?: Pick<McpToolDefinition, "idempotent" | "redactForReplay" | "enabled" | "summarize">;
}

export function defineOperation<I extends z.ZodType, O extends z.ZodType, S extends Scope>(
  definition: OperationDefinition<I, O> & { scopes: S[] },
): OperationDefinition<I, O> & { scopes: S[] } {
  if (!/^[a-z][a-z0-9_]*$/.test(definition.id)) throw new Error(`Invalid operation id: ${definition.id}`);
  if (!definition.path.startsWith("/api/v1")) throw new Error(`Operation ${definition.id} needs an /api/v1 path.`);
  if (!definition.summary.trim() || definition.summary.length > 80) throw new Error(`Invalid summary: ${definition.id}`);
  if (!definition.description.trim() || definition.description.length >= 4096) throw new Error(`Invalid description: ${definition.id}`);
  if (definition.mcp && "exclude" in definition.mcp && !definition.mcp.exclude.trim()) throw new Error(`Empty MCP exclusion: ${definition.id}`);
  if (definition.rawBody && !(definition.mcp && "exclude" in definition.mcp)) throw new Error(`Raw operation needs an MCP exclusion: ${definition.id}`);
  return definition;
}

export function schemaJson(schema: z.ZodType, io: "input" | "output" = "input"): Record<string, any> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
  });
  return json;
}

function validate(schema: z.ZodType, input: unknown, operation: string): any {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      400,
      "invalid_request",
      `Invalid input for ${operation}.`,
      "Correct the listed fields and retry; see /openapi.json for the input schema.",
      {
        fields: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

export async function executeOperation(op: OperationDefinition, input: unknown, ctx: OperationContext): Promise<any> {
  if (ctx.principal.kind === "anonymous" && !op.anonymous) requireMember(ctx.principal);
  if (ctx.principal.kind === "bootstrap") requireMember(ctx.principal);
  if (ctx.principal.kind === "member") {
    for (const scope of op.scopes) {
      if (!ctx.principal.scopes.includes(scope))
        throw new ApiError(
          403,
          "insufficient_scope",
          `Your API key lacks the "${scope}" scope needed for ${op.id}.`,
          "Ask the instance owner for a key with every required scope.",
        );
    }
  }
  const parsed = validate(op.input, input, op.id);
  const result = await op.handler(parsed, ctx);
  const output = op.output.safeParse(result);
  if (!output.success) {
    console.error(
      JSON.stringify({
        event: "operation_output_invalid",
        operation: op.id,
        fields: output.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      }),
    );
    throw new ApiError(500, "invalid_operation_output", `The ${op.id} handler returned an invalid result.`, "Report the requestId to the instance operator.");
  }
  // JSON omits optional undefined fields; MCP's schema adapter rejects them before serialization.
  return JSON.parse(JSON.stringify(output.data));
}

export function operationTools(operations: readonly OperationDefinition[]): McpToolDefinition[] {
  return operations
    .filter((op) => !(op.mcp && "exclude" in op.mcp))
    .map((op) => ({
      ...op.tool,
      name: op.id,
      title: op.summary,
      description: op.description,
      toolset: op.toolset,
      scopes: op.scopes,
      annotations: op.annotations,
      alwaysLoad: op.mcp && "alwaysLoad" in op.mcp ? op.mcp.alwaysLoad : false,
      inputSchema: schemaJson(op.input),
      outputSchema: schemaJson(op.output, "output"),
      handler: (args, ctx) => executeOperation(op, args, ctx),
    }));
}

export function commandTable(operations: readonly OperationDefinition[]) {
  return operations.map((op) => ({
    id: op.id,
    method: op.method,
    path: op.path,
    scopes: op.scopes,
    inputSchema: schemaJson(op.input),
    ...(op.cli ? { cli: op.cli } : {}),
  }));
}

function honoPath(path: string): string {
  return path.replace(/^\/api\/v1/, "").replace(/\{([a-zA-Z0-9_]+)\}/g, ":$1") || "/";
}

async function requestInput(c: Context<DropwayEnv>, op: OperationDefinition) {
  const schema = schemaJson(op.input);
  const query: Record<string, unknown> = { ...c.req.query() };
  for (const [key, value] of Object.entries(query)) {
    const field = schema.properties?.[key];
    if (field?.type === "integer" || field?.type === "number") query[key] = value === "" ? value : Number(value);
    if (field?.type === "boolean" && (value === "true" || value === "false")) query[key] = value === "true";
  }
  const body = ["GET", "HEAD"].includes(c.req.method) ? {} : await readJson(c);
  // The URL names the resource; a body cannot select a different one.
  return { ...query, ...body, ...c.req.param() };
}

export function installOperationRoutes(api: Hono<DropwayEnv>, operations: readonly OperationDefinition[]) {
  const routes = new Set<string>();
  for (const op of operations) {
    for (const route of [{ method: op.method, path: op.path }, ...(op.aliases ?? [])]) {
      const key = `${route.method} ${route.path}`;
      if (routes.has(key)) throw new Error(`Duplicate operation route: ${key}`);
      routes.add(key);
      const handler =
        op.http?.handler ??
        (async (c: Context<DropwayEnv>) => {
          const ctx: OperationContext = {
            dw: c.get("dw"),
            principal: c.get("principal"),
            request: c.req.raw,
            client: c.req.header("x-dropway-client") ?? null,
            idempotencyKey: c.req.header("idempotency-key") ?? null,
          };
          return c.json(await executeOperation(op, await requestInput(c, op), ctx), (op.http?.status ?? 200) as 200);
        });
      const path = honoPath(route.path);
      api.on(route.method, op.http?.wildcard ? path.replace(/:path$/, ":path{.+}") : path, handler);
    }
  }
}
