# v54 transaction preparation — 2026-09-23

Production remains `moneyEnabled:false`, `moneyMode:disabled`. No flag activates live adapters. Existing Worker/DB/URL preserved.

Implemented: encrypted, bounded entity evidence submission; separate personal and entity verification; registry validation; representative/authority review with self-review prevention; optimistic revision checks; one approved representative per registration; 30-day raw retention, one-year review retention; audited access/review; expiry/reconfirmation UI. Intake requires approved privacy policy, identity integration and encryption secret.

Sandbox financial transport: Toss payment confirmation/full refund, JWE payout, authenticated provider reconciliation, durable idempotent reservations, replay/forged webhook protection, final failure review/retry, 10% double-entry fee accounting. TEST-only server routes bind mission parties and amount; no production mutation. Unknown payout without returned reference requires verified provider reference from webhook or operator reconciliation; it is never blindly resent. Sandbox payout reserves a conservative aggregate below KRW10m per seller over seven days, including failed attempts.

Not completed: actual provider certification/contract, production checkout and seller onboarding/consent flow, provider-to-seller binding validation, live balance/settlement reconciliation, contract-specific partial refunds/tax handling and dispute SLAs. These must be completed against the approved custody and payout arrangement before releasing live adapters. Helper `createSeller` alone is not a working seller onboarding service.

Tests: 112 behavioral checks; 12 launch groups; 13 entity/adapter groups. Actual SQLite and Worker handlers with mocked provider responses; no provider sandbox or live transaction executed. `npm test` includes all. Wrangler dry-run passes. Encrypted prior D1 backup restored locally: integrity OK, no FK violations, 21 users / 61 missions / 1 admin role. Applying additive 0019/0020 leaves all 33 prior tables unchanged byte-for-byte at row serialization level.

Deployment: use `.github/workflows/modu-challenge-cloudflare.yml`; legacy manual workflows delegate to it. Export and isolated SQLite restore check before encryption/artifact upload; artifact upload must pass before migration; preservation inventory must pass before Worker deployment. Backup retention90d. Recovery private key is held outside repository. Restore procedure: authorized operator decrypts CMS to private temporary storage; run restore-backup-check.py; restore to isolated D1 first; apply current migrations and expired-evidence purge before any production recovery; reconcile provider ledger before enabling access. Never restore production automatically over newer data.

Limits: hourly purge also runs after any restore; backup copies retain encrypted data until artifact expiry. Key rotation must preserve old decryption keys until backup expiry. Do not put keys, business registration scans, account details or private backup SQL into Git.

Official interfaces: https://docs.tosspayments.com/reference ; https://docs.tosspayments.com/reference/additional ; https://docs.tosspayments.com/guides/v2/payouts ; https://www.data.go.kr/data/15081808/openapi.do ; https://developers.portone.io/opi/ko/console/guide/reg
