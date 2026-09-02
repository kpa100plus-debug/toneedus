-- Automatic pre-review retains the original submission but never deletes it.
ALTER TABLE challenges ADD COLUMN submitted_visibility TEXT;
ALTER TABLE challenges ADD COLUMN moderation_reasons_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE challenges ADD COLUMN moderation_reviewed_by TEXT;
ALTER TABLE challenges ADD COLUMN moderation_reviewed_at TEXT;

UPDATE challenges
SET submitted_visibility = visibility
WHERE submitted_visibility IS NULL;

CREATE INDEX IF NOT EXISTS idx_challenges_moderation_review
  ON challenges(status, created_at);
