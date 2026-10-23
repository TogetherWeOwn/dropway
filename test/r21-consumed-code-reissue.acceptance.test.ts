import { afterEach, describe, expect, it, vi } from "vitest";
import {
  freshInstance, issuedSessionCookies, jsonBody, MINUTE, SAME_ORIGIN, sessionCookie, storedRows,
} from "./r21-helpers";

const EMAIL = "owner@example.com";
afterEach(() => vi.useRealTimers());
type Message = { to: string[]; subject: string; text: string; html?: string; kind: string };

// Only the external delivery transport is captured. Requests, challenge reservations,
// one-use consumption, cookies, identity resolution and D1 all use the actual product.
async function fixture(failOnSend = 0) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const attempts: Message[] = [];
  const delivered: Message[] = [];
  const dw = await freshInstance({}, { adapters: { email: {
    async send(message: Message) {
      expect(attempts.length, "bounded local capture; no real provider").toBeLessThan(5);
      attempts.push(message);
      if (attempts.length === failOnSend) throw new Error("local transient delivery failure");
      delivered.push(message);
      return { id: `reissue-delivery-${delivered.length}` };
    },
  } } });
  const request = (email = EMAIL) => dw.json("/api/v1/auth/email-code", {
    ...jsonBody({ email }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
  });
  const verify = (code: string, email = EMAIL) => dw.call("/api/v1/auth/email-code/verify", {
    ...jsonBody({ email, code }), headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
  });
  const initial = await request();
  expect([200, 202]).toContain(initial.status);
  expect(initial.res.headers.getSetCookie()).toEqual([]);
  expect(delivered).toHaveLength(1);
  return { dw, start, attempts, delivered, request, verify };
}

function codeIn(message: Message) {
  expect(message.to).toEqual([EMAIL]);
  expect(message.kind).toBe("sign_in");
  const code = message.text.match(/\b\d{6}\b/)?.[0];
  expect(code, "proof must come from a real delivered message, never a made-up issuer").toBeTruthy();
  return code!;
}

function denied(response: Response) {
  expect([400, 401, 403, 404, 410, 429]).toContain(response.status);
  expect(issuedSessionCookies(response)).toEqual([]);
}

function wrong(code: string) { return code === "000000" ? "111111" : "000000"; }

async function challenges() {
  return (await storedRows()).filter(({ table }) => table === "email_codes");
}

