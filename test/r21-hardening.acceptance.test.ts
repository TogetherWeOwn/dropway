import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMcp } from "./mcp-helpers";
import {
  freshInstance, issuedSessionCookies, jsonBody, loginLink, member, MINUTE, ownerId,
  SAME_ORIGIN, sessionCookie, signedIn, storedRows, type Instance,
} from "./r21-helpers";

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 23);
afterEach(() => vi.useRealTimers());

function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
}

async function sessionList(dw: Instance, cookie: string) {
  return dw.json("/api/v1/auth/sessions", { headers: { ...SAME_ORIGIN, Cookie: cookie } });
}

function thirtyDayCookie(response: Response) {
  const cookie = sessionCookie(response);
  const raw = issuedSessionCookies(response)[0]!;
  const maxAge = raw.match(/(?:^|;)\s*Max-Age=(\d+)(?:;|$)/i)?.[1];
  if (maxAge !== undefined) {
    expect(maxAge).toBe("2592000");
  } else {
    const expires = raw.match(/(?:^|;)\s*Expires=([^;]+)/i)?.[1];
    expect(expires, "a persistent session needs Max-Age or Expires").toBeTruthy();
    expect(Date.parse(expires!) - Date.now()).toBe(30 * DAY);
  }
  return cookie;
}

async function resourceRows() {
  return (await storedRows()).filter(({ table }) => ["sites", "versions", "api_keys", "members"].includes(table));
}

// Breaks caught: wrong idle TTL, >= vs > expiry, not persisting sliding renewal,
// or renewing D1 but leaving the browser cookie at its original expiration.
describe("R-21 thirty-day sliding session lifetime", () => {
  it("issues a cookie with a thirty-day browser lifetime", async () => {
    clock();
    const dw = await freshInstance();
    const active = await signedIn(dw);
    thirtyDayCookie(active.exchange);
  });

  it.each([
    { elapsed: 30 * DAY - 1, status: 200 },
    { elapsed: 30 * DAY, status: 401 },
    { elapsed: 30 * DAY + 1, status: 401 },
  ])("an idle session at +$elapsed ms returns $status", async ({ elapsed, status }) => {
    clock();
    const dw = await freshInstance();
    const active = await signedIn(dw);
    vi.setSystemTime(START + elapsed);
    expect((await sessionList(dw, active.cookie)).status).toBe(status);
  });

  it("activity renews both authority and cookie past the original thirty-day deadline", async () => {
    clock();
    const dw = await freshInstance();
    const active = await signedIn(dw);
    vi.setSystemTime(START + 29 * DAY);
    const refreshed = await sessionList(dw, active.cookie);
    expect(refreshed.status).toBe(200);
    const cookie = thirtyDayCookie(refreshed.res);
    vi.setSystemTime(START + 30 * DAY + 1);
    expect((await sessionList(dw, cookie)).status).toBe(200);
  });

  it.each([
    { elapsed: 59 * DAY - 1, status: 200 },
    { elapsed: 59 * DAY, status: 401 },
    { elapsed: 59 * DAY + 1, status: 401 },
  ])("a session renewed on day 29 at +$elapsed ms returns $status", async ({ elapsed, status }) => {
    clock();
    const dw = await freshInstance();
    const active = await signedIn(dw);
    vi.setSystemTime(START + 29 * DAY);
    const refreshed = await sessionList(dw, active.cookie);
    expect(refreshed.status).toBe(200);
    const cookie = sessionCookie(refreshed.res);
    // No intervening request: checking validity itself can slide the deadline.
    vi.setSystemTime(START + elapsed);
    expect((await sessionList(dw, cookie)).status).toBe(status);
  });
});

