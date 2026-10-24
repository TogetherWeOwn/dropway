/** Canonical APP_ORIGIN must not prevent embedding a loader's own alias origin. */
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
const bootstrap = "alias-origin-local-bootstrap-0123456789abcdef";
const marker = "alias-decrypted-page-0189b3";
const payload = "alias-exact-fetched-asset-50f2";
let work: string;
let canonical: string;
let alias: string;
let fixture: string;
let browser: any;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

async function port(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("expected a local TCP port");
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function cli(args: string[], setup = false) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: text => void (stdout += text), stderr: text => void (stderr += text),
    stdinIsTTY: false, stderrIsTTY: false, readStdin: async () => "",
    prompt: async () => { throw Error("must not prompt"); }, cwd: work,
    env: { KOFRA_API: alias, KOFRA_CONFIG_DIR: join(work, "credentials"), ...(setup ? { KOFRA_BOOTSTRAP_KEY: bootstrap } : {}) },
    fetch: async request => {
      expect([alias, canonical].includes(new URL(request.url).origin), "CLI may only use the two actual loopback origins (upload URLs may be canonical)").toBe(true);
      return fetch(request);
    },
  };
  const code = await run(args, io);
  expect(code === 0, `local CLI must succeed (exit ${code}; ${stderr})`).toBe(true);
  return JSON.parse(stdout);
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "encrypted-alias-"));
  fixture = join(work, "fixture");
  await mkdir(fixture);
  await writeFile(join(fixture, "index.html"), `<h1>${marker}</h1><script src="./app.js"></script>`);
  await writeFile(join(fixture, "asset.txt"), payload);
  await writeFile(join(fixture, "app.js"), "fetch('./asset.txt').then(r => { if (!r.ok) throw Error('asset missing'); return r.text(); }).then(asset => { window.aliasFixture = asset; });");
  const localPort = await port();
  canonical = `http://localhost:${localPort}`;
  alias = `http://127.0.0.1:${localPort}`;
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-encrypted-alias-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: canonical, SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "encrypted-alias", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "encrypted-alias-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: localPort }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  await cli(["setup", "--email", "alias@example.com", "--json"], true);
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

it.each(["canonical", "alias"])("%s origin restores actual decrypted HTML AND bundled script/fetch content", async kind => {
  const result = await cli(["publish", fixture, "--encrypt", "--json", "--no-save"]);
  const url = new URL(result.url);
  url.host = new URL(kind === "canonical" ? canonical : alias).host;
  const context = await browser.newContext();
  const errors: string[] = [];
  try {
    await context.route("**/*", (route: any) => [canonical, alias].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    const page = await context.newPage();
    page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
    const response = await page.goto(url.href, { waitUntil: "networkidle" });
    expect(response.status()).toBe(200);
    expect(new URL(page.url()).origin, "do not redirect aliases to hide their broken frame policy").toBe(kind === "canonical" ? canonical : alias);
    expect(response.headers()["content-security-policy"]).toBeTruthy();
    // A loader status of 'Decrypted' and an iframe load event are insufficient:
    // only decrypted app.js fetching the exact bundled asset sets this value.
    await expect.poll(async () => (await Promise.all(page.frames().map((frame: any) => frame.evaluate(() => (globalThis as any).aliasFixture ?? null)))).filter(Boolean), { timeout: 3000 }).toEqual([payload]);
    const content = [];
    for (const frame of page.frames()) if (await frame.evaluate(() => Boolean((globalThis as any).aliasFixture))) content.push(frame);
    expect(content.length).toBeGreaterThan(0);
    for (const frame of content) expect(await frame.locator("h1").innerText()).toBe(marker);
    expect(errors.some(message => /frame-ancestors/i.test(message)), "real HTTP frame-ancestors must permit the response's own origin").toBe(false);
  } finally { await context.close(); }
});
