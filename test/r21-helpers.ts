import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

// Proposed wire contracts where the roadmap does not specify a response shape:
// login-links {memberId} -> {url, expiresAt}; auth/sessions -> {sessions:[{id}]}.
// These helpers NEVER manufacture a login token, session, or authenticated principal.
export const SAME_ORIGIN = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
export const MINUTE = 60_000;

export async function ownerId(dw: Instance) {
  const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
  expect(me.status).toBe(200);
  return me.body.member.id as string;
}

export async function member(dw: Instance, email = "member@example.com") {
  const added = await dw.json("/api/v1/members", {
    key: dw.ownerKey, ...jsonBody({ email, role: "member" }),
  });
  expect(added.status).toBe(201);
  return { id: added.body.member.id as string, key: added.body.apiKey.key as string, email };
}

export async function loginLink(dw: Instance, memberId?: string, key = dw.ownerKey, origin = ORIGIN) {
  const minted = await dw.json("/api/v1/login-links", {
    key, ...jsonBody({ memberId: memberId ?? await ownerId(dw) }),
  });
  expect(minted.status, "the real login-link issuer must exist before testing a session").toBe(201);
  expect(typeof minted.body.url).toBe("string");
  const url = new URL(minted.body.url);
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe("/login");
  const token = url.searchParams.get("token");
  expect(token, "the link contains a real, nonempty exchange token").toBeTruthy();
  return { url: url.href, token: token!, expiresAt: minted.body.expiresAt as number | string };
}

export function issuedSessionCookies(response: Response) {
  return response.headers.getSetCookie().filter((cookie) =>
    /^__Host-dw_session=[^;]/.test(cookie) && !/;\s*max-age=0(?:;|$)/i.test(cookie));
}

export function sessionCookie(response: Response) {
  const cookies = response.headers.getSetCookie();
  const session = issuedSessionCookies(response)[0];
  expect(session, "actual /login exchange must issue __Host-dw_session").toBeTruthy();
  for (const cookie of cookies) {
    expect(cookie.split("=", 1)[0]).toMatch(/^__Host-/);
    const attributes = cookie.split(";").slice(1).map((value) => value.trim());
    expect(attributes.some((value) => /^secure$/i.test(value))).toBe(true);
    expect(attributes.filter((value) => /^path=/i.test(value)).map((value) => value.toLowerCase())).toEqual(["path=/"]);
    expect(attributes.some((value) => /^domain=/i.test(value))).toBe(false);
  }
  const pair = session!.split(";", 1)[0]!;
  expect(pair.slice(pair.indexOf("=") + 1)).not.toBe("");
  return pair;
}

export async function signedIn(dw: Instance, memberId?: string, origin = ORIGIN) {
  const link = await loginLink(dw, memberId, dw.ownerKey, origin);
  const exchange = await dw.call(link.url, { headers: { Accept: "text/html" } });
  expect([302, 303]).toContain(exchange.status);
  const cookie = sessionCookie(exchange);
  const sessions = await dw.json("/api/v1/auth/sessions", { headers: { Cookie: cookie } });
  expect(sessions.status, "a real issued session must resolve without a bearer key").toBe(200);
  expect(Array.isArray(sessions.body.sessions)).toBe(true);
  return { cookie, link, exchange, sessions: sessions.body.sessions as Array<{ id: string }> };
}

export async function callWithBindings(dw: Instance, path: string, bindings: Record<string, unknown>, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await dw.dropway.fetch(new Request(new URL(path, ORIGIN), { ...init, redirect: "manual" }),
    { ...env, ...bindings } as unknown as ServerBindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// Read real emulated D1, without prescribing the implementation's table/column names.
// This also catches raw tokens tucked in an auxiliary metadata column.
export async function storedRows() {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
  const rows: Array<{ table: string; row: Record<string, unknown> }> = [];
  for (const { name } of tables.results) {
    const result = await env.DB.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    for (const row of result.results) rows.push({ table: name, row });
  }
  return rows;
}

export async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function expectHashedOnly(secret: string) {
  const rows = await storedRows();
  expect(JSON.stringify(rows)).not.toContain(secret);
  const hash = await digest(secret);
  expect(rows.some(({ row }) => Object.values(row).includes(hash)), "D1 contains the token's SHA-256, not the reusable secret").toBe(true);
}

export async function anonymousSite(dw: Instance) {
  const created = await dw.json("/api/v1/publish", {
    ...jsonBody({ files: [{ path: "index.html", content: "<p>unclaimed</p>" }] }),
  });
  expect(created.status).toBe(201);
  expect(created.body.claimToken).toBeTruthy();
  return { slug: created.body.slug as string, token: created.body.claimToken as string, url: created.body.claimUrl as string };
}

export async function pageForms(response: Response) {
  const forms: Array<{ action: string; method: string; fields: Record<string, string> }> = [];
  await new HTMLRewriter().on("form", { element(element) {
    forms.push({ action: element.getAttribute("action") ?? "", method: element.getAttribute("method") ?? "get", fields: {} });
  } }).on("form input", { element(element) {
    const name = element.getAttribute("name");
    if (name && forms.length) forms[forms.length - 1]!.fields[name] = element.getAttribute("value") ?? "";
  } }).transform(response).text();
  return forms;
}

export async function siteRow(slug: string) {
  return env.DB.prepare("SELECT tenant_id, claim_token_hash, expires_at FROM sites WHERE slug = ?").bind(slug)
    .first<{ tenant_id: string | null; claim_token_hash: string | null; expires_at: number | null }>();
}

export { env, freshInstance, jsonBody, ORIGIN };
export type { Instance };
