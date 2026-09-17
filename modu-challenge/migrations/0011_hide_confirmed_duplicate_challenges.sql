-- Preserve records while removing only the confirmed later copies from public listings.
UPDATE challenges
SET visibility = 'private',
    submitted_visibility = 'private',
    updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  'chl_d2f07d2ecbb2434ca70885973b61cbff',
  'chl_ff7120453de240ff9556c68410880335'
)
  AND visibility = 'public'
  AND participant_count = 0
  AND teaser_count = 0;
