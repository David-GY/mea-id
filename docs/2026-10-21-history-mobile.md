# History mobile release

Approved compact History layout, equal-size Edit/Delete/Return actions, trash and Lucide refresh icons, department verification labels from Special Inventory column E, and compact special-request details/review dialogs.

Special-request reasons are stored with each cart entry, included in checkout, retained in cloud drafts and the append-only journal, and returned in History. Existing requests without reasons and existing retry identifiers remain compatible. The original batch checkout and offline queue implementation is retained.

Frontend cache: mea-app-v38. Backend: existing inventory web-app URL, new version replacing Version 15. No sample records, fixture injection, spreadsheet reset, permission change or production test transaction is part of this release.

Validation: 122 Node tests; mobile layout browser regression (three account kinds, five widths and five views), plus sign-in callback viewport regression. Preview checks verified action row equality, department labels, notes, reason entry and review controls.

Rollback: revert this frontend commit and select Apps Script Version 15 on the existing deployment. Keep journal and cloud-draft data.
