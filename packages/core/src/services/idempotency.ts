import type { DropwayContext } from "../context";
import { ApiError, badRequest } from "../errors";
import { sha256Hex } from "../lib/crypto";
import type { Principal } from "../principal";

/**
 * Idempotency keys for writes (REST `Idempotency-Key` header, MCP `idempotencyKey` argument).
 *
 * Same caller + same operation + same key:
 * - same input  -> the first result is replayed (`replayed: true`), nothing runs twice;
 * - other input -> 422 idempotency_key_reused;
 * - first call still running -> 409 idempotency_in_progress (retryable).
 * Records live 24 hours. Failed calls are not recorded, so a retry after an error runs again.
 *
 * Storage is the CACHE KV namespace. KV is eventually consistent between Cloudflare
 * locations (writes are visible in the writing location at once, elsewhere within
 * about 60 s), which covers the common case: a client retrying the same call after a
 * timeout or a dropped connection. Concurrent duplicates sent to two different
 * locations within a second can both run; every core write is also safe to repeat
 * (content-addressed blobs, `unchanged` republish, idempotent finalize and restore).
 */

const TTL_SECONDS = 86_400;
/** A pending marker older than this belongs to a call that died; a retry may take over. */
const PENDING_STALE_MS = 60_000;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

interface StoredRecord {
  state: "pending" | "done";
  inputHash: string;
  at: number;
  result?: unknown;
}

/** Check an idempotency key: 1-255 printable ASCII characters, or absent. */
export function validateIdempotencyKey(key: unknown): string | null {
  if (key === undefined || key === null || key === "") return null;
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw badRequest(
      "invalid_idempotency_key",
      "The idempotency key must be 1-255 printable ASCII characters without spaces.",
      "Use a fresh UUID per logical operation, and reuse it only when retrying that same operation.",
    );
  }
  return key;
}

/** Who owns an idempotency record: the member, or the anonymous site a claim token controls. */
export function idempotencyScope(p: Principal): string | null {
  if (p.kind === "member") return `m:${p.memberId}`;
  if (p.kind === "claim") return `c:${p.siteId}`;
  return null;
}

/** JSON with sorted object keys, so equal inputs hash equally whatever their key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export interface IdempotencyOptions<T> {
  /** Owner of the record, from idempotencyScope(). null disables idempotency. */
  scope: string | null;
  /** Operation name, e.g. "publish_site". */
  operation: string;
  key: string | null;
  /** The request input (without the key itself). */
  input: unknown;
  /** Strip secrets before the result is stored for replay (e.g. a newly minted API key). */
  redactForReplay?: (result: T) => T;
}

/** Run `run` at most once per (scope, operation, key) within 24 hours. */
export async function withIdempotency<T>(dc: DropwayContext, opts: IdempotencyOptions<T>, run: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
  if (!opts.key || !opts.scope) return { result: await run(), replayed: false };
  const kvKey = `idem:${await sha256Hex(`${opts.scope}\u0000${opts.operation}\u0000${opts.key}`)}`;
  const inputHash = await sha256Hex(stableStringify(opts.input));
  const existing = await dc.env.CACHE.get<StoredRecord>(kvKey, { type: "json" }).catch(() => null);
  if (existing) {
    if (existing.inputHash !== inputHash) {
      throw new ApiError(
        422,
        "idempotency_key_reused",
        `This idempotency key was already used for a different ${opts.operation} request.`,
        "Use a new key for a new operation; reuse a key only to retry the exact same request.",
      );
    }
    if (existing.state === "done") return { result: existing.result as T, replayed: true };
    if (Date.now() - existing.at < PENDING_STALE_MS) {
      throw new ApiError(409, "idempotency_in_progress", "The first request with this idempotency key is still running.", "Retry in a second or two; you will get its result.", {
        retryable: true,
        retryAfterSeconds: 1,
      });
    }
  }
  const pending: StoredRecord = { state: "pending", inputHash, at: Date.now() };
  await dc.env.CACHE.put(kvKey, JSON.stringify(pending), { expirationTtl: TTL_SECONDS }).catch(() => {});
  let result: T;
  try {
    result = await run();
  } catch (e) {
    await dc.env.CACHE.delete(kvKey).catch(() => {});
    throw e;
  }
  const stored = opts.redactForReplay ? opts.redactForReplay(result) : result;
  const done: StoredRecord = { state: "done", inputHash, at: Date.now(), result: stored };
  await dc.env.CACHE.put(kvKey, JSON.stringify(done), { expirationTtl: TTL_SECONDS }).catch(() => {});
  return { result, replayed: false };
}
