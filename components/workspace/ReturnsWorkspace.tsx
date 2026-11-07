"use client";

import {
  AlertCircle, ChevronLeft, ChevronRight, Eye, LoaderCircle, Plus,
  Printer, RefreshCw, Search, X,
} from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatDateTime, formatMoney, formatQuantity, labelize } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { ReceiptQr } from "@/components/workspace/ReceiptQr";
import { formatReportDate, formatReportMoney, formatReportQuantity } from "@/lib/print/document";
import {
  buildReturnReceiptQrData,
  DEFAULT_RECEIPT_SETTINGS,
  receiptPageCss,
  receiptWidth,
} from "@/lib/print/receipt";
import { waitForReceiptQr } from "@/lib/print/print-window";
import { DEFAULT_BRAND_NAME } from "@/lib/branding";
import { generateReturnsRefundsDocument } from "@/lib/print/reports";

interface ReturnRow {
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
  completed_at: string | null;
}

interface ReturnItem {
  id: string;
  product_name: string;
  unit_code: string;
  quantity_milli: number;
  unit_price_paisa: number;
  line_refund_paisa: number;
  condition: string;
  restock: boolean;
}

interface ReturnRefund {
  id: string;
  method: string;
  amount_paisa: number;
  credited_paisa: number;
  paid_out_paisa: number;
  status: string;
  reference: string | null;
  processed_at: string | null;
}

interface ReturnDetails extends ReturnRow {
  shift_id: string | null;
  notes: string | null;
  sale_total_paisa: number;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  completed_by: string | null;
  created_by_name: string;
  approved_by_name: string | null;
  rejected_by_name: string | null;
  completed_by_name: string | null;
  items: ReturnItem[];
  refunds: ReturnRefund[];
}

interface ReturnsResponse {
  rows?: ReturnRow[];
  total?: number;
  capped?: boolean;
  error?: string;
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
  if (status === "rejected") return "red";
  return "";
}

