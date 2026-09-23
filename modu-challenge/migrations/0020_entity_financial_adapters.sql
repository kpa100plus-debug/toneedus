-- Additive only. Existing members, missions and verifications are unchanged.
CREATE TABLE entity_cases (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 subject_type TEXT NOT NULL CHECK(subject_type IN ('business','corporation','organization')),
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','REVOKED','EXPIRED','WITHDRAWN')),
 registration_hash TEXT NOT NULL, private_cipher TEXT, consent_version TEXT NOT NULL,
 registry_checked_at TEXT, registry_valid INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0, reason TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, purge_at TEXT NOT NULL,
 UNIQUE(user_id,subject_type)
);
CREATE TABLE entity_evidence (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES entity_cases(id),
 kind TEXT NOT NULL CHECK(kind IN ('REGISTRATION','REGISTRY','AUTHORITY')),
 cipher TEXT, digest TEXT NOT NULL, mime TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, purge_at TEXT NOT NULL,
 UNIQUE(case_id,kind)
);
CREATE TABLE entity_reviews (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES entity_cases(id), reviewer_id TEXT REFERENCES users(id),
 action TEXT NOT NULL, reason TEXT NOT NULL, evidence_digest TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER entity_reviews_no_update BEFORE UPDATE ON entity_reviews BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ENTITY_REVIEW'); END;
CREATE TRIGGER entity_reviews_no_delete BEFORE DELETE ON entity_reviews WHEN julianday(OLD.created_at)>julianday('now','-365 days') BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ENTITY_REVIEW'); END;
CREATE TABLE provider_operations (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES transaction_orders(id),
 kind TEXT NOT NULL CHECK(kind IN ('PAYMENT','REFUND','PAYOUT')),
 request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','UNKNOWN','SUCCEEDED','FAILED')),
 provider_reference TEXT, error_code TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE payout_sellers (
 user_id TEXT NOT NULL REFERENCES users(id), mode TEXT NOT NULL CHECK(mode IN ('TEST','LIVE')),
 seller_id TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT NOT NULL,
 PRIMARY KEY(user_id,mode), UNIQUE(mode,seller_id)
);
CREATE INDEX entity_purge ON entity_evidence(purge_at);
CREATE INDEX provider_pending ON provider_operations(status,updated_at);
-- Batch-local compare-and-swap guard: SQLite abort rolls back every statement.
CREATE TABLE entity_mutation_guards(case_id TEXT PRIMARY KEY, expected_revision INTEGER NOT NULL);
CREATE TRIGGER entity_guard_revision BEFORE INSERT ON entity_mutation_guards
 WHEN NOT EXISTS(SELECT 1 FROM entity_cases WHERE id=NEW.case_id AND revision=NEW.expected_revision)
 BEGIN SELECT RAISE(ABORT,'STALE_ENTITY_REVISION'); END;

CREATE UNIQUE INDEX provider_one_active ON provider_operations(order_id,kind) WHERE status<>'FAILED';
CREATE UNIQUE INDEX entity_one_representative ON entity_cases(registration_hash) WHERE status='APPROVED';
