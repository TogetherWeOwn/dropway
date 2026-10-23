-- Existing write keys retain their old deletion permission; newly minted keys do not.
UPDATE api_keys SET scopes = scopes || ' sites:delete'
 WHERE (' ' || scopes || ' ') LIKE '% sites:write %'
   AND (' ' || scopes || ' ') NOT LIKE '% sites:delete %';

CREATE TABLE usage_counters (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  key         TEXT NOT NULL,
  value       INTEGER NOT NULL CHECK (value >= 0),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
) WITHOUT ROWID;

-- Backfill existing instances. Pending uploads and deleted sites do not consume storage.
INSERT INTO usage_counters (tenant_id, key, value, updated_at)
SELECT t.id, 'sites', COUNT(s.id), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM tenants t LEFT JOIN sites s ON s.tenant_id = t.id AND s.deleted_at IS NULL
 GROUP BY t.id;
INSERT INTO usage_counters (tenant_id, key, value, updated_at)
SELECT t.id, 'storage_bytes', COALESCE(SUM(f.size), 0), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM tenants t LEFT JOIN (
    SELECT s.tenant_id, vf.sha256, MAX(COALESCE(b.size, vf.size)) AS size FROM sites s
      JOIN versions v ON v.site_id = s.id AND v.status = 'ready'
      JOIN version_files vf ON vf.version_id = v.id
      LEFT JOIN blobs b ON b.sha256 = vf.sha256
     WHERE s.deleted_at IS NULL GROUP BY s.tenant_id, vf.sha256
  ) f ON f.tenant_id = t.id GROUP BY t.id;
