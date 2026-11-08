"use client";

import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { labelize } from "@/lib/format";
import { WorkspaceDialog, WorkspaceError, WorkspaceField } from "@/components/workspace/WorkspaceDialog";

export type ExpenseCategory = { id: string; name: string; is_active: boolean };
type BranchOption = { id: string; name: string };
type ExpenseForm = {
  branchId: string;
  categoryId: string;
  description: string;
  amount: string;
  paymentMethod: string;
  reference: string;
  notes: string;
};

const METHODS = ["cash", "bank_transfer", "card", "jazzcash", "easypaisa", "other"];

function amountToPaisa(value: string): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("Expense amount must have up to 2 decimal places.");
  const amount = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Expense amount must be greater than zero.");
  return amount;
}

export function ErpExpenseActions({
  actionLabel,
  branches,
  categories,
  selectedBranchId,
  staffBranchId,
  isHqAdmin,
  onSaved,
}: {
  actionLabel: string;
  branches: BranchOption[];
  categories: ExpenseCategory[];
  selectedBranchId: string;
  staffBranchId?: string | null;
  isHqAdmin: boolean;
  onSaved: () => void;
}) {
  const [dialog, setDialog] = useState<"expense" | "category" | null>(null);
  const [form, setForm] = useState<ExpenseForm>({
    branchId: "",
    categoryId: "",
    description: "",
    amount: "",
    paymentMethod: "cash",
    reference: "",
    notes: "",
  });
  const [categoryName, setCategoryName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const postAction = async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/workspace/erp/expenses/actions", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as { error?: string; result?: { id?: string; name?: string } };
    if (!response.ok) throw new Error(result.error || "Could not save the farm expense action.");
    if (!result.result) throw new Error("The farm expense action did not return a result.");
    return result.result;
  };

  const openExpense = () => {
    const activeCategories = categories.filter((category) => category.is_active);
    if (!activeCategories.length) {
      setError("Create an active expense category before recording an expense.");
      setSuccess(null);
      return;
    }
    setError(null);
    setSuccess(null);
    setForm({
      branchId: staffBranchId || (selectedBranchId !== "all" ? selectedBranchId : ""),
      categoryId: activeCategories[0].id,
      description: "",
      amount: "",
      paymentMethod: "cash",
      reference: "",
      notes: "",
    });
    setDialog("expense");
  };

  const saveExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await postAction({
        action: "record",
        branchId: form.branchId,
        categoryId: form.categoryId,
        description: form.description,
        amountPaisa: amountToPaisa(form.amount),
        paymentMethod: form.paymentMethod,
        reference: form.reference,
        notes: form.notes,
      });
      if (!result.id) throw new Error("The farm expense was recorded without returning its ID.");
      setDialog(null);
      setSuccess("Farm expense recorded.");
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not record the farm expense.");
    } finally {
      setBusy(false);
    }
  };

  const saveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await postAction({ action: "save-category", name: categoryName });
      if (!result.id) throw new Error("The expense category was saved without returning its ID.");
      setDialog(null);
      setCategoryName("");
      setSuccess("Expense category added.");
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not add the expense category.");
    } finally {
      setBusy(false);
    }
  };

  const closeDialog = () => {
    if (busy) return;
    setDialog(null);
    setError(null);
  };

  return (
    <>
      {isHqAdmin && (
        <button className="secondary-button" type="button" onClick={() => {
          setCategoryName("");
          setError(null);
          setSuccess(null);
          setDialog("category");
        }}>
          <Plus size={14} /> Category
        </button>
      )}
      <button className="primary-button" type="button" onClick={openExpense}>
        <Plus size={14} /> {actionLabel}
      </button>
      {error && !dialog && <div className="notice" role="alert">{error}</div>}
      {success && !dialog && <div className="notice info" role="status">{success}</div>}

      {dialog === "expense" && (
        <WorkspaceDialog
          title="Record farm expense"
          eyebrow="Farm ERP · Expenses"
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="erp-expense-form" disabled={busy}>
                {busy ? "Saving…" : "Record expense"}
              </button>
            </>
          )}
        >
          <form id="erp-expense-form" className="workspace-form" onSubmit={(event) => void saveExpense(event)}>
            <WorkspaceError message={error} />
            {isHqAdmin && (
              <WorkspaceField label="Target branch">
                <select required value={form.branchId}
                  onChange={(event) => setForm((current) => ({ ...current, branchId: event.target.value }))}>
                  <option value="">Choose branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </WorkspaceField>
            )}
            <div className="workspace-form-grid">
              <WorkspaceField label="Category">
                <select required value={form.categoryId}
                  onChange={(event) => setForm((current) => ({ ...current, categoryId: event.target.value }))}>
                  {categories.filter((category) => category.is_active).map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              </WorkspaceField>
              <WorkspaceField label="Amount (PKR)">
                <input required inputMode="decimal" value={form.amount}
                  onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} />
              </WorkspaceField>
            </div>
            <WorkspaceField label="Description">
              <input required maxLength={200} value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
            </WorkspaceField>
            <div className="workspace-form-grid">
              <WorkspaceField label="Paid by">
                <select value={form.paymentMethod}
                  onChange={(event) => setForm((current) => ({ ...current, paymentMethod: event.target.value }))}>
                  {METHODS.map((method) => <option key={method} value={method}>{labelize(method)}</option>)}
                </select>
              </WorkspaceField>
              <WorkspaceField label="Reference">
                <input maxLength={100} value={form.reference}
                  onChange={(event) => setForm((current) => ({ ...current, reference: event.target.value }))} />
              </WorkspaceField>
            </div>
            <WorkspaceField label="Notes">
              <textarea rows={2} maxLength={500} value={form.notes}
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
            </WorkspaceField>
            <p className="form-hint">Expenses are append-only and are recorded against the current date. Supplier invoices belong in Purchasing.</p>
          </form>
        </WorkspaceDialog>
      )}

      {dialog === "category" && (
        <WorkspaceDialog
          title="New expense category"
          eyebrow="Farm ERP · Expenses"
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="erp-expense-category-form" disabled={busy}>
                {busy ? "Saving…" : "Add category"}
              </button>
            </>
          )}
        >
          <form id="erp-expense-category-form" className="workspace-form" onSubmit={(event) => void saveCategory(event)}>
            <WorkspaceError message={error} />
            <WorkspaceField label="Category name">
              <input autoFocus required maxLength={100} value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)} />
            </WorkspaceField>
            <p className="form-hint">Examples: Feed, Veterinary, Labour, Fuel, Repairs, Seed and fertilizer.</p>
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}
