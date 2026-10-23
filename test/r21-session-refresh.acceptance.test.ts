import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anonymousSite, callWithBindings, digest, env, freshInstance, issuedSessionCookies,
  MINUTE, ORIGIN, SAME_ORIGIN, sessionCookie, signedIn, storedRows, type Instance,
} from "./r21-helpers";

const REFRESH = "/api/v1/auth/sessions/refresh";
const START = Date.UTC(2026, 9, 23);
const DAY = 86_400_000;
const HOUR = 60 * MINUTE;
afterEach(() => vi.useRealTimers());

function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
}

async function rowFor(cookie: string) {
  const hash = await digest(cookie.slice(cookie.indexOf("=") + 1));
  const row = await env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(hash)
    .first<{ id: string; member_id: string; tenant_id: string; expires_at: number; last_seen_at: number | null; revoked_at: number | null }>();
  expect(row, "the real issuer, not a hand-inserted session, supplies the tested authority").toBeTruthy();
  return row!;
}

// Observe executed SQL while preserving real D1 statements/results. This detects
// writes before a guard even if they are rolled back or leave the same row values.
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

function refresh(dw: Instance, headers: Record<string, string>, cookie?: string, key?: string) {
  return dw.call(REFRESH, {
    method: "POST", // No JSON, form, CSRF token or bearer is needed for this cookie-only operation.
    ...(key ? { key } : {}), headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
  });
}

async function successful(response: Response) {
  expect(response.status, "a deliberate first-party POST refresh endpoint must exist").toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
  expect(response.headers.get("cache-control")).toMatch(/(?:^|[,\s])no-store(?:$|[,\s])/);
  expect(await response.json()).toEqual({ refreshed: true });
}

function refreshedCookie(response: Response, original: string) {
  expect(issuedSessionCookies(response)).toHaveLength(1);
  expect(sessionCookie(response), "renew the same browser session, not a new token").toBe(original);
  const raw = issuedSessionCookies(response)[0]!;
  expect(raw).toMatch(/;\s*HttpOnly(?:;|$)/i);
  expect(raw).toMatch(/;\s*SameSite=Lax(?:;|$)/i);
  // sessionCookie also verifies Secure, Path=/ and the absence of Domain.
  const maxAge = raw.match(/;\s*Max-Age=(\d+)(?:;|$)/i)?.[1];
  if (maxAge !== undefined) expect(maxAge).toBe("2592000");
  else {
    const expires = raw.match(/;\s*Expires=([^;]+)/i)?.[1];
    expect(expires, "browser expiration must move with D1").toBeTruthy();
    expect(Date.parse(expires!) - Date.now()).toBe(30 * DAY);
  }
}

