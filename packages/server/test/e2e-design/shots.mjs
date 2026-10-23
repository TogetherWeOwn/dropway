#!/usr/bin/env node
// Security Print screenshot harness (PORT-SPEC 9), core target.
//
// Runs the core Worker in Miniflare (local D1, R2 and KV in memory; no network), seeds fixtures through the
// public API, then opens every core screen in headless Chrome in four colour modes (light, dark, auto with
// the OS light, auto with the OS dark) at three widths (390, 768, 1440) and writes a full-page screenshot per
// cell plus matrix.json with the deterministic checks for that cell:
//   csp      no securitypolicyviolation events
//   console  no console errors or warnings, no failed sub-resource requests (except where a screen expects one)
//   axe      axe-core (wcag2a/aa, wcag21a/aa, wcag22aa) violations
//   overflow no document-level horizontal scroll
//   mode     <html data-theme> and the page background match the mode
//   fonts    Public Sans, Newsreader and Martian Mono loaded (where the page uses them)
//   brand    no visible "Dropway", no "scanned/virus/safe/clean/verified" outside user content
// Explicit modes use the __Host-dw_theme cookie on the app origin and ?theme= on site origins; Auto uses
// the emulated prefers-color-scheme and no cookie.
//
// Usage: node packages/server/test/e2e-design/shots.mjs --out <dir> [--only J03,J08] [--widths 390,1440] [--modes light,dark]
// Browser: CHROME_PATH, default the cached Playwright headless shell.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = resolve(arg("out", join(ROOT, "e2e-design-out")));
const ONLY = arg("only", "") ? new Set(arg("only").split(",")) : null;
const WIDTHS = arg("widths", "390,768,1440").split(",").map(Number);
const MODES = arg("modes", "light,dark,auto-light,auto-dark").split(",");
const CHROME =
  process.env.CHROME_PATH ||
  [1248, 1234, 1200].map((v) => `/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-${v}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);

const APP = "https://kofra.test";
const SITES = "kofra-sites.test";
const site = (slug, path = "") => `https://${slug}.${SITES}/${path}`;
const BOOT = "harness-bootstrap-secret-0123456789abcdef";
const FROZEN = new Date("2026-10-23T12:00:00Z");
const VIEWPORTS = {
  390: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  768: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2 },
  1440: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};
const PAPER = { light: "rgb(244, 239, 226)", dark: "rgb(15, 22, 38)" };

