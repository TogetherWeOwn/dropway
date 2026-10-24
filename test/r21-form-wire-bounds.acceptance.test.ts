import { describe, expect, it } from "vitest";
import { anonymousSite, freshInstance, issuedSessionCookies, ORIGIN, SAME_ORIGIN } from "./r21-helpers";
import {
  FORM_BYTES, FORM_PATHS, expectFormError, formBytes, formFixture, formState, measuredForm,
} from "./r21-form-wire-bounds.helpers";

const FORM = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };
const ALPHABETS = ["ASCII", "UTF-8"] as const;
const STREAM_MODES = ["no Content-Length", "understated Content-Length"] as const;
const DENIED: Array<{ name: string; headers: Record<string, string> }> = [
  { name: "missing Origin", headers: { "Sec-Fetch-Site": "same-origin" } },
  { name: "hostile Origin", headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "same-origin" } },
  { name: "missing Fetch Metadata", headers: { Origin: ORIGIN } },
  { name: "hostile Fetch Metadata", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" } },
];

// Breaks caught: buffering text before applying the cap, trusting Content-Length,
// counting UTF-16 characters, or checking size after proof/ownership/email effects.
// All requests execute in the local Worker with real D1/R2/KV and real issuers.
// Each actual input is at most 65,537 bytes. No provider or external fetch is used.
describe.each(FORM_PATHS)("R-21 64KiB URL-encoded wire ceiling: %s", (path) => {
  it("refuses an oversized declared length before the first stream pull", async () => {
    const f = await formFixture(path);
    const before = await formState();
    const mail = structuredClone(f.delivered);
    // The actual body is small: the declared length alone must prevent reading.
    const body = measuredForm(new TextEncoder().encode(new URLSearchParams(f.fields).toString()));
    const response = await f.post(body.stream, { ...SAME_ORIGIN, ...FORM, "Content-Length": "65537" });
    await expectFormError(response, 413, "request_too_large");
    expect.soft(body.measurement.pulls, "declared oversize must not buffer even one chunk").toBe(0);
    expect.soft(body.measurement.bytes).toBe(0);
    expect.soft(await formState(), "no proof consumption, challenge attempts/reset, new session or ownership change").toEqual(before);
    expect.soft(f.delivered).toEqual(mail);
  });

  for (const mode of STREAM_MODES) {
    it.each(ALPHABETS)(`cancels a 65,537-byte %s stream with ${mode} before reading EOF`, async (alphabet) => {
      const f = await formFixture(path);
      const before = await formState();
      const mail = structuredClone(f.delivered);
      const body = measuredForm(formBytes(f.fields, FORM_BYTES + 1, alphabet));
      const response = await f.post(body.stream, {
        ...SAME_ORIGIN, ...FORM, ...(mode === "understated Content-Length" ? { "Content-Length": "1" } : {}),
      });
      await expectFormError(response, 413, "request_too_large");
      expect.soft(body.measurement.bytes, "read enough wire bytes to discover overflow, never trust the declaration").toBe(FORM_BYTES + 1);
      expect.soft(body.measurement.cancelled, "overflow must cancel the original stream, not just reject after .text()").toBe(true);
      expect.soft(body.measurement.eof, "do not ask for another chunk after observing the overflow byte").toBe(false);
      expect.soft(await formState(), "all persisted authority and resource rows stay byte-identical").toEqual(before);
      expect.soft(f.delivered, "no email delivery/reissue at the adapter boundary").toEqual(mail);
    });
  }

  it.each(ALPHABETS)("returns the same 413 contract for a buffered 65,537-byte %s body", async (alphabet) => {
    const f = await formFixture(path);
    const before = await formState();
    const mail = structuredClone(f.delivered);
    const response = await f.post(formBytes(f.fields, FORM_BYTES + 1, alphabet), { ...SAME_ORIGIN, ...FORM });
    await expectFormError(response, 413, "request_too_large");
    expect.soft(await formState()).toEqual(before);
    expect.soft(f.delivered).toEqual(mail);
  });

  it("positive control: a small native URLSearchParams form retains genuine proof and identity", async () => {
    const f = await formFixture(path);
    await f.expectSuccess(await f.post());
  });

  it.each(ALPHABETS)("positive control: exactly 65,536 %s wire bytes are accepted", async (alphabet) => {
    const f = await formFixture(path);
    const body = measuredForm(formBytes(f.fields, FORM_BYTES, alphabet));
    await f.expectSuccess(await f.post(body.stream, { ...SAME_ORIGIN, ...FORM }));
    expect(body.measurement.bytes).toBe(FORM_BYTES);
    expect(body.measurement.eof, "an exactly-at-cap body needs its normal EOF, not an early rejection").toBe(true);
    expect(body.measurement.cancelled).toBe(false);
  });

  for (const size of ["small", "oversized"] as const) {
    it.each(DENIED)(`retains the independent $name fence on a ${size} form without mutation`, async ({ headers }) => {
      const f = await formFixture(path);
      const before = await formState();
      const mail = structuredClone(f.delivered);
      const bytes = size === "small" ? new TextEncoder().encode(new URLSearchParams(f.fields).toString()) : formBytes(f.fields, FORM_BYTES + 1);
      const body = measuredForm(bytes);
      const response = await f.post(body.stream, { ...FORM, ...headers });
      expect.soft(response.status).toBe(403);
      expect.soft(issuedSessionCookies(response)).toEqual([]);
      expect.soft(body.measurement.pulls, "browser fences precede parsing and all side effects").toBe(0);
      expect.soft(await formState()).toEqual(before);
      expect.soft(f.delivered).toEqual(mail);
      // Same genuine proof remains usable after a refusal; no synthetic session.
      await f.expectSuccess(await f.post());
    });
  }
});

