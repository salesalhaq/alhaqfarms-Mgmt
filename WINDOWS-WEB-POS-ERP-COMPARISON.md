# Windows and Web POS/ERP Comparison

**Reviewed scope:** `E:\ALhaqFM APP` and `E:\Alhaqfm Web`. `E:\Storefront` was used only as a database-integration reference. This is a source review, not a penetration test or live deployment audit. No application source files were changed.

## Executive summary

1. The Windows app is an Electron desktop client using React/Vite and local SQLite, designed to keep POS and ERP workflows available offline.
2. The management web app is Next.js/OpenNext on Cloudflare Workers, backed by Supabase; its cloud workflows require connectivity.
3. Both are intended to share staff identities and branch-scoped cloud data, rather than operate as independent Farm and Store databases.
4. The web app points to one Supabase project; the Windows setup guide directs operators to the project shared with the Storefront.
5. Branch scoping is not equivalent to separate Farm and Store databases. The required boundary remains undecided.
6. Web is stronger for centralized access and many online management workflows; Windows is stronger for offline checkout, direct hardware, and full local backup/restore.
7. Several web writes use transactional database functions, but some ERP and day-close workflows remain Windows-only.
8. FBR electronic submission is not implemented: Windows provides configuration/preview, and the web receipt QR is explicitly “not FBR verified.”
9. The Web production build passed. Windows tests ran 218 tests: 216 passed and 2 failed in Supabase migration-list expectations.
10. Recommendation: retain Windows as an offline-capable POS/hardware client and make Web the primary online management surface, after resolving data isolation and sync integrity.

## 1. Codebase map

| Area | Windows app | Management web app |
|---|---|---|
| Structure and stack | `src/` UI, `electron/` main/preload/business operations, `database/local/migrations/`, `database/supabase/`, `tests/`, and `docs/`. Electron, React 19, Vite, Node `node:sqlite`. | `app/` routes and APIs, `components/` workspaces, `lib/` business/server/print code, `supabase/migrations/` and Edge Functions. Next.js 15, React 18, OpenNext, Wrangler. |
| Data location | Each installation uses a local SQLite database under Electron’s per-user app-data directory. SQLite is the local source of truth; queued changes sync to Supabase. | Business data is in the configured Supabase project; Worker/API routes make authenticated, user-scoped requests. The checked-in Worker configuration names one Supabase project. |
| Auth and authorization | Local scrypt verifier supports offline sign-in; app checks roles and branches, and Supabase sync provides shared staff/device workflows. | Supabase Auth/session with `HttpOnly`, `SameSite=Lax` cookies; server-side staff, role, branch and same-origin checks, plus Supabase RLS. |
| API/IPC boundary | Renderer uses the named preload bridge; Electron main owns SQLite and operations. BrowserWindow has context isolation, sandboxing, and Node integration disabled. | Next.js route handlers authenticate and validate requests, then query Supabase or call database RPCs. |
| Printing and offline | Local thermal/A4/PDF printing, printer selection, barcode labels, TCP scale operations, and offline POS. | Browser printing/preview and CSV/PDF-style exports; optional local bridge supports some direct printing. No web service worker/offline POS was found in the inspected app source. |
| Build and release | `build` creates the UI; `build:win` creates a Windows NSIS installer. | `build` runs Next build; `deploy`/`upload` use OpenNext and Wrangler. |

### Database boundary

The desktop guide directs operators to the Supabase project shared with the Storefront, the web config points at one Supabase project, and the Storefront documents sharing that project with the desktop app. The Storefront also uses a separate `storefront` schema for some customer data while keeping `public.web_orders` shared. This is evidence of a shared project with some schema separation—not separate Farm and Store databases.

The user stated that Farm and Store are separate businesses, each with its own database, then clarified that the target boundary is undecided. The report therefore does not assume whether “separate database” means separate Supabase projects or strict logical isolation within one project. This decision should precede database or sync changes.

## 2. Feature parity matrix

