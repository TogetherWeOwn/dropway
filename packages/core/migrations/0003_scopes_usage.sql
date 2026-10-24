-- Existing write keys retain their old deletion permission; newly minted keys do not.
UPDATE api_keys SET scopes = scopes || ' sites:delete'
 WHERE (' ' || scopes || ' ') LIKE '% sites:write %'
   AND (' ' || scopes || ' ') NOT LIKE '% sites:delete %';

-- The transfer migration already owns this table and its retention triggers.
ALTER TABLE usage_counters ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- Backfill existing instances. Transfers retain their separate charge until purge,
-- including deleted or held deliveries; ordinary sites count unique ready hashes.
INSERT INTO usage_counters (tenant_id, key, value, updated_at)
SELECT t.id, 'sites', COUNT(s.id), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM tenants t LEFT JOIN sites s ON s.tenant_id = t.id AND s.deleted_at IS NULL
 GROUP BY t.id
 ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
INSERT INTO usage_counters (tenant_id, key, value, updated_at)
SELECT t.id, 'storage_bytes', COALESCE(SUM(f.size), 0) +
    (SELECT COALESCE(SUM(storage_bytes), 0) FROM transfers WHERE tenant_id = t.id AND purged_at IS NULL),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM tenants t LEFT JOIN (
    SELECT s.tenant_id, vf.sha256, MAX(COALESCE(b.size, vf.size)) AS size FROM sites s
      JOIN versions v ON v.site_id = s.id AND v.status = 'ready'
      JOIN version_files vf ON vf.version_id = v.id
      LEFT JOIN blobs b ON b.sha256 = vf.sha256
     WHERE s.deleted_at IS NULL AND s.mode <> 'transfer' GROUP BY s.tenant_id, vf.sha256
  ) f ON f.tenant_id = t.id GROUP BY t.id
 ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
