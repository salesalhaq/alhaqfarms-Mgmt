"use client";

import { AlertCircle, LoaderCircle, Pencil, Plus, RefreshCw, Search, Tag } from "lucide-react";
import { useEffect, useState } from "react";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface PctRow {
  id: string;
  name: string;
  pct_code: string;
  description: string;
  product_count: number;
  active_count: number;
  status: string;
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
    { label: "Source", value: "Cloud", note: "Derived from product tax metadata" },
  ];

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Classification codes are read from synchronized product tax metadata.</p>
        </div>
        <div className="heading-actions">
          <button className="primary-button" type="button" disabled title="Creating PCT categories is a Windows desktop workflow.">
            <Plus size={14} /> New PCT category
          </button>
          <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            {loading ? <><LoaderCircle className="spin" size={15} /> Loading…</> : <><RefreshCw size={15} /> Refresh</>}
          </button>
        </div>
      </div>

      <div className="notice info" role="note">
        <Tag size={16} />
        <span>{note || "Creating or editing PCT categories remains a Windows desktop workflow."}</span>
      </div>

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
            <p>Assign FBR PCT metadata to products from the Windows desktop app, then synchronize this device.</p>
          </div>
        ) : !error ? (
          <table id="fbr-pct-table">
            <thead>
              <tr><th>PCT category</th><th>PCT code</th><th>Products assigned</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><span className="primary-cell">{row.name}</span><small className="sales-cell-subtext">{row.description}</small></td>
                  <td><span className="mono">{row.pct_code}</span></td>
                  <td>{row.product_count.toLocaleString()}</td>
                  <td><span className={`status ${row.status === "active" ? "green" : ""}`}>{row.status === "active" ? "Active" : "Inactive"}</span></td>
                  <td className="row-actions">
                    <button className="secondary-button" type="button" disabled title="Editing PCT categories is a Windows desktop workflow."><Pencil size={12} /> Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <p className="list-limit-note">Showing {rows.length} PCT categor{rows.length === 1 ? "y" : "ies"} grouped from synchronized product metadata.</p>
    </>
  );
}

export default FbrPctCategoriesWorkspace;
