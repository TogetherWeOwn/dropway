import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerBindings } from "@dropway/server";
import { resolveAccessIdentity } from "../packages/core/src/services/access-identity";
import { callWithBindings, env, freshInstance, ORIGIN, type Instance } from "./r21-helpers";

// Public-behavior regressions: real RS256 signing, import and verification, with
// only the configured cert endpoint, clock and verification scheduling gated.
// No production cache reset/introspection; each case advances beyond prior trust.
type SigningKey = { pair: CryptoKeyPair; jwk: JsonWebKey & { kid: string } };
type Endpoint = { calls: number; reply: () => Response | Promise<Response> };
const AUD = "batched-cache-application";
let a: SigningKey;
let b: SigningKey;
let old: SigningKey;
let nextEpoch = Date.UTC(2034, 0, 1);
let now: number;
let sequence = 0;
let endpoints: Map<string, Endpoint>;
let unexpected: string[];

function b64url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeAll(async () => {
  async function key(kid: string): Promise<SigningKey> {
    const pair = await crypto.subtle.generateKey({
      name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
    }, true, ["sign", "verify"]) as CryptoKeyPair;
    return { pair, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey, kid, alg: "RS256", use: "sig" } };
  }
  a = await key("batched-a");
  b = await key("batched-b");
  old = await key("batched-removed");
});
beforeEach(() => {
  now = nextEpoch;
  nextEpoch += 900_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  endpoints = new Map();
  unexpected = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const endpoint = endpoints.get(url);
    if (!endpoint) {
      unexpected.push(url);
      throw new Error("Unexpected outbound request in hermetic batched JWKS test");
    }
    endpoint.calls++;
    return endpoint.reply();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(unexpected, "no real network or unconfigured issuer endpoint").toEqual([]);
});
function jwks(keys: JsonWebKey[] = [a.jwk]) {
  return Response.json({ keys });
}
async function fixture(dw?: Instance) {
  dw ??= await freshInstance();
  const issuer = `https://batched-cache-${++sequence}.cloudflareaccess.com`;
  const bindings = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: AUD };
  const endpoint: Endpoint = { calls: 0, reply: () => jwks() };
  endpoints.set(`${issuer}/cdn-cgi/access/certs`, endpoint);
  async function token(signing = a, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
    const encodedHeader = b64url(JSON.stringify({ alg: "RS256", kid: signing.jwk.kid, typ: "JWT", ...header }));
    const encodedPayload = b64url(JSON.stringify({
      iss: issuer, aud: [AUD], sub: "batched-subject", email: "owner@example.com",
      iat: now / 1000 - 1, exp: now / 1000 + 3600, type: "app", ...claims,
    }));
    const input = `${encodedHeader}.${encodedPayload}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signing.pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64url(new Uint8Array(signature))}`;
  }
  function request(assertion: string) {
    return callWithBindings(dw!, "/api/v1/me", bindings, { headers: { "Cf-Access-Jwt-Assertion": assertion } });
  }
  function verify(assertion: string) {
    const dc = dw!.dropway.context({ ...env, ...bindings } as unknown as ServerBindings, { waitUntil() {} }, new URL(ORIGIN));
    return resolveAccessIdentity(dc, assertion, "192.0.2.23");
  }
  return { dw, endpoint, token, request, verify };
}
async function denied(response: Response) {
  expect.soft(response.status).toBe(401);
  const body = await response.json();
  expect.soft(body).toMatchObject({ error: { code: "invalid_access_identity" } });
  expect.soft(body).not.toHaveProperty("member");
  expect.soft(body).not.toHaveProperty("principal");
  expect.soft(response.headers.getSetCookie()).toEqual([]);
}
async function busy(response: Response) {
  expect.soft(response.status).toBe(503);
  const body = await response.json() as { error?: { code?: string; hint?: string } };
  expect.soft(body).toMatchObject({ error: { code: "access_key_cache_busy" } });
  expect.soft(body.error?.hint, "operational denial explains retry or server capacity").toMatch(/retry|try again|capacity|busy|temporar/i);
  expect.soft(body).not.toHaveProperty("member");
  expect.soft(body).not.toHaveProperty("principal");
  expect.soft(response.headers.getSetCookie()).toEqual([]);
}
async function counts() {
  return {
    members: await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first(),
    sessions: await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first(),
  };
}
const invalidMaterials: Array<{ name: string; patch: Partial<JsonWebKey> }> = [
  { name: "malformed modulus", patch: { n: "!invalid" } },
  { name: "malformed exponent", patch: { e: "!invalid" } },
  { name: "key_ops excludes verify", patch: { key_ops: ["encrypt"] } },
];

