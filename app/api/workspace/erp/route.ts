import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

type ErpClient = {
  from(table: string): any;
  rpc(name: string, args?: Record<string, unknown>): any;
};

type BranchLite = { id: string; name: string };
type ErpRow = Record<string, any>;

const ERP_MODULES = new Set([
  "erp-dashboard",
  "animals",
  "production",
  "spice",
  "bulk-sales",
  "vendors",
  "farm-stores",
  "customer-accounts",
  "erp-expenses",
  "erp-reports",
]);

const LIST_LIMIT = 100;
/* Supabase caps a single PostgREST response at 1,000 rows by default. */
const AGGREGATE_LIMIT = 1_000;
const CATALOG_PAGE_SIZE = 60;
const CATALOG_PRODUCT_CAP = 1_200;

function escapedSearch(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function quotedFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function schemaUnavailable(error: { code?: string; message?: string }): boolean {
  return error.code === "42P01"
    || error.code === "42703"
    || error.code === "PGRST200"
    || error.code === "PGRST204"
    || error.code === "PGRST205";
}

function erpError(error: { code?: string; message?: string }): string {
  if (schemaUnavailable(error)) {
    return "Farm ERP data is not available in Supabase yet. Apply the Farm ERP schema migrations and reload the Supabase API schema cache.";
  }
  return error.message || "Farm ERP records could not be loaded.";
}

function allowedBranch(branchId: string, branches: BranchLite[]): boolean {
  return branches.some((branch) => branch.id === branchId);
}

function addSearch(query: any, columns: string[], search: string): any {
  const pattern = quotedFilterValue(`%${escapedSearch(search)}%`);
  return query.or(columns.map((column) => `${column}.ilike.${pattern}`).join(","));
}

function branchNames(branches: BranchLite[]): Map<string, string> {
  return new Map(branches.map((branch) => [branch.id, branch.name]));
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && value === parsed.toISOString().slice(0, 10);
}

function startOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function todayKey(): string {
  return pakistanDay(new Date().toISOString());
}

function sum(rows: ErpRow[], key: string): number {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

/* Pakistan has no daylight saving time, so a fixed +05:00 offset is exact. */
function pakistanDateBoundary(value: string, nextDay = false): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+05:00`).toISOString();
}

function pakistanDay(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (value.length <= 10) return value.slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return new Date(parsed.getTime() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function loadBranches(client: ErpClient, branchId: string, names: Map<string, string>): Promise<BranchLite[]> {
  const { data } = await client
    .from("branches")
    .select("id,name")
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("name", { ascending: true });
  return (data || []).filter((branch: BranchLite) =>
    branchId === "all" || branch.id === branchId
  ).map((branch: BranchLite) => ({ id: branch.id, name: names.get(branch.id) || branch.name }));
}

/* ------------------------------------------------------------------ */
/* Animals                                                             */
/* ------------------------------------------------------------------ */

type ErpList = { rows: ErpRow[]; approximate: boolean };

async function loadAnimals(
  client: ErpClient,
  branchId: string,
  names: Map<string, string>,
  search: string,
  status: string,
): Promise<ErpList> {
  let query = client
    .from("animal_batches")
    .select("id,branch_id,name,species,species_id,batch_type,status,opening_heads,opening_date,opening_cost_paisa,notes,created_at,closed_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (branchId !== "all") query = query.eq("branch_id", branchId);
  if (status) query = query.eq("status", status);
  if (search) query = addSearch(query, ["name", "species", "notes"], search);

  const { data: batches, error } = await query;
  if (error) throw error;
  const rows = (batches || []) as ErpRow[];
  if (!rows.length) return { rows: [], approximate: false };

  const batchIds = rows.map((row) => row.id);
  const [statsResult, feedResult] = await Promise.all([
    client
      .from("animal_batch_events")
      .select("batch_id,event_type,heads_delta,amount_paisa,event_date")
      .in("batch_id", batchIds)
      .neq("event_type", "feed")
      .is("deleted_at", null)
      .limit(AGGREGATE_LIMIT),
    client
      .from("animal_batch_events")
      .select("batch_id,amount_paisa,quantity_milli,event_date")
      .in("batch_id", batchIds)
      .eq("event_type", "feed")
      .is("deleted_at", null)
      .limit(AGGREGATE_LIMIT),
  ]);
  if (statsResult.error) throw statsResult.error;
  if (feedResult.error) throw feedResult.error;

  const statsRows = (statsResult.data || []) as ErpRow[];
  const feedRows = (feedResult.data || []) as ErpRow[];
  const approximate = statsRows.length >= AGGREGATE_LIMIT || feedRows.length >= AGGREGATE_LIMIT;
  const aggregates = new Map<string, {
    delta: number; feedPaisa: number; feedQuantity: number; purchasePaisa: number;
    lastEventDate: string | null; eventCount: number;
  }>();
  const aggregateFor = (batchId: string) => aggregates.get(batchId) || {
    delta: 0, feedPaisa: 0, feedQuantity: 0, purchasePaisa: 0, lastEventDate: null, eventCount: 0,
  };
  for (const event of statsRows) {
    const aggregate = aggregateFor(event.batch_id);
    aggregate.delta += Number(event.heads_delta || 0);
    aggregate.eventCount += 1;
    if (!aggregate.lastEventDate || String(event.event_date) > aggregate.lastEventDate) {
      aggregate.lastEventDate = String(event.event_date);
    }
    if (event.event_type === "purchase") aggregate.purchasePaisa += Number(event.amount_paisa || 0);
    aggregates.set(event.batch_id, aggregate);
  }
  for (const event of feedRows) {
    const aggregate = aggregateFor(event.batch_id);
    aggregate.feedPaisa += Number(event.amount_paisa || 0);
    aggregate.feedQuantity += Number(event.quantity_milli || 0);
    aggregate.eventCount += 1;
    if (!aggregate.lastEventDate || String(event.event_date) > aggregate.lastEventDate) {
      aggregate.lastEventDate = String(event.event_date);
    }
    aggregates.set(event.batch_id, aggregate);
  }

  const decorated: ErpRow[] = rows.map((batch) => {
    const aggregate = aggregates.get(batch.id) || {
      delta: 0, feedPaisa: 0, feedQuantity: 0, purchasePaisa: 0, lastEventDate: null, eventCount: 0,
    };
    return {
      ...batch,
      branch_name: names.get(batch.branch_id) || "Branch",
      head_count: Number(batch.opening_heads || 0) + aggregate.delta,
      feed_paisa: aggregate.feedPaisa,
      feed_quantity_milli: aggregate.feedQuantity,
      purchase_paisa: Number(batch.opening_cost_paisa || 0) + aggregate.purchasePaisa,
      last_event_date: aggregate.lastEventDate,
      event_count: aggregate.eventCount,
    };
  });

  return {
    approximate,
    rows: decorated.sort((left, right) => {
      const statusOrder = (left.status === "open" ? 0 : 1) - (right.status === "open" ? 0 : 1);
      if (statusOrder !== 0) return statusOrder;
      return String(right.created_at).localeCompare(String(left.created_at));
    }),
  };
}

async function loadAnimalDetail(client: ErpClient, id: string, names: Map<string, string>) {
  const { data: batch, error } = await client
    .from("animal_batches")
    .select("id,branch_id,name,species,species_id,batch_type,status,opening_heads,opening_date,opening_cost_paisa,notes,created_at,closed_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!batch) return null;

  const { data: events, error: eventError } = await client
    .from("animal_batch_events")
    .select("id,event_date,event_type,heads_delta,quantity_milli,unit_cost_paisa,amount_paisa,notes,product_id,recorded_by,created_at")
    .eq("batch_id", id)
    .is("deleted_at", null)
    .order("event_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(AGGREGATE_LIMIT);
  if (eventError) throw eventError;

  const rawItems = (events || []) as ErpRow[];
  const productIds = [...new Set(rawItems.map((event) => event.product_id).filter((value): value is string => typeof value === "string"))];
  const actorIds = [...new Set(rawItems.map((event) => event.recorded_by).filter((value): value is string => typeof value === "string"))];
  const [productsResult, actorsResult] = await Promise.all([
    productIds.length
      ? client.from("products").select("id,name").in("id", productIds).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    actorIds.length
      ? client.from("staff_profiles").select("id,full_name").in("id", actorIds).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (productsResult.error) throw productsResult.error;
  if (actorsResult.error) throw actorsResult.error;
  const productNames = new Map<string, string>();
  const actorNames = new Map<string, string>();
  for (const product of (productsResult.data || []) as ErpRow[]) productNames.set(product.id, product.name);
  for (const actor of (actorsResult.data || []) as ErpRow[]) actorNames.set(actor.id, actor.full_name);
  const items: ErpRow[] = rawItems.map((event) => ({
    ...event,
    product_name: event.product_id ? productNames.get(event.product_id) || null : null,
    recorded_by_name: event.recorded_by ? actorNames.get(event.recorded_by) || null : null,
  }));
  const headCount = Number(batch.opening_heads || 0) + sum(items, "heads_delta");
  const feedItems = items.filter((event) => event.event_type === "feed");
  const purchaseItems = items.filter((event) => event.event_type === "purchase");
  return {
    record: { ...batch, branch_name: names.get(batch.branch_id) || "Branch" },
    items,
    summary: {
      headCount,
      mortality: items.filter((event) => event.event_type === "mortality")
        .reduce((total, event) => total + Math.abs(Number(event.heads_delta || 0)), 0),
      purchases: (Number(batch.opening_cost_paisa || 0) > 0 ? Number(batch.opening_heads || 0) : 0)
        + purchaseItems.reduce((total, event) => total + Number(event.heads_delta || 0), 0),
      purchasePaisa: Number(batch.opening_cost_paisa || 0) + sum(purchaseItems, "amount_paisa"),
      feedPaisa: sum(feedItems, "amount_paisa"),
      feedQuantityMilli: sum(feedItems, "quantity_milli"),
      lastEventDate: items[0]?.event_date || null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Production                                                          */
/* ------------------------------------------------------------------ */

async function loadProduction(
  client: ErpClient,
  branchId: string,
  names: Map<string, string>,
  search: string,
  from: string,
  to: string,
): Promise<ErpRow[]> {
  let query = client
    .from("production_runs")
    .select("id,branch_id,run_number,run_date,output_product_name,output_unit_code,output_quantity_milli,input_cost_paisa,labor_cost_paisa,other_cost_paisa,total_cost_paisa,process_type,animal_heads,animal_batch_id,notes,created_at")
    .is("deleted_at", null)
    .gte("run_date", from)
    .lte("run_date", to)
    .order("run_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (branchId !== "all") query = query.eq("branch_id", branchId);
  if (search) query = addSearch(query, ["run_number", "output_product_name", "notes"], search);

  const { data, error } = await query;
  if (error) throw error;
  return ((data || []) as ErpRow[]).map((run) => ({
    ...run,
    branch_name: names.get(run.branch_id) || "Branch",
  }));
}

async function loadProductionDetail(client: ErpClient, id: string, names: Map<string, string>) {
  const { data: run, error } = await client
    .from("production_runs")
    .select("id,branch_id,run_number,run_date,output_product_name,output_unit_code,output_quantity_milli,input_cost_paisa,labor_cost_paisa,other_cost_paisa,total_cost_paisa,unit_cost_paisa,process_type,animal_heads,animal_batch_id,notes,created_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!run) return null;

  const [inputsResult, outputsResult] = await Promise.all([
    client.from("production_inputs")
      .select("id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa")
      .eq("run_id", id).is("deleted_at", null).order("product_name", { ascending: true }).limit(AGGREGATE_LIMIT),
    client.from("production_outputs")
      .select("id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa")
      .eq("run_id", id).is("deleted_at", null).order("product_name", { ascending: true }).limit(AGGREGATE_LIMIT),
  ]);
  if (inputsResult.error) throw inputsResult.error;
  if (outputsResult.error) throw outputsResult.error;

  return {
    record: { ...run, branch_name: names.get(run.branch_id) || "Branch" },
    items: (inputsResult.data || []) as ErpRow[],
    secondaryItems: (outputsResult.data || []) as ErpRow[],
  };
}

/* ------------------------------------------------------------------ */
/* Spice                                                               */
/* ------------------------------------------------------------------ */

async function loadSpice(
  client: ErpClient,
  branchId: string,
  names: Map<string, string>,
  search: string,
  status: string,
  from: string,
  to: string,
): Promise<ErpRow[]> {
  let query = client
    .from("spice_batches")
    .select("id,branch_id,batch_number,name,batch_date,status,output_product_name,output_unit_code,grade,input_cost_paisa,labor_cost_paisa,other_cost_paisa,output_quantity_milli,notes,created_at,completed_at")
    .is("deleted_at", null)
    .gte("batch_date", from)
    .lte("batch_date", to)
    .order("batch_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (branchId !== "all") query = query.eq("branch_id", branchId);
  if (status) query = query.eq("status", status);
  if (search) query = addSearch(query, ["batch_number", "name", "output_product_name", "notes"], search);

  const { data, error } = await query;
  if (error) throw error;
  const rows: ErpRow[] = ((data || []) as ErpRow[]).map((batch) => ({
    ...batch,
    branch_name: names.get(batch.branch_id) || "Branch",
    total_cost_paisa: Number(batch.input_cost_paisa || 0)
      + Number(batch.labor_cost_paisa || 0)
      + Number(batch.other_cost_paisa || 0),
  }));
  return rows.sort((left, right) => {
    const statusOrder = (left.status === "open" ? 0 : 1) - (right.status === "open" ? 0 : 1);
    if (statusOrder !== 0) return statusOrder;
    return String(right.batch_date).localeCompare(String(left.batch_date));
  });
}

async function loadSpiceDetail(client: ErpClient, id: string, names: Map<string, string>) {
  const { data: batch, error } = await client
    .from("spice_batches")
    .select("id,branch_id,batch_number,name,batch_date,status,output_product_name,output_unit_code,grade,input_cost_paisa,labor_cost_paisa,other_cost_paisa,output_quantity_milli,unit_cost_paisa,notes,created_at,completed_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!batch) return null;

  const { data: inputs, error: inputError } = await client
    .from("spice_batch_inputs")
    .select("id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa")
    .eq("batch_id", id)
    .is("deleted_at", null)
    .order("product_name", { ascending: true })
    .limit(AGGREGATE_LIMIT);
  if (inputError) throw inputError;

  return {
    record: {
      ...batch,
      branch_name: names.get(batch.branch_id) || "Branch",
      total_cost_paisa: Number(batch.input_cost_paisa || 0)
        + Number(batch.labor_cost_paisa || 0)
        + Number(batch.other_cost_paisa || 0),
    },
    items: (inputs || []) as ErpRow[],
  };
}

/* ------------------------------------------------------------------ */
/* Bulk sales                                                          */
/* ------------------------------------------------------------------ */

async function loadBulkSales(
  client: ErpClient,
  branchId: string,
  names: Map<string, string>,
  search: string,
  from: string,
  to: string,
): Promise<ErpList> {
  let query = client
    .from("bulk_sales")
    .select("id,branch_id,invoice_number,sale_date,customer_name,customer_phone,subtotal_paisa,discount_paisa,total_paisa,notes,created_at")
    .is("deleted_at", null)
    .gte("sale_date", from)
    .lte("sale_date", to)
    .order("sale_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (branchId !== "all") query = query.eq("branch_id", branchId);
  if (search) query = addSearch(query, ["invoice_number", "customer_name", "customer_phone", "notes"], search);

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data || []) as ErpRow[];
  if (!rows.length) return { rows: [], approximate: false };

  const paymentsResult = await client
    .from("bulk_sale_payments")
    .select("sale_id,amount_paisa")
    .in("sale_id", rows.map((row) => row.id))
    .is("deleted_at", null)
    .limit(AGGREGATE_LIMIT);
  if (paymentsResult.error) throw paymentsResult.error;

  const paymentRows = (paymentsResult.data || []) as ErpRow[];
  const paid = new Map<string, number>();
  for (const payment of paymentRows) {
    paid.set(payment.sale_id, (paid.get(payment.sale_id) || 0) + Number(payment.amount_paisa || 0));
  }

  return {
    approximate: paymentRows.length >= AGGREGATE_LIMIT,
    rows: rows.map((sale) => {
      const paidPaisa = paid.get(sale.id) || 0;
      return {
        ...sale,
        branch_name: names.get(sale.branch_id) || "Branch",
        paid_paisa: paidPaisa,
        due_paisa: Number(sale.total_paisa || 0) - paidPaisa,
      };
    }),
  };
}

async function loadBulkSaleDetail(client: ErpClient, id: string, names: Map<string, string>) {
  const { data: sale, error } = await client
    .from("bulk_sales")
    .select("id,branch_id,invoice_number,sale_date,customer_name,customer_phone,subtotal_paisa,discount_paisa,total_paisa,notes,created_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!sale) return null;

  const [itemsResult, paymentsResult] = await Promise.all([
    client.from("bulk_sale_items")
      .select("id,product_id,product_name,unit_code,quantity_milli,unit_price_paisa,unit_cost_paisa,line_total_paisa")
      .eq("sale_id", id).is("deleted_at", null).order("product_name", { ascending: true }).limit(200),
    client.from("bulk_sale_payments")
      .select("id,method,amount_paisa,reference,notes,paid_at")
      .eq("sale_id", id).is("deleted_at", null).order("paid_at", { ascending: false }).limit(AGGREGATE_LIMIT),
  ]);
  if (itemsResult.error) throw itemsResult.error;
  if (paymentsResult.error) throw paymentsResult.error;

  const paidPaisa = sum((paymentsResult.data || []) as ErpRow[], "amount_paisa");
  return {
    record: {
      ...sale,
      branch_name: names.get(sale.branch_id) || "Branch",
      paid_paisa: paidPaisa,
      due_paisa: Number(sale.total_paisa || 0) - paidPaisa,
    },
    items: (itemsResult.data || []) as ErpRow[],
    payments: (paymentsResult.data || []) as ErpRow[],
  };
}

/* ------------------------------------------------------------------ */
/* Vendors                                                             */
/* ------------------------------------------------------------------ */

async function loadVendors(
  client: ErpClient,
  branchId: string,
  search: string,
  status: string,
): Promise<ErpList> {
  let query = client
    .from("suppliers")
    .select("id,name,contact_name,phone,email,address,notes,is_active,created_at")
    .is("deleted_at", null)
    .order("is_active", { ascending: false })
    .order("name", { ascending: true })
    .limit(LIST_LIMIT);
  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);
  if (search) query = addSearch(query, ["name", "contact_name", "phone", "email"], search);

  const { data: suppliers, error } = await query;
  if (error) throw error;
  const rows = (suppliers || []) as ErpRow[];
  if (!rows.length) return { rows: [], approximate: false };

  let receiptQuery = client
    .from("purchase_receipts")
    .select("id,supplier_id,branch_id,subtotal_paisa,received_at")
    .in("supplier_id", rows.map((row) => row.id))
    .is("deleted_at", null)
    .limit(AGGREGATE_LIMIT);
  if (branchId !== "all") receiptQuery = receiptQuery.eq("branch_id", branchId);
  const receiptResult = await receiptQuery;
  if (receiptResult.error) throw receiptResult.error;
  const receipts = (receiptResult.data || []) as ErpRow[];

  const payments = new Map<string, number>();
  const credits = new Map<string, number>();
  let paymentRows: ErpRow[] = [];
  let returnRows: ErpRow[] = [];
  if (receipts.length) {
    const [paymentResult, returnResult] = await Promise.all([
      client
        .from("supplier_payments")
        .select("receipt_id,amount_paisa")
        .in("receipt_id", receipts.map((receipt) => receipt.id))
        .is("deleted_at", null)
        .limit(AGGREGATE_LIMIT),
      client
        .from("supplier_returns")
        .select("receipt_id,total_paisa")
        .in("receipt_id", receipts.map((receipt) => receipt.id))
        .eq("disposition", "credit")
        .is("deleted_at", null)
        .limit(AGGREGATE_LIMIT),
    ]);
    if (paymentResult.error) throw paymentResult.error;
    if (returnResult.error) throw returnResult.error;
    paymentRows = (paymentResult.data || []) as ErpRow[];
    returnRows = (returnResult.data || []) as ErpRow[];
    for (const payment of paymentRows) {
      payments.set(payment.receipt_id, (payments.get(payment.receipt_id) || 0) + Number(payment.amount_paisa || 0));
    }
    for (const credit of returnRows) {
      credits.set(credit.receipt_id, (credits.get(credit.receipt_id) || 0) + Number(credit.total_paisa || 0));
    }
  }

  const bySupplier = new Map<string, {
    count: number; purchases: number; paid: number; returned: number; lastPurchaseAt: string | null;
  }>();
  for (const receipt of receipts) {
    const entry = bySupplier.get(receipt.supplier_id) || {
      count: 0, purchases: 0, paid: 0, returned: 0, lastPurchaseAt: null,
    };
    entry.count += 1;
    entry.purchases += Number(receipt.subtotal_paisa || 0);
    entry.paid += payments.get(receipt.id) || 0;
    entry.returned += credits.get(receipt.id) || 0;
    if (!entry.lastPurchaseAt || String(receipt.received_at) > entry.lastPurchaseAt) {
      entry.lastPurchaseAt = String(receipt.received_at);
    }
    bySupplier.set(receipt.supplier_id, entry);
  }

  return {
    approximate: receipts.length >= AGGREGATE_LIMIT || paymentRows.length >= AGGREGATE_LIMIT
      || returnRows.length >= AGGREGATE_LIMIT,
    rows: rows.map((supplier) => {
      const entry = bySupplier.get(supplier.id) || { count: 0, purchases: 0, paid: 0, returned: 0, lastPurchaseAt: null };
      return {
        ...supplier,
        purchase_count: entry.count,
        purchases_paisa: entry.purchases,
        paid_paisa: entry.paid,
        returned_paisa: entry.returned,
        balance_paisa: entry.purchases - entry.paid - entry.returned,
        last_purchase_at: entry.lastPurchaseAt,
      };
    }),
  };
}

async function loadVendorDetail(client: ErpClient, id: string, branchId: string) {
  const { data: supplier, error } = await client
    .from("suppliers")
    .select("id,name,contact_name,phone,email,address,notes,is_active,created_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!supplier) return null;

  let receiptQuery = client
    .from("purchase_receipts")
    .select("id,branch_id,supplier_invoice_number,purchase_order_id,subtotal_paisa,notes,received_at")
    .eq("supplier_id", id)
    .is("deleted_at", null)
    .order("received_at", { ascending: false })
    .limit(AGGREGATE_LIMIT);
  if (branchId !== "all") receiptQuery = receiptQuery.eq("branch_id", branchId);
  const receiptResult = await receiptQuery;
  if (receiptResult.error) throw receiptResult.error;
  const receipts = (receiptResult.data || []) as ErpRow[];

  const payments = new Map<string, number>();
  const credits = new Map<string, number>();
  if (receipts.length) {
    const [paymentResult, returnResult] = await Promise.all([
      client.from("supplier_payments")
        .select("receipt_id,amount_paisa")
        .in("receipt_id", receipts.map((receipt) => receipt.id))
        .is("deleted_at", null)
        .limit(AGGREGATE_LIMIT),
      client.from("supplier_returns")
        .select("receipt_id,total_paisa")
        .in("receipt_id", receipts.map((receipt) => receipt.id))
        .eq("disposition", "credit")
        .is("deleted_at", null)
        .limit(AGGREGATE_LIMIT),
    ]);
    if (paymentResult.error) throw paymentResult.error;
    if (returnResult.error) throw returnResult.error;
    for (const payment of (paymentResult.data || []) as ErpRow[]) {
      payments.set(payment.receipt_id, (payments.get(payment.receipt_id) || 0) + Number(payment.amount_paisa || 0));
    }
    for (const credit of (returnResult.data || []) as ErpRow[]) {
      credits.set(credit.receipt_id, (credits.get(credit.receipt_id) || 0) + Number(credit.total_paisa || 0));
    }
  }

  return {
    record: supplier,
    items: receipts.map((receipt) => {
      const paidPaisa = payments.get(receipt.id) || 0;
      const returnedPaisa = credits.get(receipt.id) || 0;
      return {
        ...receipt,
        paid_paisa: paidPaisa,
        returned_paisa: returnedPaisa,
        due_paisa: Number(receipt.subtotal_paisa || 0) - paidPaisa - returnedPaisa,
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Farm stores                                                         */
/* ------------------------------------------------------------------ */

async function branchCatalogValue(client: ErpClient, branchId: string): Promise<{
  valuePaisa: number | null;
  productCount: number | null;
  complete: boolean;
}> {
  const products: { id: string; stock_milli: number }[] = [];
  let total: number | null = null;
  let offset = 0;

  while (offset < (total ?? Number.POSITIVE_INFINITY) && offset < CATALOG_PRODUCT_CAP) {
    const { data, error } = await client.rpc("get_staff_pos_catalog", {
      p_branch_id: branchId,
      p_search: "",
      p_category_id: null,
      p_limit: CATALOG_PAGE_SIZE,
      p_offset: offset,
    });
    if (error) return { valuePaisa: null, productCount: null, complete: false };
    const page = (data || []) as ErpRow[];
    if (!page.length) {
      total = total ?? 0;
      break;
    }
    total = Number(page[0].total_count || 0);
    for (const product of page) {
      products.push({ id: product.id, stock_milli: Number(product.stock_milli || 0) });
    }
    if (page.length < CATALOG_PAGE_SIZE) break;
    offset += page.length;
  }

  const productIds = products.map((product) => product.id);
  const costs = new Map<string, number>();
  for (let index = 0; index < productIds.length; index += 500) {
    const { data, error } = await client
      .from("products")
      .select("id,cost_price_paisa")
      .in("id", productIds.slice(index, index + 500))
      .is("deleted_at", null);
    if (error) return { valuePaisa: null, productCount: products.length, complete: false };
    for (const product of (data || []) as ErpRow[]) costs.set(product.id, Number(product.cost_price_paisa || 0));
  }

  const valueMilliPaisa = products.reduce(
    (totalValue, product) => totalValue + Math.max(product.stock_milli, 0) * (costs.get(product.id) || 0),
    0,
  );
  return {
    valuePaisa: Math.round(valueMilliPaisa / 1000),
    productCount: total ?? products.length,
    complete: products.length >= (total ?? products.length),
  };
}

async function loadFarmStores(
  client: ErpClient,
  branchId: string,
  search: string,
  status: string,
  today: string,
): Promise<ErpList> {
  let query = client
    .from("branches")
    .select("id,code,name,address,phone,email,timezone,receipt_prefix,is_active,is_default,created_at")
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("is_active", { ascending: false })
    .order("name", { ascending: true });
  if (branchId !== "all") query = query.eq("id", branchId);
  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);
  if (search) query = addSearch(query, ["name", "code", "address", "phone"], search);

  const { data, error } = await query;
  if (error) throw error;
  const branches = (data || []) as ErpRow[];
  if (!branches.length) return { rows: [], approximate: false };
  const ids = branches.map((branch) => branch.id);

  const salesStart = pakistanDateBoundary(today);
  const [salesResult, staffResult, ...closeResults] = await Promise.all([
    client.from("pos_sales")
      .select("branch_id,total_paisa")
      .in("branch_id", ids)
      .neq("status", "void")
      .gte("completed_at", salesStart)
      .is("deleted_at", null)
      .limit(AGGREGATE_LIMIT),
    client.from("staff_profiles")
      .select("branch_id,is_active")
      .in("branch_id", ids)
      .eq("is_active", true)
      .is("deleted_at", null)
      .limit(AGGREGATE_LIMIT),
    ...ids.map((id) => client.from("day_closes")
      .select("branch_id,business_date,difference_paisa,closed_at")
      .eq("branch_id", id)
      .is("deleted_at", null)
      .order("closed_at", { ascending: false })
      .limit(1)),
  ]);

  const sales = salesResult.error ? [] : ((salesResult.data || []) as ErpRow[]);
  const closes = closeResults.flatMap((result) => result.error ? [] : ((result.data || []) as ErpRow[]));
  const staff = staffResult.error ? [] : ((staffResult.data || []) as ErpRow[]);

  const salesByBranch = new Map<string, { receipts: number; total: number }>();
  for (const sale of sales) {
    const entry = salesByBranch.get(sale.branch_id) || { receipts: 0, total: 0 };
    entry.receipts += 1;
    entry.total += Number(sale.total_paisa || 0);
    salesByBranch.set(sale.branch_id, entry);
  }
  const closeByBranch = new Map<string, ErpRow>();
  for (const close of closes) {
    if (!closeByBranch.has(close.branch_id)) closeByBranch.set(close.branch_id, close);
  }
  const staffByBranch = new Map<string, number>();
  for (const member of staff) {
    staffByBranch.set(member.branch_id, (staffByBranch.get(member.branch_id) || 0) + 1);
  }

  const canValue = branchId !== "all";
  const valuation = canValue ? await branchCatalogValue(client, branchId) : null;

  return {
    approximate: sales.length >= AGGREGATE_LIMIT
      || staff.length >= AGGREGATE_LIMIT
      || Boolean(canValue && valuation && !valuation.complete),
    rows: branches.map((branch) => {
      const branchSales = salesByBranch.get(branch.id) || { receipts: 0, total: 0 };
      const close = closeByBranch.get(branch.id);
      return {
        ...branch,
        active_staff: staffByBranch.get(branch.id) || 0,
        products: canValue ? valuation?.productCount ?? 0 : null,
        stock_value_paisa: canValue ? valuation?.valuePaisa ?? null : null,
        stock_value_available: canValue && valuation?.valuePaisa !== null,
        stock_value_complete: canValue ? Boolean(valuation?.complete) : false,
        sales_receipts: branchSales.receipts,
        sales_paisa: branchSales.total,
        last_close: close
          ? { business_date: close.business_date, difference_paisa: close.difference_paisa, closed_at: close.closed_at }
          : null,
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Customer accounts                                                   */
/* ------------------------------------------------------------------ */

async function customerBalances(
  client: ErpClient,
  accountIds: string[],
): Promise<{ balances: Map<string, {
  invoiceCount: number; invoiced: number; paid: number; credited: number; lastActivity: string | null;
}>; approximate: boolean }> {
  const balances = new Map<string, {
    invoiceCount: number; invoiced: number; paid: number; credited: number; lastActivity: string | null;
  }>();
  const empty = { balances, approximate: false };
  if (!accountIds.length) return empty;

  const [invoiceResult, paymentResult] = await Promise.all([
    client.from("customer_invoices")
      .select("account_id,amount_paisa,invoice_date")
      .in("account_id", accountIds)
      .is("deleted_at", null)
      .limit(AGGREGATE_LIMIT),
    client.from("customer_payments")
      .select("account_id,amount_paisa,method,paid_at")
      .in("account_id", accountIds)
      .is("deleted_at", null)
      .limit(AGGREGATE_LIMIT),
  ]);
  if (invoiceResult.error) throw invoiceResult.error;
  if (paymentResult.error) throw paymentResult.error;

  const invoiceRows = (invoiceResult.data || []) as ErpRow[];
  const paymentRows = (paymentResult.data || []) as ErpRow[];
  for (const invoice of invoiceRows) {
    const entry = balances.get(invoice.account_id) || {
      invoiceCount: 0, invoiced: 0, paid: 0, credited: 0, lastActivity: null,
    };
    entry.invoiceCount += 1;
    entry.invoiced += Number(invoice.amount_paisa || 0);
    if (!entry.lastActivity || String(invoice.invoice_date) > entry.lastActivity) {
      entry.lastActivity = String(invoice.invoice_date);
    }
    balances.set(invoice.account_id, entry);
  }
  for (const payment of paymentRows) {
    const entry = balances.get(payment.account_id) || {
      invoiceCount: 0, invoiced: 0, paid: 0, credited: 0, lastActivity: null,
    };
    if (payment.method === "credit") entry.credited += Number(payment.amount_paisa || 0);
    else entry.paid += Number(payment.amount_paisa || 0);
    const paidAt = pakistanDay(payment.paid_at);
    if (paidAt && (!entry.lastActivity || paidAt > entry.lastActivity)) entry.lastActivity = paidAt;
    balances.set(payment.account_id, entry);
  }
  return {
    balances,
    approximate: invoiceRows.length >= AGGREGATE_LIMIT || paymentRows.length >= AGGREGATE_LIMIT,
  };
}

async function loadCustomerAccounts(
  client: ErpClient,
  branchId: string,
  names: Map<string, string>,
  search: string,
  status: string,
): Promise<ErpList> {
  let query = client
    .from("customer_accounts")
    .select("id,branch_id,name,phone,email,address,credit_limit_paisa,notes,is_active,created_at,updated_at")
    .is("deleted_at", null)
    .order("is_active", { ascending: false })
    .order("name", { ascending: true })
    .limit(LIST_LIMIT);
  if (branchId !== "all") query = query.eq("branch_id", branchId);
  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);
  if (search) query = addSearch(query, ["name", "phone", "email"], search);

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data || []) as ErpRow[];
  if (!rows.length) return { rows: [], approximate: false };

  const result = await customerBalances(client, rows.map((row) => row.id));
  const balances = result.balances;
  return {
    approximate: result.approximate,
    rows: rows.map((account) => {
      const entry = balances.get(account.id) || {
        invoiceCount: 0, invoiced: 0, paid: 0, credited: 0, lastActivity: null,
      };
      const balance = entry.invoiced - entry.paid - entry.credited;
      return {
        ...account,
        branch_name: names.get(account.branch_id) || "Branch",
        invoice_count: entry.invoiceCount,
        invoiced_paisa: entry.invoiced,
        paid_paisa: entry.paid,
        credited_paisa: entry.credited,
        balance_paisa: balance,
        over_limit: Number(account.credit_limit_paisa || 0) > 0 && balance > Number(account.credit_limit_paisa || 0),
        last_activity: entry.lastActivity,
      };
    }),
  };
}

async function loadCustomerDetail(client: ErpClient, id: string, names: Map<string, string>) {
  const { data: account, error } = await client
    .from("customer_accounts")
    .select("id,branch_id,name,phone,email,address,credit_limit_paisa,notes,is_active,created_at,updated_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!account) return null;

  const [invoiceResult, paymentResult] = await Promise.all([
    client.from("customer_invoices")
      .select("id,invoice_number,invoice_date,description,amount_paisa,notes,created_at")
      .eq("account_id", id).is("deleted_at", null).order("invoice_date", { ascending: false }).limit(AGGREGATE_LIMIT),
    client.from("customer_payments")
      .select("id,method,amount_paisa,reference,notes,paid_at")
      .eq("account_id", id).is("deleted_at", null).order("paid_at", { ascending: false }).limit(AGGREGATE_LIMIT),
  ]);
  if (invoiceResult.error) throw invoiceResult.error;
  if (paymentResult.error) throw paymentResult.error;

  const invoices = (invoiceResult.data || []) as ErpRow[];
  const payments = (paymentResult.data || []) as ErpRow[];
  const invoiced = sum(invoices, "amount_paisa");
  const credited = payments.filter((payment) => payment.method === "credit").reduce(
    (total, payment) => total + Number(payment.amount_paisa || 0), 0,
  );
  const paid = payments.filter((payment) => payment.method !== "credit").reduce(
    (total, payment) => total + Number(payment.amount_paisa || 0), 0,
  );
  const balance = invoiced - paid - credited;

  return {
    record: { ...account, branch_name: names.get(account.branch_id) || "Branch" },
    items: invoices,
    payments,
    summary: {
      invoicedPaisa: invoiced,
      paidPaisa: paid,
      creditedPaisa: credited,
      balancePaisa: balance,
      creditLimitPaisa: Number(account.credit_limit_paisa || 0),
      overLimit: Number(account.credit_limit_paisa || 0) > 0
        && balance > Number(account.credit_limit_paisa || 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

async function loadExpenses(
  client: ErpClient,
  branchId: string,
  names: Map<string, string>,
  search: string,
  categoryId: string,
  from: string,
  to: string,
): Promise<{ rows: ErpRow[]; categories: BranchLite[] }> {
  let query = client
    .from("expenses")
    .select("id,branch_id,category_id,description,amount_paisa,payment_method,reference,notes,spent_at,created_at")
    .is("deleted_at", null)
    .gte("spent_at", pakistanDateBoundary(from))
    .lt("spent_at", pakistanDateBoundary(to, true))
    .order("spent_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (branchId !== "all") query = query.eq("branch_id", branchId);
  if (categoryId && isUuid(categoryId)) query = query.eq("category_id", categoryId);
  if (search) query = addSearch(query, ["description", "reference", "notes"], search);

  const [expenseResult, categoryResult] = await Promise.all([
    query,
    client.from("expense_categories").select("id,name").is("deleted_at", null).order("name", { ascending: true }).limit(500),
  ]);
  if (expenseResult.error) throw expenseResult.error;

  const categoryRows = categoryResult.error ? [] : ((categoryResult.data || []) as BranchLite[]);
  const categoryNames = new Map(categoryRows.map((category) => [category.id, category.name]));
  return {
    rows: ((expenseResult.data || []) as ErpRow[]).map((expense) => ({
      ...expense,
      branch_name: names.get(expense.branch_id) || "Branch",
      category_name: categoryNames.get(expense.category_id) || "Uncategorized",
    })),
    categories: categoryRows,
  };
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

async function loadDashboard(
  client: ErpClient,
  branchId: string,
  monthStart: string,
  monthEnd: string,
  trendStart: string,
  today: string,
) {
  const scoped = (query: any) => branchId === "all" ? query : query.eq("branch_id", branchId);

  const [
    openBatchResult,
    monthOpeningResult,
    monthEventsResult,
    productionResult,
    spiceResult,
    bulkMonthResult,
    allBulkResult,
    bulkPaymentsResult,
  ] = await Promise.all([
    scoped(client.from("animal_batches")
      .select("id,opening_heads,opening_cost_paisa,opening_date")
      .eq("status", "open").is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("animal_batches")
      .select("opening_heads,opening_cost_paisa,opening_date")
      .gte("opening_date", monthStart).lte("opening_date", monthEnd)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("animal_batch_events")
      .select("event_type,heads_delta,amount_paisa,event_date")
      .gte("event_date", monthStart).lte("event_date", monthEnd)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("production_runs")
      .select("total_cost_paisa")
      .gte("run_date", monthStart).lte("run_date", monthEnd)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("spice_batches")
      .select("status,completed_at,input_cost_paisa,labor_cost_paisa,other_cost_paisa")
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("bulk_sales")
      .select("total_paisa")
      .gte("sale_date", monthStart).lte("sale_date", monthEnd)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("bulk_sales")
      .select("id,total_paisa").is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("bulk_sale_payments")
      .select("sale_id,amount_paisa").is("deleted_at", null).limit(AGGREGATE_LIMIT)),
  ]);

  const openBatches = openBatchResult.error ? [] : ((openBatchResult.data || []) as ErpRow[]);
  const monthOpenings = monthOpeningResult.error ? [] : ((monthOpeningResult.data || []) as ErpRow[]);
  const monthEvents = monthEventsResult.error ? [] : ((monthEventsResult.data || []) as ErpRow[]);
  const production = productionResult.error ? [] : ((productionResult.data || []) as ErpRow[]);
  const spice = spiceResult.error ? [] : ((spiceResult.data || []) as ErpRow[]);
  const bulkMonth = bulkMonthResult.error ? [] : ((bulkMonthResult.data || []) as ErpRow[]);
  const allBulk = allBulkResult.error ? [] : ((allBulkResult.data || []) as ErpRow[]);
  const bulkPayments = bulkPaymentsResult.error ? [] : ((bulkPaymentsResult.data || []) as ErpRow[]);

  let openHeads = 0;
  let openEventBounded = false;
  if (openBatches.length) {
    const { data: events, error: openEventError } = await scoped(client.from("animal_batch_events")
      .select("batch_id,heads_delta")
      .in("batch_id", openBatches.map((batch) => batch.id))
      .neq("event_type", "feed")
      .is("deleted_at", null)
      .limit(AGGREGATE_LIMIT));
    if (!openEventError) {
      openEventBounded = (events || []).length >= AGGREGATE_LIMIT;
      const deltas = new Map<string, number>();
      for (const event of (events || []) as ErpRow[]) {
        deltas.set(event.batch_id, (deltas.get(event.batch_id) || 0) + Number(event.heads_delta || 0));
      }
      openHeads = openBatches.reduce(
        (total, batch) => total + Number(batch.opening_heads || 0) + (deltas.get(batch.id) || 0),
        0,
      );
    }
  }

  const accountResult = await scoped(client.from("customer_accounts")
    .select("id,is_active").is("deleted_at", null).limit(AGGREGATE_LIMIT));
  const accounts = accountResult.error ? [] : ((accountResult.data || []) as ErpRow[]);
  const activeAccountIds = new Set(
    accounts.filter((account) => account.is_active).map((account) => account.id),
  );

  const [
    customerInvoiceResult,
    customerPaymentResult,
    receiptResult,
    supplierPaymentResult,
    supplierReturnResult,
    expenseResult,
    trendPurchaseResult,
    trendBulkResult,
    trendExpenseResult,
    storeCountResult,
  ] = await Promise.all([
    scoped(client.from("customer_invoices").select("account_id,amount_paisa")
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("customer_payments").select("account_id,amount_paisa")
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("purchase_receipts").select("id,subtotal_paisa").is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("supplier_payments").select("receipt_id,amount_paisa").is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("supplier_returns").select("receipt_id,total_paisa")
      .eq("disposition", "credit").is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("expenses").select("amount_paisa")
      .gte("spent_at", pakistanDateBoundary(monthStart)).lt("spent_at", pakistanDateBoundary(monthEnd, true))
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("purchase_receipts").select("received_at,subtotal_paisa")
      .gte("received_at", pakistanDateBoundary(trendStart)).is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("bulk_sales").select("sale_date,total_paisa")
      .gte("sale_date", trendStart).is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("expenses").select("spent_at,amount_paisa")
      .gte("spent_at", pakistanDateBoundary(trendStart)).is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    client.from("branches").select("id", { count: "exact", head: true })
      .eq("is_active", true).is("deleted_at", null),
  ]);

  const invoices = customerInvoiceResult.error ? [] : ((customerInvoiceResult.data || []) as ErpRow[]);
  const payments = customerPaymentResult.error ? [] : ((customerPaymentResult.data || []) as ErpRow[]);
  const receipts = receiptResult.error ? [] : ((receiptResult.data || []) as ErpRow[]);
  const supplierPayments = supplierPaymentResult.error ? [] : ((supplierPaymentResult.data || []) as ErpRow[]);
  if (supplierReturnResult.error) throw supplierReturnResult.error;
  const supplierReturns = (supplierReturnResult.data || []) as ErpRow[];
  const monthExpenses = expenseResult.error ? [] : ((expenseResult.data || []) as ErpRow[]);
  const trendPurchases = trendPurchaseResult.error ? [] : ((trendPurchaseResult.data || []) as ErpRow[]);
  const trendBulk = trendBulkResult.error ? [] : ((trendBulkResult.data || []) as ErpRow[]);
  const trendExpenses = trendExpenseResult.error ? [] : ((trendExpenseResult.data || []) as ErpRow[]);

  const spiceOpen = spice.filter((batch) => batch.status === "open").length;
  const spiceCompleted = spice.filter((batch) => {
    if (batch.status !== "completed") return false;
    const completedDay = pakistanDay(batch.completed_at);
    return completedDay >= monthStart && completedDay <= monthEnd;
  });
  const spiceCost = spiceCompleted.reduce((total, batch) =>
    total + Number(batch.input_cost_paisa || 0) + Number(batch.labor_cost_paisa || 0)
      + Number(batch.other_cost_paisa || 0), 0);

  const paidBySale = new Map<string, number>();
  for (const payment of bulkPayments) {
    paidBySale.set(payment.sale_id, (paidBySale.get(payment.sale_id) || 0) + Number(payment.amount_paisa || 0));
  }
  const bulkDue = allBulk.reduce(
    (total, sale) => total + Number(sale.total_paisa || 0) - (paidBySale.get(sale.id) || 0),
    0,
  );

  const customerReceivable = invoices
    .filter((invoice) => activeAccountIds.has(invoice.account_id))
    .reduce((total, invoice) => total + Number(invoice.amount_paisa || 0), 0)
    - payments
      .filter((payment) => activeAccountIds.has(payment.account_id))
      .reduce((total, payment) => total + Number(payment.amount_paisa || 0), 0);

  const paidByReceipt = new Map<string, number>();
  for (const payment of supplierPayments) {
    paidByReceipt.set(payment.receipt_id, (paidByReceipt.get(payment.receipt_id) || 0) + Number(payment.amount_paisa || 0));
  }
  const returnedByReceipt = new Map<string, number>();
  for (const supplierReturn of supplierReturns) {
    returnedByReceipt.set(
      supplierReturn.receipt_id,
      (returnedByReceipt.get(supplierReturn.receipt_id) || 0) + Number(supplierReturn.total_paisa || 0),
    );
  }
  const vendorDue = receipts.reduce(
    (total, receipt) => total + Number(receipt.subtotal_paisa || 0)
      - (paidByReceipt.get(receipt.id) || 0) - (returnedByReceipt.get(receipt.id) || 0),
    0,
  );

  const purchaseEvents = monthEvents.filter((event) => event.event_type === "purchase");
  const feedEvents = monthEvents.filter((event) => event.event_type === "feed");
  const animalPurchaseCost = sum(monthOpenings, "opening_cost_paisa") + sum(purchaseEvents, "amount_paisa");

  const days: { day: string; purchasesPaisa: number; wholesalePaisa: number; expensesPaisa: number }[] = [];
  const bucket = new Map<string, { purchasesPaisa: number; wholesalePaisa: number; expensesPaisa: number }>();
  for (let index = 0; index < 14; index += 1) {
    const date = new Date(`${trendStart}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    const day = date.toISOString().slice(0, 10);
    bucket.set(day, { purchasesPaisa: 0, wholesalePaisa: 0, expensesPaisa: 0 });
    days.push({ day, purchasesPaisa: 0, wholesalePaisa: 0, expensesPaisa: 0 });
  }
  for (const receipt of trendPurchases) {
    const entry = bucket.get(pakistanDay(receipt.received_at));
    if (entry) entry.purchasesPaisa += Number(receipt.subtotal_paisa || 0);
  }
  for (const sale of trendBulk) {
    const entry = bucket.get(pakistanDay(sale.sale_date));
    if (entry) entry.wholesalePaisa += Number(sale.total_paisa || 0);
  }
  for (const expense of trendExpenses) {
    const entry = bucket.get(pakistanDay(expense.spent_at));
    if (entry) entry.expensesPaisa += Number(expense.amount_paisa || 0);
  }
  for (const day of days) Object.assign(day, bucket.get(day.day));

  const bounded = openEventBounded || openBatches.length >= AGGREGATE_LIMIT || [
    openBatchResult, monthOpeningResult, monthEventsResult, productionResult, spiceResult, bulkMonthResult,
    allBulkResult, bulkPaymentsResult, accountResult, customerInvoiceResult,
    customerPaymentResult, receiptResult, supplierPaymentResult, expenseResult,
    trendPurchaseResult, trendBulkResult, trendExpenseResult,
  ].some((result) => !result.error && (result.data || []).length >= AGGREGATE_LIMIT);

  return {
    overview: {
      animals: {
        openBatches: openBatches.length,
        heads: openHeads,
        purchaseCostPaisa: animalPurchaseCost,
        feedCostPaisa: sum(feedEvents, "amount_paisa"),
      },
      production: { runs: production.length, costPaisa: sum(production, "total_cost_paisa") },
      spice: {
        openBatches: spiceOpen,
        completedThisMonth: spiceCompleted.length,
        completedCostPaisa: spiceCost,
      },
      bulk: {
        invoices: bulkMonth.length,
        totalPaisa: sum(bulkMonth, "total_paisa"),
        duePaisa: bulkDue,
      },
      customers: { accounts: activeAccountIds.size, receivablePaisa: customerReceivable },
      vendors: { duePaisa: vendorDue },
      expenses: { count: monthExpenses.length, totalPaisa: sum(monthExpenses, "amount_paisa") },
      stores: storeCountResult.count || 0,
      today,
      month: monthStart.slice(0, 7),
      approximate: bounded,
    },
    trend: days,
  };
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

async function loadReport(
  client: ErpClient,
  branchId: string,
  from: string,
  to: string,
) {
  const scoped = (query: any) => branchId === "all" ? query : query.eq("branch_id", branchId);
  const fromTime = pakistanDateBoundary(from);
  const toTime = pakistanDateBoundary(to, true);

  const [
    bulkResult,
    bulkPaymentResult,
    customerInvoiceResult,
    customerPaymentResult,
    productionResult,
    spiceResult,
    animalEventResult,
    animalOpeningResult,
    expenseResult,
    categoryResult,
    receiptResult,
    supplierPaymentResult,
    supplierReturnResult,
  ] = await Promise.all([
    scoped(client.from("bulk_sales")
      .select("total_paisa,discount_paisa").gte("sale_date", from).lte("sale_date", to)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("bulk_sale_payments")
      .select("amount_paisa").gte("paid_at", fromTime).lt("paid_at", toTime)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("customer_invoices")
      .select("amount_paisa").gte("invoice_date", from).lte("invoice_date", to)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("customer_payments")
      .select("amount_paisa,method").neq("method", "credit")
      .gte("paid_at", fromTime).lt("paid_at", toTime)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("production_runs")
      .select("output_product_name,output_quantity_milli,input_cost_paisa,labor_cost_paisa,other_cost_paisa,total_cost_paisa")
      .gte("run_date", from).lte("run_date", to).is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("spice_batches")
      .select("id,batch_number,name,output_product_name,output_unit_code,input_cost_paisa,labor_cost_paisa,other_cost_paisa,output_quantity_milli,completed_at")
      .eq("status", "completed").gte("completed_at", fromTime).lt("completed_at", toTime)
      .is("deleted_at", null).order("completed_at", { ascending: true }).limit(AGGREGATE_LIMIT)),
    scoped(client.from("animal_batch_events")
      .select("event_type,heads_delta,amount_paisa,quantity_milli").gte("event_date", from).lte("event_date", to)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("animal_batches")
      .select("opening_cost_paisa,opening_heads").gte("opening_date", from).lte("opening_date", to)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("expenses")
      .select("amount_paisa,category_id").gte("spent_at", fromTime).lt("spent_at", toTime)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    client.from("expense_categories").select("id,name").is("deleted_at", null).limit(500),
    scoped(client.from("purchase_receipts")
      .select("subtotal_paisa").gte("received_at", fromTime).lt("received_at", toTime)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("supplier_payments")
      .select("amount_paisa").gte("paid_at", fromTime).lt("paid_at", toTime)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
    scoped(client.from("supplier_returns")
      .select("total_paisa").eq("disposition", "credit")
      .gte("returned_at", fromTime).lt("returned_at", toTime)
      .is("deleted_at", null).limit(AGGREGATE_LIMIT)),
  ]);

  const bulk = bulkResult.error ? [] : ((bulkResult.data || []) as ErpRow[]);
  const bulkPayments = bulkPaymentResult.error ? [] : ((bulkPaymentResult.data || []) as ErpRow[]);
  const customerInvoices = customerInvoiceResult.error ? [] : ((customerInvoiceResult.data || []) as ErpRow[]);
  const customerPayments = customerPaymentResult.error ? [] : ((customerPaymentResult.data || []) as ErpRow[]);
  const production = productionResult.error ? [] : ((productionResult.data || []) as ErpRow[]);
  const spice = spiceResult.error ? [] : ((spiceResult.data || []) as ErpRow[]);
  const animalEvents = animalEventResult.error ? [] : ((animalEventResult.data || []) as ErpRow[]);
  const animalOpenings = animalOpeningResult.error ? [] : ((animalOpeningResult.data || []) as ErpRow[]);
  const expenses = expenseResult.error ? [] : ((expenseResult.data || []) as ErpRow[]);
  const categories = categoryResult.error ? [] : ((categoryResult.data || []) as BranchLite[]);
  const receipts = receiptResult.error ? [] : ((receiptResult.data || []) as ErpRow[]);
  const supplierPayments = supplierPaymentResult.error ? [] : ((supplierPaymentResult.data || []) as ErpRow[]);
  if (supplierReturnResult.error) throw supplierReturnResult.error;
  const supplierReturns = (supplierReturnResult.data || []) as ErpRow[];

  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const productionGroups = new Map<string, { name: string; runs: number; quantityMilli: number; totalCost: number }>();
  for (const run of production) {
    const name = String(run.output_product_name || "Unnamed output");
    const entry = productionGroups.get(name) || { name, runs: 0, quantityMilli: 0, totalCost: 0 };
    entry.runs += 1;
    entry.quantityMilli += Number(run.output_quantity_milli || 0);
    entry.totalCost += Number(run.total_cost_paisa || 0);
    productionGroups.set(name, entry);
  }

  const expenseGroups = new Map<string, { name: string; count: number; total: number }>();
  for (const expense of expenses) {
    const name = categoryNames.get(expense.category_id) || "Uncategorized";
    const entry = expenseGroups.get(name) || { name, count: 0, total: 0 };
    entry.count += 1;
    entry.total += Number(expense.amount_paisa || 0);
    expenseGroups.set(name, entry);
  }

  const effectiveAnimalEvents = animalEvents;
  const dataBounded = [
    bulkResult, bulkPaymentResult, customerInvoiceResult, customerPaymentResult,
    productionResult, spiceResult, animalEventResult, animalOpeningResult,
    expenseResult, categoryResult, receiptResult, supplierPaymentResult, supplierReturnResult,
  ].some((result) => !result.error && (result.data || []).length >= AGGREGATE_LIMIT);

  return {
    range: { from, to },
    bulk: {
      invoices: bulk.length,
      totalPaisa: sum(bulk, "total_paisa"),
      discountPaisa: sum(bulk, "discount_paisa"),
      paidPaisa: sum(bulkPayments, "amount_paisa"),
    },
    customers: {
      invoices: customerInvoices.length,
      invoicedPaisa: sum(customerInvoices, "amount_paisa"),
      payments: customerPayments.length,
      paidPaisa: sum(customerPayments, "amount_paisa"),
    },
    production: {
      runs: production.length,
      inputCostPaisa: sum(production, "input_cost_paisa"),
      overheadPaisa: production.reduce(
        (total, run) => total + Number(run.labor_cost_paisa || 0) + Number(run.other_cost_paisa || 0), 0,
      ),
      totalCostPaisa: sum(production, "total_cost_paisa"),
      top: [...productionGroups.values()].sort((left, right) => right.totalCost - left.totalCost).slice(0, 10),
    },
    spice: {
      batches: spice.length,
      inputCostPaisa: sum(spice, "input_cost_paisa"),
      laborCostPaisa: sum(spice, "labor_cost_paisa"),
      otherCostPaisa: sum(spice, "other_cost_paisa"),
      totalCostPaisa: spice.reduce((total, batch) =>
        total + Number(batch.input_cost_paisa || 0) + Number(batch.labor_cost_paisa || 0)
          + Number(batch.other_cost_paisa || 0), 0),
      outputQuantityMilli: sum(spice, "output_quantity_milli"),
      batchRows: spice.slice(0, 100),
    },
    animals: {
      mortality: effectiveAnimalEvents.filter((event) => event.event_type === "mortality")
        .reduce((total, event) => total + Math.abs(Number(event.heads_delta || 0)), 0),
      purchased: effectiveAnimalEvents.filter((event) => event.event_type === "purchase")
        .reduce((total, event) => total + Number(event.heads_delta || 0), 0)
        + animalOpenings.filter((batch) => Number(batch.opening_cost_paisa || 0) > 0)
          .reduce((total, batch) => total + Number(batch.opening_heads || 0), 0),
      purchaseCostPaisa: effectiveAnimalEvents.filter((event) => event.event_type === "purchase")
        .reduce((total, event) => total + Number(event.amount_paisa || 0), 0)
        + sum(animalOpenings, "opening_cost_paisa"),
      sold: effectiveAnimalEvents.filter((event) => event.event_type === "sale")
        .reduce((total, event) => total + Math.abs(Number(event.heads_delta || 0)), 0),
      feedCostPaisa: effectiveAnimalEvents.filter((event) => event.event_type === "feed")
        .reduce((total, event) => total + Number(event.amount_paisa || 0), 0),
      feedQuantityMilli: effectiveAnimalEvents.filter((event) => event.event_type === "feed")
        .reduce((total, event) => total + Number(event.quantity_milli || 0), 0),
    },
    expenses: {
      count: expenses.length,
      totalPaisa: sum(expenses, "amount_paisa"),
      byCategory: [...expenseGroups.values()].sort((left, right) => right.total - left.total),
    },
    purchases: {
      receipts: receipts.length,
      totalPaisa: sum(receipts, "subtotal_paisa"),
      payments: supplierPayments.length,
      paidPaisa: sum(supplierPayments, "amount_paisa"),
      returns: supplierReturns.length,
      returnedPaisa: sum(supplierReturns, "total_paisa"),
    },
    approximate: dataBounded,
  };
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(
      request,
      authentication,
      { error: "Farm ERP records are available to admin accounts only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const module = parameters.get("module") || "";
  if (!ERP_MODULES.has(module)) {
    return authenticationResponse(request, authentication, { error: "Choose a supported Farm ERP module." }, 400);
  }

  const requestedBranch = parameters.get("branchId") || "";
  const isHqAdmin = !authentication.identity.staff.branch_id;
  const branchId = requestedBranch || (isHqAdmin ? "all" : authentication.identity.staff.branch_id || "");
  if (branchId !== "all" && !isUuid(branchId)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }
  if (branchId === "all" && !isHqAdmin) {
    return authenticationResponse(request, authentication, { error: "You cannot access all branches." }, 403);
  }
  if (branchId !== "all" && !allowedBranch(branchId, authentication.identity.branches)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  const search = (parameters.get("search") || "").trim().slice(0, 80);
  const status = (parameters.get("status") || "").trim().slice(0, 40);
  const categoryId = (parameters.get("categoryId") || "").trim();
  if (categoryId && !isUuid(categoryId)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid expense category." }, 400);
  }
  const detailId = parameters.get("detailId") || "";
  if (detailId && !isUuid(detailId)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid Farm ERP record." }, 400);
  }

  const today = isDate(parameters.get("today") || "") ? parameters.get("today")! : todayKey();
  const monthStart = isDate(parameters.get("from") || "") ? parameters.get("from")! : startOfMonth(today);
  const monthEnd = isDate(parameters.get("to") || "") ? parameters.get("to")! : today;
  if (monthStart > monthEnd) {
    return authenticationResponse(request, authentication, { error: "The start date must be on or before the end date." }, 400);
  }
  const trendStart = isDate(parameters.get("trendFrom") || "")
    ? parameters.get("trendFrom")!
    : (() => {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - 13);
      return date.toISOString().slice(0, 10);
    })();

  const client = authentication.client as unknown as ErpClient;
  const names = branchNames(authentication.identity.branches);
  const branches = await loadBranches(client, branchId, names);

  try {
    if (detailId) {
      let detail: { record: ErpRow; [key: string]: unknown } | null = null;
      if (module === "animals") detail = await loadAnimalDetail(client, detailId, names);
      else if (module === "production") detail = await loadProductionDetail(client, detailId, names);
      else if (module === "spice") detail = await loadSpiceDetail(client, detailId, names);
      else if (module === "bulk-sales") detail = await loadBulkSaleDetail(client, detailId, names);
      else if (module === "vendors") detail = await loadVendorDetail(client, detailId, branchId);
      else if (module === "customer-accounts") detail = await loadCustomerDetail(client, detailId, names);

      if (!detail) {
        return authenticationResponse(request, authentication, { error: "That Farm ERP record is not available." }, 404);
      }
      const recordBranch = typeof detail.record.branch_id === "string" ? detail.record.branch_id : "";
      if (recordBranch) {
        if (!allowedBranch(recordBranch, authentication.identity.branches)) {
          return authenticationResponse(request, authentication, { error: "That record is not available to your account." }, 404);
        }
        if (branchId !== "all" && recordBranch !== branchId) {
          return authenticationResponse(request, authentication, { error: "That record is outside the selected branch." }, 404);
        }
      }
      return authenticationResponse(request, authentication, { module, detail });
    }

    if (module === "erp-dashboard") {
      const dashboard = await loadDashboard(client, branchId, monthStart, monthEnd, trendStart, today);
      return authenticationResponse(request, authentication, {
        module,
        branchId,
        branches,
        limit: AGGREGATE_LIMIT,
        ...dashboard,
      });
    }

    if (module === "erp-reports") {
      const report = await loadReport(client, branchId, monthStart, monthEnd);
      return authenticationResponse(request, authentication, {
        module, branchId, branches, limit: AGGREGATE_LIMIT, report,
      });
    }

    let list: ErpList = { rows: [], approximate: false };
    let categories: BranchLite[] = [];
    if (module === "animals") list = await loadAnimals(client, branchId, names, search, status);
    else if (module === "production") {
      list = { rows: await loadProduction(client, branchId, names, search, monthStart, monthEnd), approximate: false };
    } else if (module === "spice") {
      list = { rows: await loadSpice(client, branchId, names, search, status, monthStart, monthEnd), approximate: false };
    } else if (module === "bulk-sales") {
      list = await loadBulkSales(client, branchId, names, search, monthStart, monthEnd);
    } else if (module === "vendors") {
      list = await loadVendors(client, branchId, search, status);
    } else if (module === "farm-stores") {
      list = await loadFarmStores(client, branchId, search, status, today);
    } else if (module === "customer-accounts") {
      list = await loadCustomerAccounts(client, branchId, names, search, status);
    } else if (module === "erp-expenses") {
      const expenses = await loadExpenses(client, branchId, names, search, categoryId, monthStart, monthEnd);
      list = { rows: expenses.rows, approximate: false };
      categories = expenses.categories;
    }

    return authenticationResponse(request, authentication, {
      module,
      branchId,
      branches,
      limit: LIST_LIMIT,
      from: monthStart,
      to: monthEnd,
      approximate: list.approximate,
      rows: list.rows,
      categories,
    });
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return authenticationResponse(
      request,
      authentication,
      { error: erpError(failure) },
      schemaUnavailable(failure) ? 503 : 500,
    );
  }
}
