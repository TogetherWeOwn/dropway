import type { DropwayContext } from "../context";
import { badRequest, conflict, notFound, type ApiError } from "../errors";
import { newId } from "../lib/crypto";
import { looksLikeSlug } from "../lib/slug";
import { requireMember, type Principal } from "../principal";

/**
 * R-59 link permanence: freed site names are held for their previous tenant
 * instead of becoming free at once.
 *
 * - Rename records a redirect: the old slug 308s to the site's current name
 *   (path and query kept) until the rename hold ends. Chains resolve through
 *   the site's current slug, so a->b->c redirects both a and b to c.
 * - Delete and expiry tombstone the freed name (plus every old name still
 *   redirecting to the site): only the holding tenant may reclaim it before
 *   the hold ends; everyone else gets 409 slug_reserved.
 * - An operator (admin scope) may release a hold early with a reason; the
 *   released tombstone row is the audit trail.
 *
 * The 0004 triggers refuse cross-tenant acquisition inside the write batch,
 * so races cannot hijack a held name; the SELECT pre-checks below exist only
 * to report precise errors (with the hold end date) in the common case.
 */

export type TombstoneReason = "rename" | "delete" | "expired";

export interface TombstoneInput {
  slug: string;
  tenantId: string | null;
  siteId: string;
  chosen: boolean;
  holdUntil: number;
  reason: TombstoneReason;
  createdAt: number;
}

/**
 * INSERT one tombstone row for a freed name. Never conflicts (no UNIQUE on
 * slug). The write lands only when the site's delete did (same batch, guarded
 * on the deleted_at the caller just set), so a refused delete holds nothing.
 */
