import {
  baseDocument,
  chooseOrientation,
  formatReportDate,
  formatReportMoney,
  formatReportQuantity,
  reportTableMarkup,
  sectionMarkup,
  summaryMarkup,
  type GeneratedDocument,
  type PrintOrientation,
  type ReportBranding,
} from "@/lib/print/document";

export interface DailyReportInput {
  date: string;
  branchName: string;
  sales: {
    count: number;
    totalPaisa: number;
    discountPaisa: number;
    taxPaisa: number;
    paidPaisa: number;
    duePaisa: number;
  };
  returns: { count: number; refundPaisa: number; restockMilli: number };
  netPaisa: number;
  payments: { method: string; count: number; amount: number }[];
  refundsByMethod: { method: string; count: number; amount: number }[];
  topProducts: {
    product_name: string;
    sku: string | null;
    quantity_milli: number;
    revenue_paisa: number;
  }[];
  cashDrawer: {
    openingFloatPaisa: number;
    cashSalesPaisa: number;
    cashRefundsPaisa: number;
    cashInPaisa: number;
    cashOutPaisa: number;
    expectedCashPaisa: number;
  };
  dayClose?: { counted_cash_paisa: number; difference_paisa: number } | null;
  dayCloses?: { counted_cash_paisa: number; difference_paisa: number }[];
}

const DAILY_COLUMNS = [
  { label: "Method", weight: 2 },
  { label: "Count", weight: 1, numeric: true },
  { label: "Amount", weight: 2, numeric: true },
];

/**
 * Desktop parity: `dailyReportHtml` from `electron/report-documents.cjs`.
 */
export function generateDailyReportDocument(
  report: DailyReportInput,
  {
    branding = {},
    orientationPreference = "auto",
    printedBy = "Staff",
    filterSummary = "",
  }: {
    branding?: ReportBranding;
    orientationPreference?: PrintOrientation;
    printedBy?: string;
    filterSummary?: string;
  } = {},
): GeneratedDocument {
  const orientation = chooseOrientation(DAILY_COLUMNS, orientationPreference);
  const paymentRows = (report.payments || []).map((item) => [
    item.method.replaceAll("_", " ").toUpperCase(),
    String(item.count),
    formatReportMoney(item.amount),
  ]);
  const refundRows = (report.refundsByMethod || []).map((item) => [
    item.method.replaceAll("_", " ").toUpperCase(),
    String(item.count),
    formatReportMoney(item.amount),
  ]);
  const paymentTotal = (report.payments || []).reduce((total, item) => total + item.amount, 0);
  const paymentCount = (report.payments || []).reduce((total, item) => total + item.count, 0);
  const refundTotal = (report.refundsByMethod || []).reduce((total, item) => total + item.amount, 0);
  const refundCount = (report.refundsByMethod || []).reduce((total, item) => total + item.count, 0);
  const closes = report.dayCloses || [];
  const counted = report.dayClose?.counted_cash_paisa
    ?? (closes.length ? closes.reduce((total, row) => total + row.counted_cash_paisa, 0) : null);
  const difference = report.dayClose?.difference_paisa
    ?? (closes.length ? closes.reduce((total, row) => total + row.difference_paisa, 0) : null);
  const drawerRows: [string, string][] = [
    ["Opening float", formatReportMoney(report.cashDrawer.openingFloatPaisa)],
    ["Cash sales", formatReportMoney(report.cashDrawer.cashSalesPaisa)],
    ["Cash refunds", formatReportMoney(report.cashDrawer.cashRefundsPaisa)],
    ["Cash in", formatReportMoney(report.cashDrawer.cashInPaisa)],
    ["Cash out", formatReportMoney(report.cashDrawer.cashOutPaisa)],
    ["Expected cash", formatReportMoney(report.cashDrawer.expectedCashPaisa)],
    ["Counted cash", counted === null ? "Not closed" : formatReportMoney(counted)],
    ["Difference", difference === null ? "—" : formatReportMoney(difference)],
  ];
  const topColumns = [
    { label: "Product", weight: 4 },
    { label: "Quantity", weight: 1, numeric: true },
    { label: "Revenue", weight: 2, numeric: true },
  ];
  const topRows = (report.topProducts || []).map((item) => [
    item.sku ? `${item.product_name} (${item.sku})` : item.product_name,
    formatReportQuantity(item.quantity_milli),
    formatReportMoney(item.revenue_paisa),
  ]);
  const content = `${summaryMarkup([
    ["Gross sales", formatReportMoney(report.sales.totalPaisa)],
    ["Refunds", formatReportMoney(report.returns.refundPaisa)],
    ["Net sales", formatReportMoney(report.netPaisa)],
    ["Expected cash", formatReportMoney(report.cashDrawer.expectedCashPaisa)],
  ])}
  ${sectionMarkup("Payments taken", reportTableMarkup(DAILY_COLUMNS, paymentRows, {
    totals: ["TOTAL", String(paymentCount), formatReportMoney(paymentTotal)],
  }))}
  ${sectionMarkup("Refunds paid by method", reportTableMarkup(DAILY_COLUMNS, refundRows, {
    totals: ["TOTAL", String(refundCount), formatReportMoney(refundTotal)],
  }))}
  ${sectionMarkup("Cash drawer reconciliation", summaryMarkup(drawerRows))}
  ${sectionMarkup("Top 10 products by quantity and revenue", reportTableMarkup(topColumns, topRows))}`;

  return {
    html: baseDocument({
      reportTitle: "DAILY REPORT",
      orientation,
      branding,
      metadata: {
        printedAt: new Date(),
        printedBy,
        branch: report.branchName,
        period: formatReportDate(report.date),
        filterSummary,
      },
      content,
    }),
    orientation,
    title: "DAILY REPORT",
  };
}
