"use client";

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { formatMoney, formatQuantity, labelize } from "@/lib/format";
import { WorkspaceDialog, WorkspaceError, WorkspaceField } from "@/components/workspace/WorkspaceDialog";

export type Vendor = {
  id: string;
  name: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  is_active?: boolean;
};
export type VendorReceipt = {
  id: string;
  supplier_invoice_number?: string | null;
  due_paisa?: number;
  purchase_order_id?: string | null;
};
export type VendorRequest =
  | { kind: "edit"; vendor: Vendor }
  | { kind: "toggle"; vendor: Vendor }
  | { kind: "payment"; vendorId: string; receipt: VendorReceipt }
  | { kind: "return"; vendorId: string; receipt: VendorReceipt };
type ReturnItem = {
  id: string;
  product_id: string;
  product_name: string;
  unit_code: string;
  unit_cost_paisa: number;
  returnable_quantity_milli: number;
  quantity: string;
};
type VendorForm = {
  id: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
};

const METHODS = ["cash", "bank_transfer", "card", "jazzcash", "easypaisa", "other"];
const emptyVendorForm = (): VendorForm => ({
  id: "", name: "", contactName: "", phone: "", email: "", address: "", notes: "",
});

function amountToPaisa(value: string): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("Payment amount must have up to 2 decimal places.");
  const amount = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Payment amount must be a safe amount greater than zero.");
  return amount;
}

function quantityToMilli(value: string): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (!match) throw new Error("Return quantity must have up to 3 decimal places.");
  const quantity = Number(match[1]) * 1000 + Number((match[2] || "").padEnd(3, "0"));
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Return quantity must be greater than zero.");
  return quantity;
}

