/**
 * Agent-friendly errors. Every API error has a stable machine `code`, a human
 * `message`, and a `hint` that tells the caller (often an AI agent) what to do next.
 * Services throw these; the REST API and the MCP server turn them into responses.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON(requestId?: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
      ...(requestId ? { requestId } : {}),
    };
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export const badRequest = (code: string, message: string, hint?: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, message, hint, details);

export const unauthorized = (message = "This endpoint needs an API key.", hint?: string, code = "unauthorized") =>
  new ApiError(
    401,
    code,
    message,
    hint ?? "Send `Authorization: Bearer dw_...`. The instance owner creates keys with POST /api/v1/keys (or for a new member with POST /api/v1/members).",
  );

export const forbidden = (message: string, hint?: string, code = "forbidden") => new ApiError(403, code, message, hint);

export const notFound = (code: string, message: string, hint?: string) => new ApiError(404, code, message, hint);

export const conflict = (code: string, message: string, hint?: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, hint, details);

export const tooLarge = (code: string, message: string, hint?: string, details?: Record<string, unknown>) =>
  new ApiError(413, code, message, hint, details);

export const rateLimited = (message: string, hint: string, retryAfterSeconds: number) =>
  new ApiError(429, "rate_limited", message, hint, { retryAfterSeconds });