// ------------------------------------------------------------------ fixtures (generated, licence-clean)

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const t = Math.sin((x + seed * 13) / 9) * Math.cos((y - seed * 7) / 11);
      raw[o] = 40 + ((seed * 53 + x) % 120) + Math.round(t * 30);
      raw[o + 1] = 70 + ((y * 2 + seed * 31) % 110);
      raw[o + 2] = 90 + Math.round(t * 80) + seed * 9;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function wav() {
  const rate = 8000;
  const n = rate / 2;
  const b = Buffer.alloc(44 + n);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin((i / rate) * 2 * Math.PI * 440));
  return b;
}
function pdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const text = "BT /F1 24 Tf 72 760 Td (Quarterly report) Tj ET";
  objs[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
const svg = (label, hue) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="hsl(${hue} 45% 40%)"/><circle cx="60" cy="60" r="34" fill="none" stroke="#f4efe2" stroke-width="4"/><text x="60" y="66" font-size="14" text-anchor="middle" fill="#f4efe2" font-family="sans-serif">${label}</text></svg>`);
const notebook = () =>
  Buffer.from(
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: "python3", language: "python" }, language_info: { name: "python" } },
      cells: [
        { cell_type: "markdown", metadata: {}, source: ["# Rainfall by month\n", "A small notebook with **one chart** and a table."] },
        { cell_type: "code", execution_count: 1, metadata: {}, source: ["import statistics\n", "rain = [61, 48, 52, 44, 49, 45]\n", "statistics.mean(rain)"], outputs: [{ output_type: "execute_result", execution_count: 1, data: { "text/plain": ["49.833333333333336"] }, metadata: {} }] },
        { cell_type: "code", execution_count: 2, metadata: {}, source: ["print('done')"], outputs: [{ output_type: "stream", name: "stdout", text: ["done\n"] }, { output_type: "display_data", data: { "image/png": png(120, 60, 4).toString("base64") }, metadata: {} }] },
      ],
    }),
  );
const longLog = () => {
  const lines = [];
  for (let i = 0; i < 26000; i++) lines.push(`2026-10-23T11:${String(i % 60).padStart(2, "0")}:00Z INFO request ${i} served in ${(i * 7) % 300} ms path=/assets/app.${i % 9}.js`);
  return Buffer.from(lines.join("\n"));
};
const FONT = readFileSync(join(ROOT, "packages/server/design/fonts/martian-mono-latin-wght-normal.woff2"));

const SITE_FILES = () => ({
  "index.html": Buffer.from('<!doctype html><meta charset="utf-8"><title>Field notes</title><h1>Field notes</h1><p>A small site for the harness.</p>'),
  "README.md": Buffer.from(
    "# Field notes\n\nA short guide to the **field kit**, with a [link](https://example.com), `inline code` and a table.\n\n## Contents\n\n- Setup\n- Daily checks\n- Packing list\n\n> Keep the kit dry and the batteries charged.\n\n| Item | Count | Weight |\n|---|---:|---:|\n| Tent | 1 | 2.1 kg |\n| Stove | 1 | 0.4 kg |\n\n```python\ndef weight(items):\n    return sum(i.kg for i in items)\n```\n\n---\n\nLast updated in October.\n",
  ),
  "docs/guide.md": Buffer.from("# Guide\n\nStep one, step two.\n"),
  "docs/api.md": Buffer.from("# API\n\n`GET /items` lists items.\n"),
  "docs/report.pdf": pdf(),
  "data/table.csv": Buffer.from("month,rain_mm,days,station\nJan,61,12,North\nFeb,48,10,North\nMar,52,11,South\nApr,44,9,South\nMay,49,8,East\nJun,45,7,East\n"),
  "data/sample.json": Buffer.from(JSON.stringify({ name: "field-kit", version: 3, active: true, owner: null, items: [{ id: 1, label: "Tent", kg: 2.1 }, { id: 2, label: "Stove", kg: 0.4 }], url: "https://example.com/kit" }, null, 2)),
  "notebooks/rain.ipynb": notebook(),
  "src/app.py": Buffer.from('"""Pack the field kit."""\nfrom dataclasses import dataclass\n\n\n@dataclass\nclass Item:\n    label: str\n    kg: float\n\n\ndef weight(items: list[Item]) -> float:\n    # Total weight in kilograms\n    return sum(i.kg for i in items)\n\n\nif __name__ == "__main__":\n    print(weight([Item("Tent", 2.1), Item("Stove", 0.4)]))\n'),
  "page.html": Buffer.from('<!doctype html><meta charset="utf-8"><title>Page</title><style>body{font-family:sans-serif;margin:2rem}</style><h1>A user page</h1><p>Shown in a frame.</p>'),
  "styles.css": Buffer.from("body { margin: 0; }\n"),
  "gallery/one.png": png(160, 120, 1),
  "gallery/two.png": png(160, 120, 2),
  "gallery/three.png": png(160, 120, 3),
  "gallery/four.svg": svg("four", 160),
  "gallery/five.svg": svg("five", 30),
  "gallery/six.png": png(160, 120, 6),
  "gallery/raw/a.txt": Buffer.from("raw a\n"),
  "gallery/thumbs/b.txt": Buffer.from("thumb b\n"),
  "media/photo.png": png(480, 320, 5),
  "media/logo.svg": svg("logo", 200),
  "media/tone.wav": wav(),
  "media/clip.webm": Buffer.from("not a real video"),
  "fonts/Mono.woff2": FONT,
  "bin/blob.bin": Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37) % 256)),
  "logs/big.log": longLog(),
});

// ------------------------------------------------------------------ worker

function bundle(dir) {
  execFileSync(join(ROOT, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", dir, "--config", join(ROOT, "wrangler.jsonc")], { cwd: ROOT, stdio: "pipe" });
  return join(dir, "index.js");
}

async function startWorker(tmp) {
  const script = bundle(join(tmp, "bundle"));
  // Miniflare 5 takes the new options shape; the v4 shape (one worker) converts.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: script,
      modulesRoot: dirname(script),
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { APP_ORIGIN: APP, SITES_MODE: "subdomain", SITES_DOMAIN: SITES, SITES_ORIGIN: "", ANONYMOUS_PUBLISH: "true", ADMIN_BOOTSTRAP_KEY: BOOT, SIGNING_SECRET: "harness-signing-secret" },
      d1Databases: ["DB"],
      r2Buckets: ["FILES"],
      kvNamespaces: ["CACHE"],
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const f of readdirSync(join(ROOT, "packages/core/migrations")).sort()) {
    const sql = readFileSync(join(ROOT, "packages/core/migrations", f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
  }
  return { mf, db };
}

// ------------------------------------------------------------------ seeding

async function seed(mf, db) {
  const call = async (url, init = {}) => {
    const res = await mf.dispatchFetch(url, { redirect: "manual", ...init });
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    if (res.status >= 400) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status} ${text.slice(0, 300)}`);
    return body;
  };
  const auth = (key, extra = {}) => ({ Authorization: `Bearer ${key}`, ...extra });
  const json = (key, method, body) => ({ method, headers: auth(key, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
  const setup = await call(`${APP}/api/v1/setup`, json(BOOT, "POST", { email: "owner@kofra.test", name: "Ana Ruiz" }));
  const owner = setup.apiKey.key;
  // Multipart built by hand: Node's FormData is not the one Miniflare's fetch serialises.
  const multipart = (files) => {
    const boundary = `----kofra${Math.random().toString(16).slice(2)}`;
    const parts = [];
    for (const [p, b] of Object.entries(files)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p}"; filename="${p.split("/").pop()}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(b), Buffer.from("\r\n"));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
  };
  const publish = async (slug, files, message, key = owner) => {
    const m = multipart(files);
    const q = [slug ? `slug=${slug}` : "", message ? `message=${encodeURIComponent(message)}` : ""].filter(Boolean).join("&");
    return call(`${APP}/api/v1/publish${q ? `?${q}` : ""}`, { method: "POST", headers: key ? auth(key, { "Content-Type": m.type }) : { "Content-Type": m.type }, body: m.body });
  };
  const create = (slug) => call(`${APP}/api/v1/sites`, json(owner, "POST", { slug }));
  const all = SITE_FILES();
  await create("fx-site");
  await publish("fx-site", { "index.html": all["index.html"], "README.md": all["README.md"] }, "First draft");
  await publish("fx-site", { "index.html": all["index.html"], "README.md": all["README.md"], "docs/guide.md": all["docs/guide.md"] }, "Add the guide");
  await publish("fx-site", all, "Field kit, complete");
  await call(`${APP}/api/v1/sites/fx-site`, json(owner, "PATCH", { title: "Field notes", description: "Kit lists, guides and data for the autumn trip." }));
  await create("fx-pw");
  await publish("fx-pw", { "index.html": Buffer.from("<h1>Private</h1>") }, "Locked page");
  await call(`${APP}/api/v1/sites/fx-pw`, json(owner, "PATCH", { password: "correct horse" }));
  await create("fx-empty");
  await create("fx-spa");
  await publish("fx-spa", { "index.html": Buffer.from("<div id=app></div>") }, "SPA shell");
  await call(`${APP}/api/v1/sites/fx-spa`, json(owner, "PATCH", { spa: true }));
  await create("fx-long");
  await publish("fx-long", { "index.html": Buffer.from("<p>long</p>") });
  await call(`${APP}/api/v1/sites/fx-long`, json(owner, "PATCH", { title: "A very long site title that keeps going to test wrapping in the sites table on small screens" }));
  await create("a-very-long-slug-name-for-layout-tests-1234567");
  await publish("a-very-long-slug-name-for-layout-tests-1234567", { "index.html": Buffer.from("<p>slug</p>") });
  await create("fx-broken");
  const broken = await publish("fx-broken", { "index.html": Buffer.from("<p>broken page</p>"), "lost.txt": Buffer.from("this blob is deleted by the harness") });
  // Expiring (owned) site: a date in the future, so the chip shows.
  await db.prepare("UPDATE sites SET expires_at = ? WHERE slug = ?").bind(Date.parse("2026-10-30T09:00:00Z"), "fx-long").run();
  // Anonymous sites: one expired, one live (the report link).
  const anon = await publish(null, { "index.html": Buffer.from("<h1>Temp</h1>") }, null, null);
  await db.prepare("UPDATE sites SET expires_at = ? WHERE slug = ?").bind(Date.parse("2026-10-20T00:00:00Z"), anon.slug).run();
  const anonLive = await publish(null, { "index.html": Buffer.from('<!doctype html><title>Hello</title><h1 style="font-family:sans-serif">Hello from an anonymous page</h1>') }, null, null);
  // Keys and members.
  for (const [name, scopes] of [["claude-code on laptop", ["sites:read", "sites:write"]], ["ci deploys", ["sites:write"]], ["read-only dashboard", ["sites:read"]]]) {
    await call(`${APP}/api/v1/keys`, json(owner, "POST", { name, scopes }));
  }
  await call(`${APP}/api/v1/members`, json(owner, "POST", { email: "sam@kofra.test", name: "Sam Lee", role: "admin" }));
  await call(`${APP}/api/v1/members`, json(owner, "POST", { email: "jo@kofra.test", role: "member" }));
  // A file whose bytes are gone (502).
  const files = await call(`${APP}/api/v1/sites/fx-broken/files`, { headers: auth(owner) });
  const lost = files.files.find((f) => f.path === "lost.txt");
  if (!lost) throw new Error(`fx-broken files: ${JSON.stringify(files).slice(0, 400)}`);
  await (await mf.getR2Bucket("FILES")).delete(`blobs/${lost.sha256}`);
  // The live-site cache (KV, plus 5 s in isolate memory) still holds the rows changed in D1 above.
  const kv = await mf.getKVNamespace("CACHE");
  for (const k of (await kv.list()).keys) await kv.delete(k.name);
  await new Promise((r) => setTimeout(r, 5500));
  void broken;
  return { owner, anonExpired: anon.slug, anonLive: anonLive.slug };
}

// ------------------------------------------------------------------ screens

/** Core screens (PORT-SPEC 9.2, the rows the core worker renders). */
function screens(fx) {
  const app = (id, title, path, more = {}) => ({ id, title, origin: "app", url: `${APP}${path}`, auth: true, ...more });
  const s = (id, title, url, more = {}) => ({ id, title, origin: "site", url, ...more });
  const holdSites = async (page) => {
    await page.route(`${APP}/api/v1/sites?limit=100*`, () => {}, { times: 1 }); // never answered: the loading state stays
  };
  return [
    app("J03", "A02 Self-host home, set up", "/", { auth: false }),
    app("J10", "A07 API-key sign-in", "/login", { auth: false }),
    app("J12", "A07 Owner key shown once after recovery", "/login", {
      auth: false,
      act: async (page) => {
        await page.click("summary");
        await page.fill("#dw-recover-secret", BOOT);
        await page.click("#dw-recover button[type=submit]");
        await page.waitForSelector("#dw-recover .k-keyout");
      },
    }),
    app("J13", "A08 Sites, loading", "/dashboard", { before: holdSites, wait: ".k-skel" }),
    app("J15", "A08 Sites, list", "/dashboard", { wait: "#dw-sites tbody tr" }),
    app("J16", "A09 Site, full", "/dashboard/sites/fx-site", { wait: "#files tbody tr" }),
    app("J17", "A09 Delete-site dialog", "/dashboard/sites/fx-site", {
      wait: "#files tbody tr",
      act: async (page) => {
        await page.click("text=Delete site >> nth=-1");
        await page.fill("#dw-dlg-input", "fx-s");
      },
    }),
    app("J18", "A09 Site with no live version", "/dashboard/sites/fx-empty", { wait: ".k-versions, .k-empty" }),
    app("J19", "A09 Error toast", "/dashboard/sites/fx-site", {
      wait: "#files tbody tr",
      act: async (page) => {
        await page.route(`${APP}/api/v1/sites/fx-site`, (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid_title", message: "That title is too long.", hint: "Use at most 200 characters." } }) }) : r.fallback()));
        await page.click("text=Save settings");
        await page.waitForSelector(".k-toast.k-danger");
      },
      expectFailed: ["PATCH /api/v1/sites/fx-site"],
    }),
    app("J20", "A10 Publish, idle", "/dashboard/publish", { wait: ".k-dropzone" }),
    app("J21", "A10 Publish, files chosen + warning", "/dashboard/publish", {
      wait: ".k-dropzone",
      act: async (page) => {
        const input = page.locator("#dw-publish input[type=file]:not([webkitdirectory])");
        await input.setInputFiles(["about.md", "notes.txt", "photo.png", "data.csv", "styles.css"].map((name) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(`file ${name}\n`) })));
        await page.waitForSelector(".k-chosen .k-frow");
      },
    }),
    app("J23", "A10 Publish, success", "/dashboard/publish", {
      wait: ".k-dropzone",
      act: async (page) => {
        const input = page.locator("#dw-publish input[type=file]:not([webkitdirectory])");
        await input.setInputFiles([{ name: "index.html", mimeType: "text/html", buffer: Buffer.from("<h1>new</h1>") }]);
        await page.fill("#dw-pub-slug", `fx-new-${Math.random().toString(36).slice(2, 7)}`);
        await page.click("text=Publish >> nth=-1");
        await page.waitForSelector("#dw-publish .k-keyout", { timeout: 15000 });
      },
    }),
    app("J24", "A11 API keys", "/dashboard/keys", { wait: "#dw-keys tbody tr" }),
    app("J25", "A11 Key created", "/dashboard/keys", {
      wait: "#dw-keys tbody tr",
      act: async (page) => {
        await page.fill("#dw-k-name", "harness key");
        await page.click("text=Create key");
        await page.waitForSelector("#dw-keys .k-keyout");
      },
    }),
    app("J26", "A11 Revoke dialog", "/dashboard/keys", {
      wait: "#dw-keys tbody tr",
      act: async (page) => {
        await page.click("#dw-keys tbody tr:nth-child(2) .k-danger");
        await page.waitForSelector("dialog[open]");
      },
    }),
    app("J27", "A12 Settings, owner", "/dashboard/settings", { wait: "#dw-members tbody tr" }),
    app("J28", "A13 App viewer, Markdown file", "/v/fx-site/README.md", { wait: ".k-tree a[aria-current]", frame: true }),
    app("J29", "A13 App viewer, folder", "/v/fx-site/docs/", { wait: ".k-tree", frame: true }),
    app("J30", "A13 App viewer, password site", "/v/fx-pw/", { wait: ".k-tree", frame: true, expectFailed: ["GET / 401"] }),
    app("J42", "A24 Claim a site", `/claim?slug=${fx.anonLive}`, { auth: false }),
    app("J43", "A25 Encrypted site wrapper", "/__dropway/encrypted/fx-site", { auth: false, expectConsole: true, expectFailed: ["GET /encrypted.bin"] }),
    app("J44", "A26 Not found", "/nope", { auth: false, status: 404 }),
    s("J46", "S01 Unknown site", site("nosuch"), { status: 404 }),
    s("J48", "S01 Page not found", site("fx-site", "missing.html"), { status: 404 }),
    s("J49", "S01 Nothing published yet", site("fx-empty"), { status: 404 }),
    s("J50", "S01 Bad address 400", site("fx-site", "%ff"), { status: 400 }),
    s("J51", "S01 Expired 410", site(fx.anonExpired), { status: 410 }),
    s("J52", "S01 File unavailable 502", site("fx-broken", "lost.txt?raw=1"), { status: 502 }),
    s("J53", "S02 Password prompt", site("fx-pw"), { status: 401 }),
    s("J54", "S02 Wrong password", site("fx-pw"), {
      status: 401,
      act: async (page) => {
        await page.fill("#dw-pw", "wrong one");
        await page.click("text=Open");
        await page.waitForSelector(".k-msgline.k-err");
      },
      expectFailed: ["POST /__dropway/password"],
    }),
    s("J56", "S04 Listing with gallery", site("fx-site", "gallery/")),
    s("J57", "S05 Markdown", site("fx-site", "README.md")),
    s("J58", "S05 Notebook", site("fx-site", "notebooks/rain.ipynb")),
    s("J59", "S05 JSON", site("fx-site", "data/sample.json")),
    s("J60", "S05 CSV", site("fx-site", "data/table.csv")),
    s("J61", "S05 SVG", site("fx-site", "media/logo.svg")),
    s("J62", "S05 Image", site("fx-site", "media/photo.png")),
    s("J63", "S05 PDF", site("fx-site", "docs/report.pdf")),
    s("J64", "S05 Video", site("fx-site", "media/clip.webm"), { expectConsole: true }),
    s("J65", "S05 Audio", site("fx-site", "media/tone.wav")),
    s("J66", "S05 Font", site("fx-site", "fonts/Mono.woff2")),
    s("J67", "S05 Code", site("fx-site", "src/app.py")),
    s("J68", "S05 Source", site("fx-site", "index.html?view=source")),
    s("J69", "S05 Binary", site("fx-site", "bin/blob.bin?view=1")),
    s("J70", "S05 HTML page in the viewer frame", site("fx-site", "page.html?view=1")),
    s("J71", "S05 Truncated note", site("fx-site", "logs/big.log"), { viewportOnly: true }),
    s("J72", "S06 Report link on an anonymous page", site(fx.anonLive), { userPage: true }),
  ];
}

// ------------------------------------------------------------------ run

const BANNED = /\b(dropway|scanned|virus|virus-free|verified)\b/i;

async function main() {
  if (!CHROME) throw new Error("No Chrome: set CHROME_PATH");
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "kofra-shots-"));
  const { mf, db } = await startWorker(tmp);
  const fx = await seed(mf, db);
  const list = screens(fx).filter((s) => !ONLY || ONLY.has(s.id));
  const axeSource = readFileSync(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--font-render-hinting=none", "--disable-gpu"] });
  const matrix = [];
  try {
    for (const sc of list) {
      for (const mode of MODES) {
        for (const width of WIDTHS) {
          const cell = await runCell(browser, mf, fx, sc, mode, width, axeSource).catch((e) => ({ screen: sc.id, title: sc.title, mode, width, file: null, gates: { harness: { pass: false, detail: String(e).slice(0, 300) } } }));
          matrix.push(cell);
          const bad = Object.entries(cell.gates).filter(([, v]) => !v.pass).map(([k]) => k);
          console.log(`${sc.id} ${mode} ${width}: ${bad.length ? `FAIL ${bad.join(",")}` : "ok"}`);
        }
      }
    }
  } finally {
    await browser.close();
    await mf.dispose();
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, "matrix.json"), JSON.stringify({ generatedAt: new Date().toISOString(), target: "core", cells: matrix }, null, 1));
  writeFileSync(join(OUT, "index.html"), gallery(list, matrix));
  const failed = matrix.filter((c) => Object.values(c.gates).some((g) => !g.pass));
  console.log(`${matrix.length} cells, ${failed.length} with a failing check. ${OUT}`);
}

