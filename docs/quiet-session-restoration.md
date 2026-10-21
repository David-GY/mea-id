# Quiet school session restoration — October 21, 2026

Returning users keep their saved identity and cart on screen while school membership is checked in the background. A saved role is insufficient to open Tracker/Dashboard until current verification completes. Checkout waits for the shared verification job for at most ten seconds; a timeout leaves the cart intact and sends no checkout request. All existing server identity/permission checks remain in place.

## Compared combinations

| Combination | Interruption | Decision |
| --- | --- | --- |
| Existing Supabase + Sheets, blocking startup | Every reload waits for Apps Script and Supabase | Replace startup behavior |
| Supabase + cached authorization with a time limit | Fast, but can use stale permissions | Reject cached authorization |
| Supabase + background verification + same-origin SDK + inline recovery | Browsing/cart edits remain usable; protected actions await verification | Implement |
| Another identity provider + existing Apps Script | Still waits on the same membership backend | Migration is not justified by this issue |
| New edge authorization/data layer | Could reduce backend execution latency | Separate migration, with no live benchmark establishing the need here |

These are code-grounded architectural comparisons, not comparative vendor benchmarks. Simulated UX, security, maintenance, and skeptical perspectives favor the implemented combination. Confidence is high for removal of the recurring blocking UI; backend execution latency has not been remeasured.

## Behavior

- First sign-in/account connection can still show the existing verification screen. Returning matching school accounts do not.
- One in-flight membership check per UID/account generation; successful same-UID token refreshes do not repeat it.
- Transient failures preserve identity/cart and offer Retry. Automatic retries occur after 5, 15, and 30 seconds while visible and online, then stop until manual or network/visibility recovery.
- Expired/revoked session codes offer Reconnect. No automatic OAuth redirect, token lifetime changes, or new credential storage.
- Logout, account switching, session loss, and mismatching school UIDs invalidate old results; they cannot silently replace the saved account or cart.
- A completed background check neither closes an open editor nor immediately opens a cloud-cart conflict dialog. Conflicts preserve the device cart and offer Choose cart inline.
- Supabase JS stays at 2.118.0. Its versioned same-origin asset is cached with the app shell, removing the runtime CDN dependency. Application files still use network-first updates; callback credentials stay excluded from the service worker cache.

## Verification

`node --test tests/*.test.js`: 135 passing tests. Includes saved-role gating, coalescing, temporary retry, bounded retries, expired session error codes, stale responses after logout/account switches, protected checkout waiting and timeout without submission, cart conflict preservation, stale SDK initial-session notifications after logout, and SDK cache-first delivery.

Isolated browser fixtures checked at CSS widths 325 and 1280. With the membership response held pending, inventory browsing and adding an item remained possible with no open sign-in modal. Token refresh retained one membership request. A failed check displayed Retry; retry succeeded without OAuth. Session expiry preserved the cart and showed Reconnect inline. Device/cloud differences offered Choose cart without opening a dialog until clicked. Screenshots and test output are retained in the task workspace `.local-deploy/quiet-session-*` and `.local-deploy/quiet-auth-all-tests.txt`.

No production test transaction, return, email, or forced user sign-out was performed. Real OAuth redirects and production latency were not benchmarked.

## Sources

- [Supabase sessions](https://supabase.com/docs/guides/auth/sessions): saved sessions and automatic refresh already cover continued authentication.
- [Auth events](https://supabase.com/docs/reference/javascript/auth-onauthstatechange): identity, sign-out, and token-refresh notifications.
- [getSession](https://supabase.com/docs/reference/javascript/auth-getsession): session retrieval/refresh is distinct from server authorization.
- [Error codes](https://supabase.com/docs/guides/auth/debugging/error-codes): distinguish expired/revoked sessions from retryable network failures.

## Release and rollback

Frontend app-shell cache is `mea-app-v40`. No Apps Script deployment or Supabase configuration change is required. Rollback restores the prior frontend commit and uses a fresh service worker cache version to avoid mixed cached assets.
