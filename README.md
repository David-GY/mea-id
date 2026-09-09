# MEA App

A mobile-first Progressive Web App for the **Management Engineering Association**. It bundles two tools MEA officers use day-to-day — an NFC-based ID Tracker and a Room Inventory catalog — into one installable, offline-capable app with **no backend server to run or maintain**.

**Live app:** `https://david-gy.github.io/mea-id/`

---

## Quick facts

- 📱 **PWA** — installable to your home screen on Android, iOS, and desktop
- 📡 **NFC or manual entry** — scan tags on Android Chrome, or type IDs anywhere
- 🔌 **Offline-first** — both tools keep working without a connection and sync when it returns
- 🗄️ **Google Sheets as the database** — no servers, no hosting costs, no infra to patch
- 🚀 **Deploy by editing a Sheet** — most changes to data or access don't touch code at all

---

## What it does

### 🏠 Home
Enter your ID number once and it carries into whichever section you open next, persisting for the rest of your session. From here you can jump into Inventory or the ID Tracker, and install the app to your home screen.

### 📡 ID Tracker
Move an asset ID between three states — **Inventory → With Project → Deployed** — by scanning an NFC tag or typing the ID manually. Moving an ID to one state automatically removes it from the other two. Access is gated: only IDs listed in the sheet's `ACCESS` tab can get in. It works fully offline — scans save to the device instantly and sync automatically the moment a connection returns, with a visible pending-sync indicator the whole time.

### 📦 Inventory
Browse room inventory pulled live from a Google Sheet, with items tagged by physical location and color-coded for quick scanning. Add items to a cart and check out under **Borrow / Consume / Return**. If you open it offline, it falls back to the last successfully synced copy.

---

## Architecture

This is a **static site** hosted on GitHub Pages — there's no traditional application server. All data lives in Google Sheets, reached through two independent Google Apps Script Web Apps, each deployed separately with its own URL:

| Backend | Purpose | Configured via |
|---|---|---|
| **ID Tracker script** | Reads/writes the ID Tracker sheet (`INVENTORY`, `W/Proj`, `DEPLOYED`, `ACCESS` tabs) | Home page → ⚙️ Setup |
| **Inventory script** | Reads the Room Inventory sheet | Home page → ⚙️ Setup |

Both URLs are stored in the browser's `localStorage` and can be changed at any time from the Setup panel on the Home page — no rebuild or redeploy of the site required.

### Repo layout

```
index.html            Home page + Inventory/Cart/Checkout views
inventory.js          Logic for the above (fetch calls, cart, checkout, offline cache)
inventory.css         Shared styling — dark teal theme
id-tracker.html       Standalone ID Tracker page (NFC + manual entry, own access gate)
manifest.json         PWA manifest (installability, icons, theme color)
sw.js                 Service worker — network-first caching for instant updates
icons/                App icons for all PWA sizes, plus icons/ui/ interface SVGs
brand/                Source logo assets
```

---

## Setting up your own copy

### 1. Deploy the ID Tracker Apps Script
1. Open your ID Tracker Google Sheet → **Extensions → Apps Script**
2. Paste in the tracker script (handles `action=tracker`, `action=access`, `action=deets`)
3. **Deploy → New deployment → Web app** — execute as **Me**, access **Anyone**
4. Copy the `/exec` URL

Required sheet tabs: `INVENTORY`, `W/Proj`, `DEPLOYED`, `ACCESS` (columns: ID Number, Name).

### 2. Deploy the Inventory Apps Script
1. Use a **separate** spreadsheet and **separate** script project
2. Open your Room Inventory Sheet → **Extensions → Apps Script**
3. Paste in the inventory script (handles `action=inventory`)
4. Deploy the same way and copy its `/exec` URL

Expected sheet columns: `Type | Quantity | Location | Category | Notes` (the header row is auto-detected by matching "Type").

### 3. Configure the app
1. Open the deployed site → Home → **⚙️ Setup**
2. Paste both `/exec` URLs → Save

That's it — the site itself needs no further changes.

---

## Notes & limitations

- **Web NFC** (tag scanning) only works in **Chrome on Android**. Manual ID entry works everywhere, including iOS and desktop browsers.
- The service worker uses a **network-first** strategy on purpose, so a new deployment goes live on the next page load instead of getting stuck behind a stale cache.
- All app data — config URLs, saved scan history, the offline sync queue — lives in each device's local storage. Nothing syncs directly between devices; the Google Sheets are the only shared source of truth.
- Because both backends are Apps Script Web Apps, updating logic (not just data) means re-pasting the script and creating a **new deployment version** in that Sheet's Apps Script editor.
