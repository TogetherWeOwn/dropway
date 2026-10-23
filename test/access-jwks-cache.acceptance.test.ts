import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAccessIdentity } from "../packages/core/src/services/access-identity";
import { callWithBindings, env, freshInstance, member, ORIGIN, type Instance } from "./r21-helpers";
import type { ServerBindings } from "@dropway/server";

// Independent cache contract. Real RS256 signatures, default identity and emulated
// member data; only the configured public-key endpoint and clock are intercepted.
// This is not the separate ambient-Access unsafe-operation/browser contract.
type SigningKey = { pair: CryptoKeyPair; jwk: JsonWebKey & { kid: string } };
type Endpoint = { calls: number; reply: (init?: RequestInit) => Response | Promise<Response> };
const AUD = "cache-application";
const IP = "192.0.2.17";
let primary: SigningKey;
let rotated: SigningKey;
let impostor: SigningKey;
let sequence = 0;
let nextEpoch = Date.UTC(2030, 0, 1);
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
  primary = await key("shared-kid");
  rotated = await key("rotated-kid");
  impostor = await key("shared-kid");
});
beforeEach(() => {
  // Module cache outlives each case. Separate epochs by more than every case's
  // elapsed time and trust window so earlier cooldown states cannot fill slots.
  now = nextEpoch;
  nextEpoch += 600_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  endpoints = new Map();
  unexpected = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const endpoint = endpoints.get(url);
    if (!endpoint) {
      unexpected.push(url);
      throw new Error("Unexpected outbound request in hermetic JWKS test");
    }
    endpoint.calls++;
    return endpoint.reply(init);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  // The verifier catches fetch errors, so a thrown stub error alone cannot
  // prove that no token-supplied or other untrusted URL was attempted.
  expect(unexpected, "no real network and no unconfigured outbound URLs").toEqual([]);
});

function jwks(keys: JsonWebKey[] = [primary.jwk], headers: HeadersInit = {}) {
  return Response.json({ keys }, { headers });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(dw?: Instance) {
  dw ??= await freshInstance();
  const issuer = `https://cache-fixture-${++sequence}.cloudflareaccess.com`;
  const bindings = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: AUD };
  const endpoint: Endpoint = { calls: 0, reply: () => jwks() };
  endpoints.set(`${issuer}/cdn-cgi/access/certs`, endpoint);
  async function token(claims: Record<string, unknown> = {}, signing = primary, header: Record<string, unknown> = {}) {
    const seconds = now / 1000;
    const encodedHeader = b64url(JSON.stringify({ alg: "RS256", kid: signing.jwk.kid, typ: "JWT", ...header }));
    const encodedPayload = b64url(JSON.stringify({
      iss: issuer, aud: [AUD], sub: "external-subject", email: "owner@example.com",
      iat: seconds - 1, exp: seconds + 3600, type: "app", ...claims,
    }));
    const input = `${encodedHeader}.${encodedPayload}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signing.pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64url(new Uint8Array(signature))}`;
  }
  async function request(assertion: string, path = "/api/v1/sites", config = bindings, headers: HeadersInit = {}) {
    const merged = new Headers(headers);
    merged.set("Cf-Access-Jwt-Assertion", assertion);
    return callWithBindings(dw!, path, config, { headers: merged });
  }
  function verify(assertion: string) {
    const dc = dw!.dropway.context({ ...env, ...bindings } as unknown as ServerBindings, { waitUntil() {} }, new URL(ORIGIN));
    return resolveAccessIdentity(dc, assertion, IP);
  }
  return { dw, issuer, bindings, endpoint, token, request, verify };
}
async function denied(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_access_identity" } });
  expect(response.headers.getSetCookie()).toEqual([]);
}
async function counts() {
  return {
    members: await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first(),
    sessions: await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first(),
  };
}

