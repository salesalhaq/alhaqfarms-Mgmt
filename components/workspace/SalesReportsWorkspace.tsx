"use client";

import { AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { TableControls } from "@/components/workspace/TableControls";
import { formatMoney, formatQuantity, labelize } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

type ReportTab = "day" | "cashier" | "product" | "payment";

interface SalesReport {
  from: string;
  to: string;
  branchId: string | null;
  branchName: string;
  summary: {
    receipts: number;
    grossPaisa: number;
    discountPaisa: number;
    taxPaisa: number;
    paidPaisa: number;
    duePaisa: number;
  };
  returns: { count: number; refundPaisa: number };
  netPaisa: number;
  byDay: Array<{ day: string; receipts: number; total: number; discount: number; tax: number }>;
  byCashier: Array<{ id: string; cashier_name: string; receipts: number; total: number; discount: number }>;
  byProduct: Array<{ product_name: string; sku: string | null; quantity: number; total: number; discount: number }>;
  byPayment: Array<{ method: string; receipts: number; amount: number }>;
  truncated?: boolean;
  generatedAt: string;
  error?: string;
}

const TABS: Array<{ id: ReportTab; label: string }> = [
  { id: "day", label: "By day" },
  { id: "cashier", label: "By cashier" },
  { id: "product", label: "By product" },
  { id: "payment", label: "By payment" },
];

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultDateRange(): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(1);
  return [localDateKey(from), localDateKey(to)];
}

function formatDay(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-PK", { dateStyle: "medium" }).format(date);
}

