PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'individual' CHECK (account_type IN ('individual','business','corporation','organization')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','limited','suspended','closed')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  identity_verified INTEGER NOT NULL DEFAULT 0,
  business_verified INTEGER NOT NULL DEFAULT 0,
  professional_verified INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  terms_version TEXT,
  terms_accepted_at TEXT,
  privacy_version TEXT,
  privacy_accepted_at TEXT,
  trust_score INTEGER NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  strike_count INTEGER NOT NULL DEFAULT 0 CHECK (strike_count BETWEEN 0 AND 3),
  bounty_limit INTEGER NOT NULL DEFAULT 1000000,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_hash TEXT,
  user_agent_hash TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('LOGIN','SIGNUP')),
  ip_hash TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_window
  ON auth_attempts(action, ip_hash, email_hash, success, created_at);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('CONNECT','FIND','IDEA','BUSINESS','ACTION','LOCAL','SOCIAL','PUBLIC')),
  region TEXT,
  reward_amount INTEGER NOT NULL CHECK (reward_amount > 0),
  fee_rate REAL NOT NULL DEFAULT 0.10,
  success_criteria TEXT NOT NULL,
  payment_trigger TEXT NOT NULL,
  evidence_requirements TEXT NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('DRAFT','OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','SUCCESS','FAILED','CANCELLED','DISPUTED')),
  funding_status TEXT NOT NULL DEFAULT 'POSTED' CHECK (funding_status IN ('POSTED','PAYMENT_REQUIRED','FUNDED','PAID','REFUNDED','FAILED')),
  selected_solver_id TEXT,
  payment_due_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','private')),
  participant_count INTEGER NOT NULL DEFAULT 0,
  teaser_count INTEGER NOT NULL DEFAULT 0,
  shortlisted_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (selected_solver_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_category ON challenges(category);
CREATE INDEX IF NOT EXISTS idx_challenges_owner ON challenges(owner_id);
CREATE INDEX IF NOT EXISTS idx_challenges_created ON challenges(created_at DESC);

CREATE TABLE IF NOT EXISTS teasers (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  solver_id TEXT NOT NULL,
  headline TEXT NOT NULL,
  capability TEXT NOT NULL,
  approach TEXT NOT NULL,
  expected_days INTEGER NOT NULL CHECK (expected_days > 0),
  masked_evidence TEXT,
  qualification_type TEXT,
  qualification_ref TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','VIEWED','SHORTLISTED','REJECTED','WITHDRAWN','SELECTED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(challenge_id, solver_id),
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
  FOREIGN KEY (solver_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_teasers_challenge ON teasers(challenge_id);
CREATE INDEX IF NOT EXISTS idx_teasers_solver ON teasers(solver_id);

CREATE TABLE IF NOT EXISTS challenge_events (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_events_challenge ON challenge_events(challenge_id, created_at);

CREATE TABLE IF NOT EXISTS proofs (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  solver_id TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_url TEXT,
  evidence_hash TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ACCEPTED','REJECTED','DISPUTED')),
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
  FOREIGN KEY (solver_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_proofs_challenge ON proofs(challenge_id);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  solver_id TEXT NOT NULL,
  gross_reward INTEGER NOT NULL,
  fee_rate REAL NOT NULL,
  platform_fee INTEGER NOT NULL,
  solver_payout INTEGER NOT NULL,
  tax_withholding INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  provider_reference TEXT,
  payout_provider TEXT,
  payout_reference TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AUTHORIZED','FUNDED','PROCESSING','PAID','FAILED','REFUNDED','DISPUTED')),
  funded_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (solver_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewee_id TEXT NOT NULL,
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('OWNER','SOLVER')),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  accuracy INTEGER CHECK (accuracy BETWEEN 1 AND 5),
  responsiveness INTEGER CHECK (responsiveness BETWEEN 1 AND 5),
  reliability INTEGER CHECK (reliability BETWEEN 1 AND 5),
  would_work_again INTEGER NOT NULL DEFAULT 1,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(challenge_id, reviewer_id, reviewee_id),
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewee_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);

CREATE TABLE IF NOT EXISTS strikes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  challenge_id TEXT,
  strike_level INTEGER NOT NULL CHECK (strike_level BETWEEN 1 AND 3),
  reason_code TEXT NOT NULL,
  reason_detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','APPEALED','REVOKED','EXPIRED')),
  issued_by TEXT,
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE SET NULL,
  FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_strikes_user ON strikes(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_strikes_funding_failure_once
  ON strikes(challenge_id, reason_code)
  WHERE challenge_id IS NOT NULL AND reason_code = 'FUNDING_FAILURE' AND status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  respondent_id TEXT,
  reason_code TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','EVIDENCE','MEDIATION','DECIDED','CLOSED')),
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
  FOREIGN KEY (opened_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (respondent_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_provider_reference
  ON settlements(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_payout_reference
  ON settlements(payout_provider, payout_reference)
  WHERE payout_reference IS NOT NULL;
