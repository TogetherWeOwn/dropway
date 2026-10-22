import { badRequest } from "../errors";
import { randomString } from "./crypto";

const ADJECTIVES = [
  "amber", "bold", "brave", "bright", "calm", "clever", "cosmic", "crisp", "dapper", "eager",
  "fancy", "fluent", "fresh", "gentle", "glad", "golden", "grand", "happy", "honest", "jolly",
  "keen", "kind", "lively", "lucky", "mellow", "merry", "mighty", "neat", "nimble", "noble",
  "plucky", "polite", "proud", "quick", "quiet", "rapid", "ready", "regal", "rosy", "rustic",
  "shiny", "silent", "silver", "sleek", "smart", "snappy", "solid", "spry", "steady", "sunny",
  "swift", "tidy", "trusty", "upbeat", "vivid", "warm", "wise", "witty", "zany", "zesty",
];

const NOUNS = [
  "anchor", "badger", "beacon", "breeze", "brook", "canyon", "cedar", "comet", "coral", "crane",
  "delta", "ember", "falcon", "fern", "fjord", "forest", "galaxy", "garnet", "glacier", "harbor",
  "heron", "island", "jasper", "kestrel", "lagoon", "lantern", "maple", "meadow", "mesa", "nebula",
  "orbit", "otter", "panda", "pebble", "pine", "planet", "prairie", "quartz", "raven", "reef",
  "river", "rocket", "sage", "sparrow", "spruce", "summit", "thistle", "tiger", "tulip", "valley",
  "vista", "walrus", "willow", "wombat", "yarrow", "zephyr", "acorn", "bison", "cobalt", "dune",
];

/**
 * Labels that can never become site names. Besides infrastructure names, this
 * includes common asset folder names: in path mode (sites under /<slug>/ on a
 * shared origin) a request for /assets/app.js must never be mistaken for a site
 * called "assets".
 */
export const RESERVED_SLUGS = new Set([
  "www", "api", "app", "admin", "mcp", "docs", "doc", "status", "mail", "email", "smtp", "dashboard",
  "dropway", "static", "assets", "asset", "cdn", "s", "auth", "login", "logout", "signup", "setup", "account", "accounts",
  "billing", "help", "support", "blog", "dev", "staging", "prod", "test", "root", "system", "security",
  "abuse", "postmaster", "hostmaster", "webmaster", "ns", "ns1", "ns2", "ftp", "localhost", "internal",
  "js", "css", "img", "imgs", "image", "images", "font", "fonts", "media", "public", "build", "dist", "src",
  "lib", "libs", "vendor", "scripts", "script", "styles", "style", "icons", "icon", "data", "files", "file",
  "_next", "_astro", "_app", "well-known", "node_modules", "favicon", "robots", "sitemap", "health", "openapi",
  "llms", "claim", "members", "keys", "sites", "blobs", "publish", "raw", "view", "download",
]);

export function generateSlug(): string {
  const pick = (list: string[]) => list[crypto.getRandomValues(new Uint32Array(1))[0]! % list.length]!;
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomString(4)}`;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

/** True for strings shaped like a site name (DNS label, 3-63 chars). Does not check reservations. */
export function looksLikeSlug(s: string): boolean {
  return SLUG_RE.test(s) && !s.includes("--");
}

/** Validate a caller-chosen slug. Slugs are DNS labels: they may become <slug>.<SITES_DOMAIN>. */
export function validateSlug(input: string): string {
  const slug = String(input).trim().toLowerCase();
  if (!looksLikeSlug(slug)) {
    throw badRequest(
      "invalid_slug",
      `"${input}" is not a valid site name.`,
      "Use 3-63 characters: lowercase letters, digits and single hyphens, starting and ending with a letter or digit.",
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw badRequest("slug_reserved", `"${slug}" is reserved.`, "Pick another name, or omit slug to get a generated one.");
  }
  return slug;
}