// Missing reuse/import caching and single-flight cause these availability REDs.
describe("Access JWKS reuse and per-issuer single-flight", () => {
  it("reuses fetched and imported verification material across distinct public assertions", async () => {
    const f = await fixture();
    const added = await member(f.dw);
    const imports = vi.spyOn(crypto.subtle, "importKey");
    expect((await f.request(await f.token())).status).toBe(200);
    const response = await f.request(await f.token({ email: added.email, sub: "different-subject" }), "/api/v1/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ member: { id: added.id, email: added.email } });
    expect.soft(f.endpoint.calls, "distinct JWTs share public key material, not a Principal").toBe(1);
    expect(imports).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "unknown kid", "failed response"] as const)("coalesces concurrent cold %s requests", async (mode) => {
    const f = await fixture();
    const gate = deferred<void>();
    const entered = deferred<void>();
    f.endpoint.reply = async () => { entered.resolve(); await gate.promise; return mode === "failed response" ? new Response(null, { status: 503 }) : jwks(); };
    const token = await f.token({}, primary, mode === "unknown kid" ? { kid: "absent" } : {});
    const imports = vi.spyOn(crypto.subtle, "importKey");
    const pending = Array.from({ length: 8 }, () => f.verify(token).then(() => "member", () => "denied"));
    await entered.promise;
    // All invocations have synchronously reached the fetch/cache boundary.
    gate.resolve();
    const results = await Promise.all(pending);
    expect(results).toEqual(Array(8).fill(mode === "success" ? "member" : "denied"));
    expect.soft(f.endpoint.calls).toBe(1);
    expect(imports).toHaveBeenCalledTimes(mode === "success" ? 1 : 0);
  });

  it("normalizes configured issuer spellings to the same trusted origin", async () => {
    const f = await fixture();
    const token = await f.token();
    for (const domain of [f.issuer, `${f.issuer}/`, new URL(f.issuer).hostname]) {
      expect((await f.request(token, "/api/v1/sites", { ...f.bindings, ACCESS_TEAM_DOMAIN: domain })).status).toBe(200);
    }
    expect(f.endpoint.calls).toBe(1);
  });
});

// Fetch-start cooldown applies to the initial load, misses, and failures alike.
describe("Access JWKS rotation and bounded miss traffic", () => {
  it("refreshes a new kid at 30 seconds and atomically drops the removed old kid", async () => {
    const f = await fixture();
    const old = await f.token();
    expect((await f.request(old)).status).toBe(200);
    f.endpoint.reply = () => jwks([rotated.jwk]);
    now += 29_999;
    await denied(await f.request(await f.token({}, rotated)));
    expect(f.endpoint.calls, "initial load also starts the cooldown").toBe(1);
    now += 1;
    expect((await f.request(await f.token({}, rotated))).status).toBe(200);
    expect(f.endpoint.calls).toBe(2);
    await denied(await f.request(old));
    expect(f.endpoint.calls, "removed kid cannot force an immediate second refresh").toBe(2);
  });

  it("a successful rotation drops old verification material rather than merging keysets", async () => {
    const f = await fixture();
    const old = await f.token();
    expect((await f.request(old)).status).toBe(200);
    now += 30_000;
    f.endpoint.reply = () => jwks([rotated.jwk]);
    expect((await f.request(await f.token({}, rotated))).status).toBe(200);
    await denied(await f.request(old));
  });

  it("concurrent warm unknown-kid refreshes share retrieval and key import", async () => {
    const f = await fixture();
    expect((await f.request(await f.token())).status).toBe(200);
    now += 30_000;
    const gate = deferred<void>();
    const entered = deferred<void>();
    f.endpoint.reply = async () => { entered.resolve(); await gate.promise; return jwks([rotated.jwk]); };
    const imports = vi.spyOn(crypto.subtle, "importKey");
    const token = await f.token({}, rotated);
    const pending = Array.from({ length: 8 }, () => f.verify(token));
    await entered.promise;
    gate.resolve();
    expect(await Promise.all(pending)).toHaveLength(8);
    expect.soft(f.endpoint.calls).toBe(2);
    expect(imports).toHaveBeenCalledTimes(1);
  });

  it("a burst of distinct unknown kids starts at most one retrieval per 30-second window", async () => {
    const f = await fixture();
    const tokens = await Promise.all(Array.from({ length: 96 }, (_, i) => f.token({}, primary, { kid: `random-${i}` })));
    for (const token of tokens.slice(0, 48)) await denied(await f.request(token));
    expect.soft(f.endpoint.calls, "cold misses share the initial-fetch cooldown").toBe(1);
    now += 30_000;
    await Promise.all(tokens.slice(48).map(async (token) => denied(await f.request(token))));
    expect(f.endpoint.calls, "one refresh, not an unknown-kid fetch storm").toBe(2);
  });

  it("failed initial retrievals are cooled down and recover exactly at the next window", async () => {
    const f = await fixture();
    const token = await f.token();
    f.endpoint.reply = () => new Response(null, { status: 503 });
    await denied(await f.request(token));
    now += 29_999;
    await denied(await f.request(token));
    expect.soft(f.endpoint.calls).toBe(1);
    f.endpoint.reply = () => jwks();
    now += 1;
    expect((await f.request(token)).status).toBe(200);
    expect(f.endpoint.calls).toBe(2);
  });

  it("a forged signature for a known kid never triggers a refresh, even after cooldown", async () => {
    const f = await fixture();
    expect((await f.request(await f.token())).status).toBe(200);
    now += 30_000;
    await denied(await f.request(await f.token({}, impostor)));
    expect(f.endpoint.calls).toBe(1);
  });
});

// No stale-key fallback beyond the original fixed fetch-start trust deadline.
describe("Access JWKS outage and trust deadline", () => {
  it("serves warm keys during outage before, but never at or after, 300 seconds", async () => {
    const f = await fixture();
    const token = await f.token();
    expect((await f.request(token)).status).toBe(200);
    f.endpoint.reply = () => new Response(null, { status: 503 });
    now += 299_999;
    expect.soft((await f.request(token)).status, "unexpired public verification material survives an outage").toBe(200);
    now += 1;
    await denied(await f.request(token));
    now += 1;
    await denied(await f.request(token));
    expect.soft(f.endpoint.calls, "one failed expiry refresh, then cooldown").toBe(2);
    f.endpoint.reply = () => jwks();
    now += 29_999;
    expect((await f.request(token)).status).toBe(200);
    expect(f.endpoint.calls).toBe(3);
  });

  it("failed unknown-kid refresh and repeated hits cannot slide the old trust deadline", async () => {
    const f = await fixture();
    const token = await f.token();
    expect((await f.request(token)).status).toBe(200);
    f.endpoint.reply = () => new Response(null, { status: 503 });
    now += 270_000;
    await denied(await f.request(await f.token({}, rotated)));
    expect.soft((await f.request(token)).status, "failed refresh leaves old keys usable only until original expiry").toBe(200);
    now += 29_999;
    expect.soft((await f.request(token)).status).toBe(200);
    now += 1;
    await denied(await f.request(token));
    expect(f.endpoint.calls).toBe(3);
  });

  it("measures trust from fetch start rather than slow response completion", async () => {
    const f = await fixture();
    const gate = deferred<void>();
    const entered = deferred<void>();
    f.endpoint.reply = async () => { entered.resolve(); await gate.promise; return jwks(); };
    const token = await f.token();
    const pending = f.verify(token);
    await entered.promise;
    now += 299_000;
    gate.resolve();
    expect(await pending).toMatchObject({ kind: "member", via: "access" });
    f.endpoint.reply = () => new Response(null, { status: 503 });
    now += 1_000;
    await denied(await f.request(token));
  });

  it("Cache-Control cannot extend the local 300-second trust ceiling", async () => {
    const f = await fixture();
    f.endpoint.reply = () => jwks([primary.jwk], { "Cache-Control": "public, max-age=31536000, stale-if-error=31536000" });
    const token = await f.token();
    expect((await f.request(token)).status).toBe(200);
    now += 300_000;
    f.endpoint.reply = () => new Response(null, { status: 503 });
    await denied(await f.request(token));
    expect(f.endpoint.calls).toBe(2);
  });
});

// Same kid/key or a previously verified JWT must not cache authorization.
describe("Access JWKS issuer and authorization isolation", () => {
  it("isolates the same kid under different configured issuers and keypairs", async () => {
    const a = await fixture();
    const b = await fixture(a.dw);
    b.endpoint.reply = () => jwks([impostor.jwk]);
    expect((await a.request(await a.token())).status).toBe(200);
    expect((await b.request(await b.token({}, impostor))).status).toBe(200);
    await denied(await b.request(await b.token()));
    await denied(await a.request(await a.token({}, impostor)));
    expect((await a.request(await a.token())).status).toBe(200);
    expect((await b.request(await b.token({}, impostor))).status).toBe(200);
  });

  it("revalidates a changed audience on a warm issuer cache", async () => {
    const f = await fixture();
    const token = await f.token();
    expect((await f.request(token)).status).toBe(200);
    const changed = { ...f.bindings, ACCESS_AUD: "another-application" };
    await denied(await f.request(token, "/api/v1/sites", changed));
    expect((await f.request(await f.token({ aud: ["another-application"] }), "/api/v1/sites", changed)).status).toBe(200);
    expect(f.endpoint.calls, "audience is a per-request decision, not a second keyset").toBe(1);
  });

  it.each(["disabled member", "disabled tenant", "removed member"] as const)("rechecks current %s even for the identical warm assertion", async (mode) => {
    const f = await fixture();
    const added = await member(f.dw);
    const token = await f.token({ email: added.email });
    expect((await f.request(token)).status).toBe(200);
    if (mode === "disabled member") await env.DB.prepare("UPDATE members SET disabled_at = ? WHERE id = ?").bind(now, added.id).run();
    if (mode === "disabled tenant") await env.DB.prepare("UPDATE tenants SET disabled_at = ?").bind(now).run();
    if (mode === "removed member") await env.DB.prepare("DELETE FROM api_keys WHERE member_id = ?").bind(added.id).run().then(() => env.DB.prepare("DELETE FROM members WHERE id = ?").bind(added.id).run());
    const before = await counts();
    await denied(await f.request(token));
    expect(await counts()).toEqual(before);
  });

  it("preserves explicit bearer precedence without mandatory browser headers", async () => {
    const f = await fixture();
    expect((await f.request(await f.token())).status).toBe(200);
    const before = f.endpoint.calls;
    const response = await f.request("not.a.valid-assertion", "/api/v1/me", f.bindings, { Authorization: `Bearer ${f.dw.ownerKey}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ member: { email: "owner@example.com" } });
    expect(f.endpoint.calls).toBe(before);
  });
});

// Capacity is tested through live trust/outbound behavior, not a private cache API.
describe("Access JWKS hard capacity bounds", () => {
  it("retains at most 16 issuer states; eviction never silently resurrects old trust", async () => {
    const dw = await freshInstance();
    const fixtures = await Promise.all(Array.from({ length: 17 }, () => fixture(dw)));
    const tokens = await Promise.all(fixtures.map((f) => f.token()));
    for (let i = 0; i < fixtures.length; i++) {
      const status = (await fixtures[i]!.request(tokens[i]!)).status;
      // The seventeenth may evict an idle entry or fail closed, but the
      // first sixteen are below capacity and must establish usable trust.
      if (i < 16) expect(status).toBe(200);
      else expect([200, 401]).toContain(status);
    }
    for (const f of fixtures) f.endpoint.reply = () => new Response(null, { status: 503 });
    let stillTrusted = 0;
    for (let i = 0; i < fixtures.length; i++) {
      const response = await fixtures[i]!.request(tokens[i]!);
      if (response.status === 200) stillTrusted++;
      else await denied(response);
    }
    expect(stillTrusted, "an unbounded issuer cache would still authorize all 17").toBeLessThanOrEqual(16);
  });

  it.each(["success", "failure", "unknown kid"] as const)("fails closed at 16 simultaneous in-flight issuer states (%s)", async (mode) => {
    const dw = await freshInstance();
    const fixtures = await Promise.all(Array.from({ length: 17 }, () => fixture(dw)));
    const tokens = await Promise.all(fixtures.map((f) => f.token({}, primary, mode === "unknown kid" ? { kid: "missing" } : {})));
    const gate = deferred<void>();
    let enteredCount = 0;
    const entered = deferred<void>();
    for (const f of fixtures) f.endpoint.reply = async () => {
      if (++enteredCount === 16) entered.resolve();
      await gate.promise;
      return mode === "failure" ? new Response(null, { status: 503 }) : jwks();
    };
    const pending = fixtures.map((f, i) => f.verify(tokens[i]!).then(() => "member", () => "denied"));
    await entered.promise;
    // No real sleeps and no wait for request 17: it must not start a fetch.
    const starts = fixtures.reduce((n, f) => n + f.endpoint.calls, 0);
    gate.resolve();
    const results = await Promise.all(pending);
    expect.soft(starts, "all 16 slots in flight: the 17th must be denied, not admitted").toBe(16);
    expect(results.filter((v) => v === "member")).toHaveLength(mode === "success" ? 16 : 0);
    expect(fixtures[16]!.endpoint.calls).toBe(0);
  });

  it("reuses all 32 admitted keys without per-kid refetching", async () => {
    const f = await fixture();
    f.endpoint.reply = () => jwks(Array.from({ length: 32 }, (_, i) => ({ ...primary.jwk, kid: `key-${i}` })));
    for (let i = 0; i < 32; i++) {
      expect((await f.request(await f.token({}, primary, { kid: `key-${i}` }))).status).toBe(200);
    }
    expect(f.endpoint.calls).toBe(1);
  });

  it("accepts exactly 32 usable keys but rejects the entire over-limit keyset", async () => {
    const f = await fixture();
    const keys = Array.from({ length: 32 }, (_, i) => ({ ...primary.jwk, kid: `key-${i}` }));
    f.endpoint.reply = () => jwks(keys);
    expect((await f.request(await f.token({}, primary, { kid: "key-31" }))).status).toBe(200);
    now += 300_000;
    f.endpoint.reply = () => jwks([...keys, { ...primary.jwk, kid: "key-32" }]);
    await denied(await f.request(await f.token({}, primary, { kid: "key-0" })));
  });
});

const invalidAssertions: Array<{ name: string; claims?: Record<string, unknown>; header?: Record<string, unknown>; forged?: boolean; malformed?: string }> = [
  { name: "forged signature", forged: true },
  { name: "wrong issuer", claims: { iss: "https://untrusted.example" } },
  { name: "wrong audience", claims: { aud: ["not-this-app"] } },
  { name: "expired token", claims: { exp: 1 } },
  { name: "future nbf", claims: { nbf: Date.UTC(2031, 0, 1) / 1000 } },
  { name: "future iat", claims: { iat: Date.UTC(2031, 0, 1) / 1000 } },
  { name: "alg none", header: { alg: "none" } },
  { name: "wrong alg", header: { alg: "HS256" } },
  { name: "crit header", header: { crit: ["unrecognized"] } },
  { name: "malformed token", malformed: "invalid.jwt" },
  { name: "invalid base64", malformed: "!!!.!!!.!!!" },
  { name: "invalid type", claims: { type: "service" } },
  { name: "non-string email", claims: { email: ["owner@example.com"] } },
  { name: "overlong email", claims: { email: `${"a".repeat(255)}@example.com` } },
  { name: "empty email", claims: { email: "" } },
  { name: "unknown member", claims: { email: "missing@example.com" } },
];
describe("Access JWKS warm-cache security controls", () => {
  it.each(invalidAssertions)("rejects $name without implicit member/session creation", async (test) => {
    const f = await fixture();
    expect((await f.request(await f.token())).status).toBe(200);
    const before = await counts();
    const assertion = test.malformed ?? await f.token(test.claims, test.forged ? impostor : primary, test.header);
    await denied(await f.request(assertion));
    expect(await counts()).toEqual(before);
  });

  it("rejects expiry at the exact exp boundary on a warm cache", async () => {
    const f = await fixture();
    const token = await f.token({ exp: now / 1000 + 10 });
    expect((await f.request(token)).status).toBe(200);
    now += 10_000;
    await denied(await f.request(token));
  });

  it("ignores token-supplied jku, x5u and jwk; only configured keys can authorize", async () => {
    const f = await fixture();
    const header = { jku: "https://untrusted.example/jwks", x5u: "https://untrusted.example/cert", jwk: impostor.jwk };
    expect((await f.request(await f.token({}, primary, header))).status).toBe(200);
    await denied(await f.request(await f.token({}, impostor, header)));
  });

  it("invalid claim issuers cannot choose outbound URLs, even on a warm keyset", async () => {
    const f = await fixture();
    expect((await f.request(await f.token())).status).toBe(200);
    const before = f.endpoint.calls;
    for (const iss of ["http://127.0.0.1", "https://attacker.cloudflareaccess.com", `${f.issuer}/path`, "file:///etc/passwd"]) {
      await denied(await f.request(await f.token({ iss })));
    }
    expect(f.endpoint.calls).toBe(before);
  });
});

const badKeysets: Array<{ name: string; response: () => Response }> = [
  { name: "failed response", response: () => new Response(null, { status: 503 }) },
  { name: "redirect response", response: () => new Response(null, { status: 302, headers: { Location: "https://untrusted.example/keys" } }) },
  { name: "malformed JSON", response: () => new Response("{broken") },
  { name: "missing keys", response: () => Response.json({}) },
  { name: "non-array keys", response: () => Response.json({ keys: {} }) },
  { name: "null key", response: () => Response.json({ keys: [null] }) },
  { name: "empty keyset", response: () => jwks([]) },
  { name: "33 keys", response: () => jwks(Array.from({ length: 33 }, (_, i) => ({ ...primary.jwk, kid: i ? `extra-${i}` : primary.jwk.kid }))) },
  { name: "duplicate matching kid", response: () => jwks([primary.jwk, impostor.jwk]) },
  { name: "unsuitable alg", response: () => jwks([{ ...primary.jwk, alg: "RS512" }]) },
  { name: "encryption use", response: () => jwks([{ ...primary.jwk, use: "enc" }]) },
  { name: "unsuitable key ops", response: () => jwks([{ ...primary.jwk, key_ops: ["encrypt"] }]) },
  { name: "invalid RSA material", response: () => jwks([{ ...primary.jwk, n: "!invalid" }]) },
  { name: "wrong key type", response: () => jwks([{ kid: primary.jwk.kid, kty: "EC", crv: "P-256", x: "invalid", y: "invalid" } as JsonWebKey]) },
];
describe("Access JWKS trusted-fetch and poisoning controls", () => {
  it.each(badKeysets)("rejects $name without poisoning another issuer or later recovery", async (test) => {
    const f = await fixture();
    const healthy = await fixture(f.dw);
    const token = await f.token();
    expect((await healthy.request(await healthy.token())).status).toBe(200);
    const before = await counts();
    f.endpoint.reply = test.response;
    await denied(await f.request(token));
    expect(await counts()).toEqual(before);
    expect((await healthy.request(await healthy.token())).status).toBe(200);
    now += 30_000;
    f.endpoint.reply = () => jwks();
    expect((await f.request(token)).status).toBe(200);
  });

  it.each(["malformed", "duplicate kid", "unusable key"] as const)("an invalid warm refresh (%s) cannot grant new trust or extend expiry", async (mode) => {
    const f = await fixture();
    const old = await f.token();
    expect((await f.request(old)).status).toBe(200);
    now += 270_000;
    f.endpoint.reply = () => mode === "malformed" ? new Response("{broken") : mode === "duplicate kid"
      ? jwks([rotated.jwk, { ...impostor.jwk, kid: rotated.jwk.kid }])
      : jwks([{ ...rotated.jwk, n: "!invalid" }]);
    await denied(await f.request(await f.token({}, rotated)));
    now += 30_000;
    f.endpoint.reply = () => new Response(null, { status: 503 });
    await denied(await f.request(old));
  });

  it("counts streamed bytes, not a misleading Content-Length, and rejects above 64 KiB", async () => {
    const f = await fixture();
    const prefix = new TextEncoder().encode(JSON.stringify({ keys: [primary.jwk] }));
    const boundary = new Uint8Array(65_536).fill(32);
    boundary.set(prefix);
    f.endpoint.reply = () => new Response(boundary);
    expect((await f.request(await f.token())).status).toBe(200);
    const g = await fixture(f.dw);
    g.endpoint.reply = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(boundary.slice(0, 32_768));
      controller.enqueue(boundary.slice(32_768));
      controller.enqueue(new Uint8Array([32]));
      controller.close();
    } }), { headers: { "Content-Length": "1" } });
    await denied(await g.request(await g.token()));
  });

  it("uses redirect:error and a 5-second abort signal on the configured HTTPS endpoint", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const entered = deferred<void>();
    f.endpoint.reply = (init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBe(controller.signal);
      entered.resolve();
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("fixture timeout")), { once: true });
      });
    };
    const pending = f.verify(await f.token());
    const outcome = expect(pending).rejects.toMatchObject({ code: "invalid_access_identity", status: 401 });
    await entered.promise;
    controller.abort();
    await outcome;
    expect(timeout).toHaveBeenCalledWith(5_000);
  });

  it.each([
    "http://fixture.cloudflareaccess.com", "https://untrusted.example", "https://fixture.cloudflareaccess.com/path",
    "https://fixture.cloudflareaccess.com?query=1", "https://fixture.cloudflareaccess.com#fragment",
    "https://user:pass@fixture.cloudflareaccess.com", "https://fixture.cloudflareaccess.com:8443",
  ])("rejects invalid configured issuer %s before any fetch", async (domain) => {
    const f = await fixture();
    await denied(await f.request(await f.token(), "/api/v1/sites", { ...f.bindings, ACCESS_TEAM_DOMAIN: domain }));
    expect(f.endpoint.calls).toBe(0);
  });
});
