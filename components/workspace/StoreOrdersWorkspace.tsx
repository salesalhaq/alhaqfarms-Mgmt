"use client";

import { AlertCircle, CheckCircle2, CreditCard, Eye, LoaderCircle, Package, RefreshCw, Search, Truck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import type { Database } from "@/lib/supabase/database.types";
import { DEFAULT_BRAND_NAME } from "@/lib/branding";
import { formatReportDate } from "@/lib/print/document";
import { generateOnlineOrdersDocument } from "@/lib/print/reports";

type StoreOrder = Pick<
  Database["public"]["Tables"]["web_orders"]["Row"],
  | "id"
  | "order_number"
  | "branch_id"
  | "status"
  | "fulfillment_type"
  | "customer_name"
  | "customer_phone"
  | "delivery_address"
  | "payment_method"
  | "payment_status"
  | "payment_review_status"
  | "payment_reference"
  | "payment_rejection_reason"
  | "subtotal_paisa"
  | "tax_paisa"
  | "total_paisa"
  | "notes"
  | "packed_at"
  | "dispatched_at"
  | "delivered_at"
  | "cancelled_at"
  | "created_at"
> & {
  items?: Array<{
    id: string;
    order_id: string;
    line_number: number;
    product_name: string;
    sku: string | null;
    unit_code: string;
    quantity_milli: number;
    unit_price_paisa: number;
    tax_paisa: number;
    line_total_paisa: number;
  }>;
};

interface StoreOrdersResponse {
  orders?: StoreOrder[];
  error?: string;
}

const ORDER_STATUS_OPTIONS = [
  "all",
  "pending",
  "paid",
  "processing",
  "packed",
  "ready_for_pickup",
  "completed",
  "cancelled",
  "rejected",
] as const;

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

export function StoreOrdersWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [from, to] = useMemo(initialDateRange, []);
  const [fromDate, setFromDate] = useState(from);
  const [toDate, setToDate] = useState(to);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [status, setStatus] = useState<(typeof ORDER_STATUS_OPTIONS)[number]>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [selected, setSelected] = useState<StoreOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const isAdmin = staff?.role === "admin";
  const reportBranchName = branchId === "all"
    ? "All branches"
    : branches.find((branch) => branch.id === branchId)?.name || "Your branch";

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (staff?.role === "admin" && !branchId) setBranchId("all");
    else if (staff?.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff?.branch_id, staff?.role]);

  useEffect(() => {
    if (!staff) {
      setLoading(false);
      return undefined;
    }

    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams({
      from: fromDate,
      to: toDate,
      status,
    });
    if (branchId && branchId !== "all") parameters.set("branchId", branchId);
    if (debouncedSearch) parameters.set("search", debouncedSearch);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/store-orders?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as StoreOrdersResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load store orders.");
        setOrders(result.orders || []);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load store orders.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [branchId, debouncedSearch, fromDate, reloadKey, staff, status, toDate]);

  const visibleOrders = useMemo(() => orders, [orders]);
  const awaitingReview = orders.filter((order) => order.payment_review_status === "awaiting_review").length;

  const clearFilters = () => {
    const [defaultFrom, defaultTo] = initialDateRange();
    setFromDate(defaultFrom);
    setToDate(defaultTo);
    setBranchId(isAdmin ? "all" : staff?.branch_id || "");
    setStatus("all");
    setSearch("");
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description}</p>
        </div>
        <button
          className="secondary-button"
          onClick={() => setReloadKey((value) => value + 1)}
          disabled={loading}
          type="button"
        >
          {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>

      <div className="live-readonly-note">
        <AlertCircle size={16} />
        <span>Live branch records · read-only. Updates and fulfillment actions remain disabled until the verified workflow is available.</span>
      </div>

      <div className="order-summary-row">
        <div className="summary-card">
          <span>Orders loaded</span>
          <strong>{loading ? "…" : orders.length}</strong>
        </div>
        <div className="summary-card">
          <span>Awaiting payment review</span>
          <strong className={awaitingReview ? "highlight" : ""}>{loading ? "…" : awaitingReview}</strong>
        </div>
      </div>

      <div className="toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="Search store orders"
            placeholder="Search order number, customer or phone"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        {isAdmin && (
          <select
            aria-label="Filter by branch"
            className="toolbar-select"
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
          >
            <option value="all">All branches</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>{branch.name}</option>
            ))}
          </select>
        )}

        <select
          aria-label="Filter by order status"
          className="toolbar-select"
          value={status}
          onChange={(event) => setStatus(event.target.value as (typeof ORDER_STATUS_OPTIONS)[number])}
        >
          {ORDER_STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>{option === "all" ? "All statuses" : labelize(option)}</option>
          ))}
        </select>

        <label className="toolbar-control">
          <span>From</span>
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label className="toolbar-control">
          <span>To</span>
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>

        <button className="button secondary" onClick={clearFilters} type="button">Clear</button>
        <button className="button secondary" disabled={loading} onClick={() => setReloadKey((value) => value + 1)} type="button">
          {loading ? <LoaderCircle size={15} className="spin" /> : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="notice" role="alert"><AlertCircle size={16} /> {error}</div>
      ) : null}

      <section className="card table-wrap" aria-label="Store order list">
        <div className="table-document-heading">
          <strong>Store orders</strong>
          <TableDocumentTools
            tableId="store-orders-table"
            title="Store orders"
            orientationKey="online-orders"
            disabled={loading || Boolean(error) || !visibleOrders.length}
            buildDocument={(orientation) => visibleOrders.length
              ? generateOnlineOrdersDocument({
                  rows: visibleOrders.map((order) => ({
                    order_number: order.order_number,
                    customer_name: order.customer_name,
                    item_count: order.items?.length || 0,
                    total_paisa: order.total_paisa,
                    payment_method: order.payment_method,
                    payment_status: order.payment_status,
                    payment_review_status: order.payment_review_status,
                    status: order.status,
                    created_at: order.created_at,
                  })),
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

        {loading ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading store orders…</div>
        ) : !visibleOrders.length ? (
          <div className="empty">
            <Search size={23} />
            <h2>{search ? "No matching store orders" : "No store orders found"}</h2>
            <p>{search ? "Try another search or change the status/date filters." : "Orders placed for your branch will appear here once they sync to the cloud."}</p>
          </div>
        ) : (
          <table id="store-orders-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Total</th>
                <th>Placed</th>
                <th aria-label="Order actions">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => {
                const paymentState = order.payment_review_status === "none" ? order.payment_status : order.payment_review_status;
                return (
                  <tr key={order.id}>
                    <td>
                      <span className="primary-cell">{order.order_number}</span>
                      <span className="secondary-cell">{labelize(order.payment_method)}</span>
                    </td>
                    <td>
                      <span className="primary-cell">{order.customer_name}</span>
                      <span className="secondary-cell">{order.customer_phone}</span>
                    </td>
                    <td>{order.items?.length ? `${order.items.length} line${order.items.length === 1 ? "" : "s"}` : "—"}</td>
                    <td><span className={`status ${statusTone(order.status)}`}>{labelize(order.status)}</span></td>
                    <td>
                      <span className={`status ${statusTone(paymentState)}`}>
                        {labelize(paymentState)}
                      </span>
                    </td>
                    <td className="nowrap">{formatMoney(order.total_paisa)}</td>
                    <td className="nowrap">{formatDateTime(order.created_at)}</td>
                    <td>
                      <button className="button secondary" onClick={() => setSelected(order)} type="button">
                        <Eye size={14} /> Details
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {selected && (
        <div className="sales-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
        }}>
          <section aria-label="Store order details" aria-modal="true" className="sales-dialog card" role="dialog">
            <header className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Order details</p>
                <h2>{selected.order_number}</h2>
              </div>
              <button aria-label="Close order details" className="button secondary" onClick={() => setSelected(null)} type="button"><X size={16} /></button>
            </header>
            <div className="returns-detail-context">
              <div><span>Customer</span><strong>{selected.customer_name}</strong></div>
              <div><span>Phone</span><strong>{selected.customer_phone}</strong></div>
              <div><span>Fulfillment</span><strong>{labelize(selected.fulfillment_type)}</strong></div>
              <div><span>Status</span><strong className={`status ${statusTone(selected.status)}`}>{labelize(selected.status)}</strong></div>
              <div><span>Payment</span><strong>{labelize(selected.payment_method)} · {labelize(selected.payment_review_status === "none" ? selected.payment_status : selected.payment_review_status)}</strong></div>
              <div><span>Placed</span><strong>{formatDateTime(selected.created_at)}</strong></div>
              {selected.delivery_address && <div className="returns-detail-wide"><span>Delivery address</span><strong>{selected.delivery_address}</strong></div>}
              {selected.payment_reference && <div><span>Payment reference</span><strong>{selected.payment_reference}</strong></div>}
              {selected.notes && <div className="returns-detail-wide"><span>Notes</span><strong>{selected.notes}</strong></div>}
            </div>

            <div className="returns-detail-items">
              <div className="returns-detail-item returns-detail-item-heading"><span>Item</span><span>Qty</span><strong>Total</strong></div>
              {(selected.items || []).map((line) => (
                <div className="returns-detail-item" key={line.id}>
                  <div><strong>{line.product_name}</strong><small>{line.sku || line.unit_code}</small></div>
                  <span>{formatQuantity(line.quantity_milli)} {line.unit_code}</span>
                  <strong>{formatMoney(line.line_total_paisa)}</strong>
                </div>
              ))}
              {!(selected.items || []).length && <p>No item lines are recorded for this order.</p>}
            </div>

            <div className="returns-detail-totals">
              <div><span>Subtotal</span><strong>{formatMoney(selected.subtotal_paisa)}</strong></div>
              <div><span>Tax</span><strong>{formatMoney(selected.tax_paisa)}</strong></div>
              <div><span>Total</span><strong>{formatMoney(selected.total_paisa)}</strong></div>
            </div>

            <div className="returns-detail-actions">
              <button className="button secondary" disabled title="Opening payment screenshots is a Windows desktop workflow." type="button">
                <Eye size={13} /> View payment screenshot
              </button>
              <button className="button secondary" disabled title="Verifying online payments is a Windows desktop workflow." type="button">
                <CreditCard size={13} /> Verify payment
              </button>
              <button className="button secondary" disabled title="Rejecting online payments is a Windows desktop workflow." type="button">
                <X size={13} /> Reject payment
              </button>
              <button className="button secondary" disabled title="Packing orders is a Windows desktop workflow." type="button">
                <Package size={13} /> Pack
              </button>
              <button className="button secondary" disabled title="Dispatching orders is a Windows desktop workflow." type="button">
                <Truck size={13} /> Dispatch
              </button>
              <button className="button secondary" disabled title="Completing order handover is a Windows desktop workflow." type="button">
                <CheckCircle2 size={13} /> Complete
              </button>
              <button className="button secondary" disabled title="Cancelling orders is a Windows desktop workflow." type="button">
                Cancel order
              </button>
              <button className="button secondary" onClick={() => setSelected(null)} type="button">Close</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
