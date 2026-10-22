import { describe, expect, it } from "vitest";
import { resolveConfig } from "@dropway/core";
import { form, freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";

// Contract: docs/ROADMAP.md R-12 and docs/SPEC.md PUB-12, section 9.2.
// These tests catch missing analysis on either publish surface, missing remediation,
// and warnings emitted when the serving configuration makes them inapplicable.
type Surface = "publish" | "finalize";
type Files = Record<string, string | Uint8Array>;
type Settings = { spa?: boolean; crossOriginIsolation?: boolean };
type Warning = { code: string; message: string; path?: string; line?: number; fix?: string };

async function publish(dw: Instance, surface: Surface, files: Files, settings: Settings = {}) {
  const slug = "warning-fixture";
  const hasSettings = Object.keys(settings).length > 0;
  if (surface === "finalize" || hasSettings) {
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
    expect(created.status).toBe(201);
    if (hasSettings) {
      const patched = await dw.json(`/api/v1/sites/${slug}`, {
        key: dw.ownerKey, ...jsonBody(settings), method: "PATCH",
      });
      expect(patched.status).toBe(200);
      expect(patched.body.site.settings).toMatchObject(settings);
    }
  }
  if (surface === "publish") {
    const result = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form(files, { slug }),
    });
    expect(result.status).toBe(hasSettings ? 200 : 201);
    expect(result.body.version.live).toBe(true);
    return result.body;
  }

  const entries = await Promise.all(Object.entries(files).map(async ([path, content]) => {
    // manifestEntry also handles the tiny binary Wasm fixture's ASCII bytes.
    return manifestEntry(path, typeof content === "string" ? content : new TextDecoder().decode(content));
  }));
  const pending = await dw.json(`/api/v1/sites/${slug}/deploys`, {
    key: dw.ownerKey,
    ...jsonBody({ files: entries.map(({ bytes: _bytes, ...entry }) => entry) }),
  });
  expect(pending.status).toBe(201);
  for (const entry of entries) {
    if (!pending.body.missing.includes(entry.sha256)) continue;
    const uploaded = await dw.call(`/api/v1/blobs/${entry.sha256}`, {
      method: "PUT", key: dw.ownerKey, body: entry.bytes,
      headers: { "Content-Length": String(entry.size) },
    });
    expect(uploaded.status).toBe(201);
  }
  const result = await dw.json(`/api/v1/sites/${slug}/deploys/${pending.body.deploy.id}/finalize`, {
    method: "POST", key: dw.ownerKey,
  });
  expect(result.status).toBe(200);
  expect(result.body.live).toBe(true);
  return result.body;
}

function warnings(result: Record<string, any>): Warning[] {
  expect(result.warnings).toEqual(expect.any(Array));
  return result.warnings as Warning[];
}

function warning(result: Record<string, any>, code: string): Warning {
  const found = warnings(result).find((item) => item.code === code);
  expect(found, `missing ${code} warning`).toBeDefined();
  expect(found!.message.trim()).not.toBe("");
  expect(found!.fix, `${code} needs actionable fix text`).toEqual(expect.any(String));
  expect(found!.fix!.trim()).not.toBe("");
  return found!;
}

const page = "<!doctype html><html><head><title>Fixture</title></head><body>Hello</body></html>";
const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

