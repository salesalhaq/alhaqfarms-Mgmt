import { formatMoney, labelize } from "@/lib/format";

export type ReportValueType =
  | "text"
  | "date"
  | "datetime"
  | "badge"
  | "money"
  | "int"
  | "num"
  | "pct";

export interface ReportColumnSpec {
  key: string;
  label: string;
  type: ReportValueType;
  /** Include this column in the footer total. */
  sum?: boolean;
}

export type ReportCell = string | number | null | undefined;
export type ReportRow = {
  [key: string]: ReportCell | boolean | undefined;
  __nosum?: boolean;
};

export interface ReportTableSpec {
  title?: string;
  empty?: string;
  columns: ReportColumnSpec[];
  rows: ReportRow[];
  totals?: Record<string, number> | null;
}

export interface ReportSectionSpec {
  id: string;
  title: string;
  group: string;
  note?: string;
  tables: ReportTableSpec[];
}

export interface ReportCenterPayload {
  kind: "admin" | "erp";
  from: string;
  to: string;
  branchId: string | null;
  branchName: string;
  generatedAt: string;
  sections: ReportSectionSpec[];
  errors?: string[];
}

export interface ReportDefinition {
  id: string;
  title: string;
  group: string;
  icon: string;
}

export const ADMIN_REPORTS: ReportDefinition[] = [
  { id: "summary", title: "Executive summary", group: "Overview", icon: "💼" },
  { id: "daily", title: "Daily sales", group: "Overview", icon: "📆" },
  { id: "monthly", title: "Month-by-month results", group: "Overview", icon: "📅" },
  { id: "branches", title: "Branch performance", group: "Sales", icon: "🏬" },
  { id: "payments", title: "Payment methods and channels", group: "Sales", icon: "💳" },
  { id: "products", title: "Products sold", group: "Sales", icon: "🥩" },
  { id: "categories", title: "Sales by category", group: "Sales", icon: "📂" },
  { id: "orders", title: "Order register", group: "Sales", icon: "🧾" },
  { id: "status", title: "Order status and cancellations", group: "Sales", icon: "🚚" },
  { id: "tax", title: "Tax and delivery", group: "Sales", icon: "🧮" },
  { id: "pos_sales", title: "POS sales and profit", group: "POS", icon: "🛒" },
  { id: "cashiers", title: "Cashier performance", group: "POS", icon: "👤" },
  { id: "shifts", title: "Shifts and cash", group: "POS", icon: "⏱️" },
  { id: "pos_expenses", title: "Shop expenses", group: "POS", icon: "💸" },
  { id: "voids", title: "Voids, refunds and discounts", group: "POS", icon: "🚫" },
  { id: "customers", title: "Customers", group: "Customers and returns", icon: "👥" },
  { id: "pos_credit", title: "POS customer credit", group: "Customers and returns", icon: "📒" },
  { id: "returns", title: "Returns", group: "Customers and returns", icon: "🔄" },
  { id: "stock_value", title: "Stock valuation", group: "Stock", icon: "📊" },
  { id: "stock_low", title: "Low and out of stock", group: "Stock", icon: "⚠️" },
  { id: "branch_stock", title: "Branch stock", group: "Stock", icon: "🏪" },
  { id: "adjustments", title: "Stock adjustments", group: "Stock", icon: "📈" },
  { id: "transfers", title: "Stock transfers", group: "Stock", icon: "🚛" },
  { id: "erp_received", title: "ERP stock received", group: "Stock", icon: "📥" },
];