export function insertTombstone(dc: DropwayContext, input: TombstoneInput & { deletedAt?: number }): D1PreparedStatement {
  const values = [newId("hold"), input.slug, input.tenantId, input.siteId, input.chosen ? 1 : 0, input.holdUntil, input.reason, input.createdAt];
  if (input.deletedAt === undefined) {
    return dc.env.DB.prepare(
      `INSERT INTO slug_tombstones (id, slug, tenant_id, site_id, chosen, hold_until, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...values);
  }
  return dc.env.DB.prepare(
    `INSERT INTO slug_tombstones (id, slug, tenant_id, site_id, chosen, hold_until, reason, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sites WHERE id = ? AND deleted_at = ?)`,
  ).bind(...values, input.siteId, input.deletedAt);
}

/**
 * Collapse every redirect still bound to a deleted/expired site into
 * tombstones (per-name chosen-ness preserved), then drop the redirect rows.
 * Pure SQL, so a rename racing the delete cannot leave a dangling redirect,
 * and guarded on the delete landing like insertTombstone.
 */
export function convertRedirectsStatements(
  dc: DropwayContext,
  input: { siteId: string; tenantId: string | null; reason: TombstoneReason; now: number; deletedAt: number },
): D1PreparedStatement[] {
  const chosenUntil = input.now + dc.config.slugHolds.chosenMs;
  const generatedUntil = input.now + dc.config.slugHolds.generatedMs;
  const landed = "EXISTS (SELECT 1 FROM sites WHERE id = ? AND deleted_at = ?)";
  return [
    dc.env.DB.prepare(
      `INSERT INTO slug_tombstones (id, slug, tenant_id, site_id, chosen, hold_until, reason, created_at)
       SELECT lower(hex(randomblob(16))), slug, ?, site_id, chosen,
         CASE WHEN chosen <> 0 THEN ? ELSE ? END, ?, ?
       FROM slug_redirects WHERE site_id = ? AND ${landed}`,
    ).bind(input.tenantId, chosenUntil, generatedUntil, input.reason, input.now, input.siteId, input.siteId, input.deletedAt),
    dc.env.DB.prepare(`DELETE FROM slug_redirects WHERE site_id = ? AND ${landed}`).bind(input.siteId, input.siteId, input.deletedAt),
  ];
}

/** Reclaim the caller's own hold as part of acquiring the name (same batch). */
export function reclaimTombstone(dc: DropwayContext, slug: string, tenantId: string): D1PreparedStatement {
  return dc.env.DB.prepare("DELETE FROM slug_tombstones WHERE slug = ? AND released_at IS NULL AND tenant_id IS ?").bind(slug, tenantId);
}

/** Rename-back: the site takes its own old name again, so its redirect row goes. */
export function collapseOwnRedirect(dc: DropwayContext, slug: string, siteId: string): D1PreparedStatement {
  return dc.env.DB.prepare("DELETE FROM slug_redirects WHERE slug = ? AND site_id = ?").bind(slug, siteId);
}

/** Record that an old name 308s to its site. Clears only expired rows first (active ones are never ours to drop). */
export function insertRedirect(
  dc: DropwayContext,
  input: { slug: string; siteId: string; chosen: boolean; holdUntil: number; createdAt: number },
): D1PreparedStatement[] {
  return [
    dc.env.DB.prepare("DELETE FROM slug_redirects WHERE slug = ? AND hold_until <= ?").bind(input.slug, input.createdAt),
    dc.env.DB.prepare("INSERT INTO slug_redirects (slug, site_id, chosen, hold_until, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      input.slug,
      input.siteId,
      input.chosen ? 1 : 0,
      input.holdUntil,
      input.createdAt,
    ),
  ];
}

/** Precise 409 for a held name; the trigger is the race backstop with a generic message. */
function heldError(slug: string, holdUntil: number, redirect: boolean): ApiError {
  const iso = new Date(holdUntil).toISOString();
  return redirect
    ? conflict(
        "slug_reserved",
        `The site name "${slug}" belongs to a renamed site and redirects until ${iso}.`,
        "Pick another name, or retry after the redirect ends.",
        { holdUntil: iso },
      )
    : conflict("slug_reserved", `The site name "${slug}" is held for its previous owner until ${iso}.`, "Pick another name, or retry after the hold ends. Only the tenant that held it may reclaim it before then.", {
        holdUntil: iso,
      });
}

/**
 * Throw 409 slug_reserved when `slug` is held against this acquirer. Pass the
 * renamer's site id on rename (same-site rename-back passes); null on create.
 * Same-tenant tombstones pass: the caller reclaims them in the same batch.
 */
export async function checkNameAvailable(dc: DropwayContext, slug: string, tenantId: string | null, siteId: string | null): Promise<void> {
  const now = Date.now();
  const tombstone = await dc.env.DB.prepare(
    "SELECT tenant_id, hold_until FROM slug_tombstones WHERE slug = ? AND released_at IS NULL AND hold_until > ? LIMIT 1",
  )
    .bind(slug, now)
    .first<{ tenant_id: string | null; hold_until: number }>();
  if (tombstone && (tenantId === null || tombstone.tenant_id !== tenantId)) throw heldError(slug, tombstone.hold_until, false);
  const redirect = await dc.env.DB.prepare("SELECT site_id, hold_until FROM slug_redirects WHERE slug = ? AND hold_until > ? LIMIT 1")
    .bind(slug, now)
    .first<{ site_id: string; hold_until: number }>();
  if (redirect && redirect.site_id !== siteId) throw heldError(slug, redirect.hold_until, true);
}

/** Serve-time: where does an old name redirect, if anywhere (active redirect + site still live)? */
export async function resolveSlugRedirect(dc: DropwayContext, slug: string): Promise<{ slug: string; until: number } | null> {
  const row = await dc.env.DB.prepare(
    `SELECT r.hold_until AS hold_until, s.slug AS current FROM slug_redirects r
     JOIN sites s ON s.id = r.site_id WHERE r.slug = ? AND r.hold_until > ? AND s.deleted_at IS NULL`,
  )
    .bind(slug, Date.now())
    .first<{ hold_until: number; current: string }>();
  return row ? { slug: row.current, until: row.hold_until } : null;
}

export type VersionAddress =
  | { kind: "preview" }
  | { kind: "gone" }
  | { kind: "absent" }
  | { kind: "redirect"; slug: string };

/**
 * Serve-time: what does `<base>--v<N>` mean? A version that existed and was
 * deleted is `gone` (410, never another site's bytes); a live version's
 * preview is R-13's to serve (stays 404 here); unknown names are `absent`.
 */
export async function resolveVersionAddress(dc: DropwayContext, baseSlug: string, num: number): Promise<VersionAddress> {
  const now = Date.now();
  const site = await dc.env.DB.prepare("SELECT id, current_version_id FROM sites WHERE slug = ? AND deleted_at IS NULL").bind(baseSlug).first<{ id: string; current_version_id: string | null }>();
  if (site) {
    const version = await dc.env.DB.prepare("SELECT 1 AS ok FROM versions WHERE site_id = ? AND number = ?").bind(site.id, num).first<{ ok: number }>();
    if (version) return { kind: "preview" };
    // Numbers are dense from 1 (MAX+1 at creation), so every number below the
    // live one existed: a missing number there was deleted (gone), while a
    // missing number at or above live never existed (absent).
    if (site.current_version_id) {
      const live = await dc.env.DB.prepare("SELECT number FROM versions WHERE id = ?").bind(site.current_version_id).first<{ number: number }>();
      if (live && num < live.number) return { kind: "gone" };
    }
    return { kind: "absent" };
  }
  const redirect = await resolveSlugRedirect(dc, baseSlug);
  if (redirect) return { kind: "redirect", slug: redirect.slug };
  const tombstone = await dc.env.DB.prepare("SELECT 1 AS ok FROM slug_tombstones WHERE slug = ? AND released_at IS NULL AND hold_until > ? LIMIT 1")
    .bind(baseSlug, now)
    .first<{ ok: number }>();
  return tombstone ? { kind: "gone" } : { kind: "absent" };
}

/** Hourly purge of expired, unreleased holds. Released rows are the audit trail and stay. */
export async function purgeExpiredHolds(dc: DropwayContext, now: number): Promise<{ tombstones: number; redirects: number }> {
  const [tombstones, redirects] = await dc.env.DB.batch([
    dc.env.DB.prepare("DELETE FROM slug_tombstones WHERE released_at IS NULL AND hold_until <= ? AND id IN (SELECT id FROM slug_tombstones WHERE released_at IS NULL AND hold_until <= ? LIMIT 500)").bind(now, now),
    dc.env.DB.prepare("DELETE FROM slug_redirects WHERE hold_until <= ? AND slug IN (SELECT slug FROM slug_redirects WHERE hold_until <= ? LIMIT 500)").bind(now, now),
  ]);
  return { tombstones: Number(tombstones?.meta.changes ?? 0), redirects: Number(redirects?.meta.changes ?? 0) };
}

/**
 * Operator action: release a hold before it ends (trademark disputes). The
 * stamped tombstone rows are the audit trail; when only a redirect existed, a
 * released tombstone row is written for it.
 */
export async function releaseSlug(dc: DropwayContext, p: Principal, slugInput: unknown, reasonInput: unknown) {
  const operator = requireMember(p, "admin");
  const slug = typeof slugInput === "string" ? slugInput.trim().toLowerCase() : "";
  if (!looksLikeSlug(slug)) throw badRequest("invalid_slug", `"${String(slugInput)}" is not a site name.`, "Release the held name exactly as freed (3-63 chars: lowercase letters, digits, single hyphens).");
  if (typeof reasonInput !== "string" || !reasonInput.trim()) {
    throw badRequest("reason_required", "Releasing a held name needs a reason (for example a trademark dispute reference).", 'Call again with reason: "Trademark dispute #...".');
  }
  // Reasons over 255 characters are cut on a code-point boundary (R-54 rule).
  const reason = [...reasonInput.trim()].slice(0, 255).join("");
  const now = Date.now();
  const held = await dc.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM slug_redirects WHERE slug = ? AND hold_until > ?) AS redirects,
            (SELECT COUNT(*) FROM slug_tombstones WHERE slug = ? AND released_at IS NULL AND hold_until > ?) AS holds`,
  )
    .bind(slug, now, slug, now)
    .first<{ redirects: number; holds: number }>();
  if (!held || (held.redirects === 0 && held.holds === 0)) {
    throw notFound("slug_not_held", `No hold on "${slug}" to release.`, "Held names are freed names waiting out their hold; live, expired and never-used names need no release.");
  }
  // One batch: the audit row for a redirect-only release is stamped at INSERT
  // (so the UPDATE below skips it), conditioned on the pre-batch state.
  const auditId = newId("hold");
  const [, dropped, stamped] = await dc.env.DB.batch([
    dc.env.DB.prepare(
      `INSERT INTO slug_tombstones (id, slug, tenant_id, site_id, chosen, hold_until, reason, created_at, released_at, release_reason, released_by)
       SELECT ?, ?, NULL, ?, 0, ?, 'rename', ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM slug_redirects WHERE slug = ?)
         AND NOT EXISTS (SELECT 1 FROM slug_tombstones WHERE slug = ? AND released_at IS NULL)`,
    ).bind(auditId, slug, `released:${slug}`, now, now, now, reason, operator.memberId, slug, slug),
    dc.env.DB.prepare("DELETE FROM slug_redirects WHERE slug = ?").bind(slug),
    dc.env.DB.prepare("UPDATE slug_tombstones SET released_at = ?, release_reason = ?, released_by = ? WHERE slug = ? AND released_at IS NULL").bind(
      now,
      reason,
      operator.memberId,
      slug,
    ),
  ]);
  const redirectsReleased = Number(dropped?.meta.changes ?? 0);
  const holdsReleased = Number(stamped?.meta.changes ?? 0);
  if (redirectsReleased === 0 && holdsReleased === 0) {
    throw notFound("slug_not_held", `No hold on "${slug}" to release.`, "Another operator may have released it just now.");
  }
  return { released: true as const, slug, redirectsReleased, holdsReleased, reason };
}