// Break caught: treating "no site restriction" as "all scopes", then using a
// read-only credential to acquire the member's full dashboard authority.
describe("R-21 scope subsets cannot mint full-role sessions", () => {
  it("rejects a sites:read-only key with no site restriction at the real link issuer", async () => {
    const dw = await freshInstance();
    await loginLink(dw);
    const created = await dw.json("/api/v1/keys", {
      key: dw.ownerKey, ...jsonBody({ name: "read-only-login", scopes: ["sites:read"] }),
    });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    expect((await dw.json("/api/v1/sites", { key })).status).toBe(200);
    const deniedWrite = await dw.json("/api/v1/sites", { key, ...jsonBody({ slug: "read-only-write" }) });
    expect(deniedWrite.status).toBe(403);
    const denied = await dw.json("/api/v1/login-links", { key, ...jsonBody({ memberId: await ownerId(dw) }) });
    expect(denied.status).toBe(403);
    expect(denied.body.url).toBeUndefined();
    expect(issuedSessionCookies(denied.res)).toEqual([]);
    expect((await signedIn(dw)).sessions).toHaveLength(1);
  });

  it("enforces the same read-only scope boundary through MCP create_login_link", async () => {
    const dw = await freshInstance();
    await loginLink(dw);
    const created = await dw.json("/api/v1/keys", {
      key: dw.ownerKey, ...jsonBody({ name: "read-only-mcp", scopes: ["sites:read"] }),
    });
    expect(created.status).toBe(201);
    const client = await connectMcp(dw, created.body.key, { path: "/mcp?toolsets=members" });
    try {
      const result = await client.call("create_login_link", { memberId: await ownerId(dw) });
      expect(result.isError).toBe(true);
      expect(result.data.error.code).toBe("insufficient_scope");
      expect(result.data.url).toBeUndefined();
    } finally { await client.client.close(); }
  });
});

const WRITES = [
  { name: "create site", path: "/api/v1/sites", method: "POST", body: { slug: "cookie-created" }, status: 201 },
  { name: "publish", path: "/api/v1/publish", method: "POST", body: { slug: "cookie-published", files: [{ path: "index.txt", content: "fixture" }] }, status: 201 },
  { name: "create API key", path: "/api/v1/keys", method: "POST", body: { name: "cookie-key", scopes: ["sites:read"] }, status: 201 },
  { name: "add member", path: "/api/v1/members", method: "POST", body: { email: "cookie-added@example.com", role: "member" }, status: 201 },
  { name: "update site", path: "/api/v1/sites/cookie-target", method: "PATCH", body: { title: "Cookie edit" }, status: 200 },
  { name: "delete site", path: "/api/v1/sites/cookie-target", method: "DELETE", body: undefined, status: 200 },
] as const;

// Break caught: widening dashboard sessions into ambient REST/MCP credentials.
// Valid Origin + Fetch Metadata rule out CSRF rejection as a false positive;
// identical bearer requests prove that each tested operation actually works.
describe("R-21 a genuine session is not ordinary REST or MCP authority", () => {
  it.each(WRITES)("does not authorize $name on the ordinary REST surface", async ({ path, method, body, status }) => {
    const dw = await freshInstance();
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "cookie-target" }) })).status).toBe(201);
    const active = await signedIn(dw);
    expect((await sessionList(dw, active.cookie)).status).toBe(200);
    const before = await resourceRows();
    const init = { method, body: body === undefined ? undefined : JSON.stringify(body) };
    const denied = await dw.call(path, {
      ...init, headers: { ...SAME_ORIGIN, Cookie: active.cookie, "Content-Type": "application/json" },
    });
    expect([401, 403]).toContain(denied.status);
    expect(await resourceRows()).toEqual(before);
    expect((await sessionList(dw, active.cookie)).status).toBe(200);
    const accepted = await dw.call(path, {
      ...init, key: dw.ownerKey, headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
    });
    expect(accepted.status).toBe(status);
    expect(await resourceRows()).not.toEqual(before);
  });

  it.each([
    { method: "tools/list", params: {} },
    { method: "tools/call", params: { name: "create_site", arguments: { slug: "cookie-mcp" } } },
  ])("MCP $method rejects a real browser session with a bearer challenge", async ({ method, params }) => {
    const dw = await freshInstance();
    const active = await signedIn(dw);
    expect((await sessionList(dw, active.cookie)).status).toBe(200);
    const before = await resourceRows();
    const response = await dw.json("/mcp", {
      ...jsonBody({ jsonrpc: "2.0", id: 1, method, params }),
      headers: { ...SAME_ORIGIN, Cookie: active.cookie, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    });
    expect(response.status).toBe(401);
    expect(response.res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(response.body.error.code).toBe("unauthorized");
    expect(await resourceRows()).toEqual(before);
    const client = await connectMcp(dw, dw.ownerKey);
    try {
      expect((await client.tools()).some((tool) => tool.name === "create_site")).toBe(true);
      expect((await client.call("create_site", { slug: "cookie-mcp" })).isError).toBe(false);
    } finally { await client.client.close(); }
  });
});

