import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeLoginLink, resolveSession, runCleanup, sha256Hex, verifyEmailCode,
  type DropwayContext,
} from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

// Independent acceptance baseline: acf957ba6efbd8a0e0afdc89fc1be6938faed140.
// Retry windows reconciled to e13c231fe9cff7f820ac46fae4e6f25451bd109d;
// the old baseline intentionally lacks those resend/delivery corrections.
// Only expired rows are eligible; used/revoked/exhausted is NOT an early-delete rule.
// The additive public report contract proposed here follows expiredSites naming:
// expiredSessions, expiredLoginLinks, expiredEmailCodes, authBacklog (booleans).
// No private cleanup helper or index name is prescribed.
const NOW = 1_850_000_000_000;
const MINUTE = 60_000;
const BROWSER = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
const TABLES = [
  { table: "sessions", pk: "id_hash" },
  { table: "login_links", pk: "token_hash" },
  { table: "email_codes", pk: "id" },
] as const;
type AuthTable = typeof TABLES[number];
type CapturedStatement = { sql: string; values: unknown[] };

let app: Instance;
let dc: DropwayContext;
let memberId: string;
let tenantId: string;
let mail: Array<{ to: string[]; subject: string; text: string }>;
let failDelivery: boolean;

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mail = [];
  failDelivery = false;
  app = await freshInstance({ appOrigin: ORIGIN }, {
    adapters: { email: { async send(message) {
      if (failDelivery) throw new Error("local mail delivery failure");
      mail.push(message);
      return { id: "local-mail" };
    } } },
  });
  dc = app.dropway.context(env as unknown as ServerBindings, createExecutionContext(), new URL(ORIGIN));
  const me = await app.json("/api/v1/me", { key: app.ownerKey });
  expect(me.status, "real setup and migrations must succeed before any retention assertion").toBe(200);
  memberId = me.body.member.id;
  // Obtain the persisted FK independently of the response's presentation shape.
  tenantId = (await env.DB.prepare("SELECT tenant_id FROM members WHERE id = ?")
    .bind(memberId).first<{ tenant_id: string }>())!.tenant_id;
});

afterEach(() => { vi.restoreAllMocks(); });

async function seed(t: AuthTable, id: string, expiresAt: number, state: "live" | "spent" = "live", purpose = "sign_in") {
  if (t.table === "sessions") {
    await env.DB.prepare("INSERT INTO sessions (id_hash,id,tenant_id,member_id,via,created_at,expires_at,last_seen_at,ip_hash,user_agent,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, `ses-${id}`, tenantId, memberId, "login_link", NOW - 40 * 24 * 60 * MINUTE, expiresAt,
        NOW - MINUTE, "private-ip-hash", "private-device", state === "spent" ? NOW - MINUTE : null).run();
  } else if (t.table === "login_links") {
    await env.DB.prepare("INSERT INTO login_links (token_hash,member_id,created_by,created_at,expires_at,used_at) VALUES (?,?,?,?,?,?)")
      .bind(id, memberId, memberId, NOW - 60 * MINUTE, expiresAt, state === "spent" ? NOW - MINUTE : null).run();
  } else {
    await env.DB.prepare("INSERT INTO email_codes (id,purpose,email,site_id,code_hash,attempts,created_at,expires_at,used_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, purpose, "private-retention@example.com", purpose === "site_access" ? "private-site" : null,
        "private-proof-hash", state === "spent" ? 5 : 0, NOW - 60 * MINUTE, expiresAt,
        state === "spent" ? NOW - MINUTE : null).run();
  }
}

async function rows(t: AuthTable) {
  return (await env.DB.prepare(`SELECT * FROM ${t.table} ORDER BY ${t.pk}`).all<Record<string, unknown>>()).results;
}
async function ids(t: AuthTable) { return (await rows(t)).map((r) => r[t.pk]); }
async function count(table: string) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

