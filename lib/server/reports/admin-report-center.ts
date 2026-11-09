import {
  asNumber,
  chunk,
  displayQuantity,
  fetchPaged,
  loadStockSnapshot,
  monthKey,
  monthLabel,
  pakistanDateBoundary,
  pakistanDayKey,
  stockValuePaisa,
  type ReportClient,
  type StockSnapshot,
} from "@/lib/server/report-center";
import {
  finalizeSection,
  type ReportCenterPayload,
  type ReportColumnSpec,
  type ReportRow,
  type ReportSectionSpec,
  type ReportTableSpec,
} from "@/lib/reports/report-center";

type Row = Record<string, any>;

export interface AdminReportOptions {
  from: string;
  to: string;
  branchId: string | null;
  branchName: string;
  branches: Array<{ id: string; name: string }>;
  selectedBranchIds: string[];
}

const ID_CHUNK = 100;

function statusOf(row: Row): string {
  return String(row.status || "").toLowerCase();
}

function isVoidStatus(row: Row): boolean {
  return ["void", "voided", "cancelled", "canceled"].includes(statusOf(row));
}

function isCompletedStatus(row: Row): boolean {
  return ["completed", "partial_refund"].includes(statusOf(row));
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function moneyText(paisa: number): string {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(asNumber(paisa) / 100);
}

function table(
  columns: ReportColumnSpec[],
  rows: ReportRow[],
  options: { title?: string; empty?: string } = {},
): ReportTableSpec {
  return {
    title: options.title,
    empty: options.empty || "No records for this period.",
    columns,
    rows,
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const bucket = map.get(id);
    if (bucket) bucket.push(row);
    else map.set(id, [row]);
  }
  return map;
}

async function loadByIds<T>(
  client: ReportClient,
  tableName: string,
  select: string,
  column: string,
  ids: string[],
): Promise<T[]> {
  const rows: T[] = [];
  for (const group of chunk([...new Set(ids)], ID_CHUNK)) {
    if (!group.length) continue;
    const page = await fetchPaged<T>(() => client
      .from(tableName)
      .select(select)
      .in(column, group)
      .is("deleted_at", null));
    rows.push(...page);
  }
  return rows;
}

function quantity(value: unknown): number {
  return displayQuantity(asNumber(value));
}

export async function buildAdminReportCenter(
  client: ReportClient,
  options: AdminReportOptions,
): Promise<ReportCenterPayload> {
  const { from, to, selectedBranchIds } = options;
  const fromIso = pakistanDateBoundary(from);
  const toIso = pakistanDateBoundary(to, true);
  const branchScope = <T extends { in: (column: string, values: string[]) => T }>(query: T): T =>
    selectedBranchIds.length ? query.in("branch_id", selectedBranchIds) : query;

  const branchNames = new Map(options.branches.map((branch) => [branch.id, branch.name]));
  const branchName = (id: unknown): string =>
    typeof id === "string" ? branchNames.get(id) || "Unknown branch" : "Unknown branch";

  const [
    sales,
    returns,
    shifts,
    expenses,
    expenseCategories,
    stockMovements,
    transfers,
    customerAccounts,
    customerInvoices,
    customerPayments,
    staffProfiles,
    pendingWebOrders,
    openShifts,
    pendingReturns,
    auditRows,
    purchaseReceipts,
    stock,
  ] = await Promise.all([
    fetchPaged<Row>(() => branchScope(client
      .from("pos_sales")
      .select("id,receipt_number,branch_id,cashier_id,status,subtotal_paisa,item_discount_paisa,bill_discount_paisa,discount_paisa,tax_paisa,total_paisa,paid_paisa,due_paisa,cost_total_paisa,created_offline,override_by,customer_name,customer_phone,source_type,completed_at,created_at,customer_account_id,notes")
      .is("deleted_at", null)
      .gte("created_at", fromIso)
      .lt("created_at", toIso)
      .order("created_at", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("returns")
      .select("id,return_number,branch_id,sale_id,status,reason,notes,refund_total_paisa,restock_total_milli,created_at,completed_at")
      .is("deleted_at", null)
      .gte("created_at", fromIso)
      .lt("created_at", toIso)
      .order("created_at", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("pos_shifts")
      .select("id,branch_id,cashier_id,status,opening_cash_paisa,expected_cash_paisa,counted_cash_paisa,difference_paisa,opened_at,closed_at")
      .is("deleted_at", null)
      .gte("opened_at", fromIso)
      .lt("opened_at", toIso)
      .order("opened_at", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("expenses")
      .select("id,branch_id,category_id,description,amount_paisa,payment_method,reference,spent_at,created_at")
      .is("deleted_at", null)
      .gte("spent_at", fromIso)
      .lt("spent_at", toIso)
      .order("spent_at", { ascending: false }))),
    fetchPaged<Row>(() => client.from("expense_categories").select("id,name").is("deleted_at", null)),
    fetchPaged<Row>(() => branchScope(client
      .from("stock_movements")
      .select("id,branch_id,product_id,movement_type,quantity_delta_milli,unit_cost_paisa,reference_type,reference_id,occurred_at,notes")
      .is("deleted_at", null)
      .gte("occurred_at", fromIso)
      .lt("occurred_at", toIso)
      .order("occurred_at", { ascending: false }))),
    fetchPaged<Row>(() => {
      let query = client
        .from("stock_transfers")
        .select("id,transfer_number,from_branch_id,to_branch_id,status,notes,created_at")
        .is("deleted_at", null)
        .gte("created_at", fromIso)
        .lt("created_at", toIso)
        .order("created_at", { ascending: false });
      if (selectedBranchIds.length === 1) {
        query = query.or(`from_branch_id.eq.${selectedBranchIds[0]},to_branch_id.eq.${selectedBranchIds[0]}`);
      }
      return query;
    }),
    fetchPaged<Row>(() => branchScope(client
      .from("customer_accounts")
      .select("id,name,phone,credit_limit_paisa,is_active,branch_id,created_at")
      .is("deleted_at", null))),
    fetchPaged<Row>(() => branchScope(client
      .from("customer_invoices")
      .select("id,account_id,branch_id,invoice_number,invoice_date,description,amount_paisa,created_at")
      .is("deleted_at", null)
      .order("invoice_date", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("customer_payments")
      .select("id,account_id,branch_id,invoice_id,method,amount_paisa,paid_at,reference")
      .is("deleted_at", null)
      .order("paid_at", { ascending: false }))),
    fetchPaged<Row>(() => client.from("staff_profiles").select("id,full_name,role,branch_id").is("deleted_at", null)),
    fetchPaged<Row>(() => branchScope(client
      .from("web_orders")
      .select("id,order_number,status,total_paisa,created_at,branch_id")
      .is("deleted_at", null)
      .in("status", ["pending", "pending_verification", "awaiting_review"]))),
    fetchPaged<Row>(() => branchScope(client
      .from("pos_shifts")
      .select("id,branch_id,cashier_id,status,opened_at")
      .is("deleted_at", null)
      .eq("status", "open"))),
    fetchPaged<Row>(() => branchScope(client
      .from("returns")
      .select("id,branch_id,status,created_at")
      .is("deleted_at", null)
      .eq("status", "pending"))),
    fetchPaged<Row>(() => branchScope(client
      .from("audit_log")
      .select("id,action,occurred_at,branch_id")
      .is("deleted_at", null)
      .gte("occurred_at", fromIso)
      .lt("occurred_at", toIso))),
    fetchPaged<Row>(() => branchScope(client
      .from("purchase_receipts")
      .select("id,branch_id,supplier_id,supplier_invoice_number,subtotal_paisa,received_at,received_by,purchase_order_id")
      .is("deleted_at", null)
      .gte("received_at", fromIso)
      .lt("received_at", toIso)
      .order("received_at", { ascending: false }))),
    loadStockSnapshot(client, options.branches),
  ]);

  const saleIds = sales.map((sale) => sale.id);
  const returnIds = returns.map((entry) => entry.id);
  const shiftIds = shifts.map((shift) => shift.id);
  const transferIds = transfers.map((transfer) => transfer.id);
  const receiptIds = purchaseReceipts.map((receipt) => receipt.id);

  const [saleItems, payments, returnItems, refunds, cashMovements, transferItems, receiptItems] = await Promise.all([
    loadByIds<Row>(client, "pos_sale_items", "id,sale_id,product_id,product_name,unit_code,quantity_milli,unit_price_paisa,unit_cost_paisa,discount_paisa,tax_paisa,tax_rate_bps,line_total_paisa", "sale_id", saleIds),
    loadByIds<Row>(client, "pos_sale_payments", "id,sale_id,method,amount_paisa", "sale_id", saleIds),
    loadByIds<Row>(client, "return_items", "id,return_id,product_id,product_name,quantity_milli,line_refund_paisa", "return_id", returnIds),
    loadByIds<Row>(client, "return_refunds", "id,return_id,method,amount_paisa,status", "return_id", returnIds),
    loadByIds<Row>(client, "pos_shift_cash_movements", "id,shift_id,movement_type,amount_paisa,reason,created_at,created_by", "shift_id", shiftIds),
    loadByIds<Row>(client, "stock_transfer_items", "id,transfer_id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa", "transfer_id", transferIds),
    loadByIds<Row>(client, "purchase_receipt_items", "id,receipt_id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa", "receipt_id", receiptIds),
  ]);

  const returnSaleIds = returns.map((entry) => entry.sale_id).filter(Boolean);
  const missingSaleIds = returnSaleIds.filter((id) => !sales.some((sale) => sale.id === id));
  const returnSales = missingSaleIds.length
    ? await loadByIds<Row>(client, "pos_sales", "id,receipt_number,customer_name", "id", missingSaleIds)
    : [];

  const saleById = new Map<string, Row>();
  for (const sale of [...sales, ...returnSales]) saleById.set(sale.id, sale);
  const staffById = new Map<string, Row>();
  for (const member of staffProfiles) staffById.set(member.id, member);
  const expenseCategoryById = new Map<string, string>();
  for (const category of expenseCategories) expenseCategoryById.set(category.id, category.name);
  const stockById = new Map(stock.rows.map((row) => [row.id, row]));
  const productName = (id: unknown, fallback?: unknown): string =>
    (typeof id === "string" ? stockById.get(id)?.name : "") || String(fallback || "—");

  const activeSales = sales.filter((sale) => !isVoidStatus(sale));
  const completedSales = sales.filter(isCompletedStatus);
  const activeSaleIds = new Set(activeSales.map((sale) => sale.id));
  const completedSaleIds = new Set(completedSales.map((sale) => sale.id));
  const activeItems = saleItems.filter((item) => activeSaleIds.has(item.sale_id));
  const completedItems = saleItems.filter((item) => completedSaleIds.has(item.sale_id));
  const completedReturns = returns.filter((entry) => statusOf(entry) === "completed");

  const paymentsBySale = groupBy(payments, (payment) => payment.sale_id);
  const firstPaymentMethod = (saleId: string): string => {
    const list = paymentsBySale.get(saleId) || [];
    return list.length ? String(list[0].method || "") : "";
  };

  /* ---------------------------------------------------------------- summary */
  const channelMap = new Map<string, { channel: string; orders: number; total: number; tax: number }>();
  for (const sale of activeSales) {
    const channel = sale.source_type === "web_order" ? "Online" : "In-store / POS";
    const bucket = channelMap.get(channel) || { channel, orders: 0, total: 0, tax: 0 };
    bucket.orders += 1;
    bucket.total += asNumber(sale.total_paisa);
    bucket.tax += asNumber(sale.tax_paisa);
    channelMap.set(channel, bucket);
  }
  const totalSales = activeSales.reduce((total, sale) => total + asNumber(sale.total_paisa), 0);
  const totalTax = activeSales.reduce((total, sale) => total + asNumber(sale.tax_paisa), 0);
  const totalReturns = completedReturns.reduce((total, entry) => total + asNumber(entry.refund_total_paisa), 0);
  const cogs = activeItems.reduce(
    (total, item) => total + (asNumber(item.quantity_milli) * asNumber(item.unit_cost_paisa)) / 1000,
    0,
  );
  const totalExpenses = expenses.reduce((total, entry) => total + asNumber(entry.amount_paisa), 0);
  const netSales = totalSales - totalTax - totalReturns;
  const grossProfit = netSales - cogs;
  const netResult = grossProfit - totalExpenses;
  const lowStock = stock.rows.filter((row) => row.status === "Low").length;
  const outStock = stock.rows.filter((row) => row.status === "Out of stock").length;
  const stockValue = stock.rows.reduce(
    (total, row) => total + stockValuePaisa(row.quantityMilli, row.costPaisa),
    0,
  );

  const accountBalance = new Map<string, number>();
  for (const invoice of customerInvoices) {
    accountBalance.set(invoice.account_id, (accountBalance.get(invoice.account_id) || 0) + asNumber(invoice.amount_paisa));
  }
  for (const payment of customerPayments) {
    accountBalance.set(payment.account_id, (accountBalance.get(payment.account_id) || 0) - asNumber(payment.amount_paisa));
  }
  const totalAccountBalance = [...accountBalance.values()].reduce((total, value) => total + value, 0);
  const activeAccountCount = customerAccounts.filter((account) => account.is_active).length;

  const summary: ReportSectionSpec = finalizeSection({
    id: "summary",
    title: "Executive summary",
    group: "Overview",
    note: "Sales, returns, cost and shop expenses for the period, plus where the shop stands today. Cost of goods is an estimate: item quantity multiplied by the product cost price.",
    tables: [
      table([
        { key: "channel", label: "Sales channel", type: "text" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "total", label: "Sales", type: "money", sum: true },
        { key: "average", label: "Average order", type: "money" },
        { key: "tax", label: "Tax", type: "money", sum: true },
        { key: "delivery", label: "Delivery", type: "money", sum: true },
      ], [...channelMap.values()].map((bucket) => ({
        channel: bucket.channel,
        orders: bucket.orders,
        total: bucket.total,
        average: bucket.orders ? bucket.total / bucket.orders : 0,
        tax: bucket.tax,
        delivery: 0,
      })).sort((left, right) => right.total - left.total), { title: "Sales by channel" }),
      table([
        { key: "item", label: "Item", type: "text" },
        { key: "amount", label: "Amount", type: "money" },
      ], [
        { item: "Total sales (including tax)", amount: totalSales },
        { item: "Less: tax collected", amount: totalTax },
        { item: "Less: completed returns", amount: totalReturns },
        { item: "Net sales", amount: netSales },
        { item: "Less: estimated cost of goods", amount: cogs },
        { item: "Estimated gross profit", amount: grossProfit },
        { item: "Less: shop expenses", amount: totalExpenses },
        { item: "Estimated net result", amount: netResult },
      ], { title: "Period result" }),
      table([
        { key: "item", label: "Item", type: "text" },
        { key: "value", label: "Value", type: "text" },
      ], [
        { item: "Online orders waiting to be verified", value: String(pendingWebOrders.length) },
        { item: "Return requests waiting for a decision", value: String(pendingReturns.length) },
        { item: "POS shifts open right now", value: String(openShifts.length) },
        { item: "Stock value at cost", value: moneyText(stockValue) },
        { item: "Products low on stock / out of stock", value: `${lowStock} / ${outStock}` },
        { item: "Customer accounts on file", value: String(activeAccountCount) },
        { item: "Customer account balance (net total)", value: moneyText(totalAccountBalance) },
      ], { title: "Position as of today" }),
    ],
  });

  /* ------------------------------------------------------------------ daily */
  const dayMap = new Map<string, { day: string; orders: number; instore: number; online: number; total: number; tax: number; returns: number }>();
  for (const sale of activeSales) {
    const day = pakistanDayKey(sale.created_at);
    const bucket = dayMap.get(day) || { day, orders: 0, instore: 0, online: 0, total: 0, tax: 0, returns: 0 };
    bucket.orders += 1;
    if (sale.source_type === "web_order") bucket.online += asNumber(sale.total_paisa);
    else bucket.instore += asNumber(sale.total_paisa);
    bucket.total += asNumber(sale.total_paisa);
    bucket.tax += asNumber(sale.tax_paisa);
    dayMap.set(day, bucket);
  }
  for (const entry of completedReturns) {
    const day = pakistanDayKey(entry.created_at);
    const bucket = dayMap.get(day) || { day, orders: 0, instore: 0, online: 0, total: 0, tax: 0, returns: 0 };
    bucket.returns += asNumber(entry.refund_total_paisa);
    dayMap.set(day, bucket);
  }
  const daily: ReportSectionSpec = finalizeSection({
    id: "daily",
    title: "Daily sales",
    group: "Overview",
    note: "Orders from every channel by day. Net sales is total sales minus completed returns made that day.",
    tables: [
      table([
        { key: "day", label: "Date", type: "date" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "instore", label: "In-store", type: "money", sum: true },
        { key: "online", label: "Online", type: "money", sum: true },
        { key: "total", label: "Total sales", type: "money", sum: true },
        { key: "tax", label: "Tax", type: "money", sum: true },
        { key: "delivery", label: "Delivery", type: "money", sum: true },
        { key: "returns", label: "Returns", type: "money", sum: true },
        { key: "net", label: "Net sales", type: "money", sum: true },
      ], [...dayMap.values()].sort((left, right) => left.day.localeCompare(right.day)).map((bucket) => ({
        ...bucket,
        delivery: 0,
        net: bucket.total - bucket.returns,
      }))),
    ],
  });

  /* ---------------------------------------------------------------- monthly */
  const monthMap = new Map<string, { month: string; orders: number; sales: number; returns: number; expenses: number }>();
  for (const sale of activeSales) {
    const key = monthKey(sale.created_at);
    const bucket = monthMap.get(key) || { month: key, orders: 0, sales: 0, returns: 0, expenses: 0 };
    bucket.orders += 1;
    bucket.sales += asNumber(sale.total_paisa);
    monthMap.set(key, bucket);
  }
  for (const entry of completedReturns) {
    const key = monthKey(entry.created_at);
    const bucket = monthMap.get(key) || { month: key, orders: 0, sales: 0, returns: 0, expenses: 0 };
    bucket.returns += asNumber(entry.refund_total_paisa);
    monthMap.set(key, bucket);
  }
  for (const entry of expenses) {
    const key = monthKey(entry.spent_at);
    const bucket = monthMap.get(key) || { month: key, orders: 0, sales: 0, returns: 0, expenses: 0 };
    bucket.expenses += asNumber(entry.amount_paisa);
    monthMap.set(key, bucket);
  }
  const monthly: ReportSectionSpec = finalizeSection({
    id: "monthly",
    title: "Month-by-month results",
    group: "Overview",
    note: "Sales, returns and shop expenses by month. Net is sales minus returns and expenses; it is not an audited profit figure.",
    tables: [
      table([
        { key: "month", label: "Month", type: "text" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "sales", label: "Sales", type: "money", sum: true },
        { key: "returns", label: "Returns", type: "money", sum: true },
        { key: "expenses", label: "Shop expenses", type: "money", sum: true },
        { key: "net", label: "Net", type: "money", sum: true },
      ], [...monthMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, bucket]) => ({
        month: monthLabel(key),
        orders: bucket.orders,
        sales: bucket.sales,
        returns: bucket.returns,
        expenses: bucket.expenses,
        net: bucket.sales - bucket.returns - bucket.expenses,
      }))),
    ],
  });

  /* --------------------------------------------------------------- branches */
  const branchSales = groupBy(activeSales, (sale) => String(sale.branch_id || ""));
  const branchReturns = groupBy(completedReturns, (entry) => String(entry.branch_id || ""));
  const branches: ReportSectionSpec = finalizeSection({
    id: "branches",
    title: "Branch performance",
    group: "Sales",
    note: "Each branch with its orders, sales, returns and net sales for the period.",
    tables: [
      table([
        { key: "branch", label: "Branch", type: "text" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "sales", label: "Sales", type: "money", sum: true },
        { key: "average", label: "Average order", type: "money" },
        { key: "tax", label: "Tax", type: "money", sum: true },
        { key: "delivery", label: "Delivery", type: "money", sum: true },
        { key: "returns", label: "Returns", type: "money", sum: true },
        { key: "net", label: "Net sales", type: "money", sum: true },
      ], [...branchSales.entries()].map(([id, rows]) => {
        const total = rows.reduce((sum, sale) => sum + asNumber(sale.total_paisa), 0);
        const refunds = (branchReturns.get(id) || []).reduce((sum, entry) => sum + asNumber(entry.refund_total_paisa), 0);
        return {
          branch: branchName(id),
          orders: rows.length,
          sales: total,
          average: rows.length ? total / rows.length : 0,
          tax: rows.reduce((sum, sale) => sum + asNumber(sale.tax_paisa), 0),
          delivery: 0,
          returns: refunds,
          net: total - refunds,
        };
      }).sort((left, right) => right.sales - left.sales)),
    ],
  });

  /* --------------------------------------------------------------- payments */
  const paymentMethodMap = new Map<string, { method: string; count: number; amount: number }>();
  for (const payment of payments) {
    if (!activeSaleIds.has(payment.sale_id)) continue;
    const method = String(payment.method || "unknown");
    const bucket = paymentMethodMap.get(method) || { method, count: 0, amount: 0 };
    bucket.count += 1;
    bucket.amount += asNumber(payment.amount_paisa);
    paymentMethodMap.set(method, bucket);
  }
  const channelTotals = new Map<string, { channel: string; orders: number; total: number }>();
  for (const sale of activeSales) {
    const channel = String(sale.source_type || "pos");
    const bucket = channelTotals.get(channel) || { channel, orders: 0, total: 0 };
    bucket.orders += 1;
    bucket.total += asNumber(sale.total_paisa);
    channelTotals.set(channel, bucket);
  }
  const posPaymentMap = new Map<string, { method: string; count: number; amount: number }>();
  for (const payment of payments) {
    if (!completedSaleIds.has(payment.sale_id)) continue;
    const method = String(payment.method || "unknown");
    const bucket = posPaymentMap.get(method) || { method, count: 0, amount: 0 };
    bucket.count += 1;
    bucket.amount += asNumber(payment.amount_paisa);
    posPaymentMap.set(method, bucket);
  }
  const paymentTotal = [...paymentMethodMap.values()].reduce((total, bucket) => total + bucket.amount, 0);
  const paymentsSection: ReportSectionSpec = finalizeSection({
    id: "payments",
    title: "Payment methods and channels",
    group: "Sales",
    note: "How customers paid, and which channels brought in the sales.",
    tables: [
      table([
        { key: "method", label: "Payment method", type: "badge" },
        { key: "orders", label: "Payments", type: "int", sum: true },
        { key: "amount", label: "Amount", type: "money", sum: true },
        { key: "share", label: "Share", type: "pct" },
      ], [...paymentMethodMap.values()].sort((left, right) => right.amount - left.amount).map((bucket) => ({
        method: bucket.method,
        orders: bucket.count,
        amount: bucket.amount,
        share: pct(bucket.amount, paymentTotal),
      })), { title: "Payments by method" }),
      table([
        { key: "channel", label: "Order type", type: "badge" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], [...channelTotals.values()].sort((left, right) => right.total - left.total).map((bucket) => ({
        channel: bucket.channel,
        orders: bucket.orders,
        amount: bucket.total,
      })), { title: "Sales by channel" }),
      table([
        { key: "method", label: "POS payment method", type: "badge" },
        { key: "payments", label: "Payments", type: "int", sum: true },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], [...posPaymentMap.values()].sort((left, right) => right.amount - left.amount).map((bucket) => ({
        method: bucket.method,
        payments: bucket.count,
        amount: bucket.amount,
      })), { title: "POS payments received (split payments counted separately)" }),
    ],
  });

  /* --------------------------------------------------------------- products */
  const productAgg = new Map<string, { name: string; category: string; quantity: number; revenue: number; cost: number }>();
  for (const item of activeItems) {
    const key = String(item.product_id || item.product_name);
    const meta = item.product_id ? stockById.get(item.product_id) : undefined;
    const bucket = productAgg.get(key) || {
      name: String(item.product_name || meta?.name || "—"),
      category: meta?.category || "Uncategorised",
      quantity: 0,
      revenue: 0,
      cost: 0,
    };
    bucket.quantity += quantity(item.quantity_milli);
    bucket.revenue += asNumber(item.line_total_paisa);
    bucket.cost += (asNumber(item.quantity_milli) * asNumber(item.unit_cost_paisa)) / 1000;
    productAgg.set(key, bucket);
  }
  const productRows = [...productAgg.values()]
    .sort((left, right) => right.revenue - left.revenue)
    .slice(0, 200);
  const products: ReportSectionSpec = finalizeSection({
    id: "products",
    title: "Products sold",
    group: "Sales",
    note: "From sale lines of all channels, with completed returns taken off. Cost and margin are estimates from the product cost price.",
    tables: [
      table([
        { key: "product", label: "Product", type: "text" },
        { key: "category", label: "Category", type: "text" },
        { key: "quantity", label: "Quantity sold", type: "num", sum: true },
        { key: "average", label: "Average price", type: "money" },
        { key: "revenue", label: "Revenue", type: "money", sum: true },
        { key: "cost", label: "Est. cost", type: "money", sum: true },
        { key: "margin", label: "Est. margin", type: "money", sum: true },
      ], productRows.map((row) => ({
        product: row.name,
        category: row.category,
        quantity: row.quantity,
        average: row.quantity ? row.revenue / row.quantity : 0,
        revenue: row.revenue,
        cost: row.cost,
        margin: row.revenue - row.cost,
      })), { title: "Top 200 products by revenue" }),
    ],
  });

  /* ------------------------------------------------------------- categories */
  const categoryAgg = new Map<string, { category: string; quantity: number; revenue: number; cost: number }>();
  for (const row of productRows) {
    const bucket = categoryAgg.get(row.category) || { category: row.category, quantity: 0, revenue: 0, cost: 0 };
    bucket.quantity += row.quantity;
    bucket.revenue += row.revenue;
    bucket.cost += row.cost;
    categoryAgg.set(row.category, bucket);
  }
  const categoryTotal = [...categoryAgg.values()].reduce((total, row) => total + row.revenue, 0);
  const categories: ReportSectionSpec = finalizeSection({
    id: "categories",
    title: "Sales by category",
    group: "Sales",
    note: "Revenue by product category from sale lines. Quantities mix units (kg, pieces) so read them as a rough guide.",
    tables: [
      table([
        { key: "category", label: "Category", type: "text" },
        { key: "quantity", label: "Units sold", type: "num", sum: true },
        { key: "revenue", label: "Revenue", type: "money", sum: true },
        { key: "cost", label: "Est. cost", type: "money", sum: true },
        { key: "margin", label: "Est. margin", type: "money", sum: true },
        { key: "share", label: "Share", type: "pct" },
      ], [...categoryAgg.values()].sort((left, right) => right.revenue - left.revenue).map((row) => ({
        category: row.category,
        quantity: row.quantity,
        revenue: row.revenue,
        cost: row.cost,
        margin: row.revenue - row.cost,
        share: pct(row.revenue, categoryTotal),
      }))),
    ],
  });

  /* ----------------------------------------------------------------- orders */
  const orders: ReportSectionSpec = finalizeSection({
    id: "orders",
    title: "Order register",
    group: "Sales",
    note: "Latest 500 sales in the period. Voided and cancelled sales are shown but not counted in the totals.",
    tables: [
      table([
        { key: "order", label: "Order", type: "text" },
        { key: "date", label: "Date", type: "datetime" },
        { key: "customer", label: "Customer", type: "text" },
        { key: "branch", label: "Branch", type: "text" },
        { key: "type", label: "Type", type: "badge" },
        { key: "payment", label: "Payment", type: "badge" },
        { key: "status", label: "Status", type: "badge" },
        { key: "total", label: "Total", type: "money", sum: true },
        { key: "tax", label: "Tax", type: "money", sum: true },
        { key: "delivery", label: "Delivery", type: "money", sum: true },
      ], sales.slice(0, 500).map((sale) => ({
        order: sale.receipt_number || sale.id,
        date: sale.created_at,
        customer: sale.customer_name || "Walk-in Customer",
        branch: branchName(sale.branch_id),
        type: sale.source_type === "web_order" ? "Web" : "POS",
        payment: firstPaymentMethod(sale.id) || "—",
        status: sale.status,
        total: asNumber(sale.total_paisa),
        tax: asNumber(sale.tax_paisa),
        delivery: 0,
        __nosum: isVoidStatus(sale),
      }))),
    ],
  });

  /* ----------------------------------------------------------------- status */
  const statusMap = groupBy(sales, (sale) => statusOf(sale) || "unknown");
  const cancelled = sales.filter(isVoidStatus);
  const cancellationMap = groupBy(cancelled, (sale) => String(sale.notes || "Not stated"));
  const status: ReportSectionSpec = finalizeSection({
    id: "status",
    title: "Order status and cancellations",
    group: "Sales",
    note: "Where orders stand, and why orders were cancelled or voided.",
    tables: [
      table([
        { key: "status", label: "Status", type: "badge" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "value", label: "Value", type: "money", sum: true },
      ], [...statusMap.entries()].map(([key, rows]) => ({
        status: key,
        orders: rows.length,
        value: rows.reduce((total, sale) => total + asNumber(sale.total_paisa), 0),
      })).sort((left, right) => right.orders - left.orders), { title: "Orders by status" }),
      table([
        { key: "reason", label: "Cancellation reason", type: "text" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "value", label: "Value lost", type: "money", sum: true },
      ], [...cancellationMap.entries()].map(([reason, rows]) => ({
        reason,
        orders: rows.length,
        value: rows.reduce((total, sale) => total + asNumber(sale.total_paisa), 0),
      })).sort((left, right) => right.orders - left.orders), {
        title: "Cancelled orders",
        empty: "No cancelled orders in this period.",
      }),
    ],
  });

  /* -------------------------------------------------------------------- tax */
  const taxRateMap = new Map<string, { rate: number; orders: Set<string>; value: number; tax: number }>();
  for (const item of activeItems) {
    const rate = asNumber(item.tax_rate_bps) / 100;
    const key = String(rate);
    const bucket = taxRateMap.get(key) || { rate, orders: new Set<string>(), value: 0, tax: 0 };
    bucket.orders.add(item.sale_id);
    bucket.value += asNumber(item.line_total_paisa);
    bucket.tax += asNumber(item.tax_paisa);
    taxRateMap.set(key, bucket);
  }
  const taxBranch = groupBy(activeSales, (sale) => String(sale.branch_id || ""));
  const tax: ReportSectionSpec = finalizeSection({
    id: "tax",
    title: "Tax and delivery",
    group: "Sales",
    note: "Tax and delivery charges collected on non-void sales.",
    tables: [
      table([
        { key: "rate", label: "Tax rate (%)", type: "num" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "value", label: "Order value", type: "money", sum: true },
        { key: "tax", label: "Tax collected", type: "money", sum: true },
      ], [...taxRateMap.values()].sort((left, right) => right.tax - left.tax).map((bucket) => ({
        rate: bucket.rate,
        orders: bucket.orders.size,
        value: bucket.value,
        tax: bucket.tax,
      })), { title: "Tax by rate" }),
      table([
        { key: "branch", label: "Branch", type: "text" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "tax", label: "Tax collected", type: "money", sum: true },
        { key: "delivery", label: "Delivery charged", type: "money", sum: true },
      ], [...taxBranch.entries()].map(([id, rows]) => ({
        branch: branchName(id),
        orders: rows.length,
        tax: rows.reduce((total, sale) => total + asNumber(sale.tax_paisa), 0),
        delivery: 0,
      })).sort((left, right) => right.tax - left.tax), { title: "Tax and delivery by branch" }),
    ],
  });

  /* -------------------------------------------------------------- pos sales */
  const posStatusMap = groupBy(sales, (sale) => statusOf(sale) || "unknown");
  const posDaily = new Map<string, { day: string; bills: number; subtotal: number; discounts: number; tax: number; total: number; cost: number }>();
  for (const sale of completedSales) {
    const day = pakistanDayKey(sale.created_at);
    const bucket = posDaily.get(day) || { day, bills: 0, subtotal: 0, discounts: 0, tax: 0, total: 0, cost: 0 };
    bucket.bills += 1;
    bucket.subtotal += asNumber(sale.subtotal_paisa);
    bucket.discounts += asNumber(sale.item_discount_paisa) + asNumber(sale.bill_discount_paisa);
    bucket.tax += asNumber(sale.tax_paisa);
    bucket.total += asNumber(sale.total_paisa);
    bucket.cost += asNumber(sale.cost_total_paisa);
    posDaily.set(day, bucket);
  }
  const posTaxMap = new Map<string, { rate: number; tax: number }>();
  for (const item of completedItems) {
    if (asNumber(item.tax_paisa) <= 0) continue;
    const rate = asNumber(item.tax_rate_bps) / 100;
    const bucket = posTaxMap.get(String(rate)) || { rate, tax: 0 };
    bucket.tax += asNumber(item.tax_paisa);
    posTaxMap.set(String(rate), bucket);
  }
  const posBranch = groupBy(completedSales, (sale) => String(sale.branch_id || ""));
  const posSales: ReportSectionSpec = finalizeSection({
    id: "pos_sales",
    title: "POS sales and profit",
    group: "POS",
    note: "Counter sales recorded in the POS. Profit is the bill total minus tax minus the cost recorded at the time of sale. Voided sales are left out of the profit figures.",
    tables: [
      table([
        { key: "status", label: "Sale status", type: "badge" },
        { key: "bills", label: "Bills", type: "int", sum: true },
        { key: "value", label: "Value", type: "money", sum: true },
      ], [...posStatusMap.entries()].map(([key, rows]) => ({
        status: key,
        bills: rows.length,
        value: rows.reduce((total, sale) => total + asNumber(sale.total_paisa), 0),
      })).sort((left, right) => right.bills - left.bills), { title: "POS sales by status" }),
      table([
        { key: "day", label: "Date", type: "date" },
        { key: "bills", label: "Bills", type: "int", sum: true },
        { key: "subtotal", label: "Subtotal", type: "money", sum: true },
        { key: "discounts", label: "Discounts", type: "money", sum: true },
        { key: "tax", label: "Tax", type: "money", sum: true },
        { key: "total", label: "Bill total", type: "money", sum: true },
        { key: "net", label: "Sales ex tax", type: "money", sum: true },
        { key: "cost", label: "Cost", type: "money", sum: true },
        { key: "profit", label: "Profit", type: "money", sum: true },
        { key: "margin", label: "Margin", type: "pct" },
      ], [...posDaily.values()].sort((left, right) => left.day.localeCompare(right.day)).map((bucket) => {
        const net = bucket.total - bucket.tax;
        return {
          day: bucket.day,
          bills: bucket.bills,
          subtotal: bucket.subtotal,
          discounts: bucket.discounts,
          tax: bucket.tax,
          total: bucket.total,
          net,
          cost: bucket.cost,
          profit: net - bucket.cost,
          margin: pct(net - bucket.cost, net),
        };
      }), { title: "POS daily sales and profit (profit = sales ex tax minus cost)" }),
      table([
        { key: "rate", label: "Rate %", type: "num" },
        { key: "tax", label: "Tax collected", type: "money", sum: true },
      ], [...posTaxMap.values()].sort((left, right) => right.tax - left.tax).map((bucket) => ({
        rate: bucket.rate,
        tax: bucket.tax,
      })), { title: "POS tax collected (before any returns)" }),
      table([
        { key: "branch", label: "Branch", type: "text" },
        { key: "bills", label: "Bills", type: "int", sum: true },
        { key: "total", label: "Bill total", type: "money", sum: true },
        { key: "cost", label: "Cost", type: "money", sum: true },
        { key: "profit", label: "Profit", type: "money", sum: true },
        { key: "offline", label: "Sold offline", type: "int", sum: true },
      ], [...posBranch.entries()].map(([id, rows]) => ({
        branch: branchName(id),
        bills: rows.length,
        total: rows.reduce((total, sale) => total + asNumber(sale.total_paisa), 0),
        cost: rows.reduce((total, sale) => total + asNumber(sale.cost_total_paisa), 0),
        profit: rows.reduce((total, sale) => total + asNumber(sale.total_paisa) - asNumber(sale.tax_paisa) - asNumber(sale.cost_total_paisa), 0),
        offline: rows.filter((sale) => sale.created_offline).length,
      })).sort((left, right) => right.total - left.total), { title: "POS by branch" }),
    ],
  });

  /* --------------------------------------------------------------- cashiers */
  const cashierMap = groupBy(sales, (sale) => String(sale.cashier_id || "unknown"));
  const cashiers: ReportSectionSpec = finalizeSection({
    id: "cashiers",
    title: "Cashier performance",
    group: "POS",
    note: "Every person who rang up POS sales in the period.",
    tables: [
      table([
        { key: "name", label: "Name", type: "text" },
        { key: "role", label: "Role", type: "badge" },
        { key: "bills", label: "Bills", type: "int", sum: true },
        { key: "sales", label: "Sales", type: "money", sum: true },
        { key: "average", label: "Average bill", type: "money" },
        { key: "discounts", label: "Discounts given", type: "money", sum: true },
        { key: "voids", label: "Voided", type: "int", sum: true },
        { key: "refunds", label: "Refunded", type: "int", sum: true },
      ], [...cashierMap.entries()].map(([id, rows]) => {
        const member = staffById.get(id);
        const salesTotal = rows.filter(isCompletedStatus).reduce((total, sale) => total + asNumber(sale.total_paisa), 0);
        return {
          name: member?.full_name || "Unknown",
          role: member?.role || "staff",
          bills: rows.length,
          sales: salesTotal,
          average: rows.length ? salesTotal / rows.length : 0,
          discounts: rows.reduce((total, sale) => total + asNumber(sale.item_discount_paisa) + asNumber(sale.bill_discount_paisa), 0),
          voids: rows.filter((sale) => statusOf(sale) === "void").length,
          refunds: rows.filter((sale) => ["refunded", "partial_refund"].includes(statusOf(sale))).length,
        };
      }).sort((left, right) => right.sales - left.sales)),
    ],
  });

  /* ----------------------------------------------------------------- shifts */
  const shiftRows = shifts.slice(0, 300).map((shift) => ({
    shift: shift.id,
    branch: branchName(shift.branch_id),
    staff: staffById.get(shift.cashier_id)?.full_name || "Unknown",
    opened: shift.opened_at,
    closed: shift.closed_at || "",
    opening: asNumber(shift.opening_cash_paisa),
    expected: asNumber(shift.expected_cash_paisa),
    counted: asNumber(shift.counted_cash_paisa),
    difference: asNumber(shift.difference_paisa),
    status: shift.status,
  }));
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
  const shiftsSection: ReportSectionSpec = finalizeSection({
    id: "shifts",
    title: "Shifts and cash",
    group: "POS",
    note: "Shifts opened in the period. A difference other than zero means the counted cash did not match the expected cash.",
    tables: [
      table([
        { key: "shift", label: "Shift", type: "text" },
        { key: "branch", label: "Branch", type: "text" },
        { key: "staff", label: "Staff", type: "text" },
        { key: "opened", label: "Opened", type: "datetime" },
        { key: "closed", label: "Closed", type: "datetime" },
        { key: "opening", label: "Opening cash", type: "money", sum: true },
        { key: "expected", label: "Expected", type: "money", sum: true },
        { key: "counted", label: "Counted", type: "money", sum: true },
        { key: "difference", label: "Difference", type: "money", sum: true },
        { key: "status", label: "Status", type: "badge" },
      ], shiftRows, { title: "Shift register" }),
      table([
        { key: "when", label: "When", type: "datetime" },
        { key: "direction", label: "Direction", type: "badge" },
        { key: "staff", label: "Staff", type: "text" },
        { key: "reason", label: "Reason", type: "text" },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], cashMovements.slice(0, 300).map((movement) => ({
        when: movement.created_at,
        direction: movement.movement_type,
        staff: staffById.get(shiftById.get(movement.shift_id)?.cashier_id)?.full_name || "Unknown",
        reason: movement.reason,
        amount: asNumber(movement.amount_paisa),
      })), { title: "Cash taken out or put in during shifts" }),
    ],
  });

  /* ----------------------------------------------------------- shop expenses */
  const expenseMap = groupBy(expenses, (entry) => String(entry.category_id || ""));
  const expenseTotal = expenses.reduce((total, entry) => total + asNumber(entry.amount_paisa), 0);
  const posExpenses: ReportSectionSpec = finalizeSection({
    id: "pos_expenses",
    title: "Shop expenses",
    group: "POS",
    note: "Expenses entered for the period.",
    tables: [
      table([
        { key: "category", label: "Category", type: "text" },
        { key: "entries", label: "Entries", type: "int", sum: true },
        { key: "amount", label: "Amount", type: "money", sum: true },
        { key: "share", label: "Share", type: "pct" },
      ], [...expenseMap.entries()].map(([id, rows]) => {
        const amount = rows.reduce((total, entry) => total + asNumber(entry.amount_paisa), 0);
        return {
          category: expenseCategoryById.get(id) || "Uncategorised",
          entries: rows.length,
          amount,
          share: pct(amount, expenseTotal),
        };
      }).sort((left, right) => right.amount - left.amount), { title: "Expenses by category" }),
      table([
        { key: "date", label: "Date", type: "date" },
        { key: "branch", label: "Branch", type: "text" },
        { key: "category", label: "Category", type: "text" },
        { key: "note", label: "Note", type: "text" },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], expenses.slice(0, 500).map((entry) => ({
        date: entry.spent_at,
        branch: branchName(entry.branch_id),
        category: expenseCategoryById.get(entry.category_id) || "Uncategorised",
        note: entry.description || entry.reference || "",
        amount: asNumber(entry.amount_paisa),
      })), { title: "Expense details (latest 500)" }),
    ],
  });

  /* ------------------------------------------------------------------ voids */
  const discountRows = [{
    bills: sales.length,
    discounted: sales.filter((sale) => asNumber(sale.item_discount_paisa) + asNumber(sale.bill_discount_paisa) > 0).length,
    itemDiscount: sales.reduce((total, sale) => total + asNumber(sale.item_discount_paisa), 0),
    billDiscount: sales.reduce((total, sale) => total + asNumber(sale.bill_discount_paisa), 0),
    overrides: sales.filter((sale) => sale.override_by).length,
  }];
  const nonCompleted = sales.filter((sale) => statusOf(sale) !== "completed");
  const auditMap = groupBy(auditRows, (entry) => String(entry.action || "unknown"));
  const voids: ReportSectionSpec = finalizeSection({
    id: "voids",
    title: "Voids, refunds and discounts",
    group: "POS",
    note: "Sales that were not completed normally, discounts given, and the activity log for the period.",
    tables: [
      table([
        { key: "bills", label: "Bills", type: "int" },
        { key: "discounted", label: "Bills with a discount", type: "int" },
        { key: "itemDiscount", label: "Item discounts", type: "money" },
        { key: "billDiscount", label: "Bill discounts", type: "money" },
        { key: "overrides", label: "Manager overrides", type: "int" },
      ], discountRows, { title: "Discount summary" }),
      table([
        { key: "sale", label: "Sale", type: "text" },
        { key: "date", label: "Date", type: "datetime" },
        { key: "branch", label: "Branch", type: "text" },
        { key: "status", label: "Status", type: "badge" },
        { key: "value", label: "Value", type: "money", sum: true },
        { key: "override", label: "Override by", type: "text" },
      ], nonCompleted.slice(0, 300).map((sale) => ({
        sale: sale.receipt_number || sale.id,
        date: sale.created_at,
        branch: branchName(sale.branch_id),
        status: sale.status,
        value: asNumber(sale.total_paisa),
        override: sale.override_by || "—",
      })), {
        title: "Voided and refunded sales",
        empty: "No voided or refunded sales in this period.",
      }),
      table([
        { key: "activity", label: "Activity", type: "badge" },
        { key: "times", label: "Times", type: "int", sum: true },
      ], [...auditMap.entries()].map(([action, rows]) => ({
        activity: action,
        times: rows.length,
      })).sort((left, right) => right.times - left.times).slice(0, 40), { title: "Activity log summary" }),
    ],
  });

  /* -------------------------------------------------------------- customers */
  const periodAccounts = customerAccounts.filter((account) =>
    account.created_at >= fromIso && account.created_at < toIso);
  const customerMap = new Map<string, { name: string; phone: string; orders: number; spent: number; last: string }>();
  for (const sale of activeSales) {
    const phone = String(sale.customer_phone || "").trim();
    if (!phone || phone === "0000000000") continue;
    const bucket = customerMap.get(phone) || {
      name: String(sale.customer_name || "Customer"),
      phone,
      orders: 0,
      spent: 0,
      last: String(sale.created_at || ""),
    };
    bucket.orders += 1;
    bucket.spent += asNumber(sale.total_paisa);
    if (String(sale.created_at || "") > bucket.last) bucket.last = String(sale.created_at || "");
    customerMap.set(phone, bucket);
  }
  const customers: ReportSectionSpec = finalizeSection({
    id: "customers",
    title: "Customers",
    group: "Customers and returns",
    note: "Top buyers by phone number (walk-in customers without a number are left out), plus customer accounts.",
    tables: [
      table([
        { key: "total", label: "Customer accounts", type: "int" },
        { key: "active", label: "Active", type: "int" },
        { key: "new", label: "New in this period", type: "int" },
      ], [{
        total: customerAccounts.length,
        active: activeAccountCount,
        new: periodAccounts.length,
      }], { title: "Customer accounts (as of today)" }),
      table([
        { key: "customer", label: "Customer", type: "text" },
        { key: "phone", label: "Phone", type: "text" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "spent", label: "Spent", type: "money", sum: true },
        { key: "average", label: "Average order", type: "money" },
        { key: "last", label: "Last order", type: "datetime" },
      ], [...customerMap.values()].sort((left, right) => right.spent - left.spent).slice(0, 50).map((bucket) => ({
        customer: bucket.name,
        phone: bucket.phone,
        orders: bucket.orders,
        spent: bucket.spent,
        average: bucket.orders ? bucket.spent / bucket.orders : 0,
        last: bucket.last,
      })), { title: "Top 50 customers" }),
    ],
  });

  /* ------------------------------------------------------------- pos credit */
  const accountById = new Map(customerAccounts.map((account) => [account.id, account]));
  const accountInvoices = groupBy(customerInvoices, (invoice) => invoice.account_id);
  const accountPayments = groupBy(customerPayments, (payment) => payment.account_id);
  const balanceRows = [...accountBalance.entries()]
    .filter(([id, balance]) => balance !== 0 && accountById.get(id)?.is_active)
    .map(([id, balance]) => {
      const account = accountById.get(id);
      const limit = asNumber(account?.credit_limit_paisa);
      return {
        customer: account?.name || "Unknown",
        phone: account?.phone || "—",
        limit,
        balance,
        points: 0,
        flag: limit > 0 && balance > limit ? "Over limit" : "OK",
      };
    })
    .sort((left, right) => right.balance - left.balance);

  const ledgerEntries: Array<{
    when: string;
    customer: string;
    entry: string;
    method: string;
    amount: number;
    balanceAfter: number | null;
    note: string;
  }> = [];
  for (const [accountId, invoices] of accountInvoices) {
    const account = accountById.get(accountId);
    const events = [
      ...invoices.map((invoice) => ({
        when: String(invoice.created_at || invoice.invoice_date),
        entry: "Invoice",
        method: "",
        amount: asNumber(invoice.amount_paisa),
        note: invoice.description || invoice.invoice_number || "",
      })),
      ...(accountPayments.get(accountId) || []).map((payment) => ({
        when: String(payment.paid_at || ""),
        entry: "Payment",
        method: String(payment.method || ""),
        amount: -asNumber(payment.amount_paisa),
        note: payment.reference || "",
      })),
    ].sort((left, right) => left.when.localeCompare(right.when));
    let running = 0;
    for (const event of events) {
      running += event.amount;
      const inPeriod = event.when >= fromIso && event.when < toIso;
      if (!inPeriod) continue;
      ledgerEntries.push({
        when: event.when,
        customer: account?.name || "Unknown",
        entry: event.entry,
        method: event.method || "—",
        amount: Math.abs(event.amount),
        balanceAfter: running,
        note: event.note,
      });
    }
  }
  const posCredit: ReportSectionSpec = finalizeSection({
    id: "pos_credit",
    title: "POS customer credit",
    group: "Customers and returns",
    note: "As of today. Customer accounts with a balance, plus ledger entries in the period.",
    tables: [
      table([
        { key: "customer", label: "Customer", type: "text" },
        { key: "phone", label: "Phone", type: "text" },
        { key: "limit", label: "Credit limit", type: "money" },
        { key: "balance", label: "Balance", type: "money", sum: true },
        { key: "points", label: "Loyalty points", type: "int", sum: true },
        { key: "flag", label: "Limit check", type: "text" },
      ], balanceRows, { title: "Customer account balances" }),
      table([
        { key: "when", label: "When", type: "datetime" },
        { key: "customer", label: "Customer", type: "text" },
        { key: "entry", label: "Entry", type: "badge" },
        { key: "method", label: "Method", type: "badge" },
        { key: "amount", label: "Amount", type: "money", sum: true },
        { key: "balanceAfter", label: "Balance after", type: "money" },
        { key: "note", label: "Note", type: "text" },
      ], ledgerEntries.sort((left, right) => right.when.localeCompare(left.when)).slice(0, 300), {
        title: "Ledger entries in the period",
      }),
    ],
  });

  /* ---------------------------------------------------------------- returns */
  const returnStatusMap = groupBy(returns, (entry) => statusOf(entry) || "unknown");
  const returnReasonMap = groupBy(returns, (entry) => String(entry.reason || "Not stated"));
  const completedReturnIds = new Set(completedReturns.map((entry) => entry.id));
  const returnedProducts = new Map<string, { name: string; quantity: number; value: number }>();
  for (const item of returnItems) {
    if (!completedReturnIds.has(item.return_id)) continue;
    const key = String(item.product_id || item.product_name);
    const bucket = returnedProducts.get(key) || {
      name: productName(item.product_id, item.product_name),
      quantity: 0,
      value: 0,
    };
    bucket.quantity += quantity(item.quantity_milli);
    bucket.value += asNumber(item.line_refund_paisa);
    returnedProducts.set(key, bucket);
  }
  const refundsByReturn = groupBy(refunds, (refund) => refund.return_id);
  const refundMap = new Map<string, { type: string; status: string; count: number; amount: number }>();
  for (const refund of refunds) {
    const type = String(refund.method || "unknown");
    const status = String(refund.status || "pending");
    const key = `${type}|${status}`;
    const bucket = refundMap.get(key) || { type, status, count: 0, amount: 0 };
    bucket.count += 1;
    bucket.amount += asNumber(refund.amount_paisa);
    refundMap.set(key, bucket);
  }
  const returnsSection: ReportSectionSpec = finalizeSection({
    id: "returns",
    title: "Returns",
    group: "Customers and returns",
    note: "Return requests created in the period. Value is the total return amount on each request.",
    tables: [
      table([
        { key: "status", label: "Status", type: "badge" },
        { key: "requests", label: "Requests", type: "int", sum: true },
        { key: "value", label: "Value", type: "money", sum: true },
      ], [...returnStatusMap.entries()].map(([key, rows]) => ({
        status: key,
        requests: rows.length,
        value: rows.reduce((total, entry) => total + asNumber(entry.refund_total_paisa), 0),
      })).sort((left, right) => right.requests - left.requests), { title: "Returns by status" }),
      table([
        { key: "reason", label: "Reason", type: "text" },
        { key: "requests", label: "Requests", type: "int", sum: true },
        { key: "value", label: "Value", type: "money", sum: true },
      ], [...returnReasonMap.entries()].map(([reason, rows]) => ({
        reason,
        requests: rows.length,
        value: rows.reduce((total, entry) => total + asNumber(entry.refund_total_paisa), 0),
      })).sort((left, right) => right.requests - left.requests), { title: "Returns by reason" }),
      table([
        { key: "product", label: "Product", type: "text" },
        { key: "quantity", label: "Quantity returned", type: "num", sum: true },
        { key: "value", label: "Value", type: "money", sum: true },
      ], [...returnedProducts.values()].sort((left, right) => right.value - left.value).slice(0, 50), {
        title: "Most returned products (completed returns)",
      }),
      table([
        { key: "type", label: "Refund type", type: "badge" },
        { key: "status", label: "Refund status", type: "badge" },
        { key: "refunds", label: "Refunds", type: "int", sum: true },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], [...refundMap.values()].sort((left, right) => right.amount - left.amount).map((bucket) => ({
        type: bucket.type,
        status: bucket.status,
        refunds: bucket.count,
        amount: bucket.amount,
      })), { title: "Refunds" }),
      table([
        { key: "return", label: "Return", type: "text" },
        { key: "date", label: "Date", type: "datetime" },
        { key: "customer", label: "Customer", type: "text" },
        { key: "branch", label: "Branch", type: "text" },
        { key: "reason", label: "Reason", type: "text" },
        { key: "status", label: "Status", type: "badge" },
        { key: "refundMethod", label: "Refund method", type: "badge" },
        { key: "value", label: "Value", type: "money", sum: true },
      ], returns.slice(0, 300).map((entry) => ({
        return: entry.return_number || entry.id,
        date: entry.created_at,
        customer: saleById.get(entry.sale_id)?.customer_name || "Walk-in Customer",
        branch: branchName(entry.branch_id),
        reason: entry.reason,
        status: entry.status,
        refundMethod: refundsByReturn.get(entry.id)?.[0]?.method || "—",
        value: asNumber(entry.refund_total_paisa),
        __nosum: statusOf(entry) === "rejected",
      })), { title: "Return register (rejected requests not counted in the total)" }),
    ],
  });

  /* ------------------------------------------------------------ stock value */
  const stockCategoryMap = new Map<string, { category: string; items: number; cost: number; retail: number }>();
  for (const row of stock.rows) {
    const bucket = stockCategoryMap.get(row.category) || { category: row.category, items: 0, cost: 0, retail: 0 };
    bucket.items += 1;
    bucket.cost += stockValuePaisa(row.quantityMilli, row.costPaisa);
    bucket.retail += stockValuePaisa(row.quantityMilli, row.pricePaisa);
    stockCategoryMap.set(row.category, bucket);
  }
  const stockValueSection: ReportSectionSpec = finalizeSection({
    id: "stock_value",
    title: "Stock valuation",
    group: "Stock",
    note: "As of today. Cost value uses the product cost price; retail value uses the selling price.",
    tables: [
      table([
        { key: "category", label: "Category", type: "text" },
        { key: "items", label: "Products", type: "int", sum: true },
        { key: "cost", label: "Value at cost", type: "money", sum: true },
        { key: "retail", label: "Value at selling price", type: "money", sum: true },
      ], [...stockCategoryMap.values()].sort((left, right) => right.cost - left.cost), { title: "Value by category" }),
      table([
        { key: "product", label: "Product", type: "text" },
        { key: "category", label: "Category", type: "text" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "quantity", label: "In stock", type: "num", sum: true },
        { key: "cost", label: "Cost price", type: "money" },
        { key: "price", label: "Selling price", type: "money" },
        { key: "value", label: "Value at cost", type: "money", sum: true },
        { key: "reorder", label: "Reorder at", type: "num" },
        { key: "status", label: "Status", type: "text" },
      ], stock.rows.slice().sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name)).map((row) => ({
        product: row.name,
        category: row.category,
        unit: row.unit,
        quantity: quantity(row.quantityMilli),
        cost: row.costPaisa,
        price: row.pricePaisa,
        value: stockValuePaisa(row.quantityMilli, row.costPaisa),
        reorder: quantity(row.reorderMilli),
        status: row.status,
      })), { title: "All products" }),
    ],
  });

  /* -------------------------------------------------------------- stock low */
  const lowRows = stock.rows
    .filter((row) => row.status !== "OK")
    .sort((left, right) => left.quantityMilli - right.quantityMilli);
  const stockLow: ReportSectionSpec = finalizeSection({
    id: "stock_low",
    title: "Low and out of stock",
    group: "Stock",
    note: "As of today. Products at or below their reorder point or minimum level.",
    tables: [
      table([
        { key: "product", label: "Product", type: "text" },
        { key: "category", label: "Category", type: "text" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "quantity", label: "In stock", type: "num" },
        { key: "minimum", label: "Minimum", type: "num" },
        { key: "reorder", label: "Reorder at", type: "num" },
        { key: "status", label: "Status", type: "text" },
      ], lowRows.map((row) => ({
        product: row.name,
        category: row.category,
        unit: row.unit,
        quantity: quantity(row.quantityMilli),
        minimum: quantity(row.minMilli),
        reorder: quantity(row.reorderMilli),
        status: row.status,
      })), { empty: "All stock levels are healthy." }),
    ],
  });

  /* ----------------------------------------------------------- branch stock */
  const branchStockSummary = stock.byBranch.map((branch) => {
    const value = branch.items.reduce((total, item) => total + stockValuePaisa(item.quantityMilli, item.costPaisa), 0);
    return {
      branch: branch.branchName,
      items: branch.items.length,
      quantity: branch.items.reduce((total, item) => total + quantity(item.quantityMilli), 0),
      value,
      zero: branch.items.filter((item) => item.quantityMilli <= 0).length,
    };
  }).sort((left, right) => right.value - left.value);
  const branchStockDetail: ReportRow[] = [];
  for (const branch of stock.byBranch) {
    for (const item of branch.items) {
      branchStockDetail.push({
        branch: branch.branchName,
        product: item.name,
        unit: item.unit,
        quantity: quantity(item.quantityMilli),
        cost: item.costPaisa,
        value: stockValuePaisa(item.quantityMilli, item.costPaisa),
        __nosum: false,
      });
    }
  }
  const branchStock: ReportSectionSpec = finalizeSection({
    id: "branch_stock",
    title: "Branch stock",
    group: "Stock",
    note: "As of today. Stock held at each branch. Quantities mix units, so compare value rather than quantity.",
    tables: [
      table([
        { key: "branch", label: "Branch", type: "text" },
        { key: "items", label: "Products listed", type: "int", sum: true },
        { key: "quantity", label: "Quantity", type: "num", sum: true },
        { key: "value", label: "Value at cost", type: "money", sum: true },
        { key: "zero", label: "Products at zero", type: "int", sum: true },
      ], branchStockSummary, { title: "Summary by branch" }),
      table([
        { key: "branch", label: "Branch", type: "text" },
        { key: "product", label: "Product", type: "text" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "quantity", label: "Quantity", type: "num", sum: true },
        { key: "cost", label: "Cost price", type: "money" },
        { key: "value", label: "Value", type: "money", sum: true },
      ], branchStockDetail.slice(0, 1000), { title: "Stock by branch and product (up to 1000 lines)" }),
    ],
  });

  /* ------------------------------------------------------------ adjustments */
  const adjustmentMap = groupBy(stockMovements, (movement) => String(movement.movement_type || "unknown"));
  const adjustments: ReportSectionSpec = finalizeSection({
    id: "adjustments",
    title: "Stock adjustments",
    group: "Stock",
    note: "Purchases, damage, expiry, theft and other stock changes in the period. Value is the quantity changed multiplied by the recorded cost.",
    tables: [
      table([
        { key: "type", label: "Movement type", type: "badge" },
        { key: "entries", label: "Entries", type: "int", sum: true },
        { key: "value", label: "Value", type: "money", sum: true },
      ], [...adjustmentMap.entries()].map(([type, rows]) => ({
        type,
        entries: rows.length,
        value: rows.reduce((total, row) => total + Math.abs(stockValuePaisa(row.quantity_delta_milli, row.unit_cost_paisa)), 0),
      })).sort((left, right) => right.entries - left.entries), { title: "Summary by type" }),
      table([
        { key: "when", label: "When", type: "datetime" },
        { key: "product", label: "Product", type: "text" },
        { key: "type", label: "Type", type: "badge" },
        { key: "change", label: "Change", type: "num" },
        { key: "cost", label: "Cost", type: "money" },
        { key: "branch", label: "Branch", type: "text" },
        { key: "reason", label: "Reason", type: "text" },
      ], stockMovements.slice(0, 400).map((movement) => ({
        when: movement.occurred_at,
        product: productName(movement.product_id),
        type: movement.movement_type,
        change: quantity(movement.quantity_delta_milli),
        cost: asNumber(movement.unit_cost_paisa),
        branch: branchName(movement.branch_id),
        reason: movement.notes || movement.reference_type || "",
      })), { title: "Latest 400 adjustments" }),
    ],
  });

  /* -------------------------------------------------------------- transfers */
  const transferById = new Map(transfers.map((transfer) => [transfer.id, transfer]));
  const transfersSection: ReportSectionSpec = finalizeSection({
    id: "transfers",
    title: "Stock transfers",
    group: "Stock",
    note: "Stock moved between branches in the period.",
    tables: [
      table([
        { key: "when", label: "When", type: "datetime" },
        { key: "product", label: "Product", type: "text" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "from", label: "From", type: "text" },
        { key: "to", label: "To", type: "text" },
        { key: "quantity", label: "Quantity", type: "num", sum: true },
        { key: "status", label: "Status", type: "badge" },
        { key: "reason", label: "Reason", type: "text" },
      ], transferItems.slice(0, 300).map((item) => {
        const transfer = transferById.get(item.transfer_id);
        return {
          when: transfer?.created_at || "",
          product: item.product_name || productName(item.product_id),
          unit: item.unit_code,
          from: branchName(transfer?.from_branch_id),
          to: branchName(transfer?.to_branch_id),
          quantity: quantity(item.quantity_milli),
          status: transfer?.status || "—",
          reason: transfer?.notes || "",
        };
      })),
    ],
  });

  /* ----------------------------------------------------------- ERP received */
  const receiptById = new Map(purchaseReceipts.map((receipt) => [receipt.id, receipt]));
  const erpReceived: ReportSectionSpec = finalizeSection({
    id: "erp_received",
    title: "ERP stock received",
    group: "Stock",
    note: "Stock received into branches from purchase receipts in the period.",
    tables: [
      table([
        { key: "received", label: "Received", type: "datetime" },
        { key: "invoice", label: "Supplier invoice", type: "text" },
        { key: "product", label: "Product", type: "text" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "branch", label: "Branch", type: "text" },
        { key: "quantity", label: "Quantity", type: "num", sum: true },
        { key: "who", label: "Received by", type: "text" },
      ], receiptItems.slice(0, 400).map((item) => {
        const receipt = receiptById.get(item.receipt_id);
        return {
          received: receipt?.received_at || "",
          invoice: receipt?.supplier_invoice_number || receipt?.id || "—",
          product: item.product_name || productName(item.product_id),
          unit: item.unit_code,
          branch: branchName(receipt?.branch_id),
          quantity: quantity(item.quantity_milli),
          who: staffById.get(receipt?.received_by)?.full_name || "—",
        };
      })),
    ],
  });

  const sections = [
    summary, daily, monthly, branches, paymentsSection, products, categories, orders, status, tax,
    posSales, cashiers, shiftsSection, posExpenses, voids, customers, posCredit, returnsSection,
    stockValueSection, stockLow, branchStock, adjustments, transfersSection, erpReceived,
  ];

  return {
    kind: "admin",
    from,
    to,
    branchId: options.branchId,
    branchName: options.branchName,
    generatedAt: new Date().toISOString(),
    sections,
  };
}