// A requested import failure must not roll back a structurally valid keyset.
// Also catches retrying B's rejected import on every request in the cooldown.
describe("Access JWKS requested bad key preserves valid siblings", () => {
  it.each(invalidMaterials)("cold $name leaves A available immediately from one fetch", async ({ patch }) => {
    const f = await fixture();
    f.endpoint.reply = () => jwks([a.jwk, { ...b.jwk, ...patch }]);
    const tokenA = await f.token(a);
    const tokenB = await f.token(b);
    const imports = vi.spyOn(crypto.subtle, "importKey");
    const before = await counts();
    await denied(await f.request(tokenB));
    expect(await counts()).toEqual(before);
    expect.soft((await f.request(tokenA)).status, "valid A is not held hostage by requested B").toBe(200);
    for (const elapsed of [0, 29_999]) {
      now += elapsed;
      await denied(await f.request(tokenB));
      expect.soft((await f.request(tokenA)).status).toBe(200);
    }
    expect.soft(f.endpoint.calls, "no fetch retry during the initial cooldown").toBe(1);
    expect(imports.mock.calls.filter((call) => (call[1] as JsonWebKey & { kid?: string }).kid === b.jwk.kid), "B has one rejected import, not a per-request import loop").toHaveLength(1);
  });

  it.each(invalidMaterials)("concurrent cold $name cannot poison A's coalesced fetch", async ({ patch }) => {
    const f = await fixture();
    const entered = deferred<void>();
    const gate = deferred<void>();
    f.endpoint.reply = async () => { entered.resolve(); await gate.promise; return jwks([a.jwk, { ...b.jwk, ...patch }]); };
    const tokenA = await f.token(a);
    const tokenB = await f.token(b);
    const imports = vi.spyOn(crypto.subtle, "importKey");
    const before = await counts();
    const bad = f.verify(tokenB).then((principal) => ({ principal }), (error: unknown) => ({ error }));
    await entered.promise;
    const siblings = Array.from({ length: 8 }, () => f.verify(tokenA).then(
      (principal) => ({ principal }), (error: unknown) => ({ error }),
    ));
    gate.resolve();
    expect(await bad).toMatchObject({ error: { status: 401, code: "invalid_access_identity" } });
    expect.soft(await Promise.all(siblings), "all waiting A callers get real verified member principals").toEqual(Array(8).fill({ principal: expect.objectContaining({ kind: "member", via: "access" }) }));
    await denied(await f.request(tokenB));
    expect(await counts()).toEqual(before);
    expect.soft((await f.request(tokenA)).status).toBe(200);
    expect.soft(f.endpoint.calls).toBe(1);
    expect(imports.mock.calls.filter((call) => (call[1] as JsonWebKey & { kid?: string }).kid === b.jwk.kid)).toHaveLength(1);
  });

  it.each(invalidMaterials)("replacement with $name drops old trust while retaining new A's fixed deadline", async ({ patch }) => {
    const f = await fixture();
    f.endpoint.reply = () => jwks([old.jwk]);
    const tokenOld = await f.token(old);
    const tokenA = await f.token(a);
    const tokenB = await f.token(b);
    expect((await f.request(tokenOld)).status).toBe(200);
    now += 270_000;
    const replacementStart = now;
    f.endpoint.reply = () => jwks([a.jwk, { ...b.jwk, ...patch }]);
    const before = await counts();
    await denied(await f.request(tokenB));
    expect(await counts()).toEqual(before);
    await denied(await f.request(tokenOld));
    expect.soft((await f.request(tokenA)).status, "new sibling survives B's failed import").toBe(200);
    expect.soft(f.endpoint.calls).toBe(2);
    f.endpoint.reply = () => new Response(null, { status: 503 });
    now = replacementStart + 29_999;
    await denied(await f.request(tokenOld));
    expect.soft((await f.request(tokenA)).status).toBe(200);
    expect.soft(f.endpoint.calls).toBe(2);
    now += 1; // Original keyset's deadline: removed trust must not resurrect.
    await denied(await f.request(tokenOld));
    expect.soft((await f.request(tokenA)).status).toBe(200);
    expect.soft(f.endpoint.calls).toBe(3);
    now = replacementStart + 299_999;
    expect.soft((await f.request(tokenA)).status).toBe(200);
    now += 1;
    await denied(await f.request(tokenA));
    await denied(await f.request(tokenOld));
    expect.soft(f.endpoint.calls, "outage never slides the replacement deadline").toBe(4);
  });
});

