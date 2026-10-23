import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

/**
 * Independent R-34 contract. Baseline: a0b32f0d0f843cfc6a403e939db266411e5de940.
 * Only the Test Author may amend this file; the implementation consumes it verbatim.
 *
 * Parser/render safety limits fixed before implementation:
 * - 1 MB means 1,048,576 stored UTF-8 bytes, inclusive. Larger files are not parsed.
 * - Collection depth <= 64 (document root is depth 1); total value nodes <= 10,000
 *   (each mapping, sequence and scalar counts once; mapping keys do not count).
 * - YAML must not construct custom/unsafe tags. Aliases may be rejected entirely;
 *   if supported, expansion must stop before exceeding 1,000 scalar references. Cycles fail safe.
 * - Invalid/unsafe/over-budget input must return HTTP 200 with escaped source or
 *   stored text, no partial parsed tree, and no user-controlled executable markup.
 *   A highlighted-source fallback may retain the existing hashed copy script;
 *   successful parsed config trees themselves must contain NO scripts.
 * - Fallback output <= 16 * input bytes + 128 KiB; this is an output envelope, not
 *   a CPU benchmark. The workerd test timeout also catches non-termination.
 *
 * Native details/summary plus script-free CSP proves the server-side no-script
 * contract. Actual Tab/Enter/Space behavior is a separate, staging-only browser
 * gate for the Builder; this Worker test does not claim browser/runtime delivery.
 * All fixtures below are synthetic; nothing is fetched from a network service.
 */
const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const CAP = 1_048_576;
const ATTACK_KEY = '<svg/onload="r34key()">';
const ATTACK_VALUE = '<img src=x onerror="r34value()"><script>r34value()</script>';
const YAML = `app:
  name: r34-config café 🧩
  enabled: true
  attempts: 3
  ratio: 1.25
  empty: ""
  tags: [alpha, beta]
  owners:
    - name: Ada
      active: false
    - name: Lin
      active: true
  '${ATTACK_KEY}': 'ampersand & angle <tag>'
  literal: '${ATTACK_VALUE}'
  network:
    port: 8080
`;
const TOML = `[app]
name = "r34-config café 🧩"
enabled = true
attempts = 3
ratio = 1.25
empty = ""
tags = ["alpha", "beta"]
owners = [{name = "Ada", active = false}, {name = "Lin", active = true}]
'${ATTACK_KEY}' = 'ampersand & angle <tag>'
literal = '${ATTACK_VALUE}'
[app.network]
port = 8080
`;
const CONFIGS = [
  { path: "config.yaml", source: YAML },
  { path: "config.yml", source: YAML },
  { path: "config.toml", source: TOML },
];
const INI = '[app]\r\nname=r34-ini\r\nenabled=true\r\n';
const XML = '<app name="r34-xml"><literal>&lt;script&gt;not executable&lt;/script&gt;</literal></app>\r\n';
const padded = (prefix: string, size: number) => prefix + "#" + "x".repeat(size - new TextEncoder().encode(prefix).length - 2) + "\n";
const deepYaml = (depth: number) => "[".repeat(depth) + '"depth-leaf"' + "]".repeat(depth) + "\n";
const deepToml = (depth: number) => "levels = " + "[".repeat(depth - 1) + '"depth-leaf"' + "]".repeat(depth - 1) + "\n";
// Root mapping + sequence + N scalars = N + 2 nodes.
const wideYaml = (scalars: number) => "values: [" + Array(scalars).fill('"node-leaf"').join(",") + "]\n";
const wideToml = (scalars: number) => "values = [" + Array(scalars).fill('"node-leaf"').join(",") + "]\n";
const ALIAS_BOMB = `seed: &a [r34-alias-leaf,r34-alias-leaf,r34-alias-leaf,r34-alias-leaf,r34-alias-leaf,r34-alias-leaf,r34-alias-leaf,r34-alias-leaf,r34-alias-leaf,r34-alias-leaf]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]
`;
const UNSAFE = [
  { path: "invalid.yaml", source: `app: [unterminated\nliteral: '${ATTACK_VALUE}'\n`, marker: "unterminated" },
  { path: "invalid.toml", source: `name = "unterminated\nliteral = '${ATTACK_VALUE}'\n`, marker: "unterminated" },
  { path: "duplicate.toml", source: 'name = "first"\nname = "second"\n', marker: "second" },
  { path: "custom-tag.yml", source: `value: !r34custom '${ATTACK_VALUE}'\n`, marker: "r34custom" },
  { path: "unsafe-tag.yaml", source: 'value: !!js/function "function () { return r34unsafe(); }"\n', marker: "r34unsafe" },
  { path: "tag-uri.yaml", source: 'value: !<tag:example.test,2026:execute> "r34-tag-uri"\n', marker: "r34-tag-uri" },
  { path: "aliases.yaml", source: ALIAS_BOMB, marker: "r34-alias-leaf" },
  { path: "alias-limit.yml", source: "seed: &a r34-alias-leaf\nvalues: [" + Array(1_001).fill("*a").join(",") + "]\n", marker: "r34-alias-leaf" },
  { path: "cycle.yml", source: 'value: &cycle [*cycle]\n', marker: "cycle" },
  { path: "deep.yaml", source: deepYaml(65), marker: "depth-leaf" },
  { path: "deep.toml", source: deepToml(65), marker: "depth-leaf" },
  { path: "wide.yaml", source: wideYaml(9_999), marker: "node-leaf" },
  { path: "wide.toml", source: wideToml(9_999), marker: "node-leaf" },
];

