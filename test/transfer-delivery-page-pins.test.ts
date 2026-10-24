// Companion pins for the TogetherWeOwn/kofra#31 review findings (TOG-39681).
// The acceptance file test/transfer-delivery-pages.acceptance.test.ts is
// PROTECTED (Test Author owned), so the two behaviours the Paperclip review
// proved unpinned are pinned here instead, through the same public HTTP
// surface: recipient context on re-rendered unlock forms (403, 429) and the
// 503 back link, plus exact Retry-After preservation on the HTML 429.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGIN, type Instance } from "./helpers";
import { request } from "./delivery-review-fixtures";
import { create, instance, unlock } from "./transfer-fixtures";

const PASSWORD = "companion-pin-passphrase";
const WRONG_PASSWORD = "wrong-companion-password";
const WINDOW_MS = 15 * 60_000;

let dw: Instance;
beforeEach(async () => { dw = await instance(); });
afterEach(() => { vi.useRealTimers(); });

/** Post the live password form for url, returning the raw response. */
async function postPassword(
  url: string,
  password: string,
  accept: string,
  ip: string,
  bindings: { DB?: D1Database } = {},
): Promise<Response> {
  const page = await dw.call(url, { headers: { Accept: "text/html" } });
  expect(page.headers.get("content-type")).toContain("text/html");
  let action: string | null = null;
  await new HTMLRewriter().on("form", {
    element(e) { action = e.getAttribute("action"); },
  }).transform(page).text();
  expect(action, "locked delivery must render a password form").toBeTruthy();
  const target = new URL(action!, url).href;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
      Accept: accept,
      "CF-Connecting-IP": ip,
    },
    body: new URLSearchParams({ password }),
  };
  return Object.keys(bindings).length ? request(dw, target, init, bindings) : dw.call(target, init);
}

/** Recipient token carried by the re-rendered form action inside error HTML. */
function recipientOfForm(html: string, base: string): string | null {
  const action = html.match(/<form[^>]*action="([^"]*)"/i)?.[1];
  expect(action, "error page must re-render the password form").toBeTruthy();
  return new URL(action!.replaceAll("&amp;", "&"), base).searchParams.get("recipient");
}

/** Recipient token carried by the "Back to this delivery" link. */
function recipientOfBackLink(html: string, base: string): string | null {
  const href = html.match(/<a[^>]*href="([^"]*)"[^>]*>Back to this delivery<\/a>/i)?.[1];
  expect(href, "unavailable page must link back to the delivery").toBeTruthy();
  return new URL(href!.replaceAll("&amp;", "&"), base).searchParams.get("recipient");
}

/** Fail the unlock counter closed, keeping routing, gates and KDF real. */
function unavailableBucketsDb(): D1Database {
  const faulted = (raw: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(raw, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => faulted(target.bind(...values));
        if (property === "first") return async () => null;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => (/transfer_unlock_buckets/i.test(sql) ? faulted(target.prepare(sql)) : target.prepare(sql));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("unlock error re-renders preserve recipient context", () => {
  it("403 wrong-password form posts back to the recipient URL", async () => {
    const t = await create(dw, { slug: "pin-locked-parcel", password: PASSWORD });
    const recipientUrl = t.recipients[0]!.url;
    const token = new URL(recipientUrl).searchParams.get("recipient");
    expect(token, "fixture must use a real recipient link").toBeTruthy();
    const res = await postPassword(recipientUrl, WRONG_PASSWORD, "text/html", "192.0.2.110");
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toMatch(/<form[^>]*method=["']post["']/i);
    expect(recipientOfForm(html, recipientUrl), "re-rendered 403 form must keep the recipient token").toBe(token);

    const generic = await postPassword(t.url, WRONG_PASSWORD, "text/html", "192.0.2.110");
    expect(generic.status).toBe(403);
    expect(recipientOfForm(await generic.text(), t.url), "generic form must not gain a recipient").toBeNull();
  });

  it("429 rate-limit form keeps the recipient and the exact Retry-After", async () => {
    // Freeze the clock mid-window so the JSON and HTML 429s share one window
    // end and their Retry-After values must be exactly equal (600s here, far
    // from any constant a regression could substitute).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + 5 * 60_000);
    const a = await create(dw, { slug: "pin-limited-a", password: PASSWORD });
    const b = await create(dw, { slug: "pin-limited-b", password: PASSWORD });
    let limited = false;
    for (let i = 0; i < 60 && !limited; i++) {
      const probe = await unlock(dw, i % 2 ? a : b, WRONG_PASSWORD, "192.0.2.111");
      if (probe.status === 429) limited = true;
      else expect([400, 401, 403]).toContain(probe.status);
      await probe.text().catch(() => {});
    }
    expect(limited, "finite per-IP unlock budget").toBe(true);

    const recipientUrl = a.recipients[0]!.url;
    const token = new URL(recipientUrl).searchParams.get("recipient");
    const json = await postPassword(recipientUrl, WRONG_PASSWORD, "application/json", "192.0.2.111");
    expect(json.status).toBe(429);
    const retryAfter = (await json.json() as { error: { details: { retryAfterSeconds: number } } }).error.details.retryAfterSeconds;
    expect(retryAfter, "JSON 429 must carry the real wait").toBeGreaterThan(120);

    const page = await postPassword(recipientUrl, WRONG_PASSWORD, "text/html", "192.0.2.111");
    expect(page.status).toBe(429);
    expect(page.headers.get("retry-after"), "HTML 429 must preserve the exact Retry-After").toBe(String(retryAfter));
    const html = await page.text();
    expect(html).toMatch(/<form[^>]*method=["']post["']/i);
    expect(recipientOfForm(html, recipientUrl), "re-rendered 429 form must keep the recipient token").toBe(token);
  });

  it("503 unlock-unavailable page links back to the recipient URL", async () => {
    const t = await create(dw, { slug: "pin-unavailable-parcel", password: PASSWORD });
    const recipientUrl = t.recipients[0]!.url;
    const token = new URL(recipientUrl).searchParams.get("recipient");
    const res = await postPassword(recipientUrl, PASSWORD, "text/html", "192.0.2.112", { DB: unavailableBucketsDb() });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(recipientOfBackLink(html, recipientUrl), "503 back link must keep the recipient token").toBe(token);
  });
});
