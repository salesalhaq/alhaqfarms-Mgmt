"use client";

import { AlertCircle, ArrowRight, ClipboardList, LoaderCircle, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatDateTime, formatMoney, labelize, statusTone } from "@/lib/format";
import type { Database } from "@/lib/supabase/database.types";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";

type Order = Pick<
  Database["public"]["Tables"]["web_orders"]["Row"],
  | "id" | "order_number" | "branch_id" | "status" | "customer_name"
  | "customer_phone" | "payment_method" | "payment_status"
  | "payment_review_status"   | "total_paisa" | "created_at"
>;

interface OrdersResponse { orders?: Order[]; error?: string; }

export default function OrdersPage() {
  const { staff, branches } = useStaffAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [branchId, setBranchId] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!staff) return;
    let active = true;
    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams({ paymentFilter });
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/orders?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as OrdersResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load online orders.");
        setOrders(result.orders || []);
      } catch (queryError) {
        if (!active) return;
        setError(queryError instanceof Error ? queryError.message : "Could not load online orders.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, paymentFilter, reloadKey, staff]);

  const visibleOrders = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return orders;
    return orders.filter((order) =>
      order.order_number.toLowerCase().includes(needle)
      || order.customer_name.toLowerCase().includes(needle)
      || order.customer_phone.toLowerCase().includes(needle)
    );
  }, [orders, search]);

  const awaitingCount = orders.filter((order) => order.payment_review_status === "awaiting_review").length;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">Store operations</p>
          <h1>Online orders</h1>
          <p>Review order status and submitted payment evidence. Your Supabase staff account limits this list to your assigned branch.</p>
        </div>
        <button className="button secondary" onClick={() => setReloadKey((value) => value + 1)} type="button">
          Refresh
        </button>
      </div>

      <div className="order-summary-row">
        <div className="summary-card">
          <span>Orders loaded</span><strong>{loading ? "…" : orders.length}</strong>
        </div>
        <div className="summary-card">
          <span>Payments awaiting review</span><strong className={awaitingCount ? "highlight" : ""}>{loading ? "…" : awaitingCount}</strong>
        </div>
      </div>

      <div className="toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="Search orders"
            placeholder="Search order number, customer or phone"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {staff?.role === "admin" && !staff.branch_id && (
          <select className="toolbar-select" aria-label="Filter by branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            <option value="">All active branches</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        )}
        <select className="toolbar-select" aria-label="Filter by payment review" value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)}>
          <option value="all">All payment states</option>
          <option value="awaiting_review">Awaiting review</option>
          <option value="verified">Verified</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {error && <div className="notice" role="alert"><AlertCircle size={16} /> {error}</div>}
      <section className="card table-wrap" aria-label="Online order list">
        <div className="table-document-heading">
          <strong>Online orders</strong>
          <TableDocumentTools tableId="online-orders-table" title="Online orders" disabled={loading || Boolean(error) || !visibleOrders.length} />
        </div>
        {loading ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading branch orders…</div>
        ) : !visibleOrders.length ? (
          <div className="empty">
            <ClipboardList size={25} />
            <h2>{search ? "No matching orders" : "No online orders found"}</h2>
            <p>{search ? "Try another search term or filter." : "Orders from the storefront will appear here after they sync to Supabase."}</p>
          </div>
        ) : (
          <table id="online-orders-table">
            <thead>
              <tr><th>Order</th><th>Customer</th><th>Order status</th><th>Payment</th><th>Total</th><th>Placed</th><th aria-label="Open order" /></tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => (
                <tr key={order.id}>
                  <td><span className="primary-cell">{order.order_number}</span><span className="secondary-cell">{labelize(order.payment_method)}</span></td>
                  <td><span className="primary-cell">{order.customer_name}</span><span className="secondary-cell">{order.customer_phone}</span></td>
                  <td><span className={`status ${statusTone(order.status)}`}>{labelize(order.status)}</span></td>
                  <td>
                    <span className={`status ${statusTone(order.payment_review_status === "none" ? order.payment_status : order.payment_review_status)}`}>
                      {labelize(order.payment_review_status === "none" ? order.payment_status : order.payment_review_status)}
                    </span>
                  </td>
                  <td className="nowrap">{formatMoney(order.total_paisa)}</td>
                  <td className="nowrap">{formatDateTime(order.created_at)}</td>
                  <td><Link className="row-link" aria-label={`View ${order.order_number}`} href={`/orders/${order.id}`}><ArrowRight size={16} /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {!loading && orders.length === 100 && (
        <p className="list-limit-note">Showing the latest 100 matching orders. Narrow the list with search or filters.</p>
      )}
    </>
  );
}
