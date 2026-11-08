"use client";

import { AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatMoney } from "@/lib/format";

interface StoreReportDay {
  date: string;
  gross_sales_paisa: number;
  refunds_paisa: number;
  net_sales_paisa: number;
  receipts_count: number;
  discount_paisa: number;
}

interface StoreReportPaymentRow {
  method: string;
  amount_paisa: number;
  share: number;
}

interface StoreReportProductRow {
  product: string;
  sku: string | null;
  units_milli: number;
  total_paisa: number;
  refunds_paisa: number;
}

interface StoreReportsResponse {
  branchId: string | null;
  branchName: string;
  summary: {
    grossSalesPaisa: number;
    refundsPaisa: number;
    netSalesPaisa: number;
    receiptCount: number;
    averageTicketPaisa: number;
    discountPaisa: number;
  };
  byDay: StoreReportDay[];
  payments: StoreReportPaymentRow[];
  products: StoreReportProductRow[];
  truncated?: boolean;
  generatedAt: string;
  error?: string;
}

interface PageItem {
  section: string;
  title: string;
  description: string;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultDateRange(): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return [localDateKey(from), localDateKey(to)];
}

function formatDateHeading(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-PK", { dateStyle: "medium" }).format(date);
}

export function StoreReportsWorkspace({ item }: { item: PageItem }) {
  const { staff, branches } = useStaffAuth();
  const isHqAdmin = staff?.role === "admin" && staff.branch_id === null;
  const [fromDate, setFromDate] = useState(() => defaultDateRange()[0]);
  const [toDate, setToDate] = useState(() => defaultDateRange()[1]);
  const [branchId, setBranchId] = useState(isHqAdmin ? "all" : staff?.branch_id || "");
  const [report, setReport] = useState<StoreReportsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const selectedBranchName = useMemo(() => {
    if (!staff) return "Your branch";
    if (branchId === "all") return "All accessible branches";
    return branches.find((branch) => branch.id === branchId)?.name || "Your branch";
  }, [branchId, branches, staff]);

  useEffect(() => {
    if (staff?.role === "admin" && !staff.branch_id && !branchId) setBranchId("all");
    else if (staff?.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff?.branch_id, staff?.role]);

  useEffect(() => {
    if (!staff) return undefined;

    let active = true;
    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams({ from: fromDate, to: toDate });
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/store-reports?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const payload = await response.json() as StoreReportsResponse;
        if (!active) return;
        if (!response.ok) throw new Error(payload.error || "Could not load store reports.");
        setReport(payload);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load store reports.");
        setReport(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, fromDate, reloadKey, staff, toDate]);

  const summaryCards = report ? [
    {
      label: "Gross sales",
      value: formatMoney(report.summary.grossSalesPaisa),
      note: `${report.summary.receiptCount} receipts`,
      tone: "green",
    },
    {
      label: "Refunds",
      value: formatMoney(report.summary.refundsPaisa),
      note: `${report.summary.receiptCount ? Math.round((report.summary.refundsPaisa / report.summary.grossSalesPaisa) * 100 || 0) : 0}% of sales`,
      tone: "amber",
    },
    {
      label: "Net sales",
      value: formatMoney(report.summary.netSalesPaisa),
      note: `${formatMoney(report.summary.discountPaisa)} discounts`,
      tone: "blue",
    },
    {
      label: "Average ticket",
      value: formatMoney(report.summary.averageTicketPaisa),
      note: `Across ${report.summary.receiptCount} receipts`,
      tone: "purple",
    },
  ] : [];

  return (
    <div className="daily-report-print">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} This view is read-only and respects your authenticated branch scope.</p>
        </div>
      </div>

      <div className="daily-report-toolbar daily-report-no-print">
        {isHqAdmin && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select className="toolbar-select" value={branchId || "all"} onChange={(event) => setBranchId(event.target.value)}>
              <option value="all">All accessible branches</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}

        <label className="toolbar-control">
          <span>From</span>
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>

        <label className="toolbar-control">
          <span>To</span>
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>

        <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
          {loading ? <><LoaderCircle className="spinner" size={14} /> Loading…</> : <><RefreshCw size={14} /> Refresh</>}
        </button>
      </div>

      {error && (
        <div className="card panel" role="alert">
          <div className="inline-message error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        </div>
      )}

      {loading && (
        <div className="card panel" aria-live="polite">
          <div className="empty loading-state">
            <LoaderCircle className="spinner" size={24} />
            <h2>Loading store reports</h2>
            <p>Checking the selected period and branch scope.</p>
          </div>
        </div>
      )}

      {!loading && report && (
        <>
          {report.truncated && (
            <div className="notice" role="status">
              This report reached the per-period record limit. Narrow the date range for complete totals.
            </div>
          )}
          <div className="daily-report-metrics">
            {summaryCards.map((card) => (
              <div className={`metric-card ${card.tone}`} key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.note}</small>
              </div>
            ))}
          </div>

          <section className="daily-report-panel card">
            <div className="daily-report-panel-heading">
              <h2>Sales and refunds by day</h2>
              <TableDocumentTools tableId="store-reports-daily" title={`${item.title} · ${selectedBranchName}`} disabled={!report.byDay.length} />
            </div>
            <div className="table-wrap">
              <table id="store-reports-daily">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Receipts</th>
                    <th>Gross sales</th>
                    <th>Refunds</th>
                    <th>Discounts</th>
                    <th>Net sales</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byDay.length ? report.byDay.map((row) => (
                    <tr key={row.date}>
                      <td>{formatDateHeading(row.date)}</td>
                      <td>{row.receipts_count}</td>
                      <td>{formatMoney(row.gross_sales_paisa)}</td>
                      <td>{formatMoney(row.refunds_paisa)}</td>
                      <td>{formatMoney(row.discount_paisa)}</td>
                      <td>{formatMoney(row.net_sales_paisa)}</td>
                    </tr>
                  )) : (
                    <tr><td className="daily-report-empty-cell" colSpan={6}>No sales or refunds in the selected range.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <div className="daily-report-grid">
            <section className="daily-report-panel card">
              <div className="daily-report-panel-heading">
                <h2>Payment mix</h2>
                <TableDocumentTools tableId="store-reports-payments" title={`${item.title} payment mix`} disabled={!report.payments.length} />
              </div>
              <div className="table-wrap">
                <table id="store-reports-payments">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Amount</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.payments.length ? report.payments.map((row) => (
                      <tr key={row.method}>
                        <td>{row.method}</td>
                        <td>{formatMoney(row.amount_paisa)}</td>
                        <td>{row.share}%</td>
                      </tr>
                    )) : (
                      <tr><td className="daily-report-empty-cell" colSpan={3}>No captured payment mix for this range.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="daily-report-panel card">
              <div className="daily-report-panel-heading">
                <h2>Top products</h2>
                <TableDocumentTools tableId="store-reports-products" title={`${item.title} product mix`} disabled={!report.products.length} />
              </div>
              <div className="table-wrap">
                <table id="store-reports-products">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>SKU</th>
                      <th>Units</th>
                      <th>Sales</th>
                      <th>Refunds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.products.length ? report.products.map((row) => (
                      <tr key={`${row.product}-${row.sku || "no-sku"}`}>
                        <td>{row.product}</td>
                        <td>{row.sku || "—"}</td>
                        <td>{(row.units_milli / 1000).toFixed(3)}</td>
                        <td>{formatMoney(row.total_paisa)}</td>
                        <td>{formatMoney(row.refunds_paisa)}</td>
                      </tr>
                    )) : (
                      <tr><td className="daily-report-empty-cell" colSpan={5}>No product sales recorded for this range.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