interface Branch {
  summary: string;
  text: string;
  depth: number;
}

// Observe real response HTML with workerd's HTML parser. No mock viewer, parser
// implementation, class names, private viewer IDs, or renderer snapshots.
async function inspect(html: string) {
  const branches: Branch[] = [];
  const stack: Branch[] = [];
  const links: string[] = [];
  const unsafe: string[] = [];
  let summary: Branch | undefined;
  let scriptCount = 0;
  let directSummaries = 0;
  await new HTMLRewriter()
    .on("details", {
      element(el) {
        const node: Branch = { summary: "", text: "", depth: stack.length + 1 };
        branches.push(node);
        stack.push(node);
        if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") unsafe.push("hidden details");
        el.onEndTag(() => { stack.pop(); });
      },
      text(t) { for (const node of stack) node.text += t.text; },
    })
    .on("details > summary", {
      element(el) {
        directSummaries++;
        summary = stack.at(-1);
        if (el.getAttribute("tabindex") === "-1" || el.hasAttribute("hidden")) unsafe.push("unreachable summary");
        el.onEndTag(() => { summary = undefined; });
      },
      text(t) { if (summary) summary.summary += t.text; },
    })
    .on("a[href]", { element(el) { links.push(el.getAttribute("href")!); } })
    .on("*", {
      element(el) {
        if (el.tagName === "script") scriptCount++;
        if (["img", "svg", "iframe", "object", "embed", "form", "base"].includes(el.tagName)) unsafe.push(el.tagName);
        for (const [name = "", value = ""] of el.attributes) {
          if (/^on/i.test(name) || (/^(href|src|action)$/i.test(name) && /^\s*javascript:/i.test(value))) unsafe.push(name);
        }
      },
    })
    .transform(new Response(html)).text();
  return { branches, directSummaries, links, unsafe, scriptCount };
}

const plain = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(?:39|x27);/g, "'").replace(/&amp;/g, "&");
const branchNamed = (branches: Branch[], name: string) => branches.find(b => plain(b.summary).includes(name));
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const digest = async (source: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))), b => b.toString(16).padStart(2, "0")).join("");

