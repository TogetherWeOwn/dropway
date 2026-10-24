import { describe, expect, it } from "vitest";
import { deniedBrowserHeaders, WORKER_APP } from "./r21-browser-headers";
import {
  freshInstance, issuedSessionCookies, ORIGIN, sessionCookie, storedRows, type Instance,
} from "./r21-helpers";

type Message = { to: string[]; subject: string; text: string; html?: string; kind: string };
const OWNER = "owner@example.com";
const UNKNOWN = "unknown@example.com";
const FEATURE_HEADERS: Array<{ name: string; headers: Record<string, string> }> = [
  { name: "both absent", headers: {} },
  { name: "exact browser headers", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } },
];
const REQUESTS = [
  { transport: "JSON", email: OWNER },
  { transport: "JSON", email: UNKNOWN },
  { transport: "native form", email: OWNER },
  { transport: "native form", email: UNKNOWN },
] as const;
type EmailRequest = typeof REQUESTS[number];

async function emailFixture(origin: string) {
  const delivered: Message[] = [];
  const dw = await freshInstance({ appOrigin: origin }, { adapters: { email: {
    async send(message: Message) {
      expect(delivered.length, "bounded capture, no provider/network operation").toBeLessThan(2);
      delivered.push(message);
      return { id: `browser-intent-delivery-${delivered.length}` };
    },
  } } });
  return { dw, delivered };
}

function request(dw: Instance, input: EmailRequest, headers: Record<string, string>, origin = ORIGIN) {
  return dw.call(`${origin}/api/v1/auth/email-code`, {
    method: "POST",
    body: input.transport === "JSON" ? JSON.stringify({ email: input.email }) : new URLSearchParams({ email: input.email }),
    headers: { ...(input.transport === "JSON" ? { "Content-Type": "application/json" } : {}), ...headers },
  });
}

// Break caught: using Cookie presence to decide whether email side effects need
// browser intent. Known and unknown emails must hit the same pre-side-effect gate.
// All requests are cookieless; the optional delivery adapter only captures mail.
describe.each(REQUESTS)("R-21 email request intent: $transport $email", (input) => {
  it.each(deniedBrowserHeaders())("denies $name before delivery, challenge, session or resource mutation", async ({ origin, headers }) => {
    const f = await emailFixture(origin);
    const before = await storedRows();
    const response = await request(f.dw, input, headers, origin);
    expect.soft(response.status).toBe(403);
    expect.soft(issuedSessionCookies(response)).toEqual([]);
    expect.soft(f.delivered, "denied mail must never reach the delivery boundary").toEqual([]);
    expect(await storedRows(), "including email_codes, sessions, members and resource tables").toEqual(before);
  });

  it.each([ORIGIN, WORKER_APP])("positive control: exact Origin + same-origin metadata at %s follows the real email contract", async (origin) => {
    const f = await emailFixture(origin);
    const before = await storedRows();
    const response = await request(f.dw, input, { Origin: origin, "Sec-Fetch-Site": "same-origin" }, origin);
    expect(issuedSessionCookies(response)).toEqual([]);
    if (input.email === UNKNOWN) {
      expect([200, 202, 303, 404]).toContain(response.status);
      expect(f.delivered).toEqual([]);
      expect(await storedRows(), "unknown email cannot sign up, create a challenge, or acquire a session").toEqual(before);
      return;
    }
    expect(input.transport === "native form" ? [303] : [200, 202]).toContain(response.status);
    expect(f.delivered).toHaveLength(1);
    const message = f.delivered[0]!;
    expect(message.to).toEqual([OWNER]);
    expect(message.kind).toBe("sign_in");
    const code = message.text.match(/\b\d{6}\b/)?.[0];
    expect(Boolean(code), "use only the real issuer's delivered code").toBe(true);
    expect((await response.text()).includes(code!)).toBe(false);
    const after = await storedRows();
    expect(after.filter(({ table }) => table !== "email_codes")).toEqual(before);
    const challenges = after.filter(({ table }) => table === "email_codes");
    expect(challenges).toHaveLength(1);
    expect(challenges[0]!.row.email).toBe(OWNER);
    expect(challenges[0]!.row.purpose).toBe("sign_in");
    expect(challenges[0]!.row.attempts).toBe(0);
    expect(typeof challenges[0]!.row.code_hash).toBe("string");
    expect((challenges[0]!.row.code_hash as string).length).toBeGreaterThan(code!.length);
    expect(JSON.stringify(after).includes(code!)).toBe(false);
    const exchanged = await f.dw.call(`${origin}/api/v1/auth/email-code/verify`, {
      method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
      body: new URLSearchParams({ email: OWNER, code: code! }),
    });
    const cookie = sessionCookie(exchanged);
    expect((await f.dw.call(`${origin}/api/v1/auth/sessions`, { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it.each(FEATURE_HEADERS)("disabled feature remains feature_unavailable with $name", async ({ headers }) => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const before = await storedRows();
    const response = await request(dw, input, headers);
    expect(response.status).toBe(501);
    const body = await response.json() as { error: { code: string; hint: string } };
    expect(body.error.code).toBe("feature_unavailable");
    expect(body.error.hint).toBeTruthy();
    expect(issuedSessionCookies(response)).toEqual([]);
    expect(await storedRows()).toEqual(before);
  });
});
