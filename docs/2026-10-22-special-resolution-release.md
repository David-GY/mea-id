# Special request resolution and acceptance email release

Deployed October 22, 2026.

- Backend: existing Inventory Apps Script project, Version 17; endpoint and execute-as/access settings preserved.
- Verified special borrowings use normal partial returns and enter the shared Resolved history when fully returned. Declined and verified consuming requests also enter Resolved.
- Acceptance sends the original requester the verifier's notes. Pending/declined requests do not send mail. Failed delivery is shown to the verifier without undoing acceptance. Duplicate acceptance retries do not resend mail.
- Borrow, consume, return, and special acceptance emails share the transparent MEA logo and receipt template.
- Frontend cache: mea-app-v42.
- Validation: 151 Node tests passed. Source in the Apps Script editor matched the tested local backend before deploying. No real request or email was generated during deployment verification.
- Rollback: restore the previous frontend commit and Apps Script Version 16. Retain all journal data; no migration is needed.