// Interpose only at the real D1 boundary: every successful statement still runs
// against workerd's actual SQLite database, including bind/first/all/run/batch.
function observedDb(onExecute: (query: CapturedStatement) => void | Promise<void>): D1Database {
  const wrapped = new WeakMap<D1PreparedStatement, { statement: D1PreparedStatement; query: CapturedStatement }>();
  function wrap(statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql, args);
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (["run", "all", "first", "raw"].includes(String(property))) return async (...args: unknown[]) => {
        await onExecute({ sql, values });
        return value.apply(target, args);
      };
      return value.bind(target);
    } });
    wrapped.set(proxy, { statement, query: { sql, values } });
    return proxy;
  }
  return new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      for (const statement of statements) {
        const entry = wrapped.get(statement);
        if (entry) await onExecute(entry.query);
      }
      return target.batch(statements.map((statement) => wrapped.get(statement)?.statement ?? statement));
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
function contextWith(db: D1Database): DropwayContext { return { ...dc, env: { ...dc.env, DB: db } }; }
function deletionOf(sql: string, table: string) {
  return new RegExp(`\\bDELETE\\s+FROM\\s+["\x60\\[]?${table}\\b`, "i").test(sql);
}

async function requestCode(expectedStatus = 202) {
  const response = await app.json("/api/v1/auth/email-code", {
    ...jsonBody({ email: "owner@example.com" }), headers: { ...BROWSER, "Content-Type": "application/json" },
  });
  expect(response.status).toBe(expectedStatus);
  return response;
}
function deliveredCode() {
  const code = mail.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
  expect(code, "capture a real code through the local mail adapter, never a fabricated proof").toBeTruthy();
  return code!;
}
async function verifyCode(code: string) {
  return app.call("/api/v1/auth/email-code/verify", {
    ...jsonBody({ email: "owner@example.com", code }), headers: { ...BROWSER, "Content-Type": "application/json" },
  });
}
function issuedCookies(res: Response) {
  return res.headers.getSetCookie().filter((c) => /^__Host-dw_session=[^;]/.test(c) && !/Max-Age=0(?:;|$)/i.test(c));
}
async function realLink() {
  const result = await app.json("/api/v1/login-links", { key: app.ownerKey, ...jsonBody({ memberId }) });
  expect(result.status).toBe(201);
  const token = new URL(result.body.url).searchParams.get("token")!;
  expect(token).toMatch(/^dwl_/);
  return { token, hash: await sha256Hex(token) };
}
async function redeemLink(token: string) {
  // The corrected browser UI confirms links before consumption. Exercise the
  // real core exchange, not the retired GET side effect or a fabricated session.
  const result = await consumeLoginLink(dc, token, new Request(`${ORIGIN}/login`, { method: "POST", headers: BROWSER }));
  expect(result.cookie).toMatch(/^__Host-dw_session=dws_[A-Za-z0-9_-]{43};/);
  return result.cookie.split(";", 1)[0]!;
}
async function realSession() {
  const link = await realLink();
  const cookie = await redeemLink(link.token);
  return { cookie, hash: await sha256Hex(cookie.slice(cookie.indexOf("=") + 1)) };
}

