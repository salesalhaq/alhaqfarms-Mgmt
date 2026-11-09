"use client";

import { AlertCircle, LoaderCircle, Search, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";

interface AuditBranch {
  id: string;
  name: string;
  code?: string | null;
}

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_name: string;
  actor_role: string;
  branch_id: string;
  branch_name: string;
  action: string;
  record: string;
  summary: string;
  source: string;
}

interface AuditResponse {
  rows?: AuditRow[];
  actions?: string[];
  branches?: AuditBranch[];
  error?: string;
}

function toIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultRange(): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return [toIsoDate(from), toIsoDate(to)];
}

function formatAuditTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatActionLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function AdminAuditWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [fromDate, setFromDate] = useState(defaultRange()[0]);
  const [toDate, setToDate] = useState(defaultRange()[1]);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [actionFilter, setActionFilter] = useState("all");
  const [actorSearch, setActorSearch] = useState("");
  const [debouncedActor, setDebouncedActor] = useState("");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [availableActions, setAvailableActions] = useState<string[]>([]);
  const [availableBranches, setAvailableBranches] = useState<AuditBranch[]>(branches);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  useEffect(() => {
    if (!staff) return;
    if (staff.role === "admin") {
      setBranchId((current) => (current && current !== "all" ? current : "all"));
    } else if (staff.branch_id) {
      setBranchId((current) => {
        if (current && current !== staff.branch_id) return current;
        return staff.branch_id || "";
      });
    } else {
      setBranchId("");
    }
  }, [staff]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedActor(actorSearch.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [actorSearch]);

  useEffect(() => {
    setPage(0);
  }, [actionFilter, branchId, debouncedActor, fromDate, toDate]);

  useEffect(() => {
    if (!staff) {
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams({
      from: fromDate,
      to: toDate,
    });

    if (branchId && branchId !== "all") parameters.set("branchId", branchId);
    else if (staff.role === "admin" && branchId === "all") parameters.set("branchId", "all");
    if (actionFilter && actionFilter !== "all") parameters.set("action", actionFilter);
    if (debouncedActor) parameters.set("actor", debouncedActor);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/admin-audit?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as AuditResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load the audit log.");
        setRows(result.rows || []);
        setAvailableActions(result.actions || []);
        setAvailableBranches(result.branches || branches);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the audit log.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [actionFilter, branchId, branches, debouncedActor, fromDate, staff, toDate]);

  const clearFilters = () => {
    const [defaultFrom, defaultTo] = defaultRange();
    setFromDate(defaultFrom);
    setToDate(defaultTo);
    setActionFilter("all");
    setActorSearch("");
    setDebouncedActor("");
    setBranchId(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  };

  const canSelectBranch = staff?.role === "admin";
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRows = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} This workspace is read-only and respects the currently signed-in staff account's branch and role access.</p>
        </div>
      </div>

      <div className="live-readonly-note">
        <ShieldAlert size={16} />
        <span>Read-only audit stream · record replay and editing remain disabled until a secure approval workflow is available.</span>
      </div>

      <HorizontalFilterScroller className="audit-filterbar" ariaLabel="Audit log filters">
        <label className="toolbar-control audit-date-filter">
          <span>From</span>
          <input className="workspace-date-input" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} aria-label="Audit from date" />
        </label>
        <label className="toolbar-control audit-date-filter">
          <span>To</span>
          <input className="workspace-date-input" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} aria-label="Audit to date" />
        </label>
        {canSelectBranch && (
          <label className="toolbar-control" style={{ flex: "0 0 190px" }}>
            <span>Branch</span>
            <SearchableFilter
              value={branchId}
              ariaLabel="Filter audit log by branch"
              placeholder="All accessible branches"
              options={[
                { value: "all", label: "All accessible branches" },
                ...availableBranches.map((branch) => ({ value: branch.id, label: branch.name })),
              ]}
              onChange={setBranchId}
            />
          </label>
        )}
        <label className="toolbar-control" style={{ flex: "0 0 180px" }}>
          <span>Action</span>
          <SearchableFilter
            value={actionFilter}
            ariaLabel="Filter audit log by action"
            placeholder="All actions"
            options={[
              { value: "all", label: "All actions" },
              ...availableActions.map((action) => ({ value: action, label: formatActionLabel(action) })),
            ]}
            onChange={setActionFilter}
          />
        </label>
        <label className="search-field audit-search">
          <Search size={16} aria-hidden="true" />
          <input
            value={actorSearch}
            onChange={(event) => setActorSearch(event.target.value)}
            placeholder="Search actor"
            aria-label="Search by actor"
          />
        </label>
        <button className="button secondary" type="button" onClick={clearFilters}>Clear</button>
      </HorizontalFilterScroller>

      {error && <div className="notice" role="alert">{error}</div>}

      <section className="card table-wrap workspace-table" aria-label="Audit log table">
        <div className="table-document-heading">
          <strong>{item.title}</strong>
          <TableDocumentTools tableId="audit-log-table" title={item.title} disabled={loading || Boolean(error) || !rows.length} />
        </div>

        {loading ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading audit log…</div>
        ) : !error && rows.length === 0 ? (
          <div className="empty">
            <Search size={23} />
            <h2>No audit events found</h2>
            <p>Try different filters or check the selected date range.</p>
          </div>
        ) : !error ? (
          <table id="audit-log-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Actor</th>
                <th>Branch</th>
                <th>Action</th>
                <th>Record</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id}>
                  <td>{formatAuditTime(row.occurred_at)}</td>
                  <td>
                    <div>{row.actor_name}</div>
                    <small>{row.actor_role}</small>
                  </td>
                  <td>{row.branch_name}</td>
                  <td>{formatActionLabel(row.action)}</td>
                  <td>{row.record}</td>
                  <td>{row.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <div className="workspace-toolbar" style={{ justifyContent: "space-between" }}>
        <span className="list-limit-note">{rows.length.toLocaleString()} events</span>
        <div className="heading-actions">
          <span className="list-limit-note">Page {currentPage + 1} of {pageCount}</span>
          <button type="button" className="secondary-button" disabled={currentPage === 0} onClick={() => setPage(Math.max(0, currentPage - 1))}>Previous</button>
          <button type="button" className="secondary-button" disabled={currentPage >= pageCount - 1} onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}>Next</button>
        </div>
      </div>

      {!loading && !error && (
        <p className="list-limit-note">Showing {rows.length} audit records for the selected scope.</p>
      )}
    </>
  );
}

export default AdminAuditWorkspace;