| Module / feature | Windows | Web | Better version | Notes |
|---|---|---|---|---|
| Login and roles | Local offline credentials, staff roles and branch scoping; shared cloud enrollment/sync. | Shared staff identities with server-side role/branch checks. | Web for online access; Windows offline. | Both are clients within a shared staff/cloud arrangement, not isolated installations. |
| POS and sales | Local checkout, shifts, split tender, held bills and sales history; continues offline. | Cloud catalog/register/held-sale/discount/checkout workflows; transactional checkout RPC. | Windows offline/hardware; Web centralized online use. | Web checkout and inventory changes use server-side transactions. |
| Inventory and stock | Append-only local stock ledger, stocktakes, transfers and branch inventory; sync status matters. | Branch-scoped inventory and transactional transfer/receive flows. | Tie, depending on connectivity. | Desktop sync guide says conflict/business-rule parity still needs deployment acceptance testing. |
| Purchasing and vendors | Purchase orders, partial receipts and supplier payments are described as local workflows. | Web purchasing and vendor workflows exist, with transactional RPCs for supported actions. | Web for central visibility; Windows offline. | Confirm migrations are applied before enabling corresponding web actions. |
| Returns and refunds | Local return and refund workflows. | Current UI and migration include creation, approval/rejection, cancellation and completion. | Tie functionally; Windows offline. | Web README still says return mutations are disabled, which conflicts with current code. |
| Farm ERP and production | Animals, production, spices, bulk sales, farm stores and customer accounts are listed as local modules. | Web has transactional writes for several of these; README says other ERP writes remain Windows-only. | Windows for breadth/offline; Web for remote access. | Current web workspaces are substantial, but not full ERP parity. |
| Expenses | Store and farm expenses/categories. | Store expenses and supported ERP expense workflows. | Web for shared online visibility; Windows offline. | Scope and branch isolation still depend on the unresolved database-boundary decision. |
| Employees and payroll | Attendance, advances, payroll runs and local lifecycle controls. | Employee/attendance/advance/payroll actions; some tax/archive controls differ. | Tie for core pay calculation; Windows for offline. | Reviewed attendance-deduction and advance-recovery formulas match by inspection; no cross-implementation parity test was found. |
| Reports, A4/PDF/CSV | A4 report/PDF and local reports; daily close/Z-report are available in local app documentation. | Browser print/preview and CSV; PDF through browser print. Day close remains Windows-only. | Windows for close/operations; Web for remote viewing. | Report behavior should be tested report-by-report before assuming parity. |
| Receipts, QR and FBR | Thermal receipts and QR settings; FBR configuration/preview, but no electronic submission. | Browser receipt printing; QR is for order details and says “not FBR verified.” | Windows for local receipt hardware; neither for FBR submission. | FBR/PCT fields and categories are not the same as a live FBR integration. |
| Barcode/labels and hardware | CODE 128 labels, printer selection, scanner input, and TCP scale API. | Browser labels/printing; optional local bridge for some direct printing. No equivalent native scale integration was confirmed. | Windows. | Hardware remains the clearest Windows advantage. |
| Backup and restore | Whole SQLite database backup and validated restore. | Operational-data exports and cloud copies; docs say they are not a full database snapshot or one-click restore. | Windows for recovery today. | Web scheduled backups also require deployment configuration. |
| Settings and brand | Business settings can update window name/icon; fallback window name is hardcoded as `SAMNUH`. | Settings include business name/tagline/logo, but `BrandLockup` and PWA manifest still hardcode brand text/mark. | Neither fully meets “editable everywhere.” | Receipt settings are editable; visible web header and install metadata are not settings-driven. |
| Dashboard | Local/branch views. | Cloud-based overview and admin dashboards. | Web for consolidated online views. | A live-update/WebSocket guarantee was not confirmed. |
| Multi-user and branch access | Multiple devices through sync, branch assignment and role checks. | Browser-based multi-user access with branch-scoped data. | Web for access; Windows disconnected operation. | Multi-user cloud sync does not itself solve concurrent-write conflicts. |
| Search and language | POS barcode/search workflows; English UI observed. | Search/filter controls across workspace pages; English UI observed. | Web for workspace discovery; Windows for scanner workflow. | No Urdu translation or RTL mode was identified in the inspected source. |

## 3. Quality comparison and decision answers

| Dimension | Evidence-based assessment |
|---|---|
| UI/UX | Web has a broad workspace/navigation model suited to remote administration. Windows is a dedicated POS/ERP shell with direct device affordances. This was a source review, not a visual usability study, so it cannot objectively declare one “prettier.” |
| Speed | Windows avoids network latency for local POS operations. Web depends on browser-to-Worker/Supabase round trips. No performance benchmarks were run. |
| Security | Positive controls exist on both sides: Electron renderer isolation and guarded IPC; web HttpOnly cookies, server authorization, same-origin write checks and RLS. A local SQLite file is also a physical-device data exposure risk. This review did not prove the absence of vulnerabilities. |
| Data integrity | Both use transactional patterns for important flows. Web POS and some other workflows run through database RPCs. Windows uses local SQLite transactions and an outbox, but its own guide says sync conflict handling and parity still require acceptance testing. |
| Error handling | Windows exposes outbox errors/retries, which is valuable operationally but makes sync monitoring essential. Web validates requests and returns explicit errors; it also relies on separately applied database migrations. |
| Code quality and duplication | Both have meaningful modular boundaries. The same pricing, stock and payroll rules exist in separate implementations; duplicated rules can diverge. |
| Testability | Windows has a Node test suite: **216/218 passed**. The two failures are in `tests/supabase-schema.test.cjs`: expected migration inventory omits `0027_staff_pos_catalog.sql` and `0028_staff_daily_report.sql`. Web has build/typecheck scripts but no test script in its package manifest. |
| Deployment and updates | Web deploys centrally through Cloudflare/OpenNext; Windows requires installing/updating a desktop package per station. Installer build configuration exists, but an automatic update process was not established by this inspection. |
| Cost | Cannot honestly estimate from source: Cloudflare/Supabase plan, request volume, storage, backup retention and number of Windows stations determine cost. |
| Hardware and offline | Windows clearly wins for offline checkout, native printer discovery/printing, scale operations and local database recovery. Web wins for access from anywhere when connected; its optional print bridge is an added dependency, not equivalent to built-in offline hardware support. |

