# Al Haq Farms Management

The online management client shares staff identities and branch-scoped data with the Windows app.

## Current milestone

- Mirrored the Windows app's navigation structure in the web workspace: Operations, Catalog & Stock, Store Portal, Admin, and Farm ERP.
- Added dashboard layouts, module page layouts, search/filter controls, and action affordances for the desktop modules. Dashboards, Sales, Returns, Daily report, online orders, order details, the POS catalog, and the Farm ERP modules use live read-only cloud data; the HQ product catalog also supports authorized product and category management.
- Staff enrollment with the HQ-issued invitation code.
- The same invitation is redeemable once on the web and once on the assigned Windows device; both setups must use the same password and optional PIN.
- Web login by staff username and shared password/PIN, or by an existing Supabase Auth email/password account.
- Active staff mapping through `public.cloud_staff`.
- Active branch resolution enforced by the existing Supabase RLS policies.
- Read-only online-order list, order details, event history, payment review states, and authorized signed links to private payment proofs.
- The Overview mirrors the desktop staff page with active product count, branch stock, today's sales, current shift, and shortcuts. Its exact summary metrics use a security-invoker RPC protected by the existing Supabase RLS policies.
- Point of sale uses a branch-scoped live catalog and transactional register, customer, held-sale, discount-approval, and checkout workflows. Tax mode, bill-discount caps, loyalty conversion, and negative-stock behavior are enforced by branch settings and the checkout RPC.
- Sales history includes date, status, customer, cashier, and branch filters, paginated receipts, itemized read-only details, and browser printing; queries remain within the signed-in user's existing RLS access.
- Returns & refunds provides date/status/branch filters, return item and refund details, and browser printing. Creating, approving, cancelling, and completing a refund remain disabled until their secure transactional workflow is implemented.
- Daily report mirrors the desktop business-date totals, payment/refund breakdowns, cash drawer, top products, shifts, and day-close records. Its branch/date filters and CSV export are read-only; day closing remains in the Windows app.
- Barcode labels load the live product catalogue, support category/search, quantity selection, CODE 128 labels, layout toggles, and browser printing. Direct tag-printer output and measured scale labels remain Windows-only until securely integrated.
- All rendered web tables have per-table AUTO/portrait/landscape settings, print and preview actions, and CSV/PDF actions. PDF opens the browser print dialog, where staff can choose Save as PDF; exports include the rows currently displayed (the current page for paginated lists).
- Other read-only dashboards show recent synchronized sales and returns, a 14-day sales trend, and—when permitted—storefront order and payment-review activity. Activity queries use the signed-in user's existing branch RLS scope and are limited to the latest 100 records per source.
- The Farm ERP modules are live read-only views for admin accounts: dashboard, animals, production, spice, bulk sales, vendors, farm stores, customer accounts, ERP expenses, and ERP reports. They reuse the existing RLS scope, support branch/search/status/date filters and read-only record details, and bound list and aggregate queries to recent records while labelling approximate totals. Creating or editing ERP records remains Windows-only.
- Order mutations are intentionally not enabled. Existing cloud update policies do not enforce the desktop action-permission matrix or its transactional stock/order lifecycle.

The Windows app keeps a local scrypt verifier so staff can sign in offline. Supabase stores a separate bcrypt verifier; plaintext passwords and PINs are not added to table sync or the desktop outbox.

## Mirrored workspace pages

After staff sign-in, the home page opens the Overview dashboard. The left navigation mirrors the desktop sections and routes modules under `/workspace/<module>`. Admin and Farm ERP navigation is shown only to admin accounts; cashier navigation omits manager-only purchasing, transfer, and stock-report entries. Online Orders continues to use its existing live, branch-scoped read-only pages.

Transfers supports draft creation, dispatch, cancellation, and per-line receipt confirmation. The Transfers and Receive Stock pages use a transactional, permission-checked RPC so source deductions, destination receipts, and audit events are atomic. Purchasing supports its web order and receipt workflows. These write workflows require their listed Supabase migrations to be applied before deployment.

