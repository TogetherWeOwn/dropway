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
//   brand    no visible former product name, no "scanned/virus/verified" claims outside user content
//   status   the HTTP status the screen expects
//   tokens   (G8) color-scheme and theme-color metas match the mode; no old-palette colour in the HTML or CSS
//   fontload (G9) font responses carry the section-4 headers; layout shift <= 0.02 on a separate, uncached load
//            of the same address with the app's API held (so only the page, its CSS and its fonts can move
//            it), counted until the fonts are ready + 300 ms
//   motion   (G11) reduced motion: no transitions on buttons and the switch, no skeleton animation, no smooth scroll
//   flash    (G7) explicit modes: the HTML already carries data-theme, and every frame painted until load has
//            the mode's paper behind it (sampled each animation frame from the first one)
//   focus    (G4) Tab from the top through every focusable element: each shows a ring >= 2px with >= 3:1
//            against what is behind it, is in the viewport and not covered; app pages start at "Skip to
//            content"; an open dialog keeps focus inside
//   identity (G6) auto with the OS light is pixel-identical to light, and auto with the OS dark to dark
//            (the mode switch, whose pressed state differs, and per-screen secrets are masked; channel
//            deltas of 2/255 or less, rasteriser rounding on anti-aliased edges, are reported as noise)
// Extra passes: every screen in Light at 320 px (reflow), forced colours (G12: axe and focus) on J15, J16,
// J53 and J57, and the switch itself (G13: no-script POST, in-place switch with the script, keyboard,
// persistence across a reload).
// Explicit modes use the __Host-dw_theme cookie on the app origin and ?theme= on site origins; Auto uses
// the emulated prefers-color-scheme and no cookie.
//
// Usage: node packages/server/test/e2e-design/shots.mjs --out <dir> [--only J03,J08] [--widths 390,1440] [--modes light,dark] [--no-extra]
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
const CONCURRENCY = Number(arg("concurrency", "4"));
const EXTRA = !args.includes("--no-extra");
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
  320: { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const PAPER = { light: "rgb(244, 239, 226)", dark: "rgb(15, 22, 38)" };
const THEME_COLOR = { light: "#F4EFE2", dark: "#0F1626" };
/** The retired palette (PORT-SPEC 9.3 G8): none of these may appear in a page or its CSS. */
const OLD_HEX = ["#fbfaf8", "#1d1b19", "#d9480f", "#141312", "#ece8e2", "#ff8a4c", "#1a7f37", "#cf222e"];
/** Forced-colours pass (PORT-SPEC 9.1): the core screens of J06, J15, J16, J53, J57. */
const FORCED = new Set(["J15", "J16", "J53", "J57"]);

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

/** Split a migration into statements; a CREATE TRIGGER ... BEGIN ... END; body stays one statement. */
function sqlStatements(sql) {
  const out = [];
  let cur = "";
  for (const part of sql.split(/;\s*(?:\n|$)/)) {
    cur = cur ? `${cur};\n${part}` : part;
    const t = cur.trim();
    if (!t) {
      cur = "";
      continue;
    }
    if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(t) && !/\bEND$/i.test(t)) continue;
    out.push(t);
    cur = "";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

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
    for (const stmt of sqlStatements(sql)) await db.prepare(stmt).run();
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

/** Clean-up after a mutating cell, so the next cell sees the data as seeded. `api` calls /api/v1 as the owner. */
const revokeKeys = (name) => async (api) => {
  const { keys } = await api("/keys");
  for (const k of keys ?? []) if (k.name === name) await api(`/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
};
const deleteSite = async (api, state) => {
  if (state.slug) await api(`/sites/${encodeURIComponent(state.slug)}`, { method: "DELETE" });
};

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
      mutates: true,
      act: async (page) => {
        await page.click("summary");
        await page.fill("#dw-recover-secret", BOOT);
        await page.click("#dw-recover button[type=submit]");
        await page.waitForSelector("#dw-recover .k-keyout");
      },
      // The new key differs in every cell; each cell then revokes it, so the key lists stay as seeded.
      mask: [".k-keyout code", ".k-codeblock pre"],
      after: revokeKeys("recovery"),
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
    app("J22", "A10 Publish, uploading", "/dashboard/publish", {
      wait: ".k-dropzone",
      mutates: true,
      act: async (page, state) => {
        // Five new files of the same size; the first three uploads finish, the last two never get an
        // answer, so the bar holds at 64 % ("Uploaded 3 of 5").
        let puts = 0;
        await page.route(`${APP}/**`, (r) => (r.request().method() === "PUT" && ++puts > 3 ? undefined : r.fallback()));
        const nonce = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
        const input = page.locator("#dw-publish input[type=file]:not([webkitdirectory])");
        await input.setInputFiles(["index.html", "about.html", "notes.txt", "data.csv", "styles.css"].map((name) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(`${name} ${nonce} `.padEnd(4096, ".")) })));
        state.slug = `fx-up-${nonce}`;
        await page.fill("#dw-pub-slug", state.slug);
        await page.click("text=Publish >> nth=-1");
        await page.waitForFunction(() => Number(document.querySelector(".k-prog")?.getAttribute("aria-valuenow")) >= 60, null, { timeout: 15000 });
      },
      mask: ["#dw-pub-slug"],
      after: deleteSite,
    }),
    app("J23", "A10 Publish, success", "/dashboard/publish", {
      wait: ".k-dropzone",
      mutates: true,
      act: async (page, state) => {
        const input = page.locator("#dw-publish input[type=file]:not([webkitdirectory])");
        // New bytes in every cell (same length), so no cell reuses a blob an earlier cell stored.
        const nonce = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
        await input.setInputFiles([{ name: "index.html", mimeType: "text/html", buffer: Buffer.from(`<h1>new ${nonce}</h1>`) }]);
        state.slug = `fx-new-${nonce.slice(0, 5)}`;
        await page.fill("#dw-pub-slug", state.slug);
        await page.click("text=Publish >> nth=-1");
        await page.waitForSelector("#dw-publish .k-keyout", { timeout: 15000 });
      },
      // The new site's address is random per cell; each cell deletes its site afterwards.
      mask: ["#dw-pub-slug", "#dw-pub-site", "#dw-publish .k-keyout code"],
      after: deleteSite,
    }),
    app("J24", "A11 API keys", "/dashboard/keys", { wait: "#dw-keys tbody tr" }),
    app("J25", "A11 Key created", "/dashboard/keys", {
      wait: "#dw-keys tbody tr",
      mutates: true,
      act: async (page) => {
        await page.fill("#dw-k-name", "harness key");
        await page.click("text=Create key");
        await page.waitForSelector("#dw-keys .k-keyout");
      },
      // The secret and its prefix differ per cell; each cell revokes its key afterwards.
      mask: [".k-keyout code", "#dw-keys .k-codeblock pre", "#dw-keys tbody tr:has-text('harness key') .k-mono"],
      after: revokeKeys("harness key"),
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
    app("J30", "A13 App viewer, password site", "/v/fx-pw/", { wait: ".k-tree", frame: true, expectFailed: ["GET / 401", "GET /__dropway/open 401"] }),
    app("J42", "A24 Claim a site", `/claim?slug=${fx.anonLive}`, { auth: false }),
    app("J43", "A25 Encrypted site wrapper", "/__dropway/encrypted/fx-site", { auth: false, expectConsole: true, expectFailed: ["GET /encrypted.bin"], noSkip: true }), // minimal chrome (A25): wordmark, warning, frame
    app("J44", "A26 Not found", "/nope", { auth: false, status: 404 }),
    // A second, empty instance: not set up yet, then set up with no sites, then a broken database.
    app("J04", "A02 Self-host home, not set up", "/", { auth: false, worker: "fresh" }),
    app("J11", "A07 API-key sign-in, not set up", "/login", { auth: false, worker: "fresh" }),
    app("J14", "A08 Sites, empty", "/dashboard", { worker: "fresh", needsOwner: true, wait: ".k-empty" }),
    // Built once at module load with no request data, so it follows the device only (no ?theme).
    s("J74", "S08 Platform error 500", site("anything"), { worker: "fresh", breakDb: true, status: 500, staticTheme: true }),
    s("J46", "S01 Unknown site", site("nosuch"), { status: 404 }),
    s("J47", "S01 Reserved host", site("files", "x"), { status: 404 }),
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
    s("J63", "S05 PDF", site("fx-site", "docs/report.pdf"), { viewportOnly: true }), // a full-height layout
    // The browser's own video control animates while it gives up on the (invalid) clip: masked for G6.
    s("J64", "S05 Video", site("fx-site", "media/clip.webm"), { expectConsole: true, mask: ["video"] }),
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

// The former product name is assembled so the rebrand check does not flag this file.
const BANNED = new RegExp(`\\b(${["drop", "way"].join("")}|scanned|virus|virus-free|verified)\\b`, "i");

/**
 * The failed requests a screen did not expect. Each failure is "<METHOD> <path> <status>". An expected
 * failure names the method and the exact path, and optionally the status; a screen that expects a status
 * (sc.status) excuses only its own navigation with that status, never an asset that failed alongside it.
 */
export function unexpectedFailures(failed, sc) {
  const req = (x) => {
    const [method, path, status] = x.split(" ");
    return { method, path, status };
  };
  const expected = (sc.expectFailed ?? []).concat(sc.status ? [`GET ${new URL(sc.url).pathname} ${sc.status}`] : []).map(req);
  return failed.filter((f) => {
    const a = req(f);
    return a.path !== "/favicon.ico" && !expected.some((e) => e.method === a.method && e.path === a.path && (!e.status || e.status === a.status));
  });
}

/** Refuse a selection that would run nothing (or not what was asked) before starting anything. */
export function checkSelection(only = ONLY, widths = WIDTHS, modes = MODES) {
  const ids = screens({ owner: "", anonExpired: "x", anonLive: "y" }).map((s) => s.id);
  const unknown = [...(only ?? [])].filter((id) => !ids.includes(id));
  if (unknown.length) throw new Error(`--only: no such screen ${unknown.join(", ")}`);
  const badWidth = widths.filter((w) => !VIEWPORTS[w] || w === 320);
  const badMode = modes.filter((m) => !["light", "dark", "auto-light", "auto-dark"].includes(m));
  if (!widths.length || !modes.length || badWidth.length || badMode.length) throw new Error(`Nothing valid to run: widths ${widths.join(",") || "none"} (390, 768, 1440), modes ${modes.join(",") || "none"} (light, dark, auto-light, auto-dark)`);
}

/** Own the fresh worker's directory until startup succeeds and the caller takes over cleanup. */
export async function startFreshWorker(start = startWorker) {
  const dir = mkdtempSync(join(tmpdir(), "kofra-shots-fresh-"));
  try {
    return { ...(await start(dir)), dir };
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {} // A cleanup error must not replace the original startup error.
    throw error;
  }
}

async function main() {
  checkSelection();
  if (!CHROME) throw new Error("No Chrome: set CHROME_PATH");
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "kofra-shots-"));
  const maskDir = join(tmp, "masked");
  mkdirSync(maskDir, { recursive: true });
  // The temporary directories are this run's: removed on every path out, including a failed start.
  const { mf, db } = await startWorker(tmp).catch((e) => {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  });
  const fx = await seed(mf, db);
  const list = screens(fx).filter((s) => !ONLY || ONLY.has(s.id));
  // Fresh-instance screens run last, in order: not set up, then set up (no sites), then a broken database.
  const fresh = list.filter((s) => s.worker === "fresh").sort((a, b) => (a.needsOwner ? 1 : 0) + (a.breakDb ? 2 : 0) - ((b.needsOwner ? 1 : 0) + (b.breakDb ? 2 : 0)));
  const main = list.filter((s) => s.worker !== "fresh");
  const axeSource = readFileSync(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--font-render-hinting=none", "--disable-gpu", "--disable-lcd-text"] });
  const matrix = [];
  const checks = {};
  let second = null;
  try {
    const record = (sc, mode, width, cell) => {
      matrix.push(cell);
      const bad = Object.entries(cell.gates).filter(([, v]) => !v.pass).map(([k]) => k);
      console.log(`${sc.id} ${cell.pass === "matrix" ? "" : `${cell.pass} `}${mode} ${width}: ${bad.length ? `FAIL ${bad.join(",")}` : "ok"}`);
    };
    const failCell = (sc, mode, width, pass) => (e) => ({ screen: sc.id, title: sc.title, pass, mode, width, file: null, gates: { harness: { pass: false, detail: String(e).slice(0, 300) } } });
    // Every screen: the 12 matrix cells, then (extra passes) Light at 320 px and, for FORCED, forced colours.
    const jobsFor = (sc) => [
      ...MODES.flatMap((mode) => WIDTHS.map((width) => [sc, mode, width, "matrix"])),
      ...(EXTRA ? [[sc, "light", 320, "reflow"]] : []),
      ...(EXTRA && FORCED.has(sc.id) ? [390, 1440].map((width) => [sc, "light", width, "forced"]) : []),
    ];
    const runOn = (worker, ctx) => async ([sc, mode, width, pass]) =>
      record(sc, mode, width, await runCell(browser, worker, ctx, sc, mode, width, axeSource, { pass, maskDir }).catch(failCell(sc, mode, width, pass)));
    // Read-only seeded-instance cells run CONCURRENCY at a time (each in its own browser context) and all finish
    // first. Screens that change the data (a new owner key, a new site, a new key) then run one cell at a time
    // and clean up after themselves, so every cell sees the data as seeded and no two mutating cells race.
    const runOne = runOn(mf, fx);
    const readOnly = main.filter((x) => !x.mutates).flatMap(jobsFor);
    let next = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < readOnly.length) await runOne(readOnly[next++]);
      }),
    );
    for (const job of main.filter((x) => x.mutates).flatMap(jobsFor)) await runOne(job);
    if (EXTRA && !ONLY) checks.themeSwitch = await themeSwitchChecks(browser, mf, fx);
    for (const sc of fresh) {
      if (!second) second = await startFreshWorker();
      if (sc.needsOwner && !second.owner) {
        const r = await second.mf.dispatchFetch(`${APP}/api/v1/setup`, { method: "POST", headers: { Authorization: `Bearer ${BOOT}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: "new@kofra.test" }) });
        second.owner = (await r.json()).apiKey.key;
      }
      if (sc.breakDb && !second.broken) {
        await second.db.prepare("DROP TABLE version_files").run().catch(() => {});
        await second.db.prepare("DROP TABLE sites").run().catch(() => {});
        second.broken = true;
      }
      const run = runOn(second.mf, { ...fx, owner: second.owner ?? fx.owner });
      for (const job of jobsFor(sc)) await run(job);
    }
    // G6: auto with the OS light must equal light, and auto with the OS dark must equal dark, pixel for pixel.
    for (const c of matrix.filter((x) => x.pass === "matrix" && x.mode.startsWith("auto-") && x.masked && !list.find((s) => s.id === x.screen)?.staticTheme)) {
      const ref = matrix.find((x) => x.pass === "matrix" && x.screen === c.screen && x.width === c.width && x.mode === c.mode.replace("auto-", "") && x.masked);
      if (!ref) continue;
      const a = readFileSync(c.masked);
      const b = readFileSync(ref.masked);
      const same = a.equals(b) ? { diff: 0 } : await pixelDiff(browser, a, b);
      c.gates.identity = { pass: same.diff === 0, detail: { against: ref.file, ...same } };
      if (same.diff !== 0) {
        // Keep the two masked images for whoever looks into it.
        mkdirSync(join(OUT, "identity"), { recursive: true });
        writeFileSync(join(OUT, "identity", c.file), a);
        writeFileSync(join(OUT, "identity", ref.file), b);
        console.log(`${c.screen} ${c.mode} ${c.width}: FAIL identity ${JSON.stringify(same)}`);
      }
    }
    for (const c of matrix) delete c.masked;
    matrix.sort((a, b) => list.findIndex((s) => s.id === a.screen) - list.findIndex((s) => s.id === b.screen) || PASSES.indexOf(a.pass) - PASSES.indexOf(b.pass) || MODES.indexOf(a.mode) - MODES.indexOf(b.mode) || a.width - b.width);
  } finally {
    await browser.close();
    await mf.dispose();
    rmSync(tmp, { recursive: true, force: true });
    if (second) {
      await second.mf.dispose();
      rmSync(second.dir, { recursive: true, force: true });
    }
  }
  writeFileSync(join(OUT, "matrix.json"), JSON.stringify({ generatedAt: new Date().toISOString(), target: "core", checks, cells: matrix }, null, 1));
  writeFileSync(join(OUT, "index.html"), gallery(list, matrix, checks));
  const { failed, switchFailed } = failures(matrix, checks);
  console.log(`${matrix.length} cells, ${failed.length} with a failing check.${switchFailed.length ? ` Theme switch FAIL: ${switchFailed.join(", ")}.` : checks.themeSwitch ? " Theme switch ok." : ""} ${OUT}`);
  // The matrix and gallery are written either way; the exit status says whether the run passed.
  process.exitCode = exitCodeFor(matrix, checks);
}

/** Cells with any failing check, and theme-switch checks that failed. */
export function failures(matrix, checks = {}) {
  return {
    failed: matrix.filter((c) => Object.values(c.gates).some((g) => !g.pass)),
    switchFailed: Object.entries(checks.themeSwitch ?? {}).filter(([, v]) => !v.pass).map(([k]) => k),
  };
}

/** 0 only for a non-empty run in which every cell and every switch check passed. */
export function exitCodeFor(matrix, checks = {}) {
  const { failed, switchFailed } = failures(matrix, checks);
  return matrix.length && !failed.length && !switchFailed.length ? 0 : 1;
}

const PASSES = ["matrix", "reflow", "forced"];

/**
 * G13 in the browser: the switch works with no script (form POST, 303 back, mode rendered by the server),
 * in place where the dashboard script runs (no navigation, cookie written, persists across a reload), from the
 * keyboard (Tab to it, Enter and Space), and Auto clears the choice.
 */
async function themeSwitchChecks(browser, mf, fx) {
  const out = {};
  const ctxOpts = { ...VIEWPORTS[1440], colorScheme: "light", timezoneId: "Europe/London", locale: "en-GB", ignoreHTTPSErrors: true, reducedMotion: "reduce" };
  const redirects = [];
  const open = async (auth) => {
    const context = await browser.newContext(ctxOpts);
    await context.route("**/*", async (route) => {
      const req = route.request();
      if (!/^https:\/\/([a-z0-9-]+\.)?kofra(-sites)?\.test\//.test(req.url())) return route.abort();
      const body = req.postDataBuffer();
      const sent = await req.allHeaders();
      let res = await mf.dispatchFetch(req.url(), { method: req.method(), headers: sent, body: body && req.method() !== "GET" && req.method() !== "HEAD" ? body : undefined, redirect: "manual" });
      // Chromium does not route the request that follows a fulfilled redirect, so the form POST's 303 is
      // followed here: the browser gets the Set-Cookie of the 303 and the page it points to (loaded with
      // the new cookie), and the hop is recorded for the check.
      const setCookie = [];
      if (req.method() === "POST" && res.status === 303) {
        const location = res.headers.get("location");
        const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
        setCookie.push(...cookies);
        redirects.push({ from: new URL(req.url()).pathname, status: res.status, location, setCookie: cookies });
        const jar = new Map((sent.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => [c.split("=")[0], c]));
        for (const c of cookies) {
          const pair = c.split(";")[0];
          const name = pair.split("=")[0];
          if (/max-age=0/i.test(c)) jar.delete(name);
          else jar.set(name, pair);
        }
        const { "content-type": _ct, "content-length": _cl, cookie: _c, ...rest } = sent;
        res = await mf.dispatchFetch(new URL(location, req.url()).href, { method: "GET", headers: { ...rest, cookie: [...jar.values()].join("; ") }, redirect: "manual" });
      }
      const headers = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      if (setCookie.length) headers["set-cookie"] = setCookie.join("\n");
      await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    });
    if (auth) await context.addInitScript((key) => location.hostname === "kofra.test" && sessionStorage.setItem("dropway.key", key), fx.owner);
    return { context, page: await context.newPage() };
  };
  const cookie = async (context) => (await context.cookies(`${APP}/`)).find((c) => c.name === "__Host-dw_theme") ?? null;
  const theme = (page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const record = (name, pass, detail) => {
    out[name] = { pass, detail };
    console.log(`theme switch ${name}: ${pass ? "ok" : `FAIL ${JSON.stringify(detail)}`}`);
  };
  // 1. No script (the 404 page runs none): POST, 303 back to the same page, rendered dark by the server.
  {
    const { context, page } = await open(false);
    try {
      await page.goto(`${APP}/nope?x=1`);
      const scripts = await page.evaluate(() => document.scripts.length);
      await Promise.all([page.waitForNavigation(), page.click('.k-mode-switch button[value="dark"]')]);
      const c = await cookie(context);
      const hop = redirects.at(-1);
      const pressed = await page.getAttribute('.k-mode-switch button[value="dark"]', "aria-pressed");
      record(
        "no-script",
        scripts === 0 && hop?.location === "/nope?x=1" && (await theme(page)) === "dark" && c?.value === "dark" && c.secure && c.path === "/" && c.sameSite === "Lax" && !c.httpOnly && c.expires > Date.now() / 1000 + 364 * 86400 && pressed === "true",
        { scripts, hop, cookie: c, pressed },
      );
      await Promise.all([page.waitForNavigation(), page.click('.k-mode-switch button[value="auto"]')]);
      record("no-script-auto", (await theme(page)) === null && (await cookie(context)) === null, { theme: await theme(page), cookie: await cookie(context), hop: redirects.at(-1) });
    } catch (e) {
      record("no-script", false, String(e).slice(0, 300));
    } finally {
      await context.close();
    }
  }
  // 2. With the dashboard script: in place, no navigation; the cookie persists across a reload; keyboard works.
  {
    const { context, page } = await open(true);
    try {
      await page.goto(`${APP}/dashboard?theme=light`);
      await page.waitForSelector("#dw-sites tbody tr");
      await page.evaluate(() => (window.__marker = 1));
      await page.click('.k-mode-switch button[value="dark"]');
      await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
      const kept = await page.evaluate(() => window.__marker === 1);
      const meta = await page.evaluate(() => [document.querySelector('meta[name="color-scheme"]').content, ...[...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content)]);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const c = await cookie(context);
      record("in-place", kept && c?.value === "dark" && bg === PAPER.dark && page.url() === `${APP}/dashboard` && meta.join(" ") === `only dark ${THEME_COLOR.dark} ${THEME_COLOR.dark}`, { kept, cookie: c?.value, bg, url: page.url(), meta });
      await page.reload();
      await page.waitForSelector("#dw-sites tbody tr");
      await page.evaluate(() => (window.__marker = 2));
      record("persists", (await theme(page)) === "dark" && (await page.getAttribute('.k-mode-switch button[value="dark"]', "aria-pressed")) === "true", { theme: await theme(page) });
      // Keyboard: focus Light with Tab order, press Enter; then Auto with Space.
      await page.focus('.k-mode-switch button[value="auto"]');
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("value"));
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light");
      await page.focus('.k-mode-switch button[value="auto"]');
      await page.keyboard.press("Space");
      await page.waitForFunction(() => !document.documentElement.hasAttribute("data-theme"));
      const after = await cookie(context);
      record("keyboard", focused === "light" && after === null && (await page.evaluate(() => window.__marker === 2)), { focused, cookie: after });
    } catch (e) {
      record("in-place", false, String(e).slice(0, 300));
    } finally {
      await context.close();
    }
  }
  return out;
}

/**
 * G4 probe for the focused element (runs in the page): its ring (outline >= 2px or a box-shadow ring; CSS-only
 * toggles show it on their label), the ring's WCAG contrast against what is behind it, whether it is in the
 * viewport and not covered by another element, and whether it escaped an open dialog.
 */
const FOCUS_PROBE = () => {
  const parse = (c) => {
    let m = /^rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = /^color\(srgb ([^)]+)\)/.exec(c);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const bgBehind = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return parse(getComputedStyle(document.documentElement).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
  };
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { end: true };
  if (el.tagName === "IFRAME") return { frame: true };
  el.__fwid ??= `${(window.__fwn = (window.__fwn ?? 0) + 1)}`;
  // CSS-only toggles hide the input and show its ring on the label.
  let ringEl = el;
  const r0 = el.getBoundingClientRect();
  if ((r0.width <= 2 || r0.height <= 2) && el.id) {
    const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) ringEl = l;
  }
  const r = ringEl.getBoundingClientRect();
  const cs = getComputedStyle(ringEl);
  const ow = parseFloat(cs.outlineWidth) || 0;
  const outline = cs.outlineStyle !== "none" && ow >= 2;
  const shadow = !!cs.boxShadow && cs.boxShadow !== "none";
  const ringColor = parse(outline ? cs.outlineColor : (/(rgba?\([^)]+\)|color\([^)]+\))/.exec(cs.boxShadow) ?? [])[0] ?? "");
  const inset = outline && (parseFloat(cs.outlineOffset) || 0) < 0;
  const behind = inset ? bgBehind(ringEl) : bgBehind(ringEl.parentElement ?? ringEl);
  const contrast = ringColor ? Math.round(ratio(ringColor, behind) * 100) / 100 : null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  // WCAG 2.4.11: the focused element must not be entirely hidden by other content (a sticky bar, a toast).
  // Sample its centre and four inset corners inside the viewport; it is covered only if every one is.
  let covered = null;
  if (inView) {
    const clampX = (x) => Math.min(Math.max(x, 1), vw - 1);
    const clampY = (y) => Math.min(Math.max(y, 1), vh - 1);
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
      [r.right - 2, r.top + 2],
      [r.left + 2, r.bottom - 2],
      [r.right - 2, r.bottom - 2],
    ];
    const blockers = pts.map(([x, y]) => {
      const hit = document.elementFromPoint(clampX(x), clampY(y));
      return hit && hit !== ringEl && !ringEl.contains(hit) && !hit.contains(ringEl) && hit !== el && !el.contains(hit) ? hit : null;
    });
    if (blockers.every(Boolean)) {
      const hit = blockers[0];
      covered = hit.tagName.toLowerCase() + (hit.className && typeof hit.className === "string" ? `.${hit.className.trim().split(/\s+/).join(".")}` : "");
    }
  }
  const open = document.querySelector("dialog[open]");
  const name = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (el.className && typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).join(".")}` : "");
  return {
    key: el.__fwid,
    name: `${name} "${(el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 30)}"`,
    skip: el.classList.contains("k-skip"),
    ring: outline || shadow,
    width: outline ? ow : null,
    contrast,
    inView,
    covered,
    escaped: !!open && !open.contains(el),
    inDialog: !!open && open.contains(el),
  };
};

/** G4: Tab from the top of the page (or of an open dialog) through every focusable element, then Shift+Tab back. */
async function focusWalk(page) {
  await page.evaluate(() => {
    const host = document.querySelector("dialog[open]") ?? document.body;
    const start = document.createElement("span");
    start.tabIndex = -1;
    host.prepend(start);
    start.focus();
    start.remove();
    if (host === document.body) window.scrollTo(0, 0);
  });
  const focusable = await page.evaluate(() => document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true], iframe, summary').length);
  const stops = [];
  let frames = 0;
  for (let i = 0; i < 160; i++) {
    await page.keyboard.press("Tab");
    const st = await page.evaluate(FOCUS_PROBE);
    if (st.end) break;
    if (st.frame) {
      if (++frames > 80) break;
      continue;
    }
    if (stops.length && st.key === stops[0].key) break;
    if (stops.some((x) => x.key === st.key)) continue;
    stops.push(st);
  }
  // Shift+Tab back from the last stop must reach the previous ones (no traps).
  let back = 0;
  if (stops.length > 1) {
    for (let i = 0; i < Math.min(stops.length - 1, 40); i++) {
      await page.keyboard.press("Shift+Tab");
      const st = await page.evaluate(FOCUS_PROBE);
      if (st.frame) continue;
      if (!st.end) back++;
    }
  }
  return { stops, back, focusable };
}

/** Number of differing pixels between two PNGs (decoded by the browser), or a size mismatch (diff -1). */
async function pixelDiff(browser, a, b) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    return await page.evaluate(async ([x, y]) => {
      const load = async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        return img;
      };
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { diff: -1, size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
      const c = new OffscreenCanvas(ia.width, ia.height);
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(ia, 0, 0);
      const da = g.getImageData(0, 0, ia.width, ia.height).data;
      g.clearRect(0, 0, ia.width, ia.height);
      g.drawImage(ib, 0, 0);
      const db = g.getImageData(0, 0, ia.width, ia.height).data;
      // A pixel differs when any channel is more than 2 of 255 apart; smaller deltas are rasteriser rounding
      // on anti-aliased edges (seen as 1-unit changes on a few corner pixels), counted separately as noise.
      let diff = 0;
      let noise = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]));
        if (d > 2) diff++;
        else if (d > 0) noise++;
      }
      return { diff, noise };
    }, [a.toString("base64"), b.toString("base64")]);
  } finally {
    await context.close();
  }
}

