-- Cover the bounded oldest-expiry candidates and remaining-backlog probes.
CREATE INDEX sessions_expiry ON sessions(expires_at, id_hash);
CREATE INDEX login_links_expiry ON login_links(expires_at, token_hash);
CREATE INDEX email_codes_expiry ON email_codes(expires_at, id);
