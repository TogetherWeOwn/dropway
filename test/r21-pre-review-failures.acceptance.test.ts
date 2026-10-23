import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callWithBindings, digest, env, freshInstance, issuedSessionCookies, jsonBody, loginLink, member, MINUTE,
  ORIGIN, pageForms, SAME_ORIGIN, sessionCookie, signedIn, storedRows, type Instance,
} from "./r21-helpers";

const EMAIL = "owner@example.com";
const NAVIGATION = { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const FORGED_BROWSER: Array<{ name: string; headers: Record<string, string> }> = [
  { name: "cross-site", headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" } },
  { name: "same-site sibling", headers: { Origin: "https://sites.dropway.test", "Sec-Fetch-Site": "same-site" } },
  { name: "opaque origin", headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } },
  { name: "missing Origin independently", headers: { "Sec-Fetch-Site": "same-origin" } },
  { name: "wrong Origin independently", headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "same-origin" } },
  { name: "missing metadata independently", headers: { Origin: ORIGIN } },
  { name: "wrong metadata independently", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" } },
  { name: "both absent", headers: {} },
];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

type Message = { to: string[]; subject: string; text: string; html?: string; kind: string };
async function emailInstance(failFirst = false) {
  const attempts: Message[] = [];
  const delivered: Message[] = [];
  const dw = await freshInstance({ appOrigin: ORIGIN }, { adapters: { email: {
    async send(message: Message) {
      expect(attempts.length, "never contact a production email provider").toBeLessThan(3);
      attempts.push(message);
      if (failFirst && attempts.length === 1) throw new Error("test email transport temporarily unavailable");
      delivered.push(message);
      return { id: `local-delivery-${delivered.length}` };
    },
  } } });
  return { dw, attempts, delivered };
}

function codeIn(message: Message) {
  expect(message.to).toEqual([EMAIL]);
  expect(message.kind).toBe("sign_in");
  const code = message.text.match(/\b\d{6}\b/)?.[0];
  expect(Boolean(code), "read only the real issuer's message at the external delivery boundary").toBe(true);
  return code!;
}

function requestCode(dw: Instance) {
  return dw.json("/api/v1/auth/email-code", {
    ...jsonBody({ email: EMAIL }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
  });
}

function verifyCode(dw: Instance, code: string, origin = ORIGIN) {
  return dw.call(`${origin}/api/v1/auth/email-code/verify`, {
    ...jsonBody({ email: EMAIL, code }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
  });
}

async function sessions() {
  return (await storedRows()).filter(({ table }) => table === "sessions");
}

async function rowFor(cookie: string) {
  const hash = await digest(cookie.slice(cookie.indexOf("=") + 1));
  const rows = (await storedRows()).filter(({ row }) => Object.values(row).includes(hash));
  expect(rows, "the actual issued session must have hashed state in real D1").toHaveLength(1);
  return rows[0]!;
}

async function expectLive(dw: Instance, cookie: string) {
  expect((await dw.call("/api/v1/auth/sessions", { headers: { ...SAME_ORIGIN, Cookie: cookie } })).status).toBe(200);
}

// Breaks caught: consuming a valid credential before checking transport/app origin.
// The subsequent secure exchange is essential: refusal alone does not prove no burn.
describe("R-21 rejected exchange must preserve the real credential", () => {
  it.each(["http://dropway.test", "https://not-the-app.example"])("preserves a login link after exchange on %s", async (origin) => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const link = await loginLink(dw);
    const rejected = await dw.call(link.url.replace(ORIGIN, origin));
    expect.soft(issuedSessionCookies(rejected)).toEqual([]);
    expect.soft(await sessions()).toEqual([]);
    const secure = await dw.call(link.url);
    const cookie = sessionCookie(secure);
    await expectLive(dw, cookie);
    expect(issuedSessionCookies(await dw.call(link.url))).toEqual([]);
  });

  it.each(["http://dropway.test", "https://not-the-app.example"])("preserves a delivered email code after exchange on %s", async (origin) => {
    const { dw, delivered } = await emailInstance();
    expect([200, 202]).toContain((await requestCode(dw)).status);
    expect(delivered).toHaveLength(1);
    const code = codeIn(delivered[0]!);
    const rejected = await verifyCode(dw, code, origin);
    expect.soft(issuedSessionCookies(rejected)).toEqual([]);
    expect.soft(await sessions()).toEqual([]);
    const cookie = sessionCookie(await verifyCode(dw, code));
    await expectLive(dw, cookie);
  });
});

// Breaks caught: reporting delivery success when send throws, persisting plaintext,
// or leaving an undelivered challenge that suppresses a deliberate resend for 15 min.
describe("R-21 transient delivery failure", () => {
  it("reports explicit failure without issuing a session or storing a plaintext code", async () => {
    const { dw, attempts, delivered } = await emailInstance(true);
    const failed = await requestCode(dw);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.status).toBeLessThan(600);
    expect(typeof failed.body.error?.code).toBe("string");
    expect(failed.body.error.code.length).toBeGreaterThan(0);
    expect(failed.body.error.hint).toBeTruthy();
    expect(issuedSessionCookies(failed.res)).toEqual([]);
    expect(await sessions()).toEqual([]);
    expect(attempts).toHaveLength(1);
    expect(delivered).toEqual([]);
    expect(JSON.stringify(await storedRows()).includes(codeIn(attempts[0]!)), "failed delivery cannot leave plaintext in D1").toBe(false);
  });

  it("lets a deliberate immediate retry deliver and redeem a new real challenge", async () => {
    const { dw, attempts, delivered } = await emailInstance(true);
    const failed = await requestCode(dw);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(issuedSessionCookies(failed.res)).toEqual([]);
    const retried = await requestCode(dw);
    expect.soft([200, 202]).toContain(retried.status);
    expect(attempts, "a failed send must not suppress a deliberate retry").toHaveLength(2);
    expect(delivered).toHaveLength(1);
    const code = codeIn(delivered[0]!);
    const serialized = JSON.stringify(await storedRows());
    for (const message of attempts) expect(serialized.includes(codeIn(message)), "only hashes may remain in D1").toBe(false);
    expect(JSON.stringify(retried.body).includes(code)).toBe(false);
    const cookie = sessionCookie(await verifyCode(dw, code));
    await expectLive(dw, cookie);
    expect(issuedSessionCookies(await verifyCode(dw, code))).toEqual([]);
  });
});

// Observe executions while delegating every statement to real emulated D1.
// Both prepare/run and batch/exec are covered; no storage or result is mocked.
function observedDB() {
  const writes: string[] = [];
  const statements = new WeakMap<D1PreparedStatement, { inner: D1PreparedStatement; sql: string }>();
  const record = (sql: string) => { if (/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)) writes.push(sql); };
  const wrap = (inner: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(inner, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { record(sql); return value.apply(target, args); };
    } });
    statements.set(proxy, { inner, sql });
    return proxy;
  };
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return (batch: D1PreparedStatement[]) => target.batch(batch.map((statement) => {
      const entry = statements.get(statement);
      if (entry) record(entry.sql);
      return entry?.inner ?? statement;
    }));
    if (property === "exec") return (sql: string) => { record(sql); return target.exec(sql); };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { db, writes };
}

