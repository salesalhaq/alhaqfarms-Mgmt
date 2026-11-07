"use client";

import { AlertCircle, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface ReturnRow {
  id: string;
  return_number: string;
  branch_id: string;
  branch_name: string;
  sale_id: string;
  receipt_number: string;
  customer_name: string;
  status: string;
  reason: string | null;
  refund_total_paisa: number;
  restock_total_milli: number;
  created_by: string;
  created_by_name: string;
  created_at: string;
  completed_at: string | null;
}

interface ReturnReason {
  reason: string;
  count: number;
  refundPaisa: number;
  restockMilli: number;
}

interface ReturnReportResponse {
  from: string;
  to: string;
  branchId: string | null;
  branchName: string;
  rows: ReturnRow[];
  reasons: ReturnReason[];
  totals: {
    returns: number;
    pending: number;
    completed: number;
    refundPaisa: number;
    restockMilli: number;
  };
  capped?: boolean;
  generatedAt: string;
  error?: string;
}

const STATUS_OPTIONS = ["pending", "approved", "completed", "rejected", "cancelled"];

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

export function ReturnReportsWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [[defaultFrom, defaultTo]] = useState(defaultDateRange);
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [report, setReport] = useState<ReturnReportResponse | null>(null);
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
    if (status && status !== "all") parameters.set("status", status);
    if (search.trim()) parameters.set("search", search.trim());

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/workspace/return-reports?${parameters.toString()}`, {
            cache: "no-store",
            credentials: "same-origin",
          });
          const payload = await response.json() as ReturnReportResponse;
          if (!active) return;
          if (!response.ok) throw new Error(payload.error || "Could not load the return report.");
          setReport(payload);
        } catch (loadError) {
          if (!active) return;
          setError(loadError instanceof Error ? loadError.message : "Could not load the return report.");
          setReport(null);
        } finally {
          if (active) setLoading(false);
        }
      })();
    }, search.trim() ? 220 : 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [branchId, fromDate, reloadKey, search, staff, status, toDate]);

  const metrics = report ? [
    { label: "Returns", value: report.totals.returns.toLocaleString(), note: `${report.totals.completed} completed` },
    { label: "Refunded", value: formatMoney(report.totals.refundPaisa), note: "Completed + approved refunds" },
    { label: "Restocked", value: formatQuantity(report.totals.restockMilli), note: "Units back on the shelf" },
    { label: "Awaiting approval", value: report.totals.pending.toLocaleString(), note: report.totals.pending ? "Manager action needed" : "Nothing pending" },
  ] : [];

  return (
    <div className="daily-report-print">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Refunds are counted on the day a return completes, so this report matches the cash drawer and daily close.</p>
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
        <label className="toolbar-control">
          <span>Status</span>
          <select className="toolbar-select" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            {STATUS_OPTIONS.map((option) => <option key={option} value={option}>{labelize(option)}</option>)}
          </select>
        </label>
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="Search returns"
            placeholder="Search return, receipt or customer"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
          {loading ? <><LoaderCircle className="spin" size={14} /> Loading…</> : <><RefreshCw size={14} /> Refresh</>}
        </button>
      </div>

      {error && (
        <div className="card panel" role="alert">
          <div className="inline-message error"><AlertCircle size={16} /><span>{error}</span></div>
        </div>
      )}

      {loading && <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading return activity…</div>}

      {!loading && report && (
        <>
          <section className="dashboard-stats" aria-label="Return report summary">
            {metrics.map((metric) => (
              <article className="dashboard-stat card" key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.note}</small>
              </article>
            ))}
          </section>

          <section className="card table-wrap workspace-table" aria-label="Returns by reason">
            <div className="table-document-heading">
              <strong>Top reasons · {report.branchName}</strong>
              <TableDocumentTools
                tableId="return-reports-reasons"
                title={`${item.title} · reasons · ${report.branchName}`}
                disabled={!report.reasons.length}
              />
            </div>
            <table id="return-reports-reasons">
              <thead><tr><th>Reason</th><th>Returns</th><th>Refunded</th><th>Restocked</th></tr></thead>
              <tbody>
                {report.reasons.length ? report.reasons.map((row) => (
                  <tr key={row.reason}>
                    <td><span className="primary-cell">{row.reason}</span></td>
                    <td>{row.count}</td>
                    <td>{formatMoney(row.refundPaisa)}</td>
                    <td>{formatQuantity(row.restockMilli)}</td>
                  </tr>
                )) : <tr><td colSpan={4} className="empty">No returns in this range.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="card table-wrap workspace-table" aria-label="Return ledger">
            <div className="table-document-heading">
              <strong>Return ledger · {report.from} to {report.to}</strong>
              <TableDocumentTools
                tableId="return-reports-ledger"
                title={`${item.title} · ledger · ${report.branchName}`}
                disabled={!report.rows.length}
              />
            </div>
            <table id="return-reports-ledger">
              <thead>
                <tr>
                  <th>Return</th><th>Receipt</th><th>Customer</th><th>Reason</th>
                  <th>Status</th><th>Refund</th><th>Restocked</th><th>Created</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length ? report.rows.map((row) => (
                  <tr key={row.id}>
                    <td><span className="primary-cell">{row.return_number}</span><small className="sales-cell-subtext">{row.branch_name}</small></td>
                    <td>{row.receipt_number}</td>
                    <td>{row.customer_name}</td>
                    <td>{row.reason || "—"}</td>
                    <td><span className={`status ${statusTone(row.status)}`}>{labelize(row.status)}</span></td>
                    <td className="nowrap">{formatMoney(row.refund_total_paisa)}</td>
                    <td className="nowrap">{formatQuantity(row.restock_total_milli)}</td>
                    <td className="nowrap">{formatDateTime(row.created_at)}</td>
                  </tr>
                )) : <tr><td colSpan={8} className="empty">No returns in this range.</td></tr>}
              </tbody>
            </table>
          </section>

          <p className="list-limit-note">
            Showing {report.rows.length} return{report.rows.length === 1 ? "" : "s"} · read-only · generated {new Date(report.generatedAt).toLocaleString()}.
            {report.capped ? " This range contains more returns than one pass can load — narrow the dates for a complete total." : ""}
          </p>
        </>
      )}
    </div>
  );
}

export default ReturnReportsWorkspace;