describe.each<Surface>(["publish", "finalize"])("%s warnings", (surface) => {
  it.each([
    ["HTML", { "index.html": '<!doctype html><html><head><script src="/assets/app.js"></script></head><body></body></html>', "assets/app.js": "console.log('fixture')" }],
    ["CSS", { "index.html": page, "style.css": 'body { background: url("/assets/pixel.svg"); }', "assets/pixel.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>' }],
  ] as const)("warns about root-absolute %s paths in path mode", async (_kind, files) => {
    const dw = await freshInstance({ sitesMode: "path" });
    warning(await publish(dw, surface, files), "root_absolute_paths");
  });

  it("does not warn about relative asset URLs", async () => {
    const dw = await freshInstance();
    const result = await publish(dw, surface, {
      "index.html": '<!doctype html><html><head><script src="./assets/app.js"></script></head><body></body></html>',
      "assets/app.js": "console.log('fixture')",
    });
    expect(warnings(result).map((item) => item.code)).not.toContain("root_absolute_paths");
  });

  it("does not warn about root-absolute paths in subdomain mode", async () => {
    const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
    const result = await publish(dw, surface, { "index.html": '<script src="/app.js"></script>', "app.js": "console.log(1)" });
    expect(warnings(result).map((item) => item.code)).not.toContain("root_absolute_paths");
  });

  it("warns about a path-mode SPA without a base path", async () => {
    const dw = await freshInstance();
    warning(await publish(dw, surface, { "index.html": page }, { spa: true }), "spa_without_base");
  });

  it("does not warn about an SPA with its correct base path", async () => {
    const dw = await freshInstance();
    const result = await publish(dw, surface, {
      "index.html": '<!doctype html><html><head><base href="/s/warning-fixture/"></head><body>SPA</body></html>',
    }, { spa: true });
    expect(warnings(result).map((item) => item.code)).not.toContain("spa_without_base");
  });

  it.each(["localStorage", "sessionStorage", "indexedDB"])("warns about %s when the site is sandboxed", async (storage) => {
    const dw = await freshInstance();
    const result = await publish(dw, surface, {
      "index.html": page,
      "app.js": storage === "indexedDB" ? 'indexedDB.open("fixture");' : `${storage}.setItem("fixture", "value");`,
    });
    warning(result, "uses_browser_storage");
  });

  it.each<[string, Record<string, string>, boolean]>([
    ["dedicated auto owned", { SITES_ORIGIN: "https://sites.test", SITES_SANDBOX: "auto" }, false],
    ["dedicated forced", { SITES_ORIGIN: "https://sites.test", SITES_SANDBOX: "true" }, true],
    ["dedicated disabled", { SITES_ORIGIN: "https://sites.test", SITES_SANDBOX: "false" }, false],
    ["app origin disabled still sandboxed", { SITES_SANDBOX: "false" }, true],
  ])("uses the actual sandbox decision: %s", async (_label, vars, sandboxed) => {
    const { sitesSandbox, sitesSandboxAnonymous } = resolveConfig({ APP_ORIGIN: ORIGIN, ...vars });
    const dw = await freshInstance({
      appOrigin: ORIGIN, ...(vars.SITES_ORIGIN ? { sitesOrigin: vars.SITES_ORIGIN } : {}),
      sitesSandbox, sitesSandboxAnonymous,
    });
    const result = await publish(dw, surface, { "index.html": page, "app.js": 'localStorage.getItem("fixture");' });
    if (sandboxed) warning(result, "uses_browser_storage");
    else expect(warnings(result).map((item) => item.code)).not.toContain("uses_browser_storage");
  });

  it("warns about Wasm without cross-origin isolation", async () => {
    const dw = await freshInstance();
    warning(await publish(dw, surface, { "index.html": page, "module.wasm": wasm }), "wasm_without_coi");
  });

  it("does not warn about Wasm with cross-origin isolation enabled", async () => {
    const dw = await freshInstance();
    const result = await publish(dw, surface, { "index.html": page, "module.wasm": wasm }, { crossOriginIsolation: true });
    expect(warnings(result).map((item) => item.code)).not.toContain("wasm_without_coi");
  });

  it("locates a possible secret by file and one-based line", async () => {
    const dw = await freshInstance();
    // Public AWS documentation example, not a credential. Constructed to keep
    // secret scanners from mistaking the acceptance test itself for a leak.
    const example = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const result = await publish(dw, surface, {
      "index.html": page,
      "config.js": `// synthetic fixture\nconst region = "test";\nconst accessKeyId = "${example}";\n`,
    });
    const found = warning(result, "possible_secret");
    expect(found.path).toBe("config.js");
    expect(found.line).toBe(3);
  });

  it("warns about invalid config without rejecting the static site", async () => {
    const dw = await freshInstance();
    const result = await publish(dw, surface, { "index.html": page, ".dropway/data.json": '{ "collections": ' });
    warning(result, "invalid_config");
    const served = await dw.call("/s/warning-fixture/");
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("Hello");
  });

  it("returns an empty warnings array for a clean static page", async () => {
    const dw = await freshInstance();
    expect(warnings(await publish(dw, surface, { "index.html": page }))).toEqual([]);
  });
});

it("warns about storage for an anonymous site on a dedicated origin in auto mode", async () => {
  const dw = await freshInstance({ appOrigin: ORIGIN, anonymous: { enabled: true }, sitesOrigin: "https://sites.test" });
  const result = await dw.json("/api/v1/publish", {
    method: "POST", body: form({ "index.html": page, "app.js": 'localStorage.getItem("fixture");' }),
  });
  expect(result.status).toBe(201);
  warning(result.body, "uses_browser_storage");
});
