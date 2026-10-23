/**
 * Compatibility with the product's former name (Dropway). rebrand:keep-file
 * (scripts/rebrand.mjs never edits this file: it has to spell the old names.)
 *
 * - DROPWAY_* environment variables still work; KOFRA_* wins when both are set.
 * - Instances deployed before the rename read X-Dropway-* headers only, so the CLI sends both
 *   spellings and reads either.
 */

/** Prefix of the request and response headers before the rename. */
export const LEGACY_HEADER_PREFIX = "X-Dropway-";

/** A copy of env where every DROPWAY_<NAME> also fills an unset or empty KOFRA_<NAME>. */
export function withLegacyEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("DROPWAY_") || value === undefined) continue;
    const current = `KOFRA_${name.slice("DROPWAY_".length)}`;
    if (!out[current]) out[current] = value;
  }
  return out;
}