async function refusedWithoutEffects(dw: Instance, headers: Record<string, string>, cookie?: string, key?: string) {
  const before = await storedRows();
  const observed = observedDB();
  const response = await callWithBindings(dw, REFRESH, { DB: observed.db }, {
    method: "POST", headers: {
      ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
  });
  expect.soft([401, 403], "404 is missing implementation, not proof that the guard works").toContain(response.status);
  expect.soft(observed.writes, "denial must happen before any D1 mutation").toEqual([]);
  expect.soft(await storedRows(), "denial must not slide, revive or create session state").toEqual(before);
  expect(issuedSessionCookies(response), "denial cannot extend browser lifetime").toEqual([]);
}

// Breaks caught: missing explicit activity path, D1-only/cookie-only renewal,
// accepting an empty-body parse error, and expiry/off-by-one/throttle mistakes.
describe("R-21 explicit first-party POST session refresh", () => {
  it("renews both real D1 authority and the actual cookie after one hour with an empty body", async () => {
    clock();
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    const before = await rowFor(active.cookie);
    expect(before.expires_at).toBe(START + 30 * DAY);
    vi.setSystemTime(START + 61 * MINUTE);
    const observed = observedDB();
    const response = await callWithBindings(dw, REFRESH, { DB: observed.db }, {
      method: "POST", headers: { ...SAME_ORIGIN, Cookie: active.cookie },
    });
    await successful(response);
    refreshedCookie(response, active.cookie);
    expect(observed.writes.length, "a no-op endpoint cannot pass the positive control").toBeGreaterThan(0);
    const after = await rowFor(active.cookie);
    expect(after.id).toBe(before.id);
    expect(after.member_id).toBe(before.member_id);
    expect(after.tenant_id).toBe(before.tenant_id);
    expect(after.expires_at).toBe(START + 61 * MINUTE + 30 * DAY);
    expect(after.last_seen_at).toBe(START + 61 * MINUTE);
  });

  it.each([0, HOUR - 1])("accepts deliberate activity at +%i ms without premature D1 or cookie renewal", async (elapsed) => {
    clock();
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    const before = await storedRows();
    vi.setSystemTime(START + elapsed);
    const observed = observedDB();
    const response = await callWithBindings(dw, REFRESH, { DB: observed.db }, {
      method: "POST", headers: { ...SAME_ORIGIN, Cookie: active.cookie },
    });
    await successful(response);
    expect(observed.writes).toEqual([]);
    expect(await storedRows()).toEqual(before);
    expect(issuedSessionCookies(response)).toEqual([]);
  });

  it("survives the old idle deadline and expires exactly thirty days after the explicit refresh", async () => {
    clock();
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    vi.setSystemTime(START + 29 * DAY);
    const response = await refresh(dw, SAME_ORIGIN, active.cookie);
    await successful(response);
    refreshedCookie(response, active.cookie);
    expect((await rowFor(active.cookie)).expires_at).toBe(START + 59 * DAY);
    vi.setSystemTime(START + 30 * DAY + 1);
    // Ordinary browser GET has no Origin: it checks validity without extending it.
    const before = await rowFor(active.cookie);
    const read = await dw.call("/api/v1/auth/sessions", { headers: { Cookie: active.cookie, "Sec-Fetch-Site": "same-origin" } });
    expect(read.status).toBe(200);
    expect(issuedSessionCookies(read)).toEqual([]);
    expect(await rowFor(active.cookie)).toEqual(before);
    vi.setSystemTime(START + 59 * DAY);
    await refusedWithoutEffects(dw, SAME_ORIGIN, active.cookie);
  });
});

const UNTRUSTED: Array<{ name: string; headers: Record<string, string> }> = [
  { name: "both absent", headers: {} },
  { name: "Origin absent independently", headers: { "Sec-Fetch-Site": "same-origin" } },
  ...[
    { name: "wrong Origin", origin: "https://attacker.example" },
    { name: "opaque Origin", origin: "null" },
    { name: "wrong scheme", origin: "http://dropway.test" },
    { name: "wrong port", origin: "https://dropway.test:444" },
    { name: "same-site sibling Origin", origin: "https://sites.dropway.test" },
    { name: "Origin suffix trick", origin: "https://dropway.test.attacker.example" },
  ].map(({ name, origin }) => ({ name: `${name} independently`, headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } })),
  { name: "Fetch Metadata absent independently", headers: { Origin: ORIGIN } },
  ...["same-site", "cross-site", "none", "invalid", "Same-Origin"].map((value) => ({
    name: `Fetch Metadata ${value} independently`, headers: { Origin: ORIGIN, "Sec-Fetch-Site": value },
  })),
];

// Break caught: OR instead of AND, host/suffix matching instead of exact origin,
// and identity resolution writing before the POST's browser trust guard.
describe("R-21 POST refresh browser trust boundary", () => {
  it.each(UNTRUSTED)("denies $name without D1 or refresh-cookie effects", async ({ headers }) => {
    clock();
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    vi.setSystemTime(START + 61 * MINUTE);
    await refusedWithoutEffects(dw, headers, active.cookie);
    // The same actual session remains eligible; refusal is not revocation.
    await successful(await refresh(dw, SAME_ORIGIN, active.cookie));
  });
});

