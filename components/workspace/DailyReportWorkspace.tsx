"use client";

import { AlertCircle, Download, Eye, LoaderCircle, Printer, RefreshCw, X } from "lucide-react";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import { formatDateTime, formatMoney, formatQuantity, labelize } from "@/lib/format";
import type {
  StaffDailyReportClose,
  StaffDailyReportPayload,
  StaffDailyReportShift,
} from "@/lib/supabase/database.types";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatReportMoney, type GeneratedDocument } from "@/lib/print/document";
import { generateDailyReportDocument } from "@/lib/print/report-daily";
import { printHtmlDocument } from "@/lib/print/print-window";
import { loadPrinterSettings } from "@/lib/print/printer-settings";
import { printHtmlViaBridge, printReceiptElementViaBridge } from "@/lib/print/bridge-print";
import { postWorkspaceAction } from "@/lib/workspace/write-client";
import {
  receiptPageCss,
  receiptWidth,
} from "@/lib/print/receipt";

interface DailyReportShift extends StaffDailyReportShift {
  branch_name: string;
  cashier_name: string;
}

interface DailyReportClose extends StaffDailyReportClose {
  branch_name: string;
  closed_by_name: string;
}

interface DailyReportResponse extends StaffDailyReportPayload {
  shifts: DailyReportShift[];
  dayClose: DailyReportClose | null;
  dayCloses: DailyReportClose[];
  error?: string;
}

function localDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function differenceTone(amount: number): string {
  if (amount === 0) return "green";
  return amount > 0 ? "amber" : "red";
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parsePaisaInput(value: string): number | null {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const paisa = Math.round(Number(text) * 100);
  return Number.isSafeInteger(paisa) ? paisa : null;
}

function SummaryTable({ title, headers, children, empty }: {
  title: string;
  headers: string[];
  children: React.ReactNode;
  empty: boolean;
}) {
  const tableId = `daily-report-table-${title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className="daily-report-panel card">
      <div className="daily-report-panel-heading">
        <h2>{title}</h2>
        <TableDocumentTools tableId={tableId} title={title} />
      </div>
      <div className="table-wrap">
        <table id={tableId}>
          <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
          <tbody>
            {empty ? <tr><td className="daily-report-empty-cell" colSpan={headers.length}>No records for this business date.</td></tr> : children}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ValueBars({ title, items }: { title: string; items: { label: string; amount: number }[] }) {
  const maxAmount = Math.max(...items.map((item) => item.amount), 1);
  return (
    <section className="daily-report-panel card">
      <h2>{title}</h2>
      {items.length ? (
        <div className="daily-report-bars">
          {items.map((item) => (
            <div className="daily-report-bar-row" key={item.label}>
              <span>{labelize(item.label)}</span>
              <div className="daily-report-bar-track" aria-hidden="true">
                <span style={{ width: `${Math.max(3, (item.amount / maxAmount) * 100)}%` }} />
              </div>
              <strong>{formatMoney(item.amount)}</strong>
            </div>
          ))}
        </div>
      ) : <p className="daily-report-empty">No records for this business date.</p>}
    </section>
  );
}

export function DailyReportWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const { settings: receiptSettings } = useBusinessSettings();
  const [date, setDate] = useState(() => localDateInput(new Date()));
  const [branchId, setBranchId] = useState("");
  const [report, setReport] = useState<DailyReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [zReportOpen, setZReportOpen] = useState(false);
  const [preview, setPreview] = useState<GeneratedDocument | null>(null);
  const [closeBranchId, setCloseBranchId] = useState("");
  const [countedCash, setCountedCash] = useState("");
  const [closeNotes, setCloseNotes] = useState("");
  const [closingDay, setClosingDay] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const isAdmin = staff?.role === "admin";
  const isHqAdmin = isAdmin && staff?.branch_id === null;
  const canCloseDay = isAdmin || staff?.role === "manager";
  const branchName = branchId === "all"
    ? "All branches"
    : branches.find((branch) => branch.id === branchId)?.name || "Your branch";
  const closedBranchIds = new Set(report?.dayCloses.map((close) => close.branch_id) ?? []);

  const buildA4Document = (): GeneratedDocument | null => {
    if (!report) return null;
    return generateDailyReportDocument(
      { ...report, branchName },
      { branding: {
        businessName: receiptSettings.businessName,
        businessTagline: receiptSettings.businessTagline,
        logoDataUrl: receiptSettings.logoDataUrl,
      } },
    );
  };

  const printGenerated = async (generated: GeneratedDocument): Promise<boolean> => {
    const settings = loadPrinterSettings();
    if (settings.silentPrint && settings.reportPrinter) {
      const result = await printHtmlViaBridge(generated.html, {
        printer: settings.reportPrinter,
        copies: 1,
        title: generated.title,
        pageSize: generated.orientation === "landscape" ? "A4 landscape" : "A4 portrait",
      });
      if (result.printed) return true;
      if (!result.bridgeUnavailable && result.reason) {
        setError(result.reason);
        return false;
      }
    }
    if (!printHtmlDocument(generated.html, { title: generated.title })) {
      setError("The print window was blocked. Allow pop-ups for this site and try again.");
      return false;
    }
    return true;
  };

  const printA4 = async () => {
    const generated = buildA4Document();
    if (generated) await printGenerated(generated);
  };

  const printZReport = async () => {
    const element = document.querySelector(".receipt-print");
    const result = await printReceiptElementViaBridge(element, {
      pageCss: receiptPageCss(receiptSettings),
      title: "Z-report",
    });
    if (!result.printed) window.print();
  };

  const closeDay = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetBranchId = branchId === "all" ? closeBranchId : branchId;
    const countedCashPaisa = parsePaisaInput(countedCash);
    if (!targetBranchId) {
      setCloseError("Choose the branch to close.");
      return;
    }
    if (countedCashPaisa === null) {
      setCloseError("Enter counted cash as a non-negative amount with up to two decimals.");
      return;
    }

    setClosingDay(true);
    setCloseError(null);
    try {
      await postWorkspaceAction("/api/workspace/daily-report-actions", {
        branchId: targetBranchId,
        businessDate: date,
        countedCashPaisa,
        notes: closeNotes,
      });
      setCountedCash("");
      setCloseNotes("");
      setCloseBranchId("");
      setReloadKey((value) => value + 1);
    } catch (closeFailure) {
      setCloseError(closeFailure instanceof Error ? closeFailure.message : "Could not close this business day.");
    } finally {
      setClosingDay(false);
    }
  };

  useEffect(() => {
    if (staff?.role === "admin" && !staff.branch_id && !branchId) setBranchId("all");
    else if (staff?.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff?.branch_id, staff?.role]);

  useEffect(() => {
    if (!staff || !date) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    setReport(null);
    const parameters = new URLSearchParams({ date });
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/daily-report?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as DailyReportResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load the daily report.");
        setReport(result);
      } catch (loadError) {
        if (!active) return;
        setReport(null);
        setError(loadError instanceof Error ? loadError.message : "Could not load the daily report.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, date, reloadKey, staff]);

  useEffect(() => {
    setCountedCash("");
    setCloseNotes("");
    setCloseBranchId("");
    setCloseError(null);
  }, [branchId, date]);

  const exportCsv = () => {
    if (!report) return;
    const moneyValue = (paisa: number) => (paisa / 100).toFixed(2);
    const rows: unknown[][] = [
      ["Section", "Item", "Value", "Unit"],
      ["Report", "Date", report.date, ""],
      ["Report", "Branch", branchName, ""],
      ["Sales", "Count", report.sales.count, "sales"],
      ["Sales", "Gross", moneyValue(report.sales.totalPaisa), "PKR"],
      ["Sales", "Discount", moneyValue(report.sales.discountPaisa), "PKR"],
      ["Sales", "Tax", moneyValue(report.sales.taxPaisa), "PKR"],
      ["Returns", "Count", report.returns.count, "returns"],
      ["Returns", "Refunds", moneyValue(report.returns.refundPaisa), "PKR"],
      ["Report", "Net", moneyValue(report.netPaisa), "PKR"],
      ["Cash drawer", "Opening float", moneyValue(report.cashDrawer.openingFloatPaisa), "PKR"],
      ["Cash drawer", "Cash sales", moneyValue(report.cashDrawer.cashSalesPaisa), "PKR"],
      ["Cash drawer", "Cash refunds", moneyValue(report.cashDrawer.cashRefundsPaisa), "PKR"],
      ["Cash drawer", "Cash in", moneyValue(report.cashDrawer.cashInPaisa), "PKR"],
      ["Cash drawer", "Cash out", moneyValue(report.cashDrawer.cashOutPaisa), "PKR"],
      ["Cash drawer", "Expected cash", moneyValue(report.cashDrawer.expectedCashPaisa), "PKR"],
      ...report.payments.map((payment) => ["Payments taken", payment.method, moneyValue(payment.amount), "PKR"]),
      ...report.refundsByMethod.map((refund) => ["Refunds paid", refund.method, moneyValue(refund.amount), "PKR"]),
      ...report.shifts.map((shift) => [
        "Shift", `${shift.cashier_name} · ${shift.branch_name}`,
        moneyValue(shift.expected_cash_paisa || 0), "PKR",
      ]),
      ...report.dayCloses.map((close) => [
        "Day close", close.branch_name, moneyValue(close.difference_paisa), "PKR",
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `daily-report-${report.date}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const dayClose = report?.dayClose;

  return (
    <div className="daily-report-print">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>Business-day sales, refunds, payment methods, shifts, and the expected register cash.</p>
        </div>
      </div>

      <div className="daily-report-toolbar daily-report-no-print">
        {isHqAdmin && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select className="toolbar-select" value={branchId || "all"} onChange={(event) => setBranchId(event.target.value)}>
              <option value="all">All branches</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
        <label className="toolbar-control">
          <span>Business date</span>
          <input className="daily-report-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <button className="button secondary" type="button" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}>
          {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          REF
        </button>
        <button className="button secondary" type="button" disabled={!report} onClick={exportCsv}>
          <Download size={14} /> Export CSV
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!report}
          onClick={() => void printA4()}
        >
          <Printer size={14} /> Print A4
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!report}
          onClick={() => {
            const document = buildA4Document();
            if (document) setPreview(document);
          }}
        >
          <Eye size={14} /> Preview
        </button>
      </div>

      <div className="live-readonly-note daily-report-no-print">
        <AlertCircle size={16} />
        <span>Live cloud figures · day-close snapshots are calculated from the branch sales, refunds, and register ledger.</span>
      </div>

      {error && <div className="notice" role="alert">{error}</div>}
      {loading && !report && <div className="loading"><LoaderCircle className="spin" size={18} /> Loading daily report…</div>}
      {!loading && !report && !error && <div className="empty"><h2>No report available</h2><p>Select a business date to review its figures.</p></div>}

      {report && (
        <>
          <div className="daily-report-print-heading">
            <h2>Daily report · {report.date}</h2>
            <p>{branchName}</p>
          </div>
          <div className="dashboard-stats daily-report-stats">
            <div className="dashboard-stat card"><span>Gross sales</span><strong>{formatMoney(report.sales.totalPaisa)}</strong><small>{report.sales.count} sale{report.sales.count === 1 ? "" : "s"}</small></div>
            <div className="dashboard-stat card"><span>Refunds</span><strong>{formatMoney(report.returns.refundPaisa)}</strong><small>{report.returns.count} return{report.returns.count === 1 ? "" : "s"}</small></div>
            <div className="dashboard-stat card"><span>Net</span><strong>{formatMoney(report.netPaisa)}</strong><small>Sales less refunds</small></div>
            <div className="dashboard-stat card"><span>Expected cash</span><strong>{formatMoney(report.cashDrawer.expectedCashPaisa)}</strong><small>{dayClose ? "Day closed" : "Current drawer expectation"}</small></div>
          </div>

          <div className="daily-report-grid">
            <ValueBars title="Payments taken" items={report.payments.map((payment) => ({ label: payment.method, amount: payment.amount }))} />
            <ValueBars title="Refunds paid" items={report.refundsByMethod.map((refund) => ({ label: refund.method, amount: refund.amount }))} />
          </div>

          <div className="daily-report-grid">
            <SummaryTable title="Payments taken" headers={["Method", "Transactions", "Amount"]} empty={!report.payments.length}>
              {report.payments.map((payment) => <tr key={payment.method}><td>{labelize(payment.method)}</td><td>{payment.count}</td><td><strong>{formatMoney(payment.amount)}</strong></td></tr>)}
            </SummaryTable>
            <SummaryTable title="Refunds paid" headers={["Method", "Refunds", "Amount"]} empty={!report.refundsByMethod.length}>
              {report.refundsByMethod.map((refund) => <tr key={refund.method}><td>{labelize(refund.method)}</td><td>{refund.count}</td><td><strong>{formatMoney(refund.amount)}</strong></td></tr>)}
            </SummaryTable>
          </div>

          <section className="daily-report-panel card daily-report-cash">
            <h2>Cash drawer</h2>
            <div className="daily-report-cash-lines">
              <div><span>Opening float</span><strong>{formatMoney(report.cashDrawer.openingFloatPaisa)}</strong></div>
              <div><span>Cash sales</span><strong>{formatMoney(report.cashDrawer.cashSalesPaisa)}</strong></div>
              <div><span>Cash refunds</span><strong>− {formatMoney(report.cashDrawer.cashRefundsPaisa)}</strong></div>
              <div><span>Cash in</span><strong>{formatMoney(report.cashDrawer.cashInPaisa)}</strong></div>
              <div><span>Cash out</span><strong>− {formatMoney(report.cashDrawer.cashOutPaisa)}</strong></div>
              <div className="daily-report-cash-total"><span>Expected in drawer</span><strong>{formatMoney(report.cashDrawer.expectedCashPaisa)}</strong></div>
            </div>
          </section>

          <SummaryTable title="Top products" headers={["Product", "SKU", "Quantity", "Revenue"]} empty={!report.topProducts.length}>
            {report.topProducts.map((product, index) => (
              <tr key={`${product.sku || product.product_name}-${index}`}>
                <td>{product.product_name}</td><td>{product.sku || "—"}</td>
                <td>{formatQuantity(product.quantity_milli)}</td><td><strong>{formatMoney(product.revenue_paisa)}</strong></td>
              </tr>
            ))}
          </SummaryTable>

          <SummaryTable title="Shifts opened" headers={isAdmin ? ["Cashier", "Branch", "Opened", "Status", "Opening float", "Expected", "Counted", "Difference"] : ["Cashier", "Opened", "Status", "Opening float", "Expected", "Counted", "Difference"]} empty={!report.shifts.length}>
            {report.shifts.map((shift) => (
              <tr key={shift.id}>
                <td>{shift.cashier_name}</td>
                {isAdmin && <td>{shift.branch_name}</td>}
                <td className="nowrap">{formatDateTime(shift.opened_at)}</td>
                <td><span className={`status ${shift.status === "open" ? "amber" : "green"}`}>{labelize(shift.status)}</span></td>
                <td>{formatMoney(shift.opening_cash_paisa)}</td>
                <td>{formatMoney(shift.expected_cash_paisa || 0)}</td>
                <td>{shift.counted_cash_paisa == null ? "—" : formatMoney(shift.counted_cash_paisa)}</td>
                <td>{shift.difference_paisa == null ? "—" : <span className={`status ${differenceTone(shift.difference_paisa)}`}>{formatMoney(shift.difference_paisa)}</span>}</td>
              </tr>
            ))}
          </SummaryTable>

          {report.dayCloses.length > 0 && !dayClose && (
            <SummaryTable title="Branch day closes" headers={["Branch", "Closed by", "Closed at", "Expected", "Counted", "Difference"]} empty={false}>
              {report.dayCloses.map((close) => (
                <tr key={close.id}>
                  <td>{close.branch_name}</td><td>{close.closed_by_name}</td><td className="nowrap">{formatDateTime(close.closed_at)}</td>
                  <td>{formatMoney(close.expected_cash_paisa)}</td><td>{formatMoney(close.counted_cash_paisa)}</td>
                  <td><span className={`status ${differenceTone(close.difference_paisa)}`}>{formatMoney(close.difference_paisa)}</span></td>
                </tr>
              ))}
            </SummaryTable>
          )}

          <section className="daily-report-close card">
            <div className="daily-report-close-heading">
              <div><h2>Day close</h2><p>{dayClose ? `Closed by ${dayClose.closed_by_name} at ${formatDateTime(dayClose.closed_at)}. This record is frozen.` : `No day-close record for ${date} at ${branchName}.`}</p></div>
              {dayClose ? (
                <button className="button secondary daily-report-no-print" type="button" onClick={() => setZReportOpen(true)}>
                  <Printer size={14} /> Z-report
                </button>
              ) : null}
            </div>
            {dayClose ? (
              <div className="daily-report-close-summary">
                <div><span>Expected</span><strong>{formatMoney(dayClose.expected_cash_paisa)}</strong></div>
                <div><span>Counted</span><strong>{formatMoney(dayClose.counted_cash_paisa)}</strong></div>
                <div><span>Difference</span><span className={`status ${differenceTone(dayClose.difference_paisa)}`}>{formatMoney(dayClose.difference_paisa)}</span></div>
                <div><span>Gross sales</span><strong>{formatMoney(dayClose.gross_sales_paisa)}</strong></div>
                <div><span>Refunds</span><strong>{formatMoney(dayClose.refunds_paisa)}</strong></div>
                {dayClose.notes && <div className="daily-report-close-notes"><span>Notes</span><strong>{dayClose.notes}</strong></div>}
              </div>
            ) : canCloseDay ? (
              <form className="daily-report-close-form" onSubmit={(event) => void closeDay(event)}>
                {isHqAdmin && branchId === "all" && (
                  <label className="toolbar-control">
                    <span>Branch to close</span>
                    <select className="toolbar-select" required value={closeBranchId} onChange={(event) => setCloseBranchId(event.target.value)}>
                      <option value="">Choose branch</option>
                      {branches.map((branch) => (
                        <option key={branch.id} value={branch.id} disabled={closedBranchIds.has(branch.id)}>
                          {branch.name}{closedBranchIds.has(branch.id) ? " (closed)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="daily-report-close-fields">
                  <label className="toolbar-control">
                    <span>Counted cash (PKR)</span>
                    <input
                      inputMode="decimal"
                      maxLength={18}
                      placeholder={(report.cashDrawer.expectedCashPaisa / 100).toFixed(2)}
                      required
                      value={countedCash}
                      onChange={(event) => setCountedCash(event.target.value)}
                    />
                  </label>
                  <label className="toolbar-control">
                    <span>Closing notes <small>Optional</small></span>
                    <input maxLength={500} value={closeNotes} onChange={(event) => setCloseNotes(event.target.value)} />
                  </label>
                </div>
                <p className="daily-report-empty">Expected cash is opening float plus cash sales and cash in, minus cash refunds and cash out. Closing stores the counted amount and difference.</p>
                {closeError && <div className="notice" role="alert">{closeError}</div>}
                <div className="daily-report-close-actions">
                  <button className="button" disabled={closingDay || !report} type="submit">
                    {closingDay ? <LoaderCircle size={14} className="spin" /> : null}
                    {closingDay ? "Closing…" : "Close day"}
                  </button>
                </div>
              </form>
            ) : <p className="daily-report-empty">A manager or administrator must close the business day.</p>}
          </section>
        </>
      )}

      {zReportOpen && report && (
        <div
          className="sales-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setZReportOpen(false);
          }}
        >
          <section aria-label="Z-report" aria-modal="true" className="sales-dialog card" role="dialog">
            <header className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Z-report</p>
                <h2>{report.date}</h2>
              </div>
              <button
                aria-label="Close Z-report"
                className="button secondary"
                onClick={() => setZReportOpen(false)}
                type="button"
              >
                <X size={16} />
              </button>
            </header>
            <style>{receiptPageCss(receiptSettings)}</style>
            <article
              className="receipt-print"
              style={{ "--print-receipt-width": receiptWidth(receiptSettings) } as CSSProperties}
            >
              <header className="receipt-business">
                <strong>{branchName}</strong>
                <small>{report.date} · Z-report</small>
              </header>
              <div className="receipt-meta">
                <div><span>Closed by</span><strong>{dayClose?.closed_by_name || "—"}</strong></div>
                <div><span>Closed at</span><strong>{dayClose ? new Date(dayClose.closed_at).toLocaleString() : "—"}</strong></div>
                <div><span>Sales</span><strong>{report.sales.count}</strong></div>
                <div><span>Returns</span><strong>{report.returns.count}</strong></div>
              </div>
              <div className="receipt-totals">
                <div><span>Gross sales</span><strong>{formatReportMoney(report.sales.totalPaisa)}</strong></div>
                <div><span>Discounts</span><strong>− {formatReportMoney(report.sales.discountPaisa)}</strong></div>
                <div><span>Tax included</span><strong>{formatReportMoney(report.sales.taxPaisa)}</strong></div>
                <div><span>Refunds</span><strong>− {formatReportMoney(report.returns.refundPaisa)}</strong></div>
                <div className="receipt-total"><span>Net</span><strong>{formatReportMoney(report.netPaisa)}</strong></div>
              </div>
              <div className="receipt-items">
                {report.payments.map((payment) => (
                  <div className="receipt-item" key={payment.method}>
                    <div><strong>{labelize(payment.method)}</strong></div>
                    <strong>{formatReportMoney(payment.amount)}</strong>
                  </div>
                ))}
                {report.refundsByMethod.map((refund) => (
                  <div className="receipt-item" key={`refund-${refund.method}`}>
                    <div><strong>{labelize(refund.method)} refund</strong></div>
                    <strong>− {formatReportMoney(refund.amount)}</strong>
                  </div>
                ))}
              </div>
              <div className="receipt-totals">
                <div><span>Opening float</span><strong>{formatReportMoney(report.cashDrawer.openingFloatPaisa)}</strong></div>
                <div><span>Expected cash</span><strong>{formatReportMoney(report.cashDrawer.expectedCashPaisa)}</strong></div>
                <div><span>Counted cash</span><strong>{formatReportMoney(dayClose?.counted_cash_paisa ?? 0)}</strong></div>
                <div className="receipt-total"><span>Difference</span><strong>{formatReportMoney(dayClose?.difference_paisa ?? 0)}</strong></div>
              </div>
              <footer className="receipt-thanks">End of day</footer>
            </article>
            <div className="sales-dialog-actions">
              <button className="button" onClick={() => void printZReport()} type="button">
                <Printer size={15} /> Print Z-report
              </button>
            </div>
          </section>
        </div>
      )}
      {preview && (
        <div
          className="table-document-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <section
            aria-label="Daily report preview"
            aria-modal="true"
            className={`table-document-preview ${preview.orientation}`}
            role="dialog"
          >
            <header>
              <div>
                <h2>Daily report</h2>
                <p>A4 {preview.orientation}</p>
              </div>
              <button type="button" className="button secondary" onClick={() => setPreview(null)}>
                Close
              </button>
            </header>
            <div className="table-document-paper">
              <iframe title="Daily report preview" srcDoc={preview.html} sandbox="" />
            </div>
            <footer>
              <span>
                PDF opens the browser print dialog; choose “Save as PDF”. The document matches the
                Windows desktop daily report.
              </span>
              <button
                type="button"
                className="button"
                onClick={() => {
                  void (async () => {
                    if (await printGenerated(preview)) setPreview(null);
                  })();
                }}
              >
                <Printer size={14} /> Print / Save as PDF
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
