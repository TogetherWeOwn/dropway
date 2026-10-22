/**
 * Path-mode URL rewriting.
 *
 * In path mode a site lives under a prefix (/s/<slug>/ or /<slug>/), so a
 * root-relative URL in its HTML ("/assets/app.js") would escape the site.
 * Browsers send no Referer from sandboxed (opaque-origin) pages (Fetch spec:
 * "determine request's referrer" returns no referrer for an opaque origin), so
 * the Referer fallback cannot catch those. Instead, HTML documents and CSS files
 * are rewritten on the way out: root-relative URLs get the site prefix.
 * ?raw=1 always returns the stored bytes untouched. Subdomain mode never rewrites.
 *
 * URLs built at run time in JavaScript (fetch("/data.json")) are handled in
 * sandboxed pages by a small script injected at the top of the page, which
 * applies the same rule in the browser (./path-shim). Unsandboxed path-mode
 * pages send a Referer, so the server resolves those requests (./route-sites).
 */

/** Element/attribute pairs that carry URLs (also drives the run-time half in ./path-shim). */
export const URL_ATTRS: Array<[selector: string, attr: string]> = [
  ["a[href]", "href"],
  ["area[href]", "href"],
  ["link[href]", "href"],
  ["script[src]", "src"],
  ["img[src]", "src"],
  ["img[srcset]", "srcset"],
  ["source[src]", "src"],
  ["source[srcset]", "srcset"],
  ["video[src]", "src"],
  ["video[poster]", "poster"],
  ["audio[src]", "src"],
  ["track[src]", "src"],
  ["iframe[src]", "src"],
  ["embed[src]", "src"],
  ["object[data]", "data"],
  ["form[action]", "action"],
  ["button[formaction]", "formaction"],
  ["input[src]", "src"],
  ["input[formaction]", "formaction"],
  ["use[href]", "href"],
  ["image[href]", "href"],
];

export interface PathRewrite {
  /** Site prefix, ending in "/", e.g. "/s/bright-otter-x7k2/". */
  base: string;
  /** Root-relative URLs starting with one of these are left alone (e.g. "/s/" links to other sites). */
  keep: readonly string[];
}

export function prefixRootRelative(value: string, rw: PathRewrite): string {
  const v = value.trim();
  if (!v.startsWith("/") || v.startsWith("//")) return value;
  if (v.startsWith(rw.base) || v === rw.base.slice(0, -1)) return value;
  for (const k of rw.keep) if (v.startsWith(k)) return value;
  return rw.base + v.slice(1);
}

function rewriteSrcset(value: string, rw: PathRewrite): string {
  return value
    .split(",")
    .map((part) => {
      const m = /^(\s*)(\S+)(.*)$/s.exec(part);
      return m ? `${m[1]}${prefixRootRelative(m[2]!, rw)}${m[3]}` : part;
    })
    .join(",");
}

/**
 * Stream an HTML response through HTMLRewriter, prefixing root-relative URLs.
 * `inject` (trusted HTML, e.g. the run-time shim) goes in as the first child of
 * <head>; in a page without a <head> tag, before its first <script>, CSP <meta>
 * or into <body>, whichever comes first. Either way it runs before page scripts.
 */
export function rewriteHtml(response: Response, rw: PathRewrite, opts: { inject?: string } = {}): Response {
  let rewriter = new HTMLRewriter();
  const inject = opts.inject;
  if (inject) {
    let done = false;
    const once = (place: (html: string) => void) => {
      if (done) return;
      done = true;
      place(inject);
    };
    rewriter = rewriter
      .on("head", { element: (el) => once((h) => el.prepend(h, { html: true })) })
      .on("script", { element: (el) => once((h) => el.before(h, { html: true })) })
      .on("meta[http-equiv]", {
        element(el) {
          if ((el.getAttribute("http-equiv") ?? "").toLowerCase() === "content-security-policy") once((h) => el.before(h, { html: true }));
        },
      })
      .on("body", { element: (el) => once((h) => el.prepend(h, { html: true })) });
  }
  for (const [selector, attr] of URL_ATTRS) {
    rewriter = rewriter.on(selector, {
      element(el) {
        const v = el.getAttribute(attr);
        if (v === null) return;
        const next = attr === "srcset" ? rewriteSrcset(v, rw) : prefixRootRelative(v, rw);
        if (next !== v) el.setAttribute(attr, next);
      },
    });
  }
  // <meta http-equiv="refresh" content="0; url=/next">
  rewriter = rewriter.on("meta[http-equiv]", {
    element(el) {
      if ((el.getAttribute("http-equiv") ?? "").toLowerCase() !== "refresh") return;
      const c = el.getAttribute("content");
      if (!c) return;
      const next = c.replace(/(url\s*=\s*['"]?)(\/[^'"\s]*)/i, (_m, pre: string, url: string) => pre + prefixRootRelative(url, rw));
      if (next !== c) el.setAttribute("content", next);
    },
  });
  return rewriter.transform(response);
}

/** Prefix root-relative url(...) and @import targets in CSS text. */
export function rewriteCss(css: string, rw: PathRewrite): string {
  return css
    .replace(/url\(\s*(['"]?)(\/(?!\/)[^'")\s]*)/g, (_m, q: string, url: string) => `url(${q}${prefixRootRelative(url, rw)}`)
    .replace(/@import\s+(['"])(\/(?!\/)[^'"]*)/g, (_m, q: string, url: string) => `@import ${q}${prefixRootRelative(url, rw)}`);
}

/** CSS files above this size are served untouched. */
export const MAX_CSS_REWRITE_BYTES = 2 * 1024 * 1024;