The product catalog uses an authenticated RLS-scoped API; HQ administrators can add, edit, and soft-delete products, assign existing FBR PCT classifications, and manage categories. Categories cannot be deleted while active products still reference them; product/category changes are audited. Sales history uses an authenticated RLS-scoped API with 25-record pagination and read-only receipt details; returns uses the same branch-scoped pattern and caps its search window at 500 recent rows. Daily report uses a security-invoker, branch-scoped RPC for uncapped totals and exposes no write actions. Point of sale supports branch-scoped register operations and checkout with server-side validation. Farm ERP uses an admin-only, RLS-scoped read API with bounded lists, aggregate totals, filters, and record details; ERP writes remain in the Windows app. Modules not yet connected to an operational API remain previews; their visible controls do not change operational data until their workflows are implemented.

## Local development

1. Use Node.js 22 or newer.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the project's Supabase anon/publishable key. Set `STAFF_PIN_LOGIN_SECRET` to a long random secret; the same value must be configured for the Supabase Edge Functions. For local FBR credential storage, also set `FBR_CONFIG_ENCRYPTION_KEY` to a private 64-character hexadecimal key.
4. Run `npm run dev`, then open `http://localhost:3000`.
5. On first access, open **Redeem your HQ invite code**, enter the code, and create the password and optional PIN. Use the same values when redeeming the code on the assigned Windows device.

Supabase Auth tokens are held in `HttpOnly`, `SameSite=Lax` cookies. The browser never receives an access token, anon key, or service-role key. Same-origin API routes verify staff identity and issue user-scoped Supabase queries protected by the existing RLS policies.

## Supabase setup

Apply the forward migration to the existing Supabase project:

```text
E:\ALhaqFM APP\database\supabase\migrations\0025_shared_staff_web_credentials.sql
E:\ALhaqFM APP\database\supabase\migrations\0026_staff_overview_metrics.sql
E:\ALhaqFM APP\database\supabase\migrations\0027_staff_pos_catalog.sql
E:\ALhaqFM APP\database\supabase\migrations\0028_staff_daily_report.sql
E:\Alhaqfm Web\supabase\migrations\029_branch_tax_and_fbr_settings.sql
E:\Alhaqfm Web\supabase\migrations\030_web_cloud_backups.sql
E:\Alhaqfm Web\supabase\migrations\032_stock_transfer_workflow.sql
```

The web migration creates branch-scoped POS and FBR settings and updates checkout/held-sale validation. Apply it before deploying this version of the web app. Configure a separate 32-byte random key (64 hex characters) as `FBR_CONFIG_ENCRYPTION_KEY` in the Cloudflare Worker secret store before administrators save FBR credentials. For local development, use a different key in `.dev.vars`; do not commit real keys. A key rotation requires re-encrypting existing credentials before replacing the old key.

Migration `030_web_cloud_backups.sql` creates a private Storage bucket and owner-scoped backup metadata/preferences. Local backups are JSON business-data downloads and only run while the browser is open; they are not a full database snapshot or a one-click restore. Cloud copies are also operational-data exports, are private to the staff account that created them, and are retained for 90 days.

To enable scheduled cloud copies, deploy the Edge Function and install its 15-minute scheduler after migration 030:

1. Generate a long random `CLOUD_BACKUP_CRON_SECRET`. Set it as a Worker secret and as a Supabase Edge Function secret. Set `SUPABASE_SERVICE_ROLE_KEY` only as a Cloudflare Worker secret; never use either key in browser code or commit it.

   ```powershell
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name alhaqfarms-mgmt
   npx wrangler secret put CLOUD_BACKUP_CRON_SECRET --name alhaqfarms-mgmt
   supabase secrets set APP_BASE_URL="https://<your-management-worker-domain>" CLOUD_BACKUP_CRON_SECRET="<same-random-secret>" --project-ref osrzfwdeyznfvduizmgs
   ```

2. Deploy `cloud-data-backup` from this repository. The function configuration disables Supabase JWT verification only for this function; the function checks the private cron secret on every request.

   ```powershell
   supabase functions deploy cloud-data-backup --project-ref osrzfwdeyznfvduizmgs
   ```

3. In Supabase Vault, create secrets named `cloud_data_backup_function_url` with value `https://osrzfwdeyznfvduizmgs.supabase.co/functions/v1/cloud-data-backup` and `cloud_data_backup_cron_secret` with the same random secret. Then apply `031_schedule_cloud_data_backups.sql`. It schedules a check every 15 minutes; saved daily/weekly schedules run at or just after their configured Asia/Karachi time.

   ```text
   E:\Alhaqfm Web\supabase\migrations\031_schedule_cloud_data_backups.sql
   ```

Until these deployment steps are complete, manual local and cloud backups work, but saved automatic schedules will not run.

