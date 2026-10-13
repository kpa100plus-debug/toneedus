# Ten member journeys — v96 / 0.13.39

REF-MODUCLEAR-TEN-MEMBER-QA-20261013

Baseline checked 2026-10-13: production v95 / 0.13.38 / d0490fc350707189ef57754270127dbe327b4186; remote f380eb73b233318107aa0f4b684041e47786a3ed adds the scoped recovery runbook only. Existing source/data preserved.

## Test users and executed scope

Ten new accounts were created through the signup form and actual /api/auth/signup handler, not seeded directly into users. Signup consent and password derivation, local mailbox OTP, logout, password login and reload all ran through browser controls. Email and phone fields are synthetic, and the disposable database is separate from production. The fixture intercepts Brevo delivery locally; it cannot send external email, push or payments. Tests do not establish production delivery or physical device compatibility.

| User | Browser viewport / touch | Role |
| --- | --- | --- |
| 1 | Galaxy-sized 360 × 800 / touch | Owner |
| 2 | iPhone-sized 390 × 844 / touch | Solver |
| 3 | Notebook 1366 × 900 | Owner |
| 4 | Tablet portrait 768 × 1024 / touch | Solver |
| 5 | Desktop 1920 × 1080 | Owner |
| 6 | Galaxy-sized 412 × 915 / touch | Solver |
| 7 | Small iPhone-sized 375 × 812 / touch | Owner |
| 8 | Tablet landscape 1024 × 768 / touch | Solver |
| 9 | Notebook 1280 × 900 | Primary admin |
| 10 | Desktop 1440 × 900 | Deputy admin |

All use Chromium. iPhone-sized Chromium is not Safari/WebKit or a physical iPhone. The QA font is a local Korean font; no font or browser binary was added to the production runtime.

Final run: 146 checks passed, zero failures. 114 rendered states checked for Korean word splitting and visible horizontal overflow. Ten signup records and ten signup audit events verified. The recorded timestamps, individual checks and layout observations are in v96-ten-member-evidence.json. Four final virtual-transaction screenshots were inspected locally.

Per-member navigation: home, explore, how-to, trust, terms, privacy, dashboard, profile and creation. Repeated empty signup uses inline errors without stacked toasts. All ten contexts have no application JavaScript exceptions.

Four owner/solver pairs: easy and direct mission creation; 120,000 / 4,999,999 / 5,000,000 / 10,000,000 reward cases; private high-value detail before approval, primary approval and subsequent public detail; changed-title duplicate rejection with a fresh idempotency key; teaser submission, edit, withdrawal and reapplication; named candidate selection; virtual request, solver acceptance, owner confirmation, funding, beginning work, proof draft reload, submission, correction request, resubmission, review acceptance, payout failure and retry. Actual charge stays zero. Existing floor-rounded 10% fee and remainder payout verified, including 4,999,999 → 499,999 fee / 4,500,000 payout.

Registered primary admin appoints registered deputy through UI. Deputy status is verified from the API, and primary-only moderation/announcement/delegation access is denied. Outsider simulation access returns 403. Dashboard notification navigation works. Related API suites additionally cover duplicate concurrency, email/identity gates, transaction replay and wrong-role actions, cancellation/refunds, verification/provider failures and account security.

## Reproduced issues and fixes

1. Returning to Explore reused an earlier list even after another member created or approved a mission. Explicit route navigation and retry now refresh the current query. Initial bootstrap can still reuse the just-received list; search/category/sort stay unchanged. A regression test checks the new mission, query preservation and absence of an initial duplicate request.
2. Under reduced-motion preferences, popup entrance animation remained active and repeatedly prevented stable tablet button interaction in the local browser. Popup and toast animation plus smooth root scrolling are disabled for that preference. The same tablet scenario then completed with a normal click, without forcing it.

Early harness failures were also corrected: waiting for logout completion, handling confirmation dialogs, supplying fresh idempotency keys, selecting the explicit candidate-review control and waiting for mutation responses. Those harness corrections are not reported as service fixes.

## Validation and release

Full npm suite passes, including the restored source bundle; 57 deployment-safety checks pass. Release must use the existing backup-protected GitHub workflow for the existing Worker. Production commit/version and explicit Explore navigation must be checked after deployment.

Completion score remains 85/100 under the previously fixed rubric: production real-account authentication (5), physical Galaxy/iPhone installation and notification (5), authenticated production owner/solver/admin transaction validation (5) remain unverified. Local test coverage cannot replace those points. moneyEnabled=false remains intentional. No production users or missions were created or deleted by this run, and no external notification was sent.

Reproduce with qa-fixture-server.mjs and qa-ten-member-journeys.mjs. Set QA_SIGNUP_JOURNEY=1, MODU_QA_FONT to a locally available Korean font, and optional existing QA_PLAYWRIGHT_MODULE / QA_CHROMIUM_PATH / QA_CHROMIUM_ADAPTER. Run both processes in the same network namespace. The optional QA_PAIR_ONLY rechecks one previously failed pair; the final evidence is from the full run.
