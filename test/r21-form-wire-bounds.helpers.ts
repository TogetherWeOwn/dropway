import { expect } from "vitest";
import {
  anonymousSite, digest, freshInstance, issuedSessionCookies, jsonBody, loginLink, member,
  ORIGIN, pageForms, SAME_ORIGIN, sessionCookie, signedIn, siteRow, storedRows, type Instance,
} from "./r21-helpers";

export const FORM_BYTES = 65_536;
export const FORM_PATHS = ["/login/confirm", "/claim", "/api/v1/auth/email-code", "/api/v1/auth/email-code/verify"] as const;
export type FormPath = typeof FORM_PATHS[number];
type Message = { to: string[]; subject: string; text: string; html?: string; kind: string };

export async function formState() {
  return (await storedRows()).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function formBytes(fields: Record<string, string>, size: number, alphabet: "ASCII" | "UTF-8" = "ASCII") {
  const prefix = `${new URLSearchParams(fields)}&padding=`;
  const remaining = size - new TextEncoder().encode(prefix).byteLength;
  expect(remaining).toBeGreaterThanOrEqual(0);
  // Raw UTF-8 is legal in this URL-encoded padding field. Do not percent-encode it:
  // that would make a character-counting reader indistinguishable from a byte cap.
  const padding = alphabet === "ASCII" ? "x".repeat(remaining) : "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  const text = prefix + padding;
  const bytes = new TextEncoder().encode(text);
  expect(bytes.byteLength).toBe(size);
  if (alphabet === "UTF-8") expect(text.length).toBeLessThan(FORM_BYTES);
  return bytes;
}

export function measuredForm(bytes: Uint8Array) {
  const measurement = { pulls: 0, bytes: 0, eof: false, cancelled: false };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      measurement.pulls++;
      if (offset === bytes.byteLength) {
        measurement.eof = true;
        controller.close();
        return;
      }
      // Split a multibyte code point as well as the final overflow byte. The
      // stream has no prefetched chunk and closes only on a subsequent read.
      const end = Math.min(offset + 1023, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      measurement.bytes += end - offset;
      offset = end;
    },
    cancel() { measurement.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, measurement };
}

export async function expectFormError(response: Response, status: number, code: string) {
  expect.soft(response.status).toBe(status);
  expect.soft(issuedSessionCookies(response)).toEqual([]);
  const text = await response.text();
  let body: { error?: { code?: string; hint?: string } } = {};
  try { body = JSON.parse(text); } catch { /* Report the wire-contract assertion, not a JSON parse exception. */ }
  expect.soft(body.error?.code).toBe(code);
  expect.soft(typeof body.error?.hint).toBe("string");
  expect.soft(body.error?.hint?.trim().length ?? 0, "the refusal must tell the caller how to recover").toBeGreaterThan(0);
}

export async function formFixture(path: FormPath) {
  const delivered: Message[] = [];
  const dw = await freshInstance({ appOrigin: ORIGIN, anonymous: { enabled: true } }, { adapters: { email: {
    async send(message: Message) {
      expect(delivered.length, "local delivery capture only; never a real email provider").toBeLessThan(3);
      delivered.push(message);
      return { id: `bounded-form-${delivered.length}` };
    },
  } } });
  const target = await member(dw, "bounded-member@example.com");
  const me = await dw.json("/api/v1/me", { key: target.key });
  expect(me.status).toBe(200);
  const tenantId = me.body.tenant.id as string;
  const site = await anonymousSite(dw);
  let url: string = path;
  let cookie: string | undefined;
  let fields: Record<string, string>;

  if (path === "/login/confirm") {
    const link = await loginLink(dw, target.id, target.key);
    const response = await dw.call(link.url, { headers: { Accept: "text/html" } });
    expect(response.status).toBe(200);
    expect(issuedSessionCookies(response)).toEqual([]);
    const form = (await pageForms(response)).find((entry) => entry.method.toLowerCase() === "post");
    expect(form).toBeTruthy();
    url = new URL(form!.action, ORIGIN).href;
    expect(new URL(url).pathname).toBe(path);
    expect(Object.values(form!.fields)).toContain(link.token);
    fields = form!.fields;
  } else if (path === "/claim") {
    cookie = (await signedIn(dw, target.id)).cookie;
    const response = await dw.call(`/claim?slug=${site.slug}`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const form = (await pageForms(response)).find((entry) => entry.method.toLowerCase() === "post" && "claimToken" in entry.fields);
    expect(form).toBeTruthy();
    url = new URL(form!.action || `/claim?slug=${site.slug}`, ORIGIN).href;
    expect(new URL(url).pathname).toBe(path);
    fields = { ...form!.fields, claimToken: site.token };
  } else {
    fields = { email: target.email };
    if (path.endsWith("/verify")) {
      const issued = await dw.call("/api/v1/auth/email-code", {
        ...jsonBody(fields), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
      });
      expect([200, 202]).toContain(issued.status);
      expect(delivered).toHaveLength(1);
      const code = delivered[0]!.text.match(/\b\d{6}\b/)?.[0];
      expect(code, "use only the genuine issuer's delivered code").toBeTruthy();
      fields.code = code!;
    }
  }

  function post(body: BodyInit = new URLSearchParams(fields), headers: Record<string, string> = SAME_ORIGIN) {
    return dw.call(url, { method: "POST", body, headers: {
      Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers,
    } });
  }

  async function expectSuccess(response: Response) {
    if (path === "/api/v1/auth/email-code") {
      expect([200, 202, 303]).toContain(response.status);
      expect(issuedSessionCookies(response)).toEqual([]);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.to).toEqual([target.email]);
      expect(delivered[0]!.kind).toBe("sign_in");
      const code = delivered[0]!.text.match(/\b\d{6}\b/)?.[0];
      expect(code).toBeTruthy();
      expect(await response.text()).not.toContain(code!);
      response = await dw.call("/api/v1/auth/email-code/verify", {
        method: "POST", headers: SAME_ORIGIN, body: new URLSearchParams({ email: target.email, code: code! }),
      });
    }
    if (path === "/claim") {
      expect([200, 302, 303]).toContain(response.status);
      const row = await siteRow(site.slug);
      expect(row?.tenant_id).toBe(tenantId);
      expect(row?.claim_token_hash).toBeNull();
      expect(row?.expires_at).toBeNull();
      expect(issuedSessionCookies(response)).toEqual([]);
      await expectCookieIdentity(dw, cookie!, target.id);
      return;
    }
    await expectSessionIdentity(dw, response, target.id);
    expect((await siteRow(site.slug))?.tenant_id, "sign-in cannot claim an unrelated anonymous site").toBeNull();
  }

  return { dw, path, url, fields, delivered, post, expectSuccess, site, target };
}

async function expectSessionIdentity(dw: Instance, response: Response, memberId: string) {
  expect([200, 302, 303]).toContain(response.status);
  const cookie = sessionCookie(response);
  expect(issuedSessionCookies(response)).toHaveLength(1);
  expect(issuedSessionCookies(response)[0]).toMatch(/;\s*HttpOnly(?:;|$)/i);
  expect(issuedSessionCookies(response)[0]).toMatch(/;\s*SameSite=Lax(?:;|$)/i);
  await expectCookieIdentity(dw, cookie, memberId);
}

async function expectCookieIdentity(dw: Instance, cookie: string, memberId: string) {
  const listed = await dw.json("/api/v1/auth/sessions", { headers: { Cookie: cookie } });
  expect(listed.status, "the real cookie must resolve without a bearer key").toBe(200);
  expect(listed.body.sessions).toHaveLength(1);
  const hash = await digest(cookie.slice(cookie.indexOf("=") + 1));
  const sessions = (await storedRows()).filter(({ table, row }) => table === "sessions" && Object.values(row).includes(hash));
  expect(sessions).toHaveLength(1);
  expect(Object.values(sessions[0]!.row)).toContain(memberId);
  expect(listed.body.sessions[0].id).toBe(sessions[0]!.row.id);
}
