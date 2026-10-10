## Moduclear: source, efficiency, verification and recovery

This repository also contains **모두의클리어 (Moduclear)** in `modu-challenge/` on branch `modu-challenge-app`. The Next.js instructions below apply to the repository-root app, not to that Worker/PWA.

Reference: `REF-ISEA-CODE-EFFICIENCY-MASTER-20261010-202955`.

### Establish the baseline before editing

- Read the branch head, working-tree diff and relevant release notes before making changes. Recheck the remote head before publication; if it moved, inspect and integrate the new work rather than overwriting it.
- At the 2026-10-10 source review, the baseline was `d0490fc350707189ef57754270127dbe327b4186`, package **0.13.38**, PWA **v95**. This is a source observation, not a fresh production verification.
- Use `modu-challenge/package.json`, `wrangler.jsonc`, and `docs/v95-automatic-completion-qa.md` within that project for version and verification context. The nested README and DEPLOYMENT_STATUS still contain historical V0.9.0 instructions and must not be treated as current deployment evidence.
- Keep the existing data, member activity, TRUST, authentication records and parallel work intact. Keep `moneyEnabled=false` and the existing monitor/scheduled jobs unchanged.

### Work efficiently without weakening checks

1. Identify the reproduced issue, affected entry point, shared helper and regression boundary. Prefer the smallest understandable change; do not rewrite unrelated code or add dependencies just to reduce line counts.
2. Reuse an existing correct helper when duplication is confirmed. Check all call sites and preserve error, cancellation, retry and navigation behavior.
3. Run the closest relevant test first. Record the exact command, source revision and pass/fail/blocker; run the mandatory aggregate gates before any runtime publication.
4. Documentation-only changes outside runtime and deployment inputs need link/path/command/diff checks, not repeated browser or full application test runs. Any runtime change still requires the full gates below.
5. Reuse successful test evidence only while the relevant source, dependencies, configuration and environment remain unchanged. Record environment and timestamp; distinguish reused evidence from this run. Recheck mutable API/authentication/database state when relevant. Run independent reads and checks in parallel; serialize edits to the same file, database changes and deployments.
6. Only claim an efficiency gain when before/after measurements use the same workload and environment. One slow response is an observation, not proof of a bottleneck or a fixed outage. Do not replace earlier test evidence or assign a whole-service completion score without its rubric.

For work reports, use the first line `현재 완성도: 미산정 / 100점` until an evidence-backed whole-service rubric has been evaluated. Distinguish this cleanup task from service completion. Include source/deployment revisions, new versus reused checks, measured benefits or “not measured”, blockers, links, the reference above and KST time. Keep this record in the existing documentation rather than creating duplicate handoff reports.

### Local preparation and mandatory runtime gates

Run from `modu-challenge/`, using Node.js 22 or later:

```bash
npm ci
npm run prepare:source
# Make the scoped runtime change only after preparation.
# Run the matching regression script first, then the mandatory gates:
npm test
node --test scripts/deployment-safety.test.mjs
```

Impact-based examples (the aggregate suite remains mandatory for runtime publication):
- Modal interactions: `node scripts/modal-interaction-regressions.mjs`
- Frontend state/navigation: `node scripts/frontend-state-regressions.mjs`
- Session-expiry UI: `node scripts/session-expiry-ui-regressions.mjs`
- Mission-linked UI: `node scripts/mission-linked-ui-regressions.mjs`

`prepare:source` verifies a SHA-256 digest and restores **58** bundled runtime files at the reviewed baseline, including binary assets. It writes files: never run it over unpreserved edits. For changes to bundled runtime files, review `scripts/pack.mjs`, run `npm run bundle:pack`, and verify restoration plus the gates in a separate disposable copy. Preserve both the edited source and the matching bundle; a successful test of an unbundled edit does not prove the deployable bundle contains it. Recheck the final diff after generated-file steps.

Do not run `demo:seed:remote`, `demo:clear:remote`, `test:live:e2e`, `test:live:clear` or authenticated live tests as routine local verification. They may write real service data. Browser tests should use disposable local fixtures and document external-provider/device verification separately.

### Publication and recovery boundary

- `npm run deploy` deliberately exits with an error. The existing deployment route is `.github/workflows/modu-challenge-cloudflare.yml`.
- A push to `modu-challenge-app` changing `modu-challenge/**` or that workflow automatically starts production deployment. **Even a nested documentation change matches this path filter.** A root README-only change does not match it.
- That workflow is not a static upload: after tests it exports/encrypts D1, validates restoration, uploads the encrypted backup, applies pending remote migrations, checks record preservation, deploys the Worker, applies configured authentication-provider secrets, then verifies production.
- When the authorized scope excludes database or authentication changes, stop before triggering this workflow. Do not bypass it with direct Wrangler deployment, change schedules, extract credentials or assume empty pending migrations/secrets. Resolve the authorization and verification boundary first.
- Before an authorized deployment, retain the baseline commit and review pending migrations and all workflow side effects. Missing credentials, failed restore checks, failed preservation checks or failed tests are blockers, never reasons to skip gates.
- Recovery starts by preserving the failed run's evidence and identifying the last verified source and encrypted backup. Reverting code does not undo a D1 migration or authentication-secret change. Restore only through a separately reviewed, authorized recovery procedure; do not overwrite current production data with demo seeds or an unverified backup.
- After publication, verify the exact remote commit and required CI for that commit. After deployment, verify public health/config/bootstrap, PWA cache version and disabled real-money gates. Report source-pushed, CI-passed and production-verified as separate facts. Never call an unrun or blocked stage passed.

---

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
