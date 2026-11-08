"use client";

import { AlertCircle, LoaderCircle, Pencil, Plus, RefreshCw, Search, Tag } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { WorkspaceDialog, WorkspaceError, WorkspaceField, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";
import { postWorkspaceAction } from "@/lib/workspace/write-client";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface PctRow {
  id: string;
  name: string;
  pct_code: string;
  description: string;
  product_count: number;
  active_count: number;
  is_active: boolean;
  status: string;
}

interface PctForm {
  id: string;
  name: string;
  pctCode: string;
  description: string;
  isActive: boolean;
}

interface PctResponse {
  rows: PctRow[];
  summary: {
    categories: number;
    linkedProducts: number;
    activeCategories: number;
    unclassifiedProducts: number;
  };
  note?: string;
  error?: string;
}

export function FbrPctCategoriesWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff } = useStaffAuth();
  const canManage = staff?.role === "admin";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [rows, setRows] = useState<PctRow[]>([]);
  const [summary, setSummary] = useState<PctResponse["summary"]>({
    categories: 0, linkedProducts: 0, activeCategories: 0, unclassifiedProducts: 0,
  });
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<PctForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState("");

  const openNewCategory = () => {
    setActionError(null);
    setSuccess("");
    setDialog({ id: "", name: "", pctCode: "", description: "", isActive: true });
  };

  const openEditCategory = (row: PctRow) => {
    setActionError(null);
    setSuccess("");
    setDialog({
      id: row.id,
      name: row.name,
      pctCode: row.pct_code === "—" ? "" : row.pct_code,
      description: row.description,
      isActive: row.is_active,
    });
  };

  const saveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dialog) return;
    setSaving(true);
    setActionError(null);
    try {
      await postWorkspaceAction("/api/workspace/fbr-pct-categories", { ...dialog });
      setDialog(null);
      setSuccess(dialog.id ? "PCT category updated." : "PCT category created.");
      setReloadKey((value) => value + 1);
    } catch (saveError) {
      setActionError(saveError instanceof Error ? saveError.message : "The PCT category could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams();
    if (search.trim()) parameters.set("search", search.trim());
    if (status !== "all") parameters.set("status", status);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/workspace/fbr-pct-categories?${parameters.toString()}`, {
            cache: "no-store",
            credentials: "same-origin",
          });
          const payload = await response.json() as PctResponse;
          if (!active) return;
          if (!response.ok) throw new Error(payload.error || "Could not load FBR PCT categories.");
          setRows(payload.rows || []);
          setSummary(payload.summary);
          setNote(payload.note || "");
        } catch (loadError) {
          if (!active) return;
          setError(loadError instanceof Error ? loadError.message : "Could not load FBR PCT categories.");
          setRows([]);
        } finally {
          if (active) setLoading(false);
        }
      })();
    }, search.trim() ? 220 : 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [reloadKey, search, status]);

  const cards = [
    { label: "PCT categories", value: summary.categories.toLocaleString(), note: `${summary.activeCategories} active` },
    { label: "Linked products", value: summary.linkedProducts.toLocaleString(), note: "Products with PCT metadata" },
    { label: "Unclassified", value: summary.unclassifiedProducts.toLocaleString(), note: "Products without a PCT code" },
    { label: "Source", value: "Cloud", note: "Managed category registry" },
  ];

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Manage shared tariff classifications and review their linked products.</p>
        </div>
        <div className="heading-actions">
          {canManage && (
            <button className="primary-button" type="button" onClick={openNewCategory}>
              <Plus size={14} /> New PCT category
            </button>
          )}
          <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            {loading ? <><LoaderCircle className="spin" size={15} /> Loading…</> : <><RefreshCw size={15} /> Refresh</>}
          </button>
        </div>
      </div>

      <div className="notice info" role="note">
        <Tag size={16} />
        <span>{note || "Create tax tariff classifications separately from product categories, then assign them to catalog products."}</span>
      </div>
      <WorkspaceSuccess message={success} />

      <section className="dashboard-stats" aria-label="FBR PCT category summary">
        {cards.map((card) => (
          <article className="dashboard-stat card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.note}</small>
          </article>
        ))}
      </section>

      <div className="workspace-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="Search PCT categories"
            placeholder="Search code, category or description"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="visually-hidden-label">
          Status
          <select className="toolbar-select" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
      </div>

      {error && (
        <div className="card panel" role="alert">
          <div className="inline-message error"><AlertCircle size={16} /><span>{error}</span></div>
        </div>
      )}

      <section className="card table-wrap workspace-table" aria-label="FBR PCT categories">
        <div className="table-document-heading">
          <strong>{item.title}</strong>
          <TableDocumentTools tableId="fbr-pct-table" title={item.title} disabled={loading || Boolean(error) || !rows.length} />
        </div>

        {loading ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading PCT categories…</div>
        ) : !error && !rows.length ? (
          <div className="empty">
            <Tag size={23} />
            <h2>No PCT categories found</h2>
            <p>No PCT categories are available. Add a category before assigning tariff codes to products.</p>
          </div>
        ) : !error ? (
          <table id="fbr-pct-table">
            <thead>
              <tr>
                <th>PCT category</th><th>PCT code</th><th>Products assigned</th><th>Status</th>
                {canManage && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><span className="primary-cell">{row.name}</span><small className="sales-cell-subtext">{row.description}</small></td>
                  <td><span className="mono">{row.pct_code}</span></td>
                  <td>{row.product_count.toLocaleString()}</td>
                  <td><span className={`status ${row.is_active ? "green" : ""}`}>{row.is_active ? "Active" : "Inactive"}</span></td>
                  {canManage && (
                    <td className="row-actions">
                      <button className="secondary-button" type="button" onClick={() => openEditCategory(row)}><Pencil size={12} /> Edit</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <p className="list-limit-note">Showing {rows.length} PCT categor{rows.length === 1 ? "y" : "ies"}; linked product counts use the latest 2,000 synchronized products.</p>

      {canManage && dialog && (
        <WorkspaceDialog
          eyebrow="FBR classification"
          onClose={() => setDialog(null)}
          title={dialog.id ? "Edit PCT category" : "New PCT category"}
        >
          <form className="workspace-form" onSubmit={(event) => void saveCategory(event)}>
            <WorkspaceError message={actionError} />
            <WorkspaceField label="PCT category name">
              <input
                autoFocus
                maxLength={120}
                onChange={(event) => setDialog((current) => current && ({ ...current, name: event.target.value }))}
                required
                value={dialog.name}
              />
            </WorkspaceField>
            <WorkspaceField label="FBR PCT code">
              <input
                maxLength={32}
                onChange={(event) => setDialog((current) => current && ({ ...current, pctCode: event.target.value }))}
                required
                value={dialog.pctCode}
              />
            </WorkspaceField>
            <WorkspaceField label="Description" hint="Optional · up to 1,000 characters.">
              <textarea
                maxLength={1000}
                onChange={(event) => setDialog((current) => current && ({ ...current, description: event.target.value }))}
                rows={3}
                value={dialog.description}
              />
            </WorkspaceField>
            <label className="workspace-checkbox">
              <input
                checked={dialog.isActive}
                onChange={(event) => setDialog((current) => current && ({ ...current, isActive: event.target.checked }))}
                type="checkbox"
              />
              <span>Active for product assignment</span>
            </label>
            <div className="workspace-form-actions">
              <button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancel</button>
              <button className="primary-button" disabled={saving} type="submit">
                {saving ? <><LoaderCircle className="spin" size={14} /> Saving…</> : <><Pencil size={14} /> Save category</>}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}

export default FbrPctCategoriesWorkspace;
