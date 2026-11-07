"use client";

import {
  AlertCircle, ArrowRight, ChevronLeft, ChevronRight, Eye, LoaderCircle, RefreshCw, Search, X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatDateTime, formatQuantity, labelize } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface TransferRow {
  id: string;
  transfer_number: string;
  from_branch_id: string;
  from_branch_name: string;
  to_branch_id: string;
  to_branch_name: string;
  status: string;
  created_at: string;
  item_count: number;
  quantity_milli: number;
}

interface TransferItem {
  id: string;
  product_name: string;
  unit_code: string;
  quantity_milli: number;
  received_quantity_milli: number;
  unit_cost_paisa: number;
}

interface TransferDetails {
  transfer: TransferRow & {
    notes: string | null;
    dispatched_at: string | null;
    received_at: string | null;
    cancelled_at: string | null;
  };
  items: TransferItem[];
}

interface TransfersResponse {
  rows?: TransferRow[];
  total?: number;
  page?: number;
  pageSize?: number;
  transfer?: TransferDetails["transfer"];
  items?: TransferItem[];
  error?: string;
}

const PAGE_SIZE = 25;
const TRANSFER_STATUSES = ["all", "draft", "dispatched", "received", "cancelled"] as const;
const DIRECTIONS = ["all", "incoming", "outgoing"] as const;

function localDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initialDateRange(): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return [localDateInput(from), localDateInput(to)];
}

function statusTone(status: string): string {
  if (status === "draft") return "amber";
  if (status === "dispatched") return "blue";
  if (status === "received") return "green";
  if (status === "cancelled") return "red";
  return "";
}

