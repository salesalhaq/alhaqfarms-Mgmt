"use client";

import {
  ArrowRight, BarChart3, ClipboardList, Factory, LoaderCircle, Package, Receipt,
  RefreshCw, RotateCcw, TrendingUp, Wallet,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatMoney } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface ReportLink {
  title: string;
  slug: string;
  description: string;
  icon: typeof BarChart3;
}

const REPORT_GROUPS: Array<{ title: string; detail: string; links: ReportLink[] }> = [
  {
    title: "Sales & POS",
    detail: "Receipts, refunds, margin, and the daily close.",
    links: [
      { title: "Daily report", slug: "daily-report", description: "Drawer, payments, sales, and refunds for a business day.", icon: BarChart3 },
      { title: "Sales reports", slug: "sales-reports", description: "Receipts by day, cashier, product, and payment method.", icon: BarChart3 },
      { title: "Profit & tax", slug: "profit-tax", description: "Sales margin, cost of goods, and tax for a period.", icon: TrendingUp },
      { title: "Return reports", slug: "return-reports", description: "Refunds, restocked items, and the reasons customers return.", icon: RotateCcw },
    ],
  },
  {
    title: "Stock",
    detail: "On-hand quantity, valuation, and replenishment.",
    links: [
      { title: "Stock reports", slug: "stock-reports", description: "On-hand quantity, valuation, and reorder alerts.", icon: Package },
    ],
  },
  {
    title: "Farm ERP",
    detail: "Production, wholesale, and farm ledgers.",
    links: [
      { title: "ERP reports", slug: "erp-reports", description: "Production, wholesale, expenses, and farm ledgers.", icon: Factory },
    ],
  },
  {
    title: "People & branch",
    detail: "Payroll, audit, expenses, and store-level reports.",
    links: [
      { title: "HR & payroll", slug: "hr-payroll", description: "Staff attendance, payroll periods, and payroll cost.", icon: Wallet },
      { title: "Audit log", slug: "audit-log", description: "Recorded actions with the actor and branch.", icon: ClipboardList },
      { title: "Store expenses", slug: "store-expenses", description: "Branch operating expenses by category.", icon: Receipt },
      { title: "Store reports", slug: "store-reports", description: "Branch sales, product mix, and payment summaries.", icon: BarChart3 },
    ],
  },
];

type SummaryType = "sales" | "returns" | "payments" | "tax";

interface SummaryRow {
  label: string;
  branch: string;
  valuePaisa: number;
  secondary: string;
  tone: "green" | "amber" | "blue" | "purple";
  reportType?: SummaryType;
}

interface SummaryReport {
  branchName: string;
  summary: {
    receiptCount: number;
    grossSalesPaisa: number;
    discountPaisa: number;
    taxPaisa: number;
    refundsPaisa: number;
    netSalesPaisa: number;
  };
  rows: SummaryRow[];
  truncated?: boolean;
  error?: string;
}

