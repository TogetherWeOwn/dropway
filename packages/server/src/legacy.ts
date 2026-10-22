import type { DropwayContext } from "@dropway/core";

/**
 * Former app origins (config.legacyAppOrigins), for example the workers.dev hostname an
 * instance used before it moved to its own domain.
 *
 * Agents and scripts keep working there: the REST API, MCP, /health, /.well-known/* and the
 * agent documents are served as before, with `Deprecation` and `Link: rel="successor-version"`
 * headers naming the same URL on the new origin. They are never redirected, because HTTP
 * clients drop the Authorization header on a cross-origin redirect (a redirected agent would
 * get 401). Other GET/HEAD requests (pages, the dashboard, sign-in links) 308 to the new
 * origin with the path and query kept: browser sessions and same-origin checks belong there.
 */

/** Paths that keep answering on a legacy app origin. */
export function servedOnLegacyOrigin(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/health" ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/llms.txt" ||
    pathname === "/llms-full.txt" ||
    pathname === "/openapi.json" ||
    pathname === "/skill.md"
  );
}

/** The same URL on the current app origin, or null when `url` is not on a legacy app origin. */
export function legacyAppSuccessor(dw: DropwayContext, url: URL): string | null {
  const { appOrigin, legacyAppOrigins } = dw.config;
  if (!appOrigin || !legacyAppOrigins.includes(url.origin)) return null;
  return `${appOrigin}${url.pathname}${url.search}`;
}

/**
 * 308 for GET/HEAD outside the served paths; null = serve the request (then add the deprecation
 * headers). Not cached, so rolling the move back makes the old URLs work again at once.
 */
export function legacyAppRedirect(req: Request, url: URL, successor: string): Response | null {
  const method = req.method.toUpperCase();
  if (servedOnLegacyOrigin(url.pathname) || (method !== "GET" && method !== "HEAD")) return null;
  return new Response(null, { status: 308, headers: { Location: successor, "Cache-Control": "no-store" } });
}

/** Copy of `res` with the deprecation headers (RFC 9745) and the successor URL. */
export function withDeprecationHeaders(res: Response, dw: DropwayContext, successor: string): Response {
  const out = new Response(res.body, res);
  out.headers.set("Deprecation", `@${dw.config.legacyDeprecatedAt}`);
  out.headers.append("Link", `<${successor}>; rel="successor-version"`);
  if (out.headers.has("Access-Control-Allow-Origin")) {
    const expose = out.headers.get("Access-Control-Expose-Headers");
    out.headers.set("Access-Control-Expose-Headers", expose ? `${expose}, Deprecation, Link` : "Deprecation, Link");
  }
  return out;
}
