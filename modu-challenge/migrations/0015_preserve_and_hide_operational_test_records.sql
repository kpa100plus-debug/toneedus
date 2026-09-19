-- Preserve all linked data while removing confirmed test/expired items from public discovery.
UPDATE challenges
SET visibility = 'private',
    submitted_visibility = 'private',
    updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  'chl_349a062953cb4ca4a3c49d0597446ded',
  'chl_11e4bea805a54b93b2aa0377a16e8b5a'
)
  AND visibility = 'public';

-- Collapse only exact, empty moderation duplicates from the same owner. The earlier
-- record remains in REVIEW; later copies are preserved as private rejected records.
UPDATE challenges
SET status = 'DRAFT',
    visibility = 'private',
    submitted_visibility = 'private',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'REVIEW'
  AND visibility = 'private'
  AND participant_count = 0
  AND teaser_count = 0
  AND EXISTS (
    SELECT 1
    FROM challenges original
    WHERE original.id <> challenges.id
      AND original.owner_id = challenges.owner_id
      AND original.status = 'REVIEW'
      AND original.visibility = 'private'
      AND original.participant_count = 0
      AND original.teaser_count = 0
      AND lower(trim(original.title)) = lower(trim(challenges.title))
      AND trim(original.summary) = trim(challenges.summary)
      AND trim(original.description) = trim(challenges.description)
      AND original.reward_amount = challenges.reward_amount
      AND (
        datetime(original.created_at) < datetime(challenges.created_at)
        OR (datetime(original.created_at) = datetime(challenges.created_at) AND original.id < challenges.id)
      )
  );
