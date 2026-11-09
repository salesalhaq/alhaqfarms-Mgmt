"use client";

import {
  AlertCircle,
  BarChart3,
  Calculator,
  Download,
  LoaderCircle,
  Percent,
  RefreshCw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { TableControls } from "@/components/workspace/TableControls";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { formatMoney, formatQuantity } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface ProfitReport {
  from: string;
  to: string;
  branchId: string | null;
  branchName: string;
  summary: {
    receipts: number;
    revenuePaisa: number;
    taxPaisa: number;
    discountPaisa: number;
    refundPaisa: number;
    refundTaxPaisa: number;
    refunds: number;
    netSalesPaisa: number;
    costPaisa: number;
    profitPaisa: number;
    marginBps: number;
  };
  byDay: Array<{
    day: string;
    receipts: number;
    refundPaisa: number;
    netSalesPaisa: number;
    taxPaisa: number;
    costPaisa: number;
    profitPaisa: number;
    marginBps: number;
  }>;
  byProduct: Array<{
    product_name: string;
    sku: string | null;
    quantity: number;
    netSalesPaisa: number;
    taxPaisa: number;
    costPaisa: number;
    profitPaisa: number;
    marginBps: number;
  }>;
  byTaxRate: Array<{
    rate_bps: number;
    lines: number;
    netSalesPaisa: number;
    taxPaisa: number;
  }>;
  truncated?: boolean;
  error?: string;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultDateRange(): [string, string] {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth(), 1);
  return [localDateKey(from), localDateKey(to)];
}

function percentFromBps(bps: number): string {
  return `${(Number(bps) / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

function marginText(bps: number): string {
  return `${(Number(bps) / 100).toFixed(1)}%`;
}

function formatDay(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-PK", { dateStyle: "medium" }).format(date);
}

export function AdminFinanceWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [[defaultFrom, defaultTo]] = useState(defaultDateRange);
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [report, setReport] = useState<ProfitReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
        const response = await fetch(`/api/workspace/admin-finance?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const payload = await response.json() as ProfitReport;
        if (!active) return;
        if (!response.ok) throw new Error(payload.error || "Could not load the profit and tax report.");
        setReport(payload);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the profit and tax report.");
        setReport(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, fromDate, reloadKey, staff, toDate]);

  const summary = report?.summary;

  const metrics = summary ? [
    {
      label: "Net sales",
      value: formatMoney(summary.netSalesPaisa),
      note: `${summary.receipts} receipt${summary.receipts === 1 ? "" : "s"} · tax excluded`,
      icon: Wallet,
    },
    {
      label: "Cost of goods",
      value: formatMoney(summary.costPaisa),
      note: "Cost captured on the sale lines",
      icon: Calculator,
    },
    {
      label: "Gross profit",
      value: formatMoney(summary.profitPaisa),
      note: `${marginText(summary.marginBps)} margin`,
      icon: TrendingUp,
    },
    {
      label: "Output tax",
      value: formatMoney(summary.taxPaisa),
      note: `${formatMoney(summary.discountPaisa)} discounts`,
      icon: Percent,
    },
    {
      label: "Refunds",
      value: formatMoney(summary.refundPaisa),
      note: `${summary.refunds} return${summary.refunds === 1 ? "" : "s"} in range`,
      icon: BarChart3,
    },
  ] : [];

  const exportCsv = () => {
    if (!report) return;
    const header = ["Day", "Receipts", "Refunds", "Net sales", "Tax", "Cost", "Gross profit", "Margin %"];
    const lines = report.byDay.map((row) => [
      row.day,
      String(row.receipts),
      (row.refundPaisa / 100).toFixed(2),
      (row.netSalesPaisa / 100).toFixed(2),
      (row.taxPaisa / 100).toFixed(2),
      (row.costPaisa / 100).toFixed(2),
      (row.profitPaisa / 100).toFixed(2),
      (row.marginBps / 100).toFixed(2),
    ]);
    const csv = [header, ...lines]
      .map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `profit-tax-${report.from}-to-${report.to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const chartDays = useMemo(() => (report ? report.byDay.slice(0, 14).reverse() : []), [report]);  const maxProfit = useMemo(
    () => Math.max(1, ...chartDays.map((row) => Math.max(row.profitPaisa, 0))),
    [chartDays],
  );
  const topProducts = useMemo(() => (report ? report.byProduct.slice(0, 6) : []), [report]);

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>
            {item.description} Gross profit, cost of goods and output tax for this branch. Net sales exclude tax and
            completed refunds; cost follows the cost captured on each sale line.
          </p>
        </div>
        <HorizontalFilterScroller className="finance-filterbar" ariaLabel="Profit and tax report filters">
          {staff?.role === "admin" && (
            <label className="toolbar-control" style={{ flex: "0 0 220px" }}>
              <span>Branch</span>
              <SearchableFilter
                value={branchId || "all"}
                ariaLabel="Filter profit and tax report by branch"
                placeholder="All accessible branches"
                options={[
                  { value: "all", label: "All accessible branches" },
                  ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
                ]}
                onChange={setBranchId}
              />
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
          <button className="button secondary" type="button" onClick={exportCsv} disabled={!report?.byDay.length}>
            <Download size={14} /> Export CSV
          </button>
        </HorizontalFilterScroller>
      </div>

      {error && <div className="notice" role="alert"><AlertCircle size={15} /> {error}</div>}

      {loading && !report && (
        <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading the sales ledger…</div>
      )}

      {report && summary && (
        <>
          <section className="dashboard-stats" aria-label="Profit and tax summary">
            {metrics.map(({ icon: Icon, label, value, note }) => (
              <article className="dashboard-stat card" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small><Icon size={13} aria-hidden="true" /> {note}</small>
              </article>
            ))}
          </section>

          <div className="dashboard-grid">
            <section className="card dashboard-panel" aria-label="Profit by day">
              <div className="section-heading">
                <div><p className="eyebrow page">Trend</p><h2>Profit by day</h2></div>
                <BarChart3 size={19} aria-hidden="true" />
              </div>
              {chartDays.length ? (
                <div className="chart-bars" role="img" aria-label="Daily gross profit during the selected reporting period">
                  {chartDays.map((row) => (
                    <div
                      className="chart-bar-column"
                      key={row.day}
                      title={`${row.day}: gross profit ${formatMoney(row.profitPaisa)} · cost ${formatMoney(row.costPaisa)}`}
                    >
                      <span className="chart-bar-value">{row.profitPaisa ? "•" : ""}</span>
                      <div className="chart-bar-track">
                        <span style={{ height: `${Math.max(row.profitPaisa > 0 ? 8 : 0, (Math.max(row.profitPaisa, 0) / maxProfit) * 100)}%` }} />
                      </div>
                      <small>{formatDay(row.day).replace(/,? \d{4}$/, "")}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="dashboard-empty">No sales match this range.</div>
              )}
              <p className="dashboard-period-note">Hover a bar for the gross profit and cost of goods on that day.</p>
            </section>

            <section className="card dashboard-panel" aria-label="Top products by profit">
              <div className="section-heading">
                <div><p className="eyebrow page">Products</p><h2>Top products by profit</h2></div>
                <TrendingUp size={19} aria-hidden="true" />
              </div>
              {topProducts.length ? (
                <div className="dashboard-alert-list">
                  {topProducts.map((row) => (
                    <div className="dashboard-alert-row" key={`${row.product_name}:${row.sku || ""}`}>
                      <span>
                        <strong>{row.product_name}</strong>
                        <small>{row.sku || "No SKU"} · {marginText(row.marginBps)} margin</small>
                      </span>
                      <span className="dashboard-alert-total">{formatMoney(row.profitPaisa)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="dashboard-empty">No product sales in this range.</div>
              )}
            </section>
          </div>

          {report.byDay.length > 0 && <TableControls tableId="profit-tax-by-day" ariaLabel="Daily profit and tax report" />}
          <section className="card table-wrap workspace-table" aria-label="Profit and tax day by day">
            <div className="table-document-heading">
              <strong>Day by day · {report.from} to {report.to} · {report.branchName}</strong>
              <TableDocumentTools
                tableId="profit-tax-by-day"
                title={`Profit & tax · ${report.branchName}`}
                disabled={!report.byDay.length}
              />
            </div>
            <table id="profit-tax-by-day">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Receipts</th>
                  <th>Net sales</th>
                  <th>Tax</th>
                  <th>Cost</th>
                  <th>Gross profit</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {report.byDay.length ? report.byDay.map((row) => (
                  <tr key={row.day}>
                    <td>
                      <strong>{row.day}</strong>
                      {row.refundPaisa > 0 && <small className="secondary-cell">after {formatMoney(row.refundPaisa)} refunds</small>}
                    </td>
                    <td>{row.receipts}</td>
                    <td>{formatMoney(row.netSalesPaisa)}</td>
                    <td>{formatMoney(row.taxPaisa)}</td>
                    <td>{formatMoney(row.costPaisa)}</td>
                    <td><strong>{formatMoney(row.profitPaisa)}</strong></td>
                    <td>{marginText(row.marginBps)}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={7} className="empty">No sales match this range.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <div className="dashboard-grid">
            <div className="dashboard-table-item">
              {report.byTaxRate.length > 0 && <TableControls tableId="profit-tax-by-rate" ariaLabel="Tax by rate report" filterColumns={[{ column: "Rate" }]} />}
              <section className="card dashboard-panel" aria-label="Tax by rate">
              <div className="section-heading">
                <div><p className="eyebrow page">Tax</p><h2>Tax by rate</h2></div>
                <Percent size={19} aria-hidden="true" />
              </div>
              <div className="table-wrap">
                <table id="profit-tax-by-rate">
                  <thead><tr><th>Rate</th><th>Lines</th><th>Net sales</th><th>Tax</th></tr></thead>
                  <tbody>
                    {report.byTaxRate.length ? report.byTaxRate.map((row) => (
                      <tr key={row.rate_bps}>
                        <td><strong>{percentFromBps(row.rate_bps)}</strong></td>
                        <td>{row.lines}</td>
                        <td>{formatMoney(row.netSalesPaisa)}</td>
                        <td>{formatMoney(row.taxPaisa)}</td>
                      </tr>
                    )) : <tr><td colSpan={4} className="empty">No taxable sales in this range.</td></tr>}
                  </tbody>
                </table>
              </div>
              </section>
            </div>

            <div className="dashboard-table-item">
              {report.byProduct.length > 0 && <TableControls tableId="profit-tax-by-product" ariaLabel="Product profit detail" filterColumns={[{ column: "Product" }]} />}
              <section className="card dashboard-panel" aria-label="Top products by profit detail">
              <div className="section-heading">
                <div><p className="eyebrow page">Products</p><h2>Product profit detail</h2></div>
                <BarChart3 size={19} aria-hidden="true" />
              </div>
              <div className="table-wrap">
                <table id="profit-tax-by-product">
                  <thead><tr><th>Product</th><th>Quantity</th><th>Net sales</th><th>Profit</th></tr></thead>
                  <tbody>
                    {report.byProduct.length ? report.byProduct.slice(0, 10).map((row) => (
                      <tr key={`${row.product_name}:${row.sku || ""}`}>
                        <td>
                          <strong>{row.product_name}</strong>
                          {row.sku && <small className="secondary-cell">{row.sku}</small>}
                        </td>
                        <td>{formatQuantity(row.quantity)}</td>
                        <td>{formatMoney(row.netSalesPaisa)}</td>
                        <td>
                          <strong>{formatMoney(row.profitPaisa)}</strong>
                          <small className="secondary-cell">{marginText(row.marginBps)}</small>
                        </td>
                      </tr>
                    )) : <tr><td colSpan={4} className="empty">No product sales in this range.</td></tr>}
                  </tbody>
                </table>
              </div>
              </section>
            </div>
          </div>

          <p className="list-limit-note">
            Net sales subtract output tax and completed refunds. Refunded cost is added back only for returned lines that
            were restocked. Figures are derived from the immutable sale, return and cost snapshots, so a later cost or
            price change never rewrites history.
            {report.truncated
              ? " The selected period is very busy, so this report is capped — narrow the date range for a complete total."
              : ""}
          </p>
        </>
      )}
    </>
  );
}

export default AdminFinanceWorkspace;
