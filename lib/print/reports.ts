/**
 * Desktop-specific report documents.
 *
 * Each generator mirrors the matching function in the Windows desktop app
 * (`electron/report-documents.cjs`): same title, columns, summary blocks,
 * totals row, formatting and A4 layout. The web workspaces feed these with
 * live cloud rows so printed output matches the offline client.
 */

import {
  baseDocument,
  chooseOrientation,
  formatReportDate,
  formatReportMoney,
  formatReportPercent,
  formatReportQuantity,
  reportTableMarkup,
  sectionMarkup,
  summaryMarkup,
  type GeneratedDocument,
  type PrintOrientation,
  type ReportBranding,
  type ReportColumn,
} from "@/lib/print/document";

export interface ReportOptions {
  branding?: ReportBranding;
  orientationPreference?: PrintOrientation;
  printedBy?: string;
  branch?: string | null;
  period?: string | null;
  filterSummary?: string | null;
  tightColumns?: boolean;
}

function build(
  title: string,
  columns: ReportColumn[],
  content: string,
  options: ReportOptions,
  extraMetadata: { period?: string | null; filterSummary?: string | null } = {},
): GeneratedDocument {
  const orientation = chooseOrientation(columns, options.orientationPreference || "auto");
  return {
    html: baseDocument({
      reportTitle: title,
      orientation,
      branding: options.branding || {},
      metadata: {
        printedAt: new Date(),
        printedBy: options.printedBy || "Staff",
        branch: options.branch ?? "All branches",
        period: extraMetadata.period ?? options.period ?? null,
        filterSummary: extraMetadata.filterSummary ?? options.filterSummary ?? null,
        tightColumns: options.tightColumns,
      },
      content,
    }),
    orientation,
    title,
  };
}

/* ------------------------------------------------------------------ sales */

export interface SalesHistoryRow {
  receipt_number: string;
  completed_at: string;
  customer_name?: string | null;
  cashier_name: string;
  branch_name: string;
  channel?: string | null;
  source_type?: string | null;
  unit_count_milli: number;
  payment_methods: string[];
  total_paisa: number;
  status: string;
}

const SALES_HISTORY_COLUMNS: ReportColumn[] = [
  { label: "Order", weight: 2, priority: 1, long: true },
  { label: "Date", weight: 2, priority: 1 },
  { label: "Customer", weight: 2, priority: 1 },
  { label: "Cashier", weight: 2, priority: 1 },
  { label: "Branch", weight: 2, priority: 1 },
  { label: "Channel", weight: 1, priority: 1 },
  { label: "Items", weight: 1, priority: 1 },
  { label: "Payment", weight: 2, priority: 1 },
  { label: "Total", weight: 2, priority: 1 },
  { label: "Status", weight: 1, priority: 2 },
];

