-- Raise the former default display limit for unrestricted accounts only.
UPDATE users SET bounty_limit = 100000000, updated_at = CURRENT_TIMESTAMP
WHERE bounty_limit = 1000000 AND status = 'active' AND strike_count = 0;
