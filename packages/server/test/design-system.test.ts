import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM build script without type declarations
import { buildDesign, classesIn, minifyCss, prefixCss, prefixSelector } from "../../../scripts/build-design.mjs";
import { APP_CSS, SITE_CSS, THEME_TOKENS } from "../src/ui/design.generated";
import { kofraMotifs } from "../src/ui/motifs";

/**
 * The Security Print design system as code: the k- prefixer, the generated modules being in sync with
 * their sources, WCAG AA contrast for both modes, the literal-colour lint, and the class lint (every
 * class the server and the dashboard script write exists in the built CSS; no retired class is left).
 */
const ROOT = new URL("../../../", import.meta.url).pathname;
const SRC = join(ROOT, "packages/server/src");
const CSS_DIR = join(ROOT, "packages/server/design/css");

describe("k- prefixer", () => {
  it("prefixes classes in selector lists, :not(), :is(), compound selectors and inside @media", () => {
    expect(prefixSelector(".btn.ghost:hover, a.btn > .x:not(.y):is(.z, p)")).toBe(".k-btn.k-ghost:hover, a.k-btn > .k-x:not(.k-y):is(.k-z, p)");
    expect(prefixCss("@media (max-width:720px){.wrap{padding:0}.a .b{x:1}}")).toBe("@media (max-width:720px){.k-wrap{padding:0}.k-a .k-b{x:1}}");
  });
  it("never touches attribute selectors, strings, url(), values, keyframes or @font-face", () => {
    expect(prefixSelector('[data-x=".y"] .z[class~="w"]')).toBe('[data-x=".y"] .k-z[class~="w"]');
    const css = `.a{background:url("data:x.svg#.b");content:".c";margin:.5em}@keyframes k-spin{to{opacity:.5}}@font-face{font-family:'X';src:url(/a.woff2)}`;
    expect(prefixCss(css)).toBe(`.k-a{background:url("data:x.svg#.b");content:".c";margin:.5em}@keyframes k-spin{to{opacity:.5}}@font-face{font-family:'X';src:url(/a.woff2)}`);
  });
  it("minifies without changing selectors or strings", () => {
    expect(minifyCss(".a :focus , .b  >  .c { color : red ; }")).toBe(".a :focus,.b>.c{color : red}");
    expect(minifyCss('.a{content:"  two  spaces  "}')).toBe('.a{content:"  two  spaces  "}');
  });
});