export function SalesReportsWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [[defaultFrom, defaultTo]] = useState(defaultDateRange);
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [report, setReport] = useState<SalesReport | null>(null);
  const [tab, setTab] = useState<ReportTab>("day");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isAdmin = staff?.role === "admin";

  useEffect(() => {
    if (!staff) return;
    if (staff.role === "admin" && !branchId) setBranchId("all");
    else if (staff.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff]);

  useEffect(() => {
    if (!staff) return undefined;
    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams({ from: fromDate, to: toDate });
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/sales-reports?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const payload = await response.json() as SalesReport;
        if (!active) return;
        if (!response.ok) throw new Error(payload.error || "Could not load the sales report.");
        setReport(payload);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the sales report.");
        setReport(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, fromDate, reloadKey, staff, toDate]);

  const activeTab = TABS.find((entry) => entry.id === tab) || TABS[0];
  const tableId = `sales-reports-${tab}`;
  const metrics = report ? [
    { label: "Receipts", value: report.summary.receipts.toLocaleString(), note: `${report.returns.count} completed returns` },
    { label: "Gross sales", value: formatMoney(report.summary.grossPaisa), note: `${formatMoney(report.summary.discountPaisa)} discounts` },
    { label: "Refunds", value: formatMoney(report.returns.refundPaisa), note: `${formatMoney(report.summary.taxPaisa)} tax collected` },
    { label: "Net sales", value: formatMoney(report.netPaisa), note: `${formatMoney(report.summary.duePaisa)} outstanding` },
  ] : [];
  const rowCount = useMemo(() => {
    if (!report) return 0;
    if (tab === "day") return report.byDay.length;
    if (tab === "cashier") return report.byCashier.length;
    if (tab === "product") return report.byProduct.length;
    return report.byPayment.length;
  }, [report, tab]);

  return (
    <div className="daily-report-print">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Compare receipts, refunds, discounts, and the mix by day, cashier, product, or payment method.</p>
        </div>
      </div>

      <div className="daily-report-toolbar daily-report-no-print">
        {isAdmin && (
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
          <input type="date" value={fromDate} max={toDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label className="toolbar-control">
          <span>To</span>
          <input type="date" value={toDate} min={fromDate} onChange={(event) => setToDate(event.target.value)} />
        </label>
        <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
          {loading ? <><LoaderCircle className="spin" size={14} /> Loading…</> : <><RefreshCw size={14} /> Refresh</>}
        </button>
      </div>

      {error && <div className="notice" role="alert">{error}</div>}

      {loading && (
        <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading the sales ledger…</div>
      )}

      {!loading && report && (
        <>
          <section className="dashboard-stats" aria-label="Sales report summary">
            {metrics.map((metric) => (
              <article className="dashboard-stat card" key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.note}</small>
              </article>
            ))}
          </section>

          <div className="workspace-toolbar">
            {TABS.map((entry) => (
              <button
                className={`button ${entry.id === tab ? "" : "secondary"}`}
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
            <span className="muted">{rowCount} rows · {report.branchName}</span>
          </div>

          {rowCount > 0 && (
            <TableControls
              key={tableId}
              tableId={tableId}
              ariaLabel={`${item.title} ${activeTab.label}`}
              filterColumns={tab === "cashier"
                ? [{ column: "Cashier" }]
                : tab === "product"
                  ? [{ column: "Product" }]
                  : tab === "payment"
                    ? [{ column: "Method" }]
                    : []}
            />
          )}
          <section className="card table-wrap workspace-table" aria-label={`${item.title} ${activeTab.label}`}>
            <div className="table-document-heading">
              <strong>{activeTab.label} · {report.from} to {report.to}</strong>
              <TableDocumentTools
                tableId={tableId}
                title={`${item.title} · ${activeTab.label} · ${report.branchName}`}
                disabled={!rowCount}
              />
            </div>
            <table id={tableId}>
              {tab === "day" && (
                <>
                  <thead><tr><th>Day</th><th>Receipts</th><th>Gross</th><th>Discount</th><th>Tax</th></tr></thead>
                  <tbody>
                    {report.byDay.length ? report.byDay.map((row) => (
                      <tr key={row.day}>
                        <td>{formatDay(row.day)}</td>
                        <td>{row.receipts}</td>
                        <td>{formatMoney(row.total)}</td>
                        <td>{formatMoney(row.discount)}</td>
                        <td>{formatMoney(row.tax)}</td>
                      </tr>
                    )) : <tr><td colSpan={5} className="empty">No receipts in the selected range.</td></tr>}
                  </tbody>
                </>
              )}
              {tab === "cashier" && (
                <>
                  <thead><tr><th>Cashier</th><th>Receipts</th><th>Gross</th><th>Discount</th></tr></thead>
                  <tbody>
                    {report.byCashier.length ? report.byCashier.map((row) => (
                      <tr key={row.id}>
                        <td><span className="primary-cell">{row.cashier_name}</span></td>
                        <td>{row.receipts}</td>
                        <td>{formatMoney(row.total)}</td>
                        <td>{formatMoney(row.discount)}</td>
                      </tr>
                    )) : <tr><td colSpan={4} className="empty">No cashier activity in the selected range.</td></tr>}
                  </tbody>
                </>
              )}
              {tab === "product" && (
                <>
                  <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Gross</th><th>Discount</th></tr></thead>
                  <tbody>
                    {report.byProduct.length ? report.byProduct.map((row) => (
                      <tr key={`${row.product_name}:${row.sku || ""}`}>
                        <td><span className="primary-cell">{row.product_name}</span></td>
                        <td>{row.sku || "—"}</td>
                        <td>{formatQuantity(row.quantity)}</td>
                        <td>{formatMoney(row.total)}</td>
                        <td>{formatMoney(row.discount)}</td>
                      </tr>
                    )) : <tr><td colSpan={5} className="empty">No product sales in the selected range.</td></tr>}
                  </tbody>
                </>
              )}
              {tab === "payment" && (
                <>
                  <thead><tr><th>Method</th><th>Payments</th><th>Amount</th></tr></thead>
                  <tbody>
                    {report.byPayment.length ? report.byPayment.map((row) => (
                      <tr key={row.method}>
                        <td><span className="primary-cell">{labelize(row.method)}</span></td>
                        <td>{row.receipts}</td>
                        <td>{formatMoney(row.amount)}</td>
                      </tr>
                    )) : <tr><td colSpan={3} className="empty">No captured payments in the selected range.</td></tr>}
                  </tbody>
                </>
              )}
            </table>
          </section>

          <p className="list-limit-note">Read-only report generated {new Date(report.generatedAt).toLocaleString()} for {report.branchName}{report.truncated ? ". The period contains more rows than this report can load in one pass — narrow the date range for a complete total." : "."}</p>
        </>
      )}
    </div>
  );
}

export default SalesReportsWorkspace;