let dw: Instance;
let slug: string;
beforeAll(async () => {
  dw = await freshInstance();
  const files: Record<string, string> = {
    "observer.json": '{"observer":{"list":[{"name":"observer-leaf"}]}}',
    "legacy.ini": INI,
    "legacy.xml": XML,
    "cache/first.yaml": "cache: {name: r34-cache-alpha}\n",
    "cache/second.yaml": "cache: {name: r34-cache-alpha}\n",
    "cache/changed.yaml": "cache: {name: r34-cache-beta}\n",
    "depth-limit.yaml": deepYaml(64),
    "depth-limit.toml": deepToml(64),
    "node-limit.yaml": wideYaml(9_998),
    "node-limit.toml": wideToml(9_998),
  };
  for (const { path, source } of [...CONFIGS, ...UNSAFE]) files[path] = source;
  for (const ext of ["yaml", "yml", "toml"]) {
    const prefix = ext === "toml" ? 'app = {name = "r34-boundary-é"}\n' : "app: {name: r34-boundary-é}\n";
    files[`cap.${ext}`] = padded(prefix, CAP);
    files[`over.${ext}`] = padded(prefix, CAP + 1);
  }
  const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(files) });
  expect(published.status).toBe(201);
  slug = published.body.slug;
});
const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });

describe("R-34 parsed YAML/YML/TOML trees", () => {
  it.each(CONFIGS)("$path renders nested mappings, sequences, and scalar values, not just source", async ({ path }) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const page = await inspect(await res.text());
    expect(page.branches.length, "missing parsed native config tree").toBeGreaterThanOrEqual(4);
    for (const name of ["app", "tags", "owners", "network"]) expect(branchNamed(page.branches, name), `missing ${name} collection summary`).toBeDefined();
    const app = branchNamed(page.branches, "app")!;
    for (const value of ["r34-config", "true", "false", "3", "1.25", "empty", "8080"]) expect(plain(app.text)).toContain(value);
    const tags = branchNamed(page.branches, "tags")!;
    expect(tags.depth).toBeGreaterThan(app.depth);
    expect(plain(tags.text)).toContain("alpha");
    expect(plain(tags.text)).toContain("beta");
    const owners = branchNamed(page.branches, "owners")!;
    expect(plain(owners.text)).toContain("Ada");
    expect(plain(owners.text)).toContain("Lin");
    expect(page.branches.some(b => b.depth > owners.depth && plain(b.text).includes("Ada")), "array object must be a nested collection").toBe(true);
    expect(plain(branchNamed(page.branches, "network")!.text)).toContain("8080");
  });

  it.each(CONFIGS)("$path escapes keys and literal values in the parsed tree", async ({ path }) => {
    const html = await (await get(path)).text();
    const page = await inspect(html);
    expect(page.unsafe).toEqual([]);
    expect(page.branches.length, "escaping source alone is not a parsed tree").toBeGreaterThan(0);
    const text = plain(page.branches.map(b => b.text).join("\n"));
    expect(text).toContain(ATTACK_KEY);
    expect(text).toContain(ATTACK_VALUE);
    expect(text).toContain("ampersand & angle <tag>");
  });

  it.each(CONFIGS)("$path is usable without scripts and retains linked viewer chrome", async ({ path }) => {
    const res = await get(path);
    const html = await res.text();
    const page = await inspect(html);
    expect(page.scriptCount, "parsed config view must not depend on scripts").toBe(0);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(page.unsafe).toEqual([]);
    expect(page.branches.length).toBeGreaterThan(0);
    expect(page.directSummaries).toBe(page.branches.length);
    expect(page.links).toContain(`/s/${slug}/${path}?view=source`);
    expect(page.links).toContain(`/s/${slug}/${path}?raw=1`);
    expect(page.links).toContain(`/s/${slug}/${path}?download=1`);
    expect(page.links).toContain(`${ORIGIN}/v/${slug}/${path}`);
    const embedded = await (await get(`${path}?view=1&embed=1`)).text();
    expect(embedded).not.toContain('class="dw-vbar"');
    expect((await inspect(embedded)).branches.length).toBeGreaterThan(0);
  });

  it.each(CONFIGS)("$path supports explicit view and iframe navigation as trees", async ({ path }) => {
    for (const res of [await get(`${path}?view=1`, {}), await get(path, { ...NAV, "Sec-Fetch-Dest": "iframe" })]) {
      expect(res.status).toBe(200);
      expect((await inspect(await res.text())).branches.length).toBeGreaterThan(0);
    }
  });
});

