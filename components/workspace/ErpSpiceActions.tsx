"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { formatMoney, formatQuantity, labelize } from "@/lib/format";
import { WorkspaceDialog, WorkspaceError, WorkspaceField } from "@/components/workspace/WorkspaceDialog";

type BranchOption = { id: string; name: string };
type SpiceProduct = {
  id: string;
  name: string;
  category_name: string;
  unit_code: string;
  cost_price_paisa: number;
  stock_milli: number;
};
type SpiceBatchToComplete = {
  id: string;
  batch_number: string;
  name: string;
  status: string;
  output_product_name: string;
  input_cost_paisa: number;
  labor_cost_paisa: number;
  other_cost_paisa: number;
};
type InputLine = { key: string; productId: string; quantity: string };
type OpenForm = {
  branchId: string;
  name: string;
  batchDate: string;
  outputProductId: string;
  notes: string;
  laborCost: string;
  otherCost: string;
  inputs: InputLine[];
};

const GRADES = ["premium", "standard", "economy", "unclassified"];

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

function emptyLine(): InputLine {
  return { key: crypto.randomUUID(), productId: "", quantity: "" };
}

function emptyForm(branchId: string): OpenForm {
  return {
    branchId,
    name: "",
    batchDate: todayInPakistan(),
    outputProductId: "",
    notes: "",
    laborCost: "",
    otherCost: "",
    inputs: [emptyLine()],
  };
}

function milliUnits(value: string, label: string): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (!match) throw new Error(`${label} must be a non-negative quantity with up to 3 decimal places.`);
  const result = Number(match[1]) * 1000 + Number((match[2] || "").padEnd(3, "0"));
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be greater than zero.`);
  return result;
}

function minorUnits(value: string, label: string): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`${label} must be a non-negative amount with up to 2 decimal places.`);
  const result = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is too large.`);
  return result;
}