async function live(f: Awaited<ReturnType<typeof fixture>>, cookie: string) {
  const response = await f.dw.json("/api/v1/auth/sessions", { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  expect(response.body.sessions.length).toBeGreaterThan(0);
  return response.body.sessions as Array<{ id: string }>;
}

async function noPlaintext(f: Awaited<ReturnType<typeof fixture>>) {
  const serialized = JSON.stringify(await storedRows());
  for (const message of f.attempts) {
    expect(serialized.includes(codeIn(message)), "neither failed nor delivered plaintext proofs belong in D1").toBe(false);
  }
}

// Breaks caught: live consumed rows suppressing a legitimate new challenge in
// either previous-row selection OR the INSERT reservation's NOT EXISTS predicate.
describe("R-21 consumed email-code reissue within the original live window", () => {
  it("delivers a distinct fresh code after cooldown and creates a second actual session exactly once", async () => {
    const f = await fixture();
    const original = codeIn(f.delivered[0]!);
    const firstCookie = sessionCookie(await f.verify(original));
    const firstSessions = await live(f, firstCookie);
    vi.setSystemTime(f.start + MINUTE + 1);
    const requested = await f.request();
    expect([200, 202]).toContain(requested.status);
    expect(requested.res.headers.getSetCookie()).toEqual([]);
    expect(f.delivered, "accepted is not delivery: used rows must not suppress reissue").toHaveLength(2);
    const next = codeIn(f.delivered[1]!);
    expect(next).not.toBe(original);
    expect(JSON.stringify(requested.body)).not.toContain(next);
    denied(await f.verify(original));
    const secondCookie = sessionCookie(await f.verify(next));
    expect(secondCookie).not.toBe(firstCookie);
    const sessions = await live(f, secondCookie);
    expect(sessions).toHaveLength(2);
    expect(sessions.map(({ id }) => id)).toContain(firstSessions[0]!.id);
    denied(await f.verify(next));
    denied(await f.verify(original));
    expect(await live(f, firstCookie)).toHaveLength(2);
    await noPlaintext(f);
  });

  it("does not deliver immediate or just-before-cooldown reissues of a spent code", async () => {
    const f = await fixture();
    const original = codeIn(f.delivered[0]!);
    const cookie = sessionCookie(await f.verify(original));
    const before = await challenges();
    for (const elapsed of [0, 30_000, MINUTE - 1]) {
      vi.setSystemTime(f.start + elapsed);
      const response = await f.request();
      expect([200, 202, 429]).toContain(response.status);
      expect(response.res.headers.getSetCookie()).toEqual([]);
      expect(f.attempts).toHaveLength(1);
      expect(await challenges()).toEqual(before);
    }
    denied(await f.verify(original));
    expect(await live(f, cookie)).toHaveLength(1);
  });

  it("two simultaneous legitimate reissues reserve and deliver only one new challenge", async () => {
    const f = await fixture();
    const original = codeIn(f.delivered[0]!);
    sessionCookie(await f.verify(original));
    vi.setSystemTime(f.start + MINUTE + 1);
    const responses = await Promise.all([f.request(), f.request()]);
    for (const response of responses) {
      expect([200, 202, 429]).toContain(response.status);
      expect(response.res.headers.getSetCookie()).toEqual([]);
    }
    expect(f.delivered, "both requests race the real D1 reservation, not a mocked response").toHaveLength(2);
    expect(f.attempts).toHaveLength(2);
    const available = (await challenges()).filter(({ row }) => row.used_at === null);
    expect(available, "at most one new unused challenge may be reserved").toHaveLength(1);
    const next = codeIn(f.delivered[1]!);
    expect(next).not.toBe(original);
    const verified = await Promise.all([f.verify(next), f.verify(next)]);
    const issued = verified.filter((response) => issuedSessionCookies(response).length > 0);
    expect(issued).toHaveLength(1);
    expect(await live(f, sessionCookie(issued[0]!))).toHaveLength(2);
    for (const response of verified.filter((entry) => !issuedSessionCookies(entry).length)) denied(response);
    denied(await f.verify(original));
    await noPlaintext(f);
  });

  it("fresh reissue has a full fifteen-minute lifetime without resurrecting the old proof", async () => {
    const f = await fixture();
    const original = codeIn(f.delivered[0]!);
    sessionCookie(await f.verify(original));
    const reissuedAt = f.start + 2 * MINUTE;
    vi.setSystemTime(reissuedAt);
    expect([200, 202]).toContain((await f.request()).status);
    expect(f.delivered).toHaveLength(2);
    const next = codeIn(f.delivered[1]!);
    vi.setSystemTime(reissuedAt + 15 * MINUTE - 1);
    sessionCookie(await f.verify(next));
    denied(await f.verify(original));
  });

  it("fresh reissue is refused exactly at its own fifteen-minute deadline", async () => {
    const f = await fixture();
    sessionCookie(await f.verify(codeIn(f.delivered[0]!)));
    const reissuedAt = f.start + 2 * MINUTE;
    vi.setSystemTime(reissuedAt);
    expect([200, 202]).toContain((await f.request()).status);
    expect(f.delivered).toHaveLength(2);
    const next = codeIn(f.delivered[1]!);
    vi.setSystemTime(reissuedAt + 15 * MINUTE);
    denied(await f.verify(next));
  });

  it("transient reissue delivery failure permits retry but never reopens the consumed original", async () => {
    const f = await fixture(2);
    const original = codeIn(f.delivered[0]!);
    const cookie = sessionCookie(await f.verify(original));
    vi.setSystemTime(f.start + MINUTE + 1);
    const failed = await f.request();
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.status).toBeLessThan(600);
    expect(f.attempts).toHaveLength(2);
    expect(f.delivered).toHaveLength(1);
    expect(failed.res.headers.getSetCookie()).toEqual([]);
    denied(await f.verify(original));
    const retry = await f.request();
    expect([200, 202]).toContain(retry.status);
    expect(f.attempts).toHaveLength(3);
    expect(f.delivered).toHaveLength(2);
    const next = codeIn(f.delivered[1]!);
    expect(next).not.toBe(original);
    sessionCookie(await f.verify(next));
    denied(await f.verify(next));
    denied(await f.verify(original));
    expect(await live(f, cookie)).toHaveLength(2);
    await noPlaintext(f);
  });
});

// Controls distinguish consumed success (eligible for fresh issuance) from a live
// unconsumed/locked challenge (same original guessing budget and expiry).
describe("R-21 reissue repair must not weaken unconsumed challenge controls", () => {
  it("unconsumed resend does not extend the original expiry", async () => {
    const f = await fixture();
    vi.setSystemTime(f.start + 2 * MINUTE);
    expect([200, 202]).toContain((await f.request()).status);
    expect(f.delivered).toHaveLength(2);
    const next = codeIn(f.delivered[1]!);
    vi.setSystemTime(f.start + 15 * MINUTE);
    denied(await f.verify(next));
  });

  it("unconsumed resend preserves four failed guesses; a fifth failure locks the new code", async () => {
    const f = await fixture();
    const original = codeIn(f.delivered[0]!);
    for (let i = 0; i < 4; i++) denied(await f.verify(wrong(original)));
    vi.setSystemTime(f.start + 2 * MINUTE);
    expect([200, 202]).toContain((await f.request()).status);
    expect(f.delivered).toHaveLength(2);
    const next = codeIn(f.delivered[1]!);
    denied(await f.verify(wrong(next)));
    denied(await f.verify(next));
  });

  it("a locked challenge is not a consumed-success reissue exemption", async () => {
    const f = await fixture();
    const original = codeIn(f.delivered[0]!);
    for (let i = 0; i < 5; i++) denied(await f.verify(wrong(original)));
    vi.setSystemTime(f.start + 2 * MINUTE);
    const response = await f.request();
    expect([200, 202, 400, 403, 429]).toContain(response.status);
    expect(response.res.headers.getSetCookie()).toEqual([]);
    for (const message of f.delivered) denied(await f.verify(codeIn(message)));
    expect((await storedRows()).filter(({ table }) => table === "sessions")).toEqual([]);
  });

  it.each(["correct fifth succeeds", "fifth failure locks", "original expiry remains"])(
    "transient unconsumed resend failure keeps the original budget: %s", async (control) => {
      const f = await fixture(2);
      const original = codeIn(f.delivered[0]!);
      for (let i = 0; i < 4; i++) denied(await f.verify(wrong(original)));
      vi.setSystemTime(f.start + 2 * MINUTE);
      const failed = await f.request();
      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect(f.attempts).toHaveLength(2);
      expect(f.delivered).toHaveLength(1);
      const retried = await f.request();
      expect([200, 202]).toContain(retried.status);
      expect(f.attempts).toHaveLength(3);
      expect(f.delivered).toHaveLength(2);
      const next = codeIn(f.delivered[1]!);
      if (control === "correct fifth succeeds") sessionCookie(await f.verify(next));
      else {
        if (control === "fifth failure locks") denied(await f.verify(wrong(next)));
        else vi.setSystemTime(f.start + 15 * MINUTE);
        denied(await f.verify(next));
      }
      await noPlaintext(f);
    },
  );

  it("wrong-email requests and verification neither deliver nor sign up, including after consumption", async () => {
    const f = await fixture();
    const original = codeIn(f.delivered[0]!);
    const before = (await storedRows()).filter(({ table }) => table === "members");
    denied(await f.verify(original, "unknown@example.com"));
    sessionCookie(await f.verify(original));
    vi.setSystemTime(f.start + 2 * MINUTE);
    const response = await f.request("unknown@example.com");
    expect([200, 202, 404]).toContain(response.status);
    expect(response.res.headers.getSetCookie()).toEqual([]);
    denied(await f.verify(original, "unknown@example.com"));
    expect(f.attempts).toHaveLength(1);
    expect((await storedRows()).filter(({ table }) => table === "members")).toEqual(before);
    await noPlaintext(f);
  });
});
