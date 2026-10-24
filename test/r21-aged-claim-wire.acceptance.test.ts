import { afterEach, describe, expect, it, vi } from "vitest";
import { callWithBindings, ORIGIN, SAME_ORIGIN } from "./r21-helpers";
import {
  AGED, claimFixture, expectOversize, measuredBody, observedD1, paddedForm,
  rowsSnapshot, sessionRow, START, WIRE_CAP,
} from "./r21-remaining-contract.helpers";

afterEach(() => vi.useRealTimers());
function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
}

async function unchanged(f: Awaited<ReturnType<typeof claimFixture>>, before: string, writes: string[]) {
  expect.soft(writes, "refusal must precede every executed D1 write, even an otherwise legitimate hourly slide").toEqual([]);
  const row = await sessionRow(f.active.cookie);
  expect.soft(row.expires_at, "oversize cannot extend D1 authority before parsing").toBe(f.before.expires_at);
  expect.soft(row.last_seen_at, "oversize cannot record activity before parsing").toBe(f.before.last_seen_at);
  expect.soft((await rowsSnapshot()) === before, "all session, member, site, proof and other D1 rows remain identical").toBe(true);
}

// Breaks caught: a body cap implemented after session resolution still slides an
// old cookie's D1 authority; young-cookie rejection tests cannot detect that bug.
// Real issuance and Date-only advancement, not manually inserted session rows.
// Every actual body is <= 65,537 bytes; all bindings are local workerd storage.
describe("R-21 aged /claim refusal must precede session sliding", () => {
  it("rejects declared oversize before any pull or aged-session/proof mutation", async () => {
    clock();
    const f = await claimFixture();
    vi.setSystemTime(AGED);
    const before = await rowsSnapshot();
    const observed = observedD1();
    const body = measuredBody(new TextEncoder().encode(new URLSearchParams(f.fields).toString()));
    const response = await f.post(body.stream, { ...SAME_ORIGIN, "Content-Length": "65537" }, observed.db);
    await expectOversize(response);
    expect.soft(body.measure.pulls, "declared oversize must not pull even a small actual body").toBe(0);
    expect.soft(body.measure.bytes).toBe(0);
    await unchanged(f, before, observed.writes);
  });

  for (const length of ["absent", "understated"] as const) {
    it.each(["ASCII", "UTF-8"] as const)(`cancels %s overflow with ${length} Content-Length before sliding the aged session`, async (alphabet) => {
      clock();
      const f = await claimFixture();
      vi.setSystemTime(AGED);
      const before = await rowsSnapshot();
      const observed = observedD1();
      let writesAtFirstPull: number | undefined;
      const body = measuredBody(paddedForm(f.fields, WIRE_CAP + 1, alphabet), () => {
        writesAtFirstPull ??= observed.writes.length;
      });
      const response = await f.post(body.stream, {
        ...SAME_ORIGIN, ...(length === "understated" ? { "Content-Length": "1" } : {}),
      }, observed.db);
      await expectOversize(response);
      expect.soft(writesAtFirstPull, "even the first body read must not follow a sliding session write").toBe(0);
      expect.soft(body.measure.bytes).toBe(65_537);
      expect.soft(body.measure.cancelled, "cancel the original stream on the overflow byte").toBe(true);
      expect.soft(body.measure.eof, "do not buffer until EOF before refusing").toBe(false);
      await unchanged(f, before, observed.writes);
    });
  }

  it.each(["ASCII", "UTF-8"] as const)("refuses buffered %s overflow without aged-session or claim effects", async (alphabet) => {
    clock();
    const f = await claimFixture();
    vi.setSystemTime(AGED);
    const before = await rowsSnapshot();
    const observed = observedD1();
    await expectOversize(await f.post(paddedForm(f.fields, WIRE_CAP + 1, alphabet), SAME_ORIGIN, observed.db));
    await unchanged(f, before, observed.writes);
  });
});

// Breaks caught: rejecting every old cookie/form, counting UTF-16 characters, or
// an observation wrapper that cannot see a real, allowed sliding D1 execution.
describe("R-21 aged-session real claim and slide positive controls", () => {
  it("still claims with a small native form after the session's idle hour", async () => {
    clock();
    const f = await claimFixture();
    vi.setSystemTime(AGED);
    await f.expectClaimed(await f.post());
  });

  it.each(["ASCII", "UTF-8"] as const)("still claims with exactly 65,536 %s streamed wire bytes after the idle hour", async (alphabet) => {
    clock();
    const f = await claimFixture();
    vi.setSystemTime(AGED);
    const body = measuredBody(paddedForm(f.fields, WIRE_CAP, alphabet));
    await f.expectClaimed(await f.post(body.stream));
    expect(body.measure.bytes).toBe(65_536);
    expect(body.measure.eof).toBe(true);
    expect(body.measure.cancelled).toBe(false);
  });

  it("the genuine aged cookie is slide-eligible and the real-D1 observer detects explicit refresh", async () => {
    clock();
    const f = await claimFixture();
    vi.setSystemTime(AGED);
    const observed = observedD1();
    const response = await callWithBindings(f.dw, "/api/v1/auth/sessions/refresh", { DB: observed.db }, {
      method: "POST", headers: { ...SAME_ORIGIN, Cookie: f.active.cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ refreshed: true });
    expect(observed.writes.some((sql) => /UPDATE\s+sessions\b/i.test(sql))).toBe(true);
    const row = await sessionRow(f.active.cookie);
    expect(row.expires_at).toBe(AGED + 30 * 86_400_000);
    expect(row.last_seen_at).toBe(AGED);
    expect(response.headers.getSetCookie().length).toBe(1);
  });
});

const DENIED: Array<{ name: string; headers: Record<string, string> }> = [
  { name: "missing Origin independently", headers: { "Sec-Fetch-Site": "same-origin" } },
  { name: "wrong Origin independently", headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "same-origin" } },
  { name: "missing Fetch Metadata independently", headers: { Origin: ORIGIN } },
  { name: "wrong Fetch Metadata independently", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" } },
];

// Breaks caught: OR rather than AND for the two browser fences, or a size check /
// identity resolver that reads or mutates before refusing either browser header.
for (const size of ["small", "overflow"] as const) {
  describe(`R-21 aged-session ${size} claim independent browser fences`, () => {
    it.each(DENIED)("refuses $name before reading or mutating, preserving the original proof", async ({ headers }) => {
      clock();
      const f = await claimFixture();
      vi.setSystemTime(AGED);
      const before = await rowsSnapshot();
      const observed = observedD1();
      const bytes = size === "small" ? new TextEncoder().encode(new URLSearchParams(f.fields).toString()) : paddedForm(f.fields, WIRE_CAP + 1);
      const body = measuredBody(bytes);
      const response = await f.post(body.stream, headers, observed.db);
      expect.soft(response.status).toBe(403);
      expect.soft(response.headers.getSetCookie()).toEqual([]);
      expect.soft(body.measure.pulls, "browser denial takes precedence over size/parsing").toBe(0);
      expect.soft(body.measure.bytes).toBe(0);
      await unchanged(f, before, observed.writes);
      await f.expectClaimed(await f.post());
    });
  });
}
