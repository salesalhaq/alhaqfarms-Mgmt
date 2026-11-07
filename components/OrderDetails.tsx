"use client";

import { AlertCircle, ArrowLeft, ExternalLink, FileImage, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatDateTime, formatMoney, labelize, statusTone } from "@/lib/format";
import type { Database } from "@/lib/supabase/database.types";

type Order = Database["public"]["Tables"]["web_orders"]["Row"];
type Item = Database["public"]["Tables"]["web_order_items"]["Row"];
type Event = Database["public"]["Tables"]["web_order_events"]["Row"];

interface LoadedOrder {
  order: Order;
  items: Item[];
  events: Event[];
  proofUrl: string | null;
}
interface OrderResponse extends Partial<LoadedOrder> { error?: string; }

export function OrderDetails({ orderId }: { orderId: string }) {
  const { staff } = useStaffAuth();
  const [result, setResult] = useState<LoadedOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!staff) return;
    let active = true;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const data = await response.json() as OrderResponse;
        if (!response.ok) throw new Error(data.error || "Could not load the order.");
        if (!data.order || !data.items || !data.events) {
          throw new Error("The server returned incomplete order details.");
        }

        if (active) {
          setResult({
            order: data.order,
            items: data.items,
            events: data.events,
            proofUrl: data.proofUrl || null,
          });
        }
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the order.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [orderId, staff]);

  if (loading) return <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading order details…</div>;
  if (error || !result) {
    return (
      <>
        <Link className="detail-back" href="/orders"><ArrowLeft size={15} /> Back to orders</Link>
        <div className="notice" role="alert"><AlertCircle size={16} /> {error || "Order details are unavailable."}</div>
      </>
    );
  }

  const { order, items, events, proofUrl } = result;
  const reviewStatus = order.payment_review_status === "none" ? order.payment_status : order.payment_review_status;

  return (
    <>
      <Link className="detail-back" href="/orders"><ArrowLeft size={15} /> Back to orders</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">Online order</p>
          <h1>{order.order_number}</h1>
          <p>Placed {formatDateTime(order.created_at)} · {labelize(order.fulfillment_type)}</p>
        </div>
        <span className={`status ${statusTone(order.status)}`}>{labelize(order.status)}</span>
      </div>

      <div className="detail-grid">
        <div className="detail-stack">
          <section className="card panel">
            <h2>Customer and delivery</h2>
            <dl className="facts">
              <div className="fact"><dt>Customer</dt><dd>{order.customer_name}</dd></div>
              <div className="fact"><dt>Phone</dt><dd>{order.customer_phone}</dd></div>
              <div className="fact wide"><dt>Delivery address</dt><dd>{order.delivery_address || "Pickup / no delivery address"}</dd></div>
              {order.notes && <div className="fact wide"><dt>Order notes</dt><dd>{order.notes}</dd></div>}
            </dl>
          </section>

          <section className="card panel">
            <h2>Items <span className="muted">({items.length})</span></h2>
            {items.length ? (
              <div className="line-list">
                {items.map((item) => (
                  <div className="line-item" key={item.id}>
                    <div>
                      <strong>{item.product_name}</strong>
                      <small>{item.sku ? `${item.sku} · ` : ""}{(item.quantity_milli / 1000).toLocaleString("en-PK")} {item.unit_code} × {formatMoney(item.unit_price_paisa)}</small>
                    </div>
                    <strong>{formatMoney(item.line_total_paisa)}</strong>
                  </div>
                ))}
                <div className="line-item order-total"><strong>Order total</strong><strong>{formatMoney(order.total_paisa)}</strong></div>
              </div>
            ) : <p className="muted">No item details are available for this order.</p>}
          </section>

          <section className="card panel">
            <h2>Order history</h2>
            {events.length ? (
              <div className="timeline">
                {events.map((event) => (
                  <div className="timeline-item" key={event.id}>
                    <strong>{labelize(event.event_type)}</strong>
                    {event.notes && <p className="timeline-note">{event.notes}</p>}
                    <small>{formatDateTime(event.occurred_at)}{event.actor_id ? " · Staff action" : ""}</small>
                  </div>
                ))}
              </div>
            ) : <p className="muted">No order events have been recorded yet.</p>}
          </section>
        </div>

        <aside className="detail-stack">
          <section className="card panel payment-panel">
            <h2>Payment review</h2>
            <dl className="facts">
              <div className="fact"><dt>Method</dt><dd>{labelize(order.payment_method)}</dd></div>
              <div className="fact"><dt>Payment status</dt><dd><span className={`status ${statusTone(order.payment_status)}`}>{labelize(order.payment_status)}</span></dd></div>
              <div className="fact"><dt>Review</dt><dd><span className={`status ${statusTone(reviewStatus)}`}>{labelize(reviewStatus)}</span></dd></div>
              {order.payment_reference && <div className="fact"><dt>Transaction reference</dt><dd>{order.payment_reference}</dd></div>}
              {order.payment_verified_at && <div className="fact"><dt>Verified at</dt><dd>{formatDateTime(order.payment_verified_at)}</dd></div>}
              {order.payment_rejection_reason && <div className="fact wide"><dt>Rejection reason</dt><dd>{order.payment_rejection_reason}</dd></div>}
            </dl>
            {proofUrl ? (
              <a className="proof-link" href={proofUrl} target="_blank" rel="noreferrer">
                <FileImage size={16} /> View payment screenshot <ExternalLink size={13} />
              </a>
            ) : order.payment_method === "jazzcash" || order.payment_method === "easypaisa" ? (
              <p className="disclaimer">No payment screenshot is attached to this order.</p>
            ) : null}
            <p className="disclaimer">This first web milestone is read-only. Payment verification and order-state actions remain in the Windows app until a server-side transaction safely enforces the same permissions and conflict rules.</p>
          </section>
        </aside>
      </div>
    </>
  );
}
