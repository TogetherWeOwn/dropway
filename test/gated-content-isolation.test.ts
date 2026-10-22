import { beforeEach, describe, expect, it } from "vitest";
import type { ConfigOverrides } from "@dropway/core";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const PASSWORD = "isolation-test-password";
const NAVIGATION = { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const FILES = {
  "index.html": "<!doctype html><head><title>Gated home marker</title></head><p>Gated home marker</p>",
  "assets/app.js": 'globalThis.gatedMarker = "gated-script-marker";',
  "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"><text>gated-image-marker</text></svg>',
  "data.json": '{"marker":"gated-fetch-marker"}',
  "docs/guide.md": "# Gated guide marker\n\nViewer content.",
  "listing/listed-marker.txt": "gated-listing-marker",
};
const RESOURCES = [
  { name: "script", path: "assets/app.js", mode: "no-cors", dest: "script", marker: "gated-script-marker" },
  { name: "image", path: "image.svg", mode: "no-cors", dest: "image", marker: "gated-image-marker" },
  { name: "fetch", path: "data.json", mode: "cors", dest: "empty", marker: "gated-fetch-marker" },
];
const TOPOLOGIES: { name: string; config: ConfigOverrides; url(slug: string): string; sibling: string }[] = [
  {
    name: "subdomain",
    config: { appOrigin: ORIGIN, sitesMode: "subdomain", sitesDomain: "sites.test" },
    url: (slug) => `https://${slug}.sites.test/`,
    sibling: "https://sibling.sites.test",
  },
  {
    name: "shared-origin path",
    config: { appOrigin: ORIGIN, sitesMode: "path" },
    url: (slug) => `${ORIGIN}/s/${slug}/`,
    sibling: "https://sibling.dropway.test",
  },
  {
    name: "standalone sites-origin path",
    config: { appOrigin: ORIGIN, sitesMode: "path", sitesOrigin: "https://sites.dropway.test" },
    url: (slug) => `https://sites.dropway.test/${slug}/`,
    sibling: "https://sibling.dropway.test",
  },
];

function expectGatedHeaders(res: Response) {
  expect.soft(res.headers.get("access-control-allow-origin")).toBeNull();
  expect.soft(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
}

// Obtain the signed cookie through the served password form, never by minting one in a fixture.
async function unlock(dw: Instance, url: string): Promise<string> {
  const challenge = await dw.call(url, { headers: NAVIGATION });
  expect(challenge.status).toBe(401);
  const html = await challenge.text();
  const action = html.match(/<form\b[^>]*\baction="([^"]+)"/i)?.[1];
  expect(action, "password challenge must expose its real form action").toBeTruthy();
  const res = await dw.call(new URL(action!, url).href, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(url).origin },
    body: new URLSearchParams({ password: PASSWORD }),
  });
  expect([302, 303]).toContain(res.status);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const cookie = setCookie!.split(";")[0]!;
  const content = await dw.call(url, { headers: { Cookie: cookie, ...NAVIGATION } });
  expect(content.status).toBe(200);
  expect(await content.text()).toContain("Gated home marker");
  return cookie;
}

