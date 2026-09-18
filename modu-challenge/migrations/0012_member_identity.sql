-- Preserve historical accounts, including any legacy duplicate values.
ALTER TABLE users ADD COLUMN real_name TEXT;
CREATE INDEX IF NOT EXISTS idx_users_display_lookup ON users(lower(trim(display_name)));
CREATE INDEX IF NOT EXISTS idx_users_phone_lookup ON users((CASE WHEN replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', '') LIKE '82%' THEN '0' || substr(replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', ''), 3) ELSE replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', '') END));
CREATE TRIGGER IF NOT EXISTS users_unique_signup BEFORE INSERT ON users BEGIN
 SELECT RAISE(ABORT, 'MODU_DISPLAY_NAME_EXISTS') WHERE EXISTS(SELECT 1 FROM users WHERE lower(trim(display_name)) = lower(trim(NEW.display_name)));
 SELECT RAISE(ABORT, 'MODU_PHONE_EXISTS') WHERE NEW.phone IS NOT NULL AND NEW.phone != '' AND EXISTS(SELECT 1 FROM users WHERE (CASE WHEN replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', '') LIKE '82%' THEN '0' || substr(replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', ''), 3) ELSE replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', '') END) = NEW.phone);
END;

ALTER TABLE oauth_authorizations ADD COLUMN return_route TEXT;
CREATE TABLE oauth_signup_pending (
 token_hash TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('google','naver')),
 subject TEXT NOT NULL, email TEXT NOT NULL, display_name TEXT NOT NULL,
 expires_at TEXT NOT NULL, used_at TEXT
);
CREATE INDEX idx_oauth_signup_expiry ON oauth_signup_pending(expires_at);
