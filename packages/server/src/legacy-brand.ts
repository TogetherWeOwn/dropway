/**
 * Compatibility with the product's former name (Dropway). rebrand:keep-file
 * (scripts/rebrand.mjs never edits this file: it has to spell the old names.)
 *
 * Clients built before the rename send X-Dropway-* request headers and read X-Dropway-*
 * response headers, and installed Agent Skills point at the skill named "dropway".
 * All of that keeps working: requests are read under both prefixes, responses carry both.
 */

/** Former Agent Skill name; its URLs still serve the skill. */
export const LEGACY_SKILL_NAME = "dropway";

const CURRENT = "x-kofra-";
const LEGACY = "x-dropway-";

/** A CORS header list plus the legacy spelling of every X-Kofra-* entry. */
export function withLegacyHeaderNames(names: readonly string[]): string[] {
  const legacy = names.filter((n) => n.toLowerCase().startsWith(CURRENT)).map((n) => `X-Dropway-${n.slice(CURRENT.length)}`);
  return [...names, ...legacy];
}

/** The request with X-Dropway-* copied to X-Kofra-* (a header sent under the new name wins). */
export function acceptLegacyRequestHeaders(request: Request): Request {
  let headers: Headers | null = null;
  for (const [name, value] of request.headers) {
    if (!name.startsWith(LEGACY)) continue;
    const current = CURRENT + name.slice(LEGACY.length);
    if (request.headers.has(current)) continue;
    (headers ??= new Headers(request.headers)).set(current, value);
  }
  return headers ? new Request(request, { headers }) : request;
}

/** The response with every X-Kofra-* header also sent as X-Dropway-*. */
export function addLegacyResponseHeaders(response: Response): Response {
  if (response.status === 101) return response;
  const extra: [string, string][] = [];
  for (const [name, value] of response.headers) {
    if (!name.startsWith(CURRENT)) continue;
    const legacy = LEGACY + name.slice(CURRENT.length);
    if (!response.headers.has(legacy)) extra.push([legacy, value]);
  }
  if (!extra.length) return response;
  let out = response;
  try {
    for (const [n, v] of extra) out.headers.set(n, v);
  } catch {
    // Immutable headers (a response passed through from fetch() or the cache): copy it.
    out = new Response(response.body, response);
    for (const [n, v] of extra) out.headers.set(n, v);
  }
  return out;
}
