import { appOrigin, encodePath, KIND_LABELS } from "@dropway/core";
import { escapeHtml, formatBytes, htmlPage } from "../html";
import { TRUST_LINE } from "../ui/chrome";
import { SITE_CSS_HASH } from "../ui/design.generated";
import { fileSeal } from "../ui/motifs";
import { themeOf } from "../ui/theme";
import type { ViewerContext } from "./index";

/**
 * Version of what every viewer page shares: the bar, the document and the inlined site CSS. It is part of
 * every viewer ETag, so a redesign (or any change to the site CSS, through its hash) turns over the
 * validators of every viewer at once, not only of viewers whose own version was bumped.
 */
export const VIEWER_PAGE_VERSION = `sp1.${SITE_CSS_HASH}`;

/**
 * The shared frame of every viewer page: one slim bar (kind, path, size, type;
 * view tabs; Download; a link to the app-origin file browser) above the body.
 * The bar is plain links, so it works with JavaScript off.
 */

/** CSP for viewer pages: no scripts, so user-authored markup inside e.g. Markdown cannot execute. */
export const VIEWER_CSP =
  "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline' https:; font-src * data:; frame-src https:; base-uri 'none'; form-action 'none'";

/**
 * VIEWER_CSP plus what one viewer needs: hashed inline scripts, frames or
 * plugin objects from given origins (explicit origins, because 'self' does not
 * reliably match inside a sandboxed, opaque-origin page).
 */
export function viewerCsp(opts: { scriptHashes?: string[]; frameSrc?: string[]; objectSrc?: string[] } = {}): string {
  let csp = VIEWER_CSP;
  if (opts.frameSrc?.length) csp = csp.replace("frame-src https:", `frame-src https: ${opts.frameSrc.join(" ")}`);
  if (opts.objectSrc?.length) csp += `; object-src ${opts.objectSrc.join(" ")}`;
  if (opts.scriptHashes?.length) csp += `; script-src ${opts.scriptHashes.map((h) => `'${h}'`).join(" ")}`;
  return csp;
}

const hashes = new Map<string, Promise<string>>();

/** CSP source hash ("sha256-<base64>") of an inline script, computed once per isolate. */
export function scriptHash(script: string): Promise<string> {
  let h = hashes.get(script);
  if (!h) {
    h = crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)).then((d) => {
      let bin = "";
      for (const b of new Uint8Array(d)) bin += String.fromCharCode(b);
      return `sha256-${btoa(bin)}`;
    });
    hashes.set(script, h);
  }
  return h;
}

export interface ViewerTab {
  label: string;
  href: string;
  current?: boolean;
  /** The stored bytes (never gets ?theme=). */
  raw?: boolean;
}

/**
 * The usual tabs: the default view (label names it: "Rendered", "Table", "Tree"...),
 * "Source" for text files and "Raw" (the stored bytes).
 */
export function standardTabs(vc: ViewerContext, opts: { rendered?: string | null; source?: boolean; raw?: boolean } = {}): ViewerTab[] {
  const tabs: ViewerTab[] = [];
  const source = vc.mode === "source";
  if (opts.rendered !== null) tabs.push({ label: opts.rendered ?? "Rendered", href: vc.fileUrl, current: !source });
  if (opts.source) tabs.push({ label: "Source", href: vc.sourceUrl, current: source });
  if (opts.raw !== false) tabs.push({ label: "Raw", href: vc.rawUrl, raw: true });
  return tabs;
}

/** Breadcrumb links: each folder links to its listing on this origin. */
function crumbs(vc: ViewerContext): string {
  const parts = vc.file.path.split("/");
  const out: string[] = [`<a href="${escapeHtml(vc.siteBase)}">${escapeHtml(vc.live.slug)}</a>`];
  let dir = "";
  parts.forEach((p, i) => {
    if (i === parts.length - 1) out.push(`<strong aria-current="page">${escapeHtml(p)}</strong>`);
    else {
      dir += `${p}/`;
      out.push(`<a href="${escapeHtml(vc.siteBase + encodePath(dir))}">${escapeHtml(p)}</a>`);
    }
  });
  return out.join('<span class="k-sep" aria-hidden="true">/</span>');
}

/**
 * Carry ?theme= (set by the app's file viewer for an explicit mode) onto links to other Kofra-generated
 * views of the same file (Rendered, Source). Never onto Raw or Download: those are the user's bytes.
 */
