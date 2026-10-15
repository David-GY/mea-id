# MEA UI Refresh Implementation Plan

> **Execution:** Follow the user-authorized execution method with available tools.

**Goal:** Add the approved Celadon-inspired readability and control improvements to draft PR 4.

**Architecture:** Keep existing vanilla JS workflows. Add semantic light/dark appearance tokens and shared control styles; adjust catalog and sheet markup without changing transactions.

**Tech Stack:** HTML, CSS, JavaScript, existing service worker and Node tests.

**Spec:** User-approved comparison in this conversation: two-column catalog, item-first cards, lighter MEA surfaces, organized sheets, consistent controls, restrained branding.

## Global Constraints
Preserve MEA branding, ID-only access, cart/return behavior, and existing dashboard privileges. Default MEA Green; allow saved Garden Green, Coffee and Plum preferences. No production deployment.

## Review Focus
Long names must wrap; narrow phones must not overflow; selected controls need readable contrast; dark theme must remain usable; dashboard and modal surfaces must match appearance.

### Task 1: Shared appearance
- [x] Add appearance.css and appearance.js, link from index.html, preserve theme preference before paint.
- [x] Normalize text tokens, primary/secondary controls, navigation, feedback and dashboard surfaces.
- [x] Verify light/dark Settings and keyboard focus in browser.

### Task 2: Catalog and sheets
- [x] Update inventory.js cards to name, availability, location order; two columns on mobile.
- [x] Update workflow.js sheet facts, notes, segmented choice and quantity row.
- [x] Verify mobile and desktop, long titles, cart editing, return sheet and checkout.

### Task 3: Draft delivery
- [x] Bump worker cache and include appearance assets.
- [x] Run node --test tests/*.test.js and browser smoke checks; review preview.
- [x] Update existing draft PR and its description with validation and deployment limitations.

User steering: direct cart Borrow/Consume buttons preserve quantity; collisions require explicit merge confirmation. Added regression coverage. Theme persistence, migration, storage failure, cart switching and existing workflow tests all pass (31).