/**
 * G9 layout shift, measured on its own load: a fresh context (nothing cached, so the fonts really arrive
 * after the first paint) in which the app's API never answers, so the only things that can move the page
 * are the page itself, its CSS and its fonts. All shifts until the fonts are ready (+300 ms) count.
 */
async function fontShift(browser, mf, fx, sc, contextOptions, url, explicit) {
  const context = await browser.newContext(contextOptions);
  try {
    await context.route("**/*", async (route) => {
      const req = route.request();
      const u = req.url();
      if (!/^https:\/\/([a-z0-9-]+\.)?kofra(-sites)?\.test\//.test(u)) return route.abort();
      if (u.startsWith(`${APP}/api/`)) return; // held: no data, so no data-driven shifts
      const body = req.postDataBuffer();
      const res = await mf.dispatchFetch(u, { method: req.method(), headers: await req.allHeaders(), body: body && req.method() !== "GET" && req.method() !== "HEAD" ? body : undefined, redirect: "manual" });
      const headers = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const location = res.headers.get("location");
      if (location && res.status >= 300 && res.status < 400 && req.isNavigationRequest()) {
        const to = new URL(location, u).href.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);
        return route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: `<!doctype html><meta http-equiv="refresh" content="0;url=${to}">` });
      }
      await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    });
    if (explicit && sc.origin === "app") await context.addCookies([{ name: "__Host-dw_theme", value: explicit, url: `${APP}/`, secure: true, sameSite: "Lax" }]);
    await context.addInitScript(({ key, auth }) => {
      if (auth && location.hostname === "kofra.test") sessionStorage.setItem("dropway.key", key);
      if (window.top !== window) return;
      window.__g9 = [];
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            if (e.hadRecentInput) continue;
            const n = (e.sources ?? [])[0]?.node;
            const name = n ? (n.nodeType === 1 ? n.tagName.toLowerCase() + (typeof n.className === "string" && n.className ? `.${n.className.trim().split(/\s+/).join(".")}` : "") : "#text") : "?";
            const src = (e.sources ?? [])[0];
            const rect = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : "");
            window.__g9.push([e.startTime, e.value, `${name} ${rect(src?.previousRect)} -> ${rect(src?.currentRect)}`]);
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {}
    }, { key: fx.owner, auth: !!sc.auth });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const shifts = await page.evaluate(() => window.__g9 ?? []);
    const cls = Math.round(shifts.reduce((a, [, v]) => a + v, 0) * 1000) / 1000;
    return { cls, shifts: shifts.slice(0, 5).map(([t, v, n]) => `${Math.round(v * 1000) / 1000} ${n} @${Math.round(t)}ms`) };
  } finally {
    await context.close();
  }
}

