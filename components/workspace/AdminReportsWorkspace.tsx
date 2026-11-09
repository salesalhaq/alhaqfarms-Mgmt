"use client";

import { AlertCircle, BarChart3, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { TableControls } from "@/components/workspace/TableControls";
import { formatMoney } from "@/lib/format";

type ReportType = "sales" | "returns" | "payments" | "tax";

interface AdminReportsSummary {
  grossSalesPaisa: number;
  refundsPaisa: number;
  netSalesPaisa: number;
  receiptCount: number;
  averageTicketPaisa: number;
  discountPaisa: number;
  taxPaisa: number;
}

interface AdminReportRow {
  label: string;
  branch: string;
  valuePaisa: number;
  secondary: string;
  tone: "green" | "amber" | "blue" | "purple";
}

interface AdminReportsResponse {
  branchId: string | null;
  branchName: string;
  report: string;
  generatedAt: string;
  summary: AdminReportsSummary;
  rows: AdminReportRow[];
  error?: string;
}

interface PageItem {
  section: string;
  title: string;
  description: string;
}

const reportOptions: Array<{ value: ReportType; label: string }>
  = [
    { value: "sales", label: "Sales summary" },
    { value: "returns", label: "Returns & refunds" },
    { value: "payments", label: "Payment mix" },
    { value: "tax", label: "Tax & margin" },
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
  from.setDate(from.getDate() - 29);
  return [localDateKey(from), localDateKey(to)];
}

export function AdminReportsWorkspace({
  item,
  defaultReport = "sales",
  reports,
}: {
  item: PageItem;
  defaultReport?: ReportType;
  reports?: ReportType[];
}) {
  const { staff, branches } = useStaffAuth();
  const reportChoices = reportOptions.filter((option) => !reports || reports.includes(option.value));
  const [reportType, setReportType] = useState<ReportType>(defaultReport);
  const [fromDate, setFromDate] = useState(defaultDateRange()[0]);
  const [toDate, setToDate] = useState(defaultDateRange()[1]);
  const [branchId, setBranchId] = useState<string>(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [report, setReport] = useState<AdminReportsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isAdmin = staff?.role === "admin";
  const selectedBranchName = useMemo(() => {
    if (!staff) return "Your branch";
    if (branchId === "all") return "All accessible branches";
    return branches.find((branch) => branch.id === branchId)?.name || "Your branch";
  }, [branchId, branches, staff]);

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

    const parameters = new URLSearchParams({
      report: reportType,
      from: fromDate,
      to: toDate,
    });
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/admin-reports?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const payload = await response.json() as AdminReportsResponse;
        if (!active) return;
        if (!response.ok) throw new Error(payload.error || "Could not load the admin reports.");
        setReport(payload);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the admin reports.");
        setReport(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [branchId, fromDate, reportType, reloadKey, staff, toDate]);

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
      label: "Tax collected",
      value: formatMoney(report.summary.taxPaisa),
      note: `Avg ticket ${formatMoney(report.summary.averageTicketPaisa)}`,
      tone: "purple",
    },
  ] : [];

  return (
    <div className="daily-report-print">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} This workspace stays read-only and only reads data scoped to your signed-in branch permissions.</p>
        </div>
        <button className="button" type="button" disabled title="Report export is disabled until a secure server-side generation workflow is enabled.">
          <BarChart3 size={15} /> Generate report
        </button>
      </div>

      <div className="daily-report-toolbar daily-report-no-print">
        {reportChoices.length > 1 && (
          <label className="toolbar-control">
            <span>Report</span>
            <select className="toolbar-select" value={reportType} onChange={(event) => setReportType(event.target.value as ReportType)}>
              {reportChoices.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}

        {isAdmin && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select className="toolbar-select" value={branchId || "all"} onChange={(event) => setBranchId(event.target.value)}>
              <option value="all">All accessible branches</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
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
            <h2>Loading admin report</h2>
            <p>Confirming report scope and branch permissions.</p>
          </div>
        </div>
      )}

      {!loading && report && (
        <>
          <div className="daily-report-metrics">
            {summaryCards.map((card) => (
              <div className={`metric-card ${card.tone}`} key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.note}</small>
              </div>
            ))}
          </div>

          {report.rows.length > 0 && (
            <TableControls
              tableId="admin-reports-table"
              ariaLabel="Admin report rows"
              filterColumns={[{ column: "Branch" }, { column: "Measure" }]}
            />
          )}
          <section className="daily-report-panel card">
            <div className="daily-report-panel-heading">
              <h2>{reportOptions.find((option) => option.value === reportType)?.label ?? "Report"} · {selectedBranchName}</h2>
              <TableDocumentTools tableId="admin-reports-table" title={`${item.title} · ${selectedBranchName}`} disabled />
            </div>

            <div className="table-wrap">
              <table id="admin-reports-table">
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>Measure</th>
                    <th>Value</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.length ? report.rows.map((row) => (
                    <tr key={`${row.label}-${row.branch}`}>
                      <td>{row.branch}</td>
                      <td>{row.label}</td>
                      <td>{formatMoney(row.valuePaisa)}</td>
                      <td>{row.secondary}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={4} className="empty">No rows for the selected filters.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
