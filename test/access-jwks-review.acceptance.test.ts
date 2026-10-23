import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerBindings } from "@dropway/server";
import { resolveAccessIdentity } from "../packages/core/src/services/access-identity";
import { callWithBindings, env, freshInstance, ORIGIN, type Instance } from "./r21-helpers";

// Independent follow-up: real signing/import/verification and emulated members.
// Only time and the configured JWKS fetch boundary are intercepted. No cache reset.
type SigningKey = { pair: CryptoKeyPair; jwk: JsonWebKey & { kid: string } };
type Endpoint = { calls: number; reply: () => Response | Promise<Response> };
const AUD = "review-cache-application";
let a: SigningKey;
let b: SigningKey;
let sequence = 0;
let nextEpoch = Date.UTC(2032, 0, 1);
let now: number;
let endpoints: Map<string, Endpoint>;
let unexpected: string[];

function b64url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

beforeAll(async () => {
  async function key(kid: string): Promise<SigningKey> {
    const pair = await crypto.subtle.generateKey({
      name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
    }, true, ["sign", "verify"]) as CryptoKeyPair;
    return { pair, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey, kid, alg: "RS256", use: "sig" } };
  }
  a = await key("review-a");
  b = await key("review-b");
});
beforeEach(() => {
  // The cache module persists across cases. Every case starts after all previous
  // fetch deadlines without exposing or resetting private production state.
  now = nextEpoch;
  nextEpoch += 600_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  endpoints = new Map();
  unexpected = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const endpoint = endpoints.get(url);
    if (!endpoint) {
      unexpected.push(url);
      throw new Error("Unexpected outbound request in hermetic JWKS review test");
    }
    endpoint.calls++;
    return endpoint.reply();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(unexpected, "no real network or unconfigured endpoints").toEqual([]);
});

