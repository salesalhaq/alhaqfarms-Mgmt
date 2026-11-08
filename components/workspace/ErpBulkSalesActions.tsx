"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatMoney, formatQuantity, labelize } from "@/lib/format";
import { WorkspaceDialog, WorkspaceError, WorkspaceField } from "@/components/workspace/WorkspaceDialog";

type BranchOption = { id: string; name: string };
type BulkProduct = {
  id: string;
  name: string;
  unit_code: string;
  price_paisa: number;
  cost_price_paisa: number;
  stock_milli: number;
};
type BulkLine = { key: string; productId: string; quantity: string; unitPrice: string };
type SaleForm = {
  branchId: string;
  invoiceNumber: string;
  saleDate: string;
  customerName: string;
  customerPhone: string;
  discount: string;
  notes: string;
  paymentAmount: string;
  paymentMethod: string;
  items: BulkLine[];
};
type PaymentTarget = {
  id: string;
  invoice_number: string;
  due_paisa: number;
};

const METHODS = ["cash", "bank_transfer", "card", "jazzcash", "easypaisa", "other"];

function todayInPakistan(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function newLine(): BulkLine {
  return { key: crypto.randomUUID(), productId: "", quantity: "", unitPrice: "" };
}

function emptyForm(branchId: string): SaleForm {
  return {
    branchId,
    invoiceNumber: "",
    saleDate: todayInPakistan(),
    customerName: "",
    customerPhone: "",
    discount: "",
    notes: "",
    paymentAmount: "",
    paymentMethod: "cash",
    items: [newLine()],
  };
}

function amountToMinor(value: string, label: string, allowZero = true): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`${label} must be a non-negative amount with up to 2 decimal places.`);
  const result = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || (!allowZero && result < 1)) {
    throw new Error(`${label} must be a safe amount${allowZero ? "" : " greater than zero"}.`);
  }
  return result;
}