// Breaks caught: strict < instead of <=, a retention grace period, wall-clock
// instead of cleanupNow, or unconditional/creation-age/spent-row deletion.
describe.each(TABLES)("$table expiry boundary", (t) => {
  it("deletes at exact expiry and just after, but not one millisecond before", async () => {
    await seed(t, "expired", NOW - 1);
    await seed(t, "exact", NOW);
    await seed(t, "future", NOW + 1);
    await runCleanup(dc, NOW);
    expect(await ids(t)).toEqual(["future"]);
  });

  it("obeys the supplied cleanup clock rather than Date.now", async () => {
    await seed(t, "past-wall-clock", NOW - 1);
    await runCleanup(dc, NOW - 2);
    expect(await ids(t)).toEqual(["past-wall-clock"]);
    await runCleanup(dc, NOW - 1);
    expect(await ids(t)).toEqual([]);
  });

  it("retains old-created but unexpired spent rows byte-for-byte", async () => {
    await seed(t, "spent-live", NOW + 1, "spent");
    await seed(t, "active-live", NOW + 1);
    const before = await rows(t);
    await runCleanup(dc, NOW);
    expect(await rows(t)).toEqual(before);
  });

  it("deletes expired spent metadata as well as expired unused metadata", async () => {
    await seed(t, "spent-expired", NOW, "spent");
    await seed(t, "unused-expired", NOW);
    await runCleanup(dc, NOW);
    expect(await rows(t)).toEqual([]);
  });

  it("caps each invocation at 200, orders by expiry then primary key, and converges", async () => {
    // Insertion reverses the tie-break; primary-key-only order is also wrong:
    // old-200..404 expire FIRST, old-000..199 one millisecond later.
    for (let i = 404; i >= 0; i--) {
      await seed(t, `old-${String(i).padStart(3, "0")}`, NOW - (i >= 200 ? 2 : 1));
    }
    await seed(t, "live-sentinel", NOW + 1);
    await runCleanup(dc, NOW);
    let remaining = await ids(t);
    expect(remaining).toHaveLength(206);
    expect(remaining).toEqual([
      "live-sentinel",
      ...Array.from({ length: 200 }, (_, i) => `old-${String(i).padStart(3, "0")}`),
      "old-400", "old-401", "old-402", "old-403", "old-404",
    ]);
    await runCleanup(dc, NOW);
    remaining = await ids(t);
    expect(remaining).toEqual(["live-sentinel", "old-195", "old-196", "old-197", "old-198", "old-199"]);
    await runCleanup(dc, NOW);
    expect(await ids(t)).toEqual(["live-sentinel"]);
    const before = await rows(t);
    await runCleanup(dc, NOW);
    expect(await rows(t)).toEqual(before);
  });

  it("rechecks eligibility in the deletion statement if a selected row was renewed", async () => {
    await seed(t, "renew-before-delete", NOW - 1);
    await seed(t, "still-expired", NOW - 1);
    let interposed = false;
    const db = observedDb(async ({ sql }) => {
      if (!interposed && deletionOf(sql, t.table)) {
        interposed = true;
        await env.DB.prepare(`UPDATE ${t.table} SET expires_at = ? WHERE ${t.pk} = ?`)
          .bind(NOW + 1, "renew-before-delete").run();
      }
    });
    await runCleanup(contextWith(db), NOW);
    expect(await ids(t)).toEqual(["renew-before-delete"]);
    expect(interposed, "an actual auth deletion was exercised, not a no-op cleanup").toBe(true);
  });

  it("propagates an auth-table D1 failure rather than returning a successful report", async () => {
    await seed(t, "failure-row", NOW);
    // Real SQLite abort, not a mocked return or a missing-table/startup error.
    await env.DB.prepare(`CREATE TRIGGER retention_failure BEFORE DELETE ON ${t.table}
      BEGIN SELECT RAISE(ABORT, 'local auth retention DB failure'); END`).run();
    await expect(runCleanup(dc, NOW)).rejects.toThrow("local auth retention DB failure");
    expect(await ids(t)).toEqual(["failure-row"]);
  });

  it("has an expiry+primary-key index and an indexed actual deletion candidate plan", async () => {
    const indexes = await env.DB.prepare(`PRAGMA index_list('${t.table}')`).all<{ name: string }>();
    const covering: string[] = [];
    for (const index of indexes.results) {
      const columns = await env.DB.prepare(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`)
        .all<{ name: string; seqno: number }>();
      if (columns.results[0]?.name === "expires_at" && columns.results[1]?.name === t.pk) covering.push(index.name);
    }
    expect(covering.length, "a new migration must supply (expires_at, primary_key), without prescribing its name").toBeGreaterThan(0);
    await seed(t, "plan-expired", NOW);
    const deletions: CapturedStatement[] = [];
    await runCleanup(contextWith(observedDb((query) => { if (deletionOf(query.sql, t.table)) deletions.push(query); })), NOW);
    expect(deletions, "one bounded conditional auth DELETE per table").toHaveLength(1);
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${deletions[0]!.sql}`).bind(...deletions[0]!.values)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(covering.some((name) => details.includes(name)), details).toBe(true);
    expect(details, "expiry/PK order must not need an unbounded sorting temp tree").not.toMatch(/USE TEMP B-TREE FOR ORDER BY/i);
  });
});

it("applies retention indexes through an additive migration after the auth schema", async () => {
  const names = env.TEST_MIGRATIONS.map((migration) => migration.name);
  expect(names).toContain("0004_sessions.sql");
  expect(names.some((name) => /^\d+_.*\.sql$/.test(name) && Number(name.split("_", 1)[0]) > 4),
    "0004 is an applied migration; do not edit it to add retention indexes").toBe(true);
});

it("limits all three tables independently in one invocation and reports true backlog until drained", async () => {
  for (const t of TABLES) for (let i = 0; i < 201; i++) await seed(t, `batch-${i}`, NOW);
  const first = await runCleanup(dc, NOW);
  expect(first).toMatchObject({
    expiredSessions: 200, expiredLoginLinks: 200, expiredEmailCodes: 200,
    authBacklog: { sessions: true, loginLinks: true, emailCodes: true },
  });
  for (const t of TABLES) expect(await count(t.table)).toBe(1);
  const second = await runCleanup(dc, NOW);
  expect(second).toMatchObject({
    expiredSessions: 1, expiredLoginLinks: 1, expiredEmailCodes: 1,
    authBacklog: { sessions: false, loginLinks: false, emailCodes: false },
  });
  expect(await runCleanup(dc, NOW)).toMatchObject({
    expiredSessions: 0, expiredLoginLinks: 0, expiredEmailCodes: 0,
    authBacklog: { sessions: false, loginLinks: false, emailCodes: false },
  });
});

it("does not report backlog just because the exactly-full batch was the last batch", async () => {
  for (let i = 0; i < 200; i++) await seed(TABLES[2], `full-${i}`, NOW);
  expect(await runCleanup(dc, NOW)).toMatchObject({
    expiredEmailCodes: 200, authBacklog: { emailCodes: false },
  });
  expect(await count("email_codes")).toBe(0);
});

it("handles both email-code purposes by expiry without crossing live purpose windows", async () => {
  for (const purpose of ["sign_in", "site_access"]) {
    await seed(TABLES[2], `${purpose}-expired`, NOW, "spent", purpose);
    await seed(TABLES[2], `${purpose}-live`, NOW + 1, "spent", purpose);
  }
  await runCleanup(dc, NOW);
  expect(await ids(TABLES[2])).toEqual(["sign_in-live", "site_access-live"]);
});

// These security controls must remain GREEN with a retention implementation.
// Real request/verify services, issued proofs, attempt writes and D1 are used.
it("preserves four failed attempts through cleanup, allows only the fifth, and blocks resend/replay", async () => {
  await requestCode();
  expect(mail).toHaveLength(1);
  const correct = deliveredCode();
  const wrong = correct === "000000" ? "000001" : "000000";
  for (let i = 0; i < 4; i++) {
    const rejected = await verifyCode(wrong);
    expect(rejected.status).toBe(401);
    expect(issuedCookies(rejected)).toEqual([]);
  }
  const before = await rows(TABLES[2]);
  await runCleanup(dc, NOW);
  expect(await rows(TABLES[2])).toEqual(before);
  await requestCode();
  expect(mail).toHaveLength(1);
  const success = await verifyCode(correct);
  expect(success.status).toBe(200);
  expect(issuedCookies(success)).toHaveLength(1);
  expect((await rows(TABLES[2]))[0]!.attempts).toBe(5);
  const used = await rows(TABLES[2]);
  await runCleanup(dc, NOW);
  expect(await rows(TABLES[2])).toEqual(used);
  await requestCode();
  expect(mail).toHaveLength(1);
  const replay = await verifyCode(correct);
  expect(replay.status).toBe(401);
  expect(issuedCookies(replay)).toEqual([]);
  expect(await count("sessions")).toBe(1);
});

// Corrected-source contract: resends rotate an eligible proof after 60 seconds,
// not after its full 15-minute expiry. Cleanup must preserve BOTH windows.
it("preserves the 60-second resend cooldown, original expiry and attempts across cleanup and proof rotation", async () => {
  // Stabilize only six-digit entropy so a coincidental identical redraw cannot
  // turn the stale-code assertion flaky. IDs/secrets, HMAC and all DB work stay real.
  const generate = crypto.getRandomValues.bind(crypto);
  let draw = 123450;
  vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends Parameters<typeof crypto.getRandomValues>[0]>(array: T): T => {
    if (array instanceof Uint32Array && array.length === 1) { array[0] = draw++; return array; }
    return generate(array) as T;
  });
  await requestCode();
  const initial = deliveredCode();
  const wrong = initial === "000000" ? "000001" : "000000";
  for (let i = 0; i < 2; i++) expect((await verifyCode(wrong)).status).toBe(401);
  const before = (await rows(TABLES[2]))[0]!;
  expect(before.attempts).toBe(2);
  expect(before.expires_at).toBe(NOW + 15 * MINUTE);
  vi.mocked(Date.now).mockReturnValue(NOW + MINUTE - 1);
  await runCleanup(dc, NOW + MINUTE - 1);
  await requestCode();
  expect(mail).toHaveLength(1);
  expect(await rows(TABLES[2])).toEqual([before]);
  vi.mocked(Date.now).mockReturnValue(NOW + MINUTE);
  await runCleanup(dc, NOW + MINUTE);
  await requestCode();
  expect(mail).toHaveLength(2);
  const rotated = deliveredCode();
  expect(rotated).not.toBe(initial);
  const after = (await rows(TABLES[2]))[0]!;
  expect(after).toMatchObject({ id: before.id, attempts: 2, expires_at: NOW + 15 * MINUTE, created_at: NOW + MINUTE, used_at: null });
  expect(after.code_hash).not.toBe(before.code_hash);
  expect((await verifyCode(initial)).status).toBe(401);
  expect((await rows(TABLES[2]))[0]!.attempts).toBe(3);
  const success = await verifyCode(rotated);
  expect(success.status).toBe(200);
  expect(issuedCookies(success)).toHaveLength(1);
  expect((await rows(TABLES[2]))[0]!.attempts).toBe(4);
  vi.mocked(Date.now).mockReturnValue(NOW + 2 * MINUTE);
  const used = await rows(TABLES[2]);
  await runCleanup(dc, NOW + 2 * MINUTE);
  await requestCode();
  expect(mail).toHaveLength(2);
  expect(await rows(TABLES[2])).toEqual(used);
});