// Break caught: treating metadata/bearers as identity, falling back to a key on
// a bad cookie, or reviving sessions whose database authority was invalidated.
describe("R-21 POST refresh requires current cookie authority", () => {
  it.each(["absent", "wrong", "API key in cookie"])("denies an %s session cookie even with a valid API-key bearer", async (kind) => {
    clock();
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    vi.setSystemTime(START + 61 * MINUTE);
    const cookie = kind === "absent" ? undefined : `__Host-dw_session=${kind === "wrong" ? "unknown-session" : dw.ownerKey}`;
    await refusedWithoutEffects(dw, SAME_ORIGIN, cookie, dw.ownerKey);
    expect((await rowFor(active.cookie)).expires_at).toBe(START + 30 * DAY);
  });

  it.each([undefined, "__Host-dw_session=unknown-session"])("denies missing or wrong cookie without any bearer (%s)", async (cookie) => {
    clock();
    const dw = await freshInstance({ appOrigin: ORIGIN });
    await signedIn(dw);
    vi.setSystemTime(START + 61 * MINUTE);
    await refusedWithoutEffects(dw, SAME_ORIGIN, cookie);
  });

  it.each([30 * DAY, 30 * DAY + 1])("does not revive an idle session at +%i ms", async (elapsed) => {
    clock();
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    vi.setSystemTime(START + elapsed);
    await refusedWithoutEffects(dw, SAME_ORIGIN, active.cookie);
  });

  it("does not revive a session revoked through the real session API", async () => {
    clock();
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    const row = await rowFor(active.cookie);
    const revoked = await dw.call(`/api/v1/auth/sessions/${row.id}`, {
      method: "DELETE", headers: { ...SAME_ORIGIN, Cookie: active.cookie },
    });
    expect([200, 204]).toContain(revoked.status);
    expect((await dw.call("/api/v1/auth/sessions", { headers: { Cookie: active.cookie } })).status).toBe(401);
    vi.setSystemTime(START + 61 * MINUTE);
    await refusedWithoutEffects(dw, SAME_ORIGIN, active.cookie);
  });

  it.each(["members", "tenants"] as const)("does not renew a real session after its %s authority is disabled", async (table) => {
    clock();
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    const row = await rowFor(active.cookie);
    // Fixture-only change in emulated D1; session issuance itself remains real.
    const id = table === "members" ? row.member_id : row.tenant_id;
    await env.DB.prepare(`UPDATE ${table} SET disabled_at = ? WHERE id = ?`).bind(START, id).run();
    vi.setSystemTime(START + 61 * MINUTE);
    await refusedWithoutEffects(dw, SAME_ORIGIN, active.cookie);
  });
});

// This is a served-artifact wiring assertion, NOT a real-browser execution claim.
// It catches omitting the first-party refresh path from actual session/claim pages.
// A browser smoke must still prove naturally generated Origin/Fetch Metadata.
describe("R-21 native first-party renewal script wiring", () => {
  it.each(["post-login page", "claim page"])("loads an explicit POST refresh script on the %s without exposing session tokens", async (page) => {
    const dw = await freshInstance({ appOrigin: ORIGIN, anonymous: { enabled: true } });
    const active = await signedIn(dw);
    let path = active.exchange.headers.get("location");
    if (page === "claim page") path = `/claim?slug=${(await anonymousSite(dw)).slug}`;
    expect(path, "use the real issuer's destination rather than inventing a session UI route").toBeTruthy();
    const response = await dw.call(path!, { headers: { Cookie: active.cookie, Accept: "text/html" } });
    expect(response.status).toBe(200);
    const sources: string[] = [];
    const inline: string[] = [];
    let executable = false;
    const html = await new HTMLRewriter().on("script", {
      element(element) {
        const src = element.getAttribute("src");
        const type = element.getAttribute("type");
        executable = !type || /^(?:module|(?:text|application)\/javascript)$/.test(type);
        if (src && executable) sources.push(src);
      },
      text(chunk) { if (executable) inline.push(chunk.text); },
    }).transform(response).text();
    const scripts = [...inline];
    for (const src of sources) {
      const url = new URL(src, ORIGIN);
      expect(url.origin, "renewal is wired through the native first-party script").toBe(ORIGIN);
      const script = await dw.call(url.href);
      expect(script.status).toBe(200);
      scripts.push(await script.text());
    }
    const renewal = scripts.filter((source) => source.includes(REFRESH));
    expect(renewal.length, "the actual page must load the deliberate refresh path, not just ship an unused endpoint").toBeGreaterThan(0);
    expect(renewal.some((source) => /method\s*:\s*["']POST["']/.test(source))).toBe(true);
    for (const text of [html, ...scripts]) {
      expect(text.includes(active.cookie.slice(active.cookie.indexOf("=") + 1))).toBe(false);
      expect(text.includes(dw.ownerKey)).toBe(false);
      expect(text.includes(active.link.token)).toBe(false);
    }
  });
});
