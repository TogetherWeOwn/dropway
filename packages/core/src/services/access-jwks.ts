type AccessJwk = JsonWebKey & { kid: string; alg?: string; use?: string };
type VerificationKey = { jwk: AccessJwk; imported?: Promise<CryptoKey> };
type Keyset = { keys: Map<string, VerificationKey>; expiresAt: number };
type IssuerState = { keyset?: Keyset; refreshAt: number; pending?: Promise<void> };

const MAX_ISSUERS = 16;
const MAX_KEYS = 32;
const TRUST_MS = 300_000;
const REFRESH_MS = 30_000;
// Only configured issuer origins enter this map. Misses/failures occupy the same
// bounded slots as successes; arbitrary token kids never allocate cache entries.
const issuers = new Map<string, IssuerState>();

function issuerState(issuer: string): IssuerState {
  let state = issuers.get(issuer);
  if (!state) {
    if (issuers.size >= MAX_ISSUERS) {
      const idle = [...issuers].find(([, entry]) => !entry.pending);
      if (!idle) throw new Error("Access key cache is busy");
      issuers.delete(idle[0]);
    }
    state = { refreshAt: 0 };
  }
  // Least recently used idle states are the first eviction candidates.
  issuers.delete(issuer);
  issuers.set(issuer, state);
  return state;
}

function importKey(entry: VerificationKey): Promise<CryptoKey> {
  return entry.imported ??= crypto.subtle.importKey("jwk", entry.jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

async function fetchKeys(issuer: string): Promise<Map<string, VerificationKey>> {
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!res.ok || !res.body) throw new Error("Access keys unavailable");
  const reader = res.body.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error("Access key response too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); }
  const jwks = JSON.parse(text) as { keys?: unknown[] } | null;
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length > MAX_KEYS) throw new Error("Invalid Access keys");
  const keys = new Map<string, VerificationKey>();
  const seen = new Set<string>();
  for (const value of jwks.keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Access key");
    const jwk = value as AccessJwk;
    if (typeof jwk.kid !== "string" || !jwk.kid || jwk.kid.length > 256) throw new Error("Invalid Access key id");
    if (seen.has(jwk.kid)) throw new Error("Duplicate Access key id");
    seen.add(jwk.kid);
    if (jwk.kty === "RSA" && (!jwk.alg || jwk.alg === "RS256") && (!jwk.use || jwk.use === "sig")) {
      keys.set(jwk.kid, { jwk });
    }
  }
  return keys;
}

/** Caller must validate the configured issuer before using this cache. */
export async function accessVerificationKey(issuer: string, kid: string): Promise<{ key: CryptoKey; expiresAt: number }> {
  const state = issuerState(issuer);
  let keyset = state.keyset;
  let entry = keyset && Date.now() < keyset.expiresAt ? keyset.keys.get(kid) : undefined;
  if (!entry) {
    if (!state.pending) {
      const startedAt = Date.now();
      if (startedAt < state.refreshAt) throw new Error("Access key refresh cooling down");
      state.refreshAt = startedAt + REFRESH_MS;
      state.pending = (async () => {
        const keys = await fetchKeys(issuer);
        // Import the requested key before committing a refresh. Other admitted
        // keys import lazily, once each; unknown kids allocate nothing.
        const requested = keys.get(kid);
        if (requested) await importKey(requested);
        state.keyset = { keys, expiresAt: startedAt + TRUST_MS };
      })().finally(() => { state.pending = undefined; });
    }
    // Failure keeps the previous keyset with its ORIGINAL deadline, never stale
    // trust. A success replaces, rather than merges, the issuer's complete set.
    await state.pending;
    keyset = state.keyset;
    entry = keyset && Date.now() < keyset.expiresAt ? keyset.keys.get(kid) : undefined;
  }
  if (!keyset || !entry) throw new Error("Unknown or expired Access key");
  const key = await importKey(entry);
  if (Date.now() >= keyset.expiresAt) throw new Error("Expired Access key");
  return { key, expiresAt: keyset.expiresAt };
}