async function runCell(browser, mf, fx, sc, mode, width, axeSource) {
  const explicit = mode === "light" || mode === "dark" ? mode : null;
  const os = explicit ? (explicit === "dark" ? "light" : "dark") : mode.replace("auto-", "");
  const expected = explicit ?? os;
  const context = await browser.newContext({ ...VIEWPORTS[width], colorScheme: os, timezoneId: "Europe/London", locale: "en-GB", ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  const failed = [];
  const consoleMsgs = [];
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (!/^https:\/\/([a-z0-9-]+\.)?kofra(-sites)?\.test\//.test(url)) return route.abort();
    const headers = await req.allHeaders();
    const body = req.postDataBuffer();
    const res = await mf.dispatchFetch(url, { method: req.method(), headers, body: body && req.method() !== "GET" && req.method() !== "HEAD" ? body : undefined, redirect: "manual" });
    const out = {};
    res.headers.forEach((v, k) => {
      out[k] = v;
    });
    await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
  });
  if (explicit && sc.origin === "app") await context.addCookies([{ name: "__Host-dw_theme", value: explicit, url: `${APP}/`, secure: true, sameSite: "Lax" }]);
  await context.addInitScript(({ key, auth }) => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
    if (auth && location.hostname === "kofra.test") sessionStorage.setItem("dropway.key", key);
  }, { key: fx.owner, auth: !!sc.auth });
  const page = await context.newPage();
  await page.clock.setFixedTime(FROZEN);
  let collecting = true;
  page.on("console", (m) => {
    if (collecting && (m.type() === "error" || m.type() === "warning")) consoleMsgs.push(`${m.type()}: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`);
  });
  if (sc.before) await sc.before(page);
  let url = sc.url;
  if (explicit && sc.origin === "site") url += (url.includes("?") ? "&" : "?") + `theme=${explicit}`;
  const t0 = Date.now();
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: "load", timeout: 30000 });
    status = resp?.status() ?? 0;
    if (sc.wait) await page.waitForSelector(sc.wait, { timeout: 15000 }).catch(() => {});
    if (sc.act) await sc.act(page);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(sc.frame ? 900 : 200);
  } catch (e) {
    consoleMsgs.push(`harness: ${e.message.split("\n")[0]}`);
  }
  const file = `${sc.id}-${mode}-${width}.png`;
  // Very tall pages (the truncated log) are captured one viewport high.
  const png = await page.screenshot({ path: join(OUT, file), fullPage: !sc.viewportOnly }).catch(() => page.screenshot({ path: join(OUT, file) }));
  const probe = await page.evaluate((vw) => {
    // Elements that stick out past the viewport (a phone would zoom the whole page out to show them).
    const wide = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > vw + 1 && !el.closest(".k-table-wrap, pre, .k-tree, .dw-src, .dw-csvwrap, .dw-jtree, .k-codeblock")) {
        const name = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "");
        wide.push(`${name} ${Math.round(r.right)}`);
      }
    }
    const cs = getComputedStyle(document.body);
    const h1 = document.querySelector("h1");
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      bg: cs.backgroundColor,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      fonts: { sans: document.fonts.check('16px "Public Sans"'), serif: document.fonts.check('500 40px "Newsreader"'), mono: document.fonts.check('12px "Martian Mono"') },
      h1Font: h1 ? getComputedStyle(h1).fontFamily : null,
      text: document.body.innerText,
      csp: window.__cspViolations || [],
      wide: wide.slice(0, 6),
    };
  }, width);
  let axe = { violations: [] };
  collecting = false; // axe messages its frames; Chrome warns about cross-origin ones. Not the page's own output.
  try {
    await page.evaluate(axeSource);
    axe = await page.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] }));
  } catch (e) {
    axe = { violations: [{ id: "axe-error", help: String(e).slice(0, 200), nodes: [] }] };
  }
  await context.close();
  const expectFailed = (sc.expectFailed ?? []).concat(sc.status ? [`${new URL(sc.url).pathname}`] : []);
  const unexpected = failed.filter((f) => !expectFailed.some((x) => f.includes(x.replace(/^(GET|POST|PATCH) /, ""))) && !/\/favicon\.ico/.test(f));
  const userContent = sc.id === "J70" || sc.id === "J72";
  const gates = {
    csp: { pass: probe.csp.length === 0, detail: probe.csp },
    console: { pass: sc.expectConsole ? true : consoleMsgs.filter((m) => !/Failed to load resource/.test(m) || unexpected.length).length === 0 && unexpected.length === 0, detail: [...consoleMsgs, ...unexpected] },
    axe: { pass: sc.userPage || axe.violations.length === 0, detail: axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`) },
    overflow: { pass: probe.scrollWidth <= width && probe.innerWidth <= width, detail: { scrollWidth: probe.scrollWidth, innerWidth: probe.innerWidth, wide: probe.wide } },
    mode: { pass: sc.userPage || (explicit ? probe.theme === explicit : probe.theme === null) && probe.bg === PAPER[expected], detail: `data-theme=${probe.theme} bg=${probe.bg} expected ${expected}` },
    fonts: { pass: probe.fonts.sans && (!probe.h1Font || !probe.h1Font.includes("Newsreader") || probe.fonts.serif), detail: probe.fonts },
    brand: { pass: userContent || !BANNED.test(probe.text), detail: (probe.text.match(BANNED) ?? [])[0] ?? null },
    status: { pass: !sc.status || status === sc.status, detail: status },
  };
  return { screen: sc.id, title: sc.title, mode, width, file, sha256: createHash("sha256").update(png).digest("hex"), ms: Date.now() - t0, gates };
}

function gallery(list, matrix) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = list
    .map((sc) => {
      const cells = matrix.filter((c) => c.screen === sc.id);
      return `<section><h2>${esc(sc.id)} · ${esc(sc.title)}</h2><div class="g">${cells
        .map((c) => {
          const bad = Object.entries(c.gates).filter(([, v]) => !v.pass).map(([k]) => k);
          return `<figure><a href="${esc(c.file)}"><img loading="lazy" src="${esc(c.file)}" alt="${esc(`${sc.id} ${c.mode} ${c.width}`)}"></a><figcaption>${esc(c.mode)} · ${c.width}px ${bad.length ? `<b>${esc(bad.join(", "))}</b>` : "ok"}</figcaption></figure>`;
        })
        .join("")}</div></section>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kofra Security Print port: core screenshots</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;background:#f4efe2;color:#141414}h1{font-weight:600}section{margin:0 0 40px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}figure{margin:0}img{width:100%;height:260px;object-fit:cover;object-position:top;border:1px solid #b08d3c;background:#fff}b{color:#a8321f}</style><h1>Kofra Security Print port: core screens (${matrix.length} cells)</h1>${rows}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