### Decision questions

**Do the versions share a database or diverge?**
The intended configuration is shared cloud data plus a separate SQLite copy on each Windows device. The management web app and desktop setup docs name the same Supabase project arrangement, and the Storefront documents shared project data. That reduces separate-system double entry, but creates sync/concurrency risk: offline desktop changes and online web actions must agree on conflict resolution. The web README explicitly leaves online-order mutations disabled until safe transaction and stale-sync protections exist.

**What can only the Windows app do well?**
Offline POS, native printer discovery/printing, scale communication, and complete local SQLite backup/restore.

**What can only the Web app do well?**
Centralized browser access, shared cloud visibility, and deploying changes without installing a new app on each PC. Continuous/offline-independent operation is not established.

**Should Windows become a wrapper, true offline client, or be retired?**
**Recommendation: keep Windows as an offline-capable client, not as a second full ERP authority and not as a pure web wrapper.** Keep checkout and hardware workflows available locally; make Web the primary online management/reporting surface. Over time, reduce duplicated workflows and share/test domain rules. Retiring Windows or making it dependent on Web would discard its clearest advantages.

## 4. Prioritized improvement plan

### A. Web app

| Priority | Work | Why | Files/areas | Effort |
|---|---|---|---|---|
| **P0** | Decide the Farm/Store data boundary, then design and test it before further rollout. Compare separate Supabase projects against strict logical tenant isolation. | Current setup is one cloud project with branch scope; branch scope alone does not establish the requested separate-database guarantee. | `wrangler.jsonc`, `supabase/migrations/`, Windows sync schema | L |
| **P1** | Keep order/payment mutations disabled until transactional authorization, idempotency, state transitions and conflict handling are complete and tested against desktop sync. | The README documents this as an intentional safety hold. | `README.md`, `app/api/workspace/` | L |
| **P1** | Add automated web tests for checkout, returns, transfers, payroll, tenant/branch authorization and concurrency; validate migrations against staging. | Build/typecheck is not enough for high-impact business rules; no web test script is defined. | `package.json`, `app/api/workspace/`, `supabase/migrations/` | L |
| **P1** | Close remaining web gaps: day close, remaining ERP write workflows, employee archive/restore and complete payroll/report parity; provide full restore strategy. | These are still documented as Windows-only or not full backups. | `README.md`, `app/api/workspace/admin-payroll/` | M–L |
| **P2** | Make the header logo/name/tagline and install metadata read from editable settings; reconcile README with current Returns implementation. | Branding still appears hardcoded in visible surfaces; the README contradicts Returns code. | `components/BrandLockup.tsx`, `app/manifest.ts`, `components/workspace/SettingsWorkspace.tsx`, `components/workspace/ReturnsWorkspace.tsx`, `README.md` | S–M |
| **P3** | Add Urdu/RTL support if required by staff workflow. | No translation/RTL implementation was identified. | `components/` | M–L |

### B. Windows app

| Priority | Work | Why | Files/areas | Effort |
|---|---|---|---|---|
| **P0** | Align local data, sync and authorization with the chosen Farm/Store boundary; test concurrent offline/online updates and recovery before treating sync as production-safe. | Each device has its own SQLite copy, while cloud data is shared; docs still call sync conflict handling unvalidated. | `database/supabase/README.md`, `electron/sync.cjs`, `database/local/migrations/` | L |
| **P1** | Update the Supabase schema tests to validate generated/current migrations, then get the suite fully green. | Current result is 216/218, with both failures caused by stale migration-list expectations. | `tests/supabase-schema.test.cjs`, `database/supabase/migrations/` | S |
| **P1** | Run a staged two-device sync acceptance test covering duplicate submits, partial failures, stale updates, stock transfers, returns, payroll and backup/restore. | Local transactions are strong, but cloud replay and concurrency are the risk boundary. | `electron/sync.cjs`, `electron/operations.cjs`, `electron/backup.cjs` | L |
| **P2** | Remove/replace the hardcoded `SAMNUH` fallback and verify all printed/UI brand surfaces use settings. | It conflicts with the “brand never hardcoded” requirement. | `electron/main.cjs`, `electron/operations.cjs` | S |
| **P2** | Clarify installer signing, distribution and update process; verify the generated installer on a clean Windows machine. | Build script exists, but this review did not verify release/update operations. | `package.json`, Electron release configuration | M |
| **P3** | Add Urdu/RTL only if it is a business requirement; finish remaining payslip/report polish as needed. | These are usability/parity improvements, not prerequisites to settle the data boundary. | `src/`, `docs/MODULE_MAP.md` | M |

