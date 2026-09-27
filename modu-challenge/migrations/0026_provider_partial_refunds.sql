-- Repeat-safe; no existing order, operation, event, receipt or ledger row is changed.
-- Amounts are fixed before transport and bound to one audited state transition.
CREATE TABLE IF NOT EXISTS provider_operation_intents (
 operation_id TEXT PRIMARY KEY REFERENCES provider_operations(id),
 request_event_id TEXT NOT NULL UNIQUE REFERENCES transaction_events(id),
 amount INTEGER NOT NULL CHECK(amount>0),
 refunded_before INTEGER NOT NULL CHECK(refunded_before>=0),
 expected_state TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS provider_intents_no_update BEFORE UPDATE ON provider_operation_intents
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROVIDER_INTENT'); END;
CREATE TRIGGER IF NOT EXISTS provider_intents_no_delete BEFORE DELETE ON provider_operation_intents
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROVIDER_INTENT'); END;
-- Payment and payout retain their original single-success rule. Refunds may
-- finish in several parts, but only one unconfirmed refund may be in flight.
CREATE UNIQUE INDEX IF NOT EXISTS provider_one_payment_payout
 ON provider_operations(order_id,kind) WHERE kind<>'REFUND' AND status<>'FAILED';
CREATE UNIQUE INDEX IF NOT EXISTS provider_one_refund_inflight
 ON provider_operations(order_id,kind) WHERE kind='REFUND' AND status IN ('PENDING','UNKNOWN');
DROP INDEX IF EXISTS provider_one_active;
