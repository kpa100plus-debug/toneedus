-- Extend atomic duplicate protection to active private missions. Existing rows and hashes are preserved.
DROP TRIGGER IF EXISTS challenge_content_duplicate_insert;
DROP TRIGGER IF EXISTS challenge_content_duplicate_update;
CREATE TRIGGER challenge_content_duplicate_insert
BEFORE INSERT ON challenges
WHEN NEW.content_fingerprint IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'DUPLICATE_MISSION') WHERE EXISTS (
    SELECT 1 FROM challenges c WHERE c.content_fingerprint = NEW.content_fingerprint
    AND ((c.visibility = 'public' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
      OR (c.owner_id = NEW.owner_id AND ((c.visibility IN ('unlisted','private') AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
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
      OR (c.owner_id = NEW.owner_id AND ((c.visibility IN ('unlisted','private') AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
        OR c.status = 'DRAFT'
        OR (c.status = 'REVIEW' AND c.moderation_decision = 'ADMIN_REVIEW' AND c.moderation_guidance_json LIKE '%"HIGH_VALUE_REVIEW"%'))))
  );
  SELECT RAISE(ABORT, 'CHALLENGE_EDIT_LOCKED')
    WHERE OLD.status NOT IN ('OPEN','REVIEW','DRAFT') OR OLD.teaser_count > 0 OR OLD.funding_status <> 'POSTED';
END;

DROP TRIGGER IF EXISTS challenge_core_duplicate_insert;
DROP TRIGGER IF EXISTS challenge_core_duplicate_update;
CREATE TRIGGER challenge_core_duplicate_insert
BEFORE INSERT ON challenges
WHEN NEW.core_fingerprint IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'DUPLICATE_MISSION') WHERE EXISTS (
    SELECT 1 FROM challenges c WHERE c.core_fingerprint = NEW.core_fingerprint
      AND ((c.visibility = 'public' AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
        OR (c.owner_id = NEW.owner_id AND (c.status = 'DRAFT'
          OR (c.visibility IN ('unlisted','private') AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
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
          OR (c.visibility IN ('unlisted','private') AND c.status IN ('OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED'))
          OR (c.status = 'REVIEW' AND c.moderation_decision = 'ADMIN_REVIEW' AND c.moderation_guidance_json LIKE '%"HIGH_VALUE_REVIEW"%'))))
  );
END;

-- Compare substantive work for the same author, independent of title.
ALTER TABLE challenges ADD COLUMN work_fingerprint TEXT;
CREATE INDEX idx_challenge_work_fingerprint ON challenges(owner_id, work_fingerprint);
CREATE TRIGGER challenge_work_duplicate_insert BEFORE INSERT ON challenges
WHEN NEW.work_fingerprint IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'DUPLICATE_MISSION') WHERE EXISTS (
  SELECT 1 FROM challenges c WHERE c.owner_id=NEW.owner_id AND c.work_fingerprint=NEW.work_fingerprint
  AND c.status IN ('DRAFT','OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED')
 );
END;
CREATE TRIGGER challenge_work_duplicate_update BEFORE UPDATE OF work_fingerprint ON challenges
WHEN NEW.work_fingerprint IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'DUPLICATE_MISSION') WHERE EXISTS (
  SELECT 1 FROM challenges c WHERE c.id<>NEW.id AND c.owner_id=NEW.owner_id AND c.work_fingerprint=NEW.work_fingerprint
  AND c.status IN ('DRAFT','OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED','FUNDED','EXECUTING','PROOF_SUBMITTED','DISPUTED')
 );
END;
