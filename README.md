# MEA App

A mobile-first Progressive Web App for the Management Engineering Association. It combines the NFC/manual ID Tracker, the room-inventory catalog, and the SUS Dashboard in one static GitHub Pages app backed by Google Sheets and Apps Script.

## What is included

- ID Operations Dashboard for Admin and Dashboard users.
- Project Deployment Planner with project/member selection, filters, confirmation, atomic batch moves, and per-record results.
- Interactive ID operation totals derived from one normalized tracker response.
- Project Readiness Matrix with reusable readiness calculation and traffic-light status.
- Data-quality Exceptions Inbox. Ambiguous records are review-only; the app never silently repairs them.
- Dedicated cross-device Activity Log with a compact dashboard preview, incremental polling, cached offline fallback, visibility/online recovery, and exponential retry backoff.
- Existing ID Tracker, inventory catalog, checkout, offline queues, installed PWA behavior, and dark-teal responsive design remain in place.

## Architecture

The frontend is static and deployable to GitHub Pages. Google Sheets remain the shared source of truth:

| Source | Use |
|---|---|
| `[SUS] MEA ID tracker` | `MAIN`, `INVENTORY`, `W/Proj`, `DEPLOYED`, `PRINTING`, `ACCESS`, and new `ACTIVITY_LOG`/`IDEMPOTENCY_LOG` tabs |
| `[2627] MEA Room Inventory` | Existing Catalog, order, and history backend |

The consolidated Apps Script is [apps-script/sus-dashboard-reference.gs](apps-script/sus-dashboard-reference.gs). It contains no deployed URL or access token and is intended to be the single tracker web-app script. It preserves the legacy `tracker`, `login`, `access`, and `meansList` routes, includes the optional `deets` lookup and spreadsheet-bound `bulkMove` utility, and adds the Dashboard routes. Keep the `[2627] MEA Room Inventory` backend separate.

### Important files

```text
index.html                         PWA shell and Dashboard/Activity views
inventory.js                       Existing app logic plus Dashboard navigation guard
dashboard-rules.js                 Pure Needs deployment/readiness rules
dashboard-model.js                 Pure normalization, totals, readiness, exceptions, activity merge
dashboard.js                       Dashboard UI, API client, planner, polling, offline fallback
dashboard.css                      Responsive Dashboard/Activity styling
apps-script/sus-dashboard-reference.gs  Apps Script reference implementation
tests/dashboard.test.js            Fixture-driven rule/model/backend-contract tests
sw.js                              Network-first service worker, updated app shell and cache version
```

## Dashboard data model and formulas

The client normalizes one `dashboardData` response into member records, then derives all cards, readiness rows, filters, and exception views from that model. It does not calculate separate totals from separate UI components.

**Needs deployment** is centralized in `dashboard-rules.js`:

```text
requiresId === true
AND state is not DEPLOYED
AND state is INVENTORY or WITH_PROJECT
```

**Readiness percentage** is also centralized:

```text
100%                                   when no assigned member requires an ID
deployed required members / required members × 100, otherwise
```

An available ID in Inventory or With Project counts under `IDs ready`, but not as deployed. Any missing/printing/unknown required ID or data blocker makes the project red; complete deployment is green; otherwise it is yellow.

MAIN project columns are detected dynamically. A non-reserved project column with a truthy value (`Yes`, `true`, `1`, or another non-empty value other than `No`/`false`/`0`) is treated as an assignment.

## Apps Script setup and migration

1. Open the `[SUS] MEA ID tracker` spreadsheet and create the required tabs if they do not exist: `MAIN`, `INVENTORY`, `W/Proj`, `DEPLOYED`, `PRINTING`, and `ACCESS`.
2. Add an `ACTIVITY_LOG` tab with exactly this header row:

   ```text
   Event ID | Server timestamp | Actor ID | Actor name | Action type | Target ID | Target name | Project | Previous state | New state | Batch ID | Device/client ID | Result | Details
   ```