describe("R-34 source/raw compatibility controls", () => {
  it("the HTML observer recognizes an existing real nested native tree", async () => {
    const page = await inspect(await (await get("observer.json")).text());
    const observer = branchNamed(page.branches, "observer")!;
    const list = branchNamed(page.branches, "list")!;
    expect(observer).toBeDefined();
    expect(list).toBeDefined();
    expect(list.depth).toBeGreaterThan(observer.depth);
    expect(plain(list.text)).toContain("observer-leaf");
    expect(page.directSummaries).toBe(page.branches.length);
  });

  it.each(CONFIGS)("$path keeps highlighted, escaped source on ?view=source", async ({ path }) => {
    const res = await get(`${path}?view=source`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-dropway-viewer")).toBe("source");
    const html = await res.text();
    expect(html).toContain('id="L1"');
    expect(html).toMatch(/<span class="hljs-/);
    expect(plain(html)).toContain(ATTACK_VALUE);
    const page = await inspect(html);
    expect(page.branches).toEqual([]);
    expect(page.unsafe).toEqual([]);
  });

  it.each(CONFIGS)("$path preserves stored UTF-8 bytes and raw/download headers", async ({ path, source }) => {
    const hash = await digest(source);
    const stored = await get(path, {});
    expect(stored.headers.get("x-dropway-viewer")).toBeNull();
    expect(stored.headers.get("etag")).toBe(`"${hash}"`);
    expect(await stored.text()).toBe(source);
    const raw = await get(`${path}?raw=1`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("x-dropway-viewer")).toBeNull();
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(raw.headers.get("x-dropway-original-content-type")).toBe(stored.headers.get("content-type"));
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(raw.headers.get("etag")).toBe(`"${hash}"`);
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(new TextEncoder().encode(source));
    const download = await get(`${path}?download=1`);
    expect(download.status).toBe(200);
    expect(download.headers.get("x-dropway-viewer")).toBeNull();
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(download.headers.get("content-disposition")).toContain(path);
    expect(download.headers.get("etag")).toBe(`"${hash}"`);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new TextEncoder().encode(source));
  });

  it.each(CONFIGS)("$path never wraps script/image/fetch subresources, even with HTML Accept", async ({ path, source }) => {
    for (const dest of ["script", "image", "empty"]) {
      const res = await get(path, { Accept: "text/html,*/*", "Sec-Fetch-Dest": dest, "Sec-Fetch-Mode": "cors" });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-dropway-viewer")).toBeNull();
      expect(await res.text()).toBe(source);
    }
  });

  it.each([{ path: "legacy.ini", source: INI }, { path: "legacy.xml", source: XML }])("$path retains its existing highlighted-source viewer", async ({ path, source }) => {
    const res = await get(path);
    expect(res.headers.get("x-dropway-viewer")).toBe("code");
    const html = await res.text();
    expect(html).toContain('id="L1"');
    expect(html).toMatch(/<span class="hljs-/);
    expect((await inspect(html)).branches).toEqual([]);
    expect(await (await get(`${path}?raw=1`)).text()).toBe(source);
  });

  it("reuses content-addressed tree output without leaking the first path or stale content", async () => {
    const first = await get("cache/first.yaml");
    const firstHtml = await first.text();
    expect(first.headers.get("x-dropway-render-cache")).toBe("miss");
    expect((await inspect(firstHtml)).branches.length, "cache must contain parsed output").toBeGreaterThan(0);
    const again = await get("cache/first.yaml");
    expect(again.headers.get("x-dropway-render-cache")).toBe("memory");
    expect(await again.text()).toBe(firstHtml);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"[^"\s]+"$/);
    expect((await get("cache/first.yaml", { ...NAV, "If-None-Match": etag })).status).toBe(304);
    const sibling = await get("cache/second.yaml");
    expect(sibling.headers.get("x-dropway-render-cache")).toBe("memory");
    const siblingPage = await inspect(await sibling.text());
    expect(siblingPage.links).toContain(`/s/${slug}/cache/second.yaml?raw=1`);
    expect(siblingPage.links).not.toContain(`/s/${slug}/cache/first.yaml?raw=1`);
    expect(plain(siblingPage.branches.map(b => b.text).join(""))).toContain("r34-cache-alpha");
    const changed = await get("cache/changed.yaml");
    expect(changed.headers.get("x-dropway-render-cache")).toBe("miss");
    expect(changed.headers.get("etag")).not.toBe(etag);
    const changedPage = await inspect(await changed.text());
    const changedText = plain(changedPage.branches.map(b => b.text).join(""));
    expect(changedText).toContain("r34-cache-beta");
    expect(changedText).not.toContain("r34-cache-alpha");
  });
});

describe("R-34 bounded parsing and safe fallbacks", () => {
  it.each(UNSAFE)("$path falls back safely without expansion, partial trees or 500", async ({ path, source, marker }) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(byteLength(body)).toBeLessThanOrEqual(16 * byteLength(source) + 128 * 1024);
    if (res.headers.get("content-type")?.startsWith("text/html")) {
      const page = await inspect(body);
      expect(page.branches, "unsafe input must not produce a partial parsed tree").toEqual([]);
      expect(page.unsafe).toEqual([]);
      expect(plain(body)).toContain(marker);
      // Existing source chrome may use its fixed hash, never unsafe-inline or a
      // caller-provided script. This does not relax the parsed-tree no-script gate.
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      const scriptPolicy = csp.match(/(?:^|;)\s*script-src\s+([^;]+)/)?.[1] ?? "'none'";
      expect(scriptPolicy).not.toMatch(/'unsafe-(?:inline|eval)'/);
      const sourceHtml = await (await get(`${path}?view=source`)).text();
      const scripts = (html: string) => html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
      for (const script of scripts(body)) expect(scripts(sourceHtml)).toContain(script);
    } else {
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(body).toBe(source);
    }
    expect(await (await get(`${path}?raw=1`)).text()).toBe(source);
    if (path === "aliases.yaml") expect((body.match(/r34-alias-leaf/g) ?? []).length).toBeLessThanOrEqual(10);
  });

  it.each(["yaml", "yml", "toml"])(".%s parses at exactly 1 MiB of UTF-8 bytes", async ext => {
    const prefix = ext === "toml" ? 'app = {name = "r34-boundary-é"}\n' : "app: {name: r34-boundary-é}\n";
    const at = padded(prefix, CAP);
    expect(byteLength(at)).toBe(CAP);
    const res = await get(`cap.${ext}`);
    expect(res.status).toBe(200);
    const page = await inspect(await res.text());
    expect(page.branches.length, "inclusive 1 MiB tree boundary").toBeGreaterThan(0);
    expect(plain(page.branches.map(b => b.text).join(""))).toContain("r34-boundary-é");
    expect(await (await get(`cap.${ext}?raw=1`)).text()).toBe(at);
  });

  it.each(["yaml", "yml", "toml"])(".%s does not parse one UTF-8 byte over the cap", async ext => {
    const prefix = ext === "toml" ? 'app = {name = "r34-boundary-é"}\n' : "app: {name: r34-boundary-é}\n";
    const over = padded(prefix, CAP + 1);
    expect(byteLength(over)).toBe(CAP + 1);
    const res = await get(`over.${ext}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(byteLength(body)).toBeLessThanOrEqual(16 * CAP + 128 * 1024);
    if (res.headers.get("content-type")?.startsWith("text/html")) {
      const page = await inspect(body);
      expect(page.branches).toEqual([]);
      expect(page.unsafe).toEqual([]);
    } else {
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(body).toBe(over);
    }
    expect(await (await get(`over.${ext}?raw=1`)).text()).toBe(over);
  });

  it.each(["depth-limit.yaml", "depth-limit.toml", "node-limit.yaml", "node-limit.toml"])("%s accepts the documented safe limit instead of rejecting all nested input", async path => {
    const res = await get(path);
    expect(res.status).toBe(200);
    const page = await inspect(await res.text());
    expect(page.branches.length, `missing tree at safe limit: ${path}`).toBeGreaterThan(0);
    expect(plain(page.branches.map(b => b.text).join(""))).toContain(path.startsWith("depth") ? "depth-leaf" : "node-leaf");
    expect(page.scriptCount).toBe(0);
    expect(page.unsafe).toEqual([]);
  });
});