export function generateSalesHistoryDocument(
  input: {
    rows: SalesHistoryRow[];
    grandTotalPaisa?: number;
    period?: string;
    filterSummary?: string;
  },
  options: ReportOptions = {},
): GeneratedDocument {
  const columns = SALES_HISTORY_COLUMNS.map((column) => ({ ...column }));
  const rows = input.rows.map((sale) => [
    sale.receipt_number,
    formatReportDate(sale.completed_at, { withTime: true }),
    sale.customer_name || "Walk-in Customer",
    sale.cashier_name,
    sale.branch_name,
    sale.channel || (sale.source_type === "web_order" ? "Web" : "POS"),
    formatReportQuantity(sale.unit_count_milli),
    sale.payment_methods.join(", ") || "—",
    formatReportMoney(sale.total_paisa),
    sale.status.replaceAll("_", " ").toUpperCase(),
  ]);

  const byPayment = new Map<string, { count: number; amountPaisa: number }>();
  const byChannel = new Map<string, { count: number; totalPaisa: number }>();
  for (const sale of input.rows) {
    const methods = sale.payment_methods.length ? sale.payment_methods : ["—"];
    for (const method of methods) {
      const current = byPayment.get(method) || { count: 0, amountPaisa: 0 };
      current.count += 1;
      current.amountPaisa += Number(sale.total_paisa || 0);
      byPayment.set(method, current);
    }
    const channel = sale.channel || (sale.source_type === "web_order" ? "Web" : "POS");
    const current = byChannel.get(channel) || { count: 0, totalPaisa: 0 };
    current.count += 1;
    current.totalPaisa += Number(sale.total_paisa || 0);
    byChannel.set(channel, current);
  }

  const paymentSummary: [string, string][] = [...byPayment.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([method, value]) => [
      `${method.replaceAll("_", " ").toUpperCase()} (${value.count})`,
      formatReportMoney(value.amountPaisa),
    ]);
  const channelSummary: [string, string][] = [...byChannel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, value]) => [`${channel} (${value.count})`, formatReportMoney(value.totalPaisa)]);
  const summaryBlock = (title: string, items: [string, string][]) =>
    `<div><h2>${title}</h2>${summaryMarkup(items.length ? items : [["No records for this period", "—"]])}</div>`;

  const activeCount = input.rows.filter((sale) => sale.status !== "void").length;
  const grandTotal = input.grandTotalPaisa
    ?? input.rows.reduce((total, sale) => total + Number(sale.total_paisa || 0), 0);
  const salesTable = sectionMarkup("Sales history", reportTableMarkup(columns, rows, {
    totals: ["GRAND TOTAL", "", "", "", "", "", "", "", formatReportMoney(grandTotal), ""],
  }));
  const content = `${summaryMarkup([
    ["Sales records", input.rows.length],
    ["Non-void receipts", activeCount],
    ["Grand total", formatReportMoney(grandTotal)],
  ])}
  <div class="summary-columns">
    ${summaryBlock("By payment method", paymentSummary)}
    ${summaryBlock("By channel", channelSummary)}
  </div>
  ${salesTable}`;

  return build("SALES HISTORY REPORT", columns, content, options, {
    period: input.period || options.period || "All dates",
    filterSummary: input.filterSummary ?? options.filterSummary,
  });
}

/* -------------------------------------------------------------- inventory */

export interface BranchInventoryProduct {
  name: string;
  sku?: string | null;
  barcode?: string | null;
  category_name?: string | null;
  unit_code: string;
  stock_milli: number;
  cost_price_paisa?: number | null;
  reorder_point_milli?: number | null;
  is_active?: boolean;
}

export function stockValuePaisa(quantityMilli: number, costPaisa: number): number {
  const quantity = BigInt(Math.max(0, Math.trunc(Number(quantityMilli || 0))));
  const cost = BigInt(Math.max(0, Math.trunc(Number(costPaisa || 0))));
  const value = (quantity * cost) / BigInt(1000);
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : value);
}

function addSafeMoney(left: number, right: number): number {
  const sum = Number(left || 0) + Number(right || 0);
  if (!Number.isSafeInteger(sum)) {
    throw new Error("The report total contains an unsupported amount.");
  }
  return sum;
}

const BRANCH_INVENTORY_COLUMNS: ReportColumn[] = [
  { label: "Product", weight: 3, priority: 1 },
  { label: "SKU", weight: 1.5, priority: 1 },
  { label: "Category", weight: 1.5, priority: 1 },
  { label: "On hand", weight: 1, priority: 1 },
  { label: "Unit", weight: 0.7, priority: 1 },
  { label: "Reorder point", weight: 1, priority: 1 },
  { label: "Status", weight: 1, priority: 1 },
  { label: "Stock value at cost", weight: 1.5, priority: 1 },
];