### C. Shared business logic

- Establish one documented, tested rule set for money in paisa, quantity in milli-units, tax/discount rounding, stock movements, returns/refunds and payroll.
- Add differential tests that run equivalent inputs through Windows and web implementations. Payroll attendance and advance-recovery formulas look aligned by inspection, but that is not an automated parity guarantee.
- Define one stable idempotency and conflict strategy for writes made online and while offline.
- Version the shared schema and role/permission matrix; require the correct migration set before enabling each web workflow.

## 5. Recommended phase order

1. **Approve the database boundary and authority model.** The target is undecided. Compare separate Supabase projects (stronger isolation, more operational overhead) with one project using explicit Farm/Store tenancy and rigorously tested RLS (easier combined reporting, greater isolation-policy burden). Do not treat branches alone as proof of separate databases.
2. **Prove data integrity in staging.** Fix the two failing migration tests, then test two Windows devices plus Web under offline, retry, duplicate-submit and concurrent-update conditions; rehearse restore.
3. **Unify business rules and ownership.** Decide which workflows are cloud-authoritative and which must work locally; add cross-client parity tests before extending writes.
4. **Complete Web workflows safely.** Finish day close, missing ERP/HR/report actions and backup recovery; only then enable order/payment mutations.
5. **Retain Windows for offline POS and hardware.** Reduce duplicated admin workflows gradually rather than retiring the app or making it dependent on Web.
6. **Pilot and roll out.** Validate permissions, restore drills, printing, payroll and accounting totals with real branches before production expansion.

## Validation and limitations

- The Web production build passed.
- Windows `npm test` completed with 216/218 passing and two migration-inventory failures. The failures were in `tests/supabase-schema.test.cjs`.
- No Windows installer build, live cloud deployment, performance benchmark, or penetration test was performed.
- Findings reflect checked-in source and documentation. Cloud configuration and deployed migration state were not independently verified.

## Principal source files reviewed

### Windows app

- `E:\ALhaqFM APP\package.json`
- `E:\ALhaqFM APP\README.md`
- `E:\ALhaqFM APP\docs\MODULE_MAP.md`
- `E:\ALhaqFM APP\electron\main.cjs`
- `E:\ALhaqFM APP\electron\preload.cjs`
- `E:\ALhaqFM APP\electron\database.cjs`
- `E:\ALhaqFM APP\electron\operations.cjs`
- `E:\ALhaqFM APP\electron\sync.cjs`
- `E:\ALhaqFM APP\electron\backup.cjs`
- `E:\ALhaqFM APP\database\supabase\README.md`
- `E:\ALhaqFM APP\tests\supabase-schema.test.cjs`

### Management web app

- `E:\Alhaqfm Web\package.json`
- `E:\Alhaqfm Web\README.md`
- `E:\Alhaqfm Web\wrangler.jsonc`
- `E:\Alhaqfm Web\lib\server\staff-auth.ts`
- `E:\Alhaqfm Web\lib\server\write.ts`
- `E:\Alhaqfm Web\app\api\workspace\point-of-sale-checkout\route.ts`
- `E:\Alhaqfm Web\supabase\migrations\011_pos_checkout.sql`
- `E:\Alhaqfm Web\supabase\migrations\013_returns_workflow.sql`
- `E:\Alhaqfm Web\supabase\migrations\033_hr_payroll_web_actions.sql`
- `E:\Alhaqfm Web\components\workspace\PointOfSaleWorkspace.tsx`
- `E:\Alhaqfm Web\components\workspace\ReturnsWorkspace.tsx`
- `E:\Alhaqfm Web\components\workspace\SettingsWorkspace.tsx`
- `E:\Alhaqfm Web\components\BrandLockup.tsx`
- `E:\Alhaqfm Web\app\manifest.ts`

### Storefront reference only

- `E:\Storefront\README.md`
- `E:\Storefront\supabase\README.md`
