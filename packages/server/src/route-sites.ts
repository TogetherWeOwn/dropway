import {
  RESERVED_SLUGS,
  appOrigin,
  getLiveSite,
  looksLikeSlug,
  requestPathToFilePath,
  siteUrl,
  type DropwayContext,
} from "@dropway/core";
import { resolvePath, type ServeMode } from "./serve";

/**
 * Decide whether a request is for a published site or for the app.
 *
 * Modes (config.sitesMode):
 * - subdomain: <slug>.<sitesDomain>/<path> is a site; everything else is the app.
 * - path, separate sites origin (config.sitesOrigin): <sitesOrigin>/<slug>/<path> is a site;
 *   the app origin redirects /<prefix>/<slug>/... there and never serves user content.
 * - path, shared origin: <appOrigin>/<prefix>/<slug>/<path> is a site (always sandboxed).
 *
 * Path mode is interim (all sites share one origin). Absolute paths inside a
 * site (for example <script src="/assets/app.js">) escape the /<slug>/ prefix;
 * they are resolved with the Referer: if the referring page belongs to site X
 * and X has that file, the request is redirected (307) to X's canonical URL.
 * Redirecting (rather than serving in place) keeps module graphs and CSS url()
 * resolving under the right site, keeps caches per site, and makes service
 * worker registration at "/" impossible (browsers refuse redirected SW scripts).
 */
export type SiteRoute =
  | { kind: "site"; slug: string; path: string; mode: ServeMode }
  | { kind: "redirect"; location: string; status: 301 | 307 | 308; byReferer: boolean }
  | { kind: "sites_home" }
  | { kind: "sites_not_found" }
  | { kind: "app" };

const isSiteSlug = (s: string | undefined): s is string => !!s && looksLikeSlug(s) && !RESERVED_SLUGS.has(s);

/** The site a same-origin Referer points into, given the path prefix sites live under ("" = origin root). */
function refererSlug(req: Request, url: URL, prefix: string): string | null {
  const ref = req.headers.get("referer");
  if (!ref) return null;
  let r: URL;
  try {
    r = new URL(ref);
  } catch {
    return null;
  }
  if (r.origin !== url.origin) return null;
  if (prefix && !r.pathname.startsWith(`${prefix}/`)) return null;
  const slug = r.pathname.slice(prefix.length).split("/")[1];
  return isSiteSlug(slug) ? slug : null;
}

/** Does site `slug` have something to serve at this absolute path (no SPA/404 fallbacks)? */
async function siteHasPath(dw: DropwayContext, slug: string, pathname: string, req: Request, base: string): Promise<boolean> {
  const live = await getLiveSite(dw, slug);
  if (!live || !live.versionId || (live.expiresAt && live.expiresAt < Date.now())) return false;
  const p = requestPathToFilePath(pathname);
  if (p === null) return false;
  return resolvePath(live, p, req, { kind: "path", base, sandbox: true, rewrite: null }, false).kind !== "not_found";
}

/**
 * A former path-mode sites origin (config.legacySitesOrigins): <origin>/<slug>/<rest>?q answers
 * 308 to <current site URL><rest>?q, so old links, embeds and bookmarks keep working. An absolute
 * path from a page of site X there (Referer) goes to X. Never cached: a rollback works at once.
 */
function legacySitesRoute(dw: DropwayContext, req: Request, url: URL): SiteRoute {
  if (url.pathname === "/") return dw.config.appOrigin ? { kind: "redirect", location: dw.config.appOrigin, status: 308, byReferer: false } : { kind: "sites_not_found" };
  const first = url.pathname.split("/")[1];
  if (isSiteSlug(first)) return { kind: "redirect", location: siteUrl(dw, first) + url.pathname.slice(first.length + 2) + url.search, status: 308, byReferer: false };
  const ref = refererSlug(req, url, "");
  if (ref) return { kind: "redirect", location: siteUrl(dw, ref) + url.pathname.slice(1) + url.search, status: 307, byReferer: true };
  return { kind: "sites_not_found" };
}

