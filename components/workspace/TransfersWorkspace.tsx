"use client";

import {
  ArrowRight, ChevronLeft, ChevronRight, Eye, LoaderCircle, Plus, RefreshCw, Search, Trash2, X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { WorkspaceDialog, WorkspaceError, WorkspaceField, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";
import { formatDateTime, formatQuantity, labelize } from "@/lib/format";
import { postWorkspaceAction } from "@/lib/workspace/write-client";
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
  product_id?: string;
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
  branches?: Array<{ id: string; name: string; code: string }>;
  accessibleBranchIds?: string[];
  products?: TransferProduct[];
  permissions?: {
    canCreate: boolean;
    canManage: boolean;
    canReceive: boolean;
  };
  error?: string;
}

interface TransferProduct {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit_code: string;
  stock_milli: number;
  cost_price_paisa: number;
}

interface TransferForm {
  fromBranchId: string;
  toBranchId: string;
  notes: string;
  items: Array<TransferProduct & { quantity: string }>;
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

function quantityToMilli(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const total = Number(match[1]) * 1000 + Number((match[2] || "").padEnd(3, "0"));
  return Number.isSafeInteger(total) ? total : null;
}

function milliToInput(value: number): string {
  return (value / 1000).toFixed(3).replace(/\.?0+$/, "");
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
  const [branchesList, setBranchesList] = useState<Array<{ id: string; name: string; code: string }>>([]);
  const [accessibleBranchIds, setAccessibleBranchIds] = useState<string[]>([]);
  const [permissions, setPermissions] = useState({ canCreate: false, canManage: false, canReceive: false });
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<TransferForm>({ fromBranchId: "", toBranchId: "", notes: "", items: [] });
  const [catalogProducts, setCatalogProducts] = useState<TransferProduct[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [debouncedProductSearch, setDebouncedProductSearch] = useState("");
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
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
        setBranchesList(result.branches || []);
        setAccessibleBranchIds(result.accessibleBranchIds || []);
        setPermissions(result.permissions || { canCreate: false, canManage: false, canReceive: false });
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
    const timer = window.setTimeout(() => setDebouncedProductSearch(productSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [productSearch]);

  useEffect(() => {
    if (!createOpen || !createForm.fromBranchId) return undefined;
    let active = true;
    setCatalogLoading(true);
    const parameters = new URLSearchParams({
      catalogBranchId: createForm.fromBranchId,
      catalogSearch: debouncedProductSearch,
    });
    void (async () => {
      try {
        const response = await fetch(`/api/workspace/transfers?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as TransfersResponse;
        if (!response.ok) throw new Error(result.error || "Could not load products for this branch.");
        if (active) {
          setCatalogProducts(result.products || []);
          setCatalogTotal(result.total || 0);
        }
      } catch (loadError) {
        if (active) setActionError(loadError instanceof Error ? loadError.message : "Could not load products for this branch.");
      } finally {
        if (active) setCatalogLoading(false);
      }
    })();
    return () => { active = false; };
  }, [createForm.fromBranchId, createOpen, debouncedProductSearch]);

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

  const openDetails = async (transferId: string): Promise<TransferDetails | null> => {
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
      const loaded = { transfer: result.transfer, items: result.items || [] };
      setDetails(loaded);
      setReceiveQuantities(Object.fromEntries(loaded.items.map((line) => [line.id, milliToInput(line.quantity_milli)])));
      return loaded;
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "Could not load transfer details.");
      return null;
    } finally {
      setDetailLoading(false);
    }
  };

  const accessibleBranches = branchesList.filter((branch) => accessibleBranchIds.includes(branch.id));
  const sourceBranches = isAdmin ? accessibleBranches : accessibleBranches.filter((branch) => branch.id === staff?.branch_id);
  const openCreate = () => {
    const sourceId = branchId !== "all" && sourceBranches.some((branch) => branch.id === branchId)
      ? branchId
      : sourceBranches[0]?.id || "";
    const destinationId = branchesList.find((branch) => branch.id !== sourceId)?.id || "";
    if (!sourceId || !destinationId) {
      setActionError("Create a second active branch before transferring stock.");
      return;
    }
    setActionError(null);
    setProductSearch("");
    setCreateForm({ fromBranchId: sourceId, toBranchId: destinationId, notes: "", items: [] });
    setCreateOpen(true);
  };

  const addProduct = (product: TransferProduct) => {
    setCreateForm((form) => form.items.some((line) => line.id === product.id)
      ? form
      : { ...form, items: [...form.items, { ...product, quantity: "1" }] });
  };

  const submitCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!createForm.items.length) {
      setActionError("Add at least one product to the transfer.");
      return;
    }
    const items: Array<{ productId: string; quantityMilli: number }> = [];
    for (const line of createForm.items) {
      const quantityMilli = quantityToMilli(line.quantity);
      if (quantityMilli == null || quantityMilli < 1) {
        setActionError(`Enter a valid quantity for ${line.name}.`);
        return;
      }
      items.push({ productId: line.id, quantityMilli });
    }
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await postWorkspaceAction<{ result?: { id?: string } }>("/api/workspace/transfers", {
        action: "create",
        fromBranchId: createForm.fromBranchId,
        toBranchId: createForm.toBranchId,
        notes: createForm.notes,
        items,
      });
      setCreateOpen(false);
      setActionMessage("Draft transfer created. Dispatch it when the stock leaves the branch.");
      setReloadKey((value) => value + 1);
      if (response.result?.id) await openDetails(response.result.id);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : "The transfer could not be created.");
    } finally {
      setActionBusy(false);
    }
  };

  const submitTransferAction = async (
    action: "dispatch" | "receive" | "cancel",
    transferId: string,
    items?: Array<{ itemId: string; receivedQuantityMilli: number }>,
  ) => {
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await postWorkspaceAction<{ result?: { id?: string } }>("/api/workspace/transfers", {
        action,
        transferId,
        ...(action === "receive" ? { items } : {}),
      });
      setActionMessage(action === "dispatch"
        ? "Transfer dispatched. Stock left the sending branch."
        : action === "receive"
          ? "Transfer received. Stock is now at the destination branch."
          : "Draft transfer cancelled.");
      setReloadKey((value) => value + 1);
      if (response.result?.id) await openDetails(response.result.id);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : "The transfer action could not be completed.");
    } finally {
      setActionBusy(false);
    }
  };

  const confirmDispatch = () => {
    if (!details) return;
    if (!window.confirm("Dispatch this transfer? Stock will be removed from the sending branch.")) return;
    void submitTransferAction("dispatch", details.transfer.id);
  };

  const confirmCancel = () => {
    if (!details) return;
    if (!window.confirm("Cancel this draft transfer? No stock will move.")) return;
    void submitTransferAction("cancel", details.transfer.id);
  };

  const confirmReceive = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!details) return;
    const items: Array<{ itemId: string; receivedQuantityMilli: number }> = [];
    for (const line of details.items) {
      const receivedQuantityMilli = quantityToMilli(receiveQuantities[line.id] || "");
      if (receivedQuantityMilli == null || receivedQuantityMilli > line.quantity_milli) {
        setActionError(`Received quantity for ${line.product_name} must be between zero and the sent quantity.`);
        return;
      }
      items.push({ itemId: line.id, receivedQuantityMilli });
    }
    if (!window.confirm("Confirm the quantities that arrived at this branch?")) return;
    void submitTransferAction("receive", details.transfer.id, items);
  };

  const canManageDetails = Boolean(details && permissions.canManage
    && (isAdmin
      ? !staff?.branch_id || staff.branch_id === details.transfer.from_branch_id || staff.branch_id === details.transfer.to_branch_id
      : staff?.branch_id === details.transfer.from_branch_id));
  const canReceiveDetails = Boolean(details && permissions.canReceive
    && (isAdmin
      ? !staff?.branch_id || staff.branch_id === details.transfer.from_branch_id || staff.branch_id === details.transfer.to_branch_id
      : staff?.branch_id === details.transfer.to_branch_id));

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>Stock transfers</h1>
          <p>Move stock between branches with controlled dispatch and receipt confirmation.</p>
        </div>
        {permissions.canCreate && (
          <button className="primary-button" disabled={!sourceBranches.length || branchesList.length < 2} onClick={openCreate} type="button">
            <Plus size={14} /> New transfer
          </button>
        )}
      </div>

      {actionMessage && <WorkspaceSuccess message={actionMessage} />}
      {actionError && !createOpen && !selectedTransferId && <WorkspaceError message={actionError} />}

      <div className="dashboard-stats" aria-label="Transfer summary">
        <div className="dashboard-stat card"><span>Drafts</span><strong>{rows.filter((row) => row.status === "draft").length}</strong><small>Not dispatched yet</small></div>
        <div className="dashboard-stat card"><span>In transit</span><strong>{rows.filter((row) => row.status === "dispatched").length}</strong><small>Waiting at destination</small></div>
        <div className="dashboard-stat card"><span>Received</span><strong>{rows.filter((row) => row.status === "received").length}</strong><small>In these results</small></div>
        <div className="dashboard-stat card"><span>Branches</span><strong>{branches.filter((branch) => branch.is_active).length}</strong><small>Active destinations</small></div>
      </div>

      <HorizontalFilterScroller className="transfers-history-filters" ariaLabel="Transfer filters">
        <label className="search-field transfers-history-search">
          <Search size={16} />
          <input
            aria-label="Search transfer number"
            placeholder="Search transfer number"
            value={search}
            onChange={(event) => updateFilter(setSearch, event.target.value)}
          />
        </label>
        <label className="returns-history-control transfers-history-control">
          <span>From</span>
          <input type="date" aria-label="Transfers from date" value={fromDate} max={toDate || undefined} onChange={(event) => updateFilter(setFromDate, event.target.value)} />
        </label>
        <label className="returns-history-control transfers-history-control">
          <span>To</span>
          <input type="date" aria-label="Transfers to date" value={toDate} min={fromDate || undefined} onChange={(event) => updateFilter(setToDate, event.target.value)} />
        </label>
        <label className="returns-history-control transfers-history-control">
          <span>Status</span>
          <SearchableFilter
            value={status}
            ariaLabel="Filter transfers by status"
            placeholder="All statuses"
            options={TRANSFER_STATUSES.map((value) => ({
              value,
              label: value === "all" ? "All statuses" : labelize(value),
            }))}
            onChange={(value) => updateFilter(setStatus, value as (typeof TRANSFER_STATUSES)[number])}
          />
        </label>
        <label className="returns-history-control transfers-history-control">
          <span>Direction</span>
          <SearchableFilter
            value={direction}
            ariaLabel="Filter transfers by direction"
            placeholder="All transfers"
            options={DIRECTIONS.map((value) => ({
              value,
              label: value === "all" ? "All transfers" : labelize(value),
            }))}
            onChange={(value) => updateFilter(setDirection, value as (typeof DIRECTIONS)[number])}
          />
        </label>
        {isAdmin && (
          <label className="returns-history-control transfers-history-control">
            <span>Branch</span>
            <SearchableFilter
              value={branchId}
              ariaLabel="Filter transfers by branch"
              placeholder={isHqAdmin ? "All branches" : "Select branch"}
              options={[
                ...(isHqAdmin ? [{ value: "all", label: "All branches" }] : []),
                ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
              ]}
              onChange={(value) => updateFilter(setBranchId, value)}
            />
          </label>
        )}
        <div className="returns-history-actions transfers-history-actions">
          <button className="button secondary" disabled={loading} onClick={() => setReloadKey((value) => value + 1)} type="button">
            {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={14} />} Refresh
          </button>
          <button className="button link" onClick={clearFilters} type="button">Clear filters</button>
        </div>
      </HorizontalFilterScroller>

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
                <WorkspaceError message={actionError} />
                <div className="returns-detail-actions">
                    {canManageDetails && details.transfer.status === "draft" && (
                      <>
                        <button className="button secondary" disabled={actionBusy} onClick={confirmCancel} type="button">Cancel draft</button>
                        <button className="primary-button" disabled={actionBusy || !details.items.length} onClick={confirmDispatch} type="button">
                          {actionBusy ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />} Dispatch
                        </button>
                      </>
                    )}
                    <button className="button secondary" onClick={() => setSelectedTransferId("")} type="button">Close</button>
                  </div>
                  {canReceiveDetails && details.transfer.status === "dispatched" && (
                    <form className="workspace-form" onSubmit={confirmReceive}>
                      <h3>Confirm received quantities</h3>
                      <p>Enter what actually arrived. Enter 0 for any missing line.</p>
                      <div className="table-wrap">
                        <table>
                          <thead><tr><th>Product</th><th>Sent</th><th>Received</th></tr></thead>
                          <tbody>
                            {details.items.map((line) => (
                              <tr key={line.id}>
                                <td>{line.product_name} <small>{line.unit_code}</small></td>
                                <td>{formatQuantity(line.quantity_milli)} {line.unit_code}</td>
                                <td>
                                  <input
                                    aria-label={`Received quantity for ${line.product_name}`}
                                    inputMode="decimal"
                                    required
                                    value={receiveQuantities[line.id] || ""}
                                    onChange={(event) => setReceiveQuantities((values) => ({ ...values, [line.id]: event.target.value }))}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="workspace-form-actions">
                        <button className="primary-button" disabled={actionBusy || !details.items.length} type="submit">
                          {actionBusy ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />} Confirm receipt
                        </button>
                      </div>
                    </form>
                  )}
                </>
            )}
          </section>
        </div>
      )}
      {createOpen && (
        <WorkspaceDialog
          eyebrow="Transfers"
          onClose={() => {
            if (!actionBusy) {
                setCreateOpen(false);
                setActionError(null);
            }
          }}
          title="New stock transfer"
        >
          <form className="workspace-form" onSubmit={submitCreate}>
            <WorkspaceError message={actionError} />
            <div className="workspace-form-grid">
                <WorkspaceField label="From branch">
                  <select
                    required
                    value={createForm.fromBranchId}
                    onChange={(event) => {
                      const fromBranchId = event.target.value;
                      setCreateForm((form) => ({
                        ...form,
                        fromBranchId,
                        toBranchId: branchesList.find((branch) => branch.id !== fromBranchId)?.id || "",
                        items: [],
                      }));
                    }}
                  >
                    {sourceBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </select>
                </WorkspaceField>
                <WorkspaceField label="To branch">
                  <select
                    required
                    value={createForm.toBranchId}
                    onChange={(event) => setCreateForm((form) => ({ ...form, toBranchId: event.target.value }))}
                  >
                    {branchesList.filter((branch) => branch.id !== createForm.fromBranchId).map((branch) => (
                      <option key={branch.id} value={branch.id}>{branch.name}</option>
                    ))}
                  </select>
                </WorkspaceField>
                <WorkspaceField label="Notes (optional)">
                  <input maxLength={500} value={createForm.notes} onChange={(event) => setCreateForm((form) => ({ ...form, notes: event.target.value }))} />
                </WorkspaceField>
            </div>
            <label className="search-field">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  placeholder="Search products by name, SKU or barcode"
                  value={productSearch}
                  onChange={(event) => setProductSearch(event.target.value)}
                  aria-label="Search transfer products"
                />
            </label>
            <div className="table-wrap">
                <table>
                  <thead><tr><th>Product</th><th>On hand</th><th>Add</th></tr></thead>
                  <tbody>
                    {catalogLoading ? (
                      <tr><td className="empty-cell" colSpan={3}><LoaderCircle size={15} className="spin" /> Loading products…</td></tr>
                    ) : !catalogProducts.length ? (
                      <tr><td className="empty-cell" colSpan={3}>No active products match this search.</td></tr>
                    ) : catalogProducts.map((product) => {
                      const added = createForm.items.some((line) => line.id === product.id);
                      return (
                        <tr key={product.id}>
                          <td>{product.name}<small className="sales-cell-subtext">{product.sku || product.barcode || "No code"} · {product.unit_code}</small></td>
                          <td>{formatQuantity(product.stock_milli)} {product.unit_code}</td>
                          <td>
                            <button className="secondary-button" disabled={added} onClick={() => addProduct(product)} type="button">
                              <Plus size={13} /> {added ? "Added" : "Add"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
            </div>
            {catalogTotal > catalogProducts.length && (
                <p className="form-hint">Showing {catalogProducts.length} of {catalogTotal} products. Search to find other products.</p>
            )}
            {createForm.items.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Selected product</th><th>Quantity</th><th>Remove</th></tr></thead>
                    <tbody>
                      {createForm.items.map((line) => (
                        <tr key={line.id}>
                          <td>{line.name}<small className="sales-cell-subtext">{formatQuantity(line.stock_milli)} {line.unit_code} on hand</small></td>
                          <td>
                            <input
                              aria-label={`Transfer quantity for ${line.name}`}
                              inputMode="decimal"
                              required
                              value={line.quantity}
                              onChange={(event) => setCreateForm((form) => ({
                                ...form,
                                items: form.items.map((selected) => selected.id === line.id
                                  ? { ...selected, quantity: event.target.value }
                                  : selected),
                              }))}
                            />
                          </td>
                          <td>
                            <button
                              aria-label={`Remove ${line.name}`}
                              className="secondary-button"
                              onClick={() => setCreateForm((form) => ({ ...form, items: form.items.filter((selected) => selected.id !== line.id) }))}
                              type="button"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
            )}
            <div className="workspace-form-actions">
                <button className="secondary-button" disabled={actionBusy} onClick={() => setCreateOpen(false)} type="button">Cancel</button>
                <button className="primary-button" disabled={actionBusy || catalogLoading || !createForm.items.length || !createForm.toBranchId} type="submit">
                  {actionBusy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} Create draft
                </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}
