import { describe, expect, it } from "vitest";
import { form, freshInstance, jsonBody, ORIGIN } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const ATTACKS: { name: string; headers: Record<string, string> }[] = [
  { name: "cross-site attacker", headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" } },
  { name: "same-site, cross-origin attacker", headers: { Origin: "https://sites.dropway.test", "Sec-Fetch-Site": "same-site" } },
  { name: "opaque sandbox origin", headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } },
  { name: "missing Origin", headers: { "Sec-Fetch-Site": "same-origin" } },
  { name: "missing fetch metadata", headers: { Origin: ORIGIN } },
  { name: "same-origin browser", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } },
];

// SPEC 11.2: the default REST API is bearer-only. These are not substitutes for
// cookie-authenticated app-write tests: built-in session issuance is R-21, and
// ARCHITECTURE.md assigns embedding-session CSRF checks to the identity adapter.
// Do not install an unsafe fake adapter and mistake its failure for a core bug.
describe("R-15 default REST authentication boundary", () => {
  it.each(ATTACKS)("does not turn cookies into REST authority: $name", async ({ headers }) => {
    const dw = await freshInstance();
    const created = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ slug: "cookie-boundary", files: [{ path: "index.html", content: "<p>original</p>" }] }),
    });
    expect(created.status).toBe(201);
    const before = await dw.json("/api/v1/sites/cookie-boundary", { key: dw.ownerKey });
    expect(before.status).toBe(200);
    const attempted = await dw.json("/api/v1/sites/cookie-boundary", {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", Cookie: `__Host-dw_session=${dw.ownerKey}; dw_session=${dw.ownerKey}` },
      body: JSON.stringify({ title: "attacker changed it" }),
    });
    expect.soft(attempted.status).toBe(401);
    const after = await dw.json("/api/v1/sites/cookie-boundary", { key: dw.ownerKey });
    expect(after.status).toBe(200);
    expect(after.body.site).toEqual(before.body.site);
  });

  it.each(ATTACKS)("keeps explicit bearer-token REST writes working: $name", async ({ headers }) => {
    const dw = await freshInstance();
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "bearer-boundary" }) });
    expect(created.status).toBe(201);
    const changed = await dw.json("/api/v1/sites/bearer-boundary", {
      method: "PATCH", key: dw.ownerKey,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "bearer authorized" }),
    });
    expect(changed.status).toBe(200);
    const site = await dw.json("/api/v1/sites/bearer-boundary", { key: dw.ownerKey });
    expect(site.status).toBe(200);
    expect(site.body.site.title).toBe("bearer authorized");
  });

  it("permits cross-origin REST use without credentialed CORS", async () => {
    const dw = await freshInstance();
    const preflight = await dw.call("/api/v1/sites", {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("keeps the built-in API-key sign-in cookie-free (session issuance is R-21)", async () => {
    const dw = await freshInstance();
    const responses = [
      await dw.call("/login"),
      await dw.call("/login", { method: "POST", body: form({ key: dw.ownerKey }), headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } }),
      await dw.call("/dashboard"),
      await dw.call("/api/v1/me", { key: dw.ownerKey }),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 303, 200, 200]);
    for (const response of responses) expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe.each([
  { name: "app-origin paths", config: { appOrigin: ORIGIN }, prefix: "/s/" },
  { name: "dedicated-origin paths", config: { appOrigin: ORIGIN, sitesOrigin: "https://sites.example" }, prefix: "/" },
])("R-15 site cookie isolation: $name", ({ config, prefix }) => {
  it("keeps password cookies scoped to one site path and usable for that site only", async () => {
    const dw = await freshInstance(config);
    const urls: string[] = [];
    for (const slug of ["password-one", "password-two"]) {
      const published = await dw.json("/api/v1/publish", {
        key: dw.ownerKey, ...jsonBody({ slug, files: [{ path: "index.html", content: `<p>${slug}</p>` }] }),
      });
      expect(published.status).toBe(201);
      urls.push(published.body.url);
      const access = await dw.json(`/api/v1/sites/${slug}/access`, {
        method: "PUT", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "password", password: "correct-password" }),
      });
      expect(access.status).toBe(200);
    }
    expect((await dw.call(urls[0]!, { headers: NAV })).status).toBe(401);
    const unlocked = await dw.call(new URL("__dropway/password", urls[0]!).href, {
      method: "POST", body: new URLSearchParams({ password: "correct-password" }),
      headers: { Origin: new URL(urls[0]!).origin },
    });
    expect(unlocked.status).toBe(303);
    const cookies = unlocked.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0]!;
    const attributes = cookie.split(";").slice(1).map((part) => part.trim());
    const path = attributes.find((part) => /^path=/i.test(part))?.slice(5);
    expect([`${prefix}password-one`, `${prefix}password-one/`]).toContain(path);
    expect(attributes.some((part) => /^domain=/i.test(part))).toBe(false);
    expect(attributes.some((part) => /^secure$/i.test(part))).toBe(true);
    expect(cookie.split("=", 1)[0]).not.toMatch(/^__Host-/);
    const headers = { ...NAV, Cookie: cookie.split(";", 1)[0]! };
    const allowed = await dw.call(urls[0]!, { headers });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("password-one");
    // Force-send the first cookie even though a browser's Path filter would not.
    expect((await dw.call(urls[1]!, { headers })).status).toBe(401);
  });
});
