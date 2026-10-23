import { beforeAll, describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";

// Independent observable contract: SPEC 10.2, JSON Lines. No renderer imports.
// A code-only fallback, an off-by-one cap, injected markup, or rewritten raw
// bytes must fail these tests. Native details/summary keeps rows usable without JS.
const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const EXTENSIONS = ["jsonl", "ndjson"] as const;
const CAP = 10 * 1024 * 1024; // The repository's MB convention is binary bytes.
const HOSTILE = '<img src=x onerror="alert(91)"></details><script>alert(92)</script><iframe src="https://invalid.example/"></iframe><base href="https://invalid.example/"><form action="javascript:alert(93)">A&B 雪</form>';
const RECORDS = [
  '{"record":"nested-object","nested":{"leaf":"deep-value","list":["array-member",17]},"markup":' + JSON.stringify(HOSTILE) + '}',
  '["array-root",{"inside":"array-object"}]',
  '"scalar-string"',
  "73019",
  "true",
  "false",
  "null",
  '"<svg onload=alert(94)>雪 & snow</svg>"',
];
const MIXED = RECORDS.join("\r\n") + "\r\n";
const MALFORMED = '{"before":"valid-first"}\n{"broken": <img src=x onerror=alert(95)>}\n{"after":"valid-last"}\n';
const MANY = Array.from({ length: 2001 }, (_, i) => JSON.stringify({ value: `record-${String(i + 1).padStart(4, "0")}-end` })).join("\n") + "\n";
const BOUNDARY_RECORD = '{"boundary":"within-json-lines-cap"}\n';
// Padding is legal whitespace: exercise the FILE byte boundary without making
// one giant scalar or 10 MB of generated HTML necessary to satisfy the contract.
const sizedFile = (size: number) => BOUNDARY_RECORD + " ".repeat(size - BOUNDARY_RECORD.length);
const OVER_TAIL = '\n"over-cap-tail-must-not-render"\n';
const OVER = BOUNDARY_RECORD + " ".repeat(CAP + 1 - BOUNDARY_RECORD.length - OVER_TAIL.length) + OVER_TAIL;

type Row = { text: string; summaries: number };
type Page = { rows: Row[]; text: string; links: string[]; tags: string[]; unsafeAttributes: string[] };

/** Inspect the actual response with workerd's HTML parser, not a fake viewer. */
async function inspect(html: string): Promise<Page> {
  const page: Page = { rows: [], text: "", links: [], tags: [], unsafeAttributes: [] };
  let depth = 0;
  let current: Row | undefined;
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        page.tags.push(el.tagName);
        for (const [name, value] of el.attributes) {
          if (/^on/i.test(name ?? "") || ((name === "href" || name === "src" || name === "action") && /^\s*javascript:/i.test(value ?? ""))) {
            page.unsafeAttributes.push(`${name}=${value}`);
          }
        }
      },
    })
    .on("a", { element(el) { page.links.push(el.getAttribute("href") ?? ""); } })
    .on("details", {
      element(el) {
        if (depth++ === 0) {
          current = { text: "", summaries: 0 };
          page.rows.push(current);
        }
        el.onEndTag(() => { if (--depth === 0) current = undefined; });
      },
    })
    .on("summary", { element() { if (depth === 1 && current) current.summaries++; } })
    .onDocument({ text(chunk) {
      page.text += chunk.text;
      if (current) current.text += chunk.text;
    } });
  await rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html" } })).text();
  // HTMLRewriter text chunks retain entities; decode once, after reassembly.
  const entities: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
  const text = (s: string) => s.replace(/&(?:lt|gt|amp|quot|apos|#39);/g, (entity) => entities[entity]!);
  page.text = text(page.text);
  for (const row of page.rows) row.text = text(row.text);
  return page;
}

function chrome(page: Page, slug: string, path: string) {
  expect(page.links).toContain(`/s/${slug}/${path}?raw=1`);
  expect(page.links).toContain(`/s/${slug}/${path}?download=1`);
  expect(page.links).toContain(`https://dropway.test/v/${slug}/${path}`);
}

function noUserMarkup(page: Page) {
  expect(page.unsafeAttributes).toEqual([]);
  for (const tag of ["img", "svg", "iframe", "base", "form"]) expect(page.tags).not.toContain(tag);
}

function scriptless(res: Response, page: Page) {
  expect(page.tags).not.toContain("script");
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toMatch(/(?:^|;)\s*script-src 'none'(?:;|$)/);
  expect(csp).not.toContain("allow-scripts");
}

describe("R-34 JSON Lines acceptance through the Worker", () => {
  let dw: Instance;
  let slug: string;
  beforeAll(async () => {
    dw = await freshInstance();
    const files: Record<string, string> = { "parser-control.json": '{"nested":{"probe":"parser-control-value"}}' };
    for (const ext of EXTENSIONS) {
      files[`mixed.${ext}`] = MIXED;
      files[`many.${ext}`] = MANY;
      files[`blank-lines.${ext}`] = '\r\n{"value":"first-nonblank"}\r\n \t\r\n["second-nonblank"]\r\n\r\n';
      files[`malformed.${ext}`] = MALFORMED;
      files[`empty.${ext}`] = "";
      files[`below.${ext}`] = sizedFile(CAP - 1);
      files[`at.${ext}`] = sizedFile(CAP);
      files[`over.${ext}`] = OVER;
      files[`cached.${ext}`] = '{"cache":"json-lines-acceptance-unique-content"}\n';
    }
    expect(new TextEncoder().encode(OVER).length, "over-cap fixture must be exactly cap + 1").toBe(CAP + 1);
    // Use the normal manifest flow rather than raising the 25 MB one-shot cap.
    slug = "json-lines-acceptance";
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
    expect(created.status).toBe(201);
    const entries = await Promise.all(Object.entries(files).map(([path, content]) => manifestEntry(path, content)));
    const deploy = await dw.json(`/api/v1/sites/${slug}/deploys`, {
      key: dw.ownerKey,
      ...jsonBody({ files: entries.map(({ bytes: _bytes, ...entry }) => entry) }),
    });
    expect(deploy.status, JSON.stringify(deploy.body)).toBe(201);
    for (const hash of deploy.body.missing as string[]) {
      const entry = entries.find((e) => e.sha256 === hash)!;
      const uploaded = await dw.json(`/api/v1/blobs/${hash}`, {
        method: "PUT", key: dw.ownerKey, body: entry.bytes, headers: { "Content-Length": String(entry.size) },
      });
      expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    }
    const finalized = await dw.json(`/api/v1/sites/${slug}/deploys/${deploy.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    // Positive control for our observer: existing JSON emits nested details.
    // A broken observer must be a setup failure, never advertised as feature RED.
    const control = await dw.call(`/s/${slug}/parser-control.json`, { headers: NAV });
    expect(control.status).toBe(200);
    const parsed = await inspect(await control.text());
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.summaries).toBe(1);
    expect(parsed.rows[0]!.text).toContain("parser-control-value");
  });
  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });

  for (const ext of EXTENSIONS) {
    for (const mode of ["document", "explicit"] as const) {
      it(`${ext}: ${mode} navigation gives eight independent native collapsible records, not highlighted source`, async () => {
        const path = `mixed.${ext}`;
        const res = await get(path + (mode === "explicit" ? "?view=1" : ""), mode === "explicit" ? { Accept: "*/*", "Sec-Fetch-Dest": "empty" } : NAV);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        const page = await inspect(await res.text());
        chrome(page, slug, path);
        noUserMarkup(page);
        // Soft assertions expose both missing rows and an inherited code-script
        // permission on the baseline, rather than masking the latter behind count.
        expect.soft(page.rows, "one top-level details per record (nested details do not count)").toHaveLength(8);
        expect.soft(page.tags).not.toContain("script");
        expect.soft(res.headers.get("content-security-policy")).toMatch(/script-src 'none'/);
        if (page.rows.length !== 8) return;
        for (const row of page.rows) expect(row.summaries).toBe(1);
        expect(page.rows[0]!.text).toContain("nested-object");
        expect(page.rows[0]!.text).toContain("deep-value");
        expect(page.rows[0]!.text).toContain("array-member");
        expect(page.rows[0]!.text).toContain(HOSTILE);
        expect(page.rows[1]!.text).toContain("array-root");
        expect(page.rows[1]!.text).toContain("array-object");
        expect(page.rows[2]!.text).toContain("scalar-string");
        expect(page.rows[3]!.text).toContain("73019");
        expect(page.rows[4]!.text).toContain("true");
        expect(page.rows[5]!.text).toContain("false");
        expect(page.rows[6]!.text).toContain("null");
        expect(page.rows[7]!.text).toContain("<svg onload=alert(94)>雪 & snow</svg>");
        scriptless(res, page);
      });
    }

    it(`${ext}: ignores whitespace-only physical lines without producing phantom records`, async () => {
      const res = await get(`blank-lines.${ext}`);
      expect(res.status).toBe(200);
      const page = await inspect(await res.text());
      expect(page.rows).toHaveLength(2);
      expect(page.rows[0]!.text).toContain("first-nonblank");
      expect(page.rows[1]!.text).toContain("second-nonblank");
    });

    it(`${ext}: 2,001 nonblank records expose only the first 2,000 and an explicit truncation notice`, async () => {
      const res = await get(`many.${ext}?view=1`);
      expect(res.status).toBe(200);
      const html = await res.text();
      const page = await inspect(html);
      expect.soft(page.rows).toHaveLength(2000);
      expect.soft(/truncat|showing (?:only |the )?first/i.test(page.text), "visible truncation notice").toBe(true);
      expect.soft(page.text.includes("record-2001-end"), "no 2,001st record in displayed text").toBe(false);
      expect.soft(html.includes("record-2001-end"), "no hidden 2,001st record in HTML").toBe(false);
      if (page.rows.length !== 2000) return;
      for (let i = 0; i < 2000; i++) {
        expect(page.rows[i]!.summaries).toBe(1);
        expect(page.rows[i]!.text).toContain(`record-${String(i + 1).padStart(4, "0")}-end`);
      }
      chrome(page, slug, `many.${ext}`);
      scriptless(res, page);
    });

    for (const [name, bytes] of [["below", CAP - 1], ["at", CAP]] as const) {
      it(`${ext}: a ${bytes}-byte file is still eligible for the record viewer`, async () => {
        const res = await get(`${name}.${ext}?view=1`);
        expect(res.status).toBe(200);
        const page = await inspect(await res.text());
        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]!.text).toContain("within-json-lines-cap");
        scriptless(res, page);
        chrome(page, slug, `${name}.${ext}`);
      });
    }

    it(`${ext}: cap + 1 uses bounded code fallback with Raw/Download, never a JSON Lines tree`, async () => {
      const res = await get(`over.${ext}?view=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-dropway-viewer")).toBe("code");
      const html = await res.text();
      const page = await inspect(html);
      expect(page.rows).toHaveLength(0);
      expect(page.text).toContain("within-json-lines-cap");
      expect(page.text).toMatch(/truncat|showing (?:only |the )?first/i);
      expect(html).not.toContain("over-cap-tail-must-not-render");
      expect(new TextEncoder().encode(html).length).toBeLessThan(2 * 1024 * 1024);
      chrome(page, slug, `over.${ext}`);
      for (const query of ["?raw=1", "?download=1"]) {
        const stored = await get(`over.${ext}${query}`);
        expect(stored.status).toBe(200);
        expect(stored.headers.get("x-dropway-viewer")).toBeNull();
        expect(await stored.text()).toBe(OVER);
      }
    });

    for (const name of ["malformed", "empty"] as const) {
      it(`${ext}: ${name} input safely falls back to code, with no partial record tree`, async () => {
        const path = `${name}.${ext}`;
        const res = await get(`${path}?view=1`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("x-dropway-viewer")).toBe("code");
        const page = await inspect(await res.text());
        expect(page.rows).toHaveLength(0);
        noUserMarkup(page);
        chrome(page, slug, path);
        for (const query of ["?raw=1", "?download=1"]) {
          const stored = await get(path + query);
          expect(stored.status).toBe(200);
          expect(await stored.text()).toBe(name === "malformed" ? MALFORMED : "");
        }
        if (name === "malformed") {
          expect(page.text).toContain("valid-first");
          expect(page.text).toContain('{"broken": <img src=x onerror=alert(95)>}');
          expect(page.text).toContain("valid-last");
        }
      });
    }

    it(`${ext}: source stays highlighted; raw, download and sub-resource requests preserve stored UTF-8/CRLF bytes`, async () => {
      const path = `mixed.${ext}`;
      const source = await get(`${path}?view=source`);
      expect(source.status).toBe(200);
      expect(source.headers.get("x-dropway-viewer")).toBe("source");
      const html = await source.text();
      expect(html).toContain('id="L1"');
      const page = await inspect(html);
      expect(page.rows).toHaveLength(0);
      expect(page.text).toContain("nested-object");
      noUserMarkup(page);
      chrome(page, slug, path);
      for (const [query, headers] of [
        ["?raw=1", NAV],
        ["?download=1", NAV],
        ["", { Accept: "*/*", "Sec-Fetch-Dest": "empty" }],
        ["", { Accept: "*/*", "Sec-Fetch-Dest": "script" }],
        ["", { Accept: "*/*", "Sec-Fetch-Dest": "style" }],
      ] as const) {
        const res = await get(path + query, headers);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-dropway-viewer")).toBeNull();
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new TextEncoder().encode(MIXED));
        if (query === "?raw=1") expect(res.headers.get("content-type")).toContain("text/plain");
        if (query === "?download=1") expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      }
    });
  }

  it("repeated rendered content uses the existing cache across both extensions and preserves conditional responses", async () => {
    for (const ext of EXTENSIONS) {
      const first = await get(`cached.${ext}?view=1`);
      expect(first.status).toBe(200);
      expect(["miss", "memory"]).toContain(first.headers.get("x-dropway-render-cache"));
      await first.text();
      const res = await get(`cached.${ext}?view=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-dropway-render-cache")).toBe("memory");
      const page = await inspect(await res.text());
      expect.soft(page.rows).toHaveLength(1);
      chrome(page, slug, `cached.${ext}`);
      const etag = res.headers.get("etag");
      expect(etag).toBeTruthy();
      const conditional = await get(`cached.${ext}?view=1`, { ...NAV, "If-None-Match": etag! });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
      expect(conditional.headers.get("etag")).toBe(etag);
    }
  });
});
