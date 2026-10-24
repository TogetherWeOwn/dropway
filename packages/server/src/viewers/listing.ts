import { appOrigin, detectFileKind, encodePath, KIND_LABELS, type DropwayContext, type FileKind, type LiveSite } from "@dropway/core";
import { domainsLine, escapeHtml, formatBytes, htmlPage } from "../html";
import { SKIP_LINK, siteFooter, siteHeader, TRUST_LINE } from "../ui/chrome";
import type { ThemePref } from "../ui/theme";
import type { ServeMode } from "../serve";
import { carryLink, type LinkCarry } from "./links";

const GALLERY_MAX = 60;

/** A 40px thumbnail by kind: a sheet for tables and data, a picture for images, a play mark for media, a folder for archives, else a page. */
export function thumbHtml(kind: FileKind | "folder"): string {
  const inner =
    kind === "folder" || kind === "archive"
      ? '<span class="k-th-folder"></span>'
      : kind === "csv" || kind === "json"
        ? '<span class="k-th-sheet"></span>'
        : kind === "image" || kind === "svg"
          ? '<span class="k-th-image"></span>'
          : kind === "video" || kind === "audio"
            ? '<span class="k-th-play"></span>'
            : '<span class="k-th-doc"><i></i><b></b><b class="k-s"></b></span>';
  return `<span class="k-thumb" aria-hidden="true">${inner}</span>`;
}

/**
 * Directory listing for a folder (or site root) without an index file:
 * folders first, then files with their kind and size, then a gallery of the
 * folder's images. `appViewerUrl` links to the app-origin file browser.
 * `embed` (inside the app's file viewer frame): no header, footer or "Browse files" of its own, and every
 * link keeps the embed and the mode (links.ts).
 */
export function renderListing(live: LiveSite, dir: string, mode: ServeMode, appViewerUrl?: string, opts: { dw?: DropwayContext; theme?: ThemePref; embed?: boolean } = {}): Response {
  const carry: LinkCarry = { theme: opts.theme ?? "auto", embed: !!opts.embed };
  const link = (path: string) => escapeHtml(carryLink(mode.base, path, carry));
  const dirs = new Map<string, number>();
  const files: Array<{ name: string; size: number; kind: ReturnType<typeof detectFileKind> }> = [];
  let total = 0;
  for (const [path, [, size, type]] of Object.entries(live.files)) {
    if (!path.startsWith(dir)) continue;
    const rest = path.slice(dir.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({ name: rest, size, kind: detectFileKind(path, type) });
      total += size;
    } else {
      const d = rest.slice(0, slash);
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
  }
  const base = mode.base + encodePath(dir);
  files.sort((a, b) => a.name.localeCompare(b.name));
  const folderThumb = thumbHtml("folder");
  const parent = mode.base + encodePath(dir.split("/").filter(Boolean).slice(0, -1).map((p) => `${p}/`).join(""));
  const items = [
    ...(dir ? [`<li class="k-frow">${folderThumb}<a class="k-fname" href="${link(parent)}">../</a><span class="k-fkind">Up</span><span class="k-num"></span></li>`] : []),
    ...[...dirs.entries()]
      .sort()
      .map(([d, n]) => `<li class="k-frow">${folderThumb}<a class="k-fname" href="${link(`${base + encodeURIComponent(d)}/`)}">${escapeHtml(d)}/</a><span class="k-fkind">Folder</span><span class="k-num">${n} file${n === 1 ? "" : "s"}</span></li>`),
    ...files.map(
      (f) =>
        `<li class="k-frow">${thumbHtml(f.kind)}<a class="k-fname" href="${link(base + encodeURIComponent(f.name))}">${escapeHtml(f.name)}</a><span class="k-fkind">${escapeHtml(KIND_LABELS[f.kind])}</span><span class="k-num">${formatBytes(f.size)}</span></li>`,
    ),
  ];
  const images = files.filter((f) => f.kind === "image" || f.kind === "svg").slice(0, GALLERY_MAX);
  const gallery = images.length
    ? `<h2 class="k-sr">Images in this folder</h2><ul class="k-gallery">${images
        .map((f) => `<li><a href="${link(base + encodeURIComponent(f.name))}"><img src="${escapeHtml(base + encodeURIComponent(f.name))}" alt="" loading="lazy" decoding="async"><span>${escapeHtml(f.name)}</span></a></li>`)
        .join("")}</ul>`
    : "";
  const segs = dir.split("/").filter(Boolean);
  let acc = "";
  const crumb = [`<a href="${link(mode.base)}">${escapeHtml(live.slug)}</a>`, ...segs.map((s) => {
    acc += `${s}/`;
    return `<a href="${link(mode.base + encodePath(acc))}">${escapeHtml(s)}</a>`;
  })].join('<span class="k-sep" aria-hidden="true">/</span>');
  const summary = `${dirs.size ? `${dirs.size} folder${dirs.size === 1 ? "" : "s"}, ` : ""}${files.length} file${files.length === 1 ? "" : "s"} · ${formatBytes(total)}`;
  const dw = opts.dw;
  const origin = dw ? appOrigin(dw) : undefined;
  const name = dw?.config.instanceName ?? "Kofra";
  const page = htmlPage({
    title: `${live.slug}/${dir}`,
    delivery: "site",
    theme: opts.theme,
    appOrigin: origin,
    robots: "noindex",
    body: `${origin && !carry.embed ? SKIP_LINK + siteHeader(name, origin) : ""}<main class="k-listing" id="dw-main"><div class="k-vhead"><div><nav class="k-crumbs" aria-label="Path">${crumb}<span class="k-sep" aria-hidden="true">/</span></nav><h1>${escapeHtml(segs.length ? `${segs[segs.length - 1]}/` : live.slug)}</h1><p class="k-small">${summary}</p></div>${appViewerUrl && !carry.embed ? `<a class="k-btn k-sm k-ghost" href="${escapeHtml(appViewerUrl)}" rel="nofollow">Browse files</a>` : ""}</div><ul class="k-frows" aria-label="Files">${items.join("")}</ul>${gallery}</main>${
      carry.embed ? "" : origin && dw ? siteFooter({ name, appOrigin: origin, domains: domainsLine(dw), trust: true }) : `<p class="k-trust k-vtrust">${TRUST_LINE}</p>`
    }`,
  });
  return new Response(page, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Security-Policy": `default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline';${origin ? ` font-src ${origin};` : ""} base-uri 'none'; form-action 'none'`,
      "X-Kofra-Viewer": "listing",
    },
  });
}
