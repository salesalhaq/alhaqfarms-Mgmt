"use client";

import { AlertCircle, CheckCircle2, CreditCard, Eye, LoaderCircle, Package, RefreshCw, Search, Truck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import type { Database } from "@/lib/supabase/database.types";
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
  branch_name?: string;
  paymentProofAvailable?: boolean;
  proofUrl?: string | null;
  allowedActions?: string[];
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
  events?: Array<{
    id: string;
    event_type: string;
    previous_status: string | null;
    next_status: string | null;
    actor_id: string | null;
    actor_name: string;
    notes: string | null;
    occurred_at: string;
  }>;
};

interface StoreOrdersResponse {
  orders?: StoreOrder[];
  error?: string;
}

interface StoreOrderDetailsResponse {
  order?: StoreOrder;
  items?: StoreOrder["items"];
  events?: StoreOrder["events"];
  allowedActions?: string[];
  paymentProofAvailable?: boolean;
  proofUrl?: string | null;
  error?: string;
}

interface StoreOrderActionResponse {
  error?: string;
}

const ORDER_STATUS_OPTIONS = [
  "all",
  "pending",
  "accepted",
  "packed",
  "dispatched",
  "delivered",
  "cancelled",
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

export function StoreOrdersWorkspace({ item, initialOrderId }: { item: WorkspaceModule; initialOrderId?: string }) {
  const { staff, branches } = useStaffAuth();
  const { settings: businessSettings } = useBusinessSettings();
  const openedInitialOrderId = useRef<string | null>(null);
  const [from, to] = useMemo(initialDateRange, []);
  const [fromDate, setFromDate] = useState(from);
  const [toDate, setToDate] = useState(to);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [status, setStatus] = useState<(typeof ORDER_STATUS_OPTIONS)[number]>("all");
  const [customerFilter, setCustomerFilter] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [selected, setSelected] = useState<StoreOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejectingPayment, setRejectingPayment] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
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

  const customerOptions = useMemo(
    () => [...new Set(orders.map((order) => order.customer_name.trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right)),
    [orders],
  );
  const paymentOptions = useMemo(
    () => [...new Set(orders.map((order) => order.payment_review_status === "none"
      ? order.payment_status
      : order.payment_review_status))]
      .sort((left, right) => left.localeCompare(right)),
    [orders],
  );
  const visibleOrders = useMemo(() => orders.filter((order) => (
    (!customerFilter || order.customer_name.trim() === customerFilter)
    && (!paymentFilter || (order.payment_review_status === "none"
      ? order.payment_status
      : order.payment_review_status) === paymentFilter)
  )), [customerFilter, orders, paymentFilter]);
  const hasClientFilters = Boolean(customerFilter || paymentFilter);
  const awaitingReview = orders.filter((order) => order.payment_review_status === "awaiting_review").length;
  const allowedActions = selected?.allowedActions || [];
  const detailAction = selected && (() => {
    if (selected.status === "pending") return ["accept", "Accept order"] as const;
    if (selected.status === "accepted") return ["pack", "Pack order"] as const;
    if (selected.status === "packed" && selected.fulfillment_type === "delivery") return ["dispatch", "Dispatch"] as const;
    if ((selected.status === "packed" && selected.fulfillment_type === "pickup")
        || (selected.status === "dispatched" && selected.fulfillment_type === "delivery")) {
      const needsCollection = ["cash_on_delivery", "pay_at_store"].includes(selected.payment_method)
        && selected.payment_status !== "paid";
      return ["deliver", needsCollection ? "Collect payment & complete" : "Complete handover"] as const;
    }
    return null;
  })();
  const walletPaymentNeedsReview = Boolean(selected
    && ["easypaisa", "jazzcash"].includes(selected.payment_method)
    && selected.payment_status !== "paid");

  const loadOrderDetails = async (orderId: string) => {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    const result = await response.json() as StoreOrderDetailsResponse;
    if (!response.ok || !result.order) {
      throw new Error(result.error || "Could not load order details.");
    }
    setSelected({
      ...result.order,
      items: result.items || [],
      events: result.events || [],
      allowedActions: result.allowedActions || [],
      paymentProofAvailable: Boolean(result.paymentProofAvailable),
      proofUrl: result.proofUrl || null,
    });
  };

  const openDetails = async (order: StoreOrder) => {
    setSelected(order);
    setDetailLoading(true);
    setRejectingPayment(false);
    setRejectionReason("");
    setError(null);
    try {
      await loadOrderDetails(order.id);
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "Could not load order details.");
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (!initialOrderId || !staff || openedInitialOrderId.current === initialOrderId) return;
    openedInitialOrderId.current = initialOrderId;

    let active = true;
    setDetailLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(initialOrderId)}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as StoreOrderDetailsResponse;
        if (!response.ok || !result.order) {
          throw new Error(result.error || "Could not load order details.");
        }
        if (!active) return;
        setSelected({
          ...result.order,
          items: result.items || [],
          events: result.events || [],
          allowedActions: result.allowedActions || [],
          paymentProofAvailable: Boolean(result.paymentProofAvailable),
          proofUrl: result.proofUrl || null,
        });
      } catch (detailError) {
        if (active) setError(detailError instanceof Error ? detailError.message : "Could not load order details.");
      } finally {
        if (active) setDetailLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [initialOrderId, staff]);

  const process = async (action: string, extra: Record<string, boolean | string> = {}) => {
    if (!selected || busy) return;
    if (action === "cancel" && selected.payment_status === "paid"
        && !window.confirm("Issue the customer refund outside the app before continuing. Have you issued it?")) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/workspace/store-orders", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, action, ...extra }),
      });
      const result = await response.json() as StoreOrderActionResponse;
      if (!response.ok) throw new Error(result.error || "Could not update this order.");
      await loadOrderDetails(selected.id);
      setRejectingPayment(false);
      setRejectionReason("");
      setReloadKey((value) => value + 1);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not update this order.");
    } finally {
      setBusy(false);
    }
  };

  const clearFilters = () => {
    const [defaultFrom, defaultTo] = initialDateRange();
    setFromDate(defaultFrom);
    setToDate(defaultTo);
    setBranchId(isAdmin ? "all" : staff?.branch_id || "");
    setStatus("all");
    setCustomerFilter("");
    setPaymentFilter("");
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
        <span>Order actions follow your branch permissions and update payment, stock, sales, and order history together.</span>
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

      <HorizontalFilterScroller className="toolbar online-orders-filterbar" ariaLabel="Online order filters">
        <label className="search-field online-orders-search">
          <Search size={16} />
          <input
            aria-label="Search store orders"
            placeholder="Search order number, customer or phone"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        {isAdmin && (
          <label className="toolbar-control online-orders-filter">
            <span>Branch</span>
            <SearchableFilter
              value={branchId}
              ariaLabel="Filter online orders by branch"
              placeholder="All branches"
              options={[
                { value: "all", label: "All branches" },
                ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
              ]}
              onChange={setBranchId}
            />
          </label>
        )}

        <label className="toolbar-control online-orders-filter">
          <span>Status</span>
          <SearchableFilter
            value={status}
            ariaLabel="Filter online orders by status"
            placeholder="All statuses"
            options={ORDER_STATUS_OPTIONS.map((option) => ({
              value: option,
              label: option === "all" ? "All statuses" : labelize(option),
            }))}
            onChange={(value) => setStatus(value as (typeof ORDER_STATUS_OPTIONS)[number])}
          />
        </label>

        <label className="toolbar-control online-orders-filter">
          <span>Customer</span>
          <SearchableFilter
            value={customerFilter}
            ariaLabel="Filter online orders by customer"
            placeholder="All customers"
            options={[
              { value: "", label: "All customers" },
              ...customerOptions.map((customer) => ({ value: customer, label: customer })),
            ]}
            onChange={setCustomerFilter}
          />
        </label>

        <label className="toolbar-control online-orders-filter">
          <span>Payment</span>
          <SearchableFilter
            value={paymentFilter}
            ariaLabel="Filter online orders by payment"
            placeholder="All payments"
            options={[
              { value: "", label: "All payments" },
              ...paymentOptions.map((payment) => ({ value: payment, label: labelize(payment) })),
            ]}
            onChange={setPaymentFilter}
          />
        </label>

        <label className="toolbar-control online-orders-date">
          <span>From</span>
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label className="toolbar-control online-orders-date">
          <span>To</span>
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>

        <button className="button secondary" onClick={clearFilters} type="button">Clear</button>
        <button className="button secondary" disabled={loading} onClick={() => setReloadKey((value) => value + 1)} type="button">
          {loading ? <LoaderCircle size={15} className="spin" /> : "Refresh"}
        </button>
      </HorizontalFilterScroller>

      {error ? (
        <div className="notice" role="alert"><AlertCircle size={16} /> {error}</div>
      ) : null}

      <section className="card table-wrap" aria-label={`${item.title} list`}>
        <div className="table-document-heading">
          <strong>{item.title}</strong>
          <TableDocumentTools
            tableId={`${item.slug}-table`}
            title={item.title}
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
                    customerFilter ? `Customer: ${customerFilter}` : "",
                    paymentFilter ? `Payment: ${labelize(paymentFilter)}` : "",
                    search ? `Search: ${search}` : "",
                  ].filter(Boolean).join(" · "),
                }, {
                  branding: {
                    businessName: businessSettings.businessName,
                    businessTagline: businessSettings.businessTagline,
                    logoDataUrl: businessSettings.logoDataUrl,
                  },
                  orientationPreference: orientation,
                  branch: reportBranchName,
                  printedBy: staff?.full_name || "Staff",
                })
              : null}
          />
        </div>

        {loading ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading {item.title.toLowerCase()}…</div>
        ) : !visibleOrders.length ? (
          <div className="empty">
            <Search size={23} />
            <h2>{search || hasClientFilters ? "No matching orders" : `No ${item.title.toLowerCase()} found`}</h2>
            <p>{search || hasClientFilters ? "Try another search or change the order filters." : "Orders placed for your branch will appear here once they sync to the cloud."}</p>
          </div>
        ) : (
          <table id={`${item.slug}-table`}>
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
                      <button className="button secondary" onClick={() => void openDetails(order)} type="button">
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
          <section aria-label={`${item.title} details`} aria-modal="true" className="sales-dialog card" role="dialog">
            <header className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Order details</p>
                <h2>{selected.order_number}</h2>
              </div>
              <button aria-label="Close order details" className="button secondary" onClick={() => setSelected(null)} type="button"><X size={16} /></button>
            </header>
            {detailLoading && <div className="loading"><LoaderCircle size={16} className="spin" /> Loading order details…</div>}
            <div className="returns-detail-context">
              <div><span>Customer</span><strong>{selected.customer_name}</strong></div>
              <div><span>Phone</span><strong>{selected.customer_phone}</strong></div>
              <div><span>Branch</span><strong>{selected.branch_name || "Your branch"}</strong></div>
              <div><span>Fulfillment</span><strong>{labelize(selected.fulfillment_type)}</strong></div>
              <div><span>Status</span><strong className={`status ${statusTone(selected.status)}`}>{labelize(selected.status)}</strong></div>
              <div><span>Payment</span><strong>{labelize(selected.payment_method)} · {labelize(selected.payment_review_status === "none" ? selected.payment_status : selected.payment_review_status)}</strong></div>
              <div><span>Placed</span><strong>{formatDateTime(selected.created_at)}</strong></div>
              {selected.delivery_address && <div className="returns-detail-wide"><span>Delivery address</span><strong>{selected.delivery_address}</strong></div>}
              {selected.payment_reference && <div><span>Payment reference</span><strong>{selected.payment_reference}</strong></div>}
              {selected.notes && <div className="returns-detail-wide"><span>Notes</span><strong>{selected.notes}</strong></div>}
              {selected.payment_rejection_reason && <div className="returns-detail-wide"><span>Payment rejection reason</span><strong>{selected.payment_rejection_reason}</strong></div>}
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

            {selected.paymentProofAvailable && allowedActions.includes("verify_payment") && selected.proofUrl && (
              <div className="returns-detail-actions">
                <a className="button secondary" href={selected.proofUrl} rel="noreferrer" target="_blank">
                  <Eye size={13} /> View payment screenshot
                </a>
              </div>
            )}
            {selected.payment_review_status === "awaiting_review" && allowedActions.includes("verify_payment")
              && (!selected.payment_reference || !selected.paymentProofAvailable) && (
                <div className="notice"><AlertCircle size={16} />
                  Verification needs the customer transaction ID and uploaded payment screenshot.
                </div>
              )}
            {selected.payment_review_status === "awaiting_review" && allowedActions.includes("reject_payment")
              && rejectingPayment && (
                <label className="field">
                  <span>Reason to send back to customer</span>
                  <textarea
                    autoFocus
                    maxLength={500}
                    rows={3}
                    value={rejectionReason}
                    onChange={(event) => setRejectionReason(event.target.value)}
                  />
                </label>
              )}
            {selected.payment_status === "paid" && ["pending", "accepted", "packed"].includes(selected.status)
              && allowedActions.includes("cancel") && (
                <div className="notice"><AlertCircle size={16} />
                  Refund the customer outside the app before confirming cancellation.
                </div>
              )}
            <section className="order-event-list" aria-label="Order history">
              <strong>Order history</strong>
              {selected.events?.length ? selected.events.map((event) => (
                <small key={event.id}>
                  {labelize(event.event_type)} · {event.actor_name} · {formatDateTime(event.occurred_at)}
                  {event.notes ? ` · ${event.notes}` : ""}
                </small>
              )) : <small>No order history is recorded.</small>}
            </section>

            <div className="returns-detail-actions">
              {allowedActions.includes("cancel") && ["pending", "accepted", "packed"].includes(selected.status) && (
                <button className="button secondary" disabled={busy || detailLoading} onClick={() => void process("cancel", {
                  refundIssued: selected.payment_status === "paid",
                })} type="button">
                  <X size={13} /> {selected.payment_status === "paid" ? "Confirm refund & cancel" : "Cancel order"}
                </button>
              )}
              {allowedActions.includes("verify_payment") && selected.payment_status === "pending_verification"
                && selected.payment_review_status === "awaiting_review" && (
                  <button className="button secondary" disabled={busy || detailLoading || !selected.payment_reference || !selected.paymentProofAvailable}
                    onClick={() => void process("verify_payment")} type="button">
                    <CreditCard size={13} /> Verify payment
                  </button>
                )}
              {allowedActions.includes("reject_payment") && selected.payment_review_status === "awaiting_review" && (
                <button className="button secondary" disabled={busy || detailLoading || (rejectingPayment && !rejectionReason.trim())}
                  onClick={() => rejectingPayment
                    ? void process("reject_payment", { reason: rejectionReason })
                    : setRejectingPayment(true)} type="button">
                  <X size={13} /> {rejectingPayment ? "Send rejection reason" : "Reject payment"}
                </button>
              )}
              {detailAction && allowedActions.includes(detailAction[0]) && (
                <button className="button" disabled={busy || detailLoading
                  || (["pack", "deliver"].includes(detailAction[0]) && walletPaymentNeedsReview)}
                  onClick={() => void process(detailAction[0], {
                    ...(detailAction[0] === "deliver" && selected.payment_status !== "paid"
                      ? { paymentReceived: true }
                      : {}),
                  })} type="button">
                  {detailAction[0] === "pack" ? <Package size={13} />
                    : detailAction[0] === "dispatch" ? <Truck size={13} />
                      : <CheckCircle2 size={13} />}
                  {detailAction[1]}
                </button>
              )}
              <button className="button secondary" onClick={() => setSelected(null)} type="button">Close</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
