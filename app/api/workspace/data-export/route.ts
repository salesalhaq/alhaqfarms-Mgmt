import { createClient } from "@supabase/supabase-js";
import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import type { StaffAuthentication } from "@/lib/server/staff-auth";
import { getServerEnvironment } from "@/lib/supabase/server-environment";
import type { Database } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 500;
const MAX_ROWS_PER_TABLE = 25_000;
const ID_BATCH_SIZE = 100;

async function authorizeScheduledExport(request: Request): Promise<StaffAuthentication | Response | null> {
  const providedSecret = request.headers.get("x-cloud-backup-secret");
  if (!providedSecret) return null;
  const environment = await getServerEnvironment();
  if (!environment.CLOUD_BACKUP_CRON_SECRET || providedSecret !== environment.CLOUD_BACKUP_CRON_SECRET) {
    return Response.json({ error: "Scheduled export authorization failed." }, { status: 403 });
  }
  if (!environment.NEXT_PUBLIC_SUPABASE_URL || !environment.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "Scheduled cloud backups are not configured." }, { status: 503 });
  }

  const parameters = new URL(request.url).searchParams;
  const ownerId = parameters.get("ownerId") || "";
  const branchIds = [...new Set((parameters.get("branchIds") || "").split(",").filter(Boolean))];
  if (!isUuid(ownerId) || !branchIds.length || branchIds.some((id) => !isUuid(id))) {
    return Response.json({ error: "Scheduled export scope is invalid." }, { status: 400 });
  }
  const client = createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const [staffResult, preferenceResult] = await Promise.all([
    client.from("cloud_staff")
      .select("user_id,local_staff_id,branch_id,email,full_name,role,is_active")
      .eq("user_id", ownerId)
      .maybeSingle(),
    client.from("web_data_backup_preferences")
      .select("branch_ids,frequency")
      .eq("owner_id", ownerId)
      .maybeSingle(),
  ]);
  if (staffResult.error || preferenceResult.error) {
    console.error("Could not verify scheduled export access.", staffResult.error || preferenceResult.error);
    return Response.json({ error: "Scheduled export access could not be verified." }, { status: 503 });
  }
  const staff = staffResult.data;
  const preference = preferenceResult.data;
  if (!staff?.is_active || (staff.role !== "admin" && staff.role !== "manager")
    || (staff.role !== "admin" && !staff.branch_id)
    || !preference || preference.frequency === "manual"
    || [...preference.branch_ids].sort().join(",") !== [...branchIds].sort().join(",")) {
    return Response.json({ error: "Scheduled export access is no longer valid." }, { status: 403 });
  }

  let branchQuery = client.from("branches")
    .select("id,code,name,is_active,deleted_at")
    .in("id", branchIds)
    .eq("is_active", true)
    .is("deleted_at", null);
  if (staff.branch_id) branchQuery = branchQuery.eq("id", staff.branch_id);
  const { data: branches, error: branchError } = await branchQuery;
  if (branchError || !branches || branches.length !== branchIds.length) {
    console.error("Could not verify scheduled export branches.", branchError);
    return Response.json({ error: "A scheduled export branch is no longer accessible." }, { status: 403 });
  }

  return {
    ok: true,
    client,
    identity: { staff, branches, canViewOrders: false, moduleAccess: {} },
    refreshedSession: null,
  };
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function pakistanDateBoundary(value: string, nextDay = false): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+05:00`).toISOString();
}

async function collectRows<T>(
  readPage: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  table: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await readPage(start, start + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not export ${table}: ${error.message}`);
    const page = data || [];
    if (rows.length + page.length > MAX_ROWS_PER_TABLE) {
      throw new Error(`${table} exceeds the ${MAX_ROWS_PER_TABLE.toLocaleString()}-row export limit. Narrow the date range and try again.`);
    }
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function collectRelatedRows<T>(
  ids: string[],
  readPage: (batch: string[], start: number, end: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  table: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += ID_BATCH_SIZE) {
    const batch = ids.slice(index, index + ID_BATCH_SIZE);
    const batchRows = await collectRows(
      (start, end) => readPage(batch, start, end),
      table,
    );
    if (rows.length + batchRows.length > MAX_ROWS_PER_TABLE) {
      throw new Error(`${table} exceeds the ${MAX_ROWS_PER_TABLE.toLocaleString()}-row export limit.`);
    }
    rows.push(...batchRows);
  }
  return rows;
}

