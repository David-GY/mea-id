# Special Inventory Implementation Plan

> **Execution:** Follow the user-authorized execution method with available tools. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let students request Special Inventory separately, with manual SUS verification and no emails.

**Architecture:** Preserve permanent sheet IDs and the existing journal. Expose source and manual-verification metadata from Apps Script; enforce restrictions from the live sheet on every new order. Reuse the existing catalog, item dialog, cart reconciliation and Help contacts.

**Tech Stack:** Static JavaScript PWA, Apps Script, Google Sheets, Node test runner.

**Spec:** User request of October 20, 2026; Special Inventory A4:H11 in workbook `1oAMU9MEVxJqWuHCiwMsKsMePYlREYgq_sBi4_2-Ra3Y`.

## Global Constraints

- Complete Special Inventory changes before the whole-app audit.
- Deploy after fixes and verification, backend before frontend.
- Preserve historical transactions and legitimate retries of already committed orders.
- User clarification: students may request special items; record them separately with no email. Only verified admins may mark requests verified or declined.

## Review Focus

- An old saved/cloud cart now contains a special item: preserve it and route it through separate special-request submission.
- A stale/offline client submits a special item: normal order route rejects; separate request route records a pending request without email.
- A forged request omits verification metadata: server uses live catalog classification.
- A mixed order includes ordinary and special items: reject the entire new order without partial writes.
- A previous committed special-item order retries: return its original immutable result; existing returns still work.

### Task 1: Apps Script enforcement

**Files:** `apps-script/inventory-v2.gs`, `tests/cart-workflow.test.js`.
**Interfaces:** `invCatalog_()` adds `inventorySection` and `requiresManualVerification`; `invSubmit_(p)` returns permanent `MANUAL_VERIFICATION_REQUIRED` for new restricted orders.

- [x] Add fixture tests for metadata, Borrow/Consume rejection, mixed-order atomicity, reclassification and committed retries.
- [x] Add source metadata and validate all requested catalog IDs before generating references.
- [x] Run `node --test tests/cart-workflow.test.js`.

### Task 2: Catalog and saved carts

**Files:** `inventory.js`, `workflow.js`, `cart-model.js`, `inventory.css`, `index.html`, `sw.js`, client/model tests and browser fixture.
**Interfaces:** Shared `MeaCart.requiresManualVerification(item)`; normalized items carry server metadata. Special item details explain manual verification and no email. Checkout splits ordinary orders from special requests; History has a separate request section and verified admin review.

- [x] Add model/client tests for metadata, special dialog and separate submission routing.
- [x] Add catalog labels, recorded-quantity wording, separate request groups and History review using existing styles.
- [x] Run focused tests and inspect mobile/desktop fixture renders.

### Task 3: Whole-app audit, repair and deployment

**Files:** Entire deployed app; findings in `docs/2026-10-20-app-audit.md`.

- [x] Only after Tasks 1–2, audit auth, permissions, transactions, retries, cache/offline behavior, history, ID Tracker, dashboard, accessibility, mobile layout and deployment configuration.
- [x] Fix demonstrated issues and run all relevant existing tests plus focused regressions.
- [x] Save findings, limitations and verification evidence.
- [x] Deploy the existing inventory Apps Script deployment without changing access settings, publish frontend, and verify live release and read-only catalog metadata.

## Clarification incorporated

The user confirmed separate requests with no email. Added `submitSpecialRequest` and `specialRequestReview`, journal events, lazy-created `Special Requests` sheet, SR references, scoped request History and admin revision-checked review. Verification records do not create Borrow/Consume transactions. The original normal-order restriction remains to protect older clients.
