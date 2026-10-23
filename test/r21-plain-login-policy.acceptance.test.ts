import { describe, expect, it } from "vitest";
import {
  anonymousSite, freshInstance, issuedSessionCookies, loginLink, ORIGIN, pageForms,
  SAME_ORIGIN, sessionCookie, signedIn,
} from "./r21-helpers";
import { rowsSnapshot } from "./r21-remaining-contract.helpers";

const NAVIGATION = { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
type Message = { to: string[]; subject: string; text: string; html?: string; kind: string };

async function emailFixture(enabled: boolean) {
  const delivered: Message[] = [];
  const dw = await freshInstance({ appOrigin: ORIGIN }, enabled ? { adapters: { email: {
    async send(message: Message) {
      expect(delivered.length, "local adapter capture only, never a provider").toBeLessThan(1);
      delivered.push(message);
      return { id: "local-native-form-delivery" };
    },
  } } } : {});
  return { dw, delivered };
}

// Breaks caught: a generic shell overwrites no-store on plain login, or a blanket
// no-referrer repair breaks the native email form's ordinary browser Origin.
// These are Worker/native-wire contracts, not actual-browser execution evidence.
describe("R-21 token-free login has its own narrow response policy", () => {
  it.each([false, true])("is explicitly no-store but strict-origin-when-cross-origin (email enabled: %s)", async (enabled) => {
    const { dw, delivered } = await emailFixture(enabled);
    const before = await rowsSnapshot();
    const response = await dw.call("/login", { headers: NAVIGATION });
    expect(response.status).toBe(200);
    expect.soft(response.headers.get("cache-control"), "plain login cannot be stored just because it has no token").toMatch(/(?:^|[,\s])no-store(?:$|[,\s])/i);
    expect(response.headers.get("referrer-policy"), "preserve native same-origin form Origin rather than applying protected-page no-referrer").toBe("strict-origin-when-cross-origin");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await rowsSnapshot()) === before).toBe(true);
    expect(delivered).toHaveLength(0);
  });

  it("positive control: rendered enabled native forms request and redeem a genuine existing-member email code with both browser headers", async () => {
    const { dw, delivered } = await emailFixture(true);
    const response = await dw.call("/login", { headers: NAVIGATION });
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const disabled: boolean[] = [];
    await new HTMLRewriter().on("form", { element() { disabled.push(false); } })
      .on("form input, form button", { element(element) {
        if (element.hasAttribute("disabled") && disabled.length) disabled[disabled.length - 1] = true;
      } }).transform(response.clone()).text();
    const forms = await pageForms(response);
    const request = forms.find((entry) => new URL(entry.action || "/login", ORIGIN).pathname === "/api/v1/auth/email-code");
    const verify = forms.find((entry) => new URL(entry.action || "/login", ORIGIN).pathname === "/api/v1/auth/email-code/verify");
    expect(Boolean(request), "email enabled must render its actual native request form").toBe(true);
    expect(Boolean(verify), "email enabled must render its actual native verification form").toBe(true);
    for (const form of [request!, verify!]) {
      expect(form.method.toLowerCase()).toBe("post");
      expect(new URL(form.action, ORIGIN).origin).toBe(ORIGIN);
      expect(disabled[forms.indexOf(form)], "do not leave an inert or disabled positive control").toBe(false);
      expect(Object.hasOwn(form.fields, "email")).toBe(true);
    }
    expect(Object.hasOwn(verify!.fields, "code")).toBe(true);
    // Only the external send boundary is captured. Real challenge reservation,
    // hashes, code verification and host-cookie issuance run against local D1.
    const requested = await dw.call(new URL(request!.action, ORIGIN).href, {
      method: "POST", headers: SAME_ORIGIN,
      body: new URLSearchParams({ ...request!.fields, email: "owner@example.com" }),
    });
    expect(requested.status).toBe(303);
    expect(issuedSessionCookies(requested)).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.to).toEqual(["owner@example.com"]);
    expect(delivered[0]!.kind).toBe("sign_in");
    const code = delivered[0]!.text.match(/\b\d{6}\b/)?.[0];
    expect(Boolean(code), "use only the code produced by the real email issuer").toBe(true);
    const verified = await dw.call(new URL(verify!.action, ORIGIN).href, {
      method: "POST", headers: SAME_ORIGIN,
      body: new URLSearchParams({ ...verify!.fields, email: "owner@example.com", code: code! }),
    });
    const cookie = sessionCookie(verified);
    const sessions = await dw.json("/api/v1/auth/sessions", { headers: { Cookie: cookie } });
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toHaveLength(1);
  });
});

function protectedResponse(response: Response) {
  expect(response.headers.get("cache-control")).toMatch(/(?:^|[,\s])no-store(?:$|[,\s])/i);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
  expect(response.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

// Break caught: fixing plain login by weakening token, error, claim or session
// response policy globally instead of preserving the protected-page distinction.
describe("R-21 protected sign-in surfaces retain no-store/no-referrer/CSP", () => {
  it("keeps live token confirmation and rejected POST errors protected and read-only", async () => {
    const { dw } = await emailFixture(false);
    const link = await loginLink(dw);
    const before = await rowsSnapshot();
    const confirmation = await dw.call(link.url, { headers: NAVIGATION });
    expect(confirmation.status).toBe(200);
    protectedResponse(confirmation);
    expect(confirmation.headers.getSetCookie()).toEqual([]);
    const form = (await pageForms(confirmation)).find((entry) => entry.method.toLowerCase() === "post");
    expect(Boolean(form)).toBe(true);
    const fields = Object.fromEntries(Object.entries(form!.fields).map(([name, value]) => [name, value === link.token ? "not-a-real-proof" : value]));
    const invalid = await dw.call(new URL(form!.action, ORIGIN).href, {
      method: "POST", headers: SAME_ORIGIN, body: new URLSearchParams(fields),
    });
    expect([400, 401, 403, 410]).toContain(invalid.status);
    protectedResponse(invalid);
    expect(invalid.headers.getSetCookie()).toEqual([]);
    expect((await rowsSnapshot()) === before, "neither confirmation inspection nor error burns proof").toBe(true);
    sessionCookie(await dw.call(link.url, { headers: { Accept: "application/json" } }));
  });

  it.each(["claim", "sessions"] as const)("keeps the real signed-in %s page protected without read-side mutation", async (kind) => {
    const dw = await freshInstance({ appOrigin: ORIGIN, anonymous: { enabled: true } });
    const active = await signedIn(dw);
    const path = kind === "claim" ? `/claim?slug=${(await anonymousSite(dw)).slug}` : "/dashboard/sessions";
    const before = await rowsSnapshot();
    const response = await dw.call(path, { headers: { ...NAVIGATION, Cookie: active.cookie } });
    expect(response.status).toBe(200);
    protectedResponse(response);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await rowsSnapshot()) === before).toBe(true);
  });
});