3. Replace duplicate tracker router/helper files with the single consolidated `apps-script/sus-dashboard-reference.gs` source. Do not leave another file defining `doGet` or `doPost`; Apps Script silently uses the duplicate declaration that appears later. The script supports `login`, `access`, `meansList`, `tracker`, `dashboardData`, `activity`, `batchMove`, optional `deets`, and the spreadsheet-bound `bulkMove` utility. It accepts both headered state tabs and older headerless ID columns.
4. Deploy a new Web App version, executing as the sheet owner. Keep the existing `/exec` URL configuration in the app; Apps Script changes require a new deployment version.
5. Set the optional `ACCESS_TOKEN` Script Property and configure the same token in the existing ID Tracker settings. The Dashboard sends the logged-in actor ID and token; the backend verifies `ACCESS` levels server-side. If the project is standalone rather than sheet-bound, set `TRACKER_SPREADSHEET_ID`; the optional Digital Card lookup can use `DEETS_SPREADSHEET_ID` and `DEETS_SHEET_NAME`.
6. The first state-changing request creates `IDEMPOTENCY_LOG` if necessary. Its schema is:

   ```text
   Idempotency key | Batch ID | Actor ID | Request hash | Server timestamp | Response JSON
   ```

7. Open the PWA, sign in with an `ACCESS` record, and open Dashboard. Do not use the batch action until the Activity Log tab is present and the read view succeeds.

The `[2627] MEA Room Inventory` Apps Script remains a separate backend and is configured through the existing Inventory Script URL field. No production Sheet data is modified by the repository test suite.

## API contract

Dashboard reads use the tracker endpoint with `action=dashboardData`, `actorId`, and optional `token`. The response is normalized from `members` plus `rawTabs` and includes `revision` and `generatedAt`.

Activity reads use `action=activity&cursor=<last event ID>`. The response contains only events after the cursor, `nextCursor`, and the current revision. The Activity Log polls about every four seconds while visible; dashboard preview refreshes more slowly. Hidden tabs pause timers and visibility/online events refresh immediately.

Batch writes use `POST ?action=batchMove` with a text/plain JSON body containing `actorId`, `actorName`, `project`, `destination` (`W/Proj` or `DEPLOYED`), `ids`, `batchId`, `idempotencyKey`, and `deviceId`.

The reference write path acquires `LockService`, re-reads the state after acquiring the lock, validates every ID, and only then applies all changes and Activity Log rows. If any record is invalid or changed concurrently, the entire batch is rejected with per-record results and `BATCH_ATOMIC_ABORT`; no valid subset is applied. A repeated idempotency key returns the stored authoritative response and cannot create duplicate moves or events.

## Permissions

- `Admin`: Dashboard reads, deployment actions, exceptions, and full Activity Log.
- `Dashboard`: read-only Dashboard and Activity Log.
- `Tracker`: existing ID Tracker only.
- Ordinary users: existing ordinary-user surfaces only.

The UI hides/guards restricted navigation, but the Apps Script actions also require the actor ID to be present in `ACCESS` with the appropriate level. Hiding a button is not the authorization boundary.

## Verification

Run the repository tests with:

```text
node --test tests/dashboard.test.js tests/batch-simulator.test.js
```

The tests cover normal, missing, duplicate, conflicting, orphaned, printing, readiness, “Needs deployment”, activity de-duplication/order, and backend safeguard contracts. Apps Script execution itself requires the Google Apps Script runtime; use a copied test spreadsheet or fixtures and never the production tabs.

For a deployment smoke test, verify these isolated scenarios against a test sheet: successful batch, partially invalid all-or-nothing batch, concurrent state conflict, duplicate idempotency key, activity added from a second browser/device, reconnect/visibility polling, cached offline display, and Admin/Dashboard/Tracker/ordinary-user access. Check both a narrow mobile viewport and a wide desktop viewport, then confirm the service worker cache version is updated and the app shell is served from the new deployment.

## Existing limitations

- Web NFC is supported only by Chrome on Android; manual ID entry works on other browsers.
- Apps Script Web Apps do not provide persistent WebSockets, so cross-device activity is resilient cursor polling rather than a push channel.
- Cached Dashboard/Activity data is device-local fallback only and is clearly labeled; the shared source of truth remains Google Sheets.
- This first version intentionally offers review-only exception actions. Ambiguous data is never auto-fixed.