it("preserves failed-delivery immediate retry without reopening or extending the challenge across cleanup", async () => {
  failDelivery = true;
  await requestCode(503);
  expect(mail).toHaveLength(0);
  const failed = (await rows(TABLES[2]))[0]!;
  expect(failed).toMatchObject({ used_at: null, attempts: 0, expires_at: NOW + 15 * MINUTE });
  vi.mocked(Date.now).mockReturnValue(NOW + 1);
  await runCleanup(dc, NOW + 1);
  expect(await rows(TABLES[2])).toEqual([failed]);
  failDelivery = false;
  await requestCode();
  expect(mail).toHaveLength(1);
  expect((await rows(TABLES[2]))[0]).toMatchObject({ id: failed.id, attempts: 0, expires_at: NOW + 15 * MINUTE, used_at: null });
  const success = await verifyCode(deliveredCode());
  expect(success.status).toBe(200);
  expect(issuedCookies(success)).toHaveLength(1);
  expect(await count("sessions")).toBe(1);
});

it("does not erase an exhausted resend budget until its own exact expiry", async () => {
  await requestCode();
  const correct = deliveredCode();
  const wrong = correct === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) expect((await verifyCode(wrong)).status).toBe(401);
  const before = await rows(TABLES[2]);
  await runCleanup(dc, NOW + 15 * MINUTE - 1);
  expect(await rows(TABLES[2])).toEqual(before);
  vi.mocked(Date.now).mockReturnValue(NOW + 15 * MINUTE - 1);
  await requestCode();
  expect(mail).toHaveLength(1);
  const exhausted = await verifyCode(correct);
  expect(exhausted.status).toBe(401);
  expect(issuedCookies(exhausted)).toEqual([]);
  expect(await count("sessions")).toBe(0);
  vi.mocked(Date.now).mockReturnValue(NOW + 15 * MINUTE);
  await runCleanup(dc, NOW + 15 * MINUTE);
  expect(await rows(TABLES[2])).toEqual([]);
  await requestCode();
  expect(mail).toHaveLength(2);
  expect(await count("email_codes")).toBe(1);
});