export async function GET(request: Request) {
  const scheduledAuthentication = await authorizeScheduledExport(request);
  if (scheduledAuthentication instanceof Response) return scheduledAuthentication;
  const authentication = scheduledAuthentication || await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (!["admin", "manager"].includes(authentication.identity.staff.role)) {
    return authenticationResponse(request, authentication, { error: "Only administrators and managers can export operational data." }, 403);
  }

  const parameters = new URL(request.url).searchParams;
  const from = parameters.get("from") || "";
  const to = parameters.get("to") || "";
  const requestedBranch = parameters.get("branchId") || "";
  const requestedBranches = parameters.get("branchIds");
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    return authenticationResponse(request, authentication, { error: "Choose a valid date range." }, 400);
  }
  const rangeDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (rangeDays > 365) {
    return authenticationResponse(request, authentication, { error: "Choose a date range of no more than 366 days." }, 400);
  }
  const accessibleBranches = authentication.identity.branches;
  const requestedBranchIds = requestedBranches === null
    ? requestedBranch && requestedBranch !== "all" ? [requestedBranch] : null
    : requestedBranches.split(",").filter(Boolean);
  if ((requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch))
    || requestedBranchIds?.some((id) => !isUuid(id))) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }
  const branchIds = requestedBranchIds
    ? [...new Set(requestedBranchIds)].filter((id) => accessibleBranches.some((branch) => branch.id === id))
    : accessibleBranches.map((branch) => branch.id);
  if (requestedBranchIds && branchIds.length !== new Set(requestedBranchIds).size) {
    return authenticationResponse(request, authentication, { error: "A selected branch is not accessible to your account." }, 403);
  }
  if (!branchIds.length) {
    return authenticationResponse(request, authentication, { error: "No accessible branches were found for this export." }, 403);
  }

  try {
    const client = authentication.client;
    const startAt = pakistanDateBoundary(from);
    const endAt = pakistanDateBoundary(to, true);
    const [categories, products, sales, stockMovements, returns, expenses] = await Promise.all([
      collectRows((start, end) => client.from("categories")
        .select("id,name,description,sort_order,is_active,created_at,updated_at")
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "categories"),
      collectRows((start, end) => client.from("products")
        .select("id,category_id,name,sku,barcode,unit_code,price_paisa,on_sale,discounted_price_paisa,tax_rate_bps,min_stock_milli,reorder_point_milli,max_stock_milli,is_active,metadata_json,created_at,updated_at")
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "products"),
      collectRows((start, end) => client.from("pos_sales")
        .select("id,receipt_number,branch_id,shift_id,cashier_id,status,tax_mode,subtotal_paisa,item_discount_paisa,bill_discount_paisa,discount_paisa,tax_paisa,rounding_paisa,total_paisa,paid_paisa,due_paisa,change_paisa,loyalty_earned,loyalty_redeemed,customer_name,customer_phone,notes,completed_at,created_at,customer_account_id,loyalty_discount_paisa,source_type,source_order_id")
        .in("branch_id", branchIds)
        .gte("completed_at", startAt)
        .lt("completed_at", endAt)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "POS sales"),
      collectRows((start, end) => client.from("stock_movements")
        .select("id,branch_id,product_id,movement_type,quantity_delta_milli,reference_type,reference_id,occurred_at,notes")
        .in("branch_id", branchIds)
        .gte("occurred_at", startAt)
        .lt("occurred_at", endAt)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "stock movements"),
      collectRows((start, end) => client.from("returns")
        .select("id,return_number,branch_id,sale_id,shift_id,status,reason,notes,refund_total_paisa,restock_total_milli,created_by,approved_by,approved_at,rejected_by,rejected_at,rejection_reason,completed_by,completed_at,created_at,updated_at")
        .in("branch_id", branchIds)
        .gte("created_at", startAt)
        .lt("created_at", endAt)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "returns"),
      collectRows((start, end) => client.from("expenses")
        .select("id,branch_id,category_id,description,amount_paisa,payment_method,reference,notes,spent_at,recorded_by,created_at")
        .in("branch_id", branchIds)
        .gte("spent_at", startAt)
        .lt("spent_at", endAt)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "expenses"),
    ]);

    const saleIds = sales.map((sale) => sale.id);
    const returnIds = returns.map((record) => record.id);
    const [saleItems, salePayments, returnItems, returnRefunds] = await Promise.all([
      collectRelatedRows(saleIds, (batch, start, end) => client.from("pos_sale_items")
        .select("id,sale_id,line_number,product_id,product_name,sku,barcode,unit_code,quantity_milli,unit_price_paisa,discount_paisa,tax_rate_bps,tax_paisa,line_total_paisa,created_at")
        .in("sale_id", batch)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "POS sale items"),
      collectRelatedRows(saleIds, (batch, start, end) => client.from("pos_sale_payments")
        .select("id,sale_id,sequence_number,method,amount_paisa,tendered_paisa,reference,created_at")
        .in("sale_id", batch)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "POS sale payments"),
      collectRelatedRows(returnIds, (batch, start, end) => client.from("return_items")
        .select("id,return_id,sale_item_id,product_id,product_name,unit_code,quantity_milli,unit_price_paisa,line_refund_paisa,condition,restock,created_at")
        .in("return_id", batch)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "return items"),
      collectRelatedRows(returnIds, (batch, start, end) => client.from("return_refunds")
        .select("id,return_id,method,amount_paisa,credited_paisa,status,reference,processed_at,created_at")
        .in("return_id", batch)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(start, end), "return refunds"),
    ]);

    const branchRecords = accessibleBranches.filter((branch) => branchIds.includes(branch.id));
    const response = authenticationResponse(request, authentication, {
      format: "alhaqfarms-operational-export",
      version: 1,
      generatedAt: new Date().toISOString(),
      dateRange: { from, to, timezone: "Asia/Karachi" },
      branches: branchRecords,
      tables: { categories, products, sales, saleItems, salePayments, stockMovements, returns, returnItems, returnRefunds, expenses },
      counts: {
        categories: categories.length,
        products: products.length,
        sales: sales.length,
        saleItems: saleItems.length,
        salePayments: salePayments.length,
        stockMovements: stockMovements.length,
        returns: returns.length,
        returnItems: returnItems.length,
        returnRefunds: returnRefunds.length,
        expenses: expenses.length,
      },
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Content-Disposition", `attachment; filename="alhaq-operational-export-${from}-${to}.json"`);
    return response;
  } catch (error) {
    console.error("Could not export operational data.", error);
    return authenticationResponse(
      request,
      authentication,
      { error: error instanceof Error ? error.message : "Operational data export failed." },
      503,
    );
  }
}
