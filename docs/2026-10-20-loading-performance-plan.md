# Suscart loading performance plan

Date: 20 October 2026. Investigation, implementation plan, and implementation results.

## Findings

Inspected the published HTML/JavaScript/service workers of both sites, Celadon's public Apps Script source, and the local Suscart repository. Celadon repository tree inspected at `f5c57247811b47d39967b4cbed9c047fc7278ab8`. Public Apps Script source describes intended behavior; it does not prove which backend version is deployed. No production writes or browser timing measurements were performed.

Celadon uses a static, plain HTML/CSS/JavaScript PWA on GitHub Pages, with Google Apps Script HTTP routes and Google Sheets storage. Its `google.script.run` interface is a JavaScript compatibility adapter around HTTP requests, not evidence that the GitHub Pages frontend runs inside Apps Script. Suscart already uses the same basic architecture. A framework migration is unnecessary for this change.

Both apps include most screen markup in `index.html` and switch visible sections locally. They are already loading the page shells together; inventory/history API requests are the remaining wait. ID Tracker is a separate Suscart HTML document and should be assessed separately from section navigation.

### What Celadon does

- `inventory.js:2031–2099`: hydrates inventory from localStorage, renders immediately, then refreshes in the background. An in-flight guard and 30-second freshness window prevent repeated catalog requests. Explicit refresh bypasses freshness.
- `inventory.js:495–526,1848–1849`: starts inventory loading on session restoration and successful login while the user views Home.
- `inventory.js:626–632`: sends a read-only projects request while the login screen is visible. This may overlap backend startup with typing; it is not a guarantee against Apps Script cold starts.
- `inventory.js:1419–1439`: Home renders cached history before its live response arrives. This is evidence of cached-first Home behavior, not proof every History screen is preloaded.
- `sw.js`: precaches the static shell at installation, then uses network-first requests with offline fallback. Apps Script data is not served from the service worker cache.
- `apps-script/celadon-inventory.gs:1203–1234`: caches member lookup indexes through Apps Script CacheService for ten minutes. This is a member lookup optimization, not an inventory snapshot cache.

### Suscart gaps

- `inventory.js:504` already prefetches inventory during startup. However, `showView('catalog')` calls `loadInventory()` again (`:604`), and `loadInventory()` (`:1011`) always paints skeletons and starts another request. There is no shared in-flight promise or freshness window.
- Inventory localStorage exists (`:31–52`), but serves as an error/offline fallback instead of immediately hydrating the catalog.
- `renderHistory()` (`:727`) clears records and paints skeletons before each request. Account/tab/project-specific caches already exist (`:653`); preserve and extend this scope rather than copying Celadon's global history cache.
- `workflow.js` owns account changes, authenticated requests, checkout, and returns. Its account epoch and History render token must also guard background work.
- `sw.js` already precaches the shell and uses network-first behavior. Changing it to cache API traffic is not needed.
- `apps-script/inventory-v2.gs:227` reads catalog sheets per inventory request. Reduce duplicate client calls before adding backend cache complexity.

## Proposed implementation

### 1. Shared inventory loader — first priority

Files: `inventory.js`, `index.html`, `inventory.css`.

Make `loadInventory({force:false})` return a shared promise. Track last successful network synchronization, a loading promise, and a configuration generation. Hydrate validated cached items before rendering; scope the cache to the configured inventory endpoint and access configuration without persisting raw credentials in the key. Migrate the old global cache only when its source can be established; otherwise discard it.

Render skeletons only when there is no usable snapshot. Keep existing content visible during refresh. Use a 30-second freshness window and one request per source while loading. Treat successful `[]` as a valid empty catalog, clearing obsolete items. Failed/offline fallback must never advance the successful-fetch timestamp. Reset the promise in `finally`, discard late responses after endpoint/configuration changes, and reconcile the cart only against valid snapshots. Add a small “Updating”, “Updated …”, or “Saved copy · …” label plus explicit refresh.

Verification: delayed response + startup followed by immediate catalog navigation yields one request; reopening within 30 seconds yields none; cached content remains visible while refreshing; empty results clear the catalog; errors allow retry; corrupt/unavailable storage does not break rendering; endpoint changes cannot show the previous endpoint's data.

### 2. Account-scoped History hydration and prefetch

Files: `inventory.js`, `workflow.js`.

Separate History fetching from DOM rendering. Pass an immutable context containing account owner, account epoch, endpoint/config generation, tab, and project. Use that full context for cache identity, in-flight deduplication, response acceptance, and a proposed 15-second freshness window. Include any request option that changes the returned dataset. Keep existing server authorization and failure handling.

After account restoration/connection completes, prefetch Personal History at low priority while Home is visible. Do not start private prefetch from the initial inventory bootstrap before the account is established. Render matching cached History before revalidation with its saved timestamp. Prefetch Project History only for the selected authorized project after project options resolve; do not download all projects. Preserve render-token guards on rapid tab changes.

On logout/account switch, clear visible private records, cancel where supported, and reject old-generation responses. On authorization failure, remove the affected private snapshot and show the error; never turn denial into cached access. Cached permissions must not authorize writes; return/edit/delete requests remain checked by the server.

Verification: account A response completing after switch to B cannot render or populate B's cache; personal/project scopes cannot mix; changing project mid-request is safe; denial clears the affected view; offline matching-cache display is labeled; prefetch plus navigation shares one request.

### 3. Mutation-aware invalidation and recovery

Files: `workflow.js`, `inventory.js`.