it.each([-1, 0])("an expired real login proof cannot mint authority before or after cleanup (expiry offset %i)", async (offset) => {
  const link = await realLink();
  await env.DB.prepare("UPDATE login_links SET expires_at = ? WHERE token_hash = ?").bind(NOW + offset, link.hash).run();
  const request = new Request(`${ORIGIN}/login`, { headers: BROWSER });
  await expect(consumeLoginLink(dc, link.token, request)).rejects.toMatchObject({ code: "invalid_login_link" });
  await runCleanup(dc, NOW);
  await expect(consumeLoginLink(dc, link.token, request)).rejects.toMatchObject({ code: "invalid_login_link" });
  expect(await count("sessions")).toBe(0);
});

it.each([-1, 0])("an expired real email proof cannot mint authority before or after cleanup (expiry offset %i)", async (offset) => {
  await requestCode();
  const code = deliveredCode();
  await env.DB.prepare("UPDATE email_codes SET expires_at = ?").bind(NOW + offset).run();
  const request = new Request(`${ORIGIN}/api/v1/auth/email-code/verify`, { method: "POST", headers: BROWSER });
  await expect(verifyEmailCode(dc, { email: "owner@example.com", code }, request)).rejects.toMatchObject({ code: "invalid_email_code" });
  await runCleanup(dc, NOW);
  await expect(verifyEmailCode(dc, { email: "owner@example.com", code }, request)).rejects.toMatchObject({ code: "invalid_email_code" });
  expect(await count("sessions")).toBe(0);
});

