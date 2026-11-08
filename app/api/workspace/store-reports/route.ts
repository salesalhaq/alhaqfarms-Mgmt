import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import { cashierReturnVisibilityFilter, isHqAdmin } from "@/lib/server/staff-workflow-scope";

export const dynamic = "force-dynamic";

const SALE_LIMIT = 5_000;
const RETURN_LIMIT = 2_000;
const PAGE_SIZE = 1_000;
const ID_CHUNK = 100;
const MAX_RANGE_DAYS = 366;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
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

function dateSequence(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const dates: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const identity = authentication.identity;
  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  const isAdmin = isHqAdmin(identity.staff);

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  if (requestedBranch && requestedBranch !== "all" && !identity.branches.some((branch) => branch.id === requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  const branchId = isAdmin
    ? requestedBranch && requestedBranch !== "all" ? requestedBranch : "all"
    : identity.staff.branch_id;
  if (!branchId) {
    return authenticationResponse(request, authentication, { error: "This account is not assigned to a branch." }, 403);
  }
  if (identity.staff.role !== "admin" && branchId) {
    const { data: permissions, error: permissionError } = await authentication.client
      .from("branch_module_permissions")
      .select("permission_key,is_allowed,updated_at,id")
      .eq("branch_id", branchId)
      .eq("role", identity.staff.role)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false });
    if (permissionError) {
      return authenticationResponse(request, authentication, { error: permissionError.message }, 500);
    }
    const reportPermission = (permissions || []).find((entry) => entry.permission_key === "module:sales_reports:view");
    if (reportPermission && !reportPermission.is_allowed) {
      return authenticationResponse(request, authentication, { error: "Store reports are not available to your account at this branch." }, 403);
    }
  }
  const cashierId = identity.staff.role === "cashier" ? identity.staff.local_staff_id : null;
  if (identity.staff.role === "cashier" && !cashierId) {
    return authenticationResponse(request, authentication, { error: "This account is not linked to a staff profile." }, 403);
  }

  const fromDate = parameters.get("from") || "";
  const toDate = parameters.get("to") || "";
  if (!isCalendarDate(fromDate) || !isCalendarDate(toDate) || fromDate > toDate) {
    return authenticationResponse(request, authentication, { error: "Choose a valid date range." }, 400);
  }
  const rangeDays = (Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (rangeDays > MAX_RANGE_DAYS) {
    return authenticationResponse(request, authentication, { error: "Choose a date range of one year or less." }, 400);
  }

  const startIso = pakistanDateBoundary(fromDate);
  const endIso = pakistanDateBoundary(toDate, true);
  const dayKeys = dateSequence(fromDate, toDate);

  const sales: Array<{
    id: string;
    branch_id: string;
    receipt_number: string;
    completed_at: string;
    total_paisa: number;
    discount_paisa: number;
    status: string;
  }> = [];
  for (let offset = 0; offset < SALE_LIMIT; offset += PAGE_SIZE) {
    let salesQuery = authentication.client
      .from("pos_sales")
      .select("id, branch_id, receipt_number, completed_at, total_paisa, discount_paisa, status")
      .is("deleted_at", null)
      .neq("status", "void")
      .gte("completed_at", startIso)
      .lt("completed_at", endIso)
      .order("completed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (branchId && branchId !== "all") salesQuery = salesQuery.eq("branch_id", branchId);
    if (cashierId) salesQuery = salesQuery.eq("cashier_id", cashierId);
    const result = await salesQuery;
    if (result.error) throw new Error(result.error.message);
    const page = (result.data || []) as typeof sales;
    sales.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const returns: Array<{
    id: string;
    branch_id: string;
    refund_total_paisa: number;
    completed_at: string | null;
    created_at: string;
  }> = [];
  for (let offset = 0; offset < RETURN_LIMIT; offset += PAGE_SIZE) {
    let returnQuery = authentication.client
      .from("returns")
      .select("id, branch_id, refund_total_paisa, completed_at, created_at")
      .is("deleted_at", null)
      .gte("completed_at", startIso)
      .lt("completed_at", endIso)
      .eq("status", "completed")
      .order("completed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (branchId && branchId !== "all") returnQuery = returnQuery.eq("branch_id", branchId);
    if (cashierId) returnQuery = returnQuery.or(cashierReturnVisibilityFilter(cashierId));
    const result = await returnQuery;
    if (result.error) throw new Error(result.error.message);
    const page = (result.data || []) as typeof returns;
    returns.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const returnIds = returns.map((entry) => entry.id);
  const returnItems: Array<{ return_id: string; sale_item_id: string; line_refund_paisa: number; product_name: string; quantity_milli: number }> = [];
  const saleItems: Array<{ id: string; sale_id: string; product_name: string; sku: string | null; quantity_milli: number; line_total_paisa: number }> = [];
  const payments: Array<{ sale_id: string; method: string; amount_paisa: number }> = [];
  let detailTruncated = false;
  const returnSalesIds = sales.map((sale) => sale.id);
  for (const ids of chunk(returnIds, ID_CHUNK)) {
    for (let offset = 0; offset < 100_000; offset += PAGE_SIZE) {
      const result = await authentication.client
        .from("return_items")
        .select("return_id, sale_item_id, line_refund_paisa, product_name, quantity_milli")
        .in("return_id", ids)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (result.error) throw new Error(result.error.message);
      const page = result.data || [];
      returnItems.push(...page);
      if (page.length < PAGE_SIZE) break;
      if (offset + PAGE_SIZE >= 100_000) detailTruncated = true;
    }
  }
  for (const ids of chunk(returnSalesIds, ID_CHUNK)) {
    for (let offset = 0; offset < 100_000; offset += PAGE_SIZE) {
      const [itemResult, paymentResult] = await Promise.all([
        authentication.client
          .from("pos_sale_items")
          .select("id, sale_id, product_name, sku, quantity_milli, line_total_paisa")
          .in("sale_id", ids)
          .is("deleted_at", null)
          .order("id", { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1),
        authentication.client
          .from("pos_sale_payments")
          .select("sale_id, method, amount_paisa")
          .in("sale_id", ids)
          .is("deleted_at", null)
          .order("id", { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1),
      ]);
      if (itemResult.error) throw new Error(itemResult.error.message);
      if (paymentResult.error) throw new Error(paymentResult.error.message);
      const itemPage = itemResult.data || [];
      const paymentPage = paymentResult.data || [];
      saleItems.push(...itemPage);
      payments.push(...paymentPage);
      if (itemPage.length < PAGE_SIZE && paymentPage.length < PAGE_SIZE) break;
      if (offset + PAGE_SIZE >= 100_000) detailTruncated = true;
    }
  }
  const knownSaleItemIds = new Set(saleItems.map((item) => item.id));
  const missingSaleItemIds = [...new Set(returnItems.map((item) => item.sale_item_id))]
    .filter((id) => !knownSaleItemIds.has(id));
  for (const ids of chunk(missingSaleItemIds, ID_CHUNK)) {
    const result = await authentication.client
      .from("pos_sale_items")
      .select("id, sale_id, product_name, sku, quantity_milli, line_total_paisa")
      .in("id", ids)
      .is("deleted_at", null);
    if (result.error) throw new Error(result.error.message);
    saleItems.push(...(result.data || []).map((item) => ({ ...item, quantity_milli: 0, line_total_paisa: 0 })));
  }
  const refundsBySaleItem = new Map<string, number>();
  returnItems.forEach((item) => {
    refundsBySaleItem.set(
      item.sale_item_id,
      (refundsBySaleItem.get(item.sale_item_id) || 0) + Number(item.line_refund_paisa || 0),
    );
  });

  const byDayMap = new Map<string, { gross_sales_paisa: number; refunds_paisa: number; net_sales_paisa: number; receipts_count: number; discount_paisa: number }>();
  dayKeys.forEach((dayKey) => {
    byDayMap.set(dayKey, { gross_sales_paisa: 0, refunds_paisa: 0, net_sales_paisa: 0, receipts_count: 0, discount_paisa: 0 });
  });

  const validSales = (sales || []).filter((sale) => sale.status !== "void");
  validSales.forEach((sale) => {
    const dateKey = pakistanDayKey(sale.completed_at);
    const entry = byDayMap.get(dateKey) || { gross_sales_paisa: 0, refunds_paisa: 0, net_sales_paisa: 0, receipts_count: 0, discount_paisa: 0 };
    entry.gross_sales_paisa += Number(sale.total_paisa || 0);
    entry.discount_paisa += Number(sale.discount_paisa || 0);
    entry.net_sales_paisa += Number(sale.total_paisa || 0);
    entry.receipts_count += 1;
    byDayMap.set(dateKey, entry);
  });

  returns.forEach((entry) => {
    const dateKey = pakistanDayKey(entry.completed_at || entry.created_at || new Date().toISOString());
    const day = byDayMap.get(dateKey) || { gross_sales_paisa: 0, refunds_paisa: 0, net_sales_paisa: 0, receipts_count: 0, discount_paisa: 0 };
    day.refunds_paisa += Number(entry.refund_total_paisa || 0);
    day.net_sales_paisa -= Number(entry.refund_total_paisa || 0);
    byDayMap.set(dateKey, day);
  });

  const productMap = new Map<string, { product: string; sku: string | null; units_milli: number; total_paisa: number; refunds_paisa: number }>();
  saleItems.forEach((item) => {
    const key = `${item.product_name}::${item.sku || ""}`;
    const current = productMap.get(key) || {
      product: item.product_name,
      sku: item.sku,
      units_milli: 0,
      total_paisa: 0,
      refunds_paisa: 0,
    };
    current.units_milli += Number(item.quantity_milli || 0);
    current.total_paisa += Number(item.line_total_paisa || 0);
    current.refunds_paisa += refundsBySaleItem.get(item.id) || 0;
    productMap.set(key, current);
  });

  const paymentMap = new Map<string, number>();
  payments.forEach((payment) => {
    paymentMap.set(payment.method, (paymentMap.get(payment.method) || 0) + Number(payment.amount_paisa || 0));
  });

  const totalGross = validSales.reduce((sum, sale) => sum + Number(sale.total_paisa || 0), 0);
  const totalRefunds = returns.reduce((sum, entry) => sum + Number(entry.refund_total_paisa || 0), 0);
  const totalDiscount = validSales.reduce((sum, sale) => sum + Number(sale.discount_paisa || 0), 0);
  const totalNet = totalGross - totalRefunds;
  const receiptCount = validSales.length;

  const byDay = dayKeys.map((dayKey) => {
    const day = byDayMap.get(dayKey) || { gross_sales_paisa: 0, refunds_paisa: 0, net_sales_paisa: 0, receipts_count: 0, discount_paisa: 0 };
    return {
      date: dayKey,
      gross_sales_paisa: day.gross_sales_paisa,
      refunds_paisa: day.refunds_paisa,
      net_sales_paisa: day.net_sales_paisa,
      receipts_count: day.receipts_count,
      discount_paisa: day.discount_paisa,
    };
  });

  const paymentRows = [...paymentMap.entries()]
    .map(([method, amountPaisa]) => ({
      method,
      amount_paisa: amountPaisa,
      share: totalGross ? Math.round((amountPaisa / totalGross) * 100) : 0,
    }))
    .sort((left, right) => right.amount_paisa - left.amount_paisa);

  const productRows = [...productMap.values()]
    .map((product) => ({
      product: product.product,
      sku: product.sku,
      units_milli: product.units_milli,
      total_paisa: product.total_paisa,
      refunds_paisa: product.refunds_paisa,
    }))
    .sort((left, right) => right.total_paisa - left.total_paisa)
    .slice(0, 8);

  return authenticationResponse(request, authentication, {
    branchId: branchId === "all" ? null : branchId,
    branchName: branchId === "all"
      ? "All accessible branches"
      : identity.branches.find((branch) => branch.id === branchId)?.name || "Your branch",
    summary: {
      grossSalesPaisa: totalGross,
      refundsPaisa: totalRefunds,
      netSalesPaisa: totalNet,
      receiptCount,
      averageTicketPaisa: receiptCount ? Math.round(totalNet / receiptCount) : 0,
      discountPaisa: totalDiscount,
    },
    byDay,
    payments: paymentRows,
    products: productRows,
    truncated: sales.length >= SALE_LIMIT || returns.length >= RETURN_LIMIT || detailTruncated,
    generatedAt: new Date().toISOString(),
  });
}
