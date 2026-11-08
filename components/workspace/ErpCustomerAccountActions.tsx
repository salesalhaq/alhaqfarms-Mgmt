"use client";

import { CreditCard, FileText, Pencil, Plus, Power } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { formatMoney } from "@/lib/format";
import { WorkspaceDialog, WorkspaceError, WorkspaceField } from "@/components/workspace/WorkspaceDialog";

export type CustomerAccount = {
  id: string;
  branch_id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  credit_limit_paisa?: number;
  balance_paisa?: number;
  is_active: boolean;
};

export type CustomerAccountRequest =
  | { kind: "edit"; account: CustomerAccount }
  | { kind: "toggle"; account: CustomerAccount }
  | { kind: "invoice"; account: CustomerAccount }
  | { kind: "payment"; account: CustomerAccount };

type BranchOption = { id: string; name: string };
type AccountForm = {
  id: string;
  branchId: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  creditLimit: string;
  notes: string;
};
type InvoiceOption = { id: string; invoice_number: string; amount_paisa: number };
type InvoiceForm = {
  invoiceNumber: string;
  invoiceDate: string;
  description: string;
  amount: string;
  notes: string;
};
type PaymentForm = {
  invoiceId: string;
  amount: string;
  method: string;
  reference: string;
  notes: string;
};
type ActionResult = {
  id?: string;
  name?: string;
  invoiceNumber?: string;
};

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "card", label: "Card" },
  { value: "jazzcash", label: "JazzCash" },
  { value: "easypaisa", label: "Easypaisa" },
  { value: "other", label: "Other" },
];

function todayKey(): string {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

function amountToPaisa(value: string, allowZero = false): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("Enter an amount with up to 2 decimal places.");
  const amount = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1)) {
    throw new Error(allowZero ? "Enter a valid non-negative amount." : "Amount must be greater than zero.");
  }
  return amount;
}

const emptyAccountForm = (branchId: string): AccountForm => ({
  id: "", branchId, name: "", phone: "", email: "", address: "", creditLimit: "", notes: "",
});