export async function routeSiteRequest(dw: DropwayContext, req: Request): Promise<SiteRoute> {
  const c = dw.config;
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const readOnly = method === "GET" || method === "HEAD";

  if (c.legacySitesOrigins.includes(url.origin)) return legacySitesRoute(dw, req, url);

  if (c.sitesMode === "subdomain" && c.sitesDomain) {
    const host = url.hostname.toLowerCase();
    if (host.endsWith(`.${c.sitesDomain}`)) {
      const label = host.slice(0, -(c.sitesDomain.length + 1));
      if (isSiteSlug(label)) return { kind: "site", slug: label, path: url.pathname, mode: { kind: "subdomain", base: "/", sandbox: c.sitesSandbox, rewrite: null } };
      // Reserved labels are never user sites: www goes to the app; the rest (files, fallback,
      // customers, ...) belong to the platform and answer 404 here unless an embedding app
      // handles those hosts first. Dotted and malformed labels have no certificate or site.
      if (label === "www" && c.appOrigin) return { kind: "redirect", location: c.appOrigin, status: 301, byReferer: false };
      return { kind: "sites_not_found" };
    }
    if (host === c.sitesDomain) return { kind: "redirect", location: appOrigin(dw), status: 301, byReferer: false };
    const prefix = c.sitesPathPrefix;
    if (url.pathname.startsWith(`${prefix}/`)) {
      const rest = url.pathname.slice(prefix.length + 1);
      const slug = rest.split("/")[0];
      if (isSiteSlug(slug)) return { kind: "redirect", location: siteUrl(dw, slug) + rest.slice(slug.length + 1) + url.search, status: 301, byReferer: false };
    }
    return { kind: "app" };
  }

  // Path mode with a separate, sites-only origin.
  if (c.sitesOrigin && url.origin === c.sitesOrigin) {
    if (url.pathname === "/") return { kind: "sites_home" };
    const first = url.pathname.split("/")[1];
    const ref = refererSlug(req, url, "");
    if (readOnly && ref && ref !== first && (await siteHasPath(dw, ref, url.pathname, req, `/${ref}/`))) {
      return { kind: "redirect", location: `/${ref}${url.pathname}${url.search}`, status: 307, byReferer: true };
    }
    if (isSiteSlug(first)) {
      if (url.pathname === `/${first}`) return { kind: "redirect", location: `/${first}/${url.search}`, status: 301, byReferer: false };
      return { kind: "site", slug: first, path: url.pathname.slice(first.length + 1), mode: { kind: "path", base: `/${first}/`, sandbox: c.sitesSandbox, rewrite: { base: `/${first}/`, keep: [] } } };
    }
    return { kind: "sites_not_found" };
  }

  // Path mode on the app origin.
  const prefix = c.sitesPathPrefix;
  if (url.pathname.startsWith(`${prefix}/`)) {
    const rest = url.pathname.slice(prefix.length + 1);
    const slug = rest.split("/")[0];
    if (isSiteSlug(slug)) {
      // With a separate sites origin, user content is never served from the app origin.
      if (c.sitesOrigin) return { kind: "redirect", location: `${c.sitesOrigin}/${rest}${url.search}`, status: 301, byReferer: false };
      if (rest === slug) return { kind: "redirect", location: `${prefix}/${slug}/${url.search}`, status: 301, byReferer: false };
      const base = `${prefix}/${slug}/`;
      return { kind: "site", slug, path: rest.slice(slug.length), mode: { kind: "path", base, sandbox: true, rewrite: { base, keep: [`${prefix}/`] } } };
    }
    return { kind: "app" };
  }
  if (!c.sitesOrigin && readOnly) {
    const ref = refererSlug(req, url, prefix);
    if (ref && (await siteHasPath(dw, ref, url.pathname, req, `${prefix}/${ref}/`))) {
      return { kind: "redirect", location: `${prefix}/${ref}${url.pathname}${url.search}`, status: 307, byReferer: true };
    }
  }
  return { kind: "app" };
}

/** Response for a redirect route. Referer-based redirects must never be cached (they depend on the Referer). */
export function redirectResponse(route: Extract<SiteRoute, { kind: "redirect" }>): Response {
  const h = new Headers({ Location: route.location, "Access-Control-Allow-Origin": "*" });
  if (route.byReferer) {
    h.set("Cache-Control", "no-store");
    h.set("Vary", "Referer");
    h.set("X-Kofra-Resolved-By", "referer");
  }
  // 308 = a legacy origin moved: not cached, so moving back works at once.
  if (route.status === 308) h.set("Cache-Control", "no-store");
  return new Response(null, { status: route.status, headers: h });
}
