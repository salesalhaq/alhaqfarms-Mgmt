"use client";

import { AlertCircle, LoaderCircle, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";

interface WorkspaceRow { id: string; cells: string[]; }
interface CategoryOption { id: string; name: string; }
interface WorkspaceResponse {
  columns?: string[];
  rows?: WorkspaceRow[];
  categories?: CategoryOption[];
  error?: string;
}

export function LiveWorkspacePage({ item }: { item: WorkspaceModule }) {
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [availability, setAvailability] = useState("all");
  const [status, setStatus] = useState("all");
  const [columns, setColumns] = useState<string[]>(item.columns);
  const [rows, setRows] = useState<WorkspaceRow[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams();
    if (search.trim()) parameters.set("search", search.trim());
    if (item.slug === "products") {
      if (categoryId) parameters.set("categoryId", categoryId);
      if (availability !== "all") parameters.set("availability", availability);
    }
    if (item.slug === "returns" && status !== "all") parameters.set("status", status);
    const query = parameters.size ? `?${parameters.toString()}` : "";

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/${item.slug}${query}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as WorkspaceResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || `Could not load ${item.title.toLowerCase()}.`);
        setColumns(result.columns || item.columns);
        setRows(result.rows || []);
        setCategories(result.categories || []);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : `Could not load ${item.title.toLowerCase()}.`);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [availability, categoryId, item.columns, item.slug, item.title, search, status]);

  const clearFilters = () => {
    setSearch("");
    setCategoryId("");
    setAvailability("all");
    setStatus("all");
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} This list is read-only and follows your signed-in staff account's existing Supabase access.</p>
        </div>
        {item.actionLabel && (
          <button
            className="button"
            disabled
            title="Record changes are not enabled in this phase."
            type="button"
          >
            {item.actionLabel}
          </button>
        )}
      </div>

      <div className="live-readonly-note">
        <AlertCircle size={16} />
        <span>Live cloud records · read-only. Add, approve, and edit actions remain disabled until their server-side workflows are implemented.</span>
      </div>

      <div className="workspace-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label={item.searchLabel}
            placeholder={item.searchLabel}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {item.slug === "products" && (
          <>
            <label className="visually-hidden-label">
              Category
              <select className="toolbar-select" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                <option value="">All categories</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
            <label className="visually-hidden-label">
              Availability
              <select className="toolbar-select" value={availability} onChange={(event) => setAvailability(event.target.value)}>
                <option value="all">All availability</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="on_sale">On sale</option>
              </select>
            </label>
          </>
        )}
        {item.slug === "returns" && (
          <label className="visually-hidden-label">
            Status
            <select className="toolbar-select" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All return statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="completed">Completed</option>
            </select>
          </label>
        )}
        <button className="button secondary" onClick={clearFilters} type="button">Clear</button>
      </div>

      {error && <div className="notice" role="alert">{error}</div>}
      <section className="card table-wrap workspace-table" aria-label={`${item.title} data`}>
        <div className="table-document-heading">
          <strong>{item.title}</strong>
          <TableDocumentTools tableId={`workspace-table-${item.slug}`} title={item.title} disabled={loading || Boolean(error) || !rows.length} />
        </div>
        {loading ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading {item.title.toLowerCase()}…</div>
        ) : !error && rows.length === 0 ? (
          <div className="empty">
            <Search size={23} />
            <h2>{search ? "No matching records" : `No ${item.title.toLowerCase()} found`}</h2>
            <p>{search ? "Try a different search or clear the filters." : "Records will appear here when available to your staff account."}</p>
          </div>
        ) : !error ? (
          <table id={`workspace-table-${item.slug}`}>
            <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.id}>{row.cells.map((cell, index) => (
                <td key={`${row.id}-${columns[index]}`}>
                  {index === 0 ? <span className="primary-cell">{cell}</span> : cell}
                </td>
              ))}</tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
      {!loading && !error && (
        <p className="list-limit-note">Showing {rows.length} matching records, limited to 100 per request.</p>
      )}
    </>
  );
}
