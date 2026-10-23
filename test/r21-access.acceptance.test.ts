import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { callWithBindings, env, freshInstance, member } from "./r21-helpers";

const TEAM = "https://signin-fixture.cloudflareaccess.com";
const AUD = "fixture-access-application";
const BINDINGS = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
let keys: CryptoKeyPair;
let impostor: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string; alg: string; use: string };

function b64url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

beforeAll(async () => {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keys = await crypto.subtle.generateKey(params, true, ["sign", "verify"]) as CryptoKeyPair;
  impostor = await crypto.subtle.generateKey(params, true, ["sign", "verify"]) as CryptoKeyPair;
  jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey, kid: "fixture-key", alg: "RS256", use: "sig" };
});
afterEach(() => vi.restoreAllMocks());

async function jwt(overrides: Record<string, unknown> = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "fixture-key", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: TEAM, aud: [AUD], sub: "external-identity-not-a-member-id", email: "owner@example.com", iat: now - 1, exp: now + 300, type: "app", ...overrides }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

function localJwksOnly() {
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${TEAM}/cdn-cgi/access/certs`) throw new Error(`Unexpected outbound request in hermetic Access test: ${new URL(url).pathname}`);
    expect(++requests, "bound JWKS retrieval; no network or identity endpoint").toBeLessThanOrEqual(4);
    return Response.json({ keys: [jwk] }, { headers: { "Cache-Control": "public, max-age=60" } });
  });
}

// Breaks caught: decoding without signature verification, audience/issuer/expiry
// bypass, trusting an email header or unknown email, and implicit member creation.
describe("R-21 cryptographically verified optional Access identity", () => {
  it("maps a real RS256 JWT to the existing member by email, not external subject", async () => {
    const dw = await freshInstance();
    const existing = await member(dw);
    localJwksOnly();
    const headers = { "Cf-Access-Jwt-Assertion": await jwt({ email: existing.email }) };
    const authorized = await callWithBindings(dw, "/api/v1/sites", BINDINGS, { headers });
    expect(authorized.status).toBe(200);
    const response = await callWithBindings(dw, "/api/v1/me", BINDINGS, { headers });
    expect(response.status).toBe(200);
    const body = await response.json() as { member: { id: string; email: string } };
    expect(body.member).toBeTruthy();
    expect(body.member.id).toBe(existing.id);
    expect(body.member.email).toBe(existing.email);
  });

  it.each([
    { name: "invalid signature over otherwise valid claims", changes: {}, impostor: true },
    { name: "wrong audience", changes: { aud: ["different-application"] } },
    { name: "wrong issuer", changes: { iss: "https://other-fixture.cloudflareaccess.com" } },
    { name: "expired token", changes: { exp: 1 } },
    { name: "unknown member email", changes: { email: "unknown@example.com" } },
  ])("refuses $name without creating a member or a session", async ({ changes, impostor: wrongKey }) => {
    const dw = await freshInstance();
    localJwksOnly();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first();
    const response = await callWithBindings(dw, "/api/v1/sites", BINDINGS, {
      headers: { "Cf-Access-Jwt-Assertion": await jwt(changes, wrongKey ? impostor.privateKey : keys.privateKey) },
    });
    expect([401, 403]).toContain(response.status);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first()).toEqual(before);
  });

  it("does not trust an unsigned token or a forged email header", async () => {
    const dw = await freshInstance();
    localJwksOnly();
    const unsigned = `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify({ email: "owner@example.com", aud: [AUD], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 300 }))}.`;
    for (const headers of [new Headers({ "Cf-Access-Jwt-Assertion": unsigned }), new Headers({ "Cf-Access-Authenticated-User-Email": "owner@example.com" })]) {
      const response = await callWithBindings(dw, "/api/v1/sites", BINDINGS, { headers });
      expect([401, 403]).toContain(response.status);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it.each([{}, { ACCESS_TEAM_DOMAIN: TEAM }, { ACCESS_AUD: AUD }])("does not activate Access identity with incomplete configuration: %j", async (bindings) => {
    const dw = await freshInstance();
    localJwksOnly();
    const response = await callWithBindings(dw, "/api/v1/sites", bindings, { headers: { "Cf-Access-Jwt-Assertion": await jwt() } });
    expect([401, 403]).toContain(response.status);
  });
});
