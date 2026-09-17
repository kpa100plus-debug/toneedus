CREATE TABLE IF NOT EXISTS challenge_create_requests (
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, idempotency_key),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_challenge_create_requests_created
  ON challenge_create_requests(created_at);
