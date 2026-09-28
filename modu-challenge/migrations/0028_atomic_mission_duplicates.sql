-- Existing missions are preserved. New and edited missions carry a canonical
-- fingerprint so concurrent requests are serialized at the database boundary.
ALTER TABLE challenges ADD COLUMN content_fingerprint TEXT;
CREATE INDEX idx_challenge_content_fingerprint ON challenges(content_fingerprint);

CREATE TRIGGER challenge_content_duplicate_insert
BEFORE INSERT ON challenges
WHEN NEW.content_fingerprint IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'DUPLICATE_MISSION') WHERE EXISTS (
    SELECT 1 FROM challenges c WHERE c.content_fingerprint = NEW.content_fingerprint
    AND ((c.visibility = 'public' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
      OR (c.owner_id = NEW.owner_id AND ((c.visibility = 'unlisted' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
        OR c.status = 'DRAFT'
        OR (c.status = 'REVIEW' AND c.moderation_decision = 'ADMIN_REVIEW' AND c.moderation_guidance_json LIKE '%"HIGH_VALUE_REVIEW"%'))))
  );
END;

CREATE TRIGGER challenge_content_duplicate_update
BEFORE UPDATE OF content_fingerprint ON challenges
WHEN NEW.content_fingerprint IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'DUPLICATE_MISSION') WHERE EXISTS (
    SELECT 1 FROM challenges c WHERE c.id <> NEW.id AND c.content_fingerprint = NEW.content_fingerprint
    AND ((c.visibility = 'public' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
      OR (c.owner_id = NEW.owner_id AND ((c.visibility = 'unlisted' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
        OR c.status = 'DRAFT'
        OR (c.status = 'REVIEW' AND c.moderation_decision = 'ADMIN_REVIEW' AND c.moderation_guidance_json LIKE '%"HIGH_VALUE_REVIEW"%'))))
  );
  SELECT RAISE(ABORT, 'CHALLENGE_EDIT_LOCKED')
    WHERE OLD.status NOT IN ('OPEN','REVIEW','DRAFT') OR OLD.teaser_count > 0 OR OLD.funding_status <> 'POSTED';
END;
