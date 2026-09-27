-- Additive and repeat-safe; existing missions, identity and transaction rows stay intact.
-- Original order amount/fee/net remain immutable contractual snapshots.
CREATE TABLE IF NOT EXISTS transaction_refund_receipts (
 event_id TEXT PRIMARY KEY REFERENCES transaction_events(id),
 order_id TEXT NOT NULL REFERENCES transaction_orders(id),
 mode TEXT NOT NULL CHECK(mode IN ('TEST','LIVE')),
 provider_reference TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(mode,provider_reference)
);
CREATE INDEX IF NOT EXISTS transaction_refund_order ON transaction_refund_receipts(order_id);
CREATE TRIGGER IF NOT EXISTS transaction_refunds_no_update BEFORE UPDATE ON transaction_refund_receipts
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REFUND_RECEIPT'); END;
CREATE TRIGGER IF NOT EXISTS transaction_refunds_no_delete BEFORE DELETE ON transaction_refund_receipts
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REFUND_RECEIPT'); END;
