"use client";

import {
  ChevronLeft, ChevronRight, Eye, LoaderCircle, Plus,
  Printer, RefreshCw, Search, X,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatDateTime, formatMoney, formatQuantity, labelize } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { ReceiptDocument } from "@/components/workspace/ReceiptDocument";
import { postWorkspaceAction, newIdempotencyKey } from "@/lib/workspace/write-client";
import { formatReportDate, formatReportMoney, formatReportQuantity } from "@/lib/print/document";
import {
  buildReturnReceiptQrData,
  DEFAULT_RECEIPT_SETTINGS,
  receiptPageCss,
  receiptPageSize,
} from "@/lib/print/receipt";
import { waitForReceiptQr } from "@/lib/print/print-window";
import { printReceiptElementViaBridge } from "@/lib/print/bridge-print";
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
  created_by_is_current: boolean;
  items: ReturnItem[];
  refunds: ReturnRefund[];
}

interface ReturnsResponse {
  rows?: ReturnRow[];
  total?: number;
  capped?: boolean;
  error?: string;
}

interface ReturnableSale {
  id: string;
  receipt_number: string;
  branch_id: string;
  branch_name: string;
  status: string;
  total_paisa: number;
  paid_paisa: number;
  customer_name: string;
}

interface ReturnableItem {
  sale_item_id: string;
  product_name: string;
  unit_code: string;
  sold_milli: number;
  returned_milli: number;
  returnable_milli: number;
}

interface ReturnableSaleResponse {
  sale?: ReturnableSale;
  items?: ReturnableItem[];
}

const PAGE_SIZE = 25;
const RETURN_STATUSES = ["all", "pending", "approved", "completed", "rejected", "cancelled"] as const;
const RETURN_CONDITIONS = ["new", "used", "damaged", "expired"] as const;
const REFUND_METHODS = ["cash", "card", "jazzcash", "easypaisa", "bank_transfer", "store_credit", "replacement"] as const;

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

function quantityInput(milli: number): string {
  return (milli / 1000).toFixed(3);
}

