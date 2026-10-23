-- Transfer state is read from D1 on every download, never from the live cache.
ALTER TABLE sites ADD COLUMN mode TEXT NOT NULL DEFAULT 'site' CHECK (mode IN ('site', 'transfer'));

CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  message TEXT,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL,
  download_limit INTEGER,
  downloads INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT,
  revoked_at INTEGER,
  expired_at INTEGER,
  deleted_at INTEGER,
  takedown_at INTEGER,
  takedown_reason TEXT,
  legal_hold INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER,
  purged_at INTEGER,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX transfers_expiry ON transfers(expires_at) WHERE expired_at IS NULL;
CREATE INDEX transfers_sender ON transfers(tenant_id, member_id);
CREATE INDEX transfers_slug ON transfers(slug);

CREATE TABLE transfer_files (
  transfer_id TEXT NOT NULL REFERENCES transfers(id),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (transfer_id, path)
) WITHOUT ROWID;

-- Deliberately no foreign keys: reservations survive both site and member deletion.
CREATE TABLE transfer_slug_tombstones (
  slug TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  member_id TEXT NOT NULL
) WITHOUT ROWID;

-- Database fences cover every site creation and rename surface, including races.
CREATE TRIGGER transfer_reserved_create BEFORE INSERT ON sites
WHEN EXISTS (SELECT 1 FROM transfer_slug_tombstones t WHERE t.slug = NEW.slug
  AND (t.tenant_id IS NOT NEW.tenant_id OR t.member_id IS NOT NEW.created_by))
BEGIN SELECT RAISE(ABORT, 'transfer_slug_reserved'); END;
CREATE TRIGGER transfer_reserved_rename BEFORE UPDATE OF slug ON sites
WHEN EXISTS (SELECT 1 FROM transfer_slug_tombstones t WHERE t.slug = NEW.slug
  AND (t.tenant_id IS NOT NEW.tenant_id OR t.member_id IS NOT NEW.created_by))
BEGIN SELECT RAISE(ABORT, 'transfer_slug_reserved'); END;
CREATE TRIGGER transfer_slug_record AFTER UPDATE OF slug ON sites
WHEN OLD.mode = 'transfer' AND NEW.deleted_at IS NULL
BEGIN
  INSERT OR IGNORE INTO transfer_slug_tombstones VALUES (NEW.slug, NEW.tenant_id, NEW.created_by);
  UPDATE transfers SET slug = NEW.slug, revision = revision + 1 WHERE site_id = NEW.id;
END;
CREATE TRIGGER transfer_site_deleted AFTER UPDATE OF deleted_at ON sites
WHEN NEW.mode = 'transfer' AND NEW.deleted_at IS NOT NULL
BEGIN UPDATE transfers SET deleted_at = NEW.deleted_at, revision = revision + 1 WHERE site_id = NEW.id; END;

CREATE TABLE transfer_unlock_buckets (
  bucket TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE usage_counters (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, key)
) WITHOUT ROWID;
CREATE TRIGGER transfer_storage_added AFTER INSERT ON transfers
BEGIN
  INSERT INTO usage_counters (tenant_id, key, value) VALUES (NEW.tenant_id, 'storage_bytes', NEW.storage_bytes)
  ON CONFLICT(tenant_id, key) DO UPDATE SET value = value + NEW.storage_bytes;
END;
CREATE TRIGGER transfer_storage_released AFTER UPDATE OF purged_at ON transfers
WHEN OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL
BEGIN UPDATE usage_counters SET value = MAX(0, value - OLD.storage_bytes)
  WHERE tenant_id = OLD.tenant_id AND key = 'storage_bytes'; END;