export function generateBranchInventoryDocument(
  input: { products: BranchInventoryProduct[]; branchName?: string },
  options: ReportOptions = {},
): GeneratedDocument {
  const products = input.products || [];
  const categoryTotals = new Map<string, { count: number; value: number }>();
  const rows = products.map((product) => {
    const value = stockValuePaisa(product.stock_milli, product.cost_price_paisa || 0);
    const category = product.category_name || "Uncategorized";
    const current = categoryTotals.get(category) || { count: 0, value: 0 };
    current.count += 1;
    current.value = addSafeMoney(current.value, value);
    categoryTotals.set(category, current);
    const reorder = Number(product.reorder_point_milli || 0);
    const status = product.is_active === false
      ? "INACTIVE"
      : product.stock_milli < 0
        ? "NEGATIVE"
        : product.stock_milli === 0
          ? "OUT OF STOCK"
          : product.stock_milli <= reorder
            ? "LOW"
            : "OK";
    return [
      product.name,
      product.sku || product.barcode || "—",
      category,
      formatReportQuantity(product.stock_milli),
      product.unit_code,
      formatReportQuantity(reorder),
      status,
      formatReportMoney(value),
    ];
  });
  const totalValue = [...categoryTotals.values()].reduce(
    (total, item) => addSafeMoney(total, item.value),
    0,
  );
  const categoryRows = [...categoryTotals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, item]) => [category, String(item.count), formatReportMoney(item.value)]);
  const content = `${summaryMarkup([
    ["Total products", products.length],
    ["Total stock value at cost", formatReportMoney(totalValue)],
  ])}
  ${products.length
    ? sectionMarkup("Inventory", reportTableMarkup(BRANCH_INVENTORY_COLUMNS, rows, {
        totals: ["GRAND TOTAL", "", "", "", "", "", "", formatReportMoney(totalValue)],
      }))
    : sectionMarkup("Inventory", reportTableMarkup(BRANCH_INVENTORY_COLUMNS, []))}
  ${categoryRows.length
    ? sectionMarkup("Totals per category", reportTableMarkup([
        { label: "Category", weight: 3 },
        { label: "Products", weight: 1, numeric: true },
        { label: "Stock value at cost", weight: 2, numeric: true },
      ], categoryRows, {
        totals: ["GRAND TOTAL", String(products.length), formatReportMoney(totalValue)],
      }))
    : ""}`;

  return build("BRANCH INVENTORY REPORT", BRANCH_INVENTORY_COLUMNS, content, {
    ...options,
    branch: input.branchName ?? options.branch,
  });
}

/* ---------------------------------------------------------- product list */

export interface ProductCatalogRow {
  id: string;
  name: string;
  category_name?: string | null;
  sku?: string | null;
  barcode?: string | null;
  unit_code: string;
  cost_price_paisa: number;
  price_paisa: number;
  on_sale?: boolean;
  discounted_price_paisa?: number | null;
  fbr_pct_code?: string | null;
  stock_milli: number;
  is_active?: boolean;
}

const PRODUCT_CATALOG_COLUMNS: ReportColumn[] = [
  { label: "Product (ID)", weight: 2.5, priority: 1 },
  { label: "Category", weight: 1.5, priority: 1 },
  { label: "SKU / barcode", weight: 1.5, priority: 1 },
  { label: "Unit", weight: 0.7, priority: 1 },
  { label: "Cost", weight: 1, priority: 1 },
  { label: "Price", weight: 1, priority: 1 },
  { label: "Margin %", weight: 0.8, priority: 1 },
  { label: "FBR PCT", weight: 1, priority: 1 },
  { label: "Stock", weight: 1, priority: 1 },
  { label: "Status", weight: 1.2, priority: 1 },
];

export function generateProductCatalogDocument(
  input: { products: ProductCatalogRow[]; branchName?: string },
  options: ReportOptions = {},
): GeneratedDocument {
  const products = input.products || [];
  const rows = products.map((product) => {
    const price = product.on_sale && product.discounted_price_paisa != null
      ? product.discounted_price_paisa
      : product.price_paisa;
    const cost = Number(product.cost_price_paisa || 0);
    const margin = price > 0 ? ((price - cost) / price) * 100 : 0;
    const status = product.is_active === false
      ? "INACTIVE"
      : price <= cost
        ? "PRICE <= COST"
        : product.on_sale
          ? "ON SALE"
          : "ACTIVE";
    return [
      `${product.name} (${product.id})`,
      product.category_name || "Uncategorized",
      [product.sku, product.barcode].filter(Boolean).join(" / ") || "—",
      product.unit_code,
      formatReportMoney(cost),
      formatReportMoney(price),
      formatReportPercent(margin),
      product.fbr_pct_code || "—",
      formatReportQuantity(product.stock_milli),
      status,
    ];
  });
  const averagePrice = products.length
    ? products.reduce((sum, product) => sum + Number(
        product.on_sale && product.discounted_price_paisa != null
          ? product.discounted_price_paisa
          : product.price_paisa,
      ), 0) / products.length
    : 0;
  const content = `${summaryMarkup([
    ["Total products", products.length],
    ["Average price", formatReportMoney(averagePrice)],
  ])}
  ${sectionMarkup("Product catalog", reportTableMarkup(PRODUCT_CATALOG_COLUMNS, rows))}`;

  return build("PRODUCT INVENTORY REPORT", PRODUCT_CATALOG_COLUMNS, content, {
    ...options,
    branch: input.branchName ?? options.branch,
  });
}

