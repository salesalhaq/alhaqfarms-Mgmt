import { DEFAULT_BRAND_NAME, DEFAULT_BRAND_TAGLINE } from "@/lib/branding";
import { formatReportMoney, formatReportQuantity } from "@/lib/print/document";

export type ReceiptPaperSize = "80mm" | "58mm" | "A4";
export type ReceiptTaxDisplay = "summary" | "detailed";

export interface ReceiptSettings {
  businessName: string;
  businessTagline: string;
  businessAddress: string;
  businessPhone: string;
  businessEmail: string;
  businessWebsite: string;
  logoDataUrl: string;
  showLogoOnReceipt: boolean;
  showTaxOnReceipt: boolean;
  taxDisplay: ReceiptTaxDisplay;
  paperSize: ReceiptPaperSize;
  receiptFooter: string;
  returnPolicy: string;
}

export const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = {
  businessName: DEFAULT_BRAND_NAME,
  businessTagline: DEFAULT_BRAND_TAGLINE,
  businessAddress: "",
  businessPhone: "",
  businessEmail: "",
  businessWebsite: "",
  logoDataUrl: "",
  showLogoOnReceipt: true,
  showTaxOnReceipt: true,
  taxDisplay: "summary",
  paperSize: "80mm",
  receiptFooter: "Thank you for shopping with us",
  returnPolicy: "",
};

export function receiptWidth(settings: ReceiptSettings): string {
  if (settings.paperSize === "A4") return "100%";
  if (settings.paperSize === "58mm") return "50mm";
  return "72mm";
}

export function receiptPageSize(settings: ReceiptSettings): string {
  return settings.paperSize === "A4" ? "A4" : `${settings.paperSize} auto`;
}

/**
 * Named page so receipts and labels can coexist with A4 reports in the same
 * browser document. Chrome supports `@page <name>` + `page: <name>`.
 */
export function receiptPageCss(settings: ReceiptSettings): string {
  return settings.paperSize === "A4"
    ? "@page receipt { size: A4; margin: 10mm; }"
    : `@page receipt { size: ${settings.paperSize} auto; margin: 4mm; }`;
}

export interface ReceiptSale {
  branch_name: string;
  receipt_number: string;
  completed_at: string;
  cashier_name: string;
  customer_name: string;
  customer_phone?: string | null;
  subtotal_paisa: number;
  discount_paisa: number;
  loyalty_discount_paisa: number;
  loyalty_redeemed: number;
  loyalty_earned: number;
  tax_paisa: number;
  tax_mode: string;
  rounding_paisa: number;
  total_paisa: number;
  due_paisa: number;
  change_paisa: number;
  status?: string;
}

export interface ReceiptItem {
  line_number?: number;
  product_name: string;
  unit_code: string;
  quantity_milli: number;
  unit_price_paisa: number;
  discount_paisa: number;
  tax_rate_bps: number;
  tax_paisa: number;
  line_total_paisa: number;
}

export interface ReceiptPayment {
  sequence_number: number;
  method: string;
  amount_paisa: number;
  reference?: string | null;
}

export interface ReceiptReturnRow {
  return_number: string;
  status: string;
  refund_total_paisa: number;
}

/** Desktop `buildReceiptQrData`. */
export function buildReceiptQrData({
  sale,
  items,
  payments,
  returns = [],
}: {
  sale: ReceiptSale;
  items: ReceiptItem[];
  payments: ReceiptPayment[];
  returns?: ReceiptReturnRow[];
}): string {
  const itemCountMilli = items.reduce((total, item) => total + item.quantity_milli, 0);
  const lines = [
    sale.branch_name,
    `Bill: ${sale.receipt_number}`,
    `Date: ${new Date(sale.completed_at).toLocaleString("en-PK")}`,
    `Cashier: ${sale.cashier_name}`,
    `Customer: ${sale.customer_name || "Walk-in Customer"}`,
    `Items: ${formatReportQuantity(itemCountMilli)}`,
    `Sub: ${formatReportMoney(sale.subtotal_paisa)}`,
  ];
  if (sale.discount_paisa) lines.push(`Discount: ${formatReportMoney(sale.discount_paisa)}`);
  if (sale.tax_paisa) lines.push(`Tax: ${formatReportMoney(sale.tax_paisa)}`);
  lines.push(`TOTAL: ${formatReportMoney(sale.total_paisa)}`);
  if (payments.length) {
    lines.push(
      `Paid: ${payments.map((payment) => payment.method.replaceAll("_", " ").toUpperCase()).join(", ")}`,
    );
  }
  lines.push(
    ...items.map(
      (item) =>
        `${item.product_name} x${formatReportQuantity(item.quantity_milli)} @ ${formatReportMoney(item.unit_price_paisa)}`,
    ),
  );
  for (const row of returns) {
    lines.push(
      `Return ${row.return_number}: ${row.status} ${formatReportMoney(row.refund_total_paisa)}`,
    );
  }
  if (sale.status === "void") lines.push("VOID");
  return lines.filter(Boolean).join("\n");
}

export interface ReturnReceiptDetail {
  branch_name: string;
  return_number: string;
  receipt_number: string;
  created_at: string;
  created_by_name: string;
  approved_by_name?: string | null;
  completed_by_name?: string | null;
  customer_name?: string | null;
  status: string;
  reason: string;
  notes?: string | null;
  refund_total_paisa: number;
  items: {
    id: string;
    product_name: string;
    unit_code: string;
    quantity_milli: number;
    condition: string;
    restock: boolean;
    line_refund_paisa: number;
  }[];
  refunds: {
    id: string;
    method: string;
    status: string;
    reference?: string | null;
    amount_paisa: number;
  }[];
}

/** Desktop `buildReturnReceiptQrData`. */
export function buildReturnReceiptQrData(detail: ReturnReceiptDetail): string {
  return [
    detail.branch_name,
    `Return: ${detail.return_number}`,
    `Sale receipt: ${detail.receipt_number}`,
    `Date: ${new Date(detail.created_at).toLocaleString("en-PK")}`,
    `Raised by: ${detail.created_by_name}`,
    `Status: ${detail.status}`,
    `Reason: ${detail.reason}`,
    ...detail.items.map(
      (item) =>
        `${item.product_name} x${formatReportQuantity(item.quantity_milli)} ${item.unit_code} · ${item.condition} · ${formatReportMoney(item.line_refund_paisa)}`,
    ),
    `REFUND TOTAL: ${formatReportMoney(detail.refund_total_paisa)}`,
    ...(detail.refunds || []).map(
      (refund) =>
        `Refund: ${refund.status} via ${refund.method.replaceAll("_", " ")}${refund.reference ? ` · ${refund.reference}` : ""}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
