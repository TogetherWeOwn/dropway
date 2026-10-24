import { expect } from "vitest";
import {
  anonymousSite, callWithBindings, digest, env, freshInstance, MINUTE, ORIGIN,
  pageForms, SAME_ORIGIN, signedIn, siteRow, storedRows,
} from "./r21-helpers";

export const WIRE_CAP = 65_536;
export const START = Date.UTC(2026, 9, 23);
export const AGED = START + 61 * MINUTE;
export const FORM = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };

export async function rowsSnapshot() {
  return JSON.stringify((await storedRows()).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

// Observe executions, not prepares, while retaining real local D1 statements,
// transactions and results. A refused body must not even attempt a sliding write.
export function observedD1() {
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

export function paddedForm(fields: Record<string, string>, length: number, alphabet: "ASCII" | "UTF-8" = "ASCII") {
  const prefix = `${new URLSearchParams(fields)}&padding=`;
  const count = length - new TextEncoder().encode(prefix).byteLength;
  expect(count).toBeGreaterThanOrEqual(0);
  const padding = alphabet === "ASCII" ? "x".repeat(count) : "é".repeat(Math.floor(count / 2)) + "x".repeat(count % 2);
  const text = prefix + padding;
  const bytes = new TextEncoder().encode(text);
  expect(bytes.byteLength).toBe(length);
  if (alphabet === "UTF-8") expect(text.length).toBeLessThan(WIRE_CAP);
  return bytes;
}

export function measuredBody(bytes: Uint8Array, onPull = () => {}) {
  const measure = { pulls: 0, bytes: 0, eof: false, cancelled: false };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull();
      measure.pulls++;
      if (offset === bytes.byteLength) {
        measure.eof = true;
        controller.close();
        return;
      }
      // No prefetch; odd-sized chunks split raw UTF-8 padding code points.
      const end = Math.min(offset + 1023, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      measure.bytes += end - offset;
      offset = end;
    },
    cancel() { measure.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, measure };
}

export async function sessionRow(cookie: string) {
  const hash = await digest(cookie.slice(cookie.indexOf("=") + 1));
  const row = await env.DB.prepare("SELECT id, member_id, expires_at, last_seen_at, revoked_at FROM sessions WHERE id_hash = ?")
    .bind(hash).first<{ id: string; member_id: string; expires_at: number; last_seen_at: number | null; revoked_at: number | null }>();
  expect(Boolean(row), "the real cookie must identify its genuine D1 session").toBe(true);
  return row!;
}

export async function claimFixture() {
  const dw = await freshInstance({ appOrigin: ORIGIN, anonymous: { enabled: true } });
  const site = await anonymousSite(dw);
  const active = await signedIn(dw);
  const before = await sessionRow(active.cookie);
  expect(before.expires_at).toBe(START + 30 * 86_400_000);
  expect(before.last_seen_at).toBe(START);
  const page = await dw.call(`/claim?slug=${site.slug}`, { headers: { Cookie: active.cookie } });
  expect(page.status).toBe(200);
  const form = (await pageForms(page)).find((entry) => entry.method.toLowerCase() === "post" && "claimToken" in entry.fields);
  expect(Boolean(form), "use the actual served claim form").toBe(true);
  const url = new URL(form!.action || `/claim?slug=${site.slug}`, ORIGIN);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe("/claim");
  const fields = { ...form!.fields, claimToken: site.token };
  const row = await siteRow(site.slug);
  expect(row?.tenant_id).toBeNull();
  expect(row?.claim_token_hash === await digest(site.token), "the real publish proof must match this anonymous site").toBe(true);
  const tenant = await env.DB.prepare("SELECT tenant_id FROM members WHERE id = ?").bind(before.member_id).first<{ tenant_id: string }>();
  expect(Boolean(tenant)).toBe(true);

  function post(body: BodyInit = new URLSearchParams(fields), headers: Record<string, string> = SAME_ORIGIN, DB = env.DB) {
    return callWithBindings(dw, url.href, { DB }, { method: "POST", body, headers: {
      ...FORM, ...headers, Cookie: active.cookie, Accept: "application/json",
    } });
  }
  async function expectClaimed(response: Response) {
    expect([200, 302, 303]).toContain(response.status);
    const row = await siteRow(site.slug);
    expect(row?.tenant_id).toBe(tenant!.tenant_id);
    expect(row?.claim_token_hash).toBeNull();
    expect(row?.expires_at).toBeNull();
    const listed = await dw.json("/api/v1/auth/sessions", { headers: { Cookie: active.cookie } });
    expect(listed.status, "the original real session still authenticates without a bearer").toBe(200);
    expect(listed.body.sessions.some((entry: { id: string }) => entry.id === before.id)).toBe(true);
  }
  return { dw, site, active, fields, post, expectClaimed, before };
}

export async function expectOversize(response: Response) {
  expect.soft(response.status, "a valid aged session and genuine claim proof cannot exempt an oversized body").toBe(413);
  expect.soft(response.headers.getSetCookie(), "body refusal cannot extend or replace the browser session").toEqual([]);
  const text = await response.text();
  let body: { error?: { code?: string; hint?: string } } = {};
  try { body = JSON.parse(text); } catch { /* A redirect/HTML response is a contract failure, not a parser crash. */ }
  expect.soft(body.error?.code).toBe("request_too_large");
  expect.soft(typeof body.error?.hint).toBe("string");
  expect.soft(body.error?.hint?.trim().length ?? 0).toBeGreaterThan(0);
}