export function TransfersWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [defaultFrom, defaultTo] = initialDateRange();
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const isHqAdmin = staff?.role === "admin" && !staff.branch_id;
  const [branchId, setBranchId] = useState(isHqAdmin ? "all" : staff?.branch_id || "");
  const [status, setStatus] = useState<(typeof TRANSFER_STATUSES)[number]>("all");
  const [direction, setDirection] = useState<(typeof DIRECTIONS)[number]>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTransferId, setSelectedTransferId] = useState("");
  const [details, setDetails] = useState<TransferDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isAdmin = staff?.role === "admin";

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!staff) {
      setLoading(false);
      return undefined;
    }
    if (!branchId) {
      setBranchId(isHqAdmin ? "all" : staff.branch_id || "");
      return undefined;
    }

    let active = true;
    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams({
      from: fromDate,
      to: toDate,
      status,
      direction,
      branchId,
      page: String(page),
    });
    if (debouncedSearch) parameters.set("search", debouncedSearch);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/transfers?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as TransfersResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load transfers.");
        setRows(result.rows || []);
        setTotal(result.total || 0);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load transfers.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, debouncedSearch, direction, fromDate, isHqAdmin, page, reloadKey, staff, status, toDate]);

  useEffect(() => {
    if (!selectedTransferId) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedTransferId("");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedTransferId]);

  const updateFilter = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setPage(1);
  };

  const clearFilters = () => {
    const [from, to] = initialDateRange();
    setFromDate(from);
    setToDate(to);
    setBranchId(isHqAdmin ? "all" : staff?.branch_id || "");
    setStatus("all");
    setDirection("all");
    setSearch("");
    setPage(1);
  };

  const openDetails = async (transferId: string) => {
    setSelectedTransferId(transferId);
    setDetails(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/workspace/transfers?detailId=${encodeURIComponent(transferId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as TransfersResponse;
      if (!response.ok || !result.transfer) throw new Error(result.error || "Could not load transfer details.");
      setDetails({ transfer: result.transfer, items: result.items || [] });
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "Could not load transfer details.");
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>Stock transfers</h1>
          <p>Track stock moving between branches from draft through dispatch and receipt.</p>
        </div>
        <button
          className="button"
          disabled
          title="Drafting and dispatching transfers require the secure transaction workflow. Use the Windows app."
          type="button"
        >
          New transfer
        </button>
      </div>

      <div className="live-readonly-note">
        <AlertCircle size={16} />
        <span>Live cloud records · read-only. Draft, dispatch, receive, and cancel actions are disabled here; use the Windows app to manage stock movement.</span>
      </div>

      <div className="dashboard-stats" aria-label="Transfer summary">
        <div className="dashboard-stat card"><span>Drafts</span><strong>{rows.filter((row) => row.status === "draft").length}</strong><small>Not dispatched yet</small></div>
        <div className="dashboard-stat card"><span>In transit</span><strong>{rows.filter((row) => row.status === "dispatched").length}</strong><small>Waiting at destination</small></div>
        <div className="dashboard-stat card"><span>Received</span><strong>{rows.filter((row) => row.status === "received").length}</strong><small>In these results</small></div>
        <div className="dashboard-stat card"><span>Branches</span><strong>{branches.filter((branch) => branch.is_active).length}</strong><small>Active destinations</small></div>
      </div>

      <section className="returns-history-filters card" aria-label="Transfer filters">
        <label className="search-field returns-history-search">
          <Search size={16} />
          <input
            aria-label="Search transfer number"
            placeholder="Search transfer number"
            value={search}
            onChange={(event) => updateFilter(setSearch, event.target.value)}
          />
        </label>
        <label className="returns-history-control">
          <span>From</span>
          <input type="date" aria-label="Transfers from date" value={fromDate} max={toDate || undefined} onChange={(event) => updateFilter(setFromDate, event.target.value)} />
        </label>
        <label className="returns-history-control">
          <span>To</span>
          <input type="date" aria-label="Transfers to date" value={toDate} min={fromDate || undefined} onChange={(event) => updateFilter(setToDate, event.target.value)} />
        </label>
        <label className="returns-history-control">
          <span>Status</span>
          <select value={status} onChange={(event) => updateFilter(setStatus, event.target.value as (typeof TRANSFER_STATUSES)[number])}>
            {TRANSFER_STATUSES.map((value) => <option key={value} value={value}>{value === "all" ? "All statuses" : labelize(value)}</option>)}
          </select>
        </label>
        <label className="returns-history-control">
          <span>Direction</span>
          <select value={direction} onChange={(event) => updateFilter(setDirection, event.target.value as (typeof DIRECTIONS)[number])}>
            {DIRECTIONS.map((value) => <option key={value} value={value}>{value === "all" ? "All transfers" : labelize(value)}</option>)}
          </select>
        </label>
        {isAdmin && (
          <label className="returns-history-control">
            <span>Branch</span>
            <select value={branchId} onChange={(event) => updateFilter(setBranchId, event.target.value)}>
              {isHqAdmin && <option value="all">All branches</option>}
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
        <div className="returns-history-actions">
          <button className="button secondary" disabled={loading} onClick={() => setReloadKey((value) => value + 1)} type="button">
            {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={14} />} Refresh
          </button>
          <button className="button link" onClick={clearFilters} type="button">Clear filters</button>
        </div>
      </section>

      {error && <div className="notice" role="alert">{error}</div>}
      <section className="card table-wrap workspace-table returns-history-table" aria-label="Transfers history">
        <div className="table-document-heading">
          <strong>Transfers history · page {page}</strong>
          <TableDocumentTools tableId="transfers-history-table" title="Transfers history" disabled={loading || Boolean(error) || !rows.length} />
        </div>
        {loading && rows.length === 0 ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading transfers…</div>
        ) : !error && rows.length === 0 ? (
          <div className="empty">
            <Search size={23} />
            <h2>No transfers found</h2>
            <p>Adjust the date range or clear the search and filters.</p>
          </div>
        ) : !error ? (
          <table id="transfers-history-table">
            <thead>
              <tr>
                <th>Transfer</th><th>Route</th><th>Items</th><th>Quantity</th><th>Created</th><th>Status</th><th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.transfer_number}</strong></td>
                  <td>{row.from_branch_name} <ArrowRight size={12} aria-hidden="true" /> {row.to_branch_name}</td>
                  <td>{row.item_count}</td>
                  <td>{formatQuantity(row.quantity_milli)}</td>
                  <td>{formatDateTime(row.created_at)}</td>
                  <td><span className={`status ${statusTone(row.status)}`}>{labelize(row.status)}</span></td>
                  <td><button className="button secondary returns-view-button" onClick={() => void openDetails(row.id)} type="button"><Eye size={14} /> Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {!loading && !error && (
        <div className="returns-history-footer">
          <span>{total ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}` : "0 transfers"}</span>
          <div className="sales-pagination">
            <span>Page {page} of {pageCount}</span>
            <div>
              <button className="button secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button"><ChevronLeft size={14} /> Previous</button>
              <button className="button secondary" disabled={page >= pageCount || loading} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} type="button">Next <ChevronRight size={14} /></button>
            </div>
          </div>
        </div>
      )}

      {selectedTransferId && (
        <div className="sales-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedTransferId("");
        }}>
          <section aria-label="Transfer details" aria-modal="true" className="sales-dialog card" role="dialog">
            <header className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Transfer details</p>
                <h2>{details?.transfer.transfer_number || "Transfer record"}</h2>
              </div>
              <button aria-label="Close transfer details" className="button secondary" onClick={() => setSelectedTransferId("")} type="button"><X size={16} /></button>
            </header>
            {detailLoading && <div className="loading"><LoaderCircle size={18} className="spin" /> Loading transfer details…</div>}
            {detailError && <div className="notice" role="alert">{detailError}</div>}
            {details && (
              <>
                <div className="returns-detail-context">
                  <div><span>From</span><strong>{details.transfer.from_branch_name}</strong></div>
                  <div><span>To</span><strong>{details.transfer.to_branch_name}</strong></div>
                  <div><span>Created</span><strong>{formatDateTime(details.transfer.created_at)}</strong></div>
                  <div><span>Status</span><strong className={`status ${statusTone(details.transfer.status)}`}>{labelize(details.transfer.status)}</strong></div>
                  {details.transfer.dispatched_at && <div><span>Dispatched</span><strong>{formatDateTime(details.transfer.dispatched_at)}</strong></div>}
                  {details.transfer.received_at && <div><span>Received</span><strong>{formatDateTime(details.transfer.received_at)}</strong></div>}
                  {details.transfer.cancelled_at && <div><span>Cancelled</span><strong>{formatDateTime(details.transfer.cancelled_at)}</strong></div>}
                  {details.transfer.notes && <div className="returns-detail-wide"><span>Notes</span><strong>{details.transfer.notes}</strong></div>}
                </div>

                <div className="returns-detail-items">
                  <div className="returns-detail-item returns-detail-item-heading"><span>Product</span><span>Sent</span><strong>Received</strong></div>
                  {details.items.map((transferItem) => (
                    <div className="returns-detail-item" key={transferItem.id}>
                      <div><strong>{transferItem.product_name}</strong><small>{transferItem.unit_code}</small></div>
                      <span>{formatQuantity(transferItem.quantity_milli)} {transferItem.unit_code}</span>
                      <strong>{formatQuantity(transferItem.received_quantity_milli)} {transferItem.unit_code}</strong>
                    </div>
                  ))}
                  {!details.items.length && <p>No item lines are recorded for this transfer.</p>}
                </div>

                <div className="returns-detail-actions">
                  <button
                    className="button secondary"
                    disabled
                    title="Cancelling a draft transfer requires the secure transaction workflow. Use the Windows app."
                    type="button"
                  >
                    Cancel draft
                  </button>
                  <button
                    className="button secondary"
                    disabled
                    title="Dispatching stock requires the secure transaction workflow. Use the Windows app."
                    type="button"
                  >
                    Dispatch
                  </button>
                  <button
                    className="button secondary"
                    disabled
                    title="Receiving stock requires the secure transaction workflow. Use the Windows app."
                    type="button"
                  >
                    Receive
                  </button>
                  <button className="button secondary" onClick={() => setSelectedTransferId("")} type="button">Close</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
