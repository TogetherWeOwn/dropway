import { encodePath, type LiveSite } from "@dropway/core";
import { escapeHtml, formatBytes, htmlPage } from "../html";
import type { ServeMode } from "../serve";

const LISTING_CSS = `
.dw-ls{max-width:52rem;margin:0 auto;padding:2rem 1.25rem 4rem}
.dw-ls h1{font-size:1.2rem;font-family:ui-monospace,monospace;margin:0 0 1rem;word-break:break-all}
.dw-ls ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.dw-ls li{display:flex;justify-content:space-between;gap:1rem;padding:.55rem .9rem;border-top:1px solid var(--line);background:var(--card)}
.dw-ls li:first-child{border-top:0}.dw-ls a{text-decoration:none}.dw-ls span{color:var(--muted);font-size:.85rem;white-space:nowrap}
`;

/**
 * Directory listing for a folder (or site root) without an index file.
 * Minimal on purpose: the viewer work can replace it with a richer file browser.
 */
export function renderListing(live: LiveSite, dir: string, mode: ServeMode): Response {
  const dirs = new Map<string, number>();
  const files: Array<{ name: string; size: number }> = [];
  for (const [path, [, size]] of Object.entries(live.files)) {
    if (!path.startsWith(dir)) continue;
    const rest = path.slice(dir.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.push({ name: rest, size });
    else {
      const d = rest.slice(0, slash);
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
  }
  const base = mode.base + encodePath(dir);
  const items = [
    ...(dir ? [`<li><a href="../">../</a><span></span></li>`] : []),
    ...[...dirs.entries()].sort().map(([d, n]) => `<li><a href="${escapeHtml(base + encodeURIComponent(d))}/">${escapeHtml(d)}/</a><span>${n} file${n === 1 ? "" : "s"}</span></li>`),
    ...files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => `<li><a href="${escapeHtml(base + encodeURIComponent(f.name))}">${escapeHtml(f.name)}</a><span>${formatBytes(f.size)}</span></li>`),
  ];
  const title = `/${dir}`;
  const page = htmlPage({ title: `${live.slug}${title}`, css: LISTING_CSS, body: `<main class="dw-ls"><h1>${escapeHtml(title)}</h1><ul>${items.join("")}</ul></main>` });
  return new Response(page, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "X-Dropway-Viewer": "listing",
    },
  });
}
