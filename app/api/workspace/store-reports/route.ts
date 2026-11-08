import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import { cashierReturnVisibilityFilter, isHqAdmin } from "@/lib/server/staff-workflow-scope";

export const dynamic = "force-dynamic";

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
  const cashierId = identity.staff.role === "cashier" ? identity.staff.local_staff_id : null;
  if (identity.staff.role === "cashier" && !cashierId) {
    return authenticationResponse(request, authentication, { error: "This account is not linked to a staff profile." }, 403);
  }

  const fromDate = parameters.get("from") || "";
  const toDate = parameters.get("to") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid date range." }, 400);
  }

  const startIso = pakistanDateBoundary(fromDate);
  const endIso = pakistanDateBoundary(toDate, true);
  const dayKeys = dateSequence(fromDate, toDate);

  const salesQuery = authentication.client
    .from("pos_sales")
    .select("id, branch_id, receipt_number, completed_at, total_paisa, discount_paisa, status")
    .is("deleted_at", null)
    .gte("completed_at", startIso)
    .lt("completed_at", endIso)
    .order("completed_at", { ascending: true });

  if (!isAdmin && branchId) {
    salesQuery.eq("branch_id", branchId);
  } else if (branchId && branchId !== "all") {
    salesQuery.eq("branch_id", branchId);
  }
  if (cashierId) salesQuery.eq("cashier_id", cashierId);

  const { data: sales, error: salesError } = await salesQuery;
  if (salesError) throw new Error(salesError.message);

  const returnSalesIds = sales?.map((sale) => sale.id) || [];
  const returnQuery = authentication.client
    .from("returns")
    .select("id, branch_id, refund_total_paisa, completed_at, created_at")
    .is("deleted_at", null)
    .gte("completed_at", startIso)
    .lt("completed_at", endIso)
    .eq("status", "completed");

  if (!isAdmin && branchId) {
    returnQuery.eq("branch_id", branchId);
  } else if (branchId && branchId !== "all") {
    returnQuery.eq("branch_id", branchId);
  }
  if (cashierId) returnQuery.or(cashierReturnVisibilityFilter(cashierId));

  const { data: returns, error: returnsError } = await returnQuery;
  if (returnsError) throw new Error(returnsError.message);

  const returnIds = (returns || []).map((entry) => entry.id);
  const returnItems = returnIds.length
    ? await authentication.client
      .from("return_items")
      .select("return_id, sale_item_id, line_refund_paisa, product_name, quantity_milli")
      .in("return_id", returnIds)
      .is("deleted_at", null)
    : { data: [] as Array<{ return_id: string; sale_item_id: string; line_refund_paisa: number; product_name: string; quantity_milli: number }>, error: null };

  if (returnItems.error) throw new Error(returnItems.error.message);

  const saleItemRefundTotals = new Map<string, number>();
  (returnItems.data || []).forEach((item) => {
    saleItemRefundTotals.set(item.sale_item_id, (saleItemRefundTotals.get(item.sale_item_id) || 0) + (item.line_refund_paisa || 0));
  });

  const saleItemQuery = returnSalesIds.length
    ? await authentication.client
      .from("pos_sale_items")
      .select("id, sale_id, product_name, sku, quantity_milli, line_total_paisa")
      .in("sale_id", returnSalesIds)
      .is("deleted_at", null)
    : { data: [] as Array<{ id: string; sale_id: string; product_name: string; sku: string | null; quantity_milli: number; line_total_paisa: number }>, error: null };

  if (saleItemQuery.error) throw new Error(saleItemQuery.error.message);

  const paymentQuery = returnSalesIds.length
    ? await authentication.client
      .from("pos_sale_payments")
      .select("sale_id, method, amount_paisa")
      .in("sale_id", returnSalesIds)
      .is("deleted_at", null)
    : { data: [] as Array<{ sale_id: string; method: string; amount_paisa: number }>, error: null };

  if (paymentQuery.error) throw new Error(paymentQuery.error.message);

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

  (returns || []).forEach((entry) => {
    const dateKey = pakistanDayKey(entry.completed_at || entry.created_at || new Date().toISOString());
    const day = byDayMap.get(dateKey) || { gross_sales_paisa: 0, refunds_paisa: 0, net_sales_paisa: 0, receipts_count: 0, discount_paisa: 0 };
    day.refunds_paisa += Number(entry.refund_total_paisa || 0);
    day.net_sales_paisa -= Number(entry.refund_total_paisa || 0);
    byDayMap.set(dateKey, day);
  });

  const productMap = new Map<string, { product: string; sku: string | null; units_milli: number; total_paisa: number; refunds_paisa: number }>();
  (saleItemQuery.data || []).forEach((item) => {
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
    current.refunds_paisa += saleItemRefundTotals.get(item.id) || 0;
    productMap.set(key, current);
  });

  const paymentMap = new Map<string, number>();
  (paymentQuery.data || []).forEach((payment) => {
    paymentMap.set(payment.method, (paymentMap.get(payment.method) || 0) + Number(payment.amount_paisa || 0));
  });

  const totalGross = validSales.reduce((sum, sale) => sum + Number(sale.total_paisa || 0), 0);
  const totalRefunds = (returns || []).reduce((sum, entry) => sum + Number(entry.refund_total_paisa || 0), 0);
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
    generatedAt: new Date().toISOString(),
  });
}
