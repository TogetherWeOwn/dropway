import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anonymousSite, digest, env, freshInstance, issuedSessionCookies, loginLink, member, MINUTE,
  ORIGIN, pageForms, SAME_ORIGIN, sessionCookie, signedIn, storedRows, type Instance,
} from "./r21-helpers";

const NAVIGATION = { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function state() {
  return (await storedRows()).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function expectIdentity(dw: Instance, response: Response, memberId: string) {
  expect([200, 302, 303]).toContain(response.status);
  const cookie = sessionCookie(response);
  const listed = await dw.json("/api/v1/auth/sessions", { headers: { Cookie: cookie } });
  expect(listed.status).toBe(200);
  const hash = await digest(cookie.slice(cookie.indexOf("=") + 1));
  const rows = (await storedRows()).filter(({ table, row }) => table === "sessions" && Object.values(row).includes(hash));
  expect(rows).toHaveLength(1);
  expect(Object.values(rows[0]!.row)).toContain(memberId);
  const attributes = issuedSessionCookies(response)[0]!;
  expect(attributes).toMatch(/;\s*HttpOnly(?:;|$)/i);
  expect(attributes).toMatch(/;\s*SameSite=Lax(?:;|$)/i);
  const age = Number(attributes.match(/;\s*Max-Age=(\d+)/i)?.[1]);
  expect(age).toBeGreaterThan(0);
  expect(age).toBeLessThanOrEqual(30 * 24 * 60 * 60);
  return cookie;
}

async function formAt(dw: Instance, url: string, headers: HeadersInit = NAVIGATION) {
  const response = await dw.call(url, { headers });
  expect(response.status, "browser evidence must show identity confirmation, never silently exchange").toBe(200);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get("Cache-Control")).toMatch(/no-store/i);
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Content-Security-Policy")).toMatch(/frame-ancestors 'none'/);
  let visible = "";
  await new HTMLRewriter().on("body", { text(chunk) { visible += chunk.text; } }).transform(response.clone()).text();
  // Actual script execution/no-auto-submit evidence belongs to browser QA;
  // the Worker contract here is non-consuming inspection plus a native POST.
  expect(visible).toMatch(/sign\s*in/i);
  expect(visible).toMatch(/cancel/i);
  const forms = await pageForms(response);
  const form = forms.find((entry) => entry.method.toLowerCase() === "post");
  expect(form).toBeTruthy();
  const target = new URL(form!.action || url, ORIGIN);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe("/login/confirm");
  const token = new URL(url).searchParams.get("token")!;
  expect(Object.values(form!.fields)).toContain(token);
  return { visible, fields: form!.fields, target: target.href,
    submit: (postHeaders: Record<string, string>, fields = form!.fields, origin = ORIGIN) => dw.call(target.href.replace(ORIGIN, origin), {
      method: "POST", headers: postHeaders, body: new URLSearchParams(fields),
    }),
  };
}

const HTML_ACCEPTS: Array<[string, HeadersInit]> = [
  ["legacy HTML without metadata", { Accept: "text/html" }],
  ["XHTML without metadata", { Accept: "application/xhtml+xml" }],
  ["mixed case and parameters", { Accept: 'application/json, TeXt/HtMl ; charset="utf-8"; q=0.4' }],
  ["HTML q=0 is still restrictive", { Accept: "application/json, text/html;q=0" }],
  ["XHTML q=0", { Accept: "application/xhtml+xml;q=0, */*" }],
  ["quoted list separator before HTML", { Accept: 'application/json; note="a,b", text/html' }],
  ["quoted semicolon before XHTML", { Accept: 'application/json; note="a;b", application/xhtml+xml' }],
  ["repeated combined fields", [["Accept", "application/json"], ["Accept", "text/html;q=0"]]],
];

// Breaks caught: treating explicit legacy HTML as programmatic, substring matching,
// ignoring the complete Accept list, or mistaking metadata absence for browser attestation.
describe("R-21 final explicit browser evidence contract", () => {
  it.each(HTML_ACCEPTS)("%s renders the bearer target and leaves all authority unspent", async (_name, headers) => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const target = await member(dw, "link-owner@example.com");
    const link = await loginLink(dw, target.id, target.key);
    const before = await state();
    const page = await formAt(dw, link.url, headers);
    expect(page.visible).toContain(target.email);
    expect(await state()).toEqual(before);
    const again = await formAt(dw, link.url, headers);
    expect(again.visible).toContain(target.email);
    expect(await state()).toEqual(before);
    await expectIdentity(dw, await again.submit(SAME_ORIGIN), target.id);
    expect(issuedSessionCookies(await dw.call(link.url))).toEqual([]);
  });

  it.each([
    ["absent", undefined], ["JSON", "application/json"], ["wildcard", "*/*"],
    ["valid non-HTML prefix", "text/htmlfoo"], ["HTML only inside a parameter", 'application/json; note="text/html"'],
  ])("retains the actual consuming GET issuer for %s Accept and no metadata", async (_name, accept) => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const target = await member(dw);
    const link = await loginLink(dw, target.id, target.key);
    const response = await dw.call(link.url, { headers: accept === undefined ? {} : { Accept: accept } });
    await expectIdentity(dw, response, target.id);
    expect(issuedSessionCookies(await dw.call(link.url))).toEqual([]);
  });

  it.each(["", "   ", "not-a-media-type", "application/json,", "application/json,,text/plain", 'application/json; note="unterminated', "application/json;q=banana"])(
    "fails closed on malformed/empty Accept %j without spending proof", async (accept) => {
      const dw = await freshInstance({ appOrigin: ORIGIN });
      const link = await loginLink(dw);
      const before = await state();
      const response = await dw.call(link.url, { headers: { Accept: accept } });
      expect.soft(response.status).toBe(400);
      expect.soft(response.headers.getSetCookie()).toEqual([]);
      expect.soft(await state()).toEqual(before);
      expect((await response.text()).includes(link.token)).toBe(false);
      sessionCookie(await dw.call(link.url, { headers: { Accept: "application/json" } }));
    },
  );

  const metadataCases = ["Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User", "sEc-FeTcH-Custom"]
    .flatMap((name) => ["", " ", "?1"].flatMap((value) => ["application/json", "*/*"].map((accept) => ({ name, value, accept }))));
  it.each(metadataCases)("$name=$value presence overrides Accept=$accept", async ({ name, value, accept }) => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const link = await loginLink(dw);
    const before = await state();
    await formAt(dw, link.url, { Accept: accept, [name]: value });
    expect(await state()).toEqual(before);
    sessionCookie(await dw.call(link.url));
  });

  it("escapes the actual destination identity rather than rendering member HTML", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const target = await member(dw, "<img-src=x>@example.com");
    const link = await loginLink(dw, target.id, target.key);
    const response = await dw.call(link.url, { headers: NAVIGATION });
    expect(response.status).toBe(200);
    let injected = 0;
    await new HTMLRewriter().on("img-src", { element() { injected++; } }).transform(response.clone()).text();
    expect(injected).toBe(0);
    expect(await response.text()).toContain("&lt;img-src=x&gt;@example.com");
  });

  it("confirmation inspection cannot slide a same-member old session, even with both write headers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dw = await freshInstance({ appOrigin: ORIGIN, anonymous: { enabled: true } });
    const active = await signedIn(dw);
    const link = await loginLink(dw);
    await anonymousSite(dw);
    vi.setSystemTime(Date.now() + 61 * MINUTE);
    // Mint a fresh link only after aging the existing session past its refresh threshold.
    const current = await loginLink(dw);
    const before = await state();
    await formAt(dw, current.url, { ...NAVIGATION, ...SAME_ORIGIN, Cookie: active.cookie });
    expect.soft(await state(), "GET inspection is read-only, including last_seen_at/expires_at and claim rows").toEqual(before);
    const response = await dw.call(current.url);
    sessionCookie(response);
    expect(issuedSessionCookies(await dw.call(link.url))).toEqual([]);
  });

  it("legacy HTML with a same-member cookie remains inspection, not reauthentication", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    const link = await loginLink(dw);
    const before = await state();
    await formAt(dw, link.url, { Accept: "text/html", Cookie: active.cookie });
    expect(await state()).toEqual(before);
    sessionCookie(await dw.call(link.url, { headers: { Cookie: active.cookie } }));
  });

  it("legacy HTML cannot swap a different real account or spend the link", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const active = await signedIn(dw);
    const target = await member(dw, "other-member@example.com");
    const link = await loginLink(dw, target.id, target.key);
    const before = await state();
    const response = await dw.call(link.url, { headers: { Accept: "text/html", Cookie: active.cookie } });
    expect([403, 409]).toContain(response.status);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await state()).toEqual(before);
    const text = await response.text();
    expect(text).not.toContain(target.email);
    expect(text).not.toContain(link.token);
    expect((await dw.call("/api/v1/auth/sessions", { headers: { Cookie: active.cookie } })).status).toBe(200);
    await expectIdentity(dw, await dw.call(link.url), target.id);
  });
});