After confirmed checkout, return, record edit/delete/restore, or successful queued-write replay, invalidate the affected inventory/history scopes and force a refresh of the visible affected view. Preserve existing idempotent retry IDs, offline queues, account epochs, and cart reconciliation. Do not discard a newer invalidation when an earlier read completes: use generations so a read begun before a mutation cannot mark the data fresh afterward.

Refresh stale active data on reconnection/visibility restoration with deduplication; avoid polling inactive screens. Keep cached availability informational: existing server validation remains authoritative at submission.

Verification: each mutation updates visible state despite TTL; an older read cannot overwrite post-mutation state; queue replay does not produce a request storm or change retry semantics.

### 4. Other screens and deployment

Files: `dashboard.js`, `sw.js`, `index.html`, relevant tests.

Keep Dashboard/Activity behind their existing role guards. Do not eagerly prefetch restricted data for ordinary users. Review dashboard cache scoping before enabling any cached-first behavior there; this is a follow-on task, not a prerequisite for fast Suscart inventory/history. Keep ID Tracker navigation functional without prefetching tracker operations.

Retain network-first service worker behavior initially. Update script/style version query strings and service worker cache version with implementation. Ensure newly introduced assets, if any, join APP_SHELL. Measure first visit and return visit separately; service worker installation cannot accelerate an earlier initial page download.

## Acceptance and rollout

1. Add meaningful loader/History race tests using delayed mocked requests and controlled time. Extend the existing workflow fixture to exercise cached-first navigation, account changes, invalidation, and offline failures without production writes.
2. Run `node --test tests/*.test.js` after implementation. Use the existing local fixture for browser checks; inspect its documented invocation before launch.
3. Record request count, time to first usable catalog/History content, and time to fresh data for cold storage, warm storage, slow network, and offline scenarios on mobile and desktop. Compare the same fixture/network profile before and after. Proposed target: warm cached content within 200 ms of navigation in the controlled fixture, with zero duplicate inventory requests and no skeleton replacement during refresh. This is a target, not a measured result.
4. Ship frontend phases 1–3 first. No backend migration is required for these phases. Roll back by reverting frontend changes and bumping the service worker version again.
5. Only if timings show remaining server bottlenecks, separately evaluate short-lived Apps Script catalog caching with explicit write invalidation, manual-sheet-edit freshness bounds, payload limits, and server-side stock validation. Do not copy Celadon's member cache as though it caches inventory.

## Sources

- Celadon frontend: https://ennairaco.github.io/celadon-inventory/inventory.js
- Celadon service worker: https://ennairaco.github.io/celadon-inventory/sw.js
- Celadon backend source: https://github.com/ennairaco/celadon-inventory/blob/f5c57247811b47d39967b4cbed9c047fc7278ab8/apps-script/celadon-inventory.gs
- Suscart published frontend: https://david-gy.github.io/mea-id/inventory.js
- Suscart local files: `inventory.js`, `workflow.js`, `dashboard.js`, `sw.js`, `apps-script/inventory-v2.gs`.

## Implementation results — 20 October 2026

Implemented phases 1–3 and the frontend deployment preparation in phase 4. Inventory now hydrates saved data, shares requests, handles valid empty responses, and reuses successful reads for 30 seconds. Personal History prefetch starts only once the account is usable on Home; the selected project is prefetched only when it is listed in the server's authorized project response. History uses 15-second reuse, immutable scope contexts, account/source/revision guards, and saved-copy rendering. Added manual refresh for both views, visibility/reconnection recovery, mutation invalidation, and one refresh per completed queue replay batch.

Ruling: keep the existing backend and network-first service worker — the verified duplicate requests and skeleton replacement are frontend behavior; no backend migration is needed. Dashboard and Activity permission behavior remain unchanged. Work is isolated on `codex/loading-performance` in the existing checkout; launch is explicitly authorized by the user.

Ruling: ignore legacy inventory snapshots whose endpoint/access scope cannot be verified. New snapshots use a connection fingerprint and revision; raw access codes and Google tokens are not persisted in them. The fingerprint partitions local caches and is not used as an authorization mechanism. Saved data is never treated as a successful live refresh after an error.

Verification:

- `node --test tests/*.test.js`: 99 passed, 0 failed.
- `node tests/loading-performance.browser.js` with bundled Playwright: passed at 390px and 1280px; cold start, saved data on reload, slow refresh, shared requests, explicit refresh, offline display, no page errors, and no horizontal overflow.
- `node tests/mobile-layout.browser.js`: passed for ID-only, school-member, and guest accounts at five widths across five views.
- Independent code review found two issues (per-entry replay refreshes and a return/account-switch race). Both were reproduced with failing regression tests, fixed, and reviewed again; no remaining actionable findings.

Measured with the isolated fixture and a fixed 1200ms API read delay; these are local browser results, not production service latency or field performance guarantees. Cached rendering measurements include two animation frames after navigation.

| Scenario | Before (`4480abb`, 390px) | After (390px) | After (1280px) |
|---|---:|---:|---:|
| Warm catalog usable/rendered | 1185ms | 30.1ms | 31.8ms |
| Warm History usable/rendered | 1221.3ms | 29.7ms | 28.6ms |
| Inventory requests: startup plus Catalog → Home → Catalog | 3 | 1 | 1 |
| Skeletons replacing cached catalog / pending History | 9 / 2 | 0 / 0 | 0 / 0 |

Cold startup with no saved data still waits for live responses: inventory and prefetched History were both available by about 1.74s (390px) and 1.68s (1280px) in the fixture. Background refresh remains subject to the real Apps Script response time. API calls in all automated checks were intercepted; no test changed production sheets.