// Distinguishes capacity from bad identity; a pending issuer stays pinned even
// after cooldown, and settling it is required before an idle slot is eligible.
describe("Access JWKS operational capacity denial", () => {
  it("returns typed 503 with all 16 pending, including after 30 seconds, then admits an idle slot", async () => {
    const dw = await freshInstance();
    const fixtures = await Promise.all(Array.from({ length: 17 }, () => fixture(dw)));
    const tokens = await Promise.all(fixtures.map((f) => f.token()));
    const gate = deferred<void>();
    const entered = deferred<void>();
    let starts = 0;
    for (const f of fixtures.slice(0, 16)) f.endpoint.reply = async () => {
      if (++starts === 16) entered.resolve();
      await gate.promise;
      return jwks();
    };
    const pending = fixtures.slice(0, 16).map((f, i) => f.verify(tokens[i]!).then(
      (principal) => ({ principal }), (error: unknown) => ({ error }),
    ));
    await entered.promise;
    const newcomer = fixtures[16]!;
    const before = await counts();
    const startedAt = now;
    try {
      for (const elapsed of [0, 30_000, 30_001]) {
        now = startedAt + elapsed;
        await busy(await newcomer.request(tokens[16]!));
        const outcome = await newcomer.verify(tokens[16]!).then(
          (principal) => ({ principal }), (error: unknown) => ({ error }),
        );
        expect.soft(outcome).toMatchObject({ error: { status: 503, code: "access_key_cache_busy", hint: expect.stringMatching(/retry|try again|capacity|busy|temporar/i) } });
        expect.soft(newcomer.endpoint.calls).toBe(0);
        expect.soft(fixtures.slice(0, 16).map((f) => f.endpoint.calls)).toEqual(Array(16).fill(1));
        expect(await counts()).toEqual(before);
      }
    } finally {
      gate.resolve();
      expect(await Promise.all(pending)).toEqual(Array(16).fill({ principal: expect.objectContaining({ kind: "member", via: "access" }) }));
    }
    for (let i = 0; i < 16; i++) expect((await fixtures[i]!.request(tokens[i]!)).status).toBe(200);
    expect(fixtures.slice(0, 16).map((f) => f.endpoint.calls)).toEqual(Array(16).fill(1));
    expect((await newcomer.request(tokens[16]!)).status).toBe(200);
    expect(newcomer.endpoint.calls).toBe(1);
  });

  it("keeps invalid claims and warm forged signatures at 401 while all slots cool", async () => {
    const dw = await freshInstance();
    const fixtures = await Promise.all(Array.from({ length: 17 }, () => fixture(dw)));
    for (const f of fixtures.slice(0, 16)) expect((await f.request(await f.token())).status).toBe(200);
    const newcomer = fixtures[16]!;
    const before = await counts();
    for (const claims of [{ aud: ["wrong"] }, { iss: "https://untrusted.example" }, { exp: 1 }]) {
      await denied(await newcomer.request(await newcomer.token(a, claims)));
    }
    await denied(await newcomer.request(await newcomer.token(a, {}, { alg: "HS256" })));
    // A forged signature needs the warm key; do not demand pre-admission
    // signature classification for a cold, seventeenth issuer.
    await denied(await fixtures[0]!.request(await fixtures[0]!.token(old, {}, { kid: a.jwk.kid })));
    expect(await counts()).toEqual(before);
    expect(newcomer.endpoint.calls).toBe(0);
    expect(fixtures.slice(0, 16).map((f) => f.endpoint.calls)).toEqual(Array(16).fill(1));
    await busy(await newcomer.request(await newcomer.token()));
    expect(newcomer.endpoint.calls).toBe(0);
  });
});

// Removing only the caller's expiresAt check must kill the expiry cases. Gating
// verify (not import/fetch) ensures cache admission has already succeeded. The
// original Web Crypto operation runs after release and must return true.
describe("Access caller keyset expiry during real signature verification", () => {
  it.each([
    { name: "just before deadline authorizes", elapsed: 299_999, status: 200 },
    { name: "exact deadline denies", elapsed: 300_000, status: 401 },
    { name: "past deadline denies", elapsed: 300_001, status: 401 },
  ])("$name", async ({ elapsed, status }) => {
    const f = await fixture();
    const token = await f.token(); // JWT exp is an hour away throughout this case.
    const fetchedAt = now;
    const before = await counts();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const realVerify = crypto.subtle.verify.bind(crypto.subtle);
    const verified: boolean[] = [];
    const imports = vi.spyOn(crypto.subtle, "importKey");
    const verify = vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      entered.resolve();
      await gate.promise;
      const result = await realVerify(...args);
      verified.push(result);
      return result;
    });
    const pending = f.request(token);
    await entered.promise;
    try {
      expect(f.endpoint.calls, "key acquisition finished before the clock moves").toBe(1);
      expect(imports).toHaveBeenCalledTimes(1);
      now = fetchedAt + elapsed;
    } finally {
      gate.resolve();
    }
    const response = await pending;
    expect(verified, "the gated operation actually validates the RS256 signature").toEqual([true]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect.soft(response.status).toBe(status);
    if (status === 401) await denied(response);
    else expect(await response.json()).toMatchObject({ member: { email: "owner@example.com" } });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(f.endpoint.calls, "verification expiry is not a fetch retry").toBe(1);
  });
});
