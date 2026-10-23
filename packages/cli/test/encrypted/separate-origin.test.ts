/**
 * Real separate-origin path-mode acceptance. The same local Worker listens on
 * loopback under two hostnames (127.0.0.1 app, localhost sites); no DNS changes,
 * proxy responses, CORS/CSP overrides, remote deployments or crypto mocks.
 *
 * Uses the existing encrypted harness's pinned Playwright/Chromium. Install its
 * test-only dependencies outside synced code if needed, then expose them through
 * packages/cli/test/encrypted/node_modules. On managed runners use the existing
 * Chromium cache and LD_LIBRARY_PATH pointing at the existing browser libroot.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vitest";
import { run, type Io } from "../../src/main.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const marker = "separate-origin-private-page-f203a9";
const assetMarker = "separate-origin-private-script-807dcb";
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Alternate origin</title></head><body><h1>${marker}</h1><script src="./assets/app.js"></script></body></html>`;
const script = `Promise.all(['./bytes.bin', './index.html', './assets/app.js'].map(path => fetch(path).then(r => { if (!r.ok) throw Error('fixture fetch failed'); return r.arrayBuffer(); }).then(b => Array.from(new Uint8Array(b))))).then(([bytes, page, source]) => { window.fixtureResult = { asset: '${assetMarker}', bytes, page, source }; });`;
const binary = Buffer.from(Array.from({ length: 521 }, (_, i) => (i * 73 + 19) % 256));
const files = { "index.html": Buffer.from(html), "assets/app.js": Buffer.from(script), "bytes.bin": binary };
const bootstrap = "separate-origin-local-bootstrap-0123456789abcdef";

type Wire = { url: string; headers: string; body: Buffer };
let work: string;
let api: string;
let sites: string;
let fixture: string;
let browser: any;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
const cliWire: Wire[] = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a loopback TCP port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function cli(args: string[], setup = false) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: text => void (stdout += text), stderr: text => void (stderr += text),
    stdinIsTTY: false, stderrIsTTY: false, readStdin: async () => "",
    prompt: async () => { throw new Error("acceptance must not prompt"); }, cwd: work,
    env: { DROPWAY_API: api, DROPWAY_CONFIG_DIR: join(work, "credentials"), ...(setup ? { DROPWAY_BOOTSTRAP_KEY: bootstrap } : {}) },
    fetch: async request => {
      expect(new URL(request.url).origin === api, "CLI must only contact the scratch app Worker").toBe(true);
      cliWire.push({ url: request.url, headers: JSON.stringify([...request.headers]), body: Buffer.from(await request.clone().arrayBuffer()) });
      return fetch(request);
    },
  };
  const code = await run(args, io);
  // Boolean assertion avoids dumping a generated share key on failures.
  expect(code === 0, `local CLI command must succeed (exit ${code}; ${stderr})`).toBe(true);
  return JSON.parse(stdout);
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "encrypted-separate-origin-"));
  fixture = join(work, "fixture");
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(fixture, path, ".."), { recursive: true });
    await writeFile(join(fixture, path), bytes);
  }
  const port = await availablePort();
  api = `http://127.0.0.1:${port}`;
  sites = `http://localhost:${port}`;
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-encrypted-separate-origin-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: api, SITES_MODE: "path", SITES_ORIGIN: sites, SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "encrypted-separate-origin", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "encrypted-separate-origin-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config,
    dev: { server: { hostname: "127.0.0.1", port }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  expect((await worker.url).origin).toBe(api);
  await cli(["setup", "--email", "alternate-origin@example.com", "--json"], true);
  const { chromium } = require("playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

function keyFrom(url: string): { token: string; bytes: Buffer } {
  const fragment = decodeURIComponent(new URL(url).hash.slice(1));
  for (const token of [fragment, ...fragment.split(/[=&:!~.]/)]) {
    if (/^[0-9a-f]{64}$/i.test(token)) return { token, bytes: Buffer.from(token, "hex") };
    if (/^[A-Za-z0-9_+/-]{43}=?$/.test(token)) {
      const bytes = Buffer.from(token, "base64url");
      if (bytes.length === 32) return { token, bytes };
    }
  }
  throw new Error("expected a 256-bit fragment key without assuming an envelope layout");
}

it("the actual loader decrypts a separate sites origin under real CORS/CSP without exposing the fragment or app storage", async () => {
  const result = await cli(["publish", fixture, "--encrypt", "--json", "--no-save"]);
  expect(result.ok).toBe(true);
  const share = new URL(result.url);
  // Encrypted share links open the trusted app-origin loader. The ciphertext
  // must still be retrieved from the separately configured sites origin below.
  expect(share.origin).toBe(api);
  expect(sites).not.toBe(api);
  const key = keyFrom(result.url);
  const context = await browser.newContext();
  const wire: Wire[] = [];
  const responses: any[] = [];
  const blocked: string[] = [];
  try {
    // This observer delegates to the original WebCrypto method, unchanged. It
    // records no keys/plaintexts and does not replace the loader or its response.
    await context.addInitScript(() => {
      (globalThis as any).__realDecrypts = 0;
      const prototype = Object.getPrototypeOf(crypto.subtle);
      const decrypt = prototype.decrypt;
      prototype.decrypt = async function (...args: any[]) {
        const bytes = await decrypt.apply(this, args);
        (globalThis as any).__realDecrypts++;
        return bytes;
      };
    });
    await context.route("**/*", async (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      if (![api, sites].includes(url.origin)) {
        blocked.push(url.origin);
        return route.abort("blockedbyclient");
      }
      wire.push({ url: request.url(), headers: JSON.stringify(await request.allHeaders()), body: request.postDataBuffer() ?? Buffer.alloc(0) });
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${api}/login`, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.setItem("origin-isolation-sentinel", "app-only");
      sessionStorage.setItem("origin-isolation-sentinel", "app-session-only");
      (globalThis as any).document.cookie = "origin_isolation_sentinel=app-only; SameSite=Strict; Path=/";
    });
    page.on("response", (response: any) => responses.push(response));
    const loader = await page.goto(result.url, { waitUntil: "networkidle" });
    expect(loader.status()).toBe(200);
    const loaderCsp = (await loader.allHeaders())["content-security-policy"];
    expect(loaderCsp, "observe the actual first-party loader's CSP, not a fixture header").toMatch(/script-src/);
    expect(loaderCsp).toContain(sites);
    const restored = async () => (await Promise.all(page.frames().map((frame: any) => frame.evaluate(() => (globalThis as any).fixtureResult ?? null)))).filter(Boolean);
    await expect.poll(restored, { timeout: 5000 }).toContainEqual({
      asset: assetMarker, bytes: [...binary], page: [...files["index.html"]], source: [...files["assets/app.js"]],
    });
    const decrypts = await Promise.all(page.frames().map((frame: any) => frame.evaluate(() => (globalThis as any).__realDecrypts ?? 0)));
    expect(decrypts.reduce((sum: number, count: number) => sum + count, 0)).toBeGreaterThan(0);

    // The actual browser loader must cross the app/sites boundary successfully,
    // not just fetch a same-origin fixture or an intercepted mock response.
    let corsObserved = false;
    let cspObserved = false;
    for (const response of responses) {
      const headers = await response.allHeaders();
      const requestOrigin = await response.request().headerValue("origin");
      if (new URL(response.url()).origin === sites && requestOrigin === api && response.status() === 200) {
        expect(["*", api]).toContain(headers["access-control-allow-origin"]);
        corsObserved = true;
      }
      if (response.request().resourceType() === "document" && headers["content-security-policy"]) cspObserved = true;
    }
    expect(corsObserved, "the real loader must use working cross-origin CORS to retrieve the encrypted site").toBe(true);
    expect(cspObserved, "the delivered loader must retain its current CSP").toBe(true);
    expect(blocked, "no browser request may escape the two loopback origins").toEqual([]);

    const contentFrames = [];
    for (const frame of page.frames()) {
      if (await frame.evaluate(() => Boolean((globalThis as any).fixtureResult))) contentFrames.push(frame);
    }
    expect(contentFrames.length).toBeGreaterThan(0);
    for (const frame of contentFrames) {
      expect(await frame.locator("h1").innerText()).toBe(marker);
      expect(await frame.evaluate(() => {
        const can = (action: () => unknown) => { try { action(); return true; } catch { return false; } };
        return {
          opaque: (globalThis as any).origin === "null",
          local: can(() => localStorage.setItem("origin-isolation-sentinel", "content")),
          session: can(() => sessionStorage.setItem("origin-isolation-sentinel", "content")),
          cookie: can(() => (globalThis as any).document.cookie),
          parent: can(() => (globalThis as any).parent.localStorage.getItem("origin-isolation-sentinel")),
        };
      })).toEqual({ opaque: true, local: false, session: false, cookie: false, parent: false });
    }
    expect(context.serviceWorkers()).toHaveLength(0);

    const forbidden = [key.bytes, Buffer.from(key.token), Buffer.from(encodeURIComponent(key.token)),
      Buffer.from(key.bytes.toString("hex")), Buffer.from(key.bytes.toString("base64")), Buffer.from(key.bytes.toString("base64url")),
      Buffer.from(marker), Buffer.from(assetMarker), ...Object.values(files).flatMap(bytes => [bytes, Buffer.from(bytes.toString("base64"))])];
    for (const request of [...cliWire, ...wire]) {
      const metadata = Buffer.from(decodeURIComponent(request.url) + request.headers);
      for (const value of forbidden) {
        expect(metadata.includes(value), "request URL/query/headers must not disclose the fragment key or source content").toBe(false);
        expect(request.body.includes(value), "request body must not disclose the fragment key or source content").toBe(false);
      }
    }
    await page.goto(`${api}/login`, { waitUntil: "networkidle" });
    expect(await page.evaluate(() => ({
      local: localStorage.getItem("origin-isolation-sentinel"),
      session: sessionStorage.getItem("origin-isolation-sentinel"),
      cookie: (globalThis as any).document.cookie.includes("origin_isolation_sentinel=app-only"),
    }))).toEqual({ local: "app-only", session: "app-session-only", cookie: true });
    console.info("Separate-origin browser evidence:", JSON.stringify({
      app: new URL(api).hostname, sites: new URL(sites).hostname, corsObserved,
      loaderCsp, exactRelativeAssets: true, opaqueContentFrames: contentFrames.length,
      fragmentAndSourceAbsentFromRequests: true, appStorageUnchanged: true,
    }));
  } finally { await context.close(); }
}, 30_000);
