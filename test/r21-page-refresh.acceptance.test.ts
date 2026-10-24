import { afterEach, describe, expect, it, vi } from "vitest";
import { deniedBrowserHeaders } from "./r21-browser-headers";
import {
  anonymousSite, freshInstance, issuedSessionCookies, MINUTE, signedIn, storedRows, type Instance,
} from "./r21-helpers";

afterEach(() => vi.useRealTimers());

// Break caught: a page/claim GET looks read-only but resolving its real cookie
// slides persisted authority or emits a refreshing cookie after the idle hour.
// Ordinary navigations need not send Origin; they must still render read-only.
describe.each(["/dashboard/sessions", "/claim"])("R-21 page refresh boundary: %s", (path) => {
  it.each(deniedBrowserHeaders())("renders with $name without sliding the real cookie or D1", async ({ origin, headers }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 23));
    const raw = await freshInstance({ appOrigin: origin, anonymous: { enabled: true } });
    const dw: Instance = {
      ...raw,
      call: (target, init) => raw.call(target, { ...init, origin }),
      json: (target, init) => raw.json(target, { ...init, origin }),
    };
    const site = path === "/claim" ? await anonymousSite(dw) : null;
    const active = await signedIn(dw, undefined, origin);
    const before = await storedRows();
    vi.setSystemTime(Date.now() + 61 * MINUTE);
    const response = await dw.call(site ? `/claim?slug=${site.slug}` : path, {
      headers: {
        Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
        ...headers, Cookie: active.cookie,
      },
    });
    expect.soft(response.status, "normal page navigation must not require a synthetic Origin header").toBe(200);
    expect.soft(issuedSessionCookies(response), "a read cannot re-issue a refreshing session cookie").toEqual([]);
    expect.soft(await storedRows(), "includes last_seen_at, expires_at, claims and member state").toEqual(before);
    const live = await dw.call("/api/v1/auth/sessions", {
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", Cookie: active.cookie },
    });
    expect(live.status, "read-only resolution must not revoke a valid session").toBe(200);
  });
});
