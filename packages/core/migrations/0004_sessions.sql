CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  via TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  ip_hash TEXT,
  user_agent TEXT,
  revoked_at INTEGER
);
CREATE INDEX sessions_member ON sessions(member_id);

CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE email_codes (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('sign_in', 'site_access')),
  email TEXT NOT NULL,
  site_id TEXT,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX email_codes_lookup ON email_codes(email, purpose, created_at);
ALTER TABLE members ADD COLUMN last_seen_at INTEGER;