export function ErpVendorActions({
  actionLabel,
  request,
  onCloseRequest,
  onSaved,
}: {
  actionLabel: string;
  request: VendorRequest | null;
  onCloseRequest: () => void;
  onSaved: (vendorId: string) => void;
}) {
  const [dialog, setDialog] = useState<"vendor" | "payment" | "return" | null>(null);
  const [vendorForm, setVendorForm] = useState<VendorForm>(emptyVendorForm);
  const [payment, setPayment] = useState({ amount: "", method: "cash", reference: "", notes: "" });
  const [returnItems, setReturnItems] = useState<ReturnItem[]>([]);
  const [returnForm, setReturnForm] = useState({
    disposition: "credit", reason: "damaged", notes: "", clientReturnId: "",
  });
  const [returnLoading, setReturnLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeDialog = () => {
    if (busy) return;
    setDialog(null);
    setError(null);
    onCloseRequest();
  };

  const postAction = async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/workspace/erp/vendors/actions", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as { error?: string; result?: Record<string, unknown> };
    if (!response.ok) throw new Error(result.error || "Could not save the vendor action.");
    if (!result.result) throw new Error("The vendor action did not return a result.");
    return result.result;
  };

  useEffect(() => {
    if (!request) return;
    setError(null);
    if (request.kind === "edit") {
      setVendorForm({
        id: request.vendor.id,
        name: request.vendor.name,
        contactName: request.vendor.contact_name || "",
        phone: request.vendor.phone || "",
        email: request.vendor.email || "",
        address: request.vendor.address || "",
        notes: request.vendor.notes || "",
      });
      setDialog("vendor");
    } else if (request.kind === "payment") {
      setPayment({
        amount: (Number(request.receipt.due_paisa || 0) / 100).toFixed(2),
        method: "cash",
        reference: "",
        notes: "",
      });
      setDialog("payment");
    } else if (request.kind === "return") {
      setReturnItems([]);
      setReturnForm({
        disposition: "credit", reason: "damaged", notes: "", clientReturnId: crypto.randomUUID(),
      });
      setDialog("return");
      setReturnLoading(true);
      void (async () => {
        try {
          const response = await fetch(`/api/workspace/erp/vendors/actions?receiptId=${encodeURIComponent(request.receipt.id)}`, {
            cache: "no-store",
            credentials: "same-origin",
          });
          const result = await response.json() as { error?: string; items?: Omit<ReturnItem, "quantity">[] };
          if (!response.ok) throw new Error(result.error || "Could not load receipt return options.");
          const items = (result.items || [])
            .filter((item) => Number(item.returnable_quantity_milli) > 0)
            .map((item) => ({ ...item, quantity: "" }));
          if (!items.length) throw new Error("No remaining receipt quantities are currently in branch stock.");
          setReturnItems(items);
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : "Could not load receipt return options.");
        } finally {
          setReturnLoading(false);
        }
      })();
    } else if (request.kind === "toggle") {
      const vendor = request.vendor;
      if (!window.confirm(`${vendor.is_active ? "Deactivate" : "Activate"} ${vendor.name}?`)) {
        setDialog(null);
        onCloseRequest();
        return;
      }
      setBusy(true);
      void postAction({ action: "set-active", id: vendor.id, active: !vendor.is_active })
        .then(() => {
          onCloseRequest();
          onSaved(vendor.id);
        })
        .catch((saveError: unknown) => {
          setError(saveError instanceof Error ? saveError.message : "Could not update the vendor status.");
        })
        .finally(() => setBusy(false));
    }
  }, [request]);

  const saveVendor = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await postAction({ action: "save", ...vendorForm });
      const vendorId = typeof result.id === "string" ? result.id : "";
      if (!vendorId) throw new Error("The vendor was saved without returning its ID.");
      setDialog(null);
      onCloseRequest();
      onSaved(vendorId);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the vendor.");
    } finally {
      setBusy(false);
    }
  };

  const savePayment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request?.kind !== "payment") return;
    setBusy(true);
    setError(null);
    try {
      await postAction({
        action: "payment",
        receiptId: request.receipt.id,
        amountPaisa: amountToPaisa(payment.amount),
        method: payment.method,
        reference: payment.reference,
        notes: payment.notes,
      });
      const vendorId = request.vendorId;
      setDialog(null);
      onCloseRequest();
      onSaved(vendorId);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not record the supplier payment.");
    } finally {
      setBusy(false);
    }
  };

  const saveReturn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request?.kind !== "return") return;
    setBusy(true);
    setError(null);
    try {
      const items = returnItems
        .filter((item) => item.quantity.trim())
        .map((item) => {
          const quantityMilli = quantityToMilli(item.quantity);
          if (quantityMilli > item.returnable_quantity_milli) {
            throw new Error(`${item.product_name} exceeds the returnable quantity currently in stock.`);
          }
          return { receiptItemId: item.id, quantityMilli };
        });
      if (!items.length) throw new Error("Enter a return quantity for at least one product.");
      await postAction({
        action: "return",
        receiptId: request.receipt.id,
        clientReturnId: returnForm.clientReturnId,
        disposition: returnForm.disposition,
        reason: returnForm.reason,
        notes: returnForm.notes,
        items,
      });
      const vendorId = request.vendorId;
      setDialog(null);
      onCloseRequest();
      onSaved(vendorId);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not record the supplier return.");
    } finally {
      setBusy(false);
    }
  };

  const openNewVendor = () => {
    setVendorForm(emptyVendorForm());
    setError(null);
    setDialog("vendor");
    onCloseRequest();
  };
  const paymentReceipt = request?.kind === "payment" ? request.receipt : null;
  const returnReceipt = request?.kind === "return" ? request.receipt : null;

  return (
    <>
      <button className="primary-button" type="button" onClick={openNewVendor}>
        <Plus size={14} /> {actionLabel}
      </button>
      {error && !dialog && <div className="notice" role="alert">{error}</div>}

      {dialog === "vendor" && (
        <WorkspaceDialog
          title={vendorForm.id ? "Edit vendor" : "Add vendor"}
          eyebrow="Farm ERP"
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="erp-vendor-form" disabled={busy}>
                {busy ? "Saving…" : "Save vendor"}
              </button>
            </>
          )}
        >
          <form id="erp-vendor-form" className="workspace-form" onSubmit={(event) => void saveVendor(event)}>
            <WorkspaceError message={error} />
            <WorkspaceField label="Vendor name">
              <input required maxLength={200} value={vendorForm.name}
                onChange={(event) => setVendorForm((form) => ({ ...form, name: event.target.value }))} />
            </WorkspaceField>
            <div className="workspace-form-grid">
              <WorkspaceField label="Contact name">
                <input maxLength={200} value={vendorForm.contactName}
                  onChange={(event) => setVendorForm((form) => ({ ...form, contactName: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Phone">
                <input maxLength={50} value={vendorForm.phone}
                  onChange={(event) => setVendorForm((form) => ({ ...form, phone: event.target.value }))} />
              </WorkspaceField>
            </div>
            <WorkspaceField label="Email">
              <input type="email" maxLength={254} value={vendorForm.email}
                onChange={(event) => setVendorForm((form) => ({ ...form, email: event.target.value }))} />
            </WorkspaceField>
            <WorkspaceField label="Address">
              <textarea maxLength={1000} rows={2} value={vendorForm.address}
                onChange={(event) => setVendorForm((form) => ({ ...form, address: event.target.value }))} />
            </WorkspaceField>
            <WorkspaceField label="Notes">
              <textarea maxLength={1000} rows={2} value={vendorForm.notes}
                onChange={(event) => setVendorForm((form) => ({ ...form, notes: event.target.value }))} />
            </WorkspaceField>
          </form>
        </WorkspaceDialog>
      )}

      {dialog === "payment" && paymentReceipt && (
        <WorkspaceDialog
          title="Record supplier payment"
          eyebrow={paymentReceipt.supplier_invoice_number || "Purchase receipt"}
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="erp-vendor-payment-form" disabled={busy}>
                {busy ? "Saving…" : "Record payment"}
              </button>
            </>
          )}
        >
          <form id="erp-vendor-payment-form" className="workspace-form" onSubmit={(event) => void savePayment(event)}>
            <WorkspaceError message={error} />
            <p>Outstanding: <strong>{formatMoney(paymentReceipt.due_paisa || 0)}</strong></p>
            <div className="workspace-form-grid">
              <WorkspaceField label="Amount">
                <input required inputMode="decimal" value={payment.amount}
                  onChange={(event) => setPayment((current) => ({ ...current, amount: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Method">
                <select value={payment.method} onChange={(event) => setPayment((current) => ({ ...current, method: event.target.value }))}>
                  {METHODS.map((method) => <option key={method} value={method}>{labelize(method)}</option>)}
                </select>
              </WorkspaceField>
            </div>
            <WorkspaceField label="Reference">
              <input maxLength={100} value={payment.reference}
                onChange={(event) => setPayment((current) => ({ ...current, reference: event.target.value }))} />
            </WorkspaceField>
            <WorkspaceField label="Notes">
              <textarea maxLength={500} rows={2} value={payment.notes}
                onChange={(event) => setPayment((current) => ({ ...current, notes: event.target.value }))} />
            </WorkspaceField>
          </form>
        </WorkspaceDialog>
      )}

      {dialog === "return" && returnReceipt && (
        <WorkspaceDialog
          title="Return stock to supplier"
          eyebrow={returnReceipt.supplier_invoice_number || "Purchase receipt"}
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="erp-vendor-return-form" disabled={busy || returnLoading || !returnItems.length}>
                {busy ? "Saving…" : "Record return"}
              </button>
            </>
          )}
        >
          <form id="erp-vendor-return-form" className="workspace-form" onSubmit={(event) => void saveReturn(event)}>
            <WorkspaceError message={error} />
            {returnLoading ? <p>Loading receipt items…</p> : (
              <>
                <div className="workspace-form-grid">
                  <WorkspaceField label="Disposition">
                    <select value={returnForm.disposition} disabled={!returnReceipt.purchase_order_id}
                      onChange={(event) => setReturnForm((form) => ({ ...form, disposition: event.target.value }))}>
                      <option value="credit">Supplier credit</option>
                      <option value="replacement">Replacement delivery</option>
                    </select>
                  </WorkspaceField>
                  <WorkspaceField label="Reason">
                    <select value={returnForm.reason}
                      onChange={(event) => setReturnForm((form) => ({ ...form, reason: event.target.value }))}>
                      {["damaged", "quality", "expired", "incorrect_item", "other"].map((reason) => (
                        <option key={reason} value={reason}>{labelize(reason)}</option>
                      ))}
                    </select>
                  </WorkspaceField>
                </div>
                {!returnReceipt.purchase_order_id && <p>Only purchase-order deliveries can be returned for replacement.</p>}
                {returnItems.map((item) => (
                  <div className="workspace-production-line" key={item.id}>
                    <span>{item.product_name}<small>{formatQuantity(item.returnable_quantity_milli)} {item.unit_code} returnable</small></span>
                    <input aria-label={`Return quantity for ${item.product_name}`} inputMode="decimal"
                      placeholder="Quantity" value={item.quantity}
                      onChange={(event) => setReturnItems((current) => current.map((line) => line.id === item.id
                        ? { ...line, quantity: event.target.value }
                        : line))} />
                  </div>
                ))}
                <WorkspaceField label="Notes">
                  <textarea maxLength={500} rows={2} value={returnForm.notes}
                    onChange={(event) => setReturnForm((form) => ({ ...form, notes: event.target.value }))} />
                </WorkspaceField>
              </>
            )}
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}