function withTheme(vc: ViewerContext, href: string): string {
  const t = vc.url.searchParams.get("theme");
  if (t !== "light" && t !== "dark") return href;
  // An HTML file's own address is the user's page, not a Kofra view.
  if (vc.file.kind === "html" && !/[?&]view=/.test(href)) return href;
  return `${href}${href.includes("?") ? "&" : "?"}theme=${t}`;
}

export function viewerBar(vc: ViewerContext, tabs: ViewerTab[], extra = ""): string {
  if (vc.embed) return "";
  const kind = KIND_LABELS[vc.file.kind] ?? "File";
  const type = vc.file.contentType.split(";")[0]!;
  const origin = appOrigin(vc.dw);
  return `<header class="k-vbar">
<div class="k-vfile"><a class="k-wm" href="${escapeHtml(origin)}" rel="nofollow">${escapeHtml(vc.dw.config.instanceName)}</a><span class="k-chip k-accent">${escapeHtml(kind)}</span><nav class="k-crumbs" aria-label="Path">${crumbs(vc)}</nav><span class="k-vmeta">${formatBytes(vc.file.size)} · ${escapeHtml(type)}</span><span class="k-sum k-mini k-hide-sm">${fileSeal(vc.file.path, vc.file.sha256)}<span><code title="SHA-256 ${escapeHtml(vc.file.sha256)}">${escapeHtml(vc.file.sha256.slice(0, 12))}…</code></span></span></div>
<nav class="k-seg" aria-label="View">${tabs
    .map((t) => `<a href="${escapeHtml(t.raw ? t.href : withTheme(vc, t.href))}"${t.current ? ' aria-current="page"' : ""} rel="nofollow">${escapeHtml(t.label)}</a>`)
    .join("")}</nav>
<nav class="k-btnrow" aria-label="File">${extra}<a class="k-btn k-sm k-ghost" href="${escapeHtml(vc.downloadUrl)}" rel="nofollow" download>Download</a><a class="k-btn k-sm k-ghost" href="${escapeHtml(vc.appViewerUrl)}" rel="nofollow" title="Browse every file of this site">Files</a></nav>
<p class="k-trust k-show-lg">${TRUST_LINE}</p>
</header>`;
}

/** Shared viewer styles (on top of the site bundle). */
export const VIEWER_CSS = `
.k-vbody{min-height:calc(100vh - 3.5rem)}
.k-toggle:focus-visible~* .k-togglebtn,.k-toggle:focus-visible~.k-togglebtn{outline:2px solid var(--focus);outline-offset:2px}
`;

/** A complete viewer page response. `body` is trusted HTML (escape user content before passing it). */
export function viewerPage(
  vc: ViewerContext,
  opts: { title?: string; body: string; css?: string; tabs: ViewerTab[]; barExtra?: string; csp?: string; script?: string; headers?: Record<string, string> },
): Response {
  const page = htmlPage({
    title: opts.title ?? `${vc.file.path.split("/").pop()} · ${vc.live.slug}`,
    css: VIEWER_CSS + (opts.css ?? ""),
    robots: "noindex",
    delivery: "site",
    theme: themeOf(vc.dw),
    appOrigin: appOrigin(vc.dw),
    body:
      viewerBar(vc, opts.tabs, opts.barExtra) +
      `<div class="k-vbody">${opts.body}</div>` +
      (vc.embed ? "" : `<p class="k-trust k-vtrust k-hide-lg">${TRUST_LINE}</p>`) +
      (opts.script ? `<script>${opts.script}</script>` : ""),
  });
  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", ...opts.headers };
  if (opts.csp) headers["Content-Security-Policy"] = opts.csp;
  return new Response(page, { headers });
}

/** Note shown when only the first part of a large file is displayed. */
export function truncatedNote(vc: ViewerContext, shownBytes: number): string {
  return `<p class="k-banner k-notebar" role="note">Showing the first ${formatBytes(shownBytes)} of ${formatBytes(vc.file.size)}.&nbsp;<a href="${escapeHtml(vc.rawUrl)}" rel="nofollow">Raw</a>&nbsp;or&nbsp;<a href="${escapeHtml(vc.downloadUrl)}" rel="nofollow">download</a>&nbsp;the whole file.</p>`;
}

/** Decode UTF-8 (BOM stripped, invalid sequences replaced). */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
}