describe.each(TOPOLOGIES)("gated content isolation: $name", (topology) => {
  let dw: Instance;
  let url: string;
  let slug: string;

  beforeEach(async () => {
    dw = await freshInstance(topology.config);
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(FILES) });
    expect(pub.status).toBe(201);
    slug = pub.body.slug;
    url = topology.url(slug);
    expect(pub.body.url).toBe(url);
  });

  async function gate() {
    const access = await dw.json(`/api/v1/sites/${slug}/access`, {
      method: "PUT",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "password", password: PASSWORD }),
    });
    expect(access.status).toBe(200);
    expect(access.body.access.mode).toBe("password");
  }

  async function setIsolation(enabled: boolean) {
    const settings = await dw.json(`/api/v1/sites/${slug}`, {
      method: "PATCH",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crossOriginIsolation: enabled }),
    });
    expect(settings.status).toBe(200);
  }

  function hostileHeaders(site: "same-site" | "cross-site", mode: string, dest: string, cookie?: string) {
    return {
      // Accept is attacker-controlled; it must not override explicit resource metadata.
      Accept: "text/html",
      ...(mode === "cors" ? { Origin: site === "same-site" ? topology.sibling : "https://attacker.example" } : {}),
      "Sec-Fetch-Site": site,
      "Sec-Fetch-Mode": mode,
      "Sec-Fetch-Dest": dest,
      ...(cookie ? { Cookie: cookie } : {}),
    };
  }

  it("does not grant cross-origin access to the password challenge", async () => {
    await gate();
    const res = await dw.call(url, { headers: { ...NAVIGATION, "Sec-Fetch-Site": "cross-site" } });
    expect(res.status).toBe(401);
    expectGatedHeaders(res);
    const body = await res.text();
    expect(body).toContain('type="password"');
    expect(body).not.toContain("Gated home marker");
  });

  it.each([false, true])("restricts unlocked content headers with crossOriginIsolation=%s", async (isolation) => {
    await setIsolation(isolation);
    await gate();
    const cookie = await unlock(dw, url);
    const res = await dw.call(`${url}data.json`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILES["data.json"]);
    expectGatedHeaders(res);
    if (isolation) {
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    }
  });

  for (const site of ["same-site", "cross-site"] as const) {
    for (const method of ["GET", "HEAD"] as const) {
      it.each(RESOURCES)(`rejects unlocked ${site} ${method} $name despite Accept: text/html`, async (resource) => {
        await gate();
        const cookie = await unlock(dw, url);
        const res = await dw.call(`${url}${resource.path}`, {
          method,
          headers: hostileHeaders(site, resource.mode, resource.dest, cookie),
        });
        expect.soft(res.status).toBe(403);
        expectGatedHeaders(res);
        const body = await res.text();
        expect.soft(body).not.toContain(resource.marker);
        if (method === "HEAD") expect(body).toBe("");
      });
    }

    it(`permits an unlocked ${site} top-level document navigation`, async () => {
      await gate();
      const cookie = await unlock(dw, url);
      const res = await dw.call(url, { headers: { ...hostileHeaders(site, "navigate", "document", cookie), ...NAVIGATION } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Gated home marker");
    });
  }

  // Sandboxed path pages can also send cross-site metadata from an opaque origin.
  // That compatibility cost must not turn Origin: null into a resource-isolation bypass.
  it("does not exempt an unlocked cross-site fetch from an opaque origin", async () => {
    await gate();
    const cookie = await unlock(dw, url);
    const res = await dw.call(`${url}data.json`, {
      headers: { ...hostileHeaders("cross-site", "cors", "empty", cookie), Origin: "null" },
    });
    expect.soft(res.status).toBe(403);
    expectGatedHeaders(res);
    expect(await res.text()).not.toContain("gated-fetch-marker");
  });

  it.each(RESOURCES)("keeps same-origin and metadata-free $name access working for GET and HEAD", async (resource) => {
    await gate();
    const cookie = await unlock(dw, url);
    const metadataCases: Record<string, string>[] = [
      { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": resource.mode, "Sec-Fetch-Dest": resource.dest },
      {},
    ];
    for (const metadata of metadataCases) {
      for (const method of ["GET", "HEAD"]) {
        const res = await dw.call(`${url}${resource.path}`, { method, headers: { Cookie: cookie, ...metadata } });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(method === "HEAD" ? "" : FILES[resource.path as keyof typeof FILES]);
      }
    }
  });

  it("keeps gated headers on raw, download, viewer, listing, range and conditional responses", async () => {
    await gate();
    const cookie = await unlock(dw, url);
    const asset = await dw.call(`${url}assets/app.js`, { headers: { Cookie: cookie } });
    expect(asset.status).toBe(200);
    const etag = asset.headers.get("etag");
    expect(etag).toBeTruthy();
    await asset.text();
    const variants: { path: string; status: number; marker: string; headers?: Record<string, string> }[] = [
      { path: "index.html?raw=1", status: 200, marker: "Gated home marker" },
      { path: "data.json?download=1", status: 200, marker: "gated-fetch-marker" },
      { path: "docs/guide.md?view=1", status: 200, marker: "Gated guide marker" },
      { path: "listing/", status: 200, marker: "listed-marker.txt" },
      { path: "assets/app.js", status: 206, marker: "global", headers: { Range: "bytes=0-5" } },
      { path: "assets/app.js", status: 304, marker: "", headers: { "If-None-Match": etag! } },
    ];
    for (const variant of variants) {
      const res = await dw.call(`${url}${variant.path}`, { headers: { Cookie: cookie, ...variant.headers } });
      expect.soft(res.status, variant.path).toBe(variant.status);
      expectGatedHeaders(res);
      const body = await res.text();
      if (variant.status === 304) expect(body).toBe("");
      else expect(body).toContain(variant.marker);
    }
  });

  it("checks resource isolation before raw/download/view/listing/range/304 shortcuts", async () => {
    await gate();
    const cookie = await unlock(dw, url);
    const asset = await dw.call(`${url}assets/app.js`, { headers: { Cookie: cookie } });
    const etag = asset.headers.get("etag");
    expect(etag).toBeTruthy();
    await asset.text();
    const variants: { path: string; headers?: Record<string, string> }[] = [
      { path: "index.html?raw=1" },
      { path: "data.json?download=1" },
      { path: "docs/guide.md?view=1" },
      { path: "listing/" },
      { path: "assets/app.js", headers: { Range: "bytes=0-5" } },
      { path: "assets/app.js", headers: { "If-None-Match": etag! } },
    ];
    for (const variant of variants) {
      const res = await dw.call(`${url}${variant.path}`, {
        headers: { ...hostileHeaders("same-site", "cors", "empty", cookie), ...variant.headers },
      });
      expect.soft(res.status, variant.path).toBe(403);
      const body = await res.text();
      for (const marker of ["Gated home marker", "gated-fetch-marker", "Gated guide marker", "listed-marker.txt", "global"]) {
        expect.soft(body, variant.path).not.toContain(marker);
      }
    }
  });

  it("does not advertise wildcard CORS for gated OPTIONS, with or without an unlock cookie", async () => {
    await gate();
    const cookie = await unlock(dw, url);
    for (const auth of [undefined, cookie]) {
      const res = await dw.call(`${url}data.json`, {
        method: "OPTIONS",
        headers: { ...hostileHeaders("same-site", "cors", "empty", auth), "Access-Control-Request-Method": "GET" },
      });
      expect.soft(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(await res.text()).not.toContain("gated-fetch-marker");
    }
  });

  it.each([false, true])("preserves public content and OPTIONS CORS with crossOriginIsolation=%s", async (isolation) => {
    await setIsolation(isolation);
    const corp = isolation ? "same-origin" : "cross-origin";
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = await dw.call(`${url}data.json`, {
        method,
        headers: {
          ...hostileHeaders("cross-site", "cors", "empty"),
          Accept: "*/*",
          ...(method === "OPTIONS" ? { "Access-Control-Request-Method": "GET" } : {}),
        },
      });
      expect(res.status).toBe(method === "OPTIONS" ? 204 : 200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      // Public preflights currently send CORS headers only, not content-isolation headers.
      if (method !== "OPTIONS") {
        expect(res.headers.get("cross-origin-resource-policy")).toBe(corp);
        if (isolation) {
          expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
          expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
        }
      }
      expect(await res.text()).toBe(method === "GET" ? FILES["data.json"] : "");
    }
  });
});
