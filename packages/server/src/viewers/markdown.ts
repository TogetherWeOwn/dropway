import { Marked } from "marked";
import { escapeHtml, htmlPage } from "../html";
import type { Viewer } from "./index";

const marked = new Marked({ gfm: true, breaks: false, async: false });

const MD_CSS = `
.dw-md{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 5rem}
.dw-md h1,.dw-md h2,.dw-md h3,.dw-md h4{line-height:1.25;margin:2rem 0 .75rem}
.dw-md h1{font-size:2.1rem;margin-top:0}.dw-md h2{font-size:1.5rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
.dw-md p,.dw-md ul,.dw-md ol,.dw-md blockquote,.dw-md table,.dw-md pre{margin:0 0 1rem}
.dw-md img{max-width:100%;height:auto;border-radius:6px}
.dw-md code{background:var(--code);padding:.12em .35em;border-radius:4px}
.dw-md pre{background:var(--code);padding:1rem;border-radius:8px;overflow:auto;line-height:1.45}
.dw-md pre code{background:none;padding:0}
.dw-md blockquote{border-left:3px solid var(--accent);padding:.1rem 1rem;color:var(--muted)}
.dw-md table{border-collapse:collapse;display:block;overflow:auto}
.dw-md th,.dw-md td{border:1px solid var(--line);padding:.4rem .75rem}
.dw-md hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
.dw-md li>input[type=checkbox]{margin-right:.4rem}
`;

/** Split optional YAML front matter from the body. Only `title:` is used. */
export function splitFrontMatter(src: string): { title: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { title: null, body: src };
  const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(m[1]!);
  return { title: t ? t[1]! : null, body: src.slice(m[0].length) };
}

/** Render Markdown to HTML. Raw HTML inside the Markdown is kept, but the page CSP blocks every script. */
export function renderMarkdown(src: string, path: string): { title: string; html: string } {
  const { title: fmTitle, body } = splitFrontMatter(src.replace(/^\uFEFF/, ""));
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  const title = fmTitle ?? (h1 ? h1[1]!.replace(/[*_`]/g, "") : (path.split("/").pop() ?? path));
  return { title, html: marked.parse(body) as string };
}

export const markdownViewer: Viewer = {
  id: "markdown",
  maxBytes: 2 * 1024 * 1024,
  matches: (file, live) => live.renderMarkdown && file.kind === "markdown",
  async render(vc) {
    const { title, html } = renderMarkdown(await vc.readText(), vc.file.path);
    const page = htmlPage({
      title,
      css: MD_CSS,
      body: `<header class="dw-bar"><span class="dw-path">${escapeHtml(vc.file.path)}</span><nav><a href="${escapeHtml(vc.rawUrl)}" rel="nofollow">View raw</a><a href="${escapeHtml(vc.downloadUrl)}" rel="nofollow">Download</a></nav></header><article class="dw-md">${html}</article>`,
    });
    return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
