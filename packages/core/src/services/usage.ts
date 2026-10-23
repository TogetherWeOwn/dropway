import type { DropwayContext } from "../context";
import type { QuotaKey } from "../policy";
import { meter } from "./events";

export type UsageCounters = Partial<Record<QuotaKey, number>> & { sites: number; storage_bytes: number };

/** Ready history counts, not just the live version. A hash is charged once per tenant. */
export const STORAGE_USAGE_SQL = `SELECT COALESCE(SUM(size), 0) FROM (
  SELECT vf.sha256, MAX(COALESCE(b.size, vf.size)) AS size FROM sites s
    JOIN versions v ON v.site_id = s.id
    JOIN version_files vf ON vf.version_id = v.id
    LEFT JOIN blobs b ON b.sha256 = vf.sha256
   WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND v.status = 'ready'
   GROUP BY vf.sha256
)`;

/** Include a pending version or an anonymous site when checking a finalize/claim atomically. */
export const PROJECTED_STORAGE_SQL = `SELECT COALESCE(SUM(size), 0) FROM (
  SELECT vf.sha256, MAX(COALESCE(b.size, vf.size)) AS size FROM sites s
    JOIN versions v ON v.site_id = s.id
    JOIN version_files vf ON vf.version_id = v.id
    LEFT JOIN blobs b ON b.sha256 = vf.sha256
   WHERE (s.tenant_id = ? OR s.id = ?) AND s.deleted_at IS NULL
     AND (v.status = 'ready' OR v.id = ?)
   GROUP BY vf.sha256
)`;

/** Append to the lifecycle transaction, never do a read/modify/write counter increment. */
export function usageStatements(dc: DropwayContext, tenantId: string | null): D1PreparedStatement[] {
  if (tenantId === null) return [];
  const now = Date.now();
  return [
    dc.env.DB.prepare(`INSERT INTO usage_counters (tenant_id, key, value, updated_at)
      VALUES (?, 'sites', (SELECT COUNT(*) FROM sites WHERE tenant_id = ? AND deleted_at IS NULL), ?)
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(tenantId, tenantId, now),
    dc.env.DB.prepare(`INSERT INTO usage_counters (tenant_id, key, value, updated_at)
      VALUES (?, 'storage_bytes', (${STORAGE_USAGE_SQL}), ?)
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(tenantId, tenantId, now),
  ];
}

export async function getUsage(dc: DropwayContext, tenantId: string | null): Promise<UsageCounters> {
  const usage: UsageCounters = { sites: 0, storage_bytes: 0 };
  if (tenantId === null) return usage;
  const { results } = await dc.env.DB.prepare("SELECT key, value FROM usage_counters WHERE tenant_id = ?").bind(tenantId).all<{ key: QuotaKey; value: number }>();
  for (const row of results) usage[row.key] = row.value;
  return usage;
}

export async function recomputeUsage(dc: DropwayContext, tenantId: string): Promise<UsageCounters> {
  await dc.env.DB.batch(usageStatements(dc, tenantId));
  return getUsage(dc, tenantId);
}

/** Bytes absent from ready, active manifests, not from the upload-proof blob_scopes table. */
export async function incrementalBytes(dc: DropwayContext, tenantId: string | null, siteId: string | null, entries: readonly { sha256: string; size: number }[]): Promise<number> {
  const unique = [...new Map(entries.map((entry) => [entry.sha256, entry])).values()];
  let bytes = 0;
  for (let offset = 0; offset < unique.length; offset += 1000) {
    const chunk = unique.slice(offset, offset + 1000);
    const row = await dc.env.DB.prepare(`SELECT COALESCE(SUM(json_extract(j.value, '$.size')), 0) AS bytes
      FROM json_each(?) j WHERE NOT EXISTS (
        SELECT 1 FROM version_files vf JOIN versions v ON v.id = vf.version_id
          JOIN sites s ON s.id = v.site_id
         WHERE vf.sha256 = json_extract(j.value, '$.sha256') AND v.status = 'ready' AND s.deleted_at IS NULL
           AND ((? IS NOT NULL AND s.tenant_id = ?) OR (? IS NULL AND s.id = ? AND s.tenant_id IS NULL))
      )`).bind(JSON.stringify(chunk), tenantId, tenantId, tenantId, siteId).first<{ bytes: number }>();
    bytes += row?.bytes ?? 0;
  }
  return bytes;
}

export async function snapshotUsage(dc: DropwayContext): Promise<void> {
  // Keyset pages keep the nightly job bounded in memory for embedding applications.
  let cursor = "";
  for (;;) {
    const { results } = await dc.env.DB.prepare("SELECT id FROM tenants WHERE id > ? ORDER BY id LIMIT 100").bind(cursor).all<{ id: string }>();
    for (const tenant of results) {
      const usage = await recomputeUsage(dc, tenant.id);
      meter(dc, { type: "storage_snapshot", tenantId: tenant.id, bytes: usage.storage_bytes, at: Date.now() });
      cursor = tenant.id;
    }
    if (results.length < 100) return;
  }
}
