import { describe, expect, it } from "vitest";
import { resolveConfig } from "@dropway/core";
import { form, freshInstance, jsonBody, manifestEntry, ORIGIN } from "./helpers";

// Contract: docs/ROADMAP.md R-12, docs/SPEC.md SRV-02 and sections 8.3/11.2.
const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const HTML = "<!doctype html><html><head><title>Fixture</title></head><body>SPA fixture</body></html>";
const SITES = "https://sites.test";

describe("sandbox policy reaches served path-mode pages", () => {
  // Removing app-origin forcing, flipping anonymous ownership, or omitting the
  // shim on any sandboxed path-mode response must fail this serving matrix.
  for (const topology of ["app", "dedicated"] as const) {
    for (const mode of [undefined, "auto", "true", "false"] as const) {
      it.each([false, true])(`${topology}, ${mode ?? "default"}, anonymous=%s`, async (anonymous) => {
        const vars: Record<string, string> = { APP_ORIGIN: ORIGIN, ANONYMOUS_PUBLISH: "true" };
        if (topology === "dedicated") vars.SITES_ORIGIN = SITES;
        if (mode !== undefined) vars.SITES_SANDBOX = mode;
        const { sitesSandbox, sitesSandboxAnonymous } = resolveConfig(vars);
        const dw = await freshInstance({
          appOrigin: ORIGIN, ...(topology === "dedicated" ? { sitesOrigin: SITES } : {}),
          sitesSandbox, sitesSandboxAnonymous, anonymous: { enabled: true },
        });
        const pub = await dw.json("/api/v1/publish", {
          method: "POST", key: anonymous ? undefined : dw.ownerKey,
          body: form({ "index.html": HTML, "app.js": "console.log('fixture')" }),
        });
        expect(pub.status).toBe(201);
        expect(pub.body.site.anonymous).toBe(anonymous);
        const url = topology === "app" ? `${ORIGIN}/s/${pub.body.slug}/` : `${SITES}/${pub.body.slug}/`;
        const response = await dw.call(url, { headers: NAV });
        expect(response.status).toBe(200);
        const sandboxed = topology === "app" || mode === "true" || (mode !== "false" && anonymous);
        const csp = response.headers.get("content-security-policy") ?? "";
        const html = await response.text();
        if (sandboxed) {
          expect(csp).toContain("sandbox allow-scripts");
          expect(csp).not.toContain("allow-same-origin");
          expect(html).toContain('<script data-dropway="path-shim">');
        } else {
          expect(csp).not.toContain("sandbox");
          expect(html).not.toContain('<script data-dropway="path-shim">');
        }
        const raw = await dw.call(`${url}index.html?raw=1`, { headers: NAV });
        expect(await raw.text()).toBe(HTML);
      });
    }
  }
});

