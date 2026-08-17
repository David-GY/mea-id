# MEA App

A mobile-first web app for the **Management Engineering Association**, combining an NFC-based ID Tracker with a Room Inventory catalog — installable as a Progressive Web App (PWA), works offline, no backend server required.

Live at: `https://david-gy.github.io/mea-id/`

---

## What it does

### 🏠 Home
- Enter your ID number once — it carries into whichever section you open next, and persists for the rest of your session
- Quick access to Inventory and the ID Tracker
- Install the app to your home screen (Android/Desktop Chrome, iOS Safari)

### 📡 ID Tracker
- Scan an NFC tag **or** type an ID number manually (works on any device, not just NFC-capable Android phones)
- Move an ID between three states: **Inventory → With Project → Deployed** — moving to one automatically removes it from the other two
- Access-gated: only IDs listed in your sheet's `ACCESS` tab can get in
- **Works fully offline** — scans are saved to the device instantly and synced automatically the moment a connection returns, with a visible pending-sync indicator

### 📦 Inventory
- Browse room inventory pulled live from a Google Sheet, with items tagged by physical location (color-coded for quick scanning)
- Add items to a cart and check out under **Borrow / Consume / Return**
- Offline-safe: shows your last successfully synced copy if you open it without a connection

---

## Architecture

This is a **static site** (GitHub Pages) — there is no traditional server. All data lives in Google Sheets, reached through two independent Google Apps Script Web Apps, each deployed separately with its own URL:

| Backend | Purpose | Configured via |
|---|---|---|
| **ID Tracker script** | Reads/writes the ID Tracker sheet (`INVENTORY`, `W/Proj`, `DEPLOYED`, `ACCESS` tabs) | Home page → ⚙️ Setup |
| **Inventory script** | Reads the Room Inventory sheet | Home page → ⚙️ Setup |

Both URLs are stored in the browser's `localStorage` and are fully editable at any time from the Setup panel on the Home page.

### Files

```
index.html         Home page + Inventory/Cart/Checkout views
inventory.js        Logic for the above (fetch calls, cart, checkout, offline cache)
inventory.css        Shared styling — dark teal theme
id-tracker.html      Standalone ID Tracker page (NFC + manual entry, its own access gate)
manifest.json        PWA manifest (installability, icons, theme color)
sw.js                 Service worker — network-first caching for instant updates
icons/                 App icons (all PWA sizes) + icons/ui/ (interface SVGs)
brand/                  Source logo assets
```

---

## Setting up your own copy

### 1. Deploy the ID Tracker Apps Script
- Open your ID Tracker Google Sheet → **Extensions → Apps Script**
- Paste in the tracker script (handles `action=tracker`, `action=access`, `action=deets`)
- **Deploy → New deployment → Web App** — Execute as **Me**, Access **Anyone**
- Copy the `/exec` URL

Sheet tabs required: `INVENTORY`, `W/Proj`, `DEPLOYED`, `ACCESS` (columns: ID Number, Name)

### 2. Deploy the Inventory Apps Script
- This is a **separate** spreadsheet and **separate** script project
- Open your Room Inventory Sheet → **Extensions → Apps Script**
- Paste in the inventory script (handles `action=inventory`)
- Deploy the same way, copy its `/exec` URL

Sheet columns expected: `Type | Quantity | Location | Category | Notes` (header row auto-detected by matching "Type")

### 3. Configure the app
- Open the deployed site → Home → **⚙️ Setup**
- Paste both URLs → Save
- Done — no rebuild or redeploy of the site itself needed

---

## Notes

- **Web NFC** (tag scanning) only works in **Chrome on Android**. Manual ID entry works everywhere, including iOS and desktop.
- Updates to this repo go live on next page load — the service worker uses a network-first strategy specifically so deployments don't get stuck behind a stale cache.
- All app data (config URLs, saved scan history, offline queue) lives in the browser's local storage on each device — nothing is synced between devices except through the Google Sheets themselves.

---

