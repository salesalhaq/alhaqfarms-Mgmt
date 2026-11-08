"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { formatMoney, formatQuantity } from "@/lib/format";
import { WorkspaceDialog, WorkspaceError, WorkspaceField } from "@/components/workspace/WorkspaceDialog";

type BranchOption = { id: string; name: string };
type ProductionProduct = {
  id: string;
  name: string;
  category_name: string;
  unit_code: string;
  cost_price_paisa: number;
  stock_milli: number;
};
type ProductionAnimalBatch = {
  id: string;
  name: string;
  batch_type: string;
  species: string;
  head_count: number;
  unallocated_cost_paisa: number;
};
type ProductionLine = { key: string; productId: string; quantity: string };
type ProductionForm = {
  branchId: string;
  runDate: string;
  processType: "product" | "terminal" | "continuous";
  animalBatchId: string;
  animalHeads: string;
  inputs: ProductionLine[];
  outputs: ProductionLine[];
  laborCost: string;
  otherCost: string;
  notes: string;
};

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

function newLine(): ProductionLine {
  return { key: crypto.randomUUID(), productId: "", quantity: "" };
}

function minorUnits(value: string, label: string): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`${label} must be a non-negative amount with up to 2 decimal places.`);
  const result = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is too large.`);
  return result;
}

function milliUnits(value: string, label: string): number {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (!match) throw new Error(`${label} must be a non-negative quantity with up to 3 decimal places.`);
  const result = Number(match[1]) * 1000 + Number((match[2] || "").padEnd(3, "0"));
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be greater than zero.`);
  return result;
}

function initialForm(branchId: string): ProductionForm {
  return {
    branchId,
    runDate: todayInPakistan(),
    processType: "product",
    animalBatchId: "",
    animalHeads: "",
    inputs: [newLine()],
    outputs: [newLine()],
    laborCost: "",
    otherCost: "",
    notes: "",
  };
}

