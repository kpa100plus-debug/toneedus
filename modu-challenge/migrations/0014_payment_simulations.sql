-- Isolated virtual transactions. Never joined to real mission/reputation/settlement totals.
CREATE TABLE IF NOT EXISTS payment_simulations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_simulations_user ON payment_simulations(user_id, updated_at DESC);
