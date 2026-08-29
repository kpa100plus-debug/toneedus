PRAGMA foreign_keys = ON;
DELETE FROM challenges WHERE id LIKE 'demo_ch_%';
DELETE FROM users WHERE id LIKE 'demo_%';

SELECT COUNT(*) AS remaining_demo_challenges
FROM challenges
WHERE id LIKE 'demo_ch_%';
