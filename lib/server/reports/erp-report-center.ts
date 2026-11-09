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

export interface ErpReportOptions {
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

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
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
  for (const group of chunk([...new Set(ids.filter(Boolean))], ID_CHUNK)) {
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

function dayOf(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value.length <= 10 ? value.slice(0, 10) : pakistanDayKey(value);
}

function inDateRange(value: unknown, from: string, to: string): boolean {
  const day = dayOf(value);
  return Boolean(day) && day >= from && day <= to;
}

function paymentState(total: number, paid: number): string {
  if (paid <= 0) return "unpaid";
  if (paid >= total) return "paid";
  return "partial";
}

interface InvoiceRow {
  id: string;
  channel: "Bulk sales" | "Customer invoice";
  docno: string;
  date: string;
  customer: string;
  total: number;
  paid: number;
  branchId: string;
  status: string;
  paymentStatus: string;
  description: string;
}

export async function buildErpReportCenter(
  client: ReportClient,
  options: ErpReportOptions,
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
    stock,
    bulkSales,
    bulkPayments,
    customerInvoices,
    customerPayments,
    customerAccounts,
    purchaseOrders,
    purchaseReceipts,
    supplierPayments,
    suppliers,
    expenses,
    expenseCategories,
    stockMovements,
    spiceBatches,
    animalBatches,
    animalEvents,
    productionRuns,
    payrollRuns,
    hrEmployees,
    departments,
    staffProfiles,
    staffCompensation,
    staffAttendance,
    staffAdvances,
    advanceRecoveries,
  ] = await Promise.all([
    loadStockSnapshot(client, options.branches),
    fetchPaged<Row>(() => branchScope(client
      .from("bulk_sales")
      .select("id,branch_id,invoice_number,sale_date,customer_name,customer_phone,subtotal_paisa,discount_paisa,total_paisa,notes,created_at")
      .is("deleted_at", null)
      .order("sale_date", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("bulk_sale_payments")
      .select("id,sale_id,branch_id,method,amount_paisa,reference,paid_at")
      .is("deleted_at", null)
      .order("paid_at", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("customer_invoices")
      .select("id,account_id,branch_id,invoice_number,invoice_date,description,amount_paisa,created_at")
      .is("deleted_at", null)
      .order("invoice_date", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("customer_payments")
      .select("id,account_id,branch_id,invoice_id,method,amount_paisa,reference,paid_at")
      .is("deleted_at", null)
      .order("paid_at", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("customer_accounts")
      .select("id,branch_id,name,phone,credit_limit_paisa,is_active,created_at")
      .is("deleted_at", null))),
    fetchPaged<Row>(() => branchScope(client
      .from("purchase_orders")
      .select("id,branch_id,supplier_id,order_number,status,expected_at,notes,ordered_total_paisa,ordered_at")
      .is("deleted_at", null)
      .order("ordered_at", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("purchase_receipts")
      .select("id,branch_id,supplier_id,supplier_invoice_number,subtotal_paisa,notes,received_by,received_at,purchase_order_id")
      .is("deleted_at", null)
      .order("received_at", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("supplier_payments")
      .select("id,branch_id,receipt_id,method,amount_paisa,reference,paid_at")
      .is("deleted_at", null)
      .order("paid_at", { ascending: false }))),
    fetchPaged<Row>(() => client.from("suppliers").select("id,name,is_active").is("deleted_at", null)),
    fetchPaged<Row>(() => branchScope(client
      .from("expenses")
      .select("id,branch_id,category_id,description,amount_paisa,payment_method,reference,spent_at")
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
    fetchPaged<Row>(() => branchScope(client
      .from("spice_batches")
      .select("id,branch_id,batch_number,name,batch_date,output_product_name,output_unit_code,status,input_cost_paisa,output_quantity_milli,unit_cost_paisa,labor_cost_paisa,other_cost_paisa,notes")
      .is("deleted_at", null)
      .order("batch_date", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("animal_batches")
      .select("id,branch_id,name,species,batch_type,opening_heads,opening_date,opening_cost_paisa,status,notes,closed_at,created_at")
      .is("deleted_at", null)
      .order("opening_date", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("animal_batch_events")
      .select("id,batch_id,branch_id,event_date,event_type,heads_delta,quantity_milli,unit_cost_paisa,amount_paisa,notes")
      .is("deleted_at", null)
      .order("event_date", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("production_runs")
      .select("id,branch_id,run_number,run_date,output_product_name,output_unit_code,output_quantity_milli,input_cost_paisa,labor_cost_paisa,other_cost_paisa,total_cost_paisa,notes")
      .is("deleted_at", null)
      .gte("run_date", from)
      .lte("run_date", to)
      .order("run_date", { ascending: false }))),
    fetchPaged<Row>(() => branchScope(client
      .from("payroll_runs")
      .select("id,branch_id,period_start,period_end,status,working_days,staff_count,gross_paisa,attendance_deduction_paisa,advance_deduction_paisa,net_paisa,paid_at,voided_at")
      .is("deleted_at", null)
      .lte("period_start", to)
      .gte("period_end", from)
      .order("period_start", { ascending: false }))),
    fetchPaged<Row>(() => client
      .from("hr_employees")
      .select("id,branch_id,full_name,job_title,phone,department_id,is_active,created_at,staff_profile_id")
      .is("deleted_at", null)),
    fetchPaged<Row>(() => client.from("hr_departments").select("id,name").is("deleted_at", null)),
    fetchPaged<Row>(() => client.from("staff_profiles").select("id,full_name,role,branch_id,is_active").is("deleted_at", null)),
    fetchPaged<Row>(() => client
      .from("staff_compensation")
      .select("id,staff_id,branch_id,base_salary_paisa,allowances_paisa,effective_from")
      .is("deleted_at", null)
      .order("effective_from", { ascending: false })),
    fetchPaged<Row>(() => branchScope(client
      .from("staff_attendance")
      .select("id,staff_id,branch_id,attendance_date,status")
      .is("deleted_at", null)
      .gte("attendance_date", from)
      .lte("attendance_date", to))),
    fetchPaged<Row>(() => branchScope(client
      .from("staff_advances")
      .select("id,staff_id,branch_id,advance_date,amount_paisa,notes")
      .is("deleted_at", null)
      .order("advance_date", { ascending: false }))),
    fetchPaged<Row>(() => client
      .from("payroll_advance_recoveries")
      .select("id,run_id,advance_id,staff_id,amount_paisa")
      .is("deleted_at", null)),
  ]);

  const purchaseOrderIds = purchaseOrders.map((order) => order.id);
  const receiptIds = purchaseReceipts.map((receipt) => receipt.id);
  const runIds = payrollRuns.map((run) => run.id);
  const productionIds = productionRuns.map((run) => run.id);

  const [purchaseOrderItems, receiptItems, payrollItems, productionInputs] = await Promise.all([
    loadByIds<Row>(client, "purchase_order_items", "id,order_id,product_id,product_name,unit_code,ordered_quantity_milli,received_quantity_milli,unit_cost_paisa,line_total_paisa", "order_id", purchaseOrderIds),
    loadByIds<Row>(client, "purchase_receipt_items", "id,receipt_id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa", "receipt_id", receiptIds),
    loadByIds<Row>(client, "payroll_items", "id,run_id,staff_id,staff_name,role,base_salary_paisa,allowances_paisa,working_days,present_days,absent_days,half_days,leave_days,attendance_deduction_paisa,advance_deduction_paisa,gross_paisa,net_paisa,tax_withheld_paisa,department_name", "run_id", runIds),
    loadByIds<Row>(client, "production_inputs", "id,run_id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa", "run_id", productionIds),
  ]);

  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  const accountById = new Map(customerAccounts.map((account) => [account.id, account]));
  const departmentById = new Map(departments.map((department) => [department.id, department]));
  const staffById = new Map(staffProfiles.map((member) => [member.id, member]));
  const expenseCategoryById = new Map(expenseCategories.map((category) => [category.id, category.name]));
  const stockById = new Map(stock.rows.map((row) => [row.id, row]));
  const productName = (id: unknown, fallback?: unknown): string =>
    (typeof id === "string" ? stockById.get(id)?.name : "") || String(fallback || "—");

  const supplierName = (id: unknown): string =>
    supplierById.get(String(id))?.name || "Unknown supplier";
  const accountName = (id: unknown): string =>
    accountById.get(String(id))?.name || "Walk-in customer";

  const bulkPaidBySale = new Map<string, number>();
  for (const payment of bulkPayments) {
    bulkPaidBySale.set(payment.sale_id, (bulkPaidBySale.get(payment.sale_id) || 0) + asNumber(payment.amount_paisa));
  }
  const customerPaidByInvoice = new Map<string, number>();
  for (const payment of customerPayments) {
    if (!payment.invoice_id) continue;
    customerPaidByInvoice.set(payment.invoice_id, (customerPaidByInvoice.get(payment.invoice_id) || 0) + asNumber(payment.amount_paisa));
  }

  const allInvoices: InvoiceRow[] = [
    ...bulkSales.map((sale) => {
      const total = asNumber(sale.total_paisa);
      const paid = bulkPaidBySale.get(sale.id) || 0;
      return {
        id: sale.id,
        channel: "Bulk sales" as const,
        docno: String(sale.invoice_number || sale.id),
        date: String(sale.sale_date || ""),
        customer: String(sale.customer_name || "Walk-in customer"),
        total,
        paid,
        branchId: String(sale.branch_id || ""),
        status: "completed",
        paymentStatus: paymentState(total, paid),
        description: String(sale.notes || ""),
      };
    }),
    ...customerInvoices.map((invoice) => {
      const total = asNumber(invoice.amount_paisa);
      const paid = customerPaidByInvoice.get(invoice.id) || 0;
      return {
        id: invoice.id,
        channel: "Customer invoice" as const,
        docno: String(invoice.invoice_number || invoice.id),
        date: String(invoice.invoice_date || ""),
        customer: accountName(invoice.account_id),
        total,
        paid,
        branchId: String(invoice.branch_id || ""),
        status: "completed",
        paymentStatus: paymentState(total, paid),
        description: String(invoice.description || ""),
      };
    }),
  ].sort((left, right) => right.date.localeCompare(left.date));

  const periodInvoices = allInvoices.filter((invoice) => inDateRange(invoice.date, from, to));
  const unpaidInvoices = allInvoices.filter((invoice) => invoice.paymentStatus !== "paid" && invoice.total > invoice.paid);
  const receivablesTotal = unpaidInvoices.reduce((total, invoice) => total + (invoice.total - invoice.paid), 0);

  const poById = new Map(purchaseOrders.map((order) => [order.id, order]));
  const receiptById = new Map(purchaseReceipts.map((receipt) => [receipt.id, receipt]));
  const paidByPurchaseOrder = new Map<string, number>();
  for (const payment of supplierPayments) {
    const receipt = receiptById.get(payment.receipt_id);
    if (!receipt) continue;
    const orderId = receipt.purchase_order_id;
    if (!orderId) continue;
    paidByPurchaseOrder.set(orderId, (paidByPurchaseOrder.get(orderId) || 0) + asNumber(payment.amount_paisa));
  }
  const paidBySupplier = new Map<string, number>();
  for (const payment of supplierPayments) {
    const receipt = receiptById.get(payment.receipt_id);
    const supplierId = receipt?.supplier_id;
    if (!supplierId) continue;
    paidBySupplier.set(supplierId, (paidBySupplier.get(supplierId) || 0) + asNumber(payment.amount_paisa));
  }

  const activePurchaseOrders = purchaseOrders.filter((order) => statusOf(order) !== "cancelled");
  const orderedBySupplier = new Map<string, number>();
  for (const order of activePurchaseOrders) {
    orderedBySupplier.set(order.supplier_id, (orderedBySupplier.get(order.supplier_id) || 0) + asNumber(order.ordered_total_paisa));
  }
  const payablesTotal = [...orderedBySupplier.entries()].reduce((total, [supplierId, ordered]) =>
    total + Math.max(0, ordered - (paidBySupplier.get(supplierId) || 0)), 0);

  const periodPurchaseOrders = activePurchaseOrders.filter((order) => inDateRange(order.ordered_at, from, to));
  const purchasesTotal = periodPurchaseOrders.reduce((total, order) => total + asNumber(order.ordered_total_paisa), 0);
  const expensesTotal = expenses.reduce((total, expense) => total + asNumber(expense.amount_paisa), 0);

  const periodPayrollRuns = payrollRuns.filter((run) => statusOf(run) !== "voided");
  const payrollTotal = periodPayrollRuns.reduce((total, run) => total + asNumber(run.net_paisa), 0);
  const salesTotal = periodInvoices.reduce((total, invoice) => total + invoice.total, 0);
  const collectedTotal = periodInvoices.reduce((total, invoice) => total + invoice.paid, 0);
  const netResult = salesTotal - purchasesTotal - expensesTotal - payrollTotal;

  const stockValue = stock.rows.reduce(
    (total, row) => total + stockValuePaisa(row.quantityMilli, row.costPaisa),
    0,
  );
  const lowStock = stock.rows.filter((row) => row.status === "Low").length;
  const outStock = stock.rows.filter((row) => row.status === "Out of stock").length;

  const activeBatches = animalBatches.filter((batch) => statusOf(batch) === "active" || statusOf(batch) === "open");
  const eventsByBatch = groupBy(animalEvents, (event) => event.batch_id);
  const livestockValue = activeBatches.reduce((total, batch) => {
    const events = eventsByBatch.get(batch.id) || [];
    const purchases = events
      .filter((event) => event.event_type === "purchase")
      .reduce((sum, event) => sum + asNumber(event.amount_paisa), 0);
    return total + asNumber(batch.opening_cost_paisa) + purchases;
  }, 0);

  const spiceValue = spiceBatches.reduce((total, batch) => {
    if (statusOf(batch) === "voided") return total;
    return total + Math.round((asNumber(batch.output_quantity_milli) * asNumber(batch.unit_cost_paisa)) / 1000);
  }, 0);

  const bulkStockRows = stock.rows.filter((row) => /bulk/i.test(row.category));
  const bulkValue = bulkStockRows.reduce(
    (total, row) => total + stockValuePaisa(row.quantityMilli, row.costPaisa),
    0,
  );

  /* ---------------------------------------------------------------- summary */
  const channelRows = (["Bulk sales", "Customer invoice"] as const).map((channel) => {
    const invoices = periodInvoices.filter((invoice) => invoice.channel === channel);
    const total = invoices.reduce((sum, invoice) => sum + invoice.total, 0);
    const collected = invoices.reduce((sum, invoice) => sum + invoice.paid, 0);
    return {
      channel,
      invoices: invoices.length,
      total,
      collected,
      outstanding: total - collected,
    };
  });

  const summary: ReportSectionSpec = finalizeSection({
    id: "summary",
    title: "Executive summary",
    group: "Finance",
    note: "Sales, purchases, expenses and payroll for the period, plus where the business stands today. Sales combine bulk sales and customer invoices.",
    tables: [
      table([
        { key: "channel", label: "Sales channel", type: "text" },
        { key: "invoices", label: "Invoices", type: "int", sum: true },
        { key: "total", label: "Sales", type: "money", sum: true },
        { key: "collected", label: "Collected", type: "money", sum: true },
        { key: "outstanding", label: "Outstanding", type: "money", sum: true },
      ], channelRows, { title: "Sales by channel" }),
      table([
        { key: "item", label: "Item", type: "text" },
        { key: "amount", label: "Amount", type: "money" },
      ], [
        { item: "Total sales", amount: salesTotal },
        { item: "Less: purchases (purchase orders)", amount: purchasesTotal },
        { item: "Less: expenses", amount: expensesTotal },
        { item: "Less: payroll (runs in this period)", amount: payrollTotal },
        { item: "Estimated net result", amount: netResult, __nosum: true },
      ], { title: "Period result" }),
      table([
        { key: "item", label: "Item", type: "text" },
        { key: "value", label: "Value", type: "money" },
      ], [
        { item: "Receivables (unpaid invoices)", value: receivablesTotal },
        { item: "Payables (supplier balances)", value: payablesTotal },
        { item: "Product stock value", value: stockValue },
        { item: "Livestock value (active batches)", value: livestockValue },
        { item: "Spice stock value", value: spiceValue },
        { item: "Bulk product stock value", value: bulkValue },
      ], { title: "Position as of today" }),
    ],
  });

  /* ---------------------------------------------------------------- monthly */
  const monthMap = new Map<string, { month: string; sales: number; purchases: number; expenses: number; payroll: number }>();
  const monthBucket = (key: string) => {
    const bucket = monthMap.get(key) || { month: key, sales: 0, purchases: 0, expenses: 0, payroll: 0 };
    monthMap.set(key, bucket);
    return bucket;
  };
  for (const invoice of periodInvoices) monthBucket(monthKey(invoice.date)).sales += invoice.total;
  for (const order of periodPurchaseOrders) monthBucket(monthKey(order.ordered_at)).purchases += asNumber(order.ordered_total_paisa);
  for (const expense of expenses) monthBucket(monthKey(expense.spent_at)).expenses += asNumber(expense.amount_paisa);
  for (const run of periodPayrollRuns) monthBucket(monthKey(run.period_start)).payroll += asNumber(run.net_paisa);

  const monthly: ReportSectionSpec = finalizeSection({
    id: "monthly",
    title: "Month-by-month results",
    group: "Finance",
    note: "The estimated net result is sales minus purchases, expenses and payroll. It is a cash-style view, not an audited profit figure.",
    tables: [
      table([
        { key: "month", label: "Month", type: "text" },
        { key: "sales", label: "Sales", type: "money", sum: true },
        { key: "purchases", label: "Purchases", type: "money", sum: true },
        { key: "expenses", label: "Expenses", type: "money", sum: true },
        { key: "payroll", label: "Payroll", type: "money", sum: true },
        { key: "net", label: "Net result", type: "money", sum: true },
      ], [...monthMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, bucket]) => ({
        month: monthLabel(key),
        sales: bucket.sales,
        purchases: bucket.purchases,
        expenses: bucket.expenses,
        payroll: bucket.payroll,
        net: bucket.sales - bucket.purchases - bucket.expenses - bucket.payroll,
      }))),
    ],
  });

  /* --------------------------------------------------------------- expenses */
  const expenseByCategory = groupBy(expenses, (expense) => String(expense.category_id || ""));
  const expenseByMethod = groupBy(expenses, (expense) => String(expense.payment_method || "unknown"));
  const expensesSection: ReportSectionSpec = finalizeSection({
    id: "expenses",
    title: "Expenses",
    group: "Finance",
    note: "Expenses recorded in the period, by category and payment method.",
    tables: [
      table([
        { key: "category", label: "Category", type: "text" },
        { key: "entries", label: "Entries", type: "int", sum: true },
        { key: "amount", label: "Amount", type: "money", sum: true },
        { key: "share", label: "Share", type: "pct" },
      ], [...expenseByCategory.entries()].map(([id, rows]) => {
        const amount = rows.reduce((total, expense) => total + asNumber(expense.amount_paisa), 0);
        return {
          category: expenseCategoryById.get(id) || "Uncategorised",
          entries: rows.length,
          amount,
          share: pct(amount, expensesTotal),
        };
      }).sort((left, right) => right.amount - left.amount), { title: "Expenses by category" }),
      table([
        { key: "method", label: "Payment method", type: "badge" },
        { key: "entries", label: "Entries", type: "int", sum: true },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], [...expenseByMethod.entries()].map(([method, rows]) => ({
        method,
        entries: rows.length,
        amount: rows.reduce((total, expense) => total + asNumber(expense.amount_paisa), 0),
      })).sort((left, right) => right.amount - left.amount), { title: "Expenses by payment method" }),
      table([
        { key: "date", label: "Date", type: "date" },
        { key: "category", label: "Category", type: "text" },
        { key: "reference", label: "Reference", type: "text" },
        { key: "description", label: "Description", type: "text" },
        { key: "method", label: "Method", type: "badge" },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], expenses.slice(0, 500).map((expense) => ({
        date: expense.spent_at,
        category: expenseCategoryById.get(expense.category_id) || "Uncategorised",
        reference: expense.reference || "—",
        description: expense.description || "",
        method: expense.payment_method,
        amount: asNumber(expense.amount_paisa),
      })), { title: "Expense details (latest 500)" }),
    ],
  });

  /* ------------------------------------------------------- sales by customer */
  const byCustomer = groupBy(periodInvoices, (invoice) => invoice.customer);
  const salesStore: ReportSectionSpec = finalizeSection({
    id: "sales_store",
    title: "Sales by customer / store",
    group: "Sales",
    note: "Bulk sales and customer invoices combined. Each customer is shown with invoices, sales, collections and outstanding balance.",
    tables: [
      table([
        { key: "customer", label: "Customer / store", type: "text" },
        { key: "type", label: "Channel", type: "badge" },
        { key: "invoices", label: "Invoices", type: "int", sum: true },
        { key: "total", label: "Sales", type: "money", sum: true },
        { key: "collected", label: "Collected", type: "money", sum: true },
        { key: "due", label: "Outstanding", type: "money", sum: true },
      ], [...byCustomer.entries()].map(([customer, invoices]) => ({
        customer,
        type: [...new Set(invoices.map((invoice) => invoice.channel))].join(" / "),
        invoices: invoices.length,
        total: invoices.reduce((total, invoice) => total + invoice.total, 0),
        collected: invoices.reduce((total, invoice) => total + invoice.paid, 0),
        due: invoices.reduce((total, invoice) => total + invoice.total - invoice.paid, 0),
      })).sort((left, right) => right.total - left.total)),
    ],
  });

  /* -------------------------------------------------------- sales by product */
  const bulkSaleIdsInPeriod = new Set(
    periodInvoices.filter((invoice) => invoice.channel === "Bulk sales").map((invoice) => invoice.id),
  );
  const bulkItems = await loadByIds<Row>(
    client,
    "bulk_sale_items",
    "id,sale_id,product_id,product_name,unit_code,quantity_milli,unit_price_paisa,line_total_paisa",
    "sale_id",
    [...bulkSaleIdsInPeriod],
  );
  const productMap = new Map<string, { name: string; unit: string; quantity: number; amount: number }>();
  for (const item of bulkItems) {
    const key = `${item.product_name}|${item.unit_code}`;
    const bucket = productMap.get(key) || {
      name: String(item.product_name || productName(item.product_id)),
      unit: String(item.unit_code || ""),
      quantity: 0,
      amount: 0,
    };
    bucket.quantity += quantity(item.quantity_milli);
    bucket.amount += asNumber(item.line_total_paisa);
    productMap.set(key, bucket);
  }
  const salesProduct: ReportSectionSpec = finalizeSection({
    id: "sales_product",
    title: "Sales by product",
    group: "Sales",
    note: "Quantities and amounts from bulk sale lines. Items sold in different units are listed separately.",
    tables: [
      table([
        { key: "product", label: "Product", type: "text" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "quantity", label: "Quantity sold", type: "num", sum: true },
        { key: "average", label: "Average price", type: "money" },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], [...productMap.values()].sort((left, right) => right.amount - left.amount).slice(0, 150).map((row) => ({
        product: row.name,
        unit: row.unit,
        quantity: row.quantity,
        average: row.quantity ? row.amount / row.quantity : 0,
        amount: row.amount,
      }))),
    ],
  });

  /* ----------------------------------------------------------- daily sales */
  const dailyMap = new Map<string, { day: string; invoices: number; bulk: number; customer: number }>();
  for (const invoice of periodInvoices) {
    const bucket = dailyMap.get(invoice.date) || { day: invoice.date, invoices: 0, bulk: 0, customer: 0 };
    bucket.invoices += 1;
    if (invoice.channel === "Bulk sales") bucket.bulk += invoice.total;
    else bucket.customer += invoice.total;
    dailyMap.set(invoice.date, bucket);
  }
  const salesDaily: ReportSectionSpec = finalizeSection({
    id: "sales_daily",
    title: "Daily sales",
    group: "Sales",
    note: "Invoices by day from bulk sales and customer invoices.",
    tables: [
      table([
        { key: "day", label: "Date", type: "date" },
        { key: "invoices", label: "Invoices", type: "int", sum: true },
        { key: "bulk", label: "Bulk sales", type: "money", sum: true },
        { key: "customer", label: "Customer invoices", type: "money", sum: true },
        { key: "total", label: "Total", type: "money", sum: true },
      ], [...dailyMap.values()].sort((left, right) => left.day.localeCompare(right.day)).map((bucket) => ({
        day: bucket.day,
        invoices: bucket.invoices,
        bulk: bucket.bulk,
        customer: bucket.customer,
        total: bucket.bulk + bucket.customer,
      }))),
    ],
  });

  /* ------------------------------------------------------- invoice register */
  const invoicesSection: ReportSectionSpec = finalizeSection({
    id: "invoices",
    title: "Invoice register",
    group: "Sales",
    note: "Latest invoices in the period from bulk sales and customer invoices.",
    tables: [
      table([
        { key: "channel", label: "Type", type: "text" },
        { key: "docno", label: "Invoice", type: "text" },
        { key: "date", label: "Date", type: "date" },
        { key: "customer", label: "Customer", type: "text" },
        { key: "total", label: "Total", type: "money", sum: true },
        { key: "paid", label: "Paid", type: "money", sum: true },
        { key: "due", label: "Balance", type: "money", sum: true },
        { key: "paymentStatus", label: "Payment", type: "badge" },
        { key: "status", label: "Status", type: "badge" },
      ], periodInvoices.slice(0, 600).map((invoice) => ({
        channel: invoice.channel,
        docno: invoice.docno,
        date: invoice.date,
        customer: invoice.customer,
        total: invoice.total,
        paid: invoice.paid,
        due: invoice.total - invoice.paid,
        paymentStatus: invoice.paymentStatus,
        status: invoice.status,
      }))),
    ],
  });

  /* ---------------------------------------------------------- receivables */
  const ageBuckets = new Map<string, { bucket: string; invoices: number; amount: number }>([
    ["0 to 7 days", { bucket: "0 to 7 days", invoices: 0, amount: 0 }],
    ["8 to 30 days", { bucket: "8 to 30 days", invoices: 0, amount: 0 }],
    ["31 to 60 days", { bucket: "31 to 60 days", invoices: 0, amount: 0 }],
    ["Over 60 days", { bucket: "Over 60 days", invoices: 0, amount: 0 }],
  ]);
  const today = new Date();
  for (const invoice of unpaidInvoices) {
    const issued = new Date(`${invoice.date}T00:00:00Z`);
    const age = Number.isFinite(issued.getTime())
      ? Math.floor((today.getTime() - issued.getTime()) / 86_400_000)
      : 0;
    const key = age <= 7 ? "0 to 7 days" : age <= 30 ? "8 to 30 days" : age <= 60 ? "31 to 60 days" : "Over 60 days";
    const bucket = ageBuckets.get(key)!;
    bucket.invoices += 1;
    bucket.amount += invoice.total - invoice.paid;
  }

  const accountBalance = new Map<string, number>();
  for (const invoice of customerInvoices) {
    accountBalance.set(invoice.account_id, (accountBalance.get(invoice.account_id) || 0) + asNumber(invoice.amount_paisa));
  }
  for (const payment of customerPayments) {
    accountBalance.set(payment.account_id, (accountBalance.get(payment.account_id) || 0) - asNumber(payment.amount_paisa));
  }
  const balanceRows = [...accountBalance.entries()]
    .filter(([id, balance]) => balance !== 0 && accountById.get(id)?.is_active)
    .map(([id, balance]) => {
      const account = accountById.get(id);
      const limit = asNumber(account?.credit_limit_paisa);
      return {
        code: id.slice(0, 8),
        customer: account?.name || "Unknown",
        type: "Customer",
        phone: account?.phone || "—",
        limit,
        balance,
        flag: limit > 0 && balance > limit ? "Over limit" : "OK",
      };
    })
    .sort((left, right) => right.balance - left.balance);

  const receivables: ReportSectionSpec = finalizeSection({
    id: "receivables",
    title: "Receivables and ageing",
    group: "Sales",
    note: "As of today. Unpaid bulk sales and customer invoices, plus each customer account balance.",
    tables: [
      table([
        { key: "bucket", label: "Age of invoice", type: "text" },
        { key: "invoices", label: "Invoices", type: "int", sum: true },
        { key: "amount", label: "Unpaid amount", type: "money", sum: true },
      ], [...ageBuckets.values()], { title: "Receivables ageing" }),
      table([
        { key: "code", label: "Code", type: "text" },
        { key: "customer", label: "Customer / store", type: "text" },
        { key: "type", label: "Type", type: "badge" },
        { key: "phone", label: "Phone", type: "text" },
        { key: "limit", label: "Credit limit", type: "money" },
        { key: "balance", label: "Balance", type: "money", sum: true },
        { key: "flag", label: "Limit check", type: "text" },
      ], balanceRows, { title: "Customer account balances" }),
      table([
        { key: "channel", label: "Type", type: "text" },
        { key: "docno", label: "Invoice", type: "text" },
        { key: "customer", label: "Customer", type: "text" },
        { key: "date", label: "Date", type: "date" },
        { key: "age", label: "Age", type: "text" },
        { key: "total", label: "Total", type: "money", sum: true },
        { key: "paid", label: "Paid", type: "money", sum: true },
        { key: "due", label: "Unpaid", type: "money", sum: true },
      ], unpaidInvoices.slice(0, 300).map((invoice) => {
        const issued = new Date(`${invoice.date}T00:00:00Z`);
        const age = Number.isFinite(issued.getTime())
          ? Math.floor((today.getTime() - issued.getTime()) / 86_400_000)
          : 0;
        return {
          channel: invoice.channel,
          docno: invoice.docno,
          customer: invoice.customer,
          date: invoice.date,
          age: `${age} d`,
          total: invoice.total,
          paid: invoice.paid,
          due: invoice.total - invoice.paid,
        };
      }), { title: "Unpaid invoices (oldest first)" }),
    ],
  });

  /* --------------------------------------------------- purchases by vendor */
  const ordersBySupplier = groupBy(periodPurchaseOrders, (order) => order.supplier_id);
  const purchasesVendor: ReportSectionSpec = finalizeSection({
    id: "purchases_vendor",
    title: "Purchases by vendor",
    group: "Purchasing",
    note: "Cancelled purchase orders are left out.",
    tables: [
      table([
        { key: "code", label: "Code", type: "text" },
        { key: "vendor", label: "Vendor", type: "text" },
        { key: "orders", label: "Orders", type: "int", sum: true },
        { key: "total", label: "Purchased", type: "money", sum: true },
        { key: "paid", label: "Paid", type: "money", sum: true },
        { key: "due", label: "Unpaid", type: "money", sum: true },
      ], [...ordersBySupplier.entries()].map(([supplierId, orders]) => {
        const total = orders.reduce((sum, order) => sum + asNumber(order.ordered_total_paisa), 0);
        const paid = orders.reduce((sum, order) => sum + (paidByPurchaseOrder.get(order.id) || 0), 0);
        return {
          code: supplierId.slice(0, 8),
          vendor: supplierName(supplierId),
          orders: orders.length,
          total,
          paid,
          due: total - paid,
        };
      }).sort((left, right) => right.total - left.total)),
    ],
  });

  /* --------------------------------------------------------- PO register */
  const poRegister: ReportSectionSpec = finalizeSection({
    id: "po_register",
    title: "Purchase order register",
    group: "Purchasing",
    note: "Cancelled orders are shown but not counted in the totals.",
    tables: [
      table([
        { key: "docno", label: "PO number", type: "text" },
        { key: "date", label: "Date", type: "date" },
        { key: "vendor", label: "Vendor", type: "text" },
        { key: "status", label: "Status", type: "badge" },
        { key: "expected", label: "Expected", type: "date" },
        { key: "total", label: "Total", type: "money", sum: true },
        { key: "paid", label: "Paid", type: "money", sum: true },
        { key: "due", label: "Unpaid", type: "money", sum: true },
      ], purchaseOrders
        .filter((order) => inDateRange(order.ordered_at, from, to))
        .slice(0, 500)
        .map((order) => {
          const total = asNumber(order.ordered_total_paisa);
          const paid = paidByPurchaseOrder.get(order.id) || 0;
          return {
            docno: order.order_number,
            date: order.ordered_at,
            vendor: supplierName(order.supplier_id),
            status: order.status,
            expected: order.expected_at || "",
            total,
            paid,
            due: total - paid,
            __nosum: statusOf(order) === "cancelled",
          };
        })),
    ],
  });

  /* ------------------------------------------------------------- payables */
  const supplierBalanceRows = [...orderedBySupplier.entries()]
    .map(([supplierId, ordered]) => {
      const paid = paidBySupplier.get(supplierId) || 0;
      return {
        code: supplierId.slice(0, 8),
        vendor: supplierName(supplierId),
        type: "Supplier",
        terms: "—",
        limit: 0,
        balance: Math.max(0, ordered - paid),
      };
    })
    .filter((row) => row.balance !== 0)
    .sort((left, right) => right.balance - left.balance);

  const periodSupplierPayments = supplierPayments.filter((payment) => inDateRange(payment.paid_at, from, to));
  const payables: ReportSectionSpec = finalizeSection({
    id: "payables",
    title: "Payables and vendor payments",
    group: "Purchasing",
    note: "Supplier balances are as of today. Payments are for the selected period.",
    tables: [
      table([
        { key: "code", label: "Code", type: "text" },
        { key: "vendor", label: "Vendor", type: "text" },
        { key: "type", label: "Type", type: "badge" },
        { key: "terms", label: "Terms", type: "text" },
        { key: "limit", label: "Credit limit", type: "money" },
        { key: "balance", label: "We owe", type: "money", sum: true },
      ], supplierBalanceRows, { title: "Supplier balances (as of today)" }),
      table([
        { key: "date", label: "Date", type: "date" },
        { key: "vendor", label: "Vendor", type: "text" },
        { key: "po", label: "PO", type: "text" },
        { key: "method", label: "Method", type: "badge" },
        { key: "reference", label: "Reference", type: "text" },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], periodSupplierPayments.slice(0, 500).map((payment) => {
        const receipt = receiptById.get(payment.receipt_id);
        const order = receipt?.purchase_order_id ? poById.get(receipt.purchase_order_id) : undefined;
        return {
          date: payment.paid_at,
          vendor: supplierName(receipt?.supplier_id),
          po: order?.order_number || "—",
          method: payment.method,
          reference: payment.reference || "—",
          amount: asNumber(payment.amount_paisa),
        };
      }), { title: "Payments made to vendors" }),
    ],
  });

  /* ------------------------------------------------------------------ GRN */
  const periodReceipts = purchaseReceipts.filter((receipt) => inDateRange(receipt.received_at, from, to));
  const grn: ReportSectionSpec = finalizeSection({
    id: "grn",
    title: "Goods receipts",
    group: "Purchasing",
    note: "Stock received from suppliers in the period.",
    tables: [
      table([
        { key: "docno", label: "Receipt", type: "text" },
        { key: "date", label: "Date", type: "date" },
        { key: "vendor", label: "Vendor", type: "text" },
        { key: "po", label: "PO", type: "text" },
        { key: "vinv", label: "Vendor invoice", type: "text" },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], periodReceipts.slice(0, 500).map((receipt) => ({
        docno: receipt.id.slice(0, 8),
        date: receipt.received_at,
        vendor: supplierName(receipt.supplier_id),
        po: receipt.purchase_order_id ? poById.get(receipt.purchase_order_id)?.order_number || "—" : "—",
        vinv: receipt.supplier_invoice_number || "—",
        amount: asNumber(receipt.subtotal_paisa),
      }))),
    ],
  });

  /* ------------------------------------------------------ stock valuation */
  const stockCategoryMap = new Map<string, { category: string; items: number; cost: number; retail: number }>();
  for (const row of stock.rows) {
    const bucket = stockCategoryMap.get(row.category) || { category: row.category, items: 0, cost: 0, retail: 0 };
    bucket.items += 1;
    bucket.cost += stockValuePaisa(row.quantityMilli, row.costPaisa);
    bucket.retail += stockValuePaisa(row.quantityMilli, row.pricePaisa);
    stockCategoryMap.set(row.category, bucket);
  }
  const stockValuation: ReportSectionSpec = finalizeSection({
    id: "stock_valuation",
    title: "Stock valuation",
    group: "Inventory",
    note: "As of today. Value uses each product's cost price.",
    tables: [
      table([
        { key: "category", label: "Category", type: "text" },
        { key: "items", label: "Products", type: "int", sum: true },
        { key: "cost", label: "Stock value", type: "money", sum: true },
        { key: "retail", label: "Retail value", type: "money", sum: true },
      ], [...stockCategoryMap.values()].sort((left, right) => right.cost - left.cost), { title: "Value by category" }),
      table([
        { key: "code", label: "Code", type: "text" },
        { key: "product", label: "Product", type: "text" },
        { key: "category", label: "Category", type: "text" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "quantity", label: "In stock", type: "num", sum: true },
        { key: "cost", label: "Avg cost", type: "money" },
        { key: "value", label: "Value", type: "money", sum: true },
        { key: "reorder", label: "Reorder at", type: "num" },
        { key: "status", label: "Status", type: "text" },
      ], stock.rows.slice().sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name)).map((row) => ({
        code: row.sku || row.id.slice(0, 8),
        product: row.name,
        category: row.category,
        unit: row.unit,
        quantity: quantity(row.quantityMilli),
        cost: row.costPaisa,
        value: stockValuePaisa(row.quantityMilli, row.costPaisa),
        reorder: quantity(row.reorderMilli),
        status: row.status,
      })), { title: "All products" }),
    ],
  });

  /* --------------------------------------------------------- stock alerts */
  const alertRows = stock.rows
    .filter((row) => row.status !== "OK")
    .sort((left, right) => (left.quantityMilli - left.reorderMilli) - (right.quantityMilli - right.reorderMilli));
  const stockAlerts: ReportSectionSpec = finalizeSection({
    id: "stock_alerts",
    title: "Low and out of stock",
    group: "Inventory",
    note: "As of today. Products at or below their reorder point or minimum level.",
    tables: [
      table([
        { key: "code", label: "Code", type: "text" },
        { key: "product", label: "Product", type: "text" },
        { key: "category", label: "Category", type: "text" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "quantity", label: "In stock", type: "num" },
        { key: "minimum", label: "Minimum", type: "num" },
        { key: "reorder", label: "Reorder at", type: "num" },
        { key: "status", label: "Status", type: "text" },
      ], alertRows.map((row) => ({
        code: row.sku || row.id.slice(0, 8),
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

  /* ------------------------------------------------------- stock movement */
  const movementMap = groupBy(stockMovements, (movement) => String(movement.movement_type || "unknown"));
  const stockMovement: ReportSectionSpec = finalizeSection({
    id: "stock_movement",
    title: "Stock movements",
    group: "Inventory",
    note: "Quantities are not totalled because products use different units. Values are shown without sign.",
    tables: [
      table([
        { key: "type", label: "Movement type", type: "badge" },
        { key: "entries", label: "Entries", type: "int", sum: true },
        { key: "value", label: "Value", type: "money", sum: true },
      ], [...movementMap.entries()].map(([type, rows]) => ({
        type,
        entries: rows.length,
        value: rows.reduce((total, row) => total + Math.abs(stockValuePaisa(row.quantity_delta_milli, row.unit_cost_paisa)), 0),
      })).sort((left, right) => right.entries - left.entries), { title: "Summary by type" }),
      table([
        { key: "date", label: "Date", type: "date" },
        { key: "type", label: "Type", type: "badge" },
        { key: "product", label: "Product", type: "text" },
        { key: "quantity", label: "Quantity", type: "num" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "unitCost", label: "Unit cost", type: "money" },
        { key: "totalCost", label: "Total cost", type: "money" },
        { key: "reference", label: "Reference", type: "text" },
      ], stockMovements.slice(0, 300).map((movement) => {
        const product = stockById.get(movement.product_id);
        return {
          date: movement.occurred_at,
          type: movement.movement_type,
          product: productName(movement.product_id),
          quantity: quantity(movement.quantity_delta_milli),
          unit: product?.unit || "",
          unitCost: asNumber(movement.unit_cost_paisa),
          totalCost: Math.abs(stockValuePaisa(movement.quantity_delta_milli, movement.unit_cost_paisa)),
          reference: movement.reference_type || movement.notes || "—",
        };
      }), { title: "Latest 300 movements" }),
    ],
  });

  /* ---------------------------------------------------------- spice & bulk */
  const periodSpice = spiceBatches.filter((batch) => inDateRange(batch.batch_date, from, to));
  const spiceBulk: ReportSectionSpec = finalizeSection({
    id: "spice_bulk",
    title: "Spice and bulk stock",
    group: "Inventory",
    note: "Spice batches recorded in the period, plus products in bulk categories. Expiry tracking is not stored in the cloud schema.",
    tables: [
      table([
        { key: "batch", label: "Batch", type: "text" },
        { key: "name", label: "Spice", type: "text" },
        { key: "quantity", label: "Output (kg)", type: "num", sum: true },
        { key: "unitCost", label: "Unit cost", type: "money" },
        { key: "value", label: "Value", type: "money", sum: true },
        { key: "date", label: "Batch date", type: "date" },
        { key: "status", label: "Status", type: "badge" },
      ], periodSpice.slice(0, 300).map((batch) => ({
        batch: batch.batch_number,
        name: batch.output_product_name || batch.name,
        quantity: quantity(batch.output_quantity_milli),
        unitCost: asNumber(batch.unit_cost_paisa),
        value: Math.round((asNumber(batch.output_quantity_milli) * asNumber(batch.unit_cost_paisa)) / 1000),
        date: batch.batch_date,
        status: batch.status,
      })), { title: "Spice batches" }),
      table([
        { key: "product", label: "Item", type: "text" },
        { key: "category", label: "Category", type: "text" },
        { key: "unit", label: "Unit", type: "text" },
        { key: "quantity", label: "Quantity", type: "num", sum: true },
        { key: "unitCost", label: "Unit cost", type: "money" },
        { key: "value", label: "Value", type: "money", sum: true },
        { key: "status", label: "Status", type: "text" },
      ], bulkStockRows.map((row) => ({
        product: row.name,
        category: row.category,
        unit: row.unit,
        quantity: quantity(row.quantityMilli),
        unitCost: row.costPaisa,
        value: stockValuePaisa(row.quantityMilli, row.costPaisa),
        status: row.status,
      })), { title: "Bulk products (milk, eggs, yogurt and similar)" }),
    ],
  });

  /* ------------------------------------------------------------ livestock */
  const periodEvents = animalEvents.filter((event) => inDateRange(event.event_date, from, to));
  const batchRows = animalBatches
    .filter((batch) => statusOf(batch) === "active" || statusOf(batch) === "open" || inDateRange(batch.opening_date, from, to))
    .slice(0, 300)
    .map((batch) => {
      const events = eventsByBatch.get(batch.id) || [];
      const mortality = Math.abs(events.filter((event) => event.event_type === "mortality").reduce((sum, event) => sum + asNumber(event.heads_delta), 0));
      const sold = Math.abs(events.filter((event) => event.event_type === "sale").reduce((sum, event) => sum + asNumber(event.heads_delta), 0));
      const current = asNumber(batch.opening_heads) + events.reduce((sum, event) => sum + asNumber(event.heads_delta), 0);
      const totalCost = asNumber(batch.opening_cost_paisa) + events
        .filter((event) => event.event_type === "purchase")
        .reduce((sum, event) => sum + asNumber(event.amount_paisa), 0);
      return {
        batch: batch.name,
        type: batch.batch_type || batch.species,
        bought: batch.opening_date,
        initial: asNumber(batch.opening_heads),
        mortality,
        sold,
        current,
        unitCost: asNumber(batch.opening_heads) ? totalCost / asNumber(batch.opening_heads) : 0,
        totalCost,
        status: batch.status,
        location: branchName(batch.branch_id),
      };
    });

  const mortalityEvents = periodEvents.filter((event) => event.event_type === "mortality");
  const mortalityByType = groupBy(mortalityEvents, (event) => {
    const batch = animalBatches.find((candidate) => candidate.id === event.batch_id);
    return String(batch?.batch_type || batch?.species || "unknown");
  });
  const mortalityRows = mortalityEvents.slice(0, 300).map((event) => {
    const batch = animalBatches.find((candidate) => candidate.id === event.batch_id);
    return {
      date: event.event_date,
      batch: batch?.name || event.batch_id,
      type: batch?.batch_type || batch?.species || "unknown",
      lost: Math.abs(asNumber(event.heads_delta)),
      cause: event.notes || "—",
      loss: asNumber(event.amount_paisa),
    };
  });

  const livestock: ReportSectionSpec = finalizeSection({
    id: "livestock",
    title: "Livestock and mortality",
    group: "Farm and production",
    note: "Active batches or batches bought in the period, then mortality records for the period.",
    tables: [
      table([
        { key: "batch", label: "Batch", type: "text" },
        { key: "type", label: "Type", type: "badge" },
        { key: "bought", label: "Bought", type: "date" },
        { key: "initial", label: "Started with", type: "int", sum: true },
        { key: "mortality", label: "Mortality", type: "int", sum: true },
        { key: "sold", label: "Sold", type: "int", sum: true },
        { key: "current", label: "Now alive", type: "int", sum: true },
        { key: "unitCost", label: "Unit cost", type: "money" },
        { key: "totalCost", label: "Total cost", type: "money", sum: true },
        { key: "status", label: "Status", type: "badge" },
        { key: "location", label: "Location", type: "text" },
      ], batchRows, { title: "Animal batches" }),
      table([
        { key: "type", label: "Animal type", type: "badge" },
        { key: "lost", label: "Lost", type: "int", sum: true },
        { key: "loss", label: "Estimated loss", type: "money", sum: true },
      ], [...mortalityByType.entries()].map(([type, rows]) => ({
        type,
        lost: rows.reduce((total, event) => total + Math.abs(asNumber(event.heads_delta)), 0),
        loss: rows.reduce((total, event) => total + asNumber(event.amount_paisa), 0),
      })).sort((left, right) => right.lost - left.lost), { title: "Mortality by animal type" }),
      table([
        { key: "date", label: "Date", type: "date" },
        { key: "batch", label: "Batch", type: "text" },
        { key: "type", label: "Type", type: "badge" },
        { key: "lost", label: "Lost", type: "int", sum: true },
        { key: "cause", label: "Cause", type: "text" },
        { key: "loss", label: "Estimated loss", type: "money", sum: true },
      ], mortalityRows, { title: "Mortality records" }),
    ],
  });

  /* ----------------------------------------------------------- production */
  const inputsByRun = groupBy(productionInputs, (input) => input.run_id);
  const productionRows = productionRuns.slice(0, 300).map((run) => {
    const inputs = inputsByRun.get(run.id) || [];
    const inputQuantity = inputs.reduce((total, input) => total + asNumber(input.quantity_milli), 0);
    const output = asNumber(run.output_quantity_milli);
    return {
      batch: run.run_number,
      date: run.run_date,
      product: run.output_product_name,
      input: quantity(inputQuantity),
      output: quantity(output),
      unit: run.output_unit_code,
      yield: inputQuantity > 0 ? (output / inputQuantity) * 100 : 0,
      raw: asNumber(run.input_cost_paisa),
      labor: asNumber(run.labor_cost_paisa),
      overhead: asNumber(run.other_cost_paisa),
      packaging: asNumber(run.other_cost_paisa),
      total: asNumber(run.total_cost_paisa),
    };
  });
  const spiceProductionRows = periodSpice.slice(0, 300).map((batch) => ({
    batch: batch.batch_number,
    date: batch.batch_date,
    product: batch.output_product_name || batch.name,
    input: 0,
    output: quantity(batch.output_quantity_milli),
    unit: batch.output_unit_code,
    yield: 0,
    raw: asNumber(batch.input_cost_paisa),
    labor: asNumber(batch.labor_cost_paisa),
    overhead: asNumber(batch.other_cost_paisa),
    packaging: 0,
    total: asNumber(batch.input_cost_paisa) + asNumber(batch.labor_cost_paisa) + asNumber(batch.other_cost_paisa),
  }));

  const production: ReportSectionSpec = finalizeSection({
    id: "production",
    title: "Production",
    group: "Farm and production",
    note: "Product production runs and spice batches in the period.",
    tables: [
      table([
        { key: "batch", label: "Batch", type: "text" },
        { key: "date", label: "Date", type: "date" },
        { key: "product", label: "Product", type: "text" },
        { key: "input", label: "Input", type: "num", sum: true },
        { key: "output", label: "Output", type: "num", sum: true },
        { key: "unit", label: "Unit", type: "text" },
        { key: "yield", label: "Yield", type: "pct" },
        { key: "raw", label: "Raw material", type: "money", sum: true },
        { key: "labor", label: "Labour", type: "money", sum: true },
        { key: "overhead", label: "Overhead", type: "money", sum: true },
        { key: "packaging", label: "Packaging", type: "money", sum: true },
        { key: "total", label: "Total cost", type: "money", sum: true },
      ], productionRows, { title: "Product production" }),
      table([
        { key: "batch", label: "Batch", type: "text" },
        { key: "date", label: "Date", type: "date" },
        { key: "product", label: "Product", type: "text" },
        { key: "output", label: "Output (kg)", type: "num", sum: true },
        { key: "raw", label: "Raw material", type: "money", sum: true },
        { key: "labor", label: "Labour", type: "money", sum: true },
        { key: "overhead", label: "Overhead", type: "money", sum: true },
        { key: "total", label: "Total cost", type: "money", sum: true },
      ], spiceProductionRows, { title: "Spice production" }),
    ],
  });

  /* ------------------------------------------------------------- employees */
  const latestCompensation = new Map<string, Row>();
  for (const compensation of staffCompensation) {
    const existing = latestCompensation.get(compensation.staff_id);
    if (!existing || String(compensation.effective_from) > String(existing.effective_from)) {
      latestCompensation.set(compensation.staff_id, compensation);
    }
  }
  const activeEmployees = hrEmployees.filter((employee) => employee.is_active);
  const employeeRows = activeEmployees.map((employee) => {
    const compensation = latestCompensation.get(employee.staff_profile_id) || latestCompensation.get(employee.id);
    const base = asNumber(compensation?.base_salary_paisa);
    const allowance = asNumber(compensation?.allowances_paisa);
    const profile = staffById.get(employee.staff_profile_id);
    return {
      department: departmentById.get(employee.department_id)?.name || "No department",
      code: employee.id.slice(0, 8),
      name: employee.full_name,
      designation: employee.job_title || "—",
      type: profile?.role || "Employee",
      phone: employee.phone || "—",
      joined: employee.created_at,
      base,
      allowance,
    };
  });
  const employeeByDepartment = groupBy(employeeRows, (employee) => employee.department);
  const employees: ReportSectionSpec = finalizeSection({
    id: "employees",
    title: "Employees",
    group: "People",
    note: "As of today. Active employees only. Salary figures use the latest compensation record.",
    tables: [
      table([
        { key: "department", label: "Department", type: "text" },
        { key: "heads", label: "Employees", type: "int", sum: true },
        { key: "bill", label: "Monthly salary bill", type: "money", sum: true },
      ], [...employeeByDepartment.entries()].map(([department, rows]) => ({
        department,
        heads: rows.length,
        bill: rows.reduce((total, employee) => total + employee.base + employee.allowance, 0),
      })).sort((left, right) => right.heads - left.heads), { title: "By department" }),
      table([
        { key: "code", label: "Code", type: "text" },
        { key: "name", label: "Name", type: "text" },
        { key: "department", label: "Department", type: "text" },
        { key: "designation", label: "Designation", type: "text" },
        { key: "type", label: "Type", type: "badge" },
        { key: "phone", label: "Phone", type: "text" },
        { key: "joined", label: "Added", type: "date" },
        { key: "base", label: "Basic", type: "money", sum: true },
        { key: "allowance", label: "Allowance", type: "money", sum: true },
      ], employeeRows.sort((left, right) => left.name.localeCompare(right.name)), { title: "Employee list" }),
    ],
  });

  /* ------------------------------------------------------------ attendance */
  const attendanceByStaff = groupBy(staffAttendance, (attendance) => attendance.staff_id);
  const attendanceRows = [...attendanceByStaff.entries()].map(([staffId, rows]) => {
    const profile = staffById.get(staffId);
    const count = (status: string) => rows.filter((row) => String(row.status) === status).length;
    return {
      code: staffId.slice(0, 8),
      name: profile?.full_name || "Unknown",
      present: count("present"),
      half: count("half_day"),
      absent: count("absent"),
      leave: count("leave"),
      holiday: count("holiday"),
      overtime: 0,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const attendance: ReportSectionSpec = finalizeSection({
    id: "attendance",
    title: "Attendance summary",
    group: "People",
    note: "Attendance records in the period. Overtime hours are not stored in the cloud schema.",
    tables: [
      table([
        { key: "code", label: "Code", type: "text" },
        { key: "name", label: "Employee", type: "text" },
        { key: "present", label: "Present", type: "int", sum: true },
        { key: "half", label: "Half day", type: "int", sum: true },
        { key: "absent", label: "Absent", type: "int", sum: true },
        { key: "leave", label: "Leave", type: "int", sum: true },
        { key: "holiday", label: "Holiday", type: "int", sum: true },
        { key: "overtime", label: "Overtime hours", type: "num", sum: true },
      ], attendanceRows),
    ],
  });

  /* --------------------------------------------------------------- payroll */
  const runById = new Map(payrollRuns.map((run) => [run.id, run]));
  const payrollRows = payrollItems.map((item) => {
    const run = runById.get(item.run_id);
    const other = asNumber(item.attendance_deduction_paisa) + asNumber(item.tax_withheld_paisa);
    return {
      month: run ? monthLabel(monthKey(run.period_start)) : "—",
      periodStart: run?.period_start || "",
      code: String(item.staff_id).slice(0, 8),
      name: item.staff_name,
      present: asNumber(item.present_days),
      basic: asNumber(item.base_salary_paisa),
      allowance: asNumber(item.allowances_paisa),
      overtime: 0,
      bonus: 0,
      gross: asNumber(item.gross_paisa),
      advance: asNumber(item.advance_deduction_paisa),
      other,
      net: asNumber(item.net_paisa),
      paidOn: run?.paid_at || "",
      department: item.department_name,
    };
  }).sort((left, right) => String(right.periodStart).localeCompare(String(left.periodStart)) || left.name.localeCompare(right.name));

  const payroll: ReportSectionSpec = finalizeSection({
    id: "payroll",
    title: "Payroll",
    group: "People",
    note: "Salary records for payroll runs that fall inside the selected dates.",
    tables: [
      table([
        { key: "month", label: "Month", type: "text" },
        { key: "code", label: "Code", type: "text" },
        { key: "name", label: "Employee", type: "text" },
        { key: "present", label: "Days present", type: "int", sum: true },
        { key: "basic", label: "Basic", type: "money", sum: true },
        { key: "allowance", label: "Allowance", type: "money", sum: true },
        { key: "overtime", label: "Overtime", type: "money", sum: true },
        { key: "bonus", label: "Bonus", type: "money", sum: true },
        { key: "gross", label: "Gross", type: "money", sum: true },
        { key: "advance", label: "Advance deducted", type: "money", sum: true },
        { key: "other", label: "Other deductions", type: "money", sum: true },
        { key: "net", label: "Net pay", type: "money", sum: true },
        { key: "paidOn", label: "Paid on", type: "date" },
      ], payrollRows),
    ],
  });

  /* -------------------------------------------------------------- advances */
  const recoveredByAdvance = new Map<string, number>();
  for (const recovery of advanceRecoveries) {
    recoveredByAdvance.set(recovery.advance_id, (recoveredByAdvance.get(recovery.advance_id) || 0) + asNumber(recovery.amount_paisa));
  }
  const advanceRow = (advance: Row) => {
    const amount = asNumber(advance.amount_paisa);
    const recovered = recoveredByAdvance.get(advance.id) || 0;
    const profile = staffById.get(advance.staff_id);
    return {
      date: advance.advance_date,
      code: String(advance.staff_id).slice(0, 8),
      name: profile?.full_name || "Unknown",
      reason: advance.notes || "—",
      repayment: "Payroll",
      status: recovered >= amount && amount > 0 ? "Repaid" : "Open",
      amount,
      outstanding: Math.max(0, amount - recovered),
    };
  };
  const outstandingAdvances = staffAdvances
    .map(advanceRow)
    .filter((row) => row.outstanding > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  const periodAdvances = staffAdvances
    .filter((advance) => inDateRange(advance.advance_date, from, to))
    .map(advanceRow)
    .sort((left, right) => right.date.localeCompare(left.date));

  const advances: ReportSectionSpec = finalizeSection({
    id: "advances",
    title: "Employee advances",
    group: "People",
    note: "Outstanding advances are shown as of today. Recoveries come from payroll runs.",
    tables: [
      table([
        { key: "date", label: "Date", type: "date" },
        { key: "code", label: "Code", type: "text" },
        { key: "name", label: "Employee", type: "text" },
        { key: "reason", label: "Reason", type: "text" },
        { key: "repayment", label: "Repayment", type: "badge" },
        { key: "amount", label: "Amount", type: "money", sum: true },
        { key: "outstanding", label: "Outstanding", type: "money", sum: true },
      ], outstandingAdvances, { title: "Outstanding advances (as of today)", empty: "No outstanding advances." }),
      table([
        { key: "date", label: "Date", type: "date" },
        { key: "code", label: "Code", type: "text" },
        { key: "name", label: "Employee", type: "text" },
        { key: "reason", label: "Reason", type: "text" },
        { key: "status", label: "Status", type: "text" },
        { key: "amount", label: "Amount", type: "money", sum: true },
      ], periodAdvances, { title: "Advances given in the period" }),
    ],
  });

  const sections = [
    summary, monthly, expensesSection, salesStore, salesProduct, salesDaily, invoicesSection, receivables,
    purchasesVendor, poRegister, payables, grn, stockValuation, stockAlerts, stockMovement, spiceBulk,
    livestock, production, employees, attendance, payroll, advances,
  ];

  return {
    kind: "erp",
    from,
    to,
    branchId: options.branchId,
    branchName: options.branchName,
    generatedAt: new Date().toISOString(),
    sections,
  };
}