export function ErpCustomerAccountActions({
  actionLabel,
  request,
  branches,
  selectedBranchId,
  staffBranchId,
  isHqAdmin,
  onCloseRequest,
  onSaved,
}: {
  actionLabel: string;
  request: CustomerAccountRequest | null;
  branches: BranchOption[];
  selectedBranchId: string;
  staffBranchId?: string | null;
  isHqAdmin: boolean;
  onCloseRequest: () => void;
  onSaved: (accountId: string) => void;
}) {
  const [dialog, setDialog] = useState<"account" | "invoice" | "payment" | null>(null);
  const [accountForm, setAccountForm] = useState<AccountForm>(() => emptyAccountForm(""));
  const [invoiceForm, setInvoiceForm] = useState<InvoiceForm>({
    invoiceNumber: "", invoiceDate: todayKey(), description: "", amount: "", notes: "",
  });
  const [paymentForm, setPaymentForm] = useState<PaymentForm>({
    invoiceId: "", amount: "", method: "cash", reference: "", notes: "",
  });
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const postAction = async (payload: Record<string, unknown>): Promise<ActionResult> => {
    const response = await fetch("/api/workspace/erp/customer-accounts/actions", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as { error?: string; result?: ActionResult };
    if (!response.ok) throw new Error(result.error || "Could not save the customer account action.");
    if (!result.result) throw new Error("The customer account action did not return a result.");
    return result.result;
  };

  useEffect(() => {
    if (!request) return undefined;
    let active = true;
    setError(null);
    if (request.kind === "edit") {
      const account = request.account;
      setAccountForm({
        id: account.id,
        branchId: account.branch_id,
        name: account.name,
        phone: account.phone || "",
        email: account.email || "",
        address: account.address || "",
        creditLimit: account.credit_limit_paisa ? (Number(account.credit_limit_paisa) / 100).toFixed(2) : "",
        notes: account.notes || "",
      });
      setDialog("account");
    } else if (request.kind === "invoice") {
      setInvoiceForm({ invoiceNumber: "", invoiceDate: todayKey(), description: "", amount: "", notes: "" });
      setDialog("invoice");
    } else if (request.kind === "payment") {
      const account = request.account;
      setPaymentForm({
        invoiceId: "",
        amount: (Number(account.balance_paisa || 0) / 100).toFixed(2),
        method: "cash",
        reference: "",
        notes: "",
      });
      setInvoices([]);
      setDialog("payment");
      setInvoiceLoading(true);
      void (async () => {
        try {
          const parameters = new URLSearchParams({ module: "customer-accounts", detailId: account.id });
          const response = await fetch(`/api/workspace/erp?${parameters.toString()}`, {
            cache: "no-store",
            credentials: "same-origin",
          });
          const result = await response.json() as { error?: string; detail?: { items?: InvoiceOption[] } };
          if (!response.ok) throw new Error(result.error || "Could not load customer invoices.");
          if (active) setInvoices(result.detail?.items || []);
        } catch (loadError) {
          if (active) setError(loadError instanceof Error ? loadError.message : "Could not load customer invoices.");
        } finally {
          if (active) setInvoiceLoading(false);
        }
      })();
    } else {
      const account = request.account;
      if (!window.confirm(`${account.is_active ? "Deactivate" : "Activate"} ${account.name}?`)) {
        onCloseRequest();
        return () => { active = false; };
      }
      setBusy(true);
      void postAction({ action: "set-active", id: account.id, active: !account.is_active })
        .then(() => {
          if (active) {
            onCloseRequest();
            onSaved(account.id);
          }
        })
        .catch((saveError: unknown) => {
          if (active) setError(saveError instanceof Error ? saveError.message : "Could not update the customer account status.");
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }
    return () => { active = false; };
  }, [request]);

  const closeDialog = () => {
    if (busy) return;
    setDialog(null);
    setError(null);
    onCloseRequest();
  };

  const openNewAccount = () => {
    const initialBranch = staffBranchId || (selectedBranchId !== "all" ? selectedBranchId : "");
    setAccountForm(emptyAccountForm(initialBranch));
    setError(null);
    setDialog("account");
    onCloseRequest();
  };

  const saveAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await postAction({
        action: "save",
        ...(accountForm.id ? { id: accountForm.id } : {}),
        branchId: accountForm.branchId,
        name: accountForm.name,
        phone: accountForm.phone,
        email: accountForm.email,
        address: accountForm.address,
        creditLimitPaisa: amountToPaisa(accountForm.creditLimit || "0", true),
        notes: accountForm.notes,
      });
      if (!result.id) throw new Error("The account was saved without returning its ID.");
      setDialog(null);
      onCloseRequest();
      onSaved(result.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the customer account.");
    } finally {
      setBusy(false);
    }
  };

  const saveInvoice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request?.kind !== "invoice") return;
    setBusy(true);
    setError(null);
    try {
      const result = await postAction({
        action: "invoice",
        accountId: request.account.id,
        invoiceNumber: invoiceForm.invoiceNumber,
        invoiceDate: invoiceForm.invoiceDate,
        description: invoiceForm.description,
        amountPaisa: amountToPaisa(invoiceForm.amount),
        notes: invoiceForm.notes,
      });
      if (!result.id) throw new Error("The invoice was recorded without returning its ID.");
      setDialog(null);
      onCloseRequest();
      onSaved(request.account.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not record the customer invoice.");
    } finally {
      setBusy(false);
    }
  };

  const savePayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request?.kind !== "payment") return;
    setBusy(true);
    setError(null);
    try {
      await postAction({
        action: "payment",
        accountId: request.account.id,
        invoiceId: paymentForm.invoiceId || undefined,
        amountPaisa: amountToPaisa(paymentForm.amount),
        method: paymentForm.method,
        reference: paymentForm.reference,
        notes: paymentForm.notes,
      });
      const accountId = request.account.id;
      setDialog(null);
      onCloseRequest();
      onSaved(accountId);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not record the customer payment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="primary-button" type="button" onClick={openNewAccount}>
        <Plus size={14} /> {actionLabel}
      </button>
      {error && !dialog && <div className="notice" role="alert">{error}</div>}
      {dialog === "account" && (
        <WorkspaceDialog
          title={accountForm.id ? `Edit ${accountForm.name}` : "New customer account"}
          eyebrow="Farm ERP · Customer accounts"
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="customer-account-form" disabled={busy}>
                {busy ? "Saving…" : "Save account"}
              </button>
            </>
          )}
        >
          <form id="customer-account-form" className="workspace-form" onSubmit={(event) => void saveAccount(event)}>
            <WorkspaceError message={error} />
            {isHqAdmin && (
              <WorkspaceField label="Branch">
                <select required disabled={Boolean(accountForm.id)} value={accountForm.branchId}
                  onChange={(event) => setAccountForm((current) => ({ ...current, branchId: event.target.value }))}>
                  <option value="">Choose branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </WorkspaceField>
            )}
            <WorkspaceField label="Customer name">
              <input required maxLength={200} value={accountForm.name}
                onChange={(event) => setAccountForm((current) => ({ ...current, name: event.target.value }))} />
            </WorkspaceField>
            <div className="workspace-form-grid">
              <WorkspaceField label="Phone">
                <input maxLength={50} value={accountForm.phone}
                  onChange={(event) => setAccountForm((current) => ({ ...current, phone: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Email">
                <input type="email" maxLength={254} value={accountForm.email}
                  onChange={(event) => setAccountForm((current) => ({ ...current, email: event.target.value }))} />
              </WorkspaceField>
            </div>
            <WorkspaceField label="Address">
              <input maxLength={1000} value={accountForm.address}
                onChange={(event) => setAccountForm((current) => ({ ...current, address: event.target.value }))} />
            </WorkspaceField>
            <WorkspaceField label="Credit limit (PKR) · 0 disables credit">
              <input inputMode="decimal" value={accountForm.creditLimit}
                onChange={(event) => setAccountForm((current) => ({ ...current, creditLimit: event.target.value }))} />
            </WorkspaceField>
            <WorkspaceField label="Notes">
              <input maxLength={1000} value={accountForm.notes}
                onChange={(event) => setAccountForm((current) => ({ ...current, notes: event.target.value }))} />
            </WorkspaceField>
          </form>
        </WorkspaceDialog>
      )}
      {dialog === "invoice" && request?.kind === "invoice" && (
        <WorkspaceDialog
          title={`Invoice · ${request.account.name}`}
          eyebrow="Farm ERP · Customer accounts"
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="customer-invoice-form" disabled={busy}>
                {busy ? "Recording…" : "Record invoice"}
              </button>
            </>
          )}
        >
          <form id="customer-invoice-form" className="workspace-form" onSubmit={(event) => void saveInvoice(event)}>
            <WorkspaceError message={error} />
            <div className="workspace-form-grid">
              <WorkspaceField label="Invoice number · optional">
                <input maxLength={60} placeholder="Auto-generated" value={invoiceForm.invoiceNumber}
                  onChange={(event) => setInvoiceForm((current) => ({ ...current, invoiceNumber: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Invoice date">
                <input required type="date" max={todayKey()} value={invoiceForm.invoiceDate}
                  onChange={(event) => setInvoiceForm((current) => ({ ...current, invoiceDate: event.target.value }))} />
              </WorkspaceField>
            </div>
            <WorkspaceField label="Description">
              <input required maxLength={300} value={invoiceForm.description}
                onChange={(event) => setInvoiceForm((current) => ({ ...current, description: event.target.value }))} />
            </WorkspaceField>
            <div className="workspace-form-grid">
              <WorkspaceField label="Amount (PKR)">
                <input required inputMode="decimal" value={invoiceForm.amount}
                  onChange={(event) => setInvoiceForm((current) => ({ ...current, amount: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Notes">
                <input maxLength={500} value={invoiceForm.notes}
                  onChange={(event) => setInvoiceForm((current) => ({ ...current, notes: event.target.value }))} />
              </WorkspaceField>
            </div>
          </form>
        </WorkspaceDialog>
      )}
      {dialog === "payment" && request?.kind === "payment" && (
        <WorkspaceDialog
          title={`Payment · ${request.account.name}`}
          eyebrow="Farm ERP · Customer accounts"
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="customer-payment-form"
                disabled={busy || invoiceLoading || Boolean(error)}>
                {busy ? "Recording…" : "Record payment"}
              </button>
            </>
          )}
        >
          <form id="customer-payment-form" className="workspace-form" onSubmit={(event) => void savePayment(event)}>
            <WorkspaceError message={error} />
            {invoiceLoading && <p className="form-hint">Loading account invoices…</p>}
            <div className="workspace-form-grid">
              <WorkspaceField label={`Amount (PKR) · balance ${formatMoney(request.account.balance_paisa || 0)}`}>
                <input required inputMode="decimal" value={paymentForm.amount}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, amount: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Method">
                <select value={paymentForm.method}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, method: event.target.value }))}>
                  {METHODS.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}
                </select>
              </WorkspaceField>
            </div>
            <WorkspaceField label="Allocate to invoice · optional">
              <select value={paymentForm.invoiceId} disabled={invoiceLoading}
                onChange={(event) => setPaymentForm((current) => ({ ...current, invoiceId: event.target.value }))}>
                <option value="">Against the account balance</option>
                {invoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.invoice_number} · {formatMoney(invoice.amount_paisa)}
                  </option>
                ))}
              </select>
            </WorkspaceField>
            <div className="workspace-form-grid">
              <WorkspaceField label="Reference">
                <input maxLength={100} value={paymentForm.reference}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, reference: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Notes">
                <input maxLength={500} value={paymentForm.notes}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, notes: event.target.value }))} />
              </WorkspaceField>
            </div>
            <p className="form-hint">Payments cannot exceed the account balance. Invoice allocation is a ledger reference; balances are account-wide.</p>
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}
