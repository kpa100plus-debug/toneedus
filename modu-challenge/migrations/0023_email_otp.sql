-- Email possession remains separate from real-world identity verification.
CREATE TABLE email_otp_challenges (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 email TEXT NOT NULL, original_email TEXT NOT NULL, purpose TEXT NOT NULL,
 session_hash TEXT NOT NULL, code_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 used_at INTEGER, claim TEXT, proof_hash TEXT, proof_expires_at INTEGER
);
CREATE INDEX email_otp_member ON email_otp_challenges(user_id, purpose, created_at);
CREATE TABLE email_otp_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE email_otp_send_locks (user_id TEXT NOT NULL, purpose TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY(user_id,purpose));
ALTER TABLE email_verifications ADD COLUMN target_email TEXT;
UPDATE email_verifications SET target_email = (SELECT email FROM users WHERE users.id = email_verifications.user_id);
