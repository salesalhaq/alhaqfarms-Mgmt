"use client";

import {
  AlertCircle, ChevronLeft, ChevronRight, Eye, LoaderCircle, Plus,
  RefreshCw, Search, X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";

interface StoreReturnRow {
  id: string;
  return_number: string;
  branch_id: string;
  branch_name: string;
  sale_id: string;
  receipt_number: string;
  customer_name: string;
  status: string;
  reason: string;
  refund_total_paisa: number;
  restock_total_milli: number;
  created_by: string;
  created_at: string;
  approved_at: string | null;
  completed_at: string | null;
}

interface StoreReturnItem {
  id: string;
  product_name: string;
  unit_code: string;
  quantity_milli: number;
  unit_price_paisa: number;
  line_refund_paisa: number;
  condition: string;
  restock: boolean;
}

interface StoreReturnRefund {
  id: string;
  method: string;
  amount_paisa: number;
  credited_paisa: number;
  status: string;
  reference: string | null;
  processed_at: string | null;
}

interface StoreReturnDetails extends StoreReturnRow {
  notes: string | null;
  sale_total_paisa: number;
  created_by_name: string;
  approved_by_name: string | null;
  rejected_by_name: string | null;
  completed_by_name: string | null;
  items: StoreReturnItem[];
  refunds: StoreReturnRefund[];
}

interface StoreReturnsResponse {
  rows?: StoreReturnRow[];
  total?: number;
  capped?: boolean;
  error?: string;
  details?: StoreReturnDetails;
}

const PAGE_SIZE = 25;
const RETURN_STATUSES = ["all", "pending", "approved", "completed", "rejected", "cancelled"] as const;

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

function returnStatusTone(status: string): string {
  if (status === "pending") return "amber";
  if (status === "approved" || status === "completed") return "green";
  if (status === "rejected" || status === "cancelled") return "red";
  return statusTone(status);
}

export function StoreReturnsWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [from, to] = useMemo(initialDateRange, []);
  const [fromDate, setFromDate] = useState(from);
  const [toDate, setToDate] = useState(to);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [status, setStatus] = useState<(typeof RETURN_STATUSES)[number]>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<StoreReturnRow[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedReturnId, setSelectedReturnId] = useState("");
  const [details, setDetails] = useState<StoreReturnDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const isAdmin = staff?.role === "admin";
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const summary = useMemo(() => rows.reduce((acc, row) => {
    acc.totalRefundPaisa += row.refund_total_paisa;
    if (row.status === "pending") acc.pending += 1;
    if (row.status === "approved") acc.approved += 1;
    if (row.status === "completed") acc.completed += 1;
    if (row.status === "rejected") acc.rejected += 1;
    return acc;
  }, {
    totalRefundPaisa: 0,
    pending: 0,
    approved: 0,
    completed: 0,
    rejected: 0,
  }), [rows]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (staff?.role === "admin" && !branchId) setBranchId("all");
    else if (staff?.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff?.branch_id, staff?.role]);

  useEffect(() => {
    let active = true;
    if (!staff) {
      setLoading(false);
      return () => { active = false; };
    }

    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      from: fromDate,
      to: toDate,
      status,
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (branchId && branchId !== "all") params.set("branchId", branchId);
    if (debouncedSearch) params.set("search", debouncedSearch);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/store-returns?${params.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as StoreReturnsResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load store returns.");
        setRows(result.rows || []);
        setTotal(result.total || 0);
        setCapped(Boolean(result.capped));
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load store returns.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, debouncedSearch, fromDate, page, reloadKey, staff, status, toDate]);

  useEffect(() => {
    if (!selectedReturnId) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedReturnId("");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedReturnId]);

  const openDetails = async (returnId: string) => {
    setSelectedReturnId(returnId);
    setDetails(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/workspace/store-returns?detailId=${encodeURIComponent(returnId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as StoreReturnDetails & { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not load return details.");
      setDetails(result);
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "Could not load return details.");
    } finally {
      setDetailLoading(false);
    }
  };

  const clearFilters = () => {
    const [defaultFrom, defaultTo] = initialDateRange();
    setFromDate(defaultFrom);
    setToDate(defaultTo);
    setBranchId(isAdmin ? "all" : staff?.branch_id || "");
    setStatus("all");
    setSearch("");
    setPage(1);
  };

  const updateFilter = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setPage(1);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>Store returns</h1>
          <p>Review branch return requests, item condition, refund totals, and approval history.</p>
        </div>
        <button className="button returns-create-button" disabled title="Return creation and approval decisions require the verified secure transaction workflow." type="button">
          <Plus size={15} /> New return
        </button>
      </div>

      <div className="live-readonly-note">
        <AlertCircle size={16} />
        <span>Live branch records · read-only. Approve, reject, and release actions remain disabled until the secure workflow is verified.</span>
      </div>

      <section className="returns-history-filters card" aria-label="Store return filters">
        <label className="search-field returns-history-search">
          <Search size={16} />
          <input
            aria-label="Search return number, receipt, or customer"
            placeholder="Return number, receipt, or customer"
            value={search}
            onChange={(event) => updateFilter(setSearch, event.target.value)}
          />
        </label>
        <label className="returns-history-control">
          <span>From</span>
          <input type="date" aria-label="Returns from date" value={fromDate} max={toDate || undefined} onChange={(event) => updateFilter(setFromDate, event.target.value)} />
        </label>
        <label className="returns-history-control">
          <span>To</span>
          <input type="date" aria-label="Returns to date" value={toDate} min={fromDate || undefined} onChange={(event) => updateFilter(setToDate, event.target.value)} />
        </label>
        <label className="returns-history-control">
          <span>Status</span>
          <select value={status} onChange={(event) => updateFilter(setStatus, event.target.value as (typeof RETURN_STATUSES)[number])}>
            {RETURN_STATUSES.map((value) => <option key={value} value={value}>{value === "all" ? "All statuses" : labelize(value)}</option>)}
          </select>
        </label>
        {isAdmin && (
          <label className="returns-history-control">
            <span>Store</span>
            <select value={branchId} onChange={(event) => updateFilter(setBranchId, event.target.value)}>
              <option value="all">All stores</option>
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

      <div className="workspace-summary-grid">
        <article className="card summary-tile">
          <span>Refund issued</span>
          <strong>{formatMoney(summary.totalRefundPaisa)}</strong>
          <small>Across visible returns</small>
        </article>
        <article className="card summary-tile">
          <span>Pending</span>
          <strong>{summary.pending}</strong>
          <small>Awaiting review</small>
        </article>
        <article className="card summary-tile">
          <span>Approved</span>
          <strong>{summary.approved}</strong>
          <small>Ready for completion</small>
        </article>
        <article className="card summary-tile">
          <span>Completed</span>
          <strong>{summary.completed}</strong>
          <small>Closed and processed</small>
        </article>
      </div>

      {error && <div className="notice" role="alert">{error}</div>}
      <section className="card table-wrap workspace-table returns-history-table" aria-label="Store returns data">
        <div className="table-document-heading">
          <strong>Store returns · page {page}</strong>
          <TableDocumentTools tableId="store-returns-table" title="Store returns" disabled={loading || Boolean(error) || !rows.length} />
        </div>
        {loading && rows.length === 0 ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading store returns…</div>
        ) : !error && rows.length === 0 ? (
          <div className="empty">
            <Search size={23} />
            <h2>No store returns found</h2>
            <p>Adjust the date range, store, or status filters and try again.</p>
          </div>
        ) : !error ? (
          <table id="store-returns-table">
            <thead>
              <tr>
                <th>Return</th>
                {isAdmin && <th>Store</th>}
                <th>Receipt</th>
                <th>Customer</th>
                <th>Raised</th>
                <th>Reason</th>
                <th>Refund</th>
                <th>Restocked</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.return_number}</strong></td>
                  {isAdmin && <td>{row.branch_name}</td>}
                  <td>{row.receipt_number}</td>
                  <td>{row.customer_name}</td>
                  <td>{formatDateTime(row.created_at)}</td>
                  <td>{row.reason}</td>
                  <td className="numeric-cell"><strong>{formatMoney(row.refund_total_paisa)}</strong></td>
                  <td>{row.restock_total_milli ? formatQuantity(row.restock_total_milli) : "—"}</td>
                  <td><span className={`status ${returnStatusTone(row.status)}`}>{labelize(row.status)}</span></td>
                  <td><button className="button secondary returns-view-button" onClick={() => void openDetails(row.id)} type="button"><Eye size={14} /> Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {!loading && !error && (
        <div className="returns-history-footer">
          <span>{total ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}` : "0 returns"}</span>
          {capped && <small>Search is limited to the latest 500 matching returns for this view.</small>}
          <div className="sales-pagination">
            <span>Page {page} of {pageCount}</span>
            <div>
              <button className="button secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button"><ChevronLeft size={14} /> Previous</button>
              <button className="button secondary" disabled={page >= pageCount || loading} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} type="button">Next <ChevronRight size={14} /></button>
            </div>
          </div>
        </div>
      )}

      {selectedReturnId && (
        <div className="sales-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedReturnId("");
        }}>
          <section aria-label="Store return details" aria-modal="true" className="sales-dialog card" role="dialog">
            <header className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Return details</p>
                <h2>{details ? details.return_number : "Return record"}</h2>
              </div>
              <button aria-label="Close return details" className="button secondary" onClick={() => setSelectedReturnId("")} type="button"><X size={16} /></button>
            </header>
            {detailLoading && <div className="loading"><LoaderCircle size={18} className="spin" /> Loading return details…</div>}
            {detailError && <div className="notice" role="alert">{detailError}</div>}
            {details && (
              <>
                <div className="returns-detail-context">
                  {isAdmin && <div><span>Store</span><strong>{details.branch_name}</strong></div>}
                  <div><span>Receipt</span><strong>{details.receipt_number}</strong></div>
                  <div><span>Customer</span><strong>{details.customer_name}</strong></div>
                  <div><span>Original sale total</span><strong>{formatMoney(details.sale_total_paisa)}</strong></div>
                  <div><span>Raised</span><strong>{details.created_by_name} · {formatDateTime(details.created_at)}</strong></div>
                  <div><span>Status</span><strong className={`status ${returnStatusTone(details.status)}`}>{labelize(details.status)}</strong></div>
                  {details.approved_by_name && <div><span>Approved by</span><strong>{details.approved_by_name}</strong></div>}
                  {details.completed_by_name && <div><span>Completed by</span><strong>{details.completed_by_name}</strong></div>}
                </div>

                <div className="return-facts-grid">
                  <div className="info-block">
                    <h3>Return reason</h3>
                    <p>{details.reason || "No reason recorded."}</p>
                  </div>
                  <div className="info-block">
                    <h3>Notes</h3>
                    <p>{details.notes || "No notes added."}</p>
                  </div>
                </div>

                <div className="sales-order-sections">
                  <section className="info-block">
                    <h3>Items</h3>
                    {details.items.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Product</th>
                            <th>Unit</th>
                            <th>Qty</th>
                            <th>Refund</th>
                            <th>Condition</th>
                            <th>Restock</th>
                          </tr>
                        </thead>
                        <tbody>
                          {details.items.map((item) => (
                            <tr key={item.id}>
                              <td>{item.product_name}</td>
                              <td>{item.unit_code}</td>
                              <td>{formatQuantity(item.quantity_milli)}</td>
                              <td>{formatMoney(item.line_refund_paisa)}</td>
                              <td>{labelize(item.condition)}</td>
                              <td>{item.restock ? "Yes" : "No"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : <p>No items were recorded for this return.</p>}
                  </section>

                  <section className="info-block">
                    <h3>Refund activity</h3>
                    {details.refunds.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Method</th>
                            <th>Amount</th>
                            <th>Status</th>
                            <th>Reference</th>
                            <th>Processed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {details.refunds.map((refund) => (
                            <tr key={refund.id}>
                              <td>{labelize(refund.method)}</td>
                              <td>{formatMoney(refund.amount_paisa)}</td>
                              <td><span className={`status ${statusTone(refund.status)}`}>{labelize(refund.status)}</span></td>
                              <td>{refund.reference || "—"}</td>
                              <td>{refund.processed_at ? formatDateTime(refund.processed_at) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : <p>No refund records were created.</p>}
                  </section>
                </div>

                <div className="sales-dialog-footer">
                  <div className="sales-dialog-actions">
                    <button className="button secondary" onClick={() => window.print()} type="button">Print return receipt</button>
                    {details.status === "pending" && (
                      <button className="button secondary" disabled title="Cancelling returns is a Windows desktop workflow." type="button">Cancel return</button>
                    )}
                    <button className="button secondary" disabled title="Approve actions are disabled until the secure transaction workflow is verified and deployed.">Approve</button>
                    <button className="button danger" disabled title="Reject actions are disabled until the secure transaction workflow is verified and deployed.">Reject</button>
                    {details.status === "approved" && (
                      <button className="button" disabled title="Completing refunds is a Windows desktop workflow." type="button">Complete refund</button>
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
