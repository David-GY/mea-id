# Faster Checkout Implementation and Deployment Plan

> **Execution:** Follow the user-authorized execution method with available tools. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce checkout latency for ID-only members, school-verified members/guests, Borrow, Consume, special requests, mixed carts and offline replay.

**Architecture:** Add one `checkout` POST carrying one to four independently idempotent groups. Resolve identity once, use one transaction lock, and reuse workbook/catalog/event/reference reads only within that HTTP request. Preserve per-group success/failure; committed journal events remain authoritative. Send ordinary receipts after releasing the transaction lock, reusing image blobs; special requests never email.

**Tech Stack:** Static JavaScript PWA, Apps Script, Google Sheets, Node VM fixtures.

**Spec:** User request and `.local-deploy/request-latency-diagnosis-2026-10-21.md` (three sequential groups consumed 36 seconds of backend execution).

## Global Constraints

- Preserve original journal events, permanent IDs, ordinary receipt branding and special no-email behavior.
- Revalidate school identity and permissions on every request; no cross-request permission cache.
- Retain legacy single-group routes and existing queued entries.
- No new email scheduler or database migration. Receipts remain synchronous, outside the transaction lock.
- Backend-first deployment to the existing URL, followed by frontend/cache release; keep rollback versions.

## Review Focus

- A lost response after some groups commit: replay fixed group IDs without duplicate transactions or receipts.
- One invalid group among valid groups: report each result, retain only rejected cart entries.
- A school session expires or changes during submit: no ID-only downgrade and no cart mutation for the wrong account.
- An offline batch partly fails on replay: retain only retryable groups; move permanent failures into the failed queue.
- A background draft request overlaps checkout: prevent new syncs, ignore old read responses, then sync final cart once.

### Task 1: Shared backend performance and checkout API

**Files:** `apps-script/inventory-v2.gs`, `tests/cart-workflow.test.js`.
**Interfaces:** `checkout` consumes `{idNumber,idToken?,groups:[{clientId,caseType,requestOnly,project,committee,items}]}` and returns `{ok:true,results:[{clientId,ok,...result|error}],timings}`. Existing routes remain compatible.

- [x] Add failing tests: four combinations share one identity check and catalog read; mixed failures; guest isolation; duplicate/changed retries; receipt calls occur outside locks; batched projections; timing fields contain no identity data.
- [x] Implement request-local handles/snapshots, batched reference allocation/projection rows, receipt drain after locking, and stage timing logs.
- [x] Run backend fixture tests; count remote-service operations before/after on the same fixture workload.

### Task 2: One client request across all checkout methods

**Files:** `workflow.js`, `inventory.js`, `tests/workflow-client.test.js`, `tests/serve-workflow-fixture.js`.

- [x] Test one POST for mixed carts, explicit per-group outcomes, ambiguous response retries, ID-only offline durability, verified guests, legacy queue compatibility and partial queue replay.
- [x] Send all groups once; keep group retry IDs until confirmed/queued; invalidate data once after successful groups.
- [x] Pause draft writes/reads and queue flushing during foreground checkout; resume final dirty draft afterward, rejecting stale draft reads.
- [x] Exercise the isolated browser fixture; run all existing tests and syntax/asset checks.

### Task 3: Deployment and verification

**Files:** `index.html`, `sw.js`, `DEPLOYMENT-SUSCART.md`, `docs/2026-10-21-checkout-performance.md`.

- [x] Save current live backend source and compare it with repository source to preserve out-of-band changes.
- [x] Deploy the tested backend to the existing deployment, retaining execute-as/access settings. Smoke-test only read-only or rejected empty payloads on production; use fixtures for real writes/emails.
- [x] Publish frontend with a new service-worker release; verify GitHub Pages workflow and live asset fingerprints.
- [x] Document measured request/service-call reductions, residual latency, timings and rollback. No unsupported live write-latency promise.
