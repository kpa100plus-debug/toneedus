# v94 search navigation follow-up — 2026-10-02

REF-MODUCLEAR-REAL-USER-QA-FINAL-20261002-195428

Production verification of v93 exposed another state mismatch: search for 보행환경 returned seven cards and correctly displayed seven results, but navigating to 신뢰·안전 and going Back cleared the search field while retaining those seven results. This was reproduced in the live browser.

The collection now records its server query. Entering a list whose query differs reloads the matching result and total; returning home restores an unfiltered collection. Returning to an unchanged query does not make another request. This also prevents a previous category or sort from replacing the home collection.

Regression checks exercise browser Back and reload, unfiltered home restoration, and unchanged-query request deduplication. The full automated suite and local real-Worker browser flow are rerun because this is a new change.

Release target 0.13.37 / v94. Deployment uses the same encrypted D1 backup, restore validation, record preservation and money-disabled checks as v93. The verification boundaries in v93-real-user-qa.md still apply: physical devices, live authenticated multi-role writes and external authentication/delivery are not claimed verified.
