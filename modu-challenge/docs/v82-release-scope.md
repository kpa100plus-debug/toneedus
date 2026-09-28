# 모두의클리어 0.13.25 / PWA v82

Reference: REF-MODUCLEAR-NEW-CHAT-FINAL-EXECUTION-20260928-222019
Base production commit: 787f20bd4c297d76915528136651f6bcb06fdb59

## Changes

- New migration 0028 preserves existing rows and adds a canonical content fingerprint with database triggers. Concurrent identical creates/edits are rejected within the write transaction; retries using the same request key return the existing mission. Editing cannot race past receipt of a teaser.
- New linked virtual runs require candidate acceptance, followed by owner confirmation of the published terms, before virtual funding. The solver can decline; canceled history and the original mission/teasers remain intact. Previously started runs retain their existing stages.
- Participant-only virtual detail displays the selected solver's activity name, with a safe fallback instead of raw account IDs.
- Mission list has a server total, load-more pagination, stable ordering, and server-side search/category/sort including region. Initial public rendering still uses the existing bootstrap request.
- Instructions describe the virtual workflow and keep actual payment/transfer disabled. Newly generated mission drafts avoid unresolved Korean particle placeholders.
- PWA version URLs/cache synchronized to v82.

## Verification

- Full npm test suite passes after source packing/restoration.
- Moderation API: 23 groups including 4,999,999 / 5,000,000 / 10,000,000 KRW, price increase, private approval access, concurrent create/retry, and pagination beyond 50.
- Linked virtual transaction API: 17 groups covering two authenticated member sessions, ordered acceptance/confirmation, rejection, results/revision, payout retry, ownership, no real money, and preservation of source/financial/reputation tables.
- Mocked frontend: 22 checks covering participant controls, draft preservation, polling, role switches, and pagination/search requests.
- Deployment safety: 57 checks pass.
- Production browser navigation to explore/how/trust/admin verified before deployment. Desktop explore had no horizontal overflow at 1363px.
- Local visual preview was blocked by the cloud browser. No claim of completed mobile visual QA or real device OAuth/email delivery testing.

## Operational boundaries

No actual payments, transfers, external notification sends, new provider contracts, or user record cleanup were performed. Historical duplicate missions and high-value missions published before the approval policy were not mass-modified. Their approval provenance needs a separate administrative review. New and edited missions use the tested approval gate.

Deployment must use the existing backup-protected GitHub Actions workflow, which encrypts a D1 backup, checks preservation, applies migrations, deploys the Worker, and verifies the public version and disabled money gates.
