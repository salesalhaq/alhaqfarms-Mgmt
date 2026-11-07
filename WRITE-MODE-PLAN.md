# Web ↔ Desktop Parity Plan

## 1. Operating model (read this first)

The web app is the **primary client for every branch whenever the internet is available**.
The Windows app (`E:\ALHAQFM APP`) is the **offline fallback** only.

That changes the definition of "done":

- A screen is not done because it *reads* the same data.
- A screen is done only when **every button, dialog, validation rule, and side effect** of the desktop screen exists in the web app.
- Printing must produce the **same documents** as desktop: **A4 reports, 80mm receipts, barcode/weight labels**.
- Scale input must work **online** exactly as on desktop: **serial (Web Serial)** and **Ethernet TCP (local bridge)**, including **weight-embedded barcodes**.
- Anything the desktop keeps locally (business settings, FBR config, printer choice, discounts approval) must exist in the cloud so the web app can use it on any branch device.

The desktop app remains the reference for **behaviour and document layout**, not for "what is allowed to be missing".

## 2. Reference confirmation

Both reference projects were inspected.

### `E:\ALHAQFM APP` (Windows desktop — behavioural + document source of truth)

| Path | What it gives us |
| --- | --- |
| `electron/preload.cjs` | Full `window.posErp.*` IPC surface: ~120 write actions, exact names and input shapes. |
| `electron/operations.cjs` (504 KB) | Every write implementation: validation, `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, stock ledger, credit/loyalty/discount rules, audit events, weight-barcode code assignment. |
| `electron/sync-tables.cjs` | Sync tables, push order, append-only set, HQ-only set, write-role rules, idempotency columns. |
| `electron/report-documents.cjs` | Exact A4 report HTML/CSS, `@page` margin boxes, header/footer, page counters, orientation auto-selection. |
| `electron/report-print.cjs` | Report window lifecycle, PDF export, print pipeline. |
| `electron/scale-ipc.cjs` | Ethernet TCP scale socket lifecycle (`scale:tcp:*`). |
| `electron/main.cjs` (`print:receipt`, `print:labels`) | 80mm receipt print + `LABEL_PAGE_SIZES` + saved tag printer. |
| `src/index.css` | `@page` rules for receipts (`80mm auto`), labels, report sheets, `direct-label-print`. |
| `src/pages/*.jsx` | Screen order, button labels, tooltips, which action each screen exposes. |
| `database/supabase/schema.sql` (4,800 lines) | Cloud tables, 197 RLS policies, grants, append-only triggers, auth/staff RPCs. |

### `E:\storefront` (cloud-native transactional reference)

| Path | What it gives us |
| --- | --- |
| `app/api/orders/route.ts` | Same-origin check, server validation, rate limiting, Turnstile, idempotency, service client confined to server. |
| `supabase/migrations/005_web_order_creation_rpc.sql` | `SECURITY DEFINER` RPC pattern: `SET search_path`, stock re-check, idempotency key, `REVOKE ALL` / `GRANT EXECUTE`, atomic multi-table order creation. |

## 3. Key findings that drive the plan

1. **The cloud schema has no write RPCs today.** Only auth/staff/support/read RPCs exist (`bootstrap_first_cloud_admin`, `provision_cloud_staff`, `complete_staff_web_enrollment`, `get_staff_pos_catalog`, `get_staff_daily_report`, `get_staff_overview_metrics`, `cloud_health_check`).
2. **Single-table writes already work through RLS.** 197 policies grant `insert`/`update` to `authenticated` for most operational tables.
3. **Multi-table writes cannot be done safely with PostgREST.** A POS sale touches 8 tables; a purchase receipt touches 5; payroll generation touches 3. These need atomic Postgres functions.
4. **RLS is coarser than desktop action permissions.** Example: `returns_insert` allows any staff, but desktop requires a manager. The route/RPC must re-apply the desktop rule.
5. **Append-only tables reject update/delete at trigger level.** `stock_movements`, `audit_log`, `pos_sale_items`, `expenses`, `purchase_receipts`, `customer_invoices`, etc. Corrections are new compensating rows.
6. **Idempotency columns already exist:** `pos_sales.client_sale_id`, `returns.client_return_id`, `purchase_receipts.client_receipt_id`, `stock_movements.idempotency_key`, `supplier_returns.client_return_id`, `web_orders.idempotency_key`.
7. **Browsers cannot open raw TCP sockets.** Ethernet scales need a tiny local bridge (WebSocket ⇄ TCP). Serial scales use Web Serial. Both already have protocol helpers in `lib/scale-protocols.ts`.
8. **Browsers cannot print silently to a chosen device.** Browser print handles A4 and "choose printer"; exact silent 80mm/label output and printer discovery need the same local bridge (OS print API) or a print-server/kiosk mode.
9. **Several desktop tables are device-local only** (`business_settings`, `fbr_branch_settings`, `fbr_pct_categories`, `app_settings`, `units`, sync outbox). They must be promoted to cloud tables so the web client is not second-class.
10. **Weight-barcode assignment is currently desktop-only.** `BarcodeLabelsWorkspace` can generate EAN-13 but tells the user to assign the product code "in the desktop app". That gap must close in `saveProduct`.
11. **Desktop A4 reports use `@page` margin boxes and page counters**, which Chrome does not support. Exact parity needs a paginator (`paged.js`) or server-side PDF; the layout/CSS is otherwise portable.

## 4. Write architecture (unchanged, still correct)

Every web write follows one path:

```
workspace component
  -> POST /api/workspace/<module>   { action, payload, idempotencyKey }
  -> authenticateStaff()            (signed-in staff session, RLS-scoped client)
  -> isSameOriginRequest()          (CSRF guard)
  -> Zod validation                 (bounded body, typed payload)
  -> direct RLS write OR client.rpc('staff_<action>')
  -> audit event
  -> authenticationResponse()
```

### Shared server helpers (Phase 0 — done)

- `lib/server/write.ts` — body size cap, same-origin guard, validation, role gates, PostgREST error mapping, idempotency key helpers.
- `lib/server/audit.ts` — best-effort audit insert.
- `lib/workspace/write-client.ts` — browser POST helper + idempotency keys.
- `lib/workspace/use-workspace-action.ts` — pending/error/success state.
- `components/workspace/WorkspaceDialog.tsx` — dialog + field primitives.
- `app/api/workspace/categories/route.ts` — reference write endpoint.
- `components/workspace/ProductsWorkspace.tsx` — reference UI wiring (category dialog).

### RPC rules

- Name: `staff_<verb>_<entity>` (e.g. `staff_complete_sale`).
- `SECURITY INVOKER` by default so RLS still applies; `SECURITY DEFINER` only for controlled escalation.
- `SET search_path = pg_catalog, public`.
- Explicit guards: `is_staff()`, `is_manager_or_admin()`, `is_hq_admin()`, `has_branch_access(p_branch_id)`.
- `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon;` then `GRANT EXECUTE ... TO authenticated;`.
- Return `jsonb` with created ids and computed totals.
- Accept `p_idempotency_key` / `client_*_id`; return the existing row on retry.
- Migrations live in `E:\Alhaqfm Web\supabase\migrations\`.

---

## 5. Workstreams

The work is split into five tracks. They can run in any order, but the recommended order is **B → C → A1 → A2 → D → E** because print/scale can be verified without staff credentials and unblock daily branch use sooner.

### Track A — Writes

#### Phase A0 — Write foundation (COMPLETE, verified)

Exit met: `npm.cmd run typecheck` and `npm.cmd run build` pass; `categories` write is wired end-to-end.

#### Phase A1 — Direct single-table writes (RLS-backed)

| Module | Desktop actions | Table | Permission |
| --- | --- | --- | --- |
| Categories | `saveCategory` | `categories` | HQ admin |
| Products | `saveProduct` (incl. **weight-barcode code**) | `products` | HQ admin — web add/edit now saves product details and images; barcode-code assignment remains on the Barcode Labels workflow |
| Suppliers | `saveSupplier`, `setSupplierActive` | `suppliers` | HQ admin |
| Expense categories | `saveExpenseCategory` | `expense_categories` | HQ admin |
| HR departments | `saveHrDepartment`, `setHrDepartmentActive`, `assignStaffDepartment` | `hr_departments`, `staff_profiles` | HQ admin |
| Animal species | `saveAnimalSpecies`, `deleteAnimalSpecies` | `animal_species` | HQ admin |
| Branches | `saveBranch`, `setDefaultBranch` | `branches` | HQ admin |
| Staff profiles | `saveStaff`, `setStaffActive`, `archiveStaffProfile`, `restoreStaffProfile`, `permanentlyDeleteStaffProfile` | `staff_profiles` | HQ admin |
| Storefront settings | delivery areas, COD settings/areas, payment accounts (save/active/delete) | `storefront_*` | HQ admin |
| Permissions | `saveBranchModulePermissions`, `saveWebOrderPermissions`, `saveInventoryPermissions` | `*_permissions` | HQ admin |
| Customer accounts | `createPosCustomer`, `saveCustomerAccount`, `setCustomerActive` | `customer_accounts` | Manager+ |
| HR employees | `saveHrEmployee`, active/archive/restore/delete | `hr_employees` | Manager+ |
| Devices | `registerDevice`, `approveDevice`, `revokeDevice` | `devices` | Manager+ |
| Held sales | `saveHeldSale`, `resumeHeldSale`, `deleteHeldSale` | `pos_held_sales` | Staff |
| Single-parent actions | `cancelPurchaseOrder`, `recordSupplierPayment`, `recordExpense`, `recordBulkSalePayment`, `recordCustomerInvoice`, `recordCustomerPayment`, `closeAnimalBatch`, `voidPayrollRun`, `markPayrollRunPaid`, `setPayrollItemTax`, `saveStaffCompensation`, `recordAttendance`, `recordStaffAdvance`, `approveReturn`, `rejectReturn`, `cancelReturn`, `cancelTransfer`, `closeDay` | parent table + `audit_log` | per table |
| Cloud staff | `provisionCloudStaff` | existing `provision_cloud_staff` RPC | HQ admin |

Notes:
- Status updates = one table update + one audit insert; wrap in a tiny RPC when the audit row must be guaranteed.
- Soft deletes use `deleted_at`, matching desktop.
- `units` becomes read-only seeded reference data.
- **`saveProduct` must accept and persist the weight-barcode code** so labels no longer require desktop.

#### Phase A2 — Transactional RPCs (stock / cash / multi-row)

Each RPC mirrors the desktop `BEGIN IMMEDIATE` block: validate, re-check state, insert parent, insert children, write stock ledger, write audit, update source state, return totals.

**POS and shifts**

| Desktop action | Tables written | RPC |
| --- | --- | --- |
| `openShift` | `pos_shifts`, `audit_log` | `staff_open_shift` |
| `closeShift` | `pos_shifts`, `audit_log` | `staff_close_shift` |
| `recordShiftCashMovement` | `pos_shift_cash_movements`, `audit_log` | `staff_shift_cash_movement` |
| `completeSale` | `pos_sales`, `pos_sale_items`, `pos_sale_payments`, `stock_movements`, `customer_invoices`, `customer_payments`, `audit_log`, `pos_held_sales` | `staff_complete_sale` |
| `processWebOrder` | `web_orders`, `web_order_events`, `pos_sales`, `pos_sale_items`, `pos_sale_payments`, `stock_movements` | `staff_process_web_order` |

`staff_complete_sale` must reproduce: duplicate `client_sale_id`, active-product check, RAW-category block, price/discount limits, loyalty balance, credit limit, stock availability (unless negative stock allowed), tax-mode math, payment-total equality, receipt-number generation, audit details.

**Returns**

| Desktop action | Tables | RPC |
| --- | --- | --- |
| `createReturn` | `returns`, `return_items`, `audit_log` | `staff_create_return` |
| `completeReturn` | `returns`, `return_items`, `return_refunds`, `pos_sales`, `customer_payments`, `stock_movements`, `audit_log` | `staff_complete_return` |

`completeReturn` enforces per-item returnable quantity, manager-only rule, refund math, restock movements.

**Inventory / transfers / purchasing / payroll / ERP**

| Desktop action | RPC |
| --- | --- |
| `adjustStock` | `staff_adjust_stock` |
| `recordStocktake` | `staff_record_stocktake` |
| `createTransfer` | `staff_create_transfer` |
| `dispatchTransfer` | `staff_dispatch_transfer` |
| `receiveTransfer` | `staff_receive_transfer` |
| `receivePurchase` | `staff_receive_purchase` |
| `createPurchaseOrder` | `staff_create_purchase_order` |
| `receivePurchaseOrder` | `staff_receive_purchase_order` |
| `recordSupplierReturn` | `staff_record_supplier_return` |
| `generatePayrollRun` | `staff_generate_payroll_run` |
| `closeDay` | `staff_close_day` |
| `recordAnimalEvent` | `staff_record_animal_event` |
| `recordProductionRun` | `staff_record_production_run` |
| `createSpiceBatch` | `staff_create_spice_batch` |
| `completeSpiceBatch` | `staff_complete_spice_batch` |
| `recordBulkSale` | `staff_record_bulk_sale` |

#### Phase A3 — UI wiring (desktop parity)

Replace every disabled desktop control with a real dialog, in desktop screen order and with desktop labels/tooltips.

1. `ProductsWorkspace` — New/Edit product (incl. weight-barcode code), category save.
2. `VendorsWorkspace` — New/Edit supplier, activate/deactivate.
3. `CustomerAccountsWorkspace` — New/Edit account, activate/deactivate, invoice/payment.
4. `AdminExpensesWorkspace` — Record expense, category save. Web writes and HQ-category visibility are implemented; apply migration `009_expense_category_visibility.sql` before branch managers record expenses.
5. `InventoryWorkspace` — Adjust stock, record stocktake.
6. `PurchasingWorkspace` / `ReceiveStockWorkspace` — purchase order create/receive/cancel, direct receipt, supplier payment/return.
7. `TransfersWorkspace` — create/dispatch/receive/cancel.
8. `PointOfSaleWorkspace` — open/close shift, cash in/out, hold/resume, complete sale, discount approval.
9. `StoreOrdersWorkspace` — process order.
10. `ReturnsWorkspace` / `StoreReturnsWorkspace` — create/approve/reject/cancel/complete.
11. `AdminPayrollWorkspace` — generate/void/pay, compensation, attendance, advances, tax.
12. `ErpWorkspace` — animals, production, spice, bulk sales.
13. `SettingsWorkspace` — storefront settings, permissions, staff provisioning, printers/scale settings.
14. `StaffAccountsWorkspace` — staff profile lifecycle.
15. `DevicesWorkspace` — register/approve/revoke.

After each module: `npm.cmd run typecheck` and `npm.cmd run build`.

---

### Track B — Print parity (A4, receipts, labels)

Goal: the same three document families as desktop, from the web app.

#### B1 — Shared print core

- New `lib/print/document.ts`:
  - `reportDocumentHtml({ title, orientation, businessName, logo, columns, rows, totals, filters, generatedBy })` — port of `electron/report-documents.cjs`.
  - `receiptDocumentHtml(...)` — port of the desktop 80mm receipt markup.
  - `labelDocumentHtml(...)` — port of the desktop label markup.
- New `lib/print/print-window.ts`:
  - open a hidden/blank window, write the document, wait for images/fonts, call `print()`.
  - `exportPdf` via `print()` → "Save as PDF" fallback.
  - track `afterprint` to close the window.
- Port the desktop CSS verbatim into `app/print-documents.css` (imported only by print routes), including:
  - `@page { size: A4 portrait|landscape; margin: 16mm 12mm 18mm; }`
  - `@page { size: 80mm auto; margin: 4mm; }`
  - `@page { size: <label>; margin: 0; }`
  - `.report-page`, `.report-table`, `.report-header`, `.report-footer`, `.page-counter`.
- Because Chrome does not support `@page` margin boxes: add `paged.js` (or a small paginator) for the header/footer/page-counter parity, with a plain-CSS fallback if `paged.js` fails.

#### B2 — A4 reports

Replace the simple `TableDocumentTools` table snapshot with the desktop report document:

- `components/workspace/TableDocumentTools.tsx` → use `reportDocumentHtml` and the shared print window.
- `DailyReportWorkspace` (Z-report) → desktop daily-report layout.
- `ReportCenterWorkspace`, `SalesReportsWorkspace`, `ReturnReportsWorkspace`, `StockReportsWorkspace`, `ErpReports`, `ProfitTax`, `AuditLog` → desktop report layouts.
- Auto orientation: desktop rule `columns >= 8 || long field || weights*12 > 186 ? landscape : portrait`.
- Support `Auto / Portrait / Landscape` saved per report key (already partly in `TableDocumentTools`).
- Add: print, preview, CSV, PDF (desktop has the same four actions).

#### B3 — 80mm receipts

- Port desktop receipt markup/CSS (`@page { size: 80mm auto; margin: 4mm; }`, `--print-receipt-width: 72mm`, 9pt Arial).
- Wire to: sale receipt, return receipt, web-order receipt, purchase receipt, supplier return, payroll payslip (A4 payslip `@page` already exists in desktop CSS).
- Keep browser "choose printer" for now; silent printer selection comes with Track C bridge.

#### B4 — Barcode / weight labels

- Port `LABEL_PAGE_SIZES`: `100x50`, `80x50`, `75x50`, `60x40`, `50x30` (mm).
- Port `label-sheet`, `barcode-label`, `direct-label-print` CSS (one label per page for direct print).
- `BarcodeLabelsWorkspace`:
  - keep CODE128 + EAN-13 weight barcode generation (already present);
  - add weight-barcode code assignment in the product dialog (Track A1) and remove the "assign in desktop app" notice;
  - add "Choose printer" + "Print to tag printer" (bridge) actions like desktop;
  - enforce max 240 labels per sheet.

Exit for Track B: side-by-side screenshots of desktop vs web for one A4 report, one receipt, and one label sheet at each size.

---

### Track C — Scale + barcode parity (serial, Ethernet, local bridge)

Goal: online scale input works like desktop, with barcode/weight labels.

#### C1 — Serial scale (already partly built)

- `components/workspace/SerialScale.tsx` + `lib/scale-settings.ts` + `lib/scale-protocols.ts` already implement Web Serial, ASCII, Modbus RTU, unit conversion, stable reading.
- Finish parity:
  - port desktop scale settings screen fields and validation;
  - persist settings per branch/device (cloud + local fallback);
  - expose the scale panel in POS and Barcode Labels exactly where desktop does.

#### C2 — Ethernet TCP scale via local bridge

Browsers cannot open TCP. Ship a small **Alhaq Local Bridge** (Node/Electron tray app, or a packaged service):

- WebSocket server on `127.0.0.1` (configurable port), origin-checked to the web app.
- Commands mirror `scale-ipc.cjs`:
  - `scale:tcp:connect { id, host, port }`
  - `scale:tcp:send { id, data }`
  - `scale:tcp:disconnect { id }`
  - pushes `data` / `error` / `close` events back.
- Protocol support: ASCII and Modbus TCP (helpers already exist in `lib/scale-protocols.ts`: `buildModbusTcpRequest`, `parseModbusTcpFrame`).
- Web side: `lib/scale/bridge-client.ts` with reconnect, status, and a clear "bridge not running" error.
- `SerialScale` gets an Ethernet path that uses the bridge instead of throwing.
- Include bridge discovery/health endpoint so the UI can show "Local bridge: connected".

#### C3 — Weight barcodes end-to-end

- `saveProduct` persists `weightBarcodeCode` (Track A1).
- `BarcodeLabelsWorkspace` prints EAN-13 `product code + quantity` labels.
- POS scanning:
  - detect EAN-13 weight barcodes, resolve product by embedded code, apply embedded quantity;
  - match desktop `lookupWeightBarcode` / `getWeightBarcodeProductCode` semantics.
- Add barcode scanner support (keyboard-wedge) parity and a "scan to add" flow in POS.

#### C4 — Local bridge print channel (silent receipts/labels)

Extend the same bridge with print commands mirroring `print:receipt` and `print:labels`:

- list installed printers;
- silent print to a chosen receipt printer (copies, background);
- silent label print with exact page size + no margins;
- saved receipt/tag printer per branch/device.

Browser print remains the fallback when the bridge is absent.

Exit for Track C: live reading from a serial scale and an Ethernet scale; a scanned weight barcode adds the correct product + weight to the POS basket; a receipt and a label print silently through the bridge.

---

### Track D — Desktop-local settings promoted to cloud

Add cloud tables + RLS + RPCs so every branch device sees the same configuration:

| Desktop-local data | Cloud table | Used by |
| --- | --- | --- |
| `business_settings` | `business_settings` (per branch, HQ default) | receipts, reports, tax, printing |
| `fbr_branch_settings` | `fbr_branch_settings` | FBR PCT |
| `fbr_pct_categories` | `fbr_pct_categories` | FBR PCT |
| `app_settings` | `app_settings` (key/value, branch-scoped) | UI defaults, scale/printer prefs |
| `units` | `units` (seeded, read-only) | products, reports |
| `hr_tax_settings` | `hr_tax_settings` | payroll tax |
| `pos_discount_requests` | `pos_discount_requests` | manager discount approval across devices |
| printer/scale prefs | `device_settings` (per device) | bridge, printers, scale |
| sync outbox/errors | not needed online (desktop fallback only) | — |

Each table: `created_at`, `updated_at`, `updated_by`, branch scope, RLS (`is_staff` read, `is_hq_admin`/manager write), audit trigger. Migrations in `supabase/migrations/`.

Also seed `units` and default `business_settings` from the desktop defaults.

---

### Track E — Remaining full-function gaps (no "desktop-only" excuses)

Every item below gets a web equivalent. None stay disabled with "use the desktop app".

| Desktop feature | Web implementation |
| --- | --- |
| Local SQLite backup / restore / export JSON | Cloud backup: scheduled Postgres backups + "Export all data" (JSON/CSV ZIP) + "Import" with validation. Keep a "Download backup" button. |
| Backup schedule / backup folder | Server-side schedule + download; browser download folder is OS-managed. |
| LAN server / device pairing / CA export | Not needed online: replace with cloud **Devices** screen (register/approve/revoke) + staff enrollment. Keep a "Pair device" flow that issues an enrollment code. |
| Ethernet TCP scale | Track C bridge. |
| Printer discovery / silent receipt/label print | Track C bridge; browser print fallback. |
| FBR local configuration | Track D cloud tables + FBR PCT screen writes. |
| Business settings / app settings / units | Track D cloud tables. |
| Sync outbox / retry / errors | Desktop-only by design (offline fallback). Web shows cloud sync health from `cloud_health_check`. |
| Idle lock | Web idle timer + auto sign-out, same timeout setting. |
| App exit / fullscreen / machine info | Browser equivalents: sign out, Fullscreen API, device info from `navigator` + bridge. |
| Report folder selection / native report actions | Print/PDF/CSV downloads + "Open report in new tab" preview. |
| Discount approval across devices | Track D `pos_discount_requests` + realtime/polling. |

---

### Track F — Verification and rollout

1. Review every migration for RLS/grant correctness; apply to staging first.
2. Verify `SECURITY INVOKER` RPCs still see `auth.uid()` and enforce RLS.
3. Idempotency: submit the same sale/return/receipt twice → one row, same response.
4. Concurrency: two sessions complete the same sale → one succeeds.
5. Cross-branch denial: manager of branch A cannot write branch B.
6. Role denial: cashier cannot adjust stock, approve return, or generate payroll.
7. Print: compare desktop vs web A4/receipt/label output at every size.
8. Scale: serial + Ethernet live readings; weight barcode scan in POS.
9. Run `npm.cmd run typecheck` and `npm.cmd run build` (delete `.next`, `NODE_OPTIONS=--max-old-space-size=3072` if needed).
10. Smoke test on staging with real staff credentials, then production.

## 6. Migration index (to create)

| File | Track | Contents |
| --- | --- | --- |
| `001_write_rpcs_pos.sql` | A2 | shifts, sale, web order |
| `002_write_rpcs_returns.sql` | A2 | returns, refunds |
| `003_write_rpcs_inventory.sql` | A2 | adjust, stocktake, transfers |
| `004_write_rpcs_purchasing.sql` | A2 | receive, PO, supplier return |
| `005_write_rpcs_payroll_erp.sql` | A2 | payroll, day close, farm/ERP |
| `006_cloud_settings_tables.sql` | D | business/FBR/app/units/HR tax/device settings |
| `007_discount_requests.sql` | D | cross-device discount approval |
| `008_print_scale_device_settings.sql` | C/D | printer + scale prefs per device |

Each migration is applied manually by the user; the agent creates the file and states the apply step.

## 7. Immediate next step

Recommended order: **Track B (print) → Track C (scale/bridge) → A1 → A2 → D → E**, because print and scale are verifiable without staff credentials and make the web app usable at the counter immediately.

Ask the user to choose:

1. **Print parity first** — A4 reports, 80mm receipts, labels (recommended).
2. **Scale parity first** — serial + Ethernet bridge + weight barcodes.
3. **Writes first** — Phase A1 single-table writes, then A2 RPCs.
4. **Everything in parallel by track** — start B and C while A1 lands.

Whichever is chosen, complete it, run typecheck/build, and ask before the next track.
