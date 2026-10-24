import type { AtomicWriteExtension } from "../adapters";
import type { DropwayContext } from "../context";
import { conflict, type ApiError } from "../errors";

/** Only SQL errors reach the mappers; preparation errors keep their identity. */
export async function atomicWrite(
  dc: DropwayContext,
  core: readonly D1PreparedStatement[],
  extension?: AtomicWriteExtension,
  mapCoreError?: (error: unknown) => ApiError | undefined,
): Promise<void> {
  try {
    await dc.env.DB.batch([...core, ...(extension?.statements ?? [])]);
  } catch (error) {
    throw mapCoreError?.(error) ?? extension?.mapError?.(error) ?? error;
  }
}

/** Do not confuse another table's UNIQUE constraint with a site-name collision. */
export function siteSlugError(error: unknown, slug: string, hint: string): ApiError | undefined {
  if (/\bUNIQUE constraint failed: sites\.slug(?=:|$)/.test(String(error)) || /\btransfer_slug_reserved(?=:|$)/.test(String(error))) {
    return conflict("slug_taken", `The site name "${slug}" is taken.`, hint);
  }
  // Race backstop for R-59 holds (the common case already got a precise error
  // from checkNameAvailable before the batch ran).
  if (/\bslug_name_held(?=:|$)/.test(String(error)) || /\bslug_name_redirect(?=:|$)/.test(String(error))) {
    return conflict("slug_reserved", `The site name "${slug}" is held for its previous owner.`, hint);
  }
  return undefined;
}