describe("R-21 form bound does not substitute for claim proof", () => {
  it.each(["small", "exactly at cap"])("rejects a %s form containing another anonymous site's proof", async (size) => {
    const f = await formFixture("/claim");
    const other = await anonymousSite(f.dw);
    const fields = { ...f.fields, claimToken: other.token };
    const before = await formState();
    const body = size === "small" ? new URLSearchParams(fields) : formBytes(fields, FORM_BYTES);
    const response = await f.post(body, { ...SAME_ORIGIN, ...FORM });
    expect([400, 403, 404]).toContain(response.status);
    expect(issuedSessionCookies(response)).toEqual([]);
    expect(await formState()).toEqual(before);
    await f.expectSuccess(await f.post());
  });
});

it("R-21 oversized email reissue cannot reset an existing genuine challenge or its failed attempt", async () => {
  const f = await formFixture("/api/v1/auth/email-code");
  const issued = await f.post();
  expect(issued.status).toBe(303);
  expect(f.delivered).toHaveLength(1);
  const code = f.delivered[0]!.text.match(/\b\d{6}\b/)?.[0];
  expect(code).toBeTruthy();
  const wrong = code === "000000" ? "111111" : "000000";
  const refused = await f.dw.call("/api/v1/auth/email-code/verify", {
    method: "POST", headers: SAME_ORIGIN, body: new URLSearchParams({ email: f.target.email, code: wrong }),
  });
  expect([400, 401, 403]).toContain(refused.status);
  const before = await formState();
  expect(before.filter(({ table }) => table === "email_codes").map(({ row }) => row.attempts)).toEqual([1]);
  const mail = structuredClone(f.delivered);
  const body = measuredForm(formBytes(f.fields, FORM_BYTES + 1, "UTF-8"));
  const response = await f.post(body.stream, { ...SAME_ORIGIN, ...FORM });
  await expectFormError(response, 413, "request_too_large");
  expect.soft(body.measurement.cancelled).toBe(true);
  expect.soft(body.measurement.eof).toBe(false);
  expect.soft(await formState(), "neither code hash, attempt counter nor deadline may reset").toEqual(before);
  expect.soft(f.delivered, "no replacement code may be sent").toEqual(mail);
  await f.expectSuccess(issued);
});

const EMAIL_PATHS = ["/api/v1/auth/email-code", "/api/v1/auth/email-code/verify"] as const;
describe.each(EMAIL_PATHS)("R-21 unchanged JSON/optional email contracts: %s", (path) => {
  it("retains small JSON sign-in through the genuine issuer", async () => {
    const f = await formFixture(path);
    await f.expectSuccess(await f.post(JSON.stringify(f.fields), { ...SAME_ORIGIN, "Content-Type": "application/json" }));
  });

  it("does not apply the new 64KiB form cap to JSON within its existing budget", async () => {
    const f = await formFixture(path);
    const prefix = JSON.stringify({ ...f.fields, padding: "" });
    const body = JSON.stringify({ ...f.fields, padding: "x".repeat(FORM_BYTES + 1 - new TextEncoder().encode(prefix).byteLength) });
    expect(new TextEncoder().encode(body).byteLength).toBe(65_537);
    await f.expectSuccess(await f.post(body, { ...SAME_ORIGIN, "Content-Type": "application/json" }));
  });

  it("still refuses JSON declared above the existing 8MiB budget without reading", async () => {
    const f = await formFixture(path);
    const before = await formState();
    const mail = structuredClone(f.delivered);
    const body = measuredForm(new TextEncoder().encode(JSON.stringify(f.fields)));
    const response = await f.post(body.stream, { ...SAME_ORIGIN, "Content-Type": "application/json", "Content-Length": "8388609" });
    await expectFormError(response, 413, "request_too_large");
    expect(body.measurement.pulls).toBe(0);
    expect(await formState()).toEqual(before);
    expect(f.delivered).toEqual(mail);
    await f.expectSuccess(await f.post());
  });

  it("retains malformed JSON refusal without spending proof or sending email", async () => {
    const f = await formFixture(path);
    const before = await formState();
    const mail = structuredClone(f.delivered);
    const response = await f.post("{", { ...SAME_ORIGIN, "Content-Type": "application/json" });
    expect(response.status).toBe(400);
    expect(issuedSessionCookies(response)).toEqual([]);
    expect(await formState()).toEqual(before);
    expect(f.delivered).toEqual(mail);
    await f.expectSuccess(await f.post());
  });

  for (const size of ["small", "oversized"] as const) {
    it.each([
      { name: "both browser headers absent", headers: {} },
      { name: "both legitimate browser headers", headers: SAME_ORIGIN },
    ])(`without email, a ${size} native form keeps feature_unavailable with $name`, async ({ headers }) => {
      const dw = await freshInstance({ appOrigin: ORIGIN });
      const before = await formState();
      const fields = { email: "owner@example.com", code: "123456" };
      const bytes = size === "small" ? new TextEncoder().encode(new URLSearchParams(fields).toString()) : formBytes(fields, FORM_BYTES + 1);
      const body = measuredForm(bytes);
      const response = await dw.call(path, { method: "POST", body: body.stream, headers: {
        ...FORM, ...headers, "Content-Length": String(bytes.byteLength),
      } });
      await expectFormError(response, 501, "feature_unavailable");
      expect(await formState()).toEqual(before);
    });
  }
});
