-- Keep previous missions untouched. New submissions and edits are serialized
-- against both exact content and the stable work/acceptance terms.
ALTER TABLE challenges ADD COLUMN core_fingerprint TEXT;
CREATE INDEX idx_challenge_core_fingerprint ON challenges(core_fingerprint);

CREATE TRIGGER challenge_core_duplicate_insert
BEFORE INSERT ON challenges
WHEN NEW.core_fingerprint IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'DUPLICATE_MISSION') WHERE EXISTS (
    SELECT 1 FROM challenges c WHERE c.core_fingerprint = NEW.core_fingerprint
      AND ((c.visibility = 'public' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
        OR (c.owner_id = NEW.owner_id AND (c.status = 'DRAFT'
          OR (c.visibility = 'unlisted' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
          OR (c.status = 'REVIEW' AND c.moderation_decision = 'ADMIN_REVIEW' AND c.moderation_guidance_json LIKE '%"HIGH_VALUE_REVIEW"%'))))
  );
END;

CREATE TRIGGER challenge_core_duplicate_update
BEFORE UPDATE OF core_fingerprint ON challenges
WHEN NEW.core_fingerprint IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'DUPLICATE_MISSION') WHERE EXISTS (
    SELECT 1 FROM challenges c WHERE c.id <> NEW.id AND c.core_fingerprint = NEW.core_fingerprint
      AND ((c.visibility = 'public' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
        OR (c.owner_id = NEW.owner_id AND (c.status = 'DRAFT'
          OR (c.visibility = 'unlisted' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
          OR (c.status = 'REVIEW' AND c.moderation_decision = 'ADMIN_REVIEW' AND c.moderation_guidance_json LIKE '%"HIGH_VALUE_REVIEW"%'))))
  );
END;