function jwks(keys: JsonWebKey[] = [a.jwk]) {
  return Response.json({ keys });
}
async function fixture(dw: Instance) {
  const issuer = `https://review-cache-${++sequence}.cloudflareaccess.com`;
  const bindings = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: AUD };
  const endpoint: Endpoint = { calls: 0, reply: () => jwks() };
  endpoints.set(`${issuer}/cdn-cgi/access/certs`, endpoint);
  async function token(signing = a, kid = signing.jwk.kid) {
    const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const payload = b64url(JSON.stringify({
      iss: issuer, aud: [AUD], sub: "review-subject", email: "owner@example.com",
      iat: now / 1000 - 1, exp: now / 1000 + 3600, type: "app",
    }));
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signing.pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64url(new Uint8Array(signature))}`;
  }
  function request(assertion: string) {
    return callWithBindings(dw, "/api/v1/me", bindings, { headers: { "Cf-Access-Jwt-Assertion": assertion } });
  }
  function verify(assertion: string) {
    const dc = dw.dropway.context({ ...env, ...bindings } as unknown as ServerBindings, { waitUntil() {} }, new URL(ORIGIN));
    return resolveAccessIdentity(dc, assertion, "192.0.2.19");
  }
  return { endpoint, token, request, verify };
}
async function denied(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_access_identity" } });
  expect(response.headers.getSetCookie()).toEqual([]);
}

const invalidMaterials: Array<{ name: string; patch: Partial<JsonWebKey> }> = [
  { name: "malformed modulus", patch: { n: "!invalid" } },
  { name: "malformed exponent", patch: { e: "!invalid" } },
  { name: "key_ops excludes verify", patch: { key_ops: ["encrypt"] } },
];

// Catches a rejected lazy import pinning an otherwise corrected kid for 300s.
// Eagerly importing B instead is not a fix: A must work with one import only.
describe("Access JWKS non-requested key recovery", () => {
  it.each(invalidMaterials)("recovers $name through one coalesced refresh at exactly 30 seconds", async ({ patch }) => {
    const f = await fixture(await freshInstance());
    f.endpoint.reply = () => jwks([a.jwk, { ...b.jwk, ...patch }]);
    const tokenA = await f.token(a);
    const tokenB = await f.token(b);
    const imports = vi.spyOn(crypto.subtle, "importKey");
    expect((await f.request(tokenA)).status).toBe(200);
    expect(imports, "unrequested B is not imported eagerly").toHaveBeenCalledTimes(1);
    expect(imports.mock.calls[0]![1]).toMatchObject({ kid: a.jwk.kid });

    await denied(await f.request(tokenB));
    expect(imports, "B really reached Web Crypto, not just a metadata rejection").toHaveBeenCalledTimes(2);
    expect(imports.mock.calls[1]![1]).toMatchObject({ kid: b.jwk.kid, ...patch });
    await expect(imports.mock.results[1]!.value).rejects.toBeDefined();
    expect(f.endpoint.calls).toBe(1);

    f.endpoint.reply = () => jwks([b.jwk]);
    now += 29_999;
    await denied(await f.request(tokenB));
    expect(f.endpoint.calls, "correction cannot bypass the fetch-start cooldown").toBe(1);
    now += 1;
    const results = await Promise.all(Array.from({ length: 8 }, () => f.verify(tokenB).then(
      (principal) => principal.kind === "member" ? { kind: principal.kind, via: principal.via } : { kind: principal.kind },
      (error: unknown) => ({ error }),
    )));
    expect.soft(results, "corrected B recovers before the old 300-second expiry").toEqual(Array(8).fill({ kind: "member", via: "access" }));
    expect.soft(f.endpoint.calls, "one bounded trusted refresh for the recovery burst").toBe(2);
    expect(imports.mock.calls.filter((call) => {
      const jwk = call[1] as JsonWebKey & { kid?: string };
      return jwk.kid === b.jwk.kid && jwk.n === b.jwk.n && jwk.e === b.jwk.e && jwk.key_ops?.includes("verify");
    }), "corrected B is imported once, not once per waiter").toHaveLength(1);
  });

  it.each(invalidMaterials)("still denies $name when the endpoint has not been corrected", async ({ patch }) => {
    const f = await fixture(await freshInstance());
    f.endpoint.reply = () => jwks([a.jwk, { ...b.jwk, ...patch }]);
    expect((await f.request(await f.token(a))).status).toBe(200);
    const tokenB = await f.token(b);
    await denied(await f.request(tokenB));
    now += 30_000;
    await denied(await f.request(tokenB));
    expect((await f.request(await f.token(a))).status).toBe(200);
    expect(f.endpoint.calls, "invalid material cannot cause an unbounded retry").toBeLessThanOrEqual(2);
  });
});

type Mode = "success" | "failed retrieval" | "unknown kid";
const capacities = ["success", "failed retrieval", "unknown kid", "mixed"] as const;
async function capacityFixture(pattern: typeof capacities[number]) {
  const dw = await freshInstance();
  const fixtures = await Promise.all(Array.from({ length: 17 }, () => fixture(dw)));
  const modes: Mode[] = Array.from({ length: 16 }, (_, i) => pattern === "mixed"
    ? (["success", "failed retrieval", "unknown kid"] as const)[i % 3]!
    : pattern);
  const tokens = await Promise.all(fixtures.map((f, i) => f.token(a, modes[i] === "unknown kid" ? "absent" : a.jwk.kid)));
  for (let i = 0; i < 16; i++) {
    const f = fixtures[i]!;
    if (modes[i] === "failed retrieval") f.endpoint.reply = () => new Response(null, { status: 503 });
    const response = await f.request(tokens[i]!);
    if (modes[i] === "success") expect(response.status, "first 16 issuers fit").toBe(200);
    else await denied(response);
    expect(f.endpoint.calls).toBe(1);
    // The failure is now repairable, but its initial fetch still owns a cooldown.
    f.endpoint.reply = () => jwks();
  }
  return { fixtures, modes, tokens };
}

// Catches eviction of settled-but-cooling issuer states, which otherwise erases
// the last fetch start and lets configured-issuer churn bypass the 30s limit.
describe("Access JWKS cooldown survives issuer capacity pressure", () => {
  it.each(capacities)("rejects a 17th issuer at 0 and 29,999 ms without erasing %s cooldowns", async (pattern) => {
    const { fixtures, modes, tokens } = await capacityFixture(pattern);
    const newcomer = fixtures[16]!;
    const startedAt = now;
    for (const elapsed of [0, 29_999]) {
      now = startedAt + elapsed;
      const response = await newcomer.request(tokens[16]!);
      expect.soft(response.status, `17th issuer at ${elapsed}ms is an operational capacity denial`).toBe(503);
      expect.soft(await response.json()).toMatchObject({ error: {
        code: "access_key_cache_busy", hint: expect.stringMatching(/retry|try again|capacity|busy|temporar/i),
      } });
      expect.soft(response.headers.getSetCookie()).toEqual([]);
      expect.soft(newcomer.endpoint.calls, "no free state means no fetch").toBe(0);
      const statuses: number[] = [];
      for (let i = 0; i < 16; i++) {
        const response = await fixtures[i]!.request(tokens[i]!);
        statuses.push(response.status);
        if (response.status === 401) await denied(response);
      }
      expect.soft(statuses, "the first 16 issuers retain their results inside cooldown").toEqual(modes.map((mode) => mode === "success" ? 200 : 401));
      expect.soft(fixtures.slice(0, 16).map((f) => f.endpoint.calls), "attempted churn cannot erase any issuer's fetch start").toEqual(Array(16).fill(1));
    }
  });

  it.each(capacities)("admits an idle state at exactly 30,000 ms after %s states", async (pattern) => {
    const { fixtures, tokens } = await capacityFixture(pattern);
    now += 30_000;
    expect((await fixtures[16]!.request(tokens[16]!)).status).toBe(200);
    expect(fixtures[16]!.endpoint.calls).toBe(1);
    expect(fixtures.slice(0, 16).map((f) => f.endpoint.calls)).toEqual(Array(16).fill(1));
  });

  it("capacity eviction never resurrects old keys during a trusted-endpoint outage", async () => {
    const { fixtures, tokens } = await capacityFixture("success");
    now += 30_000;
    expect((await fixtures[16]!.request(tokens[16]!)).status).toBe(200);
    for (const f of fixtures) f.endpoint.reply = () => new Response(null, { status: 503 });
    let trusted = 0;
    let refetched = 0;
    for (let i = 0; i < 17; i++) {
      const before = fixtures[i]!.endpoint.calls;
      const response = await fixtures[i]!.request(tokens[i]!);
      if (response.status === 200) trusted++;
      else await denied(response);
      if (fixtures[i]!.endpoint.calls > before) {
        refetched++;
        expect(response.status, "evicted key material cannot survive failed retrieval").toBe(401);
      }
    }
    expect(trusted, "at most 16 live issuer states, never a hidden stale-key store").toBeLessThanOrEqual(16);
    expect(refetched, "at least one evicted issuer must retrieve again and fail closed").toBeGreaterThanOrEqual(1);
  });
});
