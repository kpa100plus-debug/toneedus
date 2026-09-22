-- Persist every automated moderation decision so safe publications and
-- administrator-review queues are both explainable and auditable.
ALTER TABLE challenges ADD COLUMN moderation_decision TEXT NOT NULL DEFAULT 'AUTO_APPROVED'
  CHECK (moderation_decision IN ('AUTO_APPROVED','ADMIN_REVIEW','ADMIN_APPROVED','ARCHIVED'));
ALTER TABLE challenges ADD COLUMN moderation_risk_score INTEGER NOT NULL DEFAULT 0
  CHECK (moderation_risk_score BETWEEN 0 AND 100);
ALTER TABLE challenges ADD COLUMN moderation_auto_reviewed_at TEXT;

UPDATE challenges
SET moderation_decision = CASE
      WHEN status = 'REVIEW' AND moderation_reasons_json <> '[]' THEN 'ADMIN_REVIEW'
      WHEN moderation_reviewed_at IS NOT NULL AND status = 'OPEN' THEN 'ADMIN_APPROVED'
      WHEN moderation_reviewed_at IS NOT NULL AND status = 'DRAFT' THEN 'ARCHIVED'
      ELSE 'AUTO_APPROVED'
    END,
    moderation_risk_score = CASE
      WHEN status = 'REVIEW' AND moderation_reasons_json <> '[]' THEN 25
      ELSE 0
    END;

CREATE INDEX IF NOT EXISTS idx_challenges_moderation_decision
  ON challenges(moderation_decision, status, created_at);
