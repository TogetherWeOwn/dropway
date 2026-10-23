import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callWithBindings, env, freshInstance, issuedSessionCookies, jsonBody, MINUTE, pageForms,
  SAME_ORIGIN, sessionCookie, type Instance,
} from "./r21-helpers";

afterEach(() => vi.useRealTimers());

type Message = { to: string[]; subject: string; text: string; html?: string; kind: string };
function deliveryCapture() {
  const messages: Message[] = [];
  return {
    messages,
    adapter: { async send(message: Message) {
      expect(messages.length, "bound the capture; never send to a real provider").toBeLessThan(2);
      expect(message.text.length).toBeLessThan(16_384);
      messages.push(message);
      return { id: `captured-${messages.length}` };
    } },
  };
}

async function emailInstance() {
  const capture = deliveryCapture();
  // The optional adapter interface is specified in SPEC.md:556-558, but is not
  // exported on the pre-feature base. A structural options cast keeps that
  // absence an HTTP assertion failure, not an import/type/harness failure.
  const dw = await freshInstance({}, { adapters: { email: capture.adapter } } as Parameters<typeof freshInstance>[1]);
  return { dw, capture };
}

function deliveredCode(messages: Message[]) {
  expect(messages).toHaveLength(1);
  expect(messages[0]!.to).toEqual(["owner@example.com"]);
  expect(messages[0]!.kind).toBe("sign_in");
  // Proposed browser contract: a six-digit code, delivered rather than returned
  // by the unauthenticated request endpoint. No fake token or session issuer.
  const code = messages[0]!.text.match(/\b\d{6}\b/)?.[0];
  expect(code, "obtain the code only at the real EmailAdapter delivery boundary").toBeTruthy();
  return code!;
}