it.each([-1, 0])("an expired real session cannot resolve before or after cleanup (expiry offset %i)", async (offset) => {
  const session = await realSession();
  await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").bind(NOW + offset, session.hash).run();
  const request = new Request(`${ORIGIN}/api/v1/auth/sessions`, { headers: { ...BROWSER, Cookie: session.cookie } });
  await expect(resolveSession(dc, request)).rejects.toMatchObject({ code: "invalid_session" });
  await runCleanup(dc, NOW);
  await expect(resolveSession(dc, request)).rejects.toMatchObject({ code: "invalid_session" });
});

it("keeps an unexpired real login proof usable and its used row present until expiry", async () => {
  const link = await realLink();
  await env.DB.prepare("UPDATE login_links SET expires_at = ? WHERE token_hash = ?").bind(NOW + 1, link.hash).run();
  await runCleanup(dc, NOW);
  await redeemLink(link.token);
  const used = await rows(TABLES[1]);
  expect(used).toHaveLength(1);
  expect(used[0]!.used_at).not.toBeNull();
  await runCleanup(dc, NOW);
  expect(await rows(TABLES[1])).toEqual(used);
  await expect(consumeLoginLink(dc, link.token, new Request(`${ORIGIN}/login`, { headers: BROWSER })))
    .rejects.toMatchObject({ code: "invalid_login_link" });
  expect(await count("sessions")).toBe(1);
});

it("keeps an unexpired real email proof usable after cleanup", async () => {
  await requestCode();
  const code = deliveredCode();
  await env.DB.prepare("UPDATE email_codes SET expires_at = ?").bind(NOW + 1).run();
  await runCleanup(dc, NOW);
  const success = await verifyCode(code);
  expect(success.status).toBe(200);
  expect(issuedCookies(success)).toHaveLength(1);
  expect(await count("sessions")).toBe(1);
});

it("retains an unexpired revoked real session but never restores its authority", async () => {
  const session = await realSession();
  const current = await env.DB.prepare("SELECT id FROM sessions WHERE id_hash = ?")
    .bind(session.hash).first<{ id: string }>();
  const revoke = await app.call(`/api/v1/auth/sessions/${current!.id}`, {
    method: "DELETE", headers: { ...BROWSER, Cookie: session.cookie },
  });
  expect(revoke.status).toBe(200);
  const revoked = await rows(TABLES[0]);
  expect(revoked[0]!.revoked_at).not.toBeNull();
  await runCleanup(dc, NOW);
  expect(await rows(TABLES[0])).toEqual(revoked);
  await expect(resolveSession(dc, new Request(`${ORIGIN}/api/v1/auth/sessions`, {
    headers: { ...BROWSER, Cookie: session.cookie },
  }))).rejects.toMatchObject({ code: "invalid_session" });
});