/* -------------------------------------------------------------- returns */

export interface ReturnsRefundsRow {
  return_number: string;
  created_at: string;
  receipt_number: string;
  branch_name?: string | null;
  customer_name?: string | null;
  reason?: string | null;
  refund_total_paisa: number;
  restock_total_milli: number;
  status: string;
}

const RETURNS_COLUMNS: ReportColumn[] = [
  { label: "Return no.", weight: 1.3, priority: 1 },
  { label: "Date", weight: 1.4, priority: 1 },
  { label: "Receipt", weight: 1.3, priority: 1 },
  { label: "Branch", weight: 1.4, priority: 1 },
  { label: "Customer", weight: 1.6, priority: 1 },
  { label: "Reason", weight: 2, priority: 1, long: true },
  { label: "Refund", weight: 1.1, priority: 1 },
  { label: "Restocked", weight: 1, priority: 1 },
  { label: "Status", weight: 1, priority: 1 },
];

export function generateReturnsRefundsDocument(
  input: { rows: ReturnsRefundsRow[]; period?: string; filterSummary?: string },
  options: ReportOptions = {},
): GeneratedDocument {
  const returns = input.rows || [];
  const completedRefund = returns.reduce(
    (sum, row) => sum + (row.status === "completed" ? Number(row.refund_total_paisa || 0) : 0),
    0,
  );
  const rows = returns.map((row) => [
    row.return_number,
    formatReportDate(row.created_at, { withTime: true }),
    row.receipt_number,
    row.branch_name || "—",
    row.customer_name || "Walk-in Customer",
    row.reason || "—",
    formatReportMoney(row.refund_total_paisa),
    formatReportQuantity(row.restock_total_milli),
    row.status.replaceAll("_", " ").toUpperCase(),
  ]);
  const content = `${summaryMarkup([
    ["Returns", returns.length],
    ["Total refunded (completed)", formatReportMoney(completedRefund)],
  ])}
  ${sectionMarkup("Returns and refunds", reportTableMarkup(RETURNS_COLUMNS, rows, {
    totals: ["TOTAL", "", "", "", "", "", formatReportMoney(completedRefund), "", ""],
  }))}`;

  return build("RETURNS & REFUNDS REPORT", RETURNS_COLUMNS, content, options, {
    period: input.period ?? options.period,
    filterSummary: input.filterSummary ?? options.filterSummary,
  });
}

/* --------------------------------------------------------- online orders */

export interface OnlineOrderRow {
  order_number: string;
  customer_name?: string | null;
  item_count: number;
  total_paisa: number;
  payment_method?: string | null;
  payment_status?: string | null;
  payment_review_status?: string | null;
  status: string;
  created_at: string;
}

const ONLINE_ORDER_COLUMNS: ReportColumn[] = [
  { label: "Order", weight: 1.7, priority: 1, long: true },
  { label: "Customer", weight: 1.8, priority: 1 },
  { label: "Items", weight: 0.7, priority: 1 },
  { label: "Total", weight: 1, priority: 1 },
  { label: "Payment method / status", weight: 2, priority: 1 },
  { label: "Order status", weight: 1, priority: 1 },
  { label: "Placed", weight: 1.5, priority: 1 },
];