export const ERP_REPORTS: ReportDefinition[] = [
  { id: "summary", title: "Executive summary", group: "Finance", icon: "💼" },
  { id: "monthly", title: "Month-by-month results", group: "Finance", icon: "📅" },
  { id: "expenses", title: "Expenses", group: "Finance", icon: "💸" },
  { id: "sales_store", title: "Sales by customer / store", group: "Sales", icon: "🏪" },
  { id: "sales_product", title: "Sales by product", group: "Sales", icon: "🛒" },
  { id: "sales_daily", title: "Daily sales", group: "Sales", icon: "📆" },
  { id: "invoices", title: "Invoice register", group: "Sales", icon: "🧾" },
  { id: "receivables", title: "Receivables and ageing", group: "Sales", icon: "🤝" },
  { id: "purchases_vendor", title: "Purchases by vendor", group: "Purchasing", icon: "🏢" },
  { id: "po_register", title: "Purchase order register", group: "Purchasing", icon: "📦" },
  { id: "payables", title: "Payables and vendor payments", group: "Purchasing", icon: "💳" },
  { id: "grn", title: "Goods receipts", group: "Purchasing", icon: "📥" },
  { id: "stock_valuation", title: "Stock valuation", group: "Inventory", icon: "📊" },
  { id: "stock_alerts", title: "Low and out of stock", group: "Inventory", icon: "⚠️" },
  { id: "stock_movement", title: "Stock movements", group: "Inventory", icon: "🔄" },
  { id: "spice_bulk", title: "Spice and bulk stock", group: "Inventory", icon: "🌶️" },
  { id: "livestock", title: "Livestock and mortality", group: "Farm and production", icon: "🐔" },
  { id: "production", title: "Production", group: "Farm and production", icon: "🏭" },
  { id: "employees", title: "Employees", group: "People", icon: "👥" },
  { id: "attendance", title: "Attendance summary", group: "People", icon: "🗓️" },
  { id: "payroll", title: "Payroll", group: "People", icon: "💵" },
  { id: "advances", title: "Employee advances", group: "People", icon: "🪙" },
];

export function reportCatalog(kind: "admin" | "erp"): ReportDefinition[] {
  return kind === "erp" ? ERP_REPORTS : ADMIN_REPORTS;
}

export function reportGroups(definitions: ReportDefinition[]): Array<{ name: string; items: ReportDefinition[] }> {
  const groups: Array<{ name: string; items: ReportDefinition[] }> = [];
  for (const definition of definitions) {
    let group = groups.find((entry) => entry.name === definition.group);
    if (!group) {
      group = { name: definition.group, items: [] };
      groups.push(group);
    }
    group.items.push(definition);
  }
  return groups;
}

export function formatDateOnly(value: string): string {
  if (!value) return "—";
  const dateOnly = value.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(date);
    }
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

export function formatReportValue(value: ReportCell, type: ReportValueType): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  switch (type) {
    case "money":
      return Number.isFinite(number) ? formatMoney(number) : "—";
    case "int":
      return Number.isFinite(number) ? new Intl.NumberFormat("en-PK").format(number) : "—";
    case "num":
      return Number.isFinite(number)
        ? new Intl.NumberFormat("en-PK", { maximumFractionDigits: 3 }).format(number)
        : "—";
    case "pct":
      return Number.isFinite(number) ? `${number.toFixed(1)}%` : "—";
    case "badge":
      return labelize(String(value));
    case "date":
      return formatDateOnly(String(value));
    case "datetime": {
      const parsed = new Date(String(value));
      if (Number.isNaN(parsed.getTime())) return String(value);
      return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
    }
    default:
      return String(value);
  }
}

export function reportRowValues(
  table: ReportTableSpec,
  row: ReportRow,
): string[] {
  return table.columns.map((column) => formatReportValue(row[column.key] as ReportCell, column.type));
}

export function reportTotalsRow(table: ReportTableSpec): string[] {
  return table.columns.map((column) => {
    if (!column.sum || !table.totals) return "";
    return formatReportValue(table.totals[column.key] ?? 0, column.type);
  });
}

/** Computes footer totals for every column marked `sum`. */
export function finalizeTable(table: ReportTableSpec): ReportTableSpec {
  const totals: Record<string, number> = {};
  let hasTotals = false;
  for (const column of table.columns) {
    if (!column.sum) continue;
    hasTotals = true;
    totals[column.key] = table.rows.reduce(
      (total, row) => (row.__nosum ? total : total + Number(row[column.key] || 0)),
      0,
    );
  }
  return { ...table, totals: hasTotals ? totals : null };
}

export function finalizeSection(section: ReportSectionSpec): ReportSectionSpec {
  return { ...section, tables: section.tables.map(finalizeTable) };
}

export function reportSectionCsv(section: ReportSectionSpec): string {
  const escape = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines: string[] = [];
  for (const table of section.tables) {
    if (table.title) lines.push(escape(table.title));
    lines.push(table.columns.map((column) => escape(column.label)).join(","));
    for (const row of table.rows) {
      lines.push(reportRowValues(table, row).map(escape).join(","));
    }
    if (table.totals) {
      lines.push(
        reportTotalsRow(table)
          .map((value, index) => (index === 0 ? escape("Total") : escape(value)))
          .join(","),
      );
    }
    lines.push("");
  }
  return lines.join("\r\n");
}