it("retains a genuinely renewed session past its previous expiry without touching member last_seen_at", async () => {
  const session = await realSession();
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?")
    .bind(NOW - 60 * MINUTE, NOW + 1, session.hash).run();
  const response = await app.json("/api/v1/auth/sessions", { headers: { ...BROWSER, Cookie: session.cookie } });
  expect(response.status).toBe(200);
  const renewed = await env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(session.hash).first();
  expect(renewed!.expires_at).toBe(NOW + 30 * 24 * 60 * MINUTE);
  await runCleanup(dc, NOW + 1);
  expect(await env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(session.hash).first()).toEqual(renewed);
  const member = await env.DB.prepare("SELECT last_seen_at FROM members WHERE id = ?").bind(memberId).first();
  expect(member!.last_seen_at).toBeNull();
});

it("removes expired auth metadata only; all unrelated rows and members remain unchanged", async () => {
  const published = await app.json("/api/v1/publish", { key: app.ownerKey,
    ...jsonBody({ files: [{ path: "index.html", content: "<p>retained site</p>" }] }),
  });
  expect(published.status).toBe(201);
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
    .all<{ name: string }>();
  async function unrelated() {
    const snapshot: Record<string, unknown> = {};
    for (const { name } of tables.results) {
      if (TABLES.some((t) => t.table === name)) continue;
      snapshot[name] = (await env.DB.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()).results
        .map((row) => JSON.stringify(row)).sort();
    }
    return snapshot;
  }
  for (const t of TABLES) await seed(t, "expired-private-metadata", NOW, "spent");
  const before = await unrelated();
  await runCleanup(dc, NOW);
  expect(await unrelated()).toEqual(before);
  for (const t of TABLES) expect(await rows(t)).toEqual([]);
  expect((await env.DB.prepare("SELECT last_seen_at FROM members WHERE id = ?").bind(memberId).first())!.last_seen_at).toBeNull();
});

it("reports auth-only cleanup accurately and logs counts/backlog without identifiers or proof metadata", async () => {
  const secretLink = await realLink();
  await requestCode();
  const secretCode = deliveredCode();
  const session = await realSession();
  await env.DB.prepare("UPDATE sessions SET expires_at = ?").bind(NOW).run();
  await env.DB.prepare("UPDATE login_links SET expires_at = ?").bind(NOW).run();
  await env.DB.prepare("UPDATE email_codes SET expires_at = ?").bind(NOW).run();
  const sensitive = [memberId, tenantId, "owner@example.com", secretLink.token, secretLink.hash,
    secretCode, session.cookie, session.hash];
  for (const t of TABLES) for (const row of await rows(t)) {
    for (const key of ["code_hash", "ip_hash", "user_agent"]) {
      if (typeof row[key] === "string" && row[key]) sensitive.push(row[key] as string);
    }
  }
  const logs: unknown[][] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args); });
  }
  const report = await runCleanup(dc, NOW);
  expect(report).toMatchObject({
    expiredSites: 0, purgedSites: 0, abandonedDeploys: 0, deletedBlobs: 0,
    expiredSessions: 1, expiredLoginLinks: 2, expiredEmailCodes: 1,
    authBacklog: { sessions: false, loginLinks: false, emailCodes: false },
  });
  const events = logs.flat().flatMap((arg) => {
    if (typeof arg !== "string") return [arg];
    try { return [JSON.parse(arg)]; } catch { return []; }
  });
  expect(events).toContainEqual(expect.objectContaining({ event: "cleanup", ...report }));
  const observable = JSON.stringify({ report, logs });
  for (const secret of sensitive) expect(observable).not.toContain(secret);
  expect(observable).not.toMatch(/"(?:email|member_id|memberId|tenant_id|tenantId|token_hash|id_hash|code_hash|ip_hash|user_agent|userAgent)"\s*:/);
});