function parseQuantityMilli(value: string): number | null {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) return null;
  const quantity = Math.round(Number(text) * 1000);
  return Number.isSafeInteger(quantity) ? quantity : null;
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
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [refundMethod, setRefundMethod] = useState<(typeof REFUND_METHODS)[number]>("cash");
  const [refundReference, setRefundReference] = useState("");
  const isAdmin = staff?.role === "admin";
  const canApprove = staff?.role === "admin" || staff?.role === "manager";
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const printReceipt = async () => {
    await waitForReceiptQr();
    const element = document.querySelector(".receipt-print");
    const result = await printReceiptElementViaBridge(element, {
      pageCss: receiptPageCss(receiptSettings),
      pageSize: receiptPageSize(receiptSettings),
      title: details ? `Return ${details.return_number}` : "Return receipt",
    });
    if (!result.printed) window.print();
  };

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
    setActionError(null);
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

  const performReturnAction = async (
    action: "approve" | "reject" | "cancel" | "complete",
    extra: Record<string, unknown> = {},
  ) => {
    if (!details) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await postWorkspaceAction("/api/workspace/return-actions", {
        action,
        returnId: details.id,
        ...extra,
      });
      await openDetails(details.id);
      setReloadKey((value) => value + 1);
      setRejecting(false);
      setRejectionReason("");
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "Could not update this return.");
    } finally {
      setActionBusy(false);
    }
  };

  const handleReturnCreated = async (returnId: string) => {
    setCreateDialogOpen(false);
    setReloadKey((value) => value + 1);
    await openDetails(returnId);
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
        <button className="button returns-create-button" onClick={() => setCreateDialogOpen(true)} type="button">
          <Plus size={15} /> New return
        </button>
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

                <ReceiptDocument
                  settings={receiptSettings}
                  branchName={details.branch_name}
                  documentLabel="RETURN / REFUND"
                  metadata={[
                    { label: "Return number", value: details.return_number },
                    { label: "Sale receipt", value: details.receipt_number },
                    { label: "Branch", value: details.branch_name },
                    { label: "Date", value: new Date(details.created_at).toLocaleString() },
                    { label: "Raised by", value: details.created_by_name },
                    ...(details.approved_by_name ? [{ label: "Approved by", value: details.approved_by_name }] : []),
                    ...(details.completed_by_name ? [{ label: "Completed by", value: details.completed_by_name }] : []),
                    { label: "Customer", value: details.customer_name || "Walk-in Customer" },
                    { label: "Status", value: details.status.toUpperCase() },
                    { label: "Reason", value: details.reason },
                  ]}
                  items={details.items.map((returnItem) => ({
                    id: returnItem.id,
                    name: returnItem.product_name,
                    details: [
                      `${formatReportQuantity(returnItem.quantity_milli)} ${returnItem.unit_code} · ${labelize(returnItem.condition)}`,
                      `Restock: ${returnItem.restock ? "Yes" : "No"}`,
                    ],
                    amount: formatReportMoney(returnItem.line_refund_paisa),
                  }))}
                  totals={[
                    { label: "Refund total", value: formatReportMoney(details.refund_total_paisa), emphasis: true },
                    ...details.refunds.map((refund) => ({
                      label: `Refund via ${refund.method.replaceAll("_", " ")}`,
                      value: formatReportMoney(refund.amount_paisa),
                      detail: refund.reference || refund.status,
                    })),
                  ]}
                  policy={receiptSettings.returnPolicy || undefined}
                  qr={{
                    value: buildReturnReceiptQrData(details),
                    label: "Scan for return details · not a tax invoice",
                  }}
                  footer={receiptSettings.receiptFooter || "Return receipt"}
                />

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
                  <button className="button" onClick={() => void printReceipt()} type="button"><Printer size={15} /> Print return receipt</button>
                </div>
                {actionError && <div className="notice" role="alert">{actionError}</div>}
                {details.status === "approved" && details.created_by_is_current && (
                  <div className="returns-action-fields">
                    <label className="returns-history-control">
                      <span>Refund method</span>
                      <select value={refundMethod} onChange={(event) => setRefundMethod(event.target.value as (typeof REFUND_METHODS)[number])}>
                        {REFUND_METHODS.map((method) => <option key={method} value={method}>{labelize(method)}</option>)}
                      </select>
                    </label>
                    <label className="returns-history-control">
                      <span>Reference <small>Optional</small></span>
                      <input maxLength={100} value={refundReference} onChange={(event) => setRefundReference(event.target.value)} />
                    </label>
                  </div>
                )}
                {rejecting && details.status === "pending" && canApprove && (
                  <label className="returns-history-control returns-rejection-field">
                    <span>Rejection reason</span>
                    <input maxLength={300} value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} />
                  </label>
                )}
                <div className="returns-detail-actions">
                  {details.status === "pending" && (details.created_by_is_current || canApprove) && (
                    <button className="button secondary" disabled={actionBusy} onClick={() => void performReturnAction("cancel")} type="button">Cancel return</button>
                  )}
                  {details.status === "pending" && canApprove && (
                    rejecting ? (
                      <button className="button secondary" disabled={actionBusy || !rejectionReason.trim()} onClick={() => void performReturnAction("reject", { reason: rejectionReason })} type="button">Confirm rejection</button>
                    ) : (
                      <button className="button secondary" disabled={actionBusy} onClick={() => setRejecting(true)} type="button">Reject</button>
                    )
                  )}
                  {details.status === "pending" && canApprove && (
                    <button className="button" disabled={actionBusy} onClick={() => void performReturnAction("approve")} type="button">Approve</button>
                  )}
                  {details.status === "approved" && details.created_by_is_current && (
                    <button className="button" disabled={actionBusy} onClick={() => void performReturnAction("complete", { refundMethod, reference: refundReference })} type="button">
                      {actionBusy ? "Completing…" : "Complete refund"}
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {createDialogOpen && (
        <ReturnCreationDialog
          branches={branches}
          branchId={branchId}
          isAdmin={isAdmin}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={handleReturnCreated}
        />
      )}
    </>
  );
}