export function ReturnsWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const receiptSettings = DEFAULT_RECEIPT_SETTINGS;
  const [from, to] = initialDateRange();
  const [fromDate, setFromDate] = useState(from);
  const [toDate, setToDate] = useState(to);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const reportBranchName = branchId === "all"
    ? "All branches"
    : branches.find((branch) => branch.id === branchId)?.name || "Your branch";
  const [status, setStatus] = useState<(typeof RETURN_STATUSES)[number]>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedReturnId, setSelectedReturnId] = useState("");
  const [details, setDetails] = useState<ReturnDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const isAdmin = staff?.role === "admin";
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
    const parameters = new URLSearchParams({
      from: fromDate,
      to: toDate,
      status,
      page: String(page),
    });
    if (branchId) parameters.set("branchId", branchId);
    if (debouncedSearch) parameters.set("search", debouncedSearch);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/returns?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as ReturnsResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load returns history.");
        setRows(result.rows || []);
        setTotal(result.total || 0);
        setCapped(Boolean(result.capped));
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load returns history.");
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
      const response = await fetch(`/api/workspace/returns?detailId=${encodeURIComponent(returnId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as ReturnDetails & { error?: string };
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
          <h1>Returns &amp; refunds</h1>
          <p>Review return requests, item condition, restocking, approvals, and refund history.</p>
        </div>
        <button className="button returns-create-button" disabled title="Return creation and approvals require the secure transaction workflow." type="button">
          <Plus size={15} /> New return
        </button>
      </div>

      <div className="live-readonly-note">
        <AlertCircle size={16} />
        <span>Live cloud records · read-only. Creating, approving, cancelling, and completing refunds remain disabled on the web.</span>
      </div>

      <section className="returns-history-filters card" aria-label="Returns history filters">
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
            <span>Branch</span>
            <select value={branchId} onChange={(event) => updateFilter(setBranchId, event.target.value)}>
              <option value="all">All branches</option>
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
      <section className="card table-wrap workspace-table returns-history-table" aria-label="Returns history data">
        <div className="table-document-heading">
          <strong>Returns history · page {page}</strong>
          <TableDocumentTools
            tableId="returns-history-table"
            title="Returns history"
            orientationKey="returns-refunds"
            disabled={loading || Boolean(error) || !rows.length}
            buildDocument={(orientation) => rows.length
              ? generateReturnsRefundsDocument({
                  rows,
                  period: `${formatReportDate(fromDate)} - ${formatReportDate(toDate)}`,
                  filterSummary: [
                    status !== "all" ? `Status: ${labelize(status)}` : "",
                    search ? `Search: ${search}` : "",
                  ].filter(Boolean).join(" · "),
                }, {
                  branding: { businessName: DEFAULT_BRAND_NAME },
                  orientationPreference: orientation,
                  branch: reportBranchName,
                  printedBy: staff?.full_name || "Staff",
                })
              : null}
          />
        </div>
        {loading && rows.length === 0 ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading returns…</div>
        ) : !error && rows.length === 0 ? (
          <div className="empty">
            <Search size={23} />
            <h2>No returns found</h2>
            <p>Adjust the date range or clear the search and filters.</p>
          </div>
        ) : !error ? (
          <table id="returns-history-table">
            <thead>
              <tr>
                <th>Return</th>{isAdmin && <th>Branch</th>}<th>Receipt</th><th>Customer</th>
                <th>Raised</th><th>Reason</th><th>Refund</th><th>Restocked</th><th>Status</th><th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><strong className="returns-number">{row.return_number}</strong></td>
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
          {capped && <small>Search is limited to the latest 500 returns matching the selected branch, dates, and status.</small>}
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
          <section aria-label="Return details" aria-modal="true" className="sales-dialog card" role="dialog">
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
                  {isAdmin && <div><span>Branch</span><strong>{details.branch_name}</strong></div>}
                  <div><span>Receipt</span><strong>{details.receipt_number}</strong></div>
                  <div><span>Customer</span><strong>{details.customer_name}</strong></div>
                  <div><span>Original sale total</span><strong>{formatMoney(details.sale_total_paisa)}</strong></div>
                  <div><span>Raised</span><strong>{details.created_by_name} · {formatDateTime(details.created_at)}</strong></div>
                  <div><span>Status</span><strong className={`status ${returnStatusTone(details.status)}`}>{labelize(details.status)}</strong></div>
                  {details.approved_by_name && <div><span>Approved by</span><strong>{details.approved_by_name}</strong></div>}
                  {details.completed_by_name && <div><span>Completed by</span><strong>{details.completed_by_name}</strong></div>}
                  {details.rejected_by_name && <div><span>Rejected by</span><strong>{details.rejected_by_name}</strong></div>}
                  <div className="returns-detail-wide"><span>Reason</span><strong>{details.reason}</strong></div>
                  {details.notes && <div className="returns-detail-wide"><span>Notes</span><strong>{details.notes}</strong></div>}
                  {details.rejection_reason && <div className="returns-detail-wide"><span>Rejection reason</span><strong>{details.rejection_reason}</strong></div>}
                </div>

                <style>{receiptPageCss(receiptSettings)}</style>
                <article
                  className="receipt-print"
                  style={{ "--print-receipt-width": receiptWidth(receiptSettings) } as CSSProperties}
                >
                  <header className="receipt-business">
                    {receiptSettings.showLogoOnReceipt && receiptSettings.logoDataUrl ? (
                      <img
                        src={receiptSettings.logoDataUrl}
                        alt=""
                        style={{ maxWidth: "36mm", maxHeight: "18mm", objectFit: "contain" }}
                      />
                    ) : null}
                    <strong>{receiptSettings.businessName || details.branch_name}</strong>
                    {receiptSettings.businessTagline ? <small>{receiptSettings.businessTagline}</small> : null}
                    {receiptSettings.businessAddress ? <small>{receiptSettings.businessAddress}</small> : null}
                    {receiptSettings.businessPhone ? <small>{receiptSettings.businessPhone}</small> : null}
                    {receiptSettings.businessEmail ? <small>{receiptSettings.businessEmail}</small> : null}
                    <strong>RETURN / REFUND</strong>
                  </header>
                  <div className="receipt-meta">
                    <div><span>Return number</span><strong>{details.return_number}</strong></div>
                    <div><span>Sale receipt</span><strong>{details.receipt_number}</strong></div>
                    <div><span>Branch</span><strong>{details.branch_name}</strong></div>
                    <div><span>Date</span><strong>{new Date(details.created_at).toLocaleString()}</strong></div>
                    <div><span>Raised by</span><strong>{details.created_by_name}</strong></div>
                    {details.approved_by_name ? <div><span>Approved by</span><strong>{details.approved_by_name}</strong></div> : null}
                    {details.completed_by_name ? <div><span>Completed by</span><strong>{details.completed_by_name}</strong></div> : null}
                    <div><span>Customer</span><strong>{details.customer_name || "Walk-in Customer"}</strong></div>
                    <div><span>Status</span><strong>{details.status.toUpperCase()}</strong></div>
                    <div><span>Reason</span><strong>{details.reason}</strong></div>
                  </div>
                  <div className="receipt-items">
                    {details.items.map((returnItem) => (
                      <div className="receipt-item" key={returnItem.id}>
                        <div>
                          <strong>{returnItem.product_name}</strong>
                          <small>{formatReportQuantity(returnItem.quantity_milli)} {returnItem.unit_code} · {labelize(returnItem.condition)}</small>
                          <small>{returnItem.restock ? "Restock: Yes" : "Restock: No"}</small>
                        </div>
                        <strong>{formatReportMoney(returnItem.line_refund_paisa)}</strong>
                      </div>
                    ))}
                  </div>
                  <div className="receipt-totals">
                    <div className="receipt-total"><span>Refund total</span><strong>{formatReportMoney(details.refund_total_paisa)}</strong></div>
                    {details.refunds.map((refund) => (
                      <div key={refund.id}>
                        <span>
                          Refund via {refund.method.replaceAll("_", " ")}
                          <small>{refund.reference || refund.status}</small>
                        </span>
                        <strong>{formatReportMoney(refund.amount_paisa)}</strong>
                      </div>
                    ))}
                  </div>
                  {details.notes ? <p className="receipt-thanks">{details.notes}</p> : null}
                  <ReceiptQr
                    value={buildReturnReceiptQrData(details)}
                    label="Scan for return details · not a tax invoice"
                  />
                  <footer className="receipt-thanks">{receiptSettings.receiptFooter || "Return receipt"}</footer>
                </article>

                {details.refunds.length > 0 && (
                  <section className="returns-refund-history">
                    <h3>Refund history</h3>
                    {details.refunds.map((refund) => (
                      <div key={refund.id}>
                        <span>
                          {labelize(refund.method)} · {labelize(refund.status)}
                          {refund.reference && <small>Reference: {refund.reference}</small>}
                          {refund.processed_at && <small>{formatDateTime(refund.processed_at)}</small>}
                        </span>
                        <strong>{formatMoney(refund.amount_paisa)}{refund.credited_paisa > 0 ? ` · ${formatMoney(refund.credited_paisa)} credited` : ""}</strong>
                      </div>
                    ))}
                  </section>
                )}
                <div className="returns-detail-actions">
                  <button className="button secondary" onClick={() => setSelectedReturnId("")} type="button">Close</button>
                  <button className="button" onClick={async () => { await waitForReceiptQr(); window.print(); }} type="button"><Printer size={15} /> Print return receipt</button>
                  {details.status === "pending" && (
                    <button className="button secondary" disabled title="Cancelling returns is a Windows desktop workflow." type="button">Cancel return</button>
                  )}
                  {details.status === "pending" && (
                    <button className="button secondary" disabled title="Rejecting returns is a Windows desktop workflow." type="button">Reject</button>
                  )}
                  {details.status === "pending" && (
                    <button className="button" disabled title="Approving returns is a Windows desktop workflow." type="button">Approve</button>
                  )}
                  {details.status === "approved" && (
                    <button className="button" disabled title="Completing refunds is a Windows desktop workflow." type="button">Complete refund</button>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
