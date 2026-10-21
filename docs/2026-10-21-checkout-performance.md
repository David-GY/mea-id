# Checkout performance release — October 21, 2026

## Problem and change

The latest three-group production checkout spent 9.557 + 11.026 + 15.429 seconds in three sequential Apps Script calls (36.012 seconds of backend work, about 39.4 seconds from first execution start to last completion). The new frontend sends one `checkout` request, carrying independently idempotent ordinary Borrow, ordinary Consume, special Borrow and special Consume groups as needed.

School members and guests verify their current token once. ID-only members keep their existing roster-based behavior. Every group retains its own retry identifier, validation and success/failure result. A successful group is never recreated when a later group fails. Special requests retain separate journal/sheet/history records and send no email.

## Measured service-operation reduction

Comparison uses the same VM/Sheets fixture workload: two ordinary borrowed lines, one ordinary consumed line and one special request, comparing release `44b2c85` with this release. Counts measure operations, not simulated network time.

| Operation | Previous release | New release |
|---|---:|---:|
| Client HTTP requests | 3 | 1 |
| School identity service calls | 3 | 1 |
| Spreadsheet workbook opens | 35 | 2 |
| Ordinary catalog data reads | 3 | 1 |
| Script-lock acquisitions, including account linkage | 6 | 2 |
| Receipt Drive image reads | 4 | 2 |
| Data-range reads | 27 | 6 |
| Data writes | 15 | 11 |

Workbook handles, MAIN/ACCESS/CBAB snapshots, catalog, journal and display references are reused only inside one HTTP invocation. There is no persistent identity/permission cache. Reference allocations and projection rows are written in batches; journal events remain independently durable and compatible with existing History/returns/corrections.

## Background activity and receipts

New draft reads/writes, pending-order replay and pending-return replay pause during foreground checkout. A late draft read cannot replace a cart edited or submitted while it was in flight. The final dirty cart resumes its normal sync after submission. Already-running network writes are allowed to finish safely rather than being cancelled ambiguously.

Ordinary receipt generation remains synchronous, preserving existing templates and delivery behavior. It runs after transaction locks are released, and multiple receipts reuse their image blobs. Special requests bypass email entirely. Email failures retain the existing committed-transaction behavior; this release does not add an email outbox or scheduler.

ID-only offline checkout stores a complete batch before clearing the cart. On replay, confirmed groups are removed, permanent failures enter the failed bucket, and only transient failures remain pending with their original group IDs. Old queued single-group requests remain supported. Verified/guest checkouts retain the cart when offline or when school identity cannot be confirmed; they do not downgrade to ID-only writes or persist school tokens in queues.

## Observability

Responses and Apps Script logs record authentication, lock wait/hold, journal, projection, receipt and total elapsed milliseconds, with projection/receipt failure counts where relevant. Logs identify route names and group counts, without account names, emails, tokens or item content. Public inventory reads expose `checkoutVersion:1` for deployment verification.

## Verification and limits

- 121 automated tests pass, covering old/new API routes, all checkout group combinations, verified guests, permission changes, duplicate/changed requests, lost responses, partial results, offline recovery, stale cloud responses, receipt behavior and existing tracker/dashboard/PWA regressions.
- Browser fixture: ordinary Borrow + ordinary Consume + special Consume submitted successfully; cart cleared only confirmed groups, special outcome remained “Awaiting SUS verification · no email,” and no browser errors were observed.
- Live backend source was backed up and matched the prior repository release before replacement; receipt branding is preserved.
- Production verification uses read-only catalog metadata and rejected empty checkout payloads. No synthetic production order, special request, return, review or receipt is created for testing.
- Operation reductions are measured. A live before/after write-duration benchmark has not been performed, so no specific seconds or percentage improvement in wall-clock time is claimed. Apps Script startup, identity service, Sheets latency, existing lock contention and synchronous ordinary emails still affect duration.

## Deployment and rollback

Deploy backend first to the unchanged inventory web-app deployment, preserving execute-as/access settings. Then publish the frontend with `mea-app-v37`. No spreadsheet migration, trigger or credential change is needed. Revert frontend before restoring Apps Script Version 14; retain newer events, drafts and Special Requests data. Old clients/queued requests continue using the compatible single-group routes.

## Release verification

Inventory backend deployed successfully as Version 15 on October 21, 2026, 9:03 AM Asia/Manila, retaining the existing URL/access settings. Editor readback matched the tested source. Live inventory returned HTTP 200 with checkoutVersion:1 and 115 items; an empty checkout returned permanent INVALID without any production transaction or email. Frontend release is mea-app-v37; task-local release evidence records the GitHub Pages workflow and live file verification.