// Break caught: identity resolution sliding D1 before the browser trust check.
// Observe writes AND persisted rows, not a refusal hiding an earlier write.
describe("R-21 sliding refresh has its own browser boundary", () => {
  it.each(FORGED_BROWSER)("does not slide a real session on GET with $name", async ({ headers }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    const before = await rowFor(active.cookie);
    vi.setSystemTime(Date.now() + 61 * MINUTE);
    const observed = observedDB();
    const response = await callWithBindings(dw, "/api/v1/auth/sessions", { DB: observed.db }, {
      headers: { ...headers, Cookie: active.cookie },
    });
    expect.soft([200, 403]).toContain(response.status);
    expect.soft(observed.writes, "hostile or incomplete metadata must not execute sliding D1 writes").toEqual([]);
    expect(await rowFor(active.cookie), "hostile or incomplete browser metadata must not slide D1 state").toEqual(before);
    expect(issuedSessionCookies(response)).toEqual([]);
    // Prove refusal did not revoke the session or replace a positive refresh test.
    await expectLive(dw, active.cookie);
  });

  it("positive control: an exact-app-Origin same-origin GET after one hour really slides D1", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    const before = await rowFor(active.cookie);
    vi.setSystemTime(Date.now() + 61 * MINUTE);
    const observed = observedDB();
    const response = await callWithBindings(dw, "/api/v1/auth/sessions", { DB: observed.db }, {
      headers: { ...SAME_ORIGIN, Cookie: active.cookie },
    });
    expect(response.status).toBe(200);
    expect(observed.writes.length, "the write observer must detect a real permitted refresh").toBeGreaterThan(0);
    expect(await rowFor(active.cookie), "a no-op implementation is not a secure refresh implementation").not.toEqual(before);
  });
});

