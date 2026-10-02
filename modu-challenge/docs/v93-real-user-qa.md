# v93 real-user QA scope — 2026-10-02

REF-MODUCLEAR-REAL-USER-QA-FINAL-20261002-195428

## Fixed and reproduced

- Same author could register identical work by changing only the title. Description and success criteria now define an additional author-scoped normalized fingerprint; an atomic D1 trigger rejects concurrent variants.
- Active private missions were missing from duplicate candidates and database guards. They now protect the author's own work. Other authors' private records are never disclosed. Legacy records without hashes are checked by normalized source content. Existing records are not deleted or backfilled.
- Home search filtered only the bootstrap page and displayed the old total. It now requests the server's complete search result before navigation, resets the previous category, and refreshes the total.

## Executed in isolated fixtures

- Full npm test suite, including API authorization, moderation, email gates, money restrictions, linked virtual transactions and frontend regression suites.
- Duplicate race with identical and different titles/request keys; private and legacy rows; update collision; legitimate self-edit and recruitment after cancellation.
- 4,999,999 / 5,000,000 / 10,000,000 KRW and increasing an existing reward: approval-private gates, owner access and anonymous detail denial.
- Headless Chromium with actual Worker routes and disposable SQLite/D1 adapter: 18 role/page cases at widths 320, 360, 390, 412, 768 and 1366 (108 combinations). Checks covered rendered Korean word breaks, visible horizontal overflow and JavaScript errors. Clipped decorative geometry and intentional horizontal scrollers are excluded. Anonymous protected pages correctly show login gates. Initial harness h1/h2 assumption was corrected to include h3; 12 affected cases reran successfully.
- Three empty signup submissions: inline errors, no stacked toast notifications.
- Separate owner/solver browser contexts: request, accept, confirm, virtual funding, begin, proof, correction request, resubmission, acceptance, payout failure and retry. Proof drafts survived reload. Fixture reward 120,000 / fee 12,000 / solver 108,000 / actual charge zero.
- Headless Linux font rendering is not evidence of physical Android/iPhone rendering. Representative registration and admin screenshots were captured; geometric checks do not establish that every state has received human visual inspection.

## Reproducible browser harness

`node scripts/qa-fixture-server.mjs` binds only 127.0.0.1:8789, uses in-memory data, and forbids external transports. In the same network namespace run `node scripts/qa-browser-matrix.mjs` and `node scripts/qa-browser-flows.mjs`.

Optional environment: QA_PLAYWRIGHT_MODULE (installed Playwright module), QA_CHROMIUM_PATH, QA_CHROMIUM_ADAPTER (optional installed Chromium adapter), QA_EVIDENCE_DIR, MODU_QA_FONT (local Korean font for /__qa/font). No browser dependency or test account is added to the production runtime.

## Production validation boundary

Baseline observed: 0.13.35 / v92 / commit 332b44567bc68f50d77710bfc2e608808ad6551b. Existing production records preserved. Release target: 0.13.36 / v93; deployment must use the existing backup-protected workflow and verify its health commit after success.

Production browser was anonymous in this session. Public navigation/search were exercised; the home search bug was observed there. Logged-in production owner/solver/admin write flows, physical Galaxy/iPhone installation, actual email delivery, Google/NAVER provider callbacks and every external integration remain unverified. No production member was deleted, no new external message was sent, and moneyEnabled remains false. This is a bounded verified release, not a claim of whole-product final completion.