export function generateOnlineOrdersDocument(
  input: { rows: OnlineOrderRow[]; period?: string; filterSummary?: string },
  options: ReportOptions = {},
): GeneratedDocument {
  const orders = input.rows || [];
  const statusTotals = new Map<string, { count: number; total: number }>();
  for (const order of orders) {
    const current = statusTotals.get(order.status) || { count: 0, total: 0 };
    current.count += 1;
    current.total += Number(order.total_paisa || 0);
    statusTotals.set(order.status, current);
  }
  const rows = orders.map((order) => {
    const flags: string[] = [];
    if (Number(order.item_count) === 0 && Number(order.total_paisa) > 0) {
      flags.push("NO ITEMS, NONZERO TOTAL");
    }
    if (
      order.status === "accepted" &&
      (order.payment_review_status === "rejected" || order.payment_status === "rejected")
    ) {
      flags.push("ACCEPTED, PAYMENT REJECTED");
    }
    const paymentStatus = order.payment_review_status === "rejected"
      ? "rejected"
      : order.payment_status || "—";
    return [
      order.order_number,
      order.customer_name || "—",
      String(order.item_count),
      formatReportMoney(order.total_paisa),
      `${String(order.payment_method || "—").replaceAll("_", " ")} · ${String(paymentStatus).replaceAll("_", " ")}`,
      `${order.status.replaceAll("_", " ").toUpperCase()}${flags.length ? ` · ${flags.join("; ")}` : ""}`,
      formatReportDate(order.created_at, { withTime: true }),
    ];
  });
  const summaryRows = [...statusTotals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, value]) => [
      `${status.replaceAll("_", " ").toUpperCase()} (${value.count})`,
      formatReportMoney(value.total),
    ]);
  const orderValue = orders.reduce((sum, order) => sum + Number(order.total_paisa || 0), 0);
  const content = `${summaryMarkup([
    ["Orders", orders.length],
    ["Order value", formatReportMoney(orderValue)],
  ])}
  ${summaryRows.length
    ? sectionMarkup("Totals by status", reportTableMarkup([
        { label: "Status", weight: 3 },
        { label: "Total", weight: 2, numeric: true },
      ], summaryRows))
    : ""}
  ${sectionMarkup("Online orders", reportTableMarkup(ONLINE_ORDER_COLUMNS, rows, {
    totals: ["TOTAL", "", "", formatReportMoney(orderValue), "", "", ""],
  }))}`;

  return build("ONLINE ORDERS REPORT", ONLINE_ORDER_COLUMNS, content, options, {
    period: input.period ?? options.period,
    filterSummary: input.filterSummary ?? options.filterSummary,
  });
}

/* ------------------------------------------------------------ suppliers */

export interface SupplierDirectoryRow {
  name: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  is_active: boolean;
  purchased_paisa?: number | null;
}

const SUPPLIER_COLUMNS: ReportColumn[] = [
  { label: "Supplier", weight: 1.7, priority: 1 },
  { label: "Contact", weight: 1.2, priority: 1 },
  { label: "Phone", weight: 1.3, priority: 1 },
  { label: "Email", weight: 2.3, priority: 1, long: true },
  { label: "Status", weight: 0.8, priority: 1 },
  { label: "Total purchased", weight: 1.2, priority: 1 },
];

export function generateSupplierDirectoryDocument(
  input: { rows: SupplierDirectoryRow[]; branchName?: string },
  options: ReportOptions = {},
): GeneratedDocument {
  const suppliers = input.rows || [];
  const totalPurchased = suppliers.reduce(
    (sum, supplier) => sum + Number(supplier.purchased_paisa || 0),
    0,
  );
  const rows = suppliers.map((supplier) => [
    supplier.name,
    supplier.contact_name || "—",
    supplier.phone || "—",
    supplier.email || "—",
    supplier.is_active ? "ACTIVE" : "INACTIVE",
    supplier.purchased_paisa == null ? "—" : formatReportMoney(supplier.purchased_paisa),
  ]);
  const content = `${summaryMarkup([
    ["Total suppliers", suppliers.length],
    ["Total purchased", formatReportMoney(totalPurchased)],
  ])}
  ${sectionMarkup("Supplier directory", reportTableMarkup(SUPPLIER_COLUMNS, rows, {
    totals: ["TOTAL", "", "", "", "", formatReportMoney(totalPurchased)],
  }))}`;

  return build("SUPPLIER DIRECTORY REPORT", SUPPLIER_COLUMNS, content, {
    ...options,
    branch: input.branchName ?? options.branch,
  });
}

/* ------------------------------------------------------------------- ERP */

export interface ErpReportInput {
  range: { from: string; to: string };
  bulk: { invoices: number; totalPaisa: number };
  production: {
    runs: number;
    totalCostPaisa: number;
    top: { name: string; runs: number; quantityMilli: number; totalCost: number }[];
  };
  spice: {
    batches: number;
    totalCostPaisa: number;
    batchRows: Array<{
      batch_number?: string | null;
      name?: string | null;
      output_product_name?: string | null;
      output_unit_code?: string | null;
      input_unit_count?: number | null;
      input_unit_code?: string | null;
      input_quantity_milli?: number | null;
      output_quantity_milli?: number | null;
      input_cost_paisa?: number | null;
      labor_cost_paisa?: number | null;
      other_cost_paisa?: number | null;
    }>;
  };
  expenses: {
    totalPaisa: number;
    count: number;
    byCategory: { name: string; count: number; total: number }[];
  };
  animals: { feedCostPaisa: number; feedQuantityMilli: number };
}

