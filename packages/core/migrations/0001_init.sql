-- Dropway core schema. Times are unix epoch milliseconds.
--
-- Tenancy: every owned row carries tenant_id. The open-source build runs exactly
-- one tenant (created by POST /api/v1/setup). A hosted, multi-tenant layer can
-- create more tenants through the same tables without changing this schema.
-- Extensions must put their own tables in their own migrations (or their own
-- database) and must not alter these tables.

CREATE TABLE tenants (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  disabled_at  INTEGER
);

-- People (or agents) inside a tenant. external_ref lets an outer identity system
-- (SSO, a hosted user table) link its own user id to a member.
CREATE TABLE members (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT,
  name          TEXT,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  external_ref  TEXT,
  created_at    INTEGER NOT NULL,
  disabled_at   INTEGER
);
CREATE UNIQUE INDEX members_tenant_email ON members(tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX members_tenant ON members(tenant_id, created_at);
CREATE INDEX members_external_ref ON members(external_ref) WHERE external_ref IS NOT NULL;

-- Only a SHA-256 of each key is stored; the plaintext is shown once at creation.
-- scopes: space-separated (sites:read sites:write keys:write members:write).
-- site_id: optional restriction of the key to a single site.
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  member_id     TEXT NOT NULL REFERENCES members(id),
  name          TEXT,
  prefix        TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  scopes        TEXT NOT NULL,
  site_id       TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  expires_at    INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX api_keys_member ON api_keys(member_id);
CREATE INDEX api_keys_tenant ON api_keys(tenant_id);

CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX folders_tenant_name ON folders(tenant_id, name COLLATE NOCASE);

-- tenant_id is NULL for anonymous sites (which then have claim_token_hash and expires_at).
CREATE TABLE sites (
  id                      TEXT PRIMARY KEY,
  slug                    TEXT NOT NULL UNIQUE,
  tenant_id               TEXT REFERENCES tenants(id),
  created_by              TEXT,
  folder_id               TEXT REFERENCES folders(id),
  title                   TEXT,
  description             TEXT,
  spa                     INTEGER NOT NULL DEFAULT 0,
  render_markdown         INTEGER NOT NULL DEFAULT 1,
  cross_origin_isolation  INTEGER NOT NULL DEFAULT 0,
  password_hash           TEXT,
  current_version_id      TEXT,
  claim_token_hash        TEXT,
  creator_ip_hash         TEXT,
  expires_at              INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  deleted_at              INTEGER,
  deleted_slug            TEXT
);
CREATE INDEX sites_tenant ON sites(tenant_id, created_at);
CREATE INDEX sites_expires ON sites(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX sites_creator_ip ON sites(creator_ip_hash, created_at) WHERE creator_ip_hash IS NOT NULL;
CREATE INDEX sites_deleted ON sites(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX sites_claim ON sites(claim_token_hash) WHERE claim_token_hash IS NOT NULL;

-- A version is an immutable file manifest. status: pending (uploading) | ready (finalized).
-- The live version is sites.current_version_id; restore only moves that pointer.
-- manifest_hash: SHA-256 over the sorted (path, sha256, content type) list, used to
-- detect byte-identical republishes. base_version_id: optimistic concurrency check.
CREATE TABLE versions (
  id               TEXT PRIMARY KEY,
  site_id          TEXT NOT NULL REFERENCES sites(id),
  number           INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  file_count       INTEGER NOT NULL,
  total_bytes      INTEGER NOT NULL,
  manifest_hash    TEXT NOT NULL,
  base_version_id  TEXT,
  source           TEXT NOT NULL,
  client           TEXT,
  message          TEXT,
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  finalized_at     INTEGER
);
CREATE UNIQUE INDEX versions_site_number ON versions(site_id, number);
CREATE INDEX versions_status ON versions(status, created_at);

CREATE TABLE version_files (
  version_id    TEXT NOT NULL,
  path          TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  size          INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  PRIMARY KEY (version_id, path)
) WITHOUT ROWID;
CREATE INDEX version_files_sha ON version_files(sha256);

-- Content-addressed blobs stored once in R2 at blobs/<sha256>.
CREATE TABLE blobs (
  sha256      TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
) WITHOUT ROWID;

-- Which owner scope has proven it holds a blob ("t:<tenant id>" or "s:<anonymous site id>").
-- Deduplication is skipped only inside a scope, so one tenant can never learn
-- whether another tenant stored a given file.
CREATE TABLE blob_scopes (
  scope       TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (scope, sha256)
) WITHOUT ROWID;
CREATE INDEX blob_scopes_sha ON blob_scopes(sha256);
