-- Preserve every TEASER while enforcing one active candidate for missions that
-- are still in the candidate-selection stage. The most recently updated
-- SHORTLISTED row remains active; earlier rows return to the reviewed state.
INSERT INTO challenge_events (
  id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json
)
SELECT
  'evt_' || lower(hex(randomblob(16))),
  c.id,
  NULL,
  'SINGLE_CANDIDATE_MIGRATION',
  c.status,
  c.status,
  json_object('previousShortlistedCount', count(t.id), 'preserved', 1)
FROM challenges c
JOIN teasers t ON t.challenge_id = c.id AND t.status = 'SHORTLISTED'
WHERE c.status = 'SHORTLISTED'
GROUP BY c.id
HAVING count(t.id) > 1;

INSERT INTO audit_logs (
  id, actor_id, action, resource_type, resource_id, before_json, after_json
)
SELECT
  'aud_' || lower(hex(randomblob(16))),
  NULL,
  'SINGLE_CANDIDATE_MIGRATION',
  'challenge',
  c.id,
  json_object('shortlistedCount', count(t.id)),
  json_object('shortlistedCount', 1, 'teaserRowsPreserved', 1)
FROM challenges c
JOIN teasers t ON t.challenge_id = c.id AND t.status = 'SHORTLISTED'
WHERE c.status = 'SHORTLISTED'
GROUP BY c.id
HAVING count(t.id) > 1;

UPDATE teasers AS current
SET status = 'VIEWED',
    updated_at = CURRENT_TIMESTAMP
WHERE current.status = 'SHORTLISTED'
  AND EXISTS (
    SELECT 1
    FROM challenges c
    WHERE c.id = current.challenge_id
      AND c.status = 'SHORTLISTED'
  )
  AND EXISTS (
    SELECT 1
    FROM teasers newer
    WHERE newer.challenge_id = current.challenge_id
      AND newer.status = 'SHORTLISTED'
      AND (
        datetime(newer.updated_at) > datetime(current.updated_at)
        OR (datetime(newer.updated_at) = datetime(current.updated_at) AND newer.id > current.id)
      )
  );

UPDATE challenges
SET shortlisted_count = (
      SELECT count(*)
      FROM teasers
      WHERE teasers.challenge_id = challenges.id
        AND teasers.status IN ('SHORTLISTED', 'SELECTED')
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'SHORTLISTED';
