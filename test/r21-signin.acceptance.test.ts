import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import * as core from "@dropway/core";
import type { DropwayContext, Principal } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { connectMcp } from "./mcp-helpers";
import {
  env, expectHashedOnly, freshInstance, issuedSessionCookies, jsonBody, loginLink, member, MINUTE,
  ownerId, SAME_ORIGIN, sessionCookie, signedIn,
} from "./r21-helpers";

afterEach(() => vi.useRealTimers());

function milliseconds(value: number | string) {
  return typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
}

// Breaks caught: missing issuer, reusable/overlong-lived secrets, plaintext storage,
// privilege escalation through memberId, and sessions surviving revocation/removal.
describe("R-21 real one-time login links", () => {
  it("exchanges the actual link for a host-only session, not an API-key-shaped cookie", async () => {
    const dw = await freshInstance();
    const session = await signedIn(dw);
    expect(session.cookie).not.toContain(dw.ownerKey);
    await expectHashedOnly(session.cookie.split("=").slice(1).join("="));
  });

  it("stores only the login token hash and gives exactly 15 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dw = await freshInstance();
    const now = Date.now();
    const link = await loginLink(dw);
    expect(milliseconds(link.expiresAt) - now).toBe(15 * MINUTE);
    await expectHashedOnly(link.token);
  });

  it("accepts a link immediately before its expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dw = await freshInstance();
    const link = await loginLink(dw);
    vi.setSystemTime(Date.now() + 15 * MINUTE - 1);
    sessionCookie(await dw.call(link.url));
  });

  it.each([15 * MINUTE, 15 * MINUTE + 1])("does not authenticate an expired link at +%i ms", async (elapsed) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dw = await freshInstance();
    const link = await loginLink(dw);
    vi.setSystemTime(Date.now() + elapsed);
    expect(issuedSessionCookies(await dw.call(link.url))).toEqual([]);
  });

  it("does not authenticate a consumed link twice", async () => {
    const dw = await freshInstance();
    const first = await signedIn(dw);
    const replay = await dw.call(first.link.url);
    expect(issuedSessionCookies(replay)).toEqual([]);
    expect((await dw.json("/api/v1/auth/sessions", { headers: { Cookie: first.cookie } })).body.sessions).toHaveLength(1);
  });

  it("consumes a link atomically when two real exchanges race", async () => {
    const dw = await freshInstance();
    const link = await loginLink(dw);
    const responses = await Promise.all([dw.call(link.url), dw.call(link.url)]);
    const issued = responses.filter((response) => issuedSessionCookies(response).length > 0);
    expect(issued).toHaveLength(1);
    const cookie = sessionCookie(issued[0]!);
    const sessions = await dw.json("/api/v1/auth/sessions", { headers: { Cookie: cookie } });
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toHaveLength(1);
  });

  it.each(["not-a-login-token", "", "dwc_wrong-credential-kind"])('does not issue a session for invalid token "%s"', async (token) => {
    const dw = await freshInstance();
    const response = await dw.call(`/login?token=${encodeURIComponent(token)}`);
    expect(issuedSessionCookies(response)).toEqual([]);
  });

  it("lets a member mint for themself but not another member", async () => {
    const dw = await freshInstance();
    const a = await member(dw);
    await loginLink(dw, a.id, a.key);
    const denied = await dw.json("/api/v1/login-links", {
      key: a.key, ...jsonBody({ memberId: await ownerId(dw) }),
    });
    expect(denied.status).toBe(403);
    expect(denied.res.headers.getSetCookie()).toEqual([]);
  });

  it("refuses anonymous minting and unknown members without creating one", async () => {
    const dw = await freshInstance();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first<{ n: number }>();
    const anonymous = await dw.json("/api/v1/login-links", { ...jsonBody({ memberId: await ownerId(dw) }) });
    expect(anonymous.status).toBe(401);
    const unknown = await dw.json("/api/v1/login-links", { key: dw.ownerKey, ...jsonBody({ memberId: "missing-member" }) });
    expect(unknown.status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first()).toEqual(before);
  });

  it("a site-restricted key cannot turn itself into an unrestricted member session", async () => {
    const dw = await freshInstance();
    const site = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "restricted-login" }) });
    expect(site.status).toBe(201);
    const key = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ site: "restricted-login", scopes: ["sites:read"] }) });
    expect(key.status).toBe(201);
    const response = await dw.json("/api/v1/login-links", { key: key.body.key, ...jsonBody({ memberId: await ownerId(dw) }) });
    expect(response.status).toBe(403);
  });

  it("the core createLoginLink service mints a real exchange and enforces member authorization itself", async () => {
    const dw = await freshInstance({ appOrigin: "https://dropway.test" });
    const a = await member(dw);
    // Proposed core export following the architecture's existing service naming.
    // Assert availability before calling: missing feature is RED, never an import error.
    const exported = (core as Record<string, unknown>)["createLoginLink"];
    expect(typeof exported, "login links belong in a core service, not an HTTP-only implementation").toBe("function");
    const createLoginLink = exported as (dc: DropwayContext, principal: Principal, input: { memberId: string }) => Promise<{ url: string }>;
    const ctx = createExecutionContext();
    const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
    const principal = await dc.adapters.identity.resolve(new Request("https://dropway.test", { headers: { Authorization: `Bearer ${a.key}` } }), dc);
    const link = await createLoginLink(dc, principal, { memberId: a.id });
    sessionCookie(await dw.call(link.url));
    await expect(createLoginLink(dc, principal, { memberId: await ownerId(dw) })).rejects.toMatchObject({ status: 403 });
    await waitOnExecutionContext(ctx);
  });

  it("MCP create_login_link produces the same real exchange and member authorization", async () => {
    const dw = await freshInstance();
    const a = await member(dw);
    const client = await connectMcp(dw, dw.ownerKey, { path: "/mcp?toolsets=members" });
    try {
      expect((await client.tools()).some((tool) => tool.name === "create_login_link")).toBe(true);
      const result = await client.call("create_login_link", { memberId: a.id });
      expect(result.isError).toBe(false);
      expect(typeof result.data.url).toBe("string");
      const cookie = sessionCookie(await dw.call(result.data.url));
      expect((await dw.json("/api/v1/auth/sessions", { headers: { Cookie: cookie } })).status).toBe(200);
    } finally { await client.client.close(); }
    const memberClient = await connectMcp(dw, a.key, { path: "/mcp?toolsets=members" });
    try {
      const denied = await memberClient.call("create_login_link", { memberId: await ownerId(dw) });
      expect(denied.isError).toBe(true);
    } finally { await memberClient.client.close(); }
  });
});