Migration `032_stock_transfer_workflow.sql` installs the atomic create/dispatch/receive/cancel RPC and the active branch lookup used by Transfers and Receive Stock. Apply it before deploying these transfer workflows. It does not depend on the optional backup scheduler setup in migration 031. Receipt confirmation is available from either page; only confirmed quantities are added to destination stock.

From `E:\ALhaqFM APP\database\supabase`, set the shared gateway secret and deploy these functions:

```powershell
supabase secrets set STAFF_PIN_LOGIN_SECRET="<long-random-secret>" --project-ref osrzfwdeyznfvduizmgs
supabase functions deploy staff-web-enroll --project-ref osrzfwdeyznfvduizmgs
supabase functions deploy staff-pin-login --project-ref osrzfwdeyznfvduizmgs
supabase functions deploy staff-credential-update --project-ref osrzfwdeyznfvduizmgs
```

The checked-in `config.toml` identifies the Supabase project and disables JWT gateway verification only for the two login functions; those functions independently verify the private gateway secret. `staff-credential-update` requires the caller's authenticated cloud staff JWT.

Put the same gateway secret in `.env.local` for Next.js development. For Wrangler preview/deployment, use a local `.dev.vars` file or set the Worker secret:

```powershell
npx wrangler secret put STAFF_PIN_LOGIN_SECRET
npx wrangler secret put FBR_CONFIG_ENCRYPTION_KEY --name alhaqfarms-mgmt
```

Never put this secret or a service-role key in browser code or commit it. The Supabase functions use the project-provided server-side service-role environment; the management Worker does not receive a service-role key.

The FBR settings page stores branch configuration and encrypts credentials at rest with AES-GCM. It does not submit invoices, verify FBR responses, or mark sales as FBR-verified.

## Shared credential flow

1. HQ syncs the active staff profile and issues an invitation from the Windows app.
2. The staff member redeems the code at `/enroll`, creates a password (10–200 characters), and optionally sets a 4–8 digit PIN. The web function creates or links the Supabase Auth account using that same password.
3. On the assigned Windows PC, the staff member redeems the same code and enters exactly the same password and optional PIN. Windows stores its own scrypt hashes locally; the database stores a separate bcrypt verifier.
4. Web sign-in supports staff username/password, staff username/PIN, and existing Supabase Auth email/password. All authorization still comes from the active `cloud_staff` mapping and RLS.

Each invitation expires after 24 hours and allows one web redemption and one Windows redemption. Issuing another invite revokes previous codes and starts a credential reset. Username must be unique among active staff profiles.

Changing the shared password or PIN from Windows requires an internet connection and the assigned cloud account. The Auth password and cloud verifier are updated together; a failed cloud operation leaves the local credential unchanged. The security version is incremented, so other devices will require HQ to issue a fresh invite before they can enroll the new credential. Offline sign-in continues with the last credential already enrolled on that device until it syncs.

## Cloudflare

- OpenNext Worker configuration is in `wrangler.jsonc`.
- Set the public anon key as a Worker secret:

  ```powershell
  npx wrangler secret put NEXT_PUBLIC_SUPABASE_ANON_KEY
  ```

- Set `STAFF_PIN_LOGIN_SECRET` as a Worker secret when enabling invite/login flows.
- Scheduled cloud backups also require `SUPABASE_SERVICE_ROLE_KEY` and `CLOUD_BACKUP_CRON_SECRET` as Worker secrets. They are used only by the server-side scheduled export route.
- Test a production-like build with `npm run preview`.
- Configure the `mgmt.alhaqfarms.com.pk` custom domain only after staging validation and DNS approval.
- Never expose the service-role key to browser code or source control.

## Shared identity and authorization

Supabase Auth `user.id` is matched to the self-visible row in `public.cloud_staff`. The app checks that staff row is active and loads branches through the existing authenticated RLS policies. A branch account is restricted to its assigned branch; the HQ admin can select among branches it can access. The browser does not submit a trusted role or branch assignment.

Payment-proof links are short-lived and requested using the authenticated Supabase session. The private Storage bucket's existing policy checks staff and branch access.

Before enabling order/payment writes, add and review a server-side database transaction/RPC that enforces the desktop web-order permission matrix, validates state transitions, writes the matching actor/event, and prevents stale desktop sync from overwriting newer web actions. Then test the same concurrent/offline scenarios against staging.