const REFUSED_HEADERS: Array<[string, Record<string, string>]> = [
  ["both missing", {}], ["missing Origin", { "Sec-Fetch-Site": "same-origin" }],
  ["missing Fetch Metadata", { Origin: ORIGIN }],
  ...["", "null", "https://dropway.test:443", "https://attacker.example", "https://sites.dropway.test", "https://sibling.workers.dev", "http://dropway.test", "https://dropway.test:444", "https://dropway.test.attacker.example", "https://dropway.test/"].map(
    (origin): [string, Record<string, string>] => [`Origin ${origin}`, { Origin: origin, "Sec-Fetch-Site": "same-origin" }]),
  ...["", "same-site", "cross-site", "none", "Same-Origin"].map(
    (site): [string, Record<string, string>] => [`Fetch-Site ${site}`, { Origin: ORIGIN, "Sec-Fetch-Site": site }]),
];

// Breaks caught: either header treated as optional, guard after body/consume,
// HTML confirmation reserving a token, or confirmation replacing a different account.
describe("R-21 native confirmation retains both independent write fences", () => {
  for (const withCookie of [false, true]) {
    it.each(REFUSED_HEADERS)(`refuses %s without burning proof (cookie=${withCookie})`, async (_name, headers) => {
      const dw = await freshInstance({ appOrigin: ORIGIN });
      const active = withCookie ? await signedIn(dw) : undefined;
      const link = await loginLink(dw);
      const page = await formAt(dw, link.url);
      const before = await state();
      const postHeaders = { ...headers, ...(active ? { Cookie: active.cookie } : {}) };
      const rejected = await page.submit(postHeaders);
      expect(rejected.status).toBe(403);
      expect(rejected.headers.getSetCookie()).toEqual([]);
      expect(await state()).toEqual(before);
      expect(await rejected.text()).not.toContain(link.token);
      const invalid = await dw.call(page.target, { method: "POST", headers: postHeaders, body: "not-a-valid-form" });
      expect(invalid.status, "guard must precede proof/body validation").toBe(403);
      expect(invalid.headers.getSetCookie()).toEqual([]);
      expect(await state()).toEqual(before);
      sessionCookie(await page.submit(SAME_ORIGIN));
    });
  }

  it("legacy confirmation and claim with only Origin remain unsupported, not an automatic claim exploit", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN, anonymous: { enabled: true } });
    const site = await anonymousSite(dw);
    const active = await signedIn(dw);
    const link = await loginLink(dw);
    const page = await formAt(dw, link.url);
    const before = await state();
    const headers = { Origin: ORIGIN, Cookie: active.cookie };
    expect((await page.submit(headers)).status).toBe(403);
    const claimPage = await dw.call(`/claim?slug=${site.slug}`, { headers: { Cookie: active.cookie } });
    const claimForm = (await pageForms(claimPage)).find((form) => "claimToken" in form.fields);
    expect(claimForm).toBeTruthy();
    const claim = await dw.call(new URL(claimForm!.action || `/claim?slug=${site.slug}`, ORIGIN).href, {
      method: "POST", headers, body: new URLSearchParams({ ...claimForm!.fields, claimToken: site.token }),
    });
    expect(claim.status).toBe(403);
    expect(claim.headers.getSetCookie()).toEqual([]);
    expect(await state()).toEqual(before);
    sessionCookie(await page.submit(SAME_ORIGIN));
  });

  it.each(["http://dropway.test", "https://not-the-app.example"])("refuses confirmation on request origin %s before consume", async (origin) => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const link = await loginLink(dw);
    const page = await formAt(dw, link.url);
    const before = await state();
    const response = await page.submit(SAME_ORIGIN, page.fields, origin);
    expect([400, 403]).toContain(response.status);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await state()).toEqual(before);
    sessionCookie(await page.submit(SAME_ORIGIN));
  });

  it("exact headers redeem the displayed target once through the native form and real issuer", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const target = await member(dw, "native-target@example.com");
    const link = await loginLink(dw, target.id, target.key);
    const page = await formAt(dw, link.url);
    expect(page.visible).toContain(target.email);
    await expectIdentity(dw, await page.submit(SAME_ORIGIN), target.id);
    expect(issuedSessionCookies(await page.submit(SAME_ORIGIN))).toEqual([]);
    expect(issuedSessionCookies(await dw.call(link.url))).toEqual([]);
  });

  it.each(["POST/POST", "programmatic GET/POST"])("%s races issue exactly one real session", async (race) => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const target = await member(dw);
    const link = await loginLink(dw, target.id, target.key);
    const page = await formAt(dw, link.url);
    const responses = await Promise.all([
      race === "POST/POST" ? page.submit(SAME_ORIGIN) : dw.call(link.url), page.submit(SAME_ORIGIN),
    ]);
    const issued = responses.filter((response) => issuedSessionCookies(response).length > 0);
    expect(issued).toHaveLength(1);
    await expectIdentity(dw, issued[0]!, target.id);
    expect((await storedRows()).filter(({ table }) => table === "sessions")).toHaveLength(1);
    expect(issuedSessionCookies(await page.submit(SAME_ORIGIN))).toEqual([]);
    expect(issuedSessionCookies(await dw.call(link.url))).toEqual([]);
  });

  it("rechecks expiry between view and POST without extending the original deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const link = await loginLink(dw);
    vi.setSystemTime(Date.now() + 15 * MINUTE - 1);
    const page = await formAt(dw, link.url);
    const before = await state();
    vi.setSystemTime(Date.now() + 1);
    const response = await page.submit(SAME_ORIGIN);
    expect([400, 401, 403, 410]).toContain(response.status);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await state()).toEqual(before);
  });

  it("rechecks account mismatch introduced after the view, leaving the target link unspent", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const target = await member(dw, "target@example.com");
    const link = await loginLink(dw, target.id, target.key);
    const page = await formAt(dw, link.url);
    const active = await signedIn(dw);
    const before = await state();
    const response = await page.submit({ ...SAME_ORIGIN, Cookie: active.cookie });
    expect([403, 409]).toContain(response.status);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await state()).toEqual(before);
    await expectIdentity(dw, await page.submit(SAME_ORIGIN), target.id);
  });

  it("the posted bearer is independently validated; caller-supplied member identity is not authority", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const a = await member(dw, "displayed@example.com");
    const b = await member(dw, "posted-bearer@example.com");
    const first = await loginLink(dw, a.id, a.key);
    const second = await loginLink(dw, b.id, b.key);
    const page = await formAt(dw, first.url);
    expect(page.visible).toContain(a.email);
    const fields = Object.fromEntries(Object.entries(page.fields).map(([key, value]) => [key, value === first.token ? second.token : value]));
    await expectIdentity(dw, await page.submit(SAME_ORIGIN, { ...fields, memberId: a.id }), b.id);
    // No prior-GET nonce or substituted weaker proof: first token is still unspent.
    await expectIdentity(dw, await page.submit(SAME_ORIGIN), a.id);
    expect(issuedSessionCookies(await dw.call(second.url))).toEqual([]);
  });

  it.each(["invalid", "consumed", "expired"])("refuses %s bearer confirmation without cookie or authority mutations", async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const link = await loginLink(dw);
    const page = await formAt(dw, link.url);
    if (kind === "consumed") sessionCookie(await dw.call(link.url));
    if (kind === "expired") vi.setSystemTime(Date.now() + 15 * MINUTE);
    const fields = kind === "invalid" ? Object.fromEntries(Object.entries(page.fields).map(([key, value]) => [key, value === link.token ? "not-a-login-token" : value])) : page.fields;
    const before = await state();
    const response = await page.submit(SAME_ORIGIN, fields);
    expect([400, 401, 403, 410]).toContain(response.status);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await state()).toEqual(before);
    expect(await response.text()).not.toContain(link.token);
    if (kind === "invalid") sessionCookie(await page.submit(SAME_ORIGIN));
  });

  it("rechecks tenant disablement after the view before consuming or issuing", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const link = await loginLink(dw);
    const page = await formAt(dw, link.url);
    // Test-only administrative state change in real emulated D1, never an issuer.
    await env.DB.prepare("UPDATE tenants SET disabled_at = ?").bind(Date.now()).run();
    const before = await state();
    const response = await page.submit(SAME_ORIGIN);
    expect([400, 401, 403, 410]).toContain(response.status);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await state()).toEqual(before);
    await env.DB.prepare("UPDATE tenants SET disabled_at = NULL").run();
    sessionCookie(await page.submit(SAME_ORIGIN));
  });

  it("rechecks member removal after the view instead of trusting rendered identity", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN });
    const target = await member(dw);
    const link = await loginLink(dw, target.id, target.key);
    const page = await formAt(dw, link.url);
    expect((await dw.call(`/api/v1/members/${target.id}`, { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    const before = await state();
    const response = await page.submit(SAME_ORIGIN);
    expect([400, 401, 403, 404, 410]).toContain(response.status);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await state()).toEqual(before);
  });
});
