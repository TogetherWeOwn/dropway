import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DropwayContext } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import {
  callWithBindings, env, freshInstance, issuedSessionCookies, jsonBody, SAME_ORIGIN, sessionCookie, signedIn,
} from "./r21-helpers";

// SPEC.md EmailAdapter shape. Keep the absent feature a runtime assertion RED
// on the protected-test base, rather than an unresolved type import.
type EmailMessage = {
  to: string[]; subject: string; text: string; html?: string;
  kind: "sign_in" | "site_access" | "invite" | "notice";
};

// Breaks caught: dropping adapters.email from context, ignoring an embedding
// adapter in favor of EMAIL, losing its service context, or making email required.
describe("R-21 optional email extension contract", () => {
  it("passes the configured adapter and real context through sign-in, ahead of the EMAIL binding", async () => {
    const messages: EmailMessage[] = [];
    const contexts: DropwayContext[] = [];
    const email = { async send(message: EmailMessage, dc: DropwayContext) {
      messages.push(message);
      contexts.push(dc);
      return { id: "extension-delivery" };
    } };
    const dw = await freshInstance({ instanceName: "Email extension contract" }, {
      adapters: { email },
    } as Parameters<typeof freshInstance>[1]);
    const dc = dw.dropway.context(env as unknown as ServerBindings, createExecutionContext());
    expect(dc.adapters).toHaveProperty("email", email);

    let bindingCalls = 0;
    const bindings = { EMAIL: { async send() {
      bindingCalls++;
      return { messageId: "binding-delivery", delivered: ["owner@example.com"], queued: [], permanent_bounces: [] };
    } } };
    const requested = await callWithBindings(dw, "/api/v1/auth/email-code", bindings, {
      ...jsonBody({ email: "owner@example.com" }),
      headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
    });
    expect([200, 202]).toContain(requested.status);
    expect(issuedSessionCookies(requested)).toEqual([]);
    const requestText = await requested.text();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ to: ["owner@example.com"], kind: "sign_in", subject: expect.any(String) });
    expect(messages[0]!.subject.length).toBeGreaterThan(0);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.env.DB).toBe(env.DB);
    expect(contexts[0]!.config.instanceName).toBe("Email extension contract");
    expect(contexts[0]!.adapters).toHaveProperty("email", email);
    expect(bindingCalls).toBe(0);

    const code = messages[0]!.text.match(/\b\d{6}\b/)?.[0];
    expect(code, "only the actual extension delivery reveals the one-time code").toBeTruthy();
    expect(requestText).not.toContain(code!);
    const verified = await callWithBindings(dw, "/api/v1/auth/email-code/verify", bindings, {
      ...jsonBody({ email: "owner@example.com", code }),
      headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
    });
    expect([200, 303]).toContain(verified.status);
    const cookie = sessionCookie(verified);
    const active = await callWithBindings(dw, "/api/v1/auth/sessions", bindings, { headers: { Cookie: cookie } });
    expect(active.status).toBe(200);
    expect(bindingCalls).toBe(0);
    expect(messages).toHaveLength(1);
  });

  it("keeps API-key and login-link sign-in usable when email is not configured", async () => {
    const dw = await freshInstance();
    const unavailable = await dw.json("/api/v1/auth/email-code", {
      ...jsonBody({ email: "owner@example.com" }),
      headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
    });
    expect(unavailable.status).toBe(501);
    expect(unavailable.body.error).toMatchObject({ code: "feature_unavailable", hint: expect.any(String) });
    expect(unavailable.body.error.hint.length).toBeGreaterThan(0);
    expect(issuedSessionCookies(unavailable.res)).toEqual([]);
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).status).toBe(200);
    const active = await signedIn(dw);
    expect(active.sessions).toHaveLength(1);
  });
});