export function ErpProductionActions({
  branches,
  selectedBranchId,
  staffBranchId,
  isHqAdmin,
  actionLabel,
  onSaved,
}: {
  branches: BranchOption[];
  selectedBranchId: string;
  staffBranchId?: string | null;
  isHqAdmin: boolean;
  actionLabel: string;
  onSaved: (runId: string) => void;
}) {
  const defaultBranchId = selectedBranchId !== "all" ? selectedBranchId : staffBranchId || "";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<ProductionForm>(() => initialForm(defaultBranchId));
  const [products, setProducts] = useState<ProductionProduct[]>([]);
  const [animalBatches, setAnimalBatches] = useState<ProductionAnimalBatch[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligibleProducts = useMemo(
    () => products.filter((product) => !product.category_name.toUpperCase().startsWith("RAW")),
    [products],
  );
  const selectedBatch = animalBatches.find((batch) => batch.id === form.animalBatchId);
  const isAnimalProcess = form.processType !== "product";
  const isTerminal = form.processType === "terminal";
  const previewInputCost = form.inputs.reduce((total, line) => {
    const product = products.find((entry) => entry.id === line.productId);
    const quantity = Number(line.quantity);
    if (!product || !Number.isFinite(quantity) || quantity <= 0) return total;
    return total + Math.round(Number(product.cost_price_paisa || 0) * quantity);
  }, 0) + (isTerminal && selectedBatch
    ? Math.round(Number(selectedBatch.unallocated_cost_paisa || 0)
      * (Number(form.animalHeads) || 0) / Math.max(1, Number(selectedBatch.head_count)))
    : 0);
  const previewOutput = form.outputs.reduce((total, line) => {
    const quantity = Number(line.quantity);
    return total + (Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity * 1000) : 0);
  }, 0);
  const laborPreview = Number(form.laborCost || 0);
  const otherPreview = Number(form.otherCost || 0);
  const previewTotal = previewInputCost
    + (Number.isFinite(laborPreview) ? Math.round(laborPreview * 100) : 0)
    + (Number.isFinite(otherPreview) ? Math.round(otherPreview * 100) : 0);

  const openDialog = async () => {
    setForm(initialForm(defaultBranchId));
    setError(null);
    setDialogOpen(true);
    if (!defaultBranchId && !isHqAdmin) {
      setError("Choose a branch before creating a production run.");
      return;
    }
    if (!defaultBranchId && isHqAdmin) return;
    await loadOptions(defaultBranchId);
  };

  const loadOptions = async (branchId: string) => {
    setLoadingOptions(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspace/erp/production/actions?branchId=${encodeURIComponent(branchId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as {
        error?: string;
        products?: ProductionProduct[];
        animalBatches?: ProductionAnimalBatch[];
      };
      if (!response.ok) throw new Error(result.error || "Could not load production options.");
      setProducts(result.products || []);
      setAnimalBatches(result.animalBatches || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load production options.");
    } finally {
      setLoadingOptions(false);
    }
  };

  const changeBranch = async (branchId: string) => {
    setForm((current) => ({ ...current, branchId, animalBatchId: "" }));
    setAnimalBatches([]);
    setProducts([]);
    if (branchId) await loadOptions(branchId);
  };

  const updateLine = (
    type: "inputs" | "outputs",
    key: string,
    update: Partial<ProductionLine>,
  ) => {
    setForm((current) => ({
      ...current,
      [type]: current[type].map((line) => line.key === key ? { ...line, ...update } : line),
    }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!form.branchId) throw new Error("Choose a branch.");
      const animalHeads = isTerminal ? Number(form.animalHeads) : 0;
      if (isTerminal && (!Number.isSafeInteger(animalHeads) || animalHeads < 1
        || animalHeads > Number(selectedBatch?.head_count || 0))) {
        throw new Error("Enter a whole-number head count within the selected batch.");
      }
      const prepareLines = (lines: ProductionLine[], label: string) => lines
        .filter((line) => line.productId || line.quantity.trim())
        .map((line) => ({
          productId: line.productId,
          quantityMilli: milliUnits(line.quantity, label),
        }));
      const inputs = form.processType === "product" ? prepareLines(form.inputs, "Input quantity") : [];
      const outputs = prepareLines(form.outputs, "Output quantity");
      if (form.processType === "product" && inputs.length === 0) throw new Error("Add at least one production input.");
      if (outputs.length === 0) throw new Error("Add at least one production output.");
      const response = await fetch("/api/workspace/erp/production/actions", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          branchId: form.branchId,
          runDate: form.runDate,
          processType: form.processType,
          animalBatchId: isAnimalProcess ? form.animalBatchId : undefined,
          animalHeads,
          inputs,
          outputs,
          laborCostPaisa: minorUnits(form.laborCost || "0", "Labour cost"),
          otherCostPaisa: minorUnits(form.otherCost || "0", "Other cost"),
          notes: form.notes,
        }),
      });
      const result = await response.json() as { error?: string; result?: { id?: string } };
      if (!response.ok) throw new Error(result.error || "Could not post the production run.");
      if (!result.result?.id) throw new Error("The production run was saved without returning its record ID.");
      setDialogOpen(false);
      onSaved(result.result.id);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not post the production run.");
    } finally {
      setBusy(false);
    }
  };

  const closeDialog = () => {
    if (busy) return;
    setDialogOpen(false);
    setError(null);
  };

  return (
    <>
      <button className="primary-button" type="button" onClick={() => void openDialog()} disabled={loadingOptions}>
        <Plus size={14} /> {actionLabel}
      </button>
      {dialogOpen && (
        <WorkspaceDialog
          title="Post production run"
          eyebrow="Farm ERP"
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="production-run-form" disabled={busy || loadingOptions}>
                {busy ? "Posting…" : "Post run"}
              </button>
            </>
          )}
        >
          <form id="production-run-form" className="workspace-form" onSubmit={(event) => void submit(event)}>
            {isHqAdmin && (
              <WorkspaceField label="Branch">
                <select required value={form.branchId} onChange={(event) => void changeBranch(event.target.value)} disabled={busy}>
                  <option value="">Choose branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </WorkspaceField>
            )}
            <div className="workspace-form-grid">
              <WorkspaceField label="Run date">
                <input required type="date" max={todayInPakistan()} value={form.runDate}
                  onChange={(event) => setForm((current) => ({ ...current, runDate: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Process type">
                <select value={form.processType} onChange={(event) => {
                  const processType = event.target.value as ProductionForm["processType"];
                  setForm((current) => ({
                    ...current,
                    processType,
                    animalBatchId: "",
                    animalHeads: "",
                    inputs: processType === "product" ? [newLine()] : [],
                  }));
                }}>
                  <option value="product">Product-based</option>
                  <option value="terminal">Terminal animal batch</option>
                  <option value="continuous">Continuous animal batch</option>
                </select>
              </WorkspaceField>
            </div>
            {isAnimalProcess && (
              <>
                <WorkspaceField label="Animal batch">
                  <select required value={form.animalBatchId}
                    onChange={(event) => setForm((current) => ({ ...current, animalBatchId: event.target.value, animalHeads: "" }))}>
                    <option value="">Choose animal batch</option>
                    {animalBatches.filter((batch) => batch.batch_type === form.processType).map((batch) => (
                      <option key={batch.id} value={batch.id}>
                        {batch.name} · {batch.head_count} head · {batch.species}
                      </option>
                    ))}
                  </select>
                </WorkspaceField>
                {isTerminal && selectedBatch && (
                  <WorkspaceField label="Animals used">
                    <input required min="1" max={selectedBatch.head_count} step="1" type="number" inputMode="numeric"
                      value={form.animalHeads} onChange={(event) => setForm((current) => ({ ...current, animalHeads: event.target.value }))} />
                  </WorkspaceField>
                )}
              </>
            )}

            <h3 className="section-title">Outputs produced</h3>
            {form.outputs.map((line) => (
              <div className="workspace-production-line" key={line.key}>
                <select required aria-label="Output product" value={line.productId}
                  onChange={(event) => updateLine("outputs", line.key, { productId: event.target.value })}>
                  <option value="">Choose output</option>
                  {eligibleProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.unit_code}</option>)}
                </select>
                <input required aria-label="Output quantity" inputMode="decimal" placeholder="Quantity" value={line.quantity}
                  onChange={(event) => updateLine("outputs", line.key, { quantity: event.target.value })} />
                <button className="button secondary" type="button" aria-label="Remove output"
                  disabled={form.outputs.length <= 1} onClick={() => setForm((current) => ({
                    ...current, outputs: current.outputs.filter((entry) => entry.key !== line.key),
                  }))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button className="button secondary" type="button" onClick={() => setForm((current) => ({ ...current, outputs: [...current.outputs, newLine()] }))}>
              <Plus size={13} /> Add output
            </button>

            {!isAnimalProcess && (
              <>
                <h3 className="section-title">Inputs consumed</h3>
                {form.inputs.map((line) => {
                  const product = products.find((entry) => entry.id === line.productId);
                  return (
                    <div className="workspace-production-line has-stock" key={line.key}>
                      <select required aria-label="Input product" value={line.productId}
                        onChange={(event) => updateLine("inputs", line.key, { productId: event.target.value })}>
                        <option value="">Choose input</option>
                        {eligibleProducts.map((entry) => (
                          <option key={entry.id} value={entry.id}>{entry.name} · {formatQuantity(entry.stock_milli)} on hand</option>
                        ))}
                      </select>
                      <input required aria-label="Input quantity" inputMode="decimal" placeholder="Quantity" value={line.quantity}
                        onChange={(event) => updateLine("inputs", line.key, { quantity: event.target.value })} />
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
                <button className="button secondary" type="button" onClick={() => setForm((current) => ({ ...current, inputs: [...current.inputs, newLine()] }))}>
                  <Plus size={13} /> Add input
                </button>
              </>
            )}

            <div className="workspace-form-grid">
              <WorkspaceField label="Labour cost (PKR)">
                <input inputMode="decimal" placeholder="0.00" value={form.laborCost}
                  onChange={(event) => setForm((current) => ({ ...current, laborCost: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Other cost (PKR)">
                <input inputMode="decimal" placeholder="0.00" value={form.otherCost}
                  onChange={(event) => setForm((current) => ({ ...current, otherCost: event.target.value }))} />
              </WorkspaceField>
            </div>
            <WorkspaceField label="Notes">
              <input maxLength={500} value={form.notes}
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
            </WorkspaceField>
            <div className="notice info">
              <strong>Input cost: {formatMoney(previewInputCost)}</strong>
              <span> · Total cost: {formatMoney(previewTotal)}</span>
              <span> · Output: {formatQuantity(previewOutput)}</span>
            </div>
            <p className="form-hint">
              Inputs use current product cost. Terminal runs allocate animal cost and reduce batch heads; continuous runs keep animals.
              Run cost is allocated across outputs by quantity. Posted runs are immutable.
            </p>
            {loadingOptions && <p className="form-hint">Loading branch products and animal batches…</p>}
            <WorkspaceError message={error} />
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}
