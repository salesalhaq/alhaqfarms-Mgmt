"use client";

import { AlertCircle, Eye, LoaderCircle, Plus, RefreshCw, Save, Search, Truck, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { WorkspaceDialog, WorkspaceError, WorkspaceField, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import { postWorkspaceAction } from "@/lib/workspace/write-client";
import type { WorkspaceModule } from "@/lib/workspace-modules";
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
  remaining_quantity_milli?: number;
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
  returned_paisa?: number;
  received_by_name?: string | null;
}

interface ProductOption {
  id: string;
  name: string;
  unit_code: string;
  cost_price_paisa: number;
  is_active: boolean;
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
  product_id?: string;
  remaining_quantity_milli?: number;
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
  products?: ProductOption[];
  branches?: Array<{ id: string; name: string }>;
  permissions?: {
    canCreateOrders: boolean;
    canReceiveOrders: boolean;
    canCancelOrders: boolean;
    canManageVendors: boolean;
  };
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
  returns?: Array<{
    id: string;
    reason: string;
    disposition: string;
    notes: string | null;
    total_paisa: number;
    returned_at: string;
  }>;
  linkedReceipts?: Pick<PurchaseReceipt, "id" | "supplier_invoice_number" | "subtotal_paisa" | "received_at">[];
  error?: string;
}

type View = "suppliers" | "orders" | "receipts";

interface OrderForm {
  supplierId: string;
  branchId: string;
  expectedAt: string;
  notes: string;
  items: Array<{ productId: string; quantity: string; unitCost: string }>;
}

interface PaymentForm {
  method: string;
  amount: string;
  reference: string;
  notes: string;
}

interface SupplierReturnForm {
  receiptId: string;
  branchId: string;
  disposition: "credit" | "replacement";
  reason: string;
  notes: string;
  items: Array<{ receiptItemId: string; productName: string; unitCode: string; remaining: number; quantity: string }>;
}

function quantityToMilli(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const total = Number(match[1]) * 1000 + Number((match[2] || "").padEnd(3, "0"));
  return Number.isSafeInteger(total) ? total : null;
}

function moneyToPaisa(value: string): number | null {
  const match = /^(?:\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const total = Math.round(Number(value) * 100);
  return Number.isSafeInteger(total) ? total : null;
}

export function PurchasingWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const { settings: businessSettings } = useBusinessSettings();
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
  const [orderDialogOpen, setOrderDialogOpen] = useState(false);
  const [orderForm, setOrderForm] = useState<OrderForm>({
    supplierId: "",
    branchId: staff?.branch_id || "",
    expectedAt: "",
    notes: "",
    items: [{ productId: "", quantity: "", unitCost: "" }],
  });
  const [receivingCounts, setReceivingCounts] = useState<Record<string, string>>({});
  const [receivingOpen, setReceivingOpen] = useState(false);
  const [receivingInvoice, setReceivingInvoice] = useState("");
  const [receivingNotes, setReceivingNotes] = useState("");
  const [paymentTarget, setPaymentTarget] = useState<{ id: string; branchId: string; supplier: string; invoice: string | null; due: number } | null>(null);
  const [paymentForm, setPaymentForm] = useState<PaymentForm>({ method: "bank_transfer", amount: "", reference: "", notes: "" });
  const [returnForm, setReturnForm] = useState<SupplierReturnForm | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const isHqAdmin = staff?.role === "admin" && !staff.branch_id;
  const canView = staff?.role === "admin" || staff?.role === "manager";
  const orders = data?.orders || [];
  const receipts = data?.receipts || [];
  const suppliers = data?.suppliers || [];
  const products = data?.products || [];
  const permissions = data?.permissions || {
    canCreateOrders: false,
    canReceiveOrders: false,
    canCancelOrders: false,
    canManageVendors: false,
  };
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

  const openDetails = async (kind: "orders" | "receipts", id: string): Promise<PurchaseDetailResponse | null> => {
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
      return result;
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "Could not load purchase details.");
      return null;
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetails = () => {
    setDetail(null);
    setDetailError(null);
    setReceivingCounts({});
    setReceivingOpen(false);
    setReceivingInvoice("");
    setReceivingNotes("");
  };

  const submitOrder = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const lines: Array<{ productId: string; quantityMilli: number; unitCostPaisa: number }> = [];
    for (const line of orderForm.items) {
      const quantityMilli = quantityToMilli(line.quantity);
      const unitCostPaisa = moneyToPaisa(line.unitCost);
      if (!line.productId || quantityMilli == null || quantityMilli < 1 || unitCostPaisa == null) {
        setActionError("Choose a product and enter a valid quantity and unit cost for every line.");
        return;
      }
      lines.push({ productId: line.productId, quantityMilli, unitCostPaisa });
    }
    if (new Set(lines.map((line) => line.productId)).size !== lines.length) {
      setActionError("Each product can only appear once on a purchase order.");
      return;
    }
    const selectedBranchId = isHqAdmin
      ? (branchId === "all" ? orderForm.branchId : branchId)
      : staff?.branch_id || "";
    if (!selectedBranchId) {
      setActionError("Choose a branch for this purchase order.");
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await postWorkspaceAction<{ result?: { orderNumber?: string } }>("/api/workspace/purchasing", {
        action: "create_order",
        branchId: selectedBranchId,
        supplierId: orderForm.supplierId,
        expectedAt: orderForm.expectedAt || null,
        notes: orderForm.notes,
        items: lines,
      });
      setOrderDialogOpen(false);
      setActionMessage(`Purchase order ${response.result?.orderNumber || ""} placed.`.trim());
      setReloadKey((key) => key + 1);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : "The purchase order could not be placed.");
    } finally {
      setActionBusy(false);
    }
  };

  const submitReceipt = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail || detail.kind !== "order") return;
    const selected = Object.entries(receivingCounts).filter(([, value]) => value.trim());
    const lines: Array<{ productId: string; quantityMilli: number }> = [];
    for (const [productId, value] of selected) {
      const quantityMilli = quantityToMilli(value);
      if (quantityMilli == null || quantityMilli < 1) {
        setDetailError("Enter valid received quantities with no more than three decimal places.");
        return;
      }
      const line = detail.items.find((item) => item.product_id === productId);
      if (!line || quantityMilli > (line.remaining_quantity_milli || 0)) {
        setDetailError(`${line?.product_name || "A product"} exceeds the remaining order quantity.`);
        return;
      }
      lines.push({ productId, quantityMilli });
    }
    if (!lines.length) {
      setDetailError("Enter a received quantity for at least one order line.");
      return;
    }
    setActionBusy(true);
    setDetailError(null);
    try {
      await postWorkspaceAction("/api/workspace/purchasing", {
        action: "receive_order",
        branchId: detail.record.branch_id,
        orderId: detail.record.id,
        supplierInvoiceNumber: receivingInvoice,
        notes: receivingNotes,
        items: lines,
      });
      setReceivingCounts({});
      setReceivingOpen(false);
      setReceivingInvoice("");
      setReceivingNotes("");
      setActionMessage(`Goods received for ${(detail.record as PurchaseOrder).order_number}.`);
      setReloadKey((key) => key + 1);
      await openDetails("orders", detail.record.id);
    } catch (submitError) {
      setDetailError(submitError instanceof Error ? submitError.message : "The delivery could not be recorded.");
    } finally {
      setActionBusy(false);
    }
  };

  const cancelOrder = async (order: PurchaseOrder) => {
    const reason = window.prompt("Why is this purchase order being cancelled?");
    if (reason === null) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await postWorkspaceAction("/api/workspace/purchasing", {
        action: "cancel_order",
        branchId: order.branch_id,
        orderId: order.id,
        reason,
      });
      setActionMessage("Purchase order cancelled.");
      setReloadKey((key) => key + 1);
      if (detail?.record.id === order.id) await openDetails("orders", order.id);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : "The purchase order could not be cancelled.");
    } finally {
      setActionBusy(false);
    }
  };

  const openSupplierPayment = async (receipt: PurchaseReceipt) => {
    setPaymentTarget(null);
    setActionError(null);
    const details = await openDetails("receipts", receipt.id);
    if (!details || details.kind !== "receipt") return;
    setPaymentForm({
      method: "bank_transfer",
      amount: ((receipt.due_paisa || 0) / 100).toFixed(2),
      reference: "",
      notes: "",
    });
    setPaymentTarget({
      id: receipt.id,
      branchId: receipt.branch_id,
      supplier: receipt.supplier_name,
      invoice: receipt.supplier_invoice_number,
      due: receipt.due_paisa || 0,
    });
  };

  const submitPayment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!paymentTarget) return;
    const amountPaisa = moneyToPaisa(paymentForm.amount);
    if (amountPaisa == null || amountPaisa < 1) {
      setActionError("Enter a valid payment amount in PKR.");
      return;
    }
    if (amountPaisa > paymentTarget.due) {
      setActionError("Payment cannot exceed the outstanding supplier balance.");
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      await postWorkspaceAction("/api/workspace/purchasing", {
        action: "supplier_payment",
        branchId: paymentTarget.branchId,
        receiptId: paymentTarget.id,
        method: paymentForm.method,
        amountPaisa,
        reference: paymentForm.reference,
        notes: paymentForm.notes,
      });
      setPaymentTarget(null);
      setActionMessage("Supplier payment recorded.");
      setReloadKey((key) => key + 1);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : "The supplier payment could not be recorded.");
    } finally {
      setActionBusy(false);
    }
  };

  const openSupplierReturn = async (receipt: PurchaseReceipt) => {
    setReturnForm(null);
    setActionError(null);
    const details = await openDetails("receipts", receipt.id);
    if (!details || details.kind !== "receipt") return;
    const remainingItems = details.items
      .filter((line) => (line.remaining_quantity_milli || 0) > 0)
      .map((line) => ({
        receiptItemId: line.id,
        productName: line.product_name,
        unitCode: line.unit_code,
        remaining: line.remaining_quantity_milli || 0,
        quantity: "",
      }));
    if (!remainingItems.length) {
      setActionError("All quantities from this receipt have already been returned.");
      return;
    }
    setActionError(null);
    setReturnForm({
      receiptId: receipt.id,
      branchId: receipt.branch_id,
      disposition: "credit",
      reason: "damaged",
      notes: "",
      items: remainingItems,
    });
  };

  const submitSupplierReturn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!returnForm) return;
    const items: Array<{ receiptItemId: string; quantityMilli: number }> = [];
    for (const line of returnForm.items) {
      if (!line.quantity.trim()) continue;
      const quantityMilli = quantityToMilli(line.quantity);
      if (quantityMilli == null || quantityMilli < 1 || quantityMilli > line.remaining) {
        setActionError(`${line.productName} exceeds the remaining quantity from this receipt.`);
        return;
      }
      items.push({ receiptItemId: line.receiptItemId, quantityMilli });
    }
    if (!items.length) {
      setActionError("Enter a return quantity for at least one product.");
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      await postWorkspaceAction("/api/workspace/purchasing", {
        action: "supplier_return",
        branchId: returnForm.branchId,
        receiptId: returnForm.receiptId,
        disposition: returnForm.disposition,
        reason: returnForm.reason,
        notes: returnForm.notes,
        items,
      });
      setReturnForm(null);
      setActionMessage(returnForm.disposition === "replacement"
        ? "Supplier return recorded. Replacement quantities are available on the purchase order."
        : "Supplier credit recorded and stock returned.");
      setReloadKey((key) => key + 1);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : "The supplier return could not be recorded.");
    } finally {
      setActionBusy(false);
    }
  };

  const startOrder = () => {
    setOrderForm({
      supplierId: suppliers.find((supplier) => supplier.is_active)?.id || "",
      branchId: branchId === "all" ? branches[0]?.id || "" : branchId,
      expectedAt: "",
      notes: "",
      items: [{ productId: "", quantity: "", unitCost: "" }],
    });
    setActionError(null);
    setOrderDialogOpen(true);
  };

  const updateOrderLine = (index: number, patch: Partial<OrderForm["items"][number]>) => {
    setOrderForm((form) => ({
      ...form,
      items: form.items.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line),
    }));
  };

  const tableId = `purchasing-${view}-${branchId || "branch"}`;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>Manage purchase orders, stock receipts, supplier payments, and supplier returns.</p>
        </div>
        <div className="heading-actions">
          <Link className="secondary-button" href="/workspace/vendors">
            <Truck size={14} /> Add supplier → Vendors
          </Link>
          {permissions.canCreateOrders && (
            <button className="primary-button" type="button" onClick={startOrder} disabled={!suppliers.some((supplier) => supplier.is_active) || !products.length}>
              <Plus size={14} /> Create purchase order
            </button>
          )}
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
            <WorkspaceError message={actionError} />
            <WorkspaceSuccess message={actionMessage} />
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
                        branding: {
                          businessName: businessSettings.businessName,
                          businessTagline: businessSettings.businessTagline,
                          logoDataUrl: businessSettings.logoDataUrl,
                        },
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
                                <Eye size={15} /> {permissions.canReceiveOrders && ["ordered", "partially_received"].includes(order.status) ? "Receive PO" : "Details"}
                              </button>
                              {permissions.canCancelOrders && ["ordered", "partially_received"].includes(order.status) && (
                                <button type="button" className="secondary-button" onClick={() => void cancelOrder(order)} disabled={actionBusy}>Cancel</button>
                              )}
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
                              {permissions.canManageVendors && (
                                <>
                                  <button type="button" className="secondary-button" onClick={() => void openSupplierReturn(receipt)} disabled={actionBusy || detailLoading}>Return stock</button>
                                  {Boolean(receipt.due_paisa) && <button type="button" className="secondary-button" onClick={() => void openSupplierPayment(receipt)} disabled={actionBusy || detailLoading}>Pay</button>}
                                </>
                              )}
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
                        {permissions.canReceiveOrders && ["ordered", "partially_received"].includes((detail.record as PurchaseOrder).status) && (
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => setReceivingOpen((open) => !open)}
                            disabled={actionBusy}
                          >
                            <Truck size={15} /> {receivingOpen ? "Close receiving" : "Record delivery"}
                          </button>
                        )}
                        {permissions.canCancelOrders && ["ordered", "partially_received"].includes((detail.record as PurchaseOrder).status) && (
                          <button className="secondary-button" type="button" onClick={() => void cancelOrder(detail.record as PurchaseOrder)} disabled={actionBusy}>Cancel order</button>
                        )}
                      </>
                    ) : (
                      <>
                        {permissions.canManageVendors && (
                          <>
                            <button className="secondary-button" type="button" onClick={() => openSupplierReturn({
                              ...(detail.record as PurchaseReceipt),
                              branch_id: detail.record.branch_id,
                              branch_name: detail.record.branch_name,
                              supplier_name: detail.record.supplier_name,
                              supplier_invoice_number: (detail.record as PurchaseReceipt).supplier_invoice_number,
                              subtotal_paisa: (detail.record as PurchaseReceipt).subtotal_paisa,
                              received_at: (detail.record as PurchaseReceipt).received_at,
                            })} disabled={actionBusy || detailLoading}>Return stock</button>
                            {Boolean((detail.record as PurchaseReceipt).due_paisa) && (
                              <button className="secondary-button" type="button" onClick={() => openSupplierPayment({
                                ...(detail.record as PurchaseReceipt),
                                branch_id: detail.record.branch_id,
                                branch_name: detail.record.branch_name,
                                supplier_name: detail.record.supplier_name,
                                supplier_invoice_number: (detail.record as PurchaseReceipt).supplier_invoice_number,
                                subtotal_paisa: (detail.record as PurchaseReceipt).subtotal_paisa,
                                received_at: (detail.record as PurchaseReceipt).received_at,
                                due_paisa: (detail.record as PurchaseReceipt).due_paisa || 0,
                              })} disabled={actionBusy || detailLoading}>Record supplier payment</button>
                            )}
                          </>
                        )}
                        {paymentTarget && (
                          <WorkspaceDialog eyebrow="Purchasing" onClose={() => { setPaymentTarget(null); setActionError(null); }} title="Record supplier payment">
                            <form className="workspace-form" onSubmit={submitPayment}>
                              <WorkspaceError message={actionError} />
                              <p>{paymentTarget.supplier} · {paymentTarget.invoice || "No supplier invoice"}</p>
                              <p><strong>Outstanding: {formatMoney(paymentTarget.due)}</strong></p>
                              <div className="workspace-form-grid">
                                <WorkspaceField label="Amount (PKR)">
                                  <input inputMode="decimal" required value={paymentForm.amount} onChange={(event) => setPaymentForm((form) => ({ ...form, amount: event.target.value }))} />
                                </WorkspaceField>
                                <WorkspaceField label="Payment method">
                                  <select value={paymentForm.method} onChange={(event) => setPaymentForm((form) => ({ ...form, method: event.target.value }))}>
                                    <option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option>
                                    <option value="card">Card</option><option value="jazzcash">JazzCash</option>
                                    <option value="easypaisa">Easypaisa</option><option value="other">Other</option>
                                  </select>
                                </WorkspaceField>
                                <WorkspaceField label="Reference (optional)">
                                  <input maxLength={100} value={paymentForm.reference} onChange={(event) => setPaymentForm((form) => ({ ...form, reference: event.target.value }))} />
                                </WorkspaceField>
                                <WorkspaceField label="Notes (optional)">
                                  <input maxLength={500} value={paymentForm.notes} onChange={(event) => setPaymentForm((form) => ({ ...form, notes: event.target.value }))} />
                                </WorkspaceField>
                              </div>
                              <div className="workspace-form-actions">
                                <button className="secondary-button" type="button" onClick={() => { setPaymentTarget(null); setActionError(null); }}>Cancel</button>
                                <button className="primary-button" disabled={actionBusy || paymentTarget.due <= 0} type="submit">
                                  {actionBusy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                                  {actionBusy ? "Recording…" : "Record payment"}
                                </button>
                              </div>
                            </form>
                          </WorkspaceDialog>
                        )}
                        {returnForm && (
                          <WorkspaceDialog eyebrow="Purchasing" onClose={() => { setReturnForm(null); setActionError(null); }} title="Return goods to supplier">
                            <form className="workspace-form" onSubmit={submitSupplierReturn}>
                              <WorkspaceError message={actionError} />
                              <div className="workspace-form-grid">
                                <WorkspaceField label="Return disposition">
                                  <select
                                    value={returnForm.disposition}
                                    onChange={(event) => {
                                      const disposition = event.target.value;
                                      if (disposition === "credit" || disposition === "replacement") {
                                        setReturnForm((form) => form ? { ...form, disposition } : form);
                                      }
                                    }}
                                  >
                                    <option value="credit">Supplier credit (remove stock)</option>
                                    <option value="replacement">Replacement (stock stays on hand)</option>
                                  </select>
                                </WorkspaceField>
                                <WorkspaceField label="Reason">
                                  <select
                                    value={returnForm.reason}
                                    onChange={(event) => setReturnForm((form) => form ? { ...form, reason: event.target.value } : form)}
                                  >
                                    <option value="damaged">Damaged</option><option value="quality">Quality issue</option>
                                    <option value="expired">Expired</option><option value="incorrect_item">Incorrect item</option><option value="other">Other</option>
                                  </select>
                                </WorkspaceField>
                              </div>
                              <WorkspaceField label="Return notes (optional)">
                                <input maxLength={500} value={returnForm.notes} onChange={(event) => setReturnForm((form) => form ? { ...form, notes: event.target.value } : form)} />
                              </WorkspaceField>
                              <div className="table-wrap">
                                <table>
                                  <thead><tr><th>Product</th><th>Remaining</th><th>Return now</th></tr></thead>
                                  <tbody>
                                    {returnForm.items.map((line) => (
                                      <tr key={line.receiptItemId}>
                                        <td>{line.productName}</td>
                                        <td>{formatQuantity(line.remaining)} {line.unitCode}</td>
                                        <td>
                                          <input
                                            aria-label={`Return quantity for ${line.productName}`}
                                            inputMode="decimal"
                                            placeholder="0.000"
                                            value={line.quantity}
                                            onChange={(event) => setReturnForm((form) => form ? {
                                              ...form,
                                              items: form.items.map((itemLine) => itemLine.receiptItemId === line.receiptItemId
                                                ? { ...itemLine, quantity: event.target.value }
                                                : itemLine),
                                            } : form)}
                                          />
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <div className="workspace-form-actions">
                                <button className="secondary-button" type="button" onClick={() => { setReturnForm(null); setActionError(null); }}>Cancel</button>
                                <button className="primary-button" disabled={actionBusy} type="submit">
                                  {actionBusy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                                  {actionBusy ? "Recording…" : "Record supplier return"}
                                </button>
                              </div>
                            </form>
                          </WorkspaceDialog>
                        )}
                      </>
                    )}
                  </div>
                  {receivingOpen && detail.kind === "order" && (
                    <form className="workspace-form" onSubmit={submitReceipt}>
                      <WorkspaceError message={detailError} />
                      <div className="workspace-form-grid">
                        <WorkspaceField label="Supplier invoice number (optional)">
                          <input maxLength={100} value={receivingInvoice} onChange={(event) => setReceivingInvoice(event.target.value)} />
                        </WorkspaceField>
                        <WorkspaceField label="Receiving notes (optional)">
                          <input maxLength={500} value={receivingNotes} onChange={(event) => setReceivingNotes(event.target.value)} />
                        </WorkspaceField>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead><tr><th>Product</th><th>Remaining</th><th>Receive now</th></tr></thead>
                          <tbody>
                            {detail.items.map((line) => (
                              <tr key={line.id}>
                                <td>{line.product_name}</td>
                                <td>{formatQuantity(line.remaining_quantity_milli || 0)} {line.unit_code}</td>
                                <td>
                                  <input
                                    aria-label={`Quantity received for ${line.product_name}`}
                                    inputMode="decimal"
                                    placeholder="0.000"
                                    value={receivingCounts[line.product_id || ""] || ""}
                                    onChange={(event) => setReceivingCounts((counts) => ({ ...counts, [line.product_id || ""]: event.target.value }))}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="workspace-form-actions">
                        <button className="secondary-button" type="button" onClick={() => { setReceivingOpen(false); setDetailError(null); }}>Cancel</button>
                        <button className="primary-button" disabled={actionBusy || !Object.values(receivingCounts).some((value) => value.trim())} type="submit">
                          {actionBusy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                          {actionBusy ? "Receiving…" : "Record receipt"}
                        </button>
                      </div>
                    </form>
                  )}
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
                  {detail.kind === "receipt" && detail.returns && detail.returns.length > 0 && (
                    <div className="purchasing-linked-receipts">
                      <h3>Supplier returns</h3>
                      {detail.returns.map((supplierReturn) => (
                        <div key={supplierReturn.id}>
                          <span>{formatDateTime(supplierReturn.returned_at)} · {labelize(supplierReturn.reason)} · {labelize(supplierReturn.disposition)}</span>
                          <strong>{formatMoney(supplierReturn.total_paisa)}</strong>
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
      {canView && permissions.canCreateOrders && orderDialogOpen && (
        <WorkspaceDialog eyebrow="Purchasing" onClose={() => setOrderDialogOpen(false)} title="Create purchase order">
          <form className="workspace-form" onSubmit={submitOrder}>
            <WorkspaceError message={actionError} />
            <div className="workspace-form-grid">
              <WorkspaceField label="Supplier">
                <select required value={orderForm.supplierId} onChange={(event) => setOrderForm((form) => ({ ...form, supplierId: event.target.value }))}>
                  <option value="">Choose supplier</option>
                  {suppliers.filter((supplier) => supplier.is_active).map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                  ))}
                </select>
              </WorkspaceField>
              {isHqAdmin && branchId === "all" && (
                <WorkspaceField label="Branch">
                  <select required value={orderForm.branchId} onChange={(event) => setOrderForm((form) => ({ ...form, branchId: event.target.value }))}>
                    <option value="">Choose branch</option>
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </select>
                </WorkspaceField>
              )}
              <WorkspaceField label="Expected delivery (optional)">
                <input type="date" value={orderForm.expectedAt} onChange={(event) => setOrderForm((form) => ({ ...form, expectedAt: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Notes (optional)">
                <input maxLength={500} value={orderForm.notes} onChange={(event) => setOrderForm((form) => ({ ...form, notes: event.target.value }))} />
              </WorkspaceField>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Product</th><th>Quantity</th><th>Unit cost (PKR)</th><th aria-label="Remove line" /></tr></thead>
                <tbody>
                  {orderForm.items.map((line, index) => (
                    <tr key={index}>
                      <td>
                        <select
                          aria-label={`Product on line ${index + 1}`}
                          required
                          value={line.productId}
                          onChange={(event) => {
                            const product = products.find((candidate) => candidate.id === event.target.value);
                            updateOrderLine(index, {
                              productId: event.target.value,
                              unitCost: product ? (product.cost_price_paisa / 100).toFixed(2) : line.unitCost,
                            });
                          }}
                        >
                          <option value="">Choose product</option>
                          {products.map((product) => <option key={product.id} value={product.id}>{product.name} ({product.unit_code})</option>)}
                        </select>
                      </td>
                      <td><input aria-label={`Quantity on line ${index + 1}`} inputMode="decimal" placeholder="0.000" required value={line.quantity} onChange={(event) => updateOrderLine(index, { quantity: event.target.value })} /></td>
                      <td><input aria-label={`Unit cost on line ${index + 1}`} inputMode="decimal" placeholder="0.00" required value={line.unitCost} onChange={(event) => updateOrderLine(index, { unitCost: event.target.value })} /></td>
                      <td>
                        {orderForm.items.length > 1 && (
                          <button
                            className="secondary-button"
                            type="button"
                            aria-label={`Remove line ${index + 1}`}
                            onClick={() => setOrderForm((form) => ({ ...form, items: form.items.filter((_, lineIndex) => lineIndex !== index) }))}
                          >
                            <X size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="secondary-button" type="button" onClick={() => setOrderForm((form) => ({ ...form, items: [...form.items, { productId: "", quantity: "", unitCost: "" }] }))}>
              <Plus size={14} /> Add product
            </button>
            <div className="workspace-form-actions">
              <button className="secondary-button" type="button" onClick={() => setOrderDialogOpen(false)}>Cancel</button>
              <button className="primary-button" disabled={actionBusy || !products.length || !suppliers.some((supplier) => supplier.is_active)} type="submit">
                {actionBusy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                {actionBusy ? "Creating…" : "Create purchase order"}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}

export default PurchasingWorkspace;
