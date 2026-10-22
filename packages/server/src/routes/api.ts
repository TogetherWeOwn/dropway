import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { ApiError, badRequest } from "@dropway/core";
import type { DropwayEnv } from "../env";

/** Parse an object body without silently accepting malformed JSON. */
export async function readJson(c: Context<DropwayEnv>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw badRequest("invalid_json", "The request body must be a JSON object.", "Send Content-Type: application/json with an object body.");
}

export function apiErrorResponse(c: Context<DropwayEnv>, err: unknown): Response {
  const requestId = c.get("requestId");
  if (err instanceof ApiError) {
    if (err.status === 429 && err.details?.retryAfterSeconds) c.header("Retry-After", String(err.details.retryAfterSeconds));
    return c.json(err.toJSON(requestId), err.status as 400);
  }
  console.error(
    JSON.stringify({
      event: "api_error",
      requestId,
      path: c.req.path,
      error: String(err),
      stack: (err as Error)?.stack,
    }),
  );
  return c.json(
    new ApiError(500, "internal_error", "Something went wrong on our side.", "Retry the request; if it keeps failing, report the requestId.").toJSON(requestId),
    500,
  );
}

/** CORS, principal resolution, error shaping, then extension middleware. */
export function installApiMiddleware(api: Hono<DropwayEnv>, middleware: MiddlewareHandler<DropwayEnv>[]) {
  api.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Authorization", "Content-Type", "X-Dropway-Path", "X-Dropway-Client", "If-None-Match", "Idempotency-Key"],
      allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["ETag", "X-Request-Id", "X-Dropway-Version", "X-Dropway-Content-Type", "Retry-After"],
      maxAge: 86400,
    }),
  );
  api.use("*", async (c, next) => {
    const dw = c.get("dw");
    c.set("principal", await dw.adapters.identity.resolve(c.req.raw, dw));
    await next();
    c.header("X-Request-Id", c.get("requestId"));
  });
  for (const mw of middleware) api.use("*", mw);
  api.onError((err, c) => apiErrorResponse(c, err));
}