describe("R-21 own-member session lifecycle", () => {
  it("lists only the caller's sessions, and one member cannot revoke another's", async () => {
    const dw = await freshInstance();
    const a = await member(dw);
    const owner = await signedIn(dw);
    const other = await signedIn(dw, a.id);
    const listed = await dw.json("/api/v1/auth/sessions", { headers: { Cookie: other.cookie } });
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(1);
    expect(listed.body.sessions.map((session: { id: string }) => session.id)).not.toContain(owner.sessions[0]!.id);
    const denied = await dw.call(`/api/v1/auth/sessions/${owner.sessions[0]!.id}`, {
      method: "DELETE", headers: { ...SAME_ORIGIN, Cookie: other.cookie },
    });
    expect([403, 404]).toContain(denied.status);
    expect((await dw.json("/api/v1/auth/sessions", { headers: { Cookie: owner.cookie } })).status).toBe(200);
  });

  it("revokes a selected own session without revoking a second live session", async () => {
    const dw = await freshInstance();
    const first = await signedIn(dw);
    const second = await signedIn(dw);
    const revoked = await dw.call(`/api/v1/auth/sessions/${first.sessions[0]!.id}`, {
      method: "DELETE", headers: { ...SAME_ORIGIN, Cookie: second.cookie },
    });
    expect([200, 204]).toContain(revoked.status);
    expect((await dw.json("/api/v1/auth/sessions", { headers: { Cookie: first.cookie } })).status).toBe(401);
    expect((await dw.json("/api/v1/auth/sessions", { headers: { Cookie: second.cookie } })).status).toBe(200);
  });

  it("logout invalidates server-side authority, including a replay of the old cookie", async () => {
    const dw = await freshInstance();
    const { cookie } = await signedIn(dw);
    const logout = await dw.call("/api/v1/auth/logout", { method: "POST", headers: { ...SAME_ORIGIN, Cookie: cookie } });
    expect([200, 204, 303]).toContain(logout.status);
    expect((await dw.json("/api/v1/auth/sessions", { headers: { ...SAME_ORIGIN, Cookie: cookie } })).status).toBe(401);
    expect(logout.headers.getSetCookie().some((value) => value.startsWith("__Host-dw_session=") && /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(value))).toBe(true);
  });

  it("member removal invalidates that member's previously issued sessions", async () => {
    const dw = await freshInstance();
    const a = await member(dw);
    const { cookie } = await signedIn(dw, a.id);
    expect((await dw.call(`/api/v1/members/${a.id}`, { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    expect((await dw.json("/api/v1/auth/sessions", { headers: { ...SAME_ORIGIN, Cookie: cookie } })).status).toBe(401);
  });

  it.each([undefined, "__Host-dw_session=unknown-session"])('headers alone cannot authorize a missing/invalid session (%s)', async (cookie) => {
    const dw = await freshInstance();
    const headers = new Headers(SAME_ORIGIN);
    if (cookie) headers.set("Cookie", cookie);
    expect((await dw.call("/api/v1/auth/sessions", { headers })).status).toBe(401);
  });
});
