import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const SALE_LIMIT = 5_000;
const RETURN_LIMIT = 2_000;
const PAGE_SIZE = 1_000;
const ID_CHUNK = 100;

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

function pakistanDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const role = authentication.identity.staff.role;
  if (!["admin", "manager"].includes(role)) {
    return authenticationResponse(
      request,
      authentication,
      { error: "Sales reports are available to managers and admins only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const from = parameters.get("from") || "";
  const to = parameters.get("to") || "";
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    return authenticationResponse(request, authentication, { error: "Choose a valid report date range." }, 400);
  }

  const requestedBranch = parameters.get("branchId") || "";
  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  const accessibleBranchIds = authentication.identity.branches.map((branch) => branch.id);
  let selectedBranchIds: string[];
  if (role === "admin") {
    if (requestedBranch && requestedBranch !== "all") {
      if (!accessibleBranchIds.includes(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }
      selectedBranchIds = [requestedBranch];
    } else {
      selectedBranchIds = accessibleBranchIds;
    }
  } else {
    const branchId = authentication.identity.staff.branch_id;
    if (!branchId) {
      return authenticationResponse(request, authentication, { error: "This account is not assigned to a branch." }, 403);
    }
    selectedBranchIds = [branchId];
  }

  if (!selectedBranchIds.length) {
    return authenticationResponse(request, authentication, {
      from,
      to,
      branchId: null,
      branchName: "No accessible branch",
      summary: { receipts: 0, grossPaisa: 0, discountPaisa: 0, taxPaisa: 0, paidPaisa: 0, duePaisa: 0 },
      returns: { count: 0, refundPaisa: 0 },
      netPaisa: 0,
      byDay: [],
      byCashier: [],
      byProduct: [],
      byPayment: [],
      generatedAt: new Date().toISOString(),
    });
  }

  const branchName = selectedBranchIds.length === 1
    ? authentication.identity.branches.find((branch) => branch.id === selectedBranchIds[0])?.name || "Your branch"
    : "All accessible branches";

  const fromIso = pakistanDateBoundary(from);
  const toIso = pakistanDateBoundary(to, true);

  try {
    const sales: Array<{
      id: string;
      branch_id: string;
      cashier_id: string;
      total_paisa: number;
      discount_paisa: number;
      tax_paisa: number;
      paid_paisa: number;
      due_paisa: number;
      status: string;
      completed_at: string;
    }> = [];

    for (let offset = 0; offset < SALE_LIMIT; offset += PAGE_SIZE) {
      const salesResult = await authentication.client
        .from("pos_sales")
        .select("id,branch_id,cashier_id,total_paisa,discount_paisa,tax_paisa,paid_paisa,due_paisa,status,completed_at")
        .in("branch_id", selectedBranchIds)
        .is("deleted_at", null)
        .neq("status", "void")
        .gte("completed_at", fromIso)
        .lt("completed_at", toIso)
        .order("completed_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (salesResult.error) throw new Error(salesResult.error.message);
      const page = (salesResult.data || []) as typeof sales;
      sales.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const refunds: Array<{
      id: string;
      refund_total_paisa: number;
      completed_at: string | null;
    }> = [];

    for (let offset = 0; offset < RETURN_LIMIT; offset += PAGE_SIZE) {
      const returnsResult = await authentication.client
        .from("returns")
        .select("id,branch_id,refund_total_paisa,status,completed_at")
        .in("branch_id", selectedBranchIds)
        .is("deleted_at", null)
        .eq("status", "completed")
        .gte("completed_at", fromIso)
        .lt("completed_at", toIso)
        .range(offset, offset + PAGE_SIZE - 1);
      if (returnsResult.error) throw new Error(returnsResult.error.message);
      const page = (returnsResult.data || []) as typeof refunds;
      refunds.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const truncated = sales.length >= SALE_LIMIT || refunds.length >= RETURN_LIMIT;

    const saleIds = sales.map((sale) => sale.id);
    const itemRows: Array<{
      product_name: string;
      sku: string | null;
      quantity_milli: number;
      line_total_paisa: number;
      discount_paisa: number;
    }> = [];
    const paymentRows: Array<{ method: string; amount_paisa: number }> = [];

    for (const ids of chunk(saleIds, ID_CHUNK)) {
      const [itemsResult, paymentsResult] = await Promise.all([
        authentication.client
          .from("pos_sale_items")
          .select("product_name,sku,quantity_milli,line_total_paisa,discount_paisa")
          .in("sale_id", ids)
          .is("deleted_at", null),
        authentication.client
          .from("pos_sale_payments")
          .select("method,amount_paisa")
          .in("sale_id", ids)
          .is("deleted_at", null),
      ]);
      if (itemsResult.error) throw new Error(itemsResult.error.message);
      if (paymentsResult.error) throw new Error(paymentsResult.error.message);
      itemRows.push(...((itemsResult.data || []) as typeof itemRows));
      paymentRows.push(...((paymentsResult.data || []) as typeof paymentRows));
    }

    const staffResult = await authentication.client
      .from("staff_profiles")
      .select("id,full_name")
      .in("branch_id", selectedBranchIds)
      .is("deleted_at", null)
      .limit(1_000);
    const staffNames = new Map<string, string>();
    for (const member of (staffResult.data || []) as Array<{ id: string; full_name: string }>) {
      if (member.id) staffNames.set(member.id, member.full_name);
    }

    const summary = sales.reduce((accumulator, sale) => ({
      receipts: accumulator.receipts + 1,
      grossPaisa: accumulator.grossPaisa + asNumber(sale.total_paisa),
      discountPaisa: accumulator.discountPaisa + asNumber(sale.discount_paisa),
      taxPaisa: accumulator.taxPaisa + asNumber(sale.tax_paisa),
      paidPaisa: accumulator.paidPaisa + asNumber(sale.paid_paisa),
      duePaisa: accumulator.duePaisa + asNumber(sale.due_paisa),
    }), { receipts: 0, grossPaisa: 0, discountPaisa: 0, taxPaisa: 0, paidPaisa: 0, duePaisa: 0 });

    const refundPaisa = refunds.reduce((total, row) => total + asNumber(row.refund_total_paisa), 0);

    const dayBuckets = new Map<string, { receipts: number; total: number; discount: number; tax: number }>();
    for (const sale of sales) {
      const day = pakistanDayKey(sale.completed_at);
      const bucket = dayBuckets.get(day) || { receipts: 0, total: 0, discount: 0, tax: 0 };
      bucket.receipts += 1;
      bucket.total += asNumber(sale.total_paisa);
      bucket.discount += asNumber(sale.discount_paisa);
      bucket.tax += asNumber(sale.tax_paisa);
      dayBuckets.set(day, bucket);
    }

    const cashierBuckets = new Map<string, { id: string; cashier_name: string; receipts: number; total: number; discount: number }>();
    for (const sale of sales) {
      const bucket = cashierBuckets.get(sale.cashier_id) || {
        id: sale.cashier_id,
        cashier_name: staffNames.get(sale.cashier_id) || "Staff unavailable",
        receipts: 0,
        total: 0,
        discount: 0,
      };
      bucket.receipts += 1;
      bucket.total += asNumber(sale.total_paisa);
      bucket.discount += asNumber(sale.discount_paisa);
      cashierBuckets.set(sale.cashier_id, bucket);
    }

    const productBuckets = new Map<string, {
      product_name: string;
      sku: string | null;
      quantity: number;
      total: number;
      discount: number;
    }>();
    for (const item of itemRows) {
      const key = `${item.product_name}:${item.sku || ""}`;
      const bucket = productBuckets.get(key) || {
        product_name: item.product_name,
        sku: item.sku,
        quantity: 0,
        total: 0,
        discount: 0,
      };
      bucket.quantity += asNumber(item.quantity_milli);
      bucket.total += asNumber(item.line_total_paisa);
      bucket.discount += asNumber(item.discount_paisa);
      productBuckets.set(key, bucket);
    }

    const paymentBuckets = new Map<string, { method: string; receipts: number; amount: number }>();
    for (const payment of paymentRows) {
      const bucket = paymentBuckets.get(payment.method) || { method: payment.method, receipts: 0, amount: 0 };
      bucket.receipts += 1;
      bucket.amount += asNumber(payment.amount_paisa);
      paymentBuckets.set(payment.method, bucket);
    }

    return authenticationResponse(request, authentication, {
      from,
      to,
      branchId: selectedBranchIds.length === 1 ? selectedBranchIds[0] : null,
      branchName,
      summary,
      returns: { count: refunds.length, refundPaisa },
      netPaisa: summary.grossPaisa - refundPaisa,
      byDay: [...dayBuckets.entries()]
        .map(([day, values]) => ({ day, ...values }))
        .sort((left, right) => right.day.localeCompare(left.day)),
      byCashier: [...cashierBuckets.values()].sort((left, right) => right.total - left.total),
      byProduct: [...productBuckets.values()].sort((left, right) => right.total - left.total).slice(0, 100),
      byPayment: [...paymentBuckets.values()].sort((left, right) => right.amount - left.amount),
      truncated,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load the sales report.",
    }, 500);
  }
}