type Message = { to: string[]; subject: string; text: string; html?: string; kind: string };
async function emailFixture() {
  const messages: Message[] = [];
  const email = { async send(message: Message) {
    expect(messages.length, "bounded test delivery, never an external provider").toBeLessThan(2);
    messages.push(message);
    return { id: `hardening-delivery-${messages.length}` };
  } };
  const dw = await freshInstance({}, { adapters: { email } } as Parameters<typeof freshInstance>[1]);
  const request = () => dw.json("/api/v1/auth/email-code", {
    ...jsonBody({ email: "owner@example.com" }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
  });
  const verify = (code: string) => dw.call("/api/v1/auth/email-code/verify", {
    ...jsonBody({ email: "owner@example.com", code }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
  });
  const code = () => {
    expect(messages.length).toBeGreaterThan(0);
    const delivered = messages.at(-1)!;
    expect(delivered.to).toEqual(["owner@example.com"]);
    expect(delivered.kind).toBe("sign_in");
    const value = delivered.text.match(/\b\d{6}\b/)?.[0];
    expect(value, "code comes from the real issuer's EmailAdapter delivery").toBeTruthy();
    return value!;
  };
  const requested = await request();
  expect([200, 202], "the real email-code issuer must exist before exercising redemption").toContain(requested.status);
  expect(messages).toHaveLength(1);
  return { dw, messages, request, verify, code };
}

function wrongCode(code: string) {
  return code === "000000" ? "111111" : "000000";
}

function deniedCode(response: Response) {
  expect([400, 401, 403, 410, 429]).toContain(response.status);
  expect(issuedSessionCookies(response)).toEqual([]);
}

// Breaks caught: reusable codes, non-atomic redemption/attempt counting, and
// resetting an email's still-live guessing budget when a code is resent.
describe("R-21 email-code replay, races and resend budget", () => {
  it("redeems a delivered code once, without a second session on sequential replay", async () => {
    const f = await emailFixture();
    const code = f.code();
    const cookie = sessionCookie(await f.verify(code));
    deniedCode(await f.verify(code));
    const active = await sessionList(f.dw, cookie);
    expect(active.status).toBe(200);
    expect(active.body.sessions).toHaveLength(1);
  });

  it("atomically redeems one delivered code when two verifications race", async () => {
    const f = await emailFixture();
    const code = f.code();
    const responses = await Promise.all([f.verify(code), f.verify(code)]);
    const winners = responses.filter((response) => issuedSessionCookies(response).length > 0);
    expect(winners).toHaveLength(1);
    for (const response of responses.filter((response) => !issuedSessionCookies(response).length)) deniedCode(response);
    const cookie = sessionCookie(winners[0]!);
    const active = await sessionList(f.dw, cookie);
    expect(active.status).toBe(200);
    expect(active.body.sessions).toHaveLength(1);
  });

  it("accepts a correct fifth try but not two concurrent fifth-try redemptions", async () => {
    const f = await emailFixture();
    const code = f.code();
    for (let i = 0; i < 4; i++) deniedCode(await f.verify(wrongCode(code)));
    const responses = await Promise.all([f.verify(code), f.verify(code)]);
    const winners = responses.filter((response) => issuedSessionCookies(response).length > 0);
    expect(winners).toHaveLength(1);
    for (const response of responses.filter((response) => !issuedSessionCookies(response).length)) deniedCode(response);
    const active = await sessionList(f.dw, sessionCookie(winners[0]!));
    expect(active.status).toBe(200);
    expect(active.body.sessions).toHaveLength(1);
  });

  it("counts five simultaneous failures without lost increments allowing a sixth try", async () => {
    const f = await emailFixture();
    const code = f.code();
    const failures = await Promise.all(Array.from({ length: 5 }, () => f.verify(wrongCode(code))));
    for (const response of failures) deniedCode(response);
    deniedCode(await f.verify(code));
  });

  it("a resend after four failures leaves only one try in the original live budget", async () => {
    clock();
    const f = await emailFixture();
    const original = f.code();
    for (let i = 0; i < 4; i++) deniedCode(await f.verify(wrongCode(original)));
    vi.setSystemTime(START + 2 * MINUTE);
    expect([200, 202]).toContain((await f.request()).status);
    expect(f.messages).toHaveLength(2);
    const resent = f.code();
    deniedCode(await f.verify(wrongCode(resent)));
    deniedCode(await f.verify(resent));
  });

  it("positive control: a resent code can still succeed as the correct fifth try", async () => {
    clock();
    const f = await emailFixture();
    const original = f.code();
    for (let i = 0; i < 4; i++) deniedCode(await f.verify(wrongCode(original)));
    vi.setSystemTime(START + 2 * MINUTE);
    expect([200, 202]).toContain((await f.request()).status);
    expect(f.messages).toHaveLength(2);
    const cookie = sessionCookie(await f.verify(f.code()));
    const active = await sessionList(f.dw, cookie);
    expect(active.status).toBe(200);
    expect(active.body.sessions).toHaveLength(1);
  });

  it("a resend cannot unlock five failures before the original fifteen-minute window ends", async () => {
    clock();
    const f = await emailFixture();
    const original = f.code();
    for (let i = 0; i < 5; i++) deniedCode(await f.verify(wrongCode(original)));
    vi.setSystemTime(START + 2 * MINUTE);
    const resent = await f.request();
    expect([200, 202, 400, 403, 429]).toContain(resent.status);
    expect(issuedSessionCookies(resent.res)).toEqual([]);
    deniedCode(await f.verify(f.code()));
  });
});

// Break caught: consuming the token before checking the browser's existing
// member, or silently replacing one member's live session with another's.
describe("R-21 login-link account swap refusal", () => {
  it("refuses another member's link without consuming it or replacing the current session", async () => {
    const dw = await freshInstance();
    const other = await member(dw);
    const current = await signedIn(dw);
    const link = await loginLink(dw, other.id);
    const refused = await dw.call(link.url, { headers: { Cookie: current.cookie } });
    expect([403, 409]).toContain(refused.status);
    expect(issuedSessionCookies(refused)).toEqual([]);
    const unchanged = await sessionList(dw, current.cookie);
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.sessions.map((session: { id: string }) => session.id)).toEqual(current.sessions.map((session) => session.id));

    const exchanged = await dw.call(link.url);
    expect([302, 303]).toContain(exchanged.status);
    const otherCookie = sessionCookie(exchanged);
    expect(otherCookie).not.toBe(current.cookie);
    const otherSessions = await sessionList(dw, otherCookie);
    expect(otherSessions.status).toBe(200);
    expect(otherSessions.body.sessions).toHaveLength(1);
    expect(otherSessions.body.sessions[0].id).not.toBe(current.sessions[0]!.id);
    expect((await sessionList(dw, current.cookie)).status).toBe(200);
    expect(issuedSessionCookies(await dw.call(link.url))).toEqual([]);
  });

  it("positive control: an existing session does not prevent same-member reauthentication", async () => {
    const dw = await freshInstance();
    const current = await signedIn(dw);
    const link = await loginLink(dw);
    const exchanged = await dw.call(link.url, { headers: { Cookie: current.cookie } });
    expect([302, 303]).toContain(exchanged.status);
    expect((await sessionList(dw, sessionCookie(exchanged))).status).toBe(200);
  });
});
