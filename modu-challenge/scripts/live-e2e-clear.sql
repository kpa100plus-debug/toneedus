PRAGMA foreign_keys = ON;

DELETE FROM challenges
WHERE owner_id IN (
  SELECT id FROM users WHERE email LIKE 'e2e-%@demo.invalid'
);

DELETE FROM users
WHERE email LIKE 'e2e-%@demo.invalid';

SELECT COUNT(*) AS remaining_e2e_users
FROM users
WHERE email LIKE 'e2e-%@demo.invalid';

SELECT COUNT(*) AS remaining_e2e_challenges
FROM challenges
WHERE title = 'E2E 자동 검수용 챌린지';
