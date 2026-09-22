-- V0.9.0: member-scoped verification, activity roles, explainable trust and
-- three-way automated moderation. Existing rows are preserved and backfilled.
ALTER TABLE challenges ADD COLUMN moderation_action TEXT NOT NULL DEFAULT 'AUTO_APPROVED'
  CHECK (moderation_action IN ('AUTO_APPROVED','CHANGES_REQUIRED','AUTO_REJECTED','ADMIN_OVERRIDE'));
ALTER TABLE challenges ADD COLUMN moderation_policy_version TEXT NOT NULL DEFAULT '2026-09-22-v2';
ALTER TABLE challenges ADD COLUMN moderation_guidance_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE challenges ADD COLUMN owner_subject_type TEXT NOT NULL DEFAULT 'individual'
  CHECK (owner_subject_type IN ('individual','business','corporation','organization'));
ALTER TABLE challenges ADD COLUMN owner_actor_profile_id TEXT;
ALTER TABLE challenges ADD COLUMN owner_verification_snapshot_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE teasers ADD COLUMN solver_subject_type TEXT NOT NULL DEFAULT 'individual'
  CHECK (solver_subject_type IN ('individual','business','corporation','organization'));
ALTER TABLE teasers ADD COLUMN solver_actor_profile_id TEXT;
ALTER TABLE teasers ADD COLUMN solver_verification_snapshot_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS member_actor_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('individual','business','corporation','organization')),
  activity_name TEXT,
  organization_name TEXT,
  industry TEXT,
  company_intro TEXT,
  public_fields_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, subject_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_actor_profiles_user ON member_actor_profiles(user_id, subject_type);

CREATE TABLE IF NOT EXISTS member_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  verification_type TEXT NOT NULL CHECK (verification_type IN ('IDENTITY','BUSINESS','CORPORATION','ORGANIZATION')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('individual','business','corporation','organization')),
  status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('UNVERIFIED','REQUESTED','PENDING','VERIFIED','REJECTED','EXPIRED','REVOKED','PROVIDER_REQUIRED')),
  provider TEXT,
  provider_reference_hash TEXT,
  subject_name TEXT,
  private_metadata_json TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  status_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, verification_type, subject_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_member_verifications_user ON member_verifications(user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS activity_qualifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  activity_role TEXT NOT NULL CHECK (activity_role IN ('OWNER','SOLVER')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('individual','business','corporation','organization')),
  actor_profile_id TEXT,
  challenge_id TEXT,
  teaser_id TEXT,
  verification_snapshot_json TEXT NOT NULL DEFAULT '{}',
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_profile_id) REFERENCES member_actor_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
  FOREIGN KEY (teaser_id) REFERENCES teasers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activity_qualifications_user ON activity_qualifications(user_id, activity_role, applied_at DESC);

CREATE TABLE IF NOT EXISTS trust_policy_versions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  starts_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS trust_policy_items (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  weight REAL,
  config_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(policy_id, item_key),
  FOREIGN KEY (policy_id) REFERENCES trust_policy_versions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS trust_evidence (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  activity_role TEXT CHECK (activity_role IN ('OWNER','SOLVER')),
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT '{}',
  source_type TEXT,
  source_id TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trust_evidence_user ON trust_evidence(user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS moderation_appeals (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEWING','UPHELD','OVERRIDDEN','CLOSED')),
  reason TEXT NOT NULL,
  resolution TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_status ON moderation_appeals(status, created_at);

UPDATE challenges SET moderation_action = CASE
  WHEN moderation_decision = 'ARCHIVED' THEN 'AUTO_REJECTED'
  WHEN moderation_decision = 'ADMIN_REVIEW' THEN 'CHANGES_REQUIRED'
  WHEN moderation_decision = 'ADMIN_APPROVED' THEN 'ADMIN_OVERRIDE'
  ELSE 'AUTO_APPROVED' END;

INSERT OR IGNORE INTO member_actor_profiles (id, user_id, subject_type, activity_name, organization_name, public_fields_json)
SELECT 'act_' || id || '_' || account_type, id, account_type, display_name, organization_name,
       '{"activityName":true,"verificationBadges":true,"activityHistory":true,"ratings":true}'
FROM users;

INSERT OR IGNORE INTO member_verifications (id, user_id, verification_type, subject_type, status, provider, verified_at, status_reason)
SELECT 'ver_' || id || '_identity', id, 'IDENTITY', account_type, 'VERIFIED', 'legacy', created_at, '기존 인증 데이터 보존'
FROM users WHERE identity_verified = 1;
INSERT OR IGNORE INTO member_verifications (id, user_id, verification_type, subject_type, status, provider, verified_at, status_reason)
SELECT 'ver_' || id || '_business', id, 'BUSINESS', account_type, 'VERIFIED', 'legacy', created_at, '기존 인증 데이터 보존'
FROM users WHERE business_verified = 1;

INSERT OR IGNORE INTO trust_policy_versions (id, version, status) VALUES ('trp_20260922_draft', '2026-09-22-draft', 'DRAFT');
INSERT OR IGNORE INTO trust_policy_items (id, policy_id, item_key, label, enabled, weight) VALUES
 ('tri_identity', 'trp_20260922_draft', 'IDENTITY_VERIFICATION', '본인확인', 1, NULL),
 ('tri_business', 'trp_20260922_draft', 'BUSINESS_VERIFICATION', '사업자·법인·단체 확인', 1, NULL),
 ('tri_owner', 'trp_20260922_draft', 'OWNER_ACTIVITY', '미션 등록·완료 이력', 1, NULL),
 ('tri_solver', 'trp_20260922_draft', 'SOLVER_ACTIVITY', '참여·수행·완료 이력', 1, NULL),
 ('tri_review', 'trp_20260922_draft', 'REVIEWS', '양방향 이용자 평가', 1, NULL),
 ('tri_dispute', 'trp_20260922_draft', 'DISPUTES_STRIKES', '분쟁·신고·제재 이력', 1, NULL);

CREATE INDEX IF NOT EXISTS idx_challenges_moderation_action
  ON challenges(moderation_action, moderation_auto_reviewed_at, created_at);
