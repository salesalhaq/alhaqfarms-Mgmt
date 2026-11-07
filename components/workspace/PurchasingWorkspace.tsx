"use client";

import { AlertCircle, Eye, LoaderCircle, Plus, RefreshCw, Search, Truck, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { DEFAULT_BRAND_NAME } from "@/lib/branding";
import { generateSupplierDirectoryDocument } from "@/lib/print/reports";

interface PurchaseOrder {
  id: string;
  branch_id: string;
  branch_name: string;
  supplier_name: string;
  order_number: string;
  status: string;
  expected_at: string | null;
  ordered_total_paisa: number;
  ordered_at: string;
  product_count?: number;
  received_quantity_milli?: number;
}

interface PurchaseReceipt {
  id: string;
  branch_id: string;
  branch_name: string;
  supplier_name: string;
  supplier_invoice_number: string | null;
  purchase_order_id: string | null;
  subtotal_paisa: number;
  received_at: string;
  product_count?: number;
  paid_paisa?: number;
  due_paisa?: number;
  received_by_name?: string | null;
}

interface SupplierRow {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  is_active: boolean;
}

interface PurchaseLine {
  id: string;
  product_name: string;
  unit_code: string;
  ordered_quantity_milli?: number;
  received_quantity_milli?: number;
  quantity_milli?: number;
  replacement_quantity_milli?: number;
  unit_cost_paisa: number;
  line_total_paisa: number;
}

interface SupplierPayment {
  id: string;
  method: string;
  amount_paisa: number;
  reference: string | null;
  notes: string | null;
  paid_at: string;
  paid_by_name: string | null;
}

interface PurchaseResponse {
  orders?: PurchaseOrder[];
  receipts?: PurchaseReceipt[];
  suppliers?: SupplierRow[];
  limit?: number;
  error?: string;
}

interface PurchaseDetailResponse {
  kind: "order" | "receipt";
  record: (PurchaseOrder | PurchaseReceipt) & {
    notes: string | null;
    supplier_name: string;
    branch_name: string;
  };
  items: PurchaseLine[];
  payments?: SupplierPayment[];
  linkedReceipts?: Pick<PurchaseReceipt, "id" | "supplier_invoice_number" | "subtotal_paisa" | "received_at">[];
  error?: string;
}

type View = "suppliers" | "orders" | "receipts";

export function PurchasingWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [view, setView] = useState<View>("orders");
  const [branchId, setBranchId] = useState(staff?.role === "admin" && !staff.branch_id ? "all" : staff?.branch_id || "");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [data, setData] = useState<PurchaseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState<PurchaseDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const isHqAdmin = staff?.role === "admin" && !staff.branch_id;
  const canView = staff?.role === "admin" || staff?.role === "manager";
  const orders = data?.orders || [];
  const receipts = data?.receipts || [];
  const suppliers = data?.suppliers || [];
  const visibleRows = view === "orders" ? orders : view === "receipts" ? receipts : suppliers;
  const reportBranchName = branchId === "all"
    ? "All branches"
    : branches.find((branch) => branch.id === branchId)?.name || "Your branch";
  const supplierPurchases = new Map<string, number>();
  for (const receipt of receipts) {
    supplierPurchases.set(
      receipt.supplier_name,
      (supplierPurchases.get(receipt.supplier_name) || 0) + Number(receipt.subtotal_paisa || 0),
    );
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (staff?.role === "admin" && !staff.branch_id && !branchId) setBranchId("all");
    else if (staff?.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff?.branch_id, staff?.role]);

  useEffect(() => {
    if (!staff) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    setData(null);
    setDetail(null);
    const parameters = new URLSearchParams();
    if (branchId) parameters.set("branchId", branchId);
    if (debouncedSearch) parameters.set("search", debouncedSearch);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/purchasing?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as PurchaseResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load purchasing records.");
        setData(result);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load purchasing records.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, debouncedSearch, reloadKey, staff]);

  const openDetails = async (kind: "orders" | "receipts", id: string) => {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const parameters = new URLSearchParams({ kind: kind === "orders" ? "order" : "receipt", detailId: id });
    if (branchId) parameters.set("branchId", branchId);
    try {
      const response = await fetch(`/api/workspace/purchasing?${parameters.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as PurchaseDetailResponse;
      if (!response.ok) throw new Error(result.error || "Could not load purchase details.");
      setDetail(result);
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "Could not load purchase details.");
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetails = () => {
    setDetail(null);
    setDetailError(null);
  };

  const tableId = `purchasing-${view}-${branchId || "branch"}`;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>Review suppliers, purchase orders, and received stock. This workspace is read-only; creating orders, receiving deliveries, paying suppliers, and supplier returns stay in the Windows desktop app.</p>
        </div>
        <div className="heading-actions">
          <Link className="secondary-button" href="/workspace/vendors">
            <Truck size={14} /> Add supplier → Vendors
          </Link>
          <button className="primary-button" type="button" disabled title="Creating purchase orders is a Windows desktop workflow.">
            <Plus size={14} /> Create purchase order
          </button>
          <button className="secondary-button" type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
      </div>

      {!canView && (
        <div className="notice" role="alert">
          Purchasing records are available to managers and admins only.
        </div>
      )}

      {canView && (
        <>
          <section className="dashboard-stats" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }} aria-label="Purchasing summary">
            <article className="dashboard-stat card"><span>Suppliers</span><strong>{suppliers.length}</strong></article>
            <article className="dashboard-stat card"><span>Purchase orders</span><strong>{orders.length}</strong></article>
            <article className="dashboard-stat card"><span>Receipts</span><strong>{receipts.length}</strong></article>
          </section>

          <section className="card">
            <div className="workspace-toolbar">
              <label className="search-field">
                <Search size={17} aria-hidden="true" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search order, invoice, supplier or notes"
                  aria-label="Search purchasing records"
                />
                {search && (
                  <button type="button" className="secondary-button" onClick={() => setSearch("")} aria-label="Clear search">
                    Clear
                  </button>
                )}
              </label>
              {isHqAdmin && (
                <label className="toolbar-control">
                  <span>Branch</span>
                  <select className="toolbar-select" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                    <option value="all">All branches</option>
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </select>
                </label>
              )}
              <TableDocumentTools
                tableId={tableId}
                title={`Purchasing · ${view}`}
                orientationKey={view === "suppliers" ? "supplier-directory" : `purchasing-${view}`}
                disabled={loading || Boolean(error) || !visibleRows.length}
                buildDocument={view === "suppliers"
                  ? (orientation) => suppliers.length
                    ? generateSupplierDirectoryDocument({
                        rows: suppliers.map((supplier) => ({
                          name: supplier.name,
                          contact_name: supplier.contact_name,
                          phone: supplier.phone,
                          email: supplier.email,
                          is_active: supplier.is_active,
                          purchased_paisa: supplierPurchases.get(supplier.name) ?? null,
                        })),
                        branchName: reportBranchName,
                      }, {
                        branding: { businessName: DEFAULT_BRAND_NAME },
                        orientationPreference: orientation,
                        branch: reportBranchName,
                        printedBy: staff?.full_name || "Staff",
                      })
                    : null
                  : undefined}
              />
            </div>

            <div className="workspace-tabs" role="tablist" aria-label="Purchasing record type">
              <button type="button" role="tab" aria-selected={view === "suppliers"} className={view === "suppliers" ? "primary-button" : "secondary-button"} onClick={() => { setView("suppliers"); closeDetails(); }}>
                Suppliers
              </button>
              <button type="button" role="tab" aria-selected={view === "orders"} className={view === "orders" ? "primary-button" : "secondary-button"} onClick={() => { setView("orders"); closeDetails(); }}>
                Purchase orders
              </button>
              <button type="button" role="tab" aria-selected={view === "receipts"} className={view === "receipts" ? "primary-button" : "secondary-button"} onClick={() => { setView("receipts"); closeDetails(); }}>
                Receipts
              </button>
            </div>

            {error && <div className="notice" role="alert"><AlertCircle size={17} /> {error}</div>}
            {loading && <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading purchasing records…</div>}
            {!loading && !error && (
              <>
                <div className="table-wrap">
                  <table id={tableId}>
                    <thead>
                      {view === "suppliers" ? (
                        <tr>
                          <th>Supplier</th><th>Contact</th><th>Phone</th><th>Email</th><th>Status</th>
                        </tr>
                      ) : view === "orders" ? (
                        <tr>
                          <th>Order</th>
                          {isHqAdmin && <th>Branch</th>}
                          <th>Supplier</th><th>Ordered</th><th>Expected</th><th className="numeric-cell">Products</th>
                          <th className="numeric-cell">Received qty</th><th className="numeric-cell">Order total</th><th>Status</th><th>Actions</th>
                        </tr>
                      ) : (
                        <tr>
                          <th>Received</th>
                          {isHqAdmin && <th>Branch</th>}
                          <th>Supplier</th><th>Supplier invoice</th><th className="numeric-cell">Products</th>
                          <th className="numeric-cell">Total</th><th className="numeric-cell">Paid</th>
                          <th className="numeric-cell">Outstanding</th><th>Received by</th><th>Actions</th>
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {!visibleRows.length ? (
                        <tr><td colSpan={
                          view === "suppliers" ? 5
                            : view === "orders" ? (isHqAdmin ? 10 : 9)
                              : (isHqAdmin ? 10 : 9)
                        } className="empty-cell">
                          {search ? "No records match this search." : view === "suppliers" ? "No suppliers found for this scope." : `No purchase ${view} found for this branch.`}
                        </td></tr>
                      ) : view === "suppliers" ? (
                        suppliers.map((supplier) => (
                          <tr key={supplier.id}>
                            <td><span className="primary-cell">{supplier.name}</span></td>
                            <td>{supplier.contact_name || "—"}</td>
                            <td>{supplier.phone || "—"}</td>
                            <td>{supplier.email || "—"}</td>
                            <td><span className={`status ${supplier.is_active ? "green" : "grey"}`}>{supplier.is_active ? "Active" : "Inactive"}</span></td>
                          </tr>
                        ))
                      ) : view === "orders" ? (
                        orders.map((order) => (
                          <tr key={order.id}>
                            <td><span className="primary-cell">{order.order_number}</span></td>
                            {isHqAdmin && <td>{order.branch_name}</td>}
                            <td>{order.supplier_name}</td>
                            <td className="nowrap">{formatDateTime(order.ordered_at)}</td>
                            <td className="nowrap">{order.expected_at ? formatDateTime(order.expected_at) : "—"}</td>
                            <td className="numeric-cell">{order.product_count ?? 0}</td>
                            <td className="numeric-cell">{formatQuantity(order.received_quantity_milli || 0)}</td>
                            <td className="numeric-cell">{formatMoney(order.ordered_total_paisa)}</td>
                            <td><span className={`status ${statusTone(order.status)}`}>{labelize(order.status)}</span></td>
                            <td className="row-actions">
                              <button type="button" className="secondary-button" onClick={() => void openDetails("orders", order.id)}>
                                <Eye size={15} /> {["ordered", "partially_received"].includes(order.status) ? "Receive PO" : "Details"}
                              </button>
                              <button type="button" className="secondary-button" disabled title="Cancelling purchase orders is a Windows desktop workflow.">Cancel</button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        receipts.map((receipt) => (
                          <tr key={receipt.id}>
                            <td className="nowrap">{formatDateTime(receipt.received_at)}</td>
                            {isHqAdmin && <td>{receipt.branch_name}</td>}
                            <td>{receipt.supplier_name}</td>
                            <td><span className="primary-cell">{receipt.supplier_invoice_number || "No invoice"}</span></td>
                            <td className="numeric-cell">{receipt.product_count ?? 0}</td>
                            <td className="numeric-cell">{formatMoney(receipt.subtotal_paisa)}</td>
                            <td className="numeric-cell">{formatMoney(receipt.paid_paisa || 0)}</td>
                            <td className="numeric-cell">{formatMoney(receipt.due_paisa || 0)}</td>
                            <td>{receipt.received_by_name || "—"}</td>
                            <td className="row-actions">
                              <button type="button" className="secondary-button" onClick={() => void openDetails("receipts", receipt.id)}><Eye size={15} /> Details</button>
                              <button type="button" className="secondary-button" disabled title="Returning stock to a supplier is a Windows desktop workflow.">Return stock</button>
                              <button type="button" className="secondary-button" disabled title="Recording supplier payments is a Windows desktop workflow.">Pay</button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                {data?.limit && visibleRows.length === data.limit && <p className="form-hint">Showing up to {data.limit} records of each type. Narrow the branch or search to find older records.</p>}
              </>
            )}
          </section>

          {(detailLoading || detailError || detail) && (
            <section className="card purchasing-detail" aria-live="polite">
              <div className="section-heading">
                <h2>{detail ? (detail.kind === "order" ? `Purchase order ${(detail.record as PurchaseOrder).order_number}` : "Purchase receipt details") : "Purchase details"}</h2>
                <button type="button" className="secondary-button" onClick={closeDetails} aria-label="Close details"><X size={17} /> Close</button>
              </div>
              {detailLoading && <div className="loading"><LoaderCircle size={18} className="spin" /> Loading purchase details…</div>}
              {detailError && <div className="notice" role="alert">{detailError}</div>}
              {detail && (
                <>
                  <div className="detail-meta">
                    <div><span>Branch</span><strong>{detail.record.branch_name}</strong></div>
                    <div><span>Supplier</span><strong>{detail.record.supplier_name}</strong></div>
                    <div><span>{detail.kind === "order" ? "Order date" : "Received"}</span><strong>{formatDateTime(detail.kind === "order" ? (detail.record as PurchaseOrder).ordered_at : (detail.record as PurchaseReceipt).received_at)}</strong></div>
                    <div><span>Total</span><strong>{formatMoney(detail.kind === "order" ? (detail.record as PurchaseOrder).ordered_total_paisa : (detail.record as PurchaseReceipt).subtotal_paisa)}</strong></div>
                  </div>
                  {detail.record.notes && <p>{detail.record.notes}</p>}
                  <div className="heading-actions" style={{ marginBottom: "12px" }}>
                    {detail.kind === "order" ? (
                      <>
                        <button className="primary-button" type="button" disabled title="Recording deliveries is a Windows desktop workflow.">Record delivery</button>
                        <button className="secondary-button" type="button" disabled title="Cancelling purchase orders is a Windows desktop workflow.">Cancel order</button>
                      </>
                    ) : (
                      <>
                        <button className="secondary-button" type="button" disabled title="Returning stock to a supplier is a Windows desktop workflow.">Return stock</button>
                        <button className="secondary-button" type="button" disabled title="Recording supplier payments is a Windows desktop workflow.">Record supplier payment</button>
                      </>
                    )}
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Product</th><th>Quantity</th>{detail.kind === "order" && <th>Received</th>}<th className="numeric-cell">Unit cost</th><th className="numeric-cell">Line total</th></tr></thead>
                      <tbody>
                        {!detail.items.length ? <tr><td colSpan={detail.kind === "order" ? 5 : 4} className="empty-cell">No purchase lines are available.</td></tr> : detail.items.map((line) => (
                          <tr key={line.id}>
                            <td>{line.product_name}</td>
                            <td>{formatQuantity(detail.kind === "order" ? line.ordered_quantity_milli || 0 : line.quantity_milli || 0)} {line.unit_code}</td>
                            {detail.kind === "order" && <td>{formatQuantity(line.received_quantity_milli || 0)} {line.unit_code}</td>}
                            <td className="numeric-cell">{formatMoney(line.unit_cost_paisa)}</td>
                            <td className="numeric-cell">{formatMoney(line.line_total_paisa)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {detail.linkedReceipts && detail.linkedReceipts.length > 0 && (
                    <div className="purchasing-linked-receipts">
                      <h3>Linked receipts</h3>
                      {detail.linkedReceipts.map((receipt) => (
                        <div key={receipt.id}>
                          <span>{formatDateTime(receipt.received_at)} · {receipt.supplier_invoice_number || "No invoice"}</span>
                          <strong>{formatMoney(receipt.subtotal_paisa)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                  {detail.kind === "receipt" && detail.payments && detail.payments.length > 0 && (
                    <div className="purchasing-linked-receipts">
                      <h3>Payment history</h3>
                      {detail.payments.map((payment) => (
                        <div key={payment.id}>
                          <span>{formatDateTime(payment.paid_at)} · {labelize(payment.method)} · {payment.paid_by_name || "Staff member"}{payment.reference ? ` · ${payment.reference}` : ""}</span>
                          <strong>{formatMoney(payment.amount_paisa)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}

export default PurchasingWorkspace;