function ReturnCreationDialog({
  branches,
  branchId,
  isAdmin,
  onClose,
  onCreated,
}: {
  branches: { id: string; name: string }[];
  branchId: string;
  isAdmin: boolean;
  onClose: () => void;
  onCreated: (returnId: string) => Promise<void>;
}) {
  const [targetBranchId, setTargetBranchId] = useState(branchId === "all" ? "" : branchId);
  const [receiptNumber, setReceiptNumber] = useState("");
  const [sale, setSale] = useState<ReturnableSale | null>(null);
  const [lines, setLines] = useState<(ReturnableItem & {
    selected: boolean;
    quantity: string;
    condition: (typeof RETURN_CONDITIONS)[number];
  })[]>([]);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [clientReturnId] = useState(newIdempotencyKey);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const findSale = async () => {
    if (!receiptNumber.trim() || (isAdmin && !targetBranchId)) return;
    setLookupBusy(true);
    setError(null);
    setSale(null);
    setLines([]);
    try {
      const result = await postWorkspaceAction<ReturnableSaleResponse>(
        "/api/workspace/return-actions",
        {
          action: "lookup",
          receiptNumber: receiptNumber.trim(),
          ...(targetBranchId ? { branchId: targetBranchId } : {}),
        },
      );
      if (!result.sale) throw new Error("The sale receipt was not found.");
      setSale(result.sale);
      setLines((result.items || []).map((line) => ({
        ...line,
        selected: false,
        quantity: quantityInput(line.returnable_milli),
        condition: "new",
      })));
      if (!(result.items || []).some((line) => line.returnable_milli > 0)) {
        setError("Every line on this receipt has already been returned.");
      }
    } catch (lookupFailure) {
      setError(lookupFailure instanceof Error ? lookupFailure.message : "Could not find that sale.");
    } finally {
      setLookupBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!sale) return;
    setSaving(true);
    setError(null);
    try {
      const items = lines.filter((line) => line.selected).map((line) => {
        const quantityMilli = parseQuantityMilli(line.quantity);
        if (quantityMilli === null || quantityMilli <= 0 || quantityMilli > line.returnable_milli) {
          throw new Error(`Enter a valid return quantity for ${line.product_name}.`);
        }
        return {
          saleItemId: line.sale_item_id,
          quantityMilli,
          condition: line.condition,
        };
      });
      if (!items.length) throw new Error("Select at least one line to return.");
      const result = await postWorkspaceAction<{ returnId?: string }>(
        "/api/workspace/return-actions",
        {
          action: "create",
          clientReturnId,
          saleId: sale.id,
          branchId: sale.branch_id,
          reason,
          notes,
          items,
        },
      );
      if (!result.returnId) throw new Error("The return was saved but its identifier was not returned.");
      await onCreated(result.returnId);
    } catch (saveFailure) {
      setError(saveFailure instanceof Error ? saveFailure.message : "Could not create this return.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sales-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section aria-label="Create return" aria-modal="true" className="sales-dialog card" role="dialog">
        <header className="sales-dialog-header">
          <div>
            <p className="eyebrow page">Returns</p>
            <h2>New return</h2>
          </div>
          <button aria-label="Close new return" className="button secondary" disabled={saving} onClick={onClose} type="button"><X size={16} /></button>
        </header>
        <form className="returns-create-form" onSubmit={(event) => void submit(event)}>
          <div className="returns-action-fields">
            {isAdmin && (
              <label className="returns-history-control">
                <span>Target branch</span>
                <select required value={targetBranchId} onChange={(event) => setTargetBranchId(event.target.value)}>
                  <option value="">Choose branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </label>
            )}
            <label className="returns-history-control">
              <span>Receipt number</span>
              <input maxLength={60} required value={receiptNumber} onChange={(event) => setReceiptNumber(event.target.value)} />
            </label>
            <button className="button secondary" disabled={lookupBusy || !receiptNumber.trim() || (isAdmin && !targetBranchId)} onClick={() => void findSale()} type="button">
              {lookupBusy ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />} Find sale
            </button>
          </div>
          {sale && (
            <>
              <div className="returns-detail-context">
                <div><span>Receipt</span><strong>{sale.receipt_number}</strong></div>
                <div><span>Customer</span><strong>{sale.customer_name || "Walk-in Customer"}</strong></div>
                <div><span>Sale total</span><strong>{formatMoney(sale.total_paisa)}</strong></div>
                <div><span>Paid</span><strong>{formatMoney(sale.paid_paisa)}</strong></div>
                <div><span>Branch</span><strong>{sale.branch_name}</strong></div>
              </div>
              <div className="returns-create-lines">
                <table>
                  <thead><tr><th>Return</th><th>Product</th><th>Sold</th><th>Available</th><th>Quantity</th><th>Condition</th></tr></thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.sale_item_id}>
                        <td><input aria-label={`Select ${line.product_name}`} checked={line.selected} disabled={line.returnable_milli <= 0} onChange={(event) => setLines((current) => current.map((row) => row.sale_item_id === line.sale_item_id ? { ...row, selected: event.target.checked } : row))} type="checkbox" /></td>
                        <td>{line.product_name}</td>
                        <td>{formatQuantity(line.sold_milli)} {line.unit_code}</td>
                        <td>{formatQuantity(line.returnable_milli)} {line.unit_code}</td>
                        <td><input aria-label={`Return quantity for ${line.product_name}`} disabled={!line.selected} inputMode="decimal" value={line.quantity} onChange={(event) => setLines((current) => current.map((row) => row.sale_item_id === line.sale_item_id ? { ...row, quantity: event.target.value } : row))} /></td>
                        <td><select aria-label={`Condition for ${line.product_name}`} disabled={!line.selected} value={line.condition} onChange={(event) => setLines((current) => current.map((row) => row.sale_item_id === line.sale_item_id ? { ...row, condition: event.target.value as (typeof RETURN_CONDITIONS)[number] } : row))}>
                          {RETURN_CONDITIONS.map((condition) => <option key={condition} value={condition}>{labelize(condition)}</option>)}
                        </select></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="returns-create-help">Only new and used items return to sellable stock. Damaged or expired units are refunded but not restocked. A manager or administrator must approve this request; the staff member who raised it completes the refund.</p>
              <label className="returns-history-control">
                <span>Reason</span>
                <input maxLength={300} required value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              <label className="returns-history-control">
                <span>Notes <small>Optional</small></span>
                <input maxLength={1000} value={notes} onChange={(event) => setNotes(event.target.value)} />
              </label>
            </>
          )}
          {error && <div className="notice" role="alert">{error}</div>}
          <div className="returns-detail-actions">
            <button className="button secondary" disabled={saving} onClick={onClose} type="button">Close</button>
            <button className="button" disabled={!sale || saving || lookupBusy} type="submit">
              {saving ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />} Raise return
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