async function runCell(browser, mf, fx, sc, mode, width, axeSource, opts = {}) {
  const explicit = mode === "light" || mode === "dark" ? mode : null;
  const os = explicit ? (explicit === "dark" ? "light" : "dark") : mode.replace("auto-", "");
  const expected = explicit ?? os;
  const pass = opts.pass ?? "matrix";
  const contextOptions = { ...VIEWPORTS[width], colorScheme: os, timezoneId: "Europe/London", locale: "en-GB", ignoreHTTPSErrors: true, reducedMotion: "reduce", forcedColors: pass === "forced" ? "active" : "none" };
  const context = await browser.newContext(contextOptions);
  const failed = [];
  const consoleMsgs = [];
  const fontHeaders = [];
  const redirects = [];
  const css = [];
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
    const buf = Buffer.from(await res.arrayBuffer());
    const path = new URL(url).pathname;
    // Chromium does not route the request that follows a fulfilled redirect, so a redirected navigation
    // (the app viewer's frame through __dropway/open) continues through a harness-made meta refresh, which
    // is a new, routed request to the same Location.
    const location = res.headers.get("location");
    if (location && res.status >= 300 && res.status < 400 && req.isNavigationRequest()) {
      const to = new URL(location, url).href.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);
      redirects.push(`${req.method()} ${path} ${res.status} -> ${location}`);
      return route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: `<!doctype html><meta http-equiv="refresh" content="0;url=${to}">` });
    }
    if (path.startsWith("/__dropway/fonts/") && path.endsWith(".woff2")) fontHeaders.push({ path, status: res.status, ...out });
    if ((out["content-type"] ?? "").startsWith("text/css") || (out["content-type"] ?? "").startsWith("text/html")) css.push(buf.toString("utf8"));
    await route.fulfill({ status: res.status, headers: out, body: buf });
  });
  if (explicit && sc.origin === "app") await context.addCookies([{ name: "__Host-dw_theme", value: explicit, url: `${APP}/`, secure: true, sameSite: "Lax" }]);
  await context.addInitScript(({ key, auth }) => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
    if (auth && location.hostname === "kofra.test") sessionStorage.setItem("dropway.key", key);
    // G9: layout shift while the page and its fonts load.
    window.__cls = 0;
    window.__shifts = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.hadRecentInput) continue;
          // G9 counts shifts until the load event (fonts and CSS arriving); later shifts are the dashboard
          // drawing the data it fetched, reported separately.
          if (document.readyState === "complete") window.__clsAfter = (window.__clsAfter ?? 0) + e.value;
          else window.__cls += e.value;
          const n = (e.sources ?? [])[0]?.node;
          const name = n ? (n.nodeType === 1 ? n.tagName.toLowerCase() + (n.id ? `#${n.id}` : "") + (typeof n.className === "string" && n.className ? `.${n.className.trim().split(/\s+/).join(".")}` : "") : "#text") : "?";
          const src = (e.sources ?? [])[0];
          const rect = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : "");
          window.__shifts.push(`${Math.round(e.value * 1000) / 1000} ${name} @${Math.round(e.startTime)}ms ${rect(src?.previousRect)} -> ${rect(src?.currentRect)}`);
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}
    // G7: the background behind every frame painted until load (top-level documents only).
    if (window.top === window) {
      window.__frames = [];
      const sample = () => {
        const html = getComputedStyle(document.documentElement).backgroundColor;
        const body = document.body ? getComputedStyle(document.body).backgroundColor : null;
        const pick = (c) => (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent" ? c : null);
        window.__frames.push(pick(html) ?? pick(body) ?? "canvas");
        if (document.readyState !== "complete" && window.__frames.length < 600) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }
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
  // Requests that never got a response (blocked, unroutable). Cancellations (a frame moving on, media range
  // requests) are normal browser behaviour and not counted.
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "";
    if (collecting && !/ERR_ABORTED/.test(why)) failed.push(`${r.method()} ${new URL(r.url()).pathname} ${why || "failed"}`);
  });
  if (sc.before) await sc.before(page);
  let url = sc.url;
  if (explicit && sc.origin === "site") url += (url.includes("?") ? "&" : "?") + `theme=${explicit}`;
  const t0 = Date.now();
  let status = 0;
  let firstHtml = "";
  const state = {};
  try {
    const resp = await page.goto(url, { waitUntil: "load", timeout: 30000 });
    status = resp?.status() ?? 0;
    firstHtml = (await resp?.text().catch(() => "")) ?? "";
    if (sc.wait) await page.waitForSelector(sc.wait, { timeout: 15000 }).catch(() => {});
    // Signed-in dashboard pages: wait until the script has filled the account area and the site picker,
    // so a cell never captures a half-loaded header next to its twin.
    if (sc.origin === "app" && sc.auth) {
      await page
        .waitForFunction(() => {
          const acct = document.querySelector("#dw-account");
          const picker = document.querySelector("#dw-pub-site");
          return (!acct || /Sign out/.test(acct.textContent ?? "")) && (!picker || !/Loading sites/.test(picker.textContent ?? ""));
        }, null, { timeout: 15000 })
        .catch(() => {});
    }
    if (sc.act) await sc.act(page, state);
    // Every face the page declares and uses is in before the capture (a face still in its block period
    // would leave text blank in the screenshot), then two frames for the swap to paint.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.fonts].filter((f) => f.status === "loading").map((f) => f.loaded.catch(() => {})));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    await page.waitForTimeout(sc.frame ? 900 : 200);
  } catch (e) {
    consoleMsgs.push(`harness: ${e.message.split("\n")[0]}`);
  }
  // Full-page captures (and their masks) are taken from the top of the page.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  const tag = pass === "forced" ? `forced-${width}` : `${mode}-${width}`;
  const file = `${sc.id}-${tag}.png`;
  // Very tall pages (the truncated log) are captured one viewport high.
  const shot = (o = {}) => page.screenshot({ fullPage: !sc.viewportOnly, ...o }).catch(() => page.screenshot(o));
  const png = await shot({ path: join(OUT, file) });
  // G6 compares this copy: the switch (its pressed state differs by design) and per-cell secrets masked.
  const masks = [".k-mode-switch", ...(sc.mask ?? [])].map((m) => page.locator(m));
  let masked = null;
  if (pass === "matrix" && opts.maskDir) {
    masked = join(opts.maskDir, file);
    await shot({ path: masked, mask: masks, maskColor: "#FF00FF", animations: "disabled", caret: "hide" });
  }
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
    const dur = (sel) => [...document.querySelectorAll(sel)].map((e) => getComputedStyle(e).transitionDuration).filter((d) => d.split(",").some((x) => parseFloat(x) > 0));
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
      colorScheme: document.querySelector('meta[name="color-scheme"]')?.content ?? null,
      themeColors: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => `${m.media}=${m.content}`),
      cls: Math.round((window.__cls ?? 0) * 1000) / 1000,
      shifts: (window.__shifts ?? []).slice(0, 5),
      clsAfterLoad: Math.round((window.__clsAfter ?? 0) * 1000) / 1000,
      frames: window.__frames ?? [],
      motion: {
        buttons: dur(".k-btn, .k-mode-switch button"),
        skel: [...document.querySelectorAll(".k-skel")].map((e) => getComputedStyle(e).animationName).filter((n) => n !== "none"),
        scroll: getComputedStyle(document.documentElement).scrollBehavior,
      },
    };
  }, width);
  let axe = { violations: [] };
  collecting = false; // axe messages its frames; Chrome warns about cross-origin ones. Not the page's own output.
  try {
    await page.evaluate(axeSource);
    // Forced colours: the user's system palette sets every colour, and axe reads the author colours, so its
    // colour-contrast rule says nothing there (G12 checks the rest of axe and the focus rings).
    const rules = pass === "forced" ? { "color-contrast": { enabled: false } } : {};
    axe = await page.evaluate((rules) => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, rules, resultTypes: ["violations"] }), rules);
  } catch (e) {
    axe = { violations: [{ id: "axe-error", help: String(e).slice(0, 200), nodes: [] }] };
  }
  // G4 runs last: it moves focus and scrolls.
  const walk = sc.userPage || pass === "reflow" ? null : await focusWalk(page).catch((e) => ({ error: String(e).slice(0, 200), stops: [] }));
  await context.close();
  const g9 = sc.userPage ? { cls: 0, shifts: [] } : await fontShift(browser, mf, fx, sc, contextOptions, url, explicit).catch((e) => ({ cls: 1, shifts: [`harness: ${String(e).slice(0, 160)}`] }));
  if (sc.after) {
    const api = async (path, init = {}) => {
      const res = await mf.dispatchFetch(`${APP}/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${fx.owner}`, ...(init.headers ?? {}) } });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    await sc.after(api, state).catch((e) => consoleMsgs.push(`harness clean-up: ${String(e).slice(0, 200)}`));
  }
  // Each failed request is "<METHOD> <path> <status>". An expected failure names the method and the exact path,
  // and optionally the status; a screen that expects a status allows only its own navigation with that status.
  const unexpected = unexpectedFailures(failed, sc);
  const userContent = sc.id === "J70" || sc.id === "J72";
  // Explicit modes pin the metas to the chosen colour; Auto lists both (PORT-SPEC 3.1). The static platform
  // error page (S08) is built without request data and is always Auto.
  const metaMode = sc.staticTheme ? "auto" : (explicit ?? "auto");
  const metasOk =
    metaMode === "auto"
      ? probe.colorScheme === "light dark" && probe.themeColors.join(" ") === `(prefers-color-scheme: light)=${THEME_COLOR.light} (prefers-color-scheme: dark)=${THEME_COLOR.dark}`
      : probe.colorScheme === `only ${metaMode}` && probe.themeColors.length === 2 && probe.themeColors.every((t) => t.endsWith(`=${THEME_COLOR[metaMode]}`));
  const oldHex = OLD_HEX.filter((h) => css.some((t) => t.toLowerCase().includes(h)));
  const badFont = fontHeaders.filter((h) => h.status !== 200 || h["content-type"] !== "font/woff2" || !/immutable/.test(h["cache-control"] ?? "") || h["access-control-allow-origin"] !== "*" || h["cross-origin-resource-policy"] !== "cross-origin" || h["x-content-type-options"] !== "nosniff");
  const wantBg = PAPER[sc.staticTheme ? os : expected];
  const frames = probe.frames.filter((f) => f !== wantBg);
  const stops = walk?.stops ?? [];
  // Under forced colours the rings are system colours (CanvasText on Canvas); computed backgrounds still
  // report author colours there, so only the ring itself is checked.
  const forced = pass === "forced";
  const badStops = stops.filter((x) => !x.ring || (x.width !== null && x.width < 2) || (!forced && (x.contrast === null || x.contrast < 3)) || !x.inView || x.covered || x.escaped);
  const gates = {
    csp: { pass: probe.csp.length === 0, detail: probe.csp },
    console: { pass: sc.expectConsole ? true : consoleMsgs.filter((m) => !/Failed to load resource/.test(m) || unexpected.length).length === 0 && unexpected.length === 0, detail: [...consoleMsgs, ...unexpected] },
    axe: { pass: sc.userPage || axe.violations.length === 0, detail: axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`) },
    overflow: { pass: sc.userPage || probe.scrollWidth <= width && probe.innerWidth <= width, detail: { scrollWidth: probe.scrollWidth, innerWidth: probe.innerWidth, wide: probe.wide } },
    mode: { pass: sc.userPage || forced || (sc.staticTheme ? probe.theme === null && probe.bg === PAPER[os] : (explicit ? probe.theme === explicit : probe.theme === null) && probe.bg === PAPER[expected]), detail: `data-theme=${probe.theme} bg=${probe.bg} expected ${expected}` },
    fonts: { pass: probe.fonts.sans && (!probe.h1Font || !probe.h1Font.includes("Newsreader") || probe.fonts.serif), detail: probe.fonts },
    brand: { pass: userContent || !BANNED.test(probe.text), detail: (probe.text.match(BANNED) ?? [])[0] ?? null },
    status: { pass: !sc.status || status === sc.status, detail: status },
    tokens: { pass: sc.userPage || (metasOk && oldHex.length === 0), detail: { colorScheme: probe.colorScheme, themeColors: probe.themeColors, oldHex } },
    // G9: the shift measured on a load with the API held (fonts and CSS only); the cell's own load is
    // reported too (pageLoad), including what the dashboard does once its data arrives.
    fontload: { pass: badFont.length === 0 && g9.cls <= 0.02, detail: { cls: g9.cls, shifts: g9.shifts, pageLoad: { cls: probe.cls, clsAfterLoad: probe.clsAfterLoad, shifts: probe.shifts }, fonts: fontHeaders.length, bad: badFont.slice(0, 3) } },
    motion: { pass: sc.userPage || (probe.motion.buttons.length === 0 && probe.motion.skel.length === 0 && probe.motion.scroll === "auto"), detail: probe.motion },
  };
  if (explicit && !sc.userPage && !sc.staticTheme && !forced) {
    gates.flash = { pass: firstHtml.includes(`data-theme="${explicit}"`) && frames.length === 0, detail: { inHtml: firstHtml.includes(`data-theme="${explicit}"`), frames: probe.frames.length, other: [...new Set(frames)] } };
  }
  if (walk) {
    // App pages start at "Skip to content"; with a dialog open, the walk starts (and must stay) inside it.
    const needSkip = sc.origin === "app" && !sc.noSkip && !stops[0]?.inDialog;
    gates.focus = {
      pass: !walk.error && (stops.length > 0 || walk.focusable === 0) && badStops.length === 0 && (!needSkip || stops[0]?.skip === true) && (stops.length < 2 || walk.back > 0),
      detail: { error: walk.error, focusable: walk.focusable, stops: stops.length, first: stops[0]?.name ?? null, back: walk.back, bad: badStops.slice(0, 4) },
    };
  }
  return { screen: sc.id, title: sc.title, pass, mode, width, file, sha256: createHash("sha256").update(png).digest("hex"), masked, ms: Date.now() - t0, gates };
}

function gallery(list, matrix, checks = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const label = (c) => (c.pass === "forced" ? `forced colours · ${c.width}px` : `${c.mode} · ${c.width}px${c.pass === "reflow" ? " (reflow)" : ""}`);
  const rows = list
    .map((sc) => {
      const cells = matrix.filter((c) => c.screen === sc.id);
      return `<section><h2>${esc(sc.id)} · ${esc(sc.title)}</h2><div class="g">${cells
        .map((c) => {
          const bad = Object.entries(c.gates).filter(([, v]) => !v.pass).map(([k]) => k);
          return `<figure><a href="${esc(c.file)}"><img loading="lazy" src="${esc(c.file)}" alt="${esc(`${sc.id} ${label(c)}`)}"></a><figcaption>${esc(label(c))} ${bad.length ? `<b>${esc(bad.join(", "))}</b>` : "ok"}</figcaption></figure>`;
        })
        .join("")}</div></section>`;
    })
    .join("");
  const sw = Object.entries(checks.themeSwitch ?? {})
    .map(([k, v]) => `<li>${esc(k)}: ${v.pass ? "ok" : `<b>fail</b> ${esc(JSON.stringify(v.detail))}`}</li>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kofra Security Print port: core screenshots</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;background:#f4efe2;color:#141414}h1{font-weight:600}section{margin:0 0 40px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}figure{margin:0}img{width:100%;height:260px;object-fit:cover;object-position:top;border:1px solid #b08d3c;background:#fff}b{color:#a8321f}</style><h1>Kofra Security Print port: core screens (${matrix.length} cells)</h1>${sw ? `<h2>Theme switch (G13)</h2><ul>${sw}</ul>` : ""}${rows}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
