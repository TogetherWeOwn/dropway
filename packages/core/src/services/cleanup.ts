import type { DropwayContext } from "../context";
import { siteUrl } from "../context";
import { blobKey } from "./blobs";
import { emit, meter } from "./events";
import { dropLive } from "./live";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface CleanupReport {
  expiredSites: number;
  purgedSites: number;
  abandonedDeploys: number;
  deletedBlobs: number;
  expiredSessions: number;
  expiredLoginLinks: number;
  expiredEmailCodes: number;
  /** Eligible rows remaining after this invocation, not merely a full batch. */
  authBacklog: { sessions: boolean; loginLinks: boolean; emailCodes: boolean };
}

/**
 * Hourly housekeeping (Worker cron):
 * 0. purge expired auth rows (at most 200 per table, oldest expiry first);
 * 1. expire anonymous sites past expires_at (soft delete, slug freed);
 * 2. purge rows of sites deleted more than an hour ago;
 * 3. drop pending deploys older than a day;
 * 4. delete blobs no version references any more (older than a day).
 * Each step is bounded so one run stays well inside Worker limits.
 */
export async function runCleanup(dc: DropwayContext, now = Date.now()): Promise<CleanupReport> {
  const report: CleanupReport = {
    expiredSites: 0, purgedSites: 0, abandonedDeploys: 0, deletedBlobs: 0,
    expiredSessions: 0, expiredLoginLinks: 0, expiredEmailCodes: 0,
    authBacklog: { sessions: false, loginLinks: false, emailCodes: false },
  };
  const db = dc.env.DB;

  // Auth runs first so unrelated storage failures cannot starve metadata expiry.
  // Expiry alone determines eligibility: used/revoked/exhausted live rows still
  // carry security budgets. Select and recheck in one statement, never a stale ID list.
  const [sessions, links, codes] = await db.batch([
    db.prepare(`DELETE FROM sessions WHERE expires_at <= ? AND id_hash IN (
      SELECT id_hash FROM sessions WHERE expires_at <= ? ORDER BY expires_at, id_hash LIMIT 200
    )`).bind(now, now),
    db.prepare(`DELETE FROM login_links WHERE expires_at <= ? AND token_hash IN (
      SELECT token_hash FROM login_links WHERE expires_at <= ? ORDER BY expires_at, token_hash LIMIT 200
    )`).bind(now, now),
    db.prepare(`DELETE FROM email_codes WHERE expires_at <= ? AND id IN (
      SELECT id FROM email_codes WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 200
    )`).bind(now, now),
  ]);
  report.expiredSessions = sessions!.meta.changes;
  report.expiredLoginLinks = links!.meta.changes;
  report.expiredEmailCodes = codes!.meta.changes;
  const backlog = await db.prepare(`SELECT
    EXISTS (SELECT 1 FROM sessions WHERE expires_at <= ?) AS sessions,
    EXISTS (SELECT 1 FROM login_links WHERE expires_at <= ?) AS loginLinks,
    EXISTS (SELECT 1 FROM email_codes WHERE expires_at <= ?) AS emailCodes
  `).bind(now, now, now).first<{ sessions: number; loginLinks: number; emailCodes: number }>();
  report.authBacklog = {
    sessions: !!backlog!.sessions, loginLinks: !!backlog!.loginLinks, emailCodes: !!backlog!.emailCodes,
  };

  // 1. Expire anonymous sites.
  const { results: expired } = await db
    .prepare("SELECT id, slug, tenant_id FROM sites WHERE expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL LIMIT 200")
    .bind(now)
    .all<{ id: string; slug: string; tenant_id: string | null }>();
  for (const s of expired) {
    await db
      .prepare("UPDATE sites SET deleted_at = ?, deleted_slug = slug, slug = ?, claim_token_hash = NULL WHERE id = ? AND deleted_at IS NULL")
      .bind(now, `~deleted~${s.id}`, s.id)
      .run();
    await dropLive(dc, s.slug);
    emit(dc, "onDelete", { site: { id: s.id, slug: s.slug, tenantId: s.tenant_id, url: siteUrl(dc, s.slug) }, principal: null, reason: "expired", at: now });
    meter(dc, { type: "site_deleted", tenantId: s.tenant_id, siteId: s.id, at: now });
    report.expiredSites++;
  }

  // 2. Purge deleted sites (rows only; their blobs become orphans for step 4).
  const { results: gone } = await db
    .prepare("SELECT id FROM sites WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 50")
    .bind(now - HOUR)
    .all<{ id: string }>();
  for (const s of gone) {
    await db.batch([
      db.prepare("DELETE FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE site_id = ?)").bind(s.id),
      db.prepare("DELETE FROM versions WHERE site_id = ?").bind(s.id),
      db.prepare("DELETE FROM blob_scopes WHERE scope = ?").bind(`s:${s.id}`),
      db.prepare("DELETE FROM sites WHERE id = ?").bind(s.id),
    ]);
    report.purgedSites++;
  }

  // 3. Abandoned uploads.
  const { results: stale } = await db
    .prepare("SELECT id FROM versions WHERE status = 'pending' AND created_at < ? LIMIT 200")
    .bind(now - DAY)
    .all<{ id: string }>();
  for (const v of stale) {
    await db.batch([
      db.prepare("DELETE FROM version_files WHERE version_id = ?").bind(v.id),
      db.prepare("DELETE FROM versions WHERE id = ? AND status = 'pending'").bind(v.id),
    ]);
    report.abandonedDeploys++;
  }

  // 4. Unreferenced blobs. The row is deleted only if still unreferenced at that instant;
  // only then is the R2 object removed. (Known gap: a re-upload of the same bytes in the
  // milliseconds between those two steps would be lost; the next finalize reports it missing.)
  const { results: orphans } = await db
    .prepare(
      `SELECT b.sha256 FROM blobs b
        WHERE b.created_at < ? AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.sha256 = b.sha256)
        LIMIT 500`,
    )
    .bind(now - DAY)
    .all<{ sha256: string }>();
  for (const b of orphans) {
    const [del] = await db.batch([
      db.prepare("DELETE FROM blobs WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM version_files WHERE sha256 = ?)").bind(b.sha256, b.sha256),
      db.prepare("DELETE FROM blob_scopes WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?)").bind(b.sha256, b.sha256),
    ]);
    if (del?.meta.changes) {
      await dc.env.FILES.delete(blobKey(b.sha256));
      report.deletedBlobs++;
    }
  }
  if (report.expiredSites || report.purgedSites || report.abandonedDeploys || report.deletedBlobs ||
      report.expiredSessions || report.expiredLoginLinks || report.expiredEmailCodes || Object.values(report.authBacklog).some(Boolean)) {
    console.log(JSON.stringify({ event: "cleanup", ...report }));
  }
  return report;
}
