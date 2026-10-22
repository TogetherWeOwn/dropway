/**
 * HTTP client for the Dropway REST API (v1). Runtime-neutral: it only uses
 * fetch, so the same code runs in Node (the CLI) and inside the Workers runtime
 * (the integration tests call it against the real Worker).
 */
import { VERSION } from "./version.ts";

/** Process exit codes. Stable: agents branch on them. */
export const EXIT = {
  ok: 0,
  /** Unexpected failure (a bug, or a response we could not understand). */
  error: 1,
  /** Bad command line, refused without --yes, or files that look like secrets. Fix the command. */
  usage: 2,
  /** No credentials, invalid key, or the key lacks a scope (HTTP 401/403). */
  auth: 3,
  /** The site, version or file does not exist or is not visible to this key (HTTP 404). */
  notFound: 4,
  /** Conflict: the live version moved (baseVersionId), the name is taken (HTTP 409). */
  conflict: 5,
  /** The instance refused the content: invalid input or over a limit (HTTP 400/411/413/422). */
  invalid: 6,
  /** Retryable: rate limited, server error or network failure (HTTP 429/5xx). Retry later. */
  unavailable: 7,
  /** --wait gave up before the live URL served the new version. */
  waitTimeout: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function exitCodeForStatus(status: number): ExitCode {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if (status === 409) return EXIT.conflict;
  if (status === 429 || status >= 500) return EXIT.unavailable;
  if (status >= 400) return EXIT.invalid;
  return EXIT.error;
}

/** An error with a stable code, a hint for the caller and the exit code to use. */
export class CliError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly exitCode: ExitCode;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(opts: {
    code: string;
    message: string;
    hint?: string;
    exitCode: ExitCode;
    status?: number;
    requestId?: string;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = "CliError";
    this.code = opts.code;
    this.hint = opts.hint;
    this.exitCode = opts.exitCode;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.details = opts.details;
  }

  get retryable(): boolean {
    return this.exitCode === EXIT.unavailable;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

export type FetchLike = (input: Request) => Promise<Response>;

export interface ClientOptions {
  /** Instance origin, e.g. https://dropway.example.workers.dev (no /api/v1). */
  api: string;
  /** API key (dw_...), claim token (dwc_...) or bootstrap secret. null = anonymous. */
  token: string | null;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: FetchLike;
  /** Sent as X-Dropway-Client (attribution shown per version). */
  client?: string;
  /** Attempts for retryable failures (429, 5xx, network). Default 4. */
  attempts?: number;
  /** Base backoff in ms (doubles each attempt, plus jitter). Default 500. */
  backoffMs?: number;
  /** Longest Retry-After we are willing to sleep, in seconds. Default 30. */
  maxRetryAfterSeconds?: number;
  /**
   * Called once when the instance answers with a Deprecation header and a
   * `Link: <...>; rel="successor-version"` on another origin (it moved; the old origin still works).
   */
  onMoved?: (newOrigin: string) => void;
}

/** The successor origin named by a deprecated response, or null. */
export function movedTo(res: Response, current: string): string | null {
  if (!res.headers.has("deprecation")) return null;
  const m = /<([^>]+)>\s*;\s*rel="?successor-version"?/i.exec(res.headers.get("link") ?? "");
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(m[1]!);
  } catch {
    return null;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== current ? url.origin : null;
}

export interface RequestOptions {
  /** JSON body (sets Content-Type). */
  json?: unknown;
  /** Raw body (blob uploads, zips). */
  body?: Blob | Uint8Array | ArrayBuffer | string | null;
  headers?: Record<string, string>;
  /**
   * "safe": retry on 429, 5xx and network errors (GET, PUT blob, finalize: all idempotent).
   * "rate-limit": retry only on 429 (the server refused before doing anything).
   */
  retry?: "safe" | "rate-limit";
  /** Override the bearer token for this call (null = none). */
  token?: string | null;
  /** Allowed non-2xx statuses that should be returned instead of thrown. */
  accept?: number[];
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** Normalise "https://x.dev/", "x.dev", "https://x.dev/api/v1" to "https://x.dev". */
export function normaliseApi(input: string): string {
  let s = input.trim();
  if (!s) throw new CliError({ code: "invalid_api_url", message: "The instance URL is empty.", exitCode: EXIT.usage });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${/^(localhost|127\.|\[::1\])/.test(s) ? "http" : "https"}://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new CliError({ code: "invalid_api_url", message: `"${input}" is not a valid URL.`, hint: "Use the instance origin, e.g. https://dropway.example.workers.dev", exitCode: EXIT.usage });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError({ code: "invalid_api_url", message: `"${input}" must be an http(s) URL.`, exitCode: EXIT.usage });
  }
  return url.origin;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DropwayClient {
  readonly api: string;
  token: string | null;
  private readonly doFetch: FetchLike;
  private readonly clientName: string;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly maxRetryAfter: number;
  private onMoved: ((newOrigin: string) => void) | undefined;

  constructor(opts: ClientOptions) {
    this.api = normaliseApi(opts.api);
    this.token = opts.token;
    this.doFetch = opts.fetch ?? ((req) => fetch(req));
    this.clientName = opts.client ?? `dropway-cli/${VERSION}`;
    this.attempts = Math.max(1, opts.attempts ?? 4);
    this.backoffMs = opts.backoffMs ?? 500;
    this.maxRetryAfter = opts.maxRetryAfterSeconds ?? 30;
    this.onMoved = opts.onMoved;
  }

  /** Absolute URL for an API path ("/sites" -> <api>/api/v1/sites); absolute URLs pass through. */
  url(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    const p = path.startsWith("/") ? path : `/${path}`;
    return p.startsWith("/api/") || p === "/openapi.json" || p === "/llms.txt" ? `${this.api}${p}` : `${this.api}/api/v1${p}`;
  }

  /** Call the API and parse JSON. Throws CliError for non-2xx answers (unless accepted). */
  async request<T = Record<string, unknown>>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const url = this.url(path);
    const token = opts.token === undefined ? this.token : opts.token;
    const retry = opts.retry ?? (method === "GET" || method === "HEAD" ? "safe" : "rate-limit");
    let lastError: CliError | null = null;

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const headers = new Headers(opts.headers);
      headers.set("Accept", "application/json");
      headers.set("X-Dropway-Client", this.clientName);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      let body: Blob | Uint8Array | ArrayBuffer | string | null | undefined = opts.body;
      if (opts.json !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(opts.json);
      }
      let res: Response;
      try {
        res = await this.doFetch(new Request(url, { method, headers, body: body ?? null, redirect: "follow" }));
      } catch (e) {
        lastError = new CliError({
          code: "network_error",
          message: `Could not reach ${new URL(url).origin}: ${(e as Error)?.message ?? String(e)}`,
          hint: "Check the instance URL (--api or DROPWAY_API) and your network, then retry.",
          exitCode: EXIT.unavailable,
        });
        if (retry === "safe" && attempt < this.attempts) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw lastError;
      }

      const successor = this.onMoved ? movedTo(res, this.api) : null;
      if (successor && this.onMoved) {
        const notify = this.onMoved;
        this.onMoved = undefined;
        notify(successor);
      }

      if (res.ok || opts.accept?.includes(res.status)) {
        return { status: res.status, data: (await parseBody(res)) as T, headers: res.headers };
      }

      const err = await errorFromResponse(res);
      const retryable = res.status === 429 || (retry === "safe" && res.status >= 500);
      if (retryable && attempt < this.attempts) {
        const ra = Number(res.headers.get("retry-after"));
        if (res.status === 429 && Number.isFinite(ra) && ra > this.maxRetryAfter) throw err;
        await sleep(res.status === 429 && Number.isFinite(ra) && ra > 0 ? ra * 1000 : this.backoff(attempt));
        lastError = err;
        continue;
      }
      throw err;
    }
    throw lastError ?? new CliError({ code: "request_failed", message: `${method} ${url} failed.`, exitCode: EXIT.error });
  }

  private backoff(attempt: number): number {
    const base = this.backoffMs * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * (base / 2));
  }

  get<T = Record<string, unknown>>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts);
  }

  post<T = Record<string, unknown>>(path: string, json?: unknown, opts: RequestOptions = {}) {
    return this.request<T>("POST", path, { ...opts, json: json ?? {} });
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/** Turn an error response (the API's {error:{code,message,hint,details}} envelope or anything else) into a CliError. */
export async function errorFromResponse(res: Response): Promise<CliError> {
  const body = (await parseBody(res)) as { error?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> }; requestId?: string; text?: string };
  const e = body?.error;
  const requestId = body?.requestId ?? res.headers.get("x-request-id") ?? undefined;
  if (e && typeof e === "object" && e.code) {
    return new CliError({
      code: e.code,
      message: e.message ?? `HTTP ${res.status}`,
      hint: e.hint,
      details: e.details,
      status: res.status,
      requestId,
      exitCode: exitCodeForStatus(res.status),
    });
  }
  const snippet = (body?.text ?? "").replace(/\s+/g, " ").slice(0, 200);
  return new CliError({
    code: `http_${res.status}`,
    message: `The server answered HTTP ${res.status}${snippet ? `: ${snippet}` : ""}.`,
    hint: res.status === 404 ? "Is this a Dropway instance? Check --api / DROPWAY_API (use the origin, without /api/v1)." : undefined,
    status: res.status,
    requestId,
    exitCode: exitCodeForStatus(res.status),
  });
}
