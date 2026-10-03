# v95 automatic completion QA — 2026-10-03

REF-MODUCLEAR-AUTOMATIC-COMPLETION-20261003

Baseline: production and remote source 0.13.37 / v94 / f6f3304eafd91841b685d818d07f62aca1d15627. The removed scratch checkout was restored from the same branch; no unrelated changes were present.

## Reproduced and fixed

1. A 503 search response rendered “검색 결과가 없습니다” with no persistent retry. Failure is now distinguished from a genuine zero-result response; an inline retry preserves the query. A next-page failure retains already received cards and retries the same offset.
2. A slow home search response navigated away from a newer user-selected page. Navigation now occurs only when the original home route is still current.
3. An expired session only displayed a short login-required toast and retained privileged UI. It now clears account-specific UI, offers direct login, and saves the author-bound draft. Same-account authentication restores it without submitting; another account cannot inherit it. Restricted storage is reported without keeping privileged UI or blocking login.
4. The manifest contained only an SVG and no Apple touch icon. The existing logo was rasterized to 180, 192 and 512 pixel PNGs, with a separate padded maskable icon. Manifest, Apple link, notification icon and service-worker cache reference these assets. Bundle restoration preserves binary bytes.

## Executed checks

- Full npm suite and 57 deployment-safety tests, including restored-bundle PNG validation and session-expiry UI regressions.
- Actual Chromium against the actual Worker/schema in a disposable fixture: 4,999,999 public; 5,000,000 and 10,000,000 private pending; primary approval publishes; archive preserves privacy; result-dialog state and primary button match the outcome.
- Unverified mission and teaser submission prevented before any write; return restores authored text. Server email and authorization gates remain covered by the existing API suites.
- Deputy UI excludes final approval/archive/announcement actions.
- Cookie expiration returns 401, removes privileged form, preserves owner draft and opens login directly. Same-account and different-account recovery additionally verified in the DOM regression suite.
- Injected 503 followed by recovery: persistent error, unchanged search query, genuine empty result after retry. Delayed response does not override navigation.
- Chromium Page.getAppManifest and Page.getInstallabilityErrors: no errors. PNG URLs, dimensions, Apple touch icon and service-worker cache validated. The local HTTP fixture explicitly registers the worker for this test; production registration remains HTTPS-only.
- Read-only production config reports email delivery configured, Google/NAVER enabled, identity unavailable and real money disabled. OAuth start routes point to the respective providers with state and the existing Worker callbacks; no provider login or email/push was sent.

## Reproduction

Use the existing qa-fixture-server and the documented optional Playwright/Chromium environment variables in v93-real-user-qa.md. New browser suites: qa-browser-exceptions.mjs, qa-browser-policies.mjs, qa-browser-install.mjs. They use only local disposable users/data. No production account is embedded.

## Human/external verification boundary

Remaining: interactive real-account login/OTP, provider authentication completion, physical Galaxy/iPhone installation and notifications, and authenticated production owner/solver/administrator writes. These are not claimed complete by local emulation. Paid identity contracts and actual money activation remain outside approval; moneyEnabled=false.

Deployment target: 0.13.38 / v95 through the existing encrypted-backup workflow. Production commit and public assets must be checked after deployment. Previous successful screen-width and virtual-transaction coverage remains in v93/v94 reports; unchanged passing screens were not blindly repeated.

Icon compatibility references: https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html and https://web.dev/articles/add-manifest .