describe("generated design modules", () => {
  it("are in sync with packages/server/design (npm run design:check)", async () => {
    const { designTs, fontsTs } = await buildDesign();
    expect(readFileSync(join(SRC, "ui/design.generated.ts"), "utf8")).toBe(designTs);
    expect(readFileSync(join(SRC, "ui/fonts.generated.ts"), "utf8")).toBe(fontsTs);
  });
  it("every built class carries the k- prefix (hljs classes excepted)", () => {
    for (const css of [APP_CSS, SITE_CSS]) {
      const bad = [...classesIn(css)].filter((c: string) => !c.startsWith("k-") && !c.startsWith("hljs") && !/^[a-z]+_$/.test(c));
      expect(bad).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------ contrast (WCAG 2.x)

function lum(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe("contrast: both modes pass WCAG AA", () => {
  const TEXT: Array<[string, string]> = [
    ["ink", "paper"], ["ink", "paper-2"], ["ink", "paper-3"], ["ink", "surface"], ["ink", "field"],
    ["ink-2", "paper"], ["ink-2", "paper-2"], ["ink-2", "paper-3"], ["ink-2", "surface"],
    ["muted", "paper"], ["muted", "paper-2"], ["muted", "paper-3"], ["muted", "surface"], ["muted", "field"],
    ["accent", "paper"], ["accent", "paper-2"], ["accent", "paper-3"], ["accent", "surface"],
    ["accent-2", "paper"], ["accent-2", "paper-2"], ["accent-2", "paper-3"], ["accent-2", "surface"],
    ["accent-ink", "accent"], ["accent-ink", "accent-hover"],
    ["danger", "paper"], ["danger", "paper-2"], ["danger", "surface"],
    ["warning", "paper"], ["warning", "paper-2"], ["warning", "warning-wash"],
    ["success", "paper"], ["success", "paper-2"],
    ["paper", "danger"], ["paper", "accent"],
  ];
  const UI: Array<[string, string]> = [["edge", "paper"], ["edge", "paper-2"], ["edge", "field"], ["focus", "paper"], ["focus", "paper-2"], ["focus", "surface"], ["signal", "paper"], ["eng-1", "paper-2"], ["eng-mark", "paper-2"]];
  const SYN = ["syn-comment", "syn-keyword", "syn-string", "syn-number", "syn-title", "syn-type", "syn-tag", "syn-meta"];
  for (const mode of ["light", "dark"] as const) {
    const t = THEME_TOKENS[mode] as Record<string, string>;
    it(`${mode}: text pairs >= 4.5:1, UI parts >= 3:1, syntax colours >= 4.5:1 on paper, paper-2, paper-3`, () => {
      const fails: string[] = [];
      for (const [fg, bg] of TEXT) if (contrast(t[fg]!, t[bg]!) < 4.5) fails.push(`${fg}/${bg} ${contrast(t[fg]!, t[bg]!).toFixed(2)}`);
      for (const [fg, bg] of UI) if (contrast(t[fg]!, t[bg]!) < 3) fails.push(`${fg}/${bg} ${contrast(t[fg]!, t[bg]!).toFixed(2)}`);
      for (const s of SYN) for (const bg of ["paper", "paper-2", "paper-3"]) if (contrast(t[s]!, t[bg]!) < 4.5) fails.push(`${s}/${bg} ${contrast(t[s]!, t[bg]!).toFixed(2)}`);
      if (contrast(t["syn-del"]!, t["syn-del-wash"]!) < 4.5) fails.push("syn-del/syn-del-wash");
      if (contrast(t["syn-add"]!, t["syn-add-wash"]!) < 4.5) fails.push("syn-add/syn-add-wash");
      expect(fails).toEqual([]);
    });
  }
});

// ------------------------------------------------------------------ literal colours and classes

/** Literal colours allowed in component CSS (PORT-SPEC 8.3): E2 the user-content canvas (frame, notebook output images). */
const ALLOWED_LITERALS = [/\.frame\{[^}]*background:#fff/, /\.k-frame\{[^}]*background:#fff/, /\.nb-out img\{[^}]*background:#fff/];
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![.\w-])(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple)\b(?![-\w])/;

function stripForcedColors(css: string): string {
  // E5: system colours inside @media (forced-colors: active) are allowed by definition.
  return css.replace(/@media \(forced-colors:active\)\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
}

describe("literal-colour lint", () => {
  it("design CSS uses tokens only (E2 and E5 excepted)", () => {
    const fails: string[] = [];
    for (const f of readdirSync(CSS_DIR)) {
      let css = minifyCss(readFileSync(join(CSS_DIR, f), "utf8"));
      css = stripForcedColors(css).replace(/url\("data:[^"]*"\)/g, "url()");
      for (const ok of ALLOWED_LITERALS) css = css.replace(ok, "");
      const m = LITERAL.exec(css);
      if (m) fails.push(`${f}: ${css.slice(Math.max(0, m.index - 40), m.index + 20)}`);
    }
    expect(fails).toEqual([]);
  });
  it("viewer and page CSS in the server source uses tokens only", () => {
    const fails: string[] = [];
    for (const dir of ["viewers", "ui", "."]) {
      for (const f of readdirSync(join(SRC, dir)).filter((n) => n.endsWith(".ts") && !n.endsWith(".generated.ts"))) {
        const src = readFileSync(join(SRC, dir, f), "utf8");
        for (const m of src.matchAll(/(?:css|CSS)[^=\n]*=\s*`([^`]*)`|css:\s*"([^"]*)"/g)) {
          let css = (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, "");
          for (const ok of ALLOWED_LITERALS) css = css.replace(ok, "");
          const hit = LITERAL.exec(css);
          if (hit) fails.push(`${dir}/${f}: ${css.slice(Math.max(0, hit.index - 40), hit.index + 20)}`);
        }
      }
    }
    expect(fails).toEqual([]);
  });
});

/** Legacy presentational classes (PORT-SPEC 8.2): none may be left in markup the server or the dashboard script writes. */
const RETIRED = [
  "dw-top", "dw-brand", "dw-nav", "dw-banner", "dw-callout", "dw-error", "dw-main-wide", "dw-skip", "dw-pagehead", "dw-h1", "dw-section", "dw-pad", "dw-row",
  "dw-btn", "dw-btn-link", "dw-label", "dw-input", "dw-select", "dw-field", "dw-help", "dw-check", "dw-grid2", "dw-table", "dw-scroll", "dw-badge", "dw-empty",
  "dw-secret", "dw-skel", "dw-toast", "dw-dialog", "dw-drop", "dw-progress", "dw-url", "dw-title", "dw-sub", "dw-kv", "dw-tabs", "dw-snippet", "dw-snipwrap",
  "dw-hero", "dw-eyebrow", "dw-home", "dw-points", "dw-foot", "dw-panel", "dw-auth", "dw-side", "dw-treebox", "dw-viewer", "dw-vtools", "dw-vtabs", "dw-vbar",
  "dw-vfile", "dw-kind", "dw-crumbs", "dw-sep", "dw-vmeta", "dw-vact", "dw-toggle", "dw-note", "dw-checker", "dw-meta", "dw-ls", "dw-gal", "dw-system", "dw-code",
  "dw-bar", "dw-muted", "dw-small", "dw-mono", "dw-hide-sm", "dw-wide",
];

/** Class names written by server-rendered markup (class="...") and by the dashboard script (class: "..."). */
function classesUsed(): Map<string, string> {
  const out = new Map<string, string>();
  const files = [
    ...["html.ts", "serve.ts", "create.ts", "app.ts", "encrypted.ts", "report-link.ts"].map((f) => join(SRC, f)),
    ...readdirSync(join(SRC, "ui")).filter((f) => f.endsWith(".ts") && !f.endsWith(".generated.ts")).map((f) => join(SRC, "ui", f)),
    ...readdirSync(join(SRC, "viewers")).filter((f) => f.endsWith(".ts")).map((f) => join(SRC, "viewers", f)),
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/class(?:Name)?(?:=\\?"|: ?")([^"$\\]*)/g)) {
      for (const c of m[1]!.split(/\s+/)) if (/^[A-Za-z0-9_-]+$/.test(c)) out.set(c, file.replace(ROOT, ""));
    }
    for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\("([^"]+)"/g)) out.set(m[1]!, file.replace(ROOT, ""));
  }
  return out;
}

describe("class lint", () => {
  const used = classesUsed();
  it("no retired presentational class is written anywhere", () => {
    const left = [...used.entries()].filter(([c]) => RETIRED.includes(c));
    expect(left).toEqual([]);
  });
  it("every k- class the server or the dashboard writes exists in the built CSS (or a viewer's own CSS)", () => {
    const viewerCss = readdirSync(join(SRC, "viewers"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(SRC, "viewers", f), "utf8"))
      .join("\n");
    const pageCss = [readFileSync(join(SRC, "encrypted.ts"), "utf8"), viewerCss].join("\n");
    const defined = new Set<string>([...classesIn(APP_CSS), ...classesIn(SITE_CSS)]);
    // Marker classes that only carry state for selectors elsewhere (no style of their own).
    const markers = new Set(["k-draw"]);
    const missing = [...used.entries()].filter(([c]) => c.startsWith("k-") && !defined.has(c) && !markers.has(c) && !pageCss.includes(`.${c}`));
    expect(missing).toEqual([]);
  });
});

describe("motifs", () => {
  const m = kofraMotifs() as { seal(seed: string, o?: Record<string, unknown>): string; plate(seed: string, o?: Record<string, unknown>): string };
  it("seals are deterministic, token-classed and distinct per input; never a colour attribute", () => {
    const a = m.seal("SHA256:aa", { size: "mini", label: "Checksum seal for a.txt" });
    expect(m.seal("SHA256:aa", { size: "mini", label: "Checksum seal for a.txt" })).toBe(a);
    expect(m.seal("SHA256:ab", { size: "mini" })).not.toBe(a);
    expect(a).toContain('role="img" aria-label="Checksum seal for a.txt"');
    expect(a).toContain('class="k-e1"');
    expect(a).not.toMatch(/(?:stroke|fill)="#|color=/);
    expect(a.length).toBeLessThan(12_000);
  });
  it("plates stay inside their size budget", () => {
    expect(m.plate("kofra-home").length).toBeLessThan(420_000);
    expect(m.plate("kofra-signin", { lite: true }).length).toBeLessThan(100_000);
  });
});