export function generateErpReportDocument(
  input: ErpReportInput,
  options: ReportOptions = {},
): GeneratedDocument {
  const report = input;
  const summaryRows = [
    ["Wholesale invoiced", formatReportMoney(report.bulk.totalPaisa), `${report.bulk.invoices} invoices`],
    ["Production cost", formatReportMoney(report.production.totalCostPaisa), `${report.production.runs} runs`],
    ["Spice batch cost", formatReportMoney(report.spice.totalCostPaisa), `${report.spice.batches} completed batches`],
    ["Farm expenses", formatReportMoney(report.expenses.totalPaisa), `${report.expenses.count} entries`],
    ["Feed issued", formatReportMoney(report.animals.feedCostPaisa), formatReportQuantity(report.animals.feedQuantityMilli)],
  ];
  const productionRows = (report.production.top || []).map((row) => [
    row.name,
    String(row.runs),
    formatReportQuantity(row.quantityMilli),
    formatReportMoney(row.totalCost),
  ]);
  const expenseRows = (report.expenses.byCategory || []).map((row) => [
    row.name,
    String(row.count),
    formatReportMoney(row.total),
  ]);
  const spiceRows = (report.spice.batchRows || []).map((batch) => {
    const inputMatchesOutputUnit = batch.input_unit_count === 1
      && batch.input_unit_code === batch.output_unit_code
      && Number(batch.input_quantity_milli) > 0;
    const yieldPercent = inputMatchesOutputUnit
      ? formatReportPercent(
          Number(batch.output_quantity_milli) / Number(batch.input_quantity_milli) * 100,
        )
      : "—";
    const totalCost = Number(batch.input_cost_paisa || 0)
      + Number(batch.labor_cost_paisa || 0)
      + Number(batch.other_cost_paisa || 0);
    const costPerUnit = Number(batch.output_quantity_milli) > 0
      ? formatReportMoney(totalCost * 1000 / Number(batch.output_quantity_milli))
      : "—";
    return [
      `${batch.batch_number || ""} · ${batch.name || ""}`,
      `${batch.output_product_name || ""} (${batch.output_unit_code || ""})`,
      formatReportMoney(batch.input_cost_paisa || 0),
      formatReportMoney(batch.labor_cost_paisa || 0),
      yieldPercent,
      costPerUnit,
    ];
  });
  const content = `${sectionMarkup("Financial and activity summary", reportTableMarkup([
    { label: "Metric", weight: 2 },
    { label: "Value", weight: 1, numeric: true },
    { label: "Activity", weight: 2 },
  ], summaryRows))}
  ${sectionMarkup("Farm expenses by category", reportTableMarkup([
    { label: "Category", weight: 2 },
    { label: "Entries", weight: 1, numeric: true },
    { label: "Total", weight: 1, numeric: true },
  ], expenseRows))}
  ${sectionMarkup("Production by output", reportTableMarkup([
    { label: "Product", weight: 2 },
    { label: "Runs", weight: 1, numeric: true },
    { label: "Quantity", weight: 1, numeric: true },
    { label: "Cost", weight: 1, numeric: true },
  ], productionRows))}
  ${sectionMarkup("Spice batches", reportTableMarkup([
    { label: "Batch", weight: 1.7 },
    { label: "Output", weight: 1.5 },
    { label: "Raw input cost", weight: 1.3, numeric: true },
    { label: "Packing labor", weight: 1.2, numeric: true },
    { label: "Yield %", weight: 0.8, numeric: true },
    { label: "Cost per kg / output unit", weight: 1.4, numeric: true },
  ], spiceRows))}`;

  return build("ERP REPORT", [
    { label: "Metric", weight: 2 },
    { label: "Value", weight: 1 },
    { label: "Activity", weight: 2 },
  ], content, options, {
    period: `${report.range.from} - ${report.range.to}`,
  });
}