const SUMMARY_CHOICES: Array<{ id: SummaryType; title: string; description: string }> = [
  { id: "sales", title: "Sales summary", description: "Gross sales, refunds, net sales, receipts, and discounts." },
  { id: "returns", title: "Returns & refunds", description: "Completed refunds and their share of gross sales." },
  { id: "payments", title: "Payment mix", description: "Captured totals by payment method." },
  { id: "tax", title: "Tax & discounts", description: "Tax collected, average ticket, and discounts." },
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

export function ReportCenterWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [[defaultFrom, defaultTo]] = useState(defaultDateRange);
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [selectedReports, setSelectedReports] = useState<SummaryType[]>(SUMMARY_CHOICES.map((choice) => choice.id));
  const [summary, setSummary] = useState<SummaryReport | null>(null);
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

    const parameters = new URLSearchParams({ from: fromDate, to: toDate, report: "all" });
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/admin-reports?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const payload = await response.json() as SummaryReport;
        if (!active) return;
        if (!response.ok) throw new Error(payload.error || "Could not load the report summary.");
        setSummary(payload);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the report summary.");
        setSummary(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, fromDate, reloadKey, staff, toDate]);

  const cards = summary ? [
    { label: "Gross sales", value: formatMoney(summary.summary.grossSalesPaisa), note: `${summary.summary.receiptCount} receipts` },
    { label: "Refunds", value: formatMoney(summary.summary.refundsPaisa), note: "Completed returns" },
    { label: "Net sales", value: formatMoney(summary.summary.netSalesPaisa), note: `${formatMoney(summary.summary.discountPaisa)} discounts` },
    { label: "Tax collected", value: formatMoney(summary.summary.taxPaisa), note: "Across completed receipts" },
  ] : [];
  const selectedRows = summary?.rows.filter((row) => row.reportType && selectedReports.includes(row.reportType)) || [];
  const applyPreset = (days: number | "month") => {
    const end = new Date();
    const start = new Date(end);
    if (days === "month") start.setDate(1);
    else start.setDate(start.getDate() - days + 1);
    setFromDate(localDateKey(start));
    setToDate(localDateKey(end));
  };
  const toggleReport = (report: SummaryType) => {
    setSelectedReports((current) => current.includes(report)
      ? current.filter((entry) => entry !== report)
      : [...current, report]);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Open any report below to review the same operational ledgers used by the desktop app.</p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            {loading ? <><LoaderCircle className="spin" size={15} /> Loading…</> : <><RefreshCw size={15} /> Refresh</>}
          </button>
        </div>
      </div>

      <div className="daily-report-toolbar daily-report-no-print">
        {staff?.role === "admin" && (
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
        <div className="heading-actions" role="group" aria-label="Quick date ranges">
          <button className="button secondary" type="button" onClick={() => applyPreset(7)}>7 days</button>
          <button className="button secondary" type="button" onClick={() => applyPreset(30)}>30 days</button>
          <button className="button secondary" type="button" onClick={() => applyPreset("month")}>This month</button>
        </div>
      </div>

      {error && <div className="notice" role="alert">{error}</div>}

      {loading && !summary && <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading report summary…</div>}

      <section className="card panel" aria-label="Select report summaries">
        <div className="section-heading">
          <div><p className="eyebrow page">Report summaries</p><h2>Choose what to include</h2></div>
          <div className="heading-actions">
            <button className="button secondary" type="button" onClick={() => setSelectedReports(SUMMARY_CHOICES.map((choice) => choice.id))}>Select all</button>
            <button className="button secondary" type="button" onClick={() => setSelectedReports([])}>Clear</button>
          </div>
        </div>
        <div className="report-center-options">
          {SUMMARY_CHOICES.map((choice) => (
            <label className="report-center-option card" key={choice.id}>
              <input
                type="checkbox"
                checked={selectedReports.includes(choice.id)}
                onChange={() => toggleReport(choice.id)}
              />
              <span><strong>{choice.title}</strong><small>{choice.description}</small></span>
            </label>
          ))}
        </div>
      </section>

      {summary && (
        <section className="dashboard-stats" aria-label="Report center summary">
          {cards.map((card) => (
            <article className="dashboard-stat card" key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <small>{card.note}</small>
            </article>
          ))}
        </section>
      )}
      {summary?.truncated && (
        <div className="notice" role="status">
          The report reached its per-period record limit. Narrow the date range for complete totals.
        </div>
      )}

      {summary && (
        <section className="card table-wrap workspace-table" aria-label="Selected report summaries">
          <div className="table-document-heading">
            <strong>Selected summaries · {fromDate} to {toDate}</strong>
            <TableDocumentTools
              tableId="report-center-selected"
              title={`Report center ${summary.branchName}`}
              disabled={!selectedRows.length || loading}
            />
          </div>
          <table id="report-center-selected">
            <thead><tr><th>Report</th><th>Branch</th><th>Measure</th><th>Value</th><th>Notes</th></tr></thead>
            <tbody>
              {selectedRows.length ? selectedRows.map((row) => (
                <tr key={`${row.reportType}-${row.label}-${row.branch}`}>
                  <td>{SUMMARY_CHOICES.find((choice) => choice.id === row.reportType)?.title || row.reportType}</td>
                  <td>{row.branch}</td>
                  <td>{row.label}</td>
                  <td>{formatMoney(row.valuePaisa)}</td>
                  <td>{row.secondary}</td>
                </tr>
              )) : <tr><td colSpan={5} className="empty">Select at least one report summary to print or export.</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {REPORT_GROUPS.map((group) => (
        <section className="overview-workspace" key={group.title}>
          <div className="section-heading">
            <div><p className="eyebrow page">Reports</p><h2>{group.title}</h2></div>
            <span className="muted">{group.detail}</span>
          </div>
          <div className="overview-action-grid">
            {group.links.map(({ title, slug, description, icon: Icon }) => (
              <Link className="overview-action-card card" href={`/workspace/${slug}`} key={slug}>
                <span className="shortcut-icon"><Icon size={18} /></span>
                <span className="shortcut-copy"><strong>{title}</strong><small>{description}</small></span>
                <span className="report-card-open">Full report <ArrowRight size={14} className="shortcut-arrow" /></span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      <p className="list-limit-note">
        Reports are read-only and follow your signed-in branch access. Document export controls are available inside each report.
      </p>
    </>
  );
}

export default ReportCenterWorkspace;
