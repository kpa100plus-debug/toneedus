-- Additive only: do not rewrite members, missions, roles or legacy settlements.
CREATE TABLE identity_attempts (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','VERIFIED','REJECTED','EXPIRED')),
 consent_version TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE INDEX identity_attempts_user ON identity_attempts(user_id,created_at);
CREATE TABLE verified_identities (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 subject_hash TEXT NOT NULL UNIQUE, provider_reference_hash TEXT NOT NULL UNIQUE,
 provider TEXT NOT NULL, verified_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 revoked_at TEXT
);
CREATE TABLE verification_reviews (
 id TEXT PRIMARY KEY, verification_id TEXT NOT NULL REFERENCES member_verifications(id),
 reviewer_id TEXT NOT NULL REFERENCES users(id),
 decision TEXT NOT NULL CHECK(decision IN ('REJECTED','REVOKED','RECONFIRM_REQUIRED')),
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE transaction_orders (
 id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL REFERENCES challenges(id),
 owner_id TEXT NOT NULL REFERENCES users(id), solver_id TEXT NOT NULL REFERENCES users(id),
 mode TEXT NOT NULL CHECK(mode IN ('TEST','LIVE')),
 amount INTEGER NOT NULL CHECK(amount BETWEEN 10000 AND 100000000),
 currency TEXT NOT NULL DEFAULT 'KRW' CHECK(currency='KRW'),
 fee INTEGER NOT NULL CHECK(fee>=0), net INTEGER NOT NULL CHECK(net>=0 AND fee+net=amount),
 state TEXT NOT NULL DEFAULT 'CREATED', revision INTEGER NOT NULL DEFAULT 0,
 request_key TEXT NOT NULL, payment_reference TEXT, payout_reference TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_id,request_key), UNIQUE(challenge_id,mode), UNIQUE(mode,payment_reference), UNIQUE(mode,payout_reference)
);
CREATE TABLE transaction_events (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES transaction_orders(id),
 request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, action TEXT NOT NULL,
 actor_id TEXT, previous_state TEXT NOT NULL, next_state TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(order_id,request_key)
);
CREATE TABLE transaction_ledger (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES transaction_orders(id),
 event_id TEXT NOT NULL REFERENCES transaction_events(id), account TEXT NOT NULL,
 debit INTEGER NOT NULL DEFAULT 0 CHECK(debit>=0), credit INTEGER NOT NULL DEFAULT 0 CHECK(credit>=0),
 currency TEXT NOT NULL DEFAULT 'KRW' CHECK(currency='KRW'),
 CHECK((debit=0) != (credit=0)), UNIQUE(event_id,account)
);
CREATE TRIGGER transaction_events_no_update BEFORE UPDATE ON transaction_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TRANSACTION_EVENT'); END;
CREATE TRIGGER transaction_events_no_delete BEFORE DELETE ON transaction_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TRANSACTION_EVENT'); END;
CREATE TRIGGER transaction_ledger_no_update BEFORE UPDATE ON transaction_ledger BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER transaction_ledger_no_delete BEFORE DELETE ON transaction_ledger BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
