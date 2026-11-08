"use client";

import { Plus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { WorkspaceCheckbox, WorkspaceDialog, WorkspaceError, WorkspaceField } from "@/components/workspace/WorkspaceDialog";

export type FarmStore = {
  id: string;
  code: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  timezone?: string | null;
  receipt_prefix: string;
  is_active: boolean;
};

type StoreDraft = {
  id: string;
  code: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  timezone: string;
  receiptPrefix: string;
  isActive: boolean;
};

const EMPTY_DRAFT: StoreDraft = {
  id: "",
  code: "",
  name: "",
  address: "",
  phone: "",
  email: "",
  timezone: "Asia/Karachi",
  receiptPrefix: "POS",
  isActive: true,
};

export function ErpFarmStoreActions({
  actionLabel,
  storeToEdit,
  onCloseEdit,
  onSaved,
}: {
  actionLabel: string;
  storeToEdit: FarmStore | null;
  onCloseEdit: () => void;
  onSaved: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<StoreDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeToEdit) return;
    setDraft({
      id: storeToEdit.id,
      code: storeToEdit.code,
      name: storeToEdit.name,
      address: storeToEdit.address || "",
      phone: storeToEdit.phone || "",
      email: storeToEdit.email || "",
      timezone: storeToEdit.timezone || "Asia/Karachi",
      receiptPrefix: storeToEdit.receipt_prefix || "POS",
      isActive: storeToEdit.is_active,
    });
    setError(null);
    setDialogOpen(true);
  }, [storeToEdit]);

  const closeDialog = () => {
    if (busy) return;
    setDialogOpen(false);
    setError(null);
    onCloseEdit();
  };

  const openNewStore = () => {
    setDraft(EMPTY_DRAFT);
    setError(null);
    setDialogOpen(true);
    onCloseEdit();
  };

  const saveStore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id, ...branch } = draft;
      const response = await fetch("/api/workspace/settings", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save_branch",
          mode: id ? "update" : "create",
          branchId: id || undefined,
          branch,
        }),
      });
      const result = await response.json() as { error?: string; branch?: { id?: string } };
      if (!response.ok) throw new Error(result.error || "The farm store could not be saved.");
      if (!result.branch?.id) throw new Error("The store was saved without returning its branch ID.");
      setDialogOpen(false);
      onCloseEdit();
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The farm store could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="primary-button" type="button" onClick={openNewStore}>
        <Plus size={14} /> {actionLabel}
      </button>
      {error && !dialogOpen && <div className="notice" role="alert">{error}</div>}
      {dialogOpen && (
        <WorkspaceDialog
          title={draft.id ? `Edit ${draft.name}` : "Register store"}
          eyebrow="Farm ERP"
          onClose={closeDialog}
          footer={(
            <>
              <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
              <button className="button primary" type="submit" form="erp-farm-store-form" disabled={busy}>
                {busy ? "Saving…" : "Save store"}
              </button>
            </>
          )}
        >
          <form id="erp-farm-store-form" className="workspace-form" onSubmit={(event) => void saveStore(event)}>
            <WorkspaceError message={error} />
            <div className="workspace-form-grid">
              <WorkspaceField label="Store code">
                <input required maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" value={draft.code}
                  onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value.toUpperCase() }))} />
              </WorkspaceField>
              <WorkspaceField label="Receipt prefix">
                <input required maxLength={12} pattern="[A-Za-z0-9_-]+" value={draft.receiptPrefix}
                  onChange={(event) => setDraft((current) => ({ ...current, receiptPrefix: event.target.value.toUpperCase() }))} />
              </WorkspaceField>
            </div>
            <WorkspaceField label="Store name">
              <input required maxLength={200} value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
            </WorkspaceField>
            <WorkspaceField label="Location">
              <input maxLength={300} value={draft.address}
                onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} />
            </WorkspaceField>
            <div className="workspace-form-grid">
              <WorkspaceField label="Phone">
                <input maxLength={40} value={draft.phone}
                  onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))} />
              </WorkspaceField>
              <WorkspaceField label="Email">
                <input type="email" maxLength={254} value={draft.email}
                  onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} />
              </WorkspaceField>
            </div>
            <WorkspaceField label="Timezone">
              <input required maxLength={100} value={draft.timezone}
                onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} />
            </WorkspaceField>
            <WorkspaceCheckbox label="Store is active" checked={draft.isActive}
              onChange={(isActive) => setDraft((current) => ({ ...current, isActive }))} />
            <p className="form-hint">Stores are branches shared with Settings. A new store starts with no stock; receive a transfer or record opening stock before selling.</p>
            <p className="form-hint">Receipt prefix changes only apply to new sales. Existing receipts keep their numbers.</p>
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}