function quantityToMilli(value: string, label: string): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (!match) throw new Error(`${label} must be a non-negative quantity with up to 3 decimal places.`);
  const result = Number(match[1]) * 1000 + Number((match[2] || "").padEnd(3, "0"));
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a safe quantity greater than zero.`);
  return result;
}

export function ErpBulkSalesActions({
  branches,
  selectedBranchId,
  staffBranchId,
  isHqAdmin,
  actionLabel,
  saleToPay,
  onClosePayment,
  onSaved,
}: {
  branches: BranchOption[];
  selectedBranchId: string;
  staffBranchId?: string | null;
  isHqAdmin: boolean;
  actionLabel: string;
  saleToPay: PaymentTarget | null;
  onClosePayment: () => void;
  onSaved: (saleId: string) => void;
}) {
  const defaultBranchId = selectedBranchId !== "all" ? selectedBranchId : staffBranchId || "";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<SaleForm>(() => emptyForm(defaultBranchId));
  const [products, setProducts] = useState<BulkProduct[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const subtotal = useMemo(() => form.items.reduce((total, line) => {
    try {
      return total + Math.round(
        amountToMinor(line.unitPrice || "0", "Unit price")
        * quantityToMilli(line.quantity, "Product quantity") / 1000,
      );
    } catch {
      return total;
    }
  }, 0), [form.items]);
  const discountPreview = (() => {
    try { return amountToMinor(form.discount || "0", "Discount"); } catch { return 0; }
  })();
  const totalPaisa = Math.max(0, subtotal - discountPreview);
  const initialPayment = (() => {
    try { return amountToMinor(form.paymentAmount || "0", "Payment amount"); } catch { return 0; }
  })();
  const dueAfterPayment = Math.max(0, totalPaisa - initialPayment);

  useEffect(() => {
    if (!saleToPay) return;
    setPaymentAmount((Number(saleToPay.due_paisa) / 100).toFixed(2));
    setPaymentMethod("cash");
    setPaymentReference("");
    setPaymentNotes("");
    setPaymentError(null);
    setPaymentOpen(true);
  }, [saleToPay?.id]);

  const loadProducts = async (branchId: string) => {
    setOptionsLoading(true);
    setSaleError(null);
    try {
      const response = await fetch(`/api/workspace/erp/bulk-sales/actions?branchId=${encodeURIComponent(branchId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as { error?: string; products?: BulkProduct[] };
      if (!response.ok) throw new Error(result.error || "Could not load bulk sale products.");
      setProducts(result.products || []);
    } catch (loadError) {
      setSaleError(loadError instanceof Error ? loadError.message : "Could not load bulk sale products.");
    } finally {
      setOptionsLoading(false);
    }
  };

  const openDialog = async () => {
    setForm(emptyForm(defaultBranchId));
    setProducts([]);
    setSaleError(null);
    setDialogOpen(true);
    if (!defaultBranchId) {
      if (!isHqAdmin) setSaleError("Choose a branch before creating a bulk sale.");
      return;
    }
    await loadProducts(defaultBranchId);
  };

  const changeBranch = async (branchId: string) => {
    setForm((current) => ({ ...current, branchId, items: [newLine()] }));
    setProducts([]);
    if (branchId) await loadProducts(branchId);
  };

  const updateLine = (key: string, update: Partial<BulkLine>) => {
    setForm((current) => ({
      ...current,
      items: current.items.map((line) => {
        if (line.key !== key) return line;
        if (update.productId !== undefined) {
          const product = products.find((entry) => entry.id === update.productId);
          return {
            ...line,
            productId: update.productId,
            unitPrice: product ? (Number(product.price_paisa || 0) / 100).toFixed(2) : "",
          };
        }
        return { ...line, ...update };
      }),
    }));
  };

  const submitSale = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setSaleError(null);
    try {
      if (!form.branchId) throw new Error("Choose a branch.");
      const items = form.items.map((line) => ({
        productId: line.productId,
        quantityMilli: quantityToMilli(line.quantity, "Product quantity"),
        unitPricePaisa: amountToMinor(line.unitPrice || "0", "Unit price"),
      }));
      if (!items.length) throw new Error("Add at least one product.");
      const initialPaymentPaisa = form.paymentAmount.trim()
        ? amountToMinor(form.paymentAmount, "Payment amount")
        : 0;
      const response = await fetch("/api/workspace/erp/bulk-sales/actions", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "record",
          branchId: form.branchId,
          invoiceNumber: form.invoiceNumber,
          saleDate: form.saleDate,
          customerName: form.customerName,
          customerPhone: form.customerPhone,
          discountPaisa: amountToMinor(form.discount || "0", "Discount"),
          notes: form.notes,
          items,
          payments: initialPaymentPaisa > 0
            ? [{ method: form.paymentMethod, amountPaisa: initialPaymentPaisa }]
            : [],
        }),
      });
      const result = await response.json() as { error?: string; result?: { id?: string } };
      if (!response.ok) throw new Error(result.error || "Could not post the bulk sale.");
      if (!result.result?.id) throw new Error("Bulk sale was saved without returning its invoice ID.");
      setDialogOpen(false);
      onSaved(result.result.id);
    } catch (submitError) {
      setSaleError(submitError instanceof Error ? submitError.message : "Could not post the bulk sale.");
    } finally {
      setBusy(false);
    }
  };

  const closePayment = () => {
    if (busy) return;
    setPaymentError(null);
    setPaymentAmount("");
    setPaymentOpen(false);
    onClosePayment();
  };

  const submitPayment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!saleToPay) return;
    setBusy(true);
    setPaymentError(null);
    try {
      const amountPaisa = amountToMinor(paymentAmount, "Payment amount", false);
      const response = await fetch("/api/workspace/erp/bulk-sales/actions", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "payment",
          saleId: saleToPay.id,
          amountPaisa,
          method: paymentMethod,
          reference: paymentReference,
          notes: paymentNotes,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not record the payment.");
      const saleId = saleToPay.id;
      setPaymentAmount("");
      setPaymentOpen(false);
      onClosePayment();
      onSaved(saleId);
    } catch (submitError) {
      setPaymentError(submitError instanceof Error ? submitError.message : "Could not record the payment.");
    } finally {
      setBusy(false);
    }
  };

  const closeSaleDialog = () => {
    if (busy) return;
    setDialogOpen(false);
    setSaleError(null);
  };

  return (
    <>
      <button className="primary-button" type="button" onClick={() => void openDialog()} disabled={optionsLoading}>
        <Plus size={14} /> {actionLabel}
      </button>
      {dialogOpen && (
        <WorkspaceDialog
          title="New bulk sale"
          eyebrow="Farm ERP"
          onClose={closeSaleDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeSaleDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="bulk-sale-form" disabled={busy || optionsLoading}>
                {busy ? "Posting…" : "Post bulk sale"}
              </button>
            </>
          )}
        >
          <form id="bulk-sale-form" className="workspace-form" onSubmit={(event) => void submitSale(event)}>
            {isHqAdmin && (
              <WorkspaceField label="Branch">
                <select required value={form.branchId} onChange={(event) => void changeBranch(event.target.value)} disabled={busy}>
                  <option value="">Choose branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </WorkspaceField>
            )}
            <div className="workspace-form-grid">
              <WorkspaceField label="Invoice number · optional">
                <input maxLength={60} value={form.invoiceNumber} placeholder="Auto-generated"
                  onChange={(event) => setForm((current) => ({ ...current, invoiceNumber: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Sale date">
                <input required type="date" max={todayInPakistan()} value={form.saleDate}
                  onChange={(event) => setForm((current) => ({ ...current, saleDate: event.target.value }))} />
              </WorkspaceField>
            </div>
            <div className="workspace-form-grid">
              <WorkspaceField label="Customer name">
                <input required maxLength={200} value={form.customerName}
                  onChange={(event) => setForm((current) => ({ ...current, customerName: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Phone · optional">
                <input maxLength={50} value={form.customerPhone}
                  onChange={(event) => setForm((current) => ({ ...current, customerPhone: event.target.value }))} />
              </WorkspaceField>
            </div>
            <h3 className="section-title">Products</h3>
            {form.items.map((line) => {
              const product = products.find((entry) => entry.id === line.productId);
              return (
                <div className="workspace-production-line" key={line.key}>
                  <select required aria-label="Product" value={line.productId}
                    onChange={(event) => updateLine(line.key, { productId: event.target.value })}>
                    <option value="">Choose product</option>
                    {products.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name} · {formatQuantity(entry.stock_milli)} on hand
                      </option>
                    ))}
                  </select>
                  <input required aria-label="Quantity" inputMode="decimal" placeholder="Quantity" value={line.quantity}
                    onChange={(event) => updateLine(line.key, { quantity: event.target.value })} />
                  <input required aria-label="Unit price" inputMode="decimal" placeholder="Unit price" value={line.unitPrice}
                    onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })} />
                  <button className="button secondary" type="button" aria-label="Remove product"
                    disabled={form.items.length <= 1} onClick={() => setForm((current) => ({
                      ...current, items: current.items.filter((entry) => entry.key !== line.key),
                    }))}>
                    <Trash2 size={14} />
                  </button>
                  {product && <span className="form-hint">{formatQuantity(product.stock_milli)} {product.unit_code} available</span>}
                </div>
              );
            })}
            <button className="button secondary" type="button" disabled={form.items.length >= 200}
              onClick={() => setForm((current) => ({ ...current, items: [...current.items, newLine()] }))}>
              <Plus size={13} /> Add product
            </button>
            <div className="workspace-form-grid">
              <WorkspaceField label="Discount (PKR)">
                <input inputMode="decimal" placeholder="0.00" value={form.discount}
                  onChange={(event) => setForm((current) => ({ ...current, discount: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Notes">
                <input maxLength={500} value={form.notes}
                  onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
              </WorkspaceField>
            </div>
            <div className="workspace-form-grid">
              <WorkspaceField label="Payment received · optional (PKR)">
                <input inputMode="decimal" placeholder="0.00" value={form.paymentAmount}
                  onChange={(event) => setForm((current) => ({ ...current, paymentAmount: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Payment method">
                <select value={form.paymentMethod} onChange={(event) => setForm((current) => ({ ...current, paymentMethod: event.target.value }))}>
                  {METHODS.map((method) => <option key={method} value={method}>{labelize(method)}</option>)}
                </select>
              </WorkspaceField>
            </div>
            <div className="notice info">
              <strong>Subtotal: {formatMoney(subtotal)}</strong>
              <span> · Total: {formatMoney(totalPaisa)}</span>
              <span> · Balance after payment: {formatMoney(dueAfterPayment)}</span>
            </div>
            <p className="form-hint">Posting checks and deducts branch stock atomically. Unit prices default to the product selling price; received payments are recorded against the invoice.</p>
            {optionsLoading && <p className="form-hint">Loading branch products and stock…</p>}
            <WorkspaceError message={saleError} />
          </form>
        </WorkspaceDialog>
      )}
      {saleToPay && paymentOpen && (
        <WorkspaceDialog
          title={`Payment · ${saleToPay.invoice_number}`}
          eyebrow="Farm ERP"
          onClose={closePayment}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closePayment} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="bulk-payment-form" disabled={busy}>
                {busy ? "Recording…" : "Record payment"}
              </button>
            </>
          )}
        >
          <form id="bulk-payment-form" className="workspace-form" onSubmit={(event) => void submitPayment(event)}>
            <div className="notice info"><strong>Outstanding: {formatMoney(saleToPay.due_paisa)}</strong></div>
            <div className="workspace-form-grid">
              <WorkspaceField label="Amount (PKR)">
                <input required inputMode="decimal" value={paymentAmount}
                  onChange={(event) => setPaymentAmount(event.target.value)} />
              </WorkspaceField>
              <WorkspaceField label="Method">
                <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
                  {METHODS.map((method) => <option key={method} value={method}>{labelize(method)}</option>)}
                </select>
              </WorkspaceField>
            </div>
            <WorkspaceField label="Reference">
              <input maxLength={100} value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} />
            </WorkspaceField>
            <WorkspaceField label="Notes">
              <input maxLength={500} value={paymentNotes} onChange={(event) => setPaymentNotes(event.target.value)} />
            </WorkspaceField>
            <WorkspaceError message={paymentError} />
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}
