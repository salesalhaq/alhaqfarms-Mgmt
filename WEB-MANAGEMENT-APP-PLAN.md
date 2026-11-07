# Web Management App Plan

## Goal

Build a web management app at `mgmt.alhaqfarms.com.pk` that staff can use alongside the Windows app (e:\alhaqfm app) with the same Supabase identity, role, assigned branch, and permissions. The Windows app remains the offline-capable client; the web app is an online client of shared data.

## Guiding decisions

- Supabase is the shared source of truth for cloud identity, staff assignments, permissions, and synchronized records.
- Reuse existing staff and `cloud_staff` records; do not create a separate web-only staff directory.
- Keep authorization server-enforced. Never trust a role, staff ID, or branch ID supplied by browser state.
- Keep service-role credentials and other privileged secrets on the server only.
- Preserve the Windows app's offline operation, while explicitly handling conflicts between offline desktop changes and online web changes.
- Deliver a focused, secure first release before pursuing broad feature parity.

## First milestone

The selected first milestone is **staff sign-in and branch-scoped online order management, including payment review**. It includes the secure app shell, order list/details and history, payment-proof viewing for authorized staff, and order/payment actions only after they are protected by a server-side transactional authorization path. Dashboard, reports, catalog management, and wider desktop feature parity can follow.

The existing cloud RLS policies permit branch staff to update `web_orders` rows but do not by themselves enforce each desktop order action permission or the desktop's multi-row transaction logic. The web app must not implement order actions as unchecked direct table updates. Validate action-level permission rules and provide an atomic server-side database operation before enabling writes.

## Phase 1: Discovery and contract

1. Inventory the current Supabase Auth, `cloud_staff`, `staff_profiles`, branch assignment, permission, RLS, audit, and sync models.
2. Document how desktop identities map to Supabase Auth users and how branch IDs are mapped across devices.
3. Inventory the storefront and desktop app's existing schemas, RPCs, migrations, and deployment setup.
4. Choose the initial web workflows and label each read-only or write-enabled.
5. Define conflict and offline-reconciliation behavior for each shared write.

**Exit criteria:** approved identity/authorization flow, feature scope, data ownership rules, and a migration/deployment sequence.

## Phase 2: Secure foundation

1. Create the web app using the existing project conventions where practical and prepare staging separately from production.
2. Configure `mgmt.alhaqfarms.com.pk`, TLS, environment secrets, and appropriate security headers.
3. Implement Supabase Auth sign-in using the same staff accounts as the Windows app.
4. Resolve the authenticated user to the existing active staff profile and cloud staff record.
5. Load the current role, branch assignment, and permissions from trusted server-side records.
6. Enforce access on every server request with Supabase RLS and narrowly scoped RPCs where needed.
7. Handle account deactivation, branch reassignment, session expiry, and sign-out consistently.
8. Add server-side audit records with the correct staff actor and branch.

**Exit criteria:** the same staff member can sign in to both apps; the web app exposes only authorized branches and actions; deactivated or reassigned staff lose access.

## Phase 3: Read-only first release

Start with lower-risk workflows, such as:

- Role- and branch-scoped dashboard
- Reports
- Product and category browsing
- Online-order visibility and payment-review history

Use pagination and bounded queries; avoid loading large tables or image payloads unnecessarily. Validate that the selected screens work well at desktop and tablet sizes.

**Exit criteria:** authorized users can use the selected screens without changing operational data, and access-control tests prove cross-branch data is not exposed.

## Phase 4: Controlled write workflows

Add write access one workflow at a time, beginning with online-order actions if they are needed:

- Validate the current order state and permissions on the server for every action.
- Use database transactions, concurrency checks, and idempotency keys to prevent duplicate or stale actions.
- Record state changes and payment review actions in the existing order event/audit history.
- Ensure desktop sync cannot silently overwrite a newer cloud change.
- Keep customer payment proofs private and issue short-lived signed links only to authorized staff.

Do not enable web POS sales or stock-affecting actions until the offline conflict and stock-reservation policy is implemented and tested.

**Exit criteria:** repeated or concurrent requests cannot duplicate actions; stale updates are rejected or reconciled explicitly; desktop and web views converge to the same state.

## Phase 5: Cross-client correctness

Test scenarios include:

- Same staff account signed in on Windows and web
- Multiple roles and branch assignments
- Unauthorized branch and action requests
- Staff deactivation and branch reassignment
- Simultaneous web and desktop edits
- Desktop changes made offline and later synchronized
- Duplicate submissions, retries, and interrupted requests
- Payment verification/rejection and order event visibility
- Stock reservations racing with POS sales

Define observability for failed requests, sync conflicts, and authorization denials without logging credentials, payment proof contents, or unnecessary personal data.

## Phase 6: Deployment and rollout

1. Apply reviewed schema changes to staging and verify RLS, RPCs, and rollback steps.
2. Run automated tests and end-to-end checks against staging with non-production accounts.
3. Deploy to the production Cloudflare environment and bind `mgmt.alhaqfarms.com.pk`.
4. Pilot with a small staff group and monitor errors, performance, and data consistency.
5. Expand access gradually; maintain a documented rollback path.
6. Document staff workflows, support procedures, and which actions remain desktop-only or online-only.

## Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Browser trusts a forged role or branch | Derive authorization server-side and enforce RLS on every data path. |
| Offline desktop writes conflict with web writes | Use explicit conflict rules, concurrency/version checks, and reconciliation tests. |
| POS and website oversell inventory | Implement atomic shared reservations and define how offline POS sales are handled before enabling stock-sensitive web actions. |
| Duplicate order/payment actions | Use idempotency keys, transactional state transitions, and append-only event records. |
| Sensitive credentials or payment proofs leak | Keep privileged secrets server-side; use private storage and short-lived authorized links. |
| Web and desktop schema drift | Review migrations centrally, preserve compatibility, and verify deployment order in staging. |

## Non-goals for the first release

- Replacing the Windows app or its offline capability
- Rebuilding every desktop screen before staff needs are validated
- Treating the browser as a direct client of the local SQLite database
- Enabling web POS or inventory mutations before cross-client stock consistency is solved

## Definition of done

The web app is ready for production use when staff can use the same account and branch permissions in both apps; server-side authorization and RLS are verified; supported changes are safe under retries and concurrency; offline desktop sync does not silently lose web changes; and staging, production deployment, monitoring, and rollback procedures are documented and tested.