describe.each(["app", "dedicated"] as const)("SPA Referer navigation on %s origin", (topology) => {
  async function fixture(spa: boolean) {
    const dw = await freshInstance(topology === "dedicated" ? { appOrigin: ORIGIN, sitesOrigin: SITES } : {});
    const pub = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "index.html": HTML, "app.js": "console.log('fixture')" }, { slug: "spa-fixture" }),
    });
    expect(pub.status).toBe(201);
    const patched = await dw.json("/api/v1/sites/spa-fixture", {
      key: dw.ownerKey, ...jsonBody({ spa }), method: "PATCH",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.site.settings.spa).toBe(spa);
    const origin = topology === "app" ? ORIGIN : SITES;
    const prefix = topology === "app" ? "/s/spa-fixture/" : "/spa-fixture/";
    return { dw, origin, prefix };
  }

  it("redirects a missing route into the referring SPA and keeps its query", async () => {
    const { dw, origin, prefix } = await fixture(true);
    const response = await dw.call(`${origin}/account/preferences?tab=privacy`, {
      headers: { ...NAV, Referer: `${origin}${prefix}projects/one` },
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${prefix}account/preferences?tab=privacy`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toMatch(/(?:^|,\s*)Referer(?:,|$)/i);
    const target = await dw.call(new URL(response.headers.get("location")!, origin).href, { headers: NAV });
    expect(target.status).toBe(200);
    expect(await target.text()).toContain("SPA fixture");
  });

  it("does not redirect a missing script merely because SPA mode is on", async () => {
    const { dw, origin, prefix } = await fixture(true);
    const response = await dw.call(`${origin}/missing-script.js`, {
      headers: { "Sec-Fetch-Dest": "script", Referer: `${origin}${prefix}` },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not use an external Referer to select an SPA", async () => {
    const { dw, origin, prefix } = await fixture(true);
    const response = await dw.call(`${origin}/account/preferences`, {
      headers: { ...NAV, Referer: `https://external.test${prefix}` },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect missing navigation into a non-SPA site", async () => {
    const { dw, origin, prefix } = await fixture(false);
    const response = await dw.call(`${origin}/account/preferences`, {
      headers: { ...NAV, Referer: `${origin}${prefix}` },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("reserved upload namespace", () => {
  // Accepting any of these lets uploaded bytes impersonate platform endpoints.
  const paths = ["__dropway/password", "__dropway/assets/app.js", "./__dropway/x.txt", "/__dropway/x.txt"];
  it.each(paths)("rejects %s in one-shot JSON publish", async (path) => {
    const dw = await freshInstance();
    const result = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ files: [{ path, content: "uploaded platform impersonation" }] }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("invalid_path");
    expect(result.body.error.hint).toEqual(expect.any(String));
    expect(result.body.error.hint.trim()).not.toBe("");
  });

  it.each(paths)("rejects %s in a staged manifest", async (path) => {
    const dw = await freshInstance();
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "reserved-fixture" }) });
    expect(created.status).toBe(201);
    const { bytes: _bytes, ...entry } = await manifestEntry(path, "uploaded platform impersonation");
    const result = await dw.json("/api/v1/sites/reserved-fixture/deploys", {
      key: dw.ownerKey, ...jsonBody({ files: [entry] }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("invalid_path");
  });

  it("does not reserve similarly named ordinary files", async () => {
    const dw = await freshInstance();
    const result = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "__dropwayish/file.txt": "ordinary file", "index.html": HTML }),
    });
    expect(result.status).toBe(201);
    expect(await (await dw.call(`/s/${result.body.slug}/__dropwayish/file.txt`)).text()).toBe("ordinary file");
  });
});

describe.each(["app", "dedicated", "subdomain"] as const)("stored but hidden config on %s origin", (topology) => {
  // Public static serving, raw/download/view selectors and SPA fallback must all
  // keep config bytes private; authenticated owner read-back must retain them.
  it.each(["", "?raw=1", "?download=1", "?view=source", "?view=1"])("never serves .dropway files with selector '%s'", async (selector) => {
    const config = topology === "dedicated" ? { appOrigin: ORIGIN, sitesOrigin: SITES }
      : topology === "subdomain" ? { sitesMode: "subdomain" as const, sitesDomain: "sites.test" } : {};
    const dw = await freshInstance(config);
    const files = { "index.html": HTML, ".dropway/private.txt": "private config marker", ".dropway/nested/private.txt": "nested private marker" };
    const pub = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form(files, { slug: "hidden-fixture" }),
    });
    expect(pub.status).toBe(201);
    const patched = await dw.json("/api/v1/sites/hidden-fixture", {
      key: dw.ownerKey, ...jsonBody({ spa: true }), method: "PATCH",
    });
    expect(patched.status).toBe(200);
    const listed = await dw.json("/api/v1/sites/hidden-fixture/files", { key: dw.ownerKey });
    expect(listed.status).toBe(200);
    expect(listed.body.files.map((item: { path: string }) => item.path)).toEqual(expect.arrayContaining(Object.keys(files)));
    const root = topology === "app" ? `${ORIGIN}/s/hidden-fixture/`
      : topology === "dedicated" ? `${SITES}/hidden-fixture/` : "https://hidden-fixture.sites.test/";
    for (const path of [".dropway/private.txt", ".dropway/nested/private.txt"]) {
      const stored = await dw.call(`/api/v1/sites/hidden-fixture/files/${path}`, { key: dw.ownerKey });
      expect(stored.status).toBe(200);
      expect(await stored.text()).toBe(files[path as keyof typeof files]);
      const publicFile = await dw.call(`${root}${path}${selector}`, { headers: NAV });
      expect.soft(publicFile.status, `${path}${selector}`).toBe(404);
      expect.soft(await publicFile.text()).not.toContain(files[path as keyof typeof files]);
    }
    const publicPage = await dw.call(root, { headers: NAV });
    expect(publicPage.status).toBe(200);
    expect(await publicPage.text()).toContain("SPA fixture");
  });
});