export function ErpSpiceActions({
  branches,
  selectedBranchId,
  staffBranchId,
  isHqAdmin,
  actionLabel,
  batchToComplete,
  onCloseCompletion,
  onSaved,
}: {
  branches: BranchOption[];
  selectedBranchId: string;
  staffBranchId?: string | null;
  isHqAdmin: boolean;
  actionLabel: string;
  batchToComplete: SpiceBatchToComplete | null;
  onCloseCompletion: () => void;
  onSaved: (batchId: string) => void;
}) {
  const defaultBranchId = selectedBranchId !== "all" ? selectedBranchId : staffBranchId || "";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<OpenForm>(() => emptyForm(defaultBranchId));
  const [products, setProducts] = useState<SpiceProduct[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [outputQuantity, setOutputQuantity] = useState("");
  const [grade, setGrade] = useState("standard");
  const [completeError, setCompleteError] = useState<string | null>(null);

  const rawProducts = useMemo(
    () => products.filter((product) => product.category_name.trim().toUpperCase().startsWith("RAW")),
    [products],
  );
  const outputProducts = useMemo(
    () => products.filter((product) => !product.category_name.trim().toUpperCase().startsWith("RAW")),
    [products],
  );
  const inputCost = form.inputs.reduce((total, line) => {
    const product = products.find((entry) => entry.id === line.productId);
    const quantity = Number(line.quantity);
    if (!product || !Number.isFinite(quantity) || quantity <= 0) return total;
    return total + Math.round(Number(product.cost_price_paisa || 0) * quantity);
  }, 0);
  const laborCostPreview = Number(form.laborCost || 0);
  const otherCostPreview = Number(form.otherCost || 0);
  const totalCost = inputCost
    + (Number.isFinite(laborCostPreview) ? Math.round(laborCostPreview * 100) : 0)
    + (Number.isFinite(otherCostPreview) ? Math.round(otherCostPreview * 100) : 0);
  const completionTotalCost = batchToComplete
    ? Number(batchToComplete.input_cost_paisa || 0)
      + Number(batchToComplete.labor_cost_paisa || 0)
      + Number(batchToComplete.other_cost_paisa || 0)
    : 0;
  const completionQuantityMilli = Number(outputQuantity) * 1000;
  const completionUnitCost = Number.isSafeInteger(completionQuantityMilli) && completionQuantityMilli > 0
    ? Math.round(completionTotalCost * 1000 / completionQuantityMilli)
    : 0;

  const loadProducts = async (branchId: string) => {
    setOptionsLoading(true);
    setOpenError(null);
    try {
      const response = await fetch(`/api/workspace/erp/spice/actions?branchId=${encodeURIComponent(branchId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as { error?: string; products?: SpiceProduct[] };
      if (!response.ok) throw new Error(result.error || "Could not load spice products.");
      setProducts(result.products || []);
    } catch (loadError) {
      setOpenError(loadError instanceof Error ? loadError.message : "Could not load spice products.");
    } finally {
      setOptionsLoading(false);
    }
  };

  const openDialog = async () => {
    setForm(emptyForm(defaultBranchId));
    setProducts([]);
    setOpenError(null);
    setDialogOpen(true);
    if (!defaultBranchId) {
      if (!isHqAdmin) setOpenError("Choose a branch before opening a spice batch.");
      return;
    }
    await loadProducts(defaultBranchId);
  };

  const changeBranch = async (branchId: string) => {
    setForm((current) => ({ ...current, branchId, outputProductId: "", inputs: [emptyLine()] }));
    setProducts([]);
    if (branchId) await loadProducts(branchId);
  };

  const updateLine = (key: string, update: Partial<InputLine>) => {
    setForm((current) => ({
      ...current,
      inputs: current.inputs.map((line) => line.key === key ? { ...line, ...update } : line),
    }));
  };

  const submitOpen = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setOpenError(null);
    try {
      if (!form.branchId) throw new Error("Choose a branch.");
      if (!form.outputProductId) throw new Error("Choose an output product.");
      const response = await fetch("/api/workspace/erp/spice/actions", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "open",
          branchId: form.branchId,
          name: form.name,
          batchDate: form.batchDate,
          outputProductId: form.outputProductId,
          notes: form.notes,
          laborCostPaisa: minorUnits(form.laborCost || "0", "Packing labour cost"),
          otherCostPaisa: minorUnits(form.otherCost || "0", "Other batch cost"),
          inputs: form.inputs.map((line) => ({
            productId: line.productId,
            quantityMilli: milliUnits(line.quantity, "Raw input quantity"),
          })),
        }),
      });
      const result = await response.json() as { error?: string; result?: { id?: string } };
      if (!response.ok) throw new Error(result.error || "Could not open the spice batch.");
      if (!result.result?.id) throw new Error("The spice batch was saved without returning its ID.");
      setDialogOpen(false);
      onSaved(result.result.id);
    } catch (submitError) {
      setOpenError(submitError instanceof Error ? submitError.message : "Could not open the spice batch.");
    } finally {
      setBusy(false);
    }
  };

  const submitComplete = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!batchToComplete) return;
    setBusy(true);
    setCompleteError(null);
    try {
      const response = await fetch("/api/workspace/erp/spice/actions", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          batchId: batchToComplete.id,
          outputQuantityMilli: milliUnits(outputQuantity, "Output quantity"),
          grade,
        }),
      });
      const result = await response.json() as { error?: string; result?: { id?: string } };
      if (!response.ok) throw new Error(result.error || "Could not complete the spice batch.");
      if (!result.result?.id) throw new Error("The spice batch completed without returning its ID.");
      const batchId = result.result.id;
      setOutputQuantity("");
      setGrade("standard");
      onCloseCompletion();
      onSaved(batchId);
    } catch (submitError) {
      setCompleteError(submitError instanceof Error ? submitError.message : "Could not complete the spice batch.");
    } finally {
      setBusy(false);
    }
  };

  const closeOpenDialog = () => {
    if (busy) return;
    setDialogOpen(false);
    setOpenError(null);
  };
  const closeCompleteDialog = () => {
    if (busy) return;
    setOutputQuantity("");
    setGrade("standard");
    setCompleteError(null);
    onCloseCompletion();
  };

  return (
    <>
      <button className="primary-button" type="button" onClick={() => void openDialog()} disabled={optionsLoading}>
        <Plus size={14} /> {actionLabel}
      </button>
      {dialogOpen && (
        <WorkspaceDialog
          title="Open spice batch"
          eyebrow="Farm ERP"
          onClose={closeOpenDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeOpenDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="spice-open-form" disabled={busy || optionsLoading}>
                {busy ? "Opening…" : "Open batch"}
              </button>
            </>
          )}
        >
          <form id="spice-open-form" className="workspace-form" onSubmit={(event) => void submitOpen(event)}>
            {isHqAdmin && (
              <WorkspaceField label="Branch">
                <select required value={form.branchId} onChange={(event) => void changeBranch(event.target.value)} disabled={busy}>
                  <option value="">Choose branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </WorkspaceField>
            )}
            <div className="workspace-form-grid">
              <WorkspaceField label="Batch name">
                <input required maxLength={160} value={form.name} placeholder="Chilli powder run"
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Batch date">
                <input required type="date" max={todayInPakistan()} value={form.batchDate}
                  onChange={(event) => setForm((current) => ({ ...current, batchDate: event.target.value }))} />
              </WorkspaceField>
            </div>
            <div className="workspace-form-grid">
              <WorkspaceField label="Output product">
                <select required value={form.outputProductId}
                  onChange={(event) => setForm((current) => ({ ...current, outputProductId: event.target.value }))}>
                  <option value="">Choose output</option>
                  {outputProducts.map((product) => (
                    <option key={product.id} value={product.id}>{product.name} · {product.unit_code}</option>
                  ))}
                </select>
              </WorkspaceField>
              <WorkspaceField label="Notes">
                <input maxLength={500} value={form.notes}
                  onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
              </WorkspaceField>
            </div>
            <h3 className="section-title">Raw inputs</h3>
            {form.inputs.map((line) => {
              const product = products.find((entry) => entry.id === line.productId);
              return (
                <div className="workspace-production-line has-stock" key={line.key}>
                  <select required aria-label="Raw input product" value={line.productId}
                    onChange={(event) => updateLine(line.key, { productId: event.target.value })}>
                    <option value="">Choose RAW input</option>
                    {rawProducts.filter((entry) => entry.id !== form.outputProductId).map((entry) => (
                      <option key={entry.id} value={entry.id}>{entry.name} · {formatQuantity(entry.stock_milli)} on hand</option>
                    ))}
                  </select>
                  <input required aria-label="Raw input quantity" inputMode="decimal" placeholder="Quantity" value={line.quantity}
                    onChange={(event) => updateLine(line.key, { quantity: event.target.value })} />
                  <span className="form-hint">{product ? `${formatQuantity(product.stock_milli)} on hand` : "—"}</span>
                  <button className="button secondary" type="button" aria-label="Remove input"
                    disabled={form.inputs.length <= 1} onClick={() => setForm((current) => ({
                      ...current, inputs: current.inputs.filter((entry) => entry.key !== line.key),
                    }))}>
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
            <button className="button secondary" type="button" disabled={form.inputs.length >= 50}
              onClick={() => setForm((current) => ({ ...current, inputs: [...current.inputs, emptyLine()] }))}>
              <Plus size={13} /> Add raw input
            </button>
            <div className="workspace-form-grid">
              <WorkspaceField label="Packing labour cost (PKR)">
                <input inputMode="decimal" placeholder="0.00" value={form.laborCost}
                  onChange={(event) => setForm((current) => ({ ...current, laborCost: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Other batch cost (PKR)">
                <input inputMode="decimal" placeholder="0.00" value={form.otherCost}
                  onChange={(event) => setForm((current) => ({ ...current, otherCost: event.target.value }))} />
              </WorkspaceField>
            </div>
            <div className="notice info">
              <strong>Raw material cost: {formatMoney(inputCost)}</strong>
              <span> · Total batch cost: {formatMoney(totalCost)}</span>
            </div>
            <p className="form-hint">Opening the batch deducts raw inputs from branch stock immediately. Completion will add output stock at the derived batch cost.</p>
            {optionsLoading && <p className="form-hint">Loading branch products and stock…</p>}
            <WorkspaceError message={openError} />
          </form>
        </WorkspaceDialog>
      )}
      {batchToComplete && (
        <WorkspaceDialog
          title={`Complete ${batchToComplete.batch_number}`}
          eyebrow="Farm ERP"
          onClose={closeCompleteDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeCompleteDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="spice-complete-form" disabled={busy}>
                {busy ? "Completing…" : "Complete batch"}
              </button>
            </>
          )}
        >
          <form id="spice-complete-form" className="workspace-form" onSubmit={(event) => void submitComplete(event)}>
            <div className="sales-detail-context">
              <div><small>Output</small><strong>{batchToComplete.output_product_name}</strong></div>
              <div><small>Raw materials</small><strong>{formatMoney(batchToComplete.input_cost_paisa)}</strong></div>
              <div><small>Packing labour</small><strong>{formatMoney(batchToComplete.labor_cost_paisa)}</strong></div>
              <div><small>Other cost</small><strong>{formatMoney(batchToComplete.other_cost_paisa)}</strong></div>
              <div><small>Total cost</small><strong>{formatMoney(completionTotalCost)}</strong></div>
            </div>
            <div className="workspace-form-grid">
              <WorkspaceField label="Output quantity">
                <input required inputMode="decimal" value={outputQuantity}
                  onChange={(event) => setOutputQuantity(event.target.value)} />
              </WorkspaceField>
              <WorkspaceField label="Grade">
                <select value={grade} onChange={(event) => setGrade(event.target.value)}>
                  {GRADES.map((entry) => <option key={entry} value={entry}>{labelize(entry)}</option>)}
                </select>
              </WorkspaceField>
            </div>
            <div className="notice info">
              <strong>Derived cost per unit: {completionUnitCost ? formatMoney(completionUnitCost) : "—"}</strong>
              <span> · Grade: {labelize(grade)}</span>
            </div>
            <p className="form-hint">Completion adds output to branch stock and updates the saved product cost. A completed batch cannot be completed again.</p>
            <WorkspaceError message={completeError} />
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}
