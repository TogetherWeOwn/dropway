import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpEndpoint } from "@dropway/server";
import {
  callWithBindings, env, freshInstance, issuedSessionCookies, member,
  ORIGIN, ownerId, sessionCookie, storedRows, type Instance,
} from "./r21-helpers";
import { deniedBrowserHeaders, WORKER_APP, WORKER_SIBLING } from "./r21-browser-headers";

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

const UNSAFE_ACCESS = [
  { surface: "REST", operation: "create site" },
  { surface: "REST", operation: "mint login link" },
  { surface: "MCP", operation: "create site" },
  { surface: "MCP", operation: "mint login link" },
] as const;
type UnsafeAccess = typeof UNSAFE_ACCESS[number];

function accessInstance(origin: string) {
  // Configure only the app hostname through the documented transport option.
  // This does not allow siblings or replace the required exact-origin guard.
  return freshInstance({ appOrigin: origin }, {
    mcp: createMcpEndpoint({ allowedOriginHostnames: [new URL(origin).hostname] }),
  });
}

function accessWrite(dw: Instance, target: UnsafeAccess, memberId: string, headers: Record<string, string>, origin = ORIGIN) {
  const mint = target.operation === "mint login link";
  const args = mint ? { memberId } : { slug: "access-intent-site" };
  const path = target.surface === "REST" ? (mint ? "/api/v1/login-links" : "/api/v1/sites") : (mint ? "/mcp?toolsets=members" : "/mcp");
  const body = target.surface === "REST" ? args : {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: mint ? "create_login_link" : "create_site", arguments: args },
  };
  // Simple text/plain POSTs are reachable by forms; REST parsing must not be
  // mistaken for browser intent. MCP keeps its actual JSON transport contract.
  return callWithBindings(dw, `${origin}${path}`, { ...BINDINGS, APP_ORIGIN: origin }, {
    method: "POST", body: JSON.stringify(body), headers: {
      "Content-Type": target.surface === "REST" ? "text/plain" : "application/json",
      Host: new URL(origin).host, Accept: "application/json, text/event-stream", ...headers,
    },
  });
}

async function accessOwner(dw: Instance, origin: string) {
  const id = await ownerId(dw);
  localJwksOnly();
  const headers = { "Cf-Access-Jwt-Assertion": await jwt() };
  const me = await callWithBindings(dw, `${origin}/api/v1/me`, BINDINGS, { headers });
  expect(me.status, "the real signature/JWKS/member path must work before testing browser intent").toBe(200);
  expect((await me.json() as { member: { id: string } }).member.id).toBe(id);
  return { id, headers };
}

async function expectAccessWrite(response: Response, target: UnsafeAccess, memberId: string, origin: string) {
  const expectedStatus = target.surface === "REST" ? 201 : 200;
  expect(response.status, response.status === expectedStatus ? undefined : await response.text()).toBe(expectedStatus);
  const text = await response.text();
  const envelopes = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, any>)
    : [JSON.parse(text) as Record<string, any>];
  expect(envelopes).toHaveLength(1);
  const envelope = envelopes[0]!;
  if (target.surface === "MCP") {
    expect(envelope.error).toBeUndefined();
    expect(envelope.result.isError).not.toBe(true);
  }
  const rows = await storedRows();
  const sites = rows.filter(({ table }) => table === "sites");
  const links = rows.filter(({ table }) => table === "login_links");
  expect(rows.filter(({ table }) => table === "sessions")).toEqual([]);
  expect(issuedSessionCookies(response)).toEqual([]);
  if (target.operation === "create site") {
    expect(sites).toHaveLength(1);
    expect(sites[0]!.row.slug).toBe("access-intent-site");
    const tenant = await env.DB.prepare("SELECT id FROM tenants").first<{ id: string }>();
    expect(sites[0]!.row.tenant_id).toBe(tenant!.id);
    expect(links).toEqual([]);
    return null;
  }
  expect(sites).toEqual([]);
  expect(links).toHaveLength(1);
  expect(links[0]!.row.member_id).toBe(memberId);
  const data = target.surface === "REST" ? envelope : envelope.result.structuredContent;
  expect(typeof data.url).toBe("string");
  const url = new URL(data.url);
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe("/login");
  expect(Boolean(url.searchParams.get("token"))).toBe(true);
  return url.href;
}

// Break caught: treating a proxy assertion as an explicit bearer credential.
// No Cookie is sent: a trusted proxy can strip it and inject ambient identity.
// Signature verification remains real; only the external JWKS fetch is local.
describe.each(UNSAFE_ACCESS)("R-21 Access browser intent: $surface $operation", (target) => {
  it.each(deniedBrowserHeaders())("denies $name without any D1 mutation", async ({ origin, headers }) => {
    const dw = await accessInstance(origin);
    const access = await accessOwner(dw, origin);
    const before = await storedRows();
    const response = await accessWrite(dw, target, access.id, { ...access.headers, ...headers }, origin);
    expect.soft(response.status).toBe(403);
    expect.soft(issuedSessionCookies(response)).toEqual([]);
    expect(await storedRows(), "denial must precede site writes and login-link minting").toEqual(before);
  });

  it.each([ORIGIN, WORKER_APP])("positive control: both exact browser headers at %s permit precisely the intended write", async (origin) => {
    const dw = await accessInstance(origin);
    const access = await accessOwner(dw, origin);
    const response = await accessWrite(dw, target, access.id, {
      ...access.headers, Origin: origin, "Sec-Fetch-Site": "same-origin",
    }, origin);
    const url = await expectAccessWrite(response, target, access.id, origin);
    if (url) sessionCookie(await dw.call(url));
  });

  it("positive control: an explicit headerless bearer writes even with an invalid unused Access assertion", async () => {
    const dw = await accessInstance(ORIGIN);
    const id = await ownerId(dw);
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("bearer precedence must not consult Access JWKS");
    });
    const response = await accessWrite(dw, target, id, {
      Authorization: `Bearer ${dw.ownerKey}`, "Cf-Access-Jwt-Assertion": "not-a-valid-assertion",
    });
    await expectAccessWrite(response, target, id, ORIGIN);
    expect(network).not.toHaveBeenCalled();
  });

  if (target.surface === "REST") {
    it("positive control: a bearer with hostile browser headers is not reclassified as ambient Access", async () => {
      const dw = await accessInstance(ORIGIN);
      const id = await ownerId(dw);
      const response = await accessWrite(dw, target, id, {
        Authorization: `Bearer ${dw.ownerKey}`, "Cf-Access-Jwt-Assertion": "not-a-valid-assertion",
        Origin: WORKER_SIBLING, "Sec-Fetch-Site": "cross-site",
      });
      await expectAccessWrite(response, target, id, ORIGIN);
    });
  }
});

it("R-21 a valid bearer member takes precedence over a different valid Access member", async () => {
  const dw = await accessInstance(ORIGIN);
  const existing = await member(dw);
  localJwksOnly();
  const headers = { Authorization: `Bearer ${existing.key}`, "Cf-Access-Jwt-Assertion": await jwt() };
  const me = await callWithBindings(dw, "/api/v1/me", BINDINGS, { headers });
  expect(me.status).toBe(200);
  expect((await me.json() as { member: { id: string } }).member.id).toBe(existing.id);
  const before = await storedRows();
  const mint = await accessWrite(dw, { surface: "REST", operation: "mint login link" }, await ownerId(dw), headers);
  expect(mint.status, "the Access owner's role must not elevate the explicit member bearer").toBe(403);
  expect(await storedRows()).toEqual(before);
});