// Break caught: logging request.url at the actual router error boundary exposes
// a reusable login token and other query secrets. Only D1 is fault-injected;
// the real issuer, service, router, error handling and log calls execute.
describe("R-21 token-bearing URL diagnostics", () => {
  it.each(["auth service", "site serving service"])("keeps query secrets out of logs when the real %s cannot read D1", async (boundary) => {
    const { dw } = await emailInstance();
    const link = await loginLink(dw);
    const url = new URL(boundary === "auth service" ? "/api/v1/auth/email-code" : "/s/log-diagnostics/", ORIGIN);
    url.searchParams.set("token", link.token);
    const marker = "local-query-secret-never-log";
    url.searchParams.set("extra_secret", marker);
    const logs: unknown[][] = [];
    for (const method of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); });
    }
    const brokenDB = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return () => { throw new Error("local auth storage failure"); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await callWithBindings(dw, url.href, { DB: brokenDB }, boundary === "auth service" ? {
      ...jsonBody({ email: EMAIL }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
    } : {});
    expect(response.status).toBe(500);
    expect(issuedSessionCookies(response)).toEqual([]);
    const diagnostic = logs.flat().map((value) => value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ""}` : typeof value === "string" ? value : JSON.stringify(value)).join("\n");
    expect(diagnostic.includes("local auth storage failure"), "the real router logged the controlled failure").toBe(true);
    expect.soft(diagnostic.includes(link.token), "a real login token must never enter logs").toBe(false);
    expect.soft(diagnostic.includes(marker), "unrecognized secret query parameters must also be redacted").toBe(false);
    expect.soft(diagnostic.includes(url.search), "the complete secret-bearing query must not be logged").toBe(false);
    // The fault did not manufacture or replace an authentication service.
    sessionCookie(await dw.call(link.url));
  });
});

async function confirmation(dw: Instance, url: string, fetchSite = "cross-site") {
  const page = await dw.call(url, { headers: { ...NAVIGATION, "Sec-Fetch-Site": fetchSite } });
  expect(page.status, "browser navigation must show deliberate identity confirmation, not silently sign in").toBe(200);
  expect(issuedSessionCookies(page)).toEqual([]);
  expect(page.headers.get("Content-Type")).toMatch(/text\/html/i);
  expect(page.headers.get("Cache-Control")).toMatch(/(?:^|[,\s])no-store(?:$|[,\s])/i);
  expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
  let visibleText = "";
  await new HTMLRewriter().on("body", { text(chunk) { visibleText += chunk.text; } }).transform(page.clone()).text();
  const form = (await pageForms(page)).find((entry) => entry.method.toLowerCase() === "post");
  expect(form, "the actual confirmation page must offer a native POST, without a fake route").toBeTruthy();
  const target = new URL(form!.action || url, ORIGIN);
  expect(target.origin).toBe(ORIGIN);
  return { visibleText, submit: (headers: Record<string, string>) => dw.call(target.href, {
    method: "POST", headers: { ...NAVIGATION, ...headers }, body: new URLSearchParams(form!.fields),
  }) };
}

// Proposed compatible security contract: Fetch Metadata identifies a document
// navigation; header-less/programmatic exchange retains the protected issuer
// tests' contract. This corpus does not rewrite those tests or authorize release.
describe("R-21 signed-out browser login CSRF confirmation", () => {
  it.each(["cross-site", "none", "same-origin"])("shows the member before consuming a %s document navigation", async (fetchSite) => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const attacker = await member(dw, "attacker-member@example.com");
    const link = await loginLink(dw, attacker.id, attacker.key);
    const first = await confirmation(dw, link.url, fetchSite);
    expect(first.visibleText).toContain(attacker.email);
    expect(await sessions()).toEqual([]);
    // Merely rendering/refreshing the page has not spent the one-use link.
    const refreshed = await confirmation(dw, link.url, fetchSite);
    expect(refreshed.visibleText).toContain(attacker.email);
    const issued = await refreshed.submit(SAME_ORIGIN);
    expect([302, 303]).toContain(issued.status);
    const cookie = sessionCookie(issued);
    expect(Object.values((await rowFor(cookie)).row)).toContain(attacker.id);
    await expectLive(dw, cookie);
    expect(issuedSessionCookies(await refreshed.submit(SAME_ORIGIN))).toEqual([]);
    expect(issuedSessionCookies(await dw.call(link.url))).toEqual([]);
    expect(await sessions()).toHaveLength(1);
  });

  it.each(FORGED_BROWSER)("refuses $name confirmation without consuming the link", async ({ headers }) => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const attacker = await member(dw, "attacker-member@example.com");
    const link = await loginLink(dw, attacker.id, attacker.key);
    const page = await confirmation(dw, link.url);
    const rejected = await page.submit(headers);
    expect(rejected.status).toBe(403);
    expect(issuedSessionCookies(rejected)).toEqual([]);
    expect(await sessions()).toEqual([]);
    const cookie = sessionCookie(await page.submit(SAME_ORIGIN));
    expect(Object.values((await rowFor(cookie)).row)).toContain(attacker.id);
    await expectLive(dw, cookie);
  });
});

// Break caught: rejecting a real human's pasted code solely for outer whitespace.
// No manufactured code, session, browser headers-as-identity, or email bypass.
describe("R-21 pasted email-code input", () => {
  it.each(["json", "native form"])("redeems a delivered six-digit code with surrounding whitespace via %s", async (transport) => {
    const { dw, delivered } = await emailInstance();
    expect([200, 202]).toContain((await requestCode(dw)).status);
    expect(delivered).toHaveLength(1);
    const code = codeIn(delivered[0]!);
    const pasted = ` \t${code}\r\n `;
    const response = transport === "json" ? await verifyCode(dw, pasted) : await dw.call("/api/v1/auth/email-code/verify", {
      method: "POST", headers: SAME_ORIGIN, body: new URLSearchParams({ email: EMAIL, code: pasted }),
    });
    expect([200, 303]).toContain(response.status);
    const cookie = sessionCookie(response);
    await expectLive(dw, cookie);
    expect(issuedSessionCookies(await verifyCode(dw, code))).toEqual([]);
  });
});
