-- Preserve historical social identities while revoking credentials created
-- before mailbox ownership was established. Re-running this DDL is safe.
CREATE TABLE IF NOT EXISTS auth_identity_restrictions (
  identity_id TEXT PRIMARY KEY REFERENCES auth_identities(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleared_at TEXT
);