async function requestCode(dw: Instance) {
  const request = await dw.json("/api/v1/auth/email-code", {
    ...jsonBody({ email: "owner@example.com" }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
  });
  expect([200, 202]).toContain(request.status);
  expect(issuedSessionCookies(request.res)).toEqual([]);
  return request;
}

async function verify(dw: Instance, code: string, email = "owner@example.com") {
  return dw.call("/api/v1/auth/email-code/verify", {
    ...jsonBody({ email, code }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
  });
}

// Breaks caught: optional transport ignored, codes exposed instead of delivered,
// expiry/attempt cap bypass, accepting a code for a different email, and signup.
describe("R-21 email-code sign-in at the actual delivery boundary", () => {
  it("delivers through EmailAdapter and exchanges the delivered code for a real session", async () => {
    const { dw, capture } = await emailInstance();
    const request = await requestCode(dw);
    const code = deliveredCode(capture.messages);
    expect(JSON.stringify(request.body)).not.toContain(code);
    const response = await verify(dw, code);
    expect([200, 303]).toContain(response.status);
    const cookie = sessionCookie(response);
    expect((await dw.json("/api/v1/auth/sessions", { headers: { Cookie: cookie } })).status).toBe(200);
    expect(issuedSessionCookies(await verify(dw, code))).toEqual([]);
  });

  it("stores a hash rather than the delivered email code and initializes five-try state", async () => {
    const { dw, capture } = await emailInstance();
    await requestCode(dw);
    const code = deliveredCode(capture.messages);
    const stored = await env.DB.prepare("SELECT code_hash, attempts FROM email_codes WHERE email = ? AND purpose = 'sign_in'")
      .bind("owner@example.com").first<{ code_hash: string; attempts: number }>();
    expect(stored).toBeTruthy();
    expect(stored!.code_hash).not.toBe(code);
    expect(typeof stored!.code_hash).toBe("string");
    expect(stored!.code_hash.length).toBeGreaterThan(code.length);
    expect(stored!.attempts).toBe(0);
    sessionCookie(await verify(dw, code));
  });

  it("uses EMAIL by default when the binding is present, without an embedding adapter", async () => {
    const dw = await freshInstance();
    const delivered: string[] = [];
    const binding = { async send(message: { text?: string; raw?: ReadableStream; to?: unknown }) {
      expect(delivered.length).toBeLessThan(1);
      const text = message.text ?? (message.raw ? await new Response(message.raw).text() : "");
      expect(text.length).toBeLessThan(16_384);
      delivered.push(text);
      return { messageId: "test-message", delivered: ["owner@example.com"], queued: [], permanent_bounces: [] };
    } };
    const response = await callWithBindings(dw, "/api/v1/auth/email-code", { EMAIL: binding }, {
      ...jsonBody({ email: "owner@example.com" }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
    });
    expect([200, 202]).toContain(response.status);
    expect(delivered).toHaveLength(1);
    const code = delivered[0]!.match(/\b\d{6}\b/)?.[0];
    expect(code).toBeTruthy();
    const verified = await callWithBindings(dw, "/api/v1/auth/email-code/verify", { EMAIL: binding }, {
      ...jsonBody({ email: "owner@example.com", code }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
    });
    const cookie = sessionCookie(verified);
    expect((await callWithBindings(dw, "/api/v1/auth/sessions", { EMAIL: binding }, { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("hides email sign-in without an EMAIL binding and returns feature_unavailable", async () => {
    const dw = await freshInstance();
    const forms = await pageForms(await dw.call("/login"));
    expect(forms.some((form) => form.action.includes("/auth/email-code"))).toBe(false);
    for (const path of ["/api/v1/auth/email-code", "/api/v1/auth/email-code/verify"]) {
      const response = await dw.json(path, { ...jsonBody({ email: "owner@example.com", code: "123456" }) });
      expect(response.status).toBe(501);
      expect(response.body.error.code).toBe("feature_unavailable");
      expect(response.body.error.hint).toBeTruthy();
    }
  });

  it("shows an email sign-in operation when delivery is available", async () => {
    const { dw } = await emailInstance();
    const forms = await pageForms(await dw.call("/login"));
    expect(forms.some((form) => form.action.includes("/auth/email-code"))).toBe(true);
  });

  it.each([15 * MINUTE, 15 * MINUTE + 1])("refuses a delivered code at expiry +%i ms", async (elapsed) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { dw, capture } = await emailInstance();
    await requestCode(dw);
    const code = deliveredCode(capture.messages);
    vi.setSystemTime(Date.now() + elapsed);
    const response = await verify(dw, code);
    expect([400, 401, 403, 410]).toContain(response.status);
    expect(issuedSessionCookies(response)).toEqual([]);
  });

  it("still accepts the correct code just before 15 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { dw, capture } = await emailInstance();
    await requestCode(dw);
    const code = deliveredCode(capture.messages);
    vi.setSystemTime(Date.now() + 15 * MINUTE - 1);
    sessionCookie(await verify(dw, code));
  });

  it("allows the correct fifth attempt after four wrong codes", async () => {
    const { dw, capture } = await emailInstance();
    await requestCode(dw);
    const code = deliveredCode(capture.messages);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 4; attempt++) {
      const failed = await verify(dw, wrong);
      expect([400, 401, 403, 429]).toContain(failed.status);
      expect(issuedSessionCookies(failed)).toEqual([]);
    }
    sessionCookie(await verify(dw, code));
  });

  it("locks the challenge after five failures, even for the subsequently correct code", async () => {
    const { dw, capture } = await emailInstance();
    await requestCode(dw);
    const code = deliveredCode(capture.messages);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await verify(dw, wrong);
      expect([400, 401, 403, 429]).toContain(failed.status);
      expect(issuedSessionCookies(failed)).toEqual([]);
    }
    const response = await verify(dw, code);
    expect([400, 401, 403, 429]).toContain(response.status);
    expect(issuedSessionCookies(response)).toEqual([]);
  });

  it("does not accept a valid code for a different email or create an implicit member", async () => {
    const { dw, capture } = await emailInstance();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first();
    await requestCode(dw);
    const code = deliveredCode(capture.messages);
    const unknown = await dw.json("/api/v1/auth/email-code", {
      ...jsonBody({ email: "unknown@example.com" }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
    });
    expect([200, 202, 404]).toContain(unknown.status);
    expect(capture.messages).toHaveLength(1);
    const response = await verify(dw, code, "unknown@example.com");
    expect([400, 401, 403, 404]).toContain(response.status);
    expect(issuedSessionCookies(response)).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first()).toEqual(before);
    sessionCookie(await verify(dw, code));
  });
});
