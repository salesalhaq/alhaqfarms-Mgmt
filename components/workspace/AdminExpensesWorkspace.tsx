"use client";

import { AlertCircle, LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatMoney } from "@/lib/format";

interface ExpenseCategory {
  id: string;
  name: string;
}

interface ExpenseRow {
  id: string;
  branch_id: string;
  branch_name: string;
  category_id: string | null;
  category_name: string;
  description: string | null;
  amount_paisa: number;
  payment_method: string | null;
  reference: string | null;
  notes: string | null;
  spent_at: string;
  created_at: string;
}

interface AdminExpensesResponse {
  rows: ExpenseRow[];
  categories: ExpenseCategory[];
  branchId: string | null;
  branchName: string;
  from: string;
  to: string;
  totalPaisa: number;
  count: number;
  generatedAt: string;
  error?: string;
}

interface PageItem {
  section: string;
  title: string;
  description: string;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultDateRange(): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return [localDateKey(from), localDateKey(to)];
}

function formatExpenseDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium" }).format(date);
}

export function AdminExpensesWorkspace({ item }: { item: PageItem }) {
  const { staff, branches } = useStaffAuth();
  const [fromDate, setFromDate] = useState(() => defaultDateRange()[0]);
  const [toDate, setToDate] = useState(() => defaultDateRange()[1]);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [categoryId, setCategoryId] = useState("all");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [branchName, setBranchName] = useState("All accessible branches");
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const isAdmin = staff?.role === "admin";

  useEffect(() => {
    if (staff?.role === "admin" && !branchId) setBranchId("all");
    else if (staff?.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff?.branch_id, staff?.role]);

  useEffect(() => {
    if (!staff) return undefined;

    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams({ from: fromDate, to: toDate });
    if (branchId && branchId !== "all") parameters.set("branchId", branchId);
    if (categoryId && categoryId !== "all") parameters.set("categoryId", categoryId);
    if (search.trim()) parameters.set("search", search.trim());

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/admin-expenses?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const payload = await response.json() as AdminExpensesResponse;
        if (!active) return;
        if (!response.ok) throw new Error(payload.error || "Could not load store expenses.");
        setRows(payload.rows || []);
        setCategories(payload.categories || []);
        setBranchName(payload.branchName || "All accessible branches");
        setGeneratedAt(payload.generatedAt || null);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load store expenses.");
        setRows([]);
        setCategories([]);
        setGeneratedAt(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, categoryId, fromDate, reloadKey, search, staff, toDate]);

  const summary = useMemo(() => {
    const totalPaisa = rows.reduce((sum, row) => sum + Number(row.amount_paisa || 0), 0);
    const avgPaisa = rows.length ? totalPaisa / rows.length : 0;
    const categoryTotals = new Map<string, number>();
    rows.forEach((row) => {
      const category = row.category_name || "Uncategorized";
      categoryTotals.set(category, (categoryTotals.get(category) || 0) + Number(row.amount_paisa || 0));
    });
    const topCategory = [...categoryTotals.entries()].sort((left, right) => right[1] - left[1])[0];

    return {
      totalPaisa,
      avgPaisa,
      records: rows.length,
      topCategory: topCategory ? { name: topCategory[0], total: topCategory[1] } : null,
    };
  }, [rows]);

  const selectedBranchLabel = useMemo(() => {
    if (!staff) return "Your branch";
    if (branchId === "all") return "All accessible branches";
    return branches.find((branch) => branch.id === branchId)?.name || "Your branch";
  }, [branchId, branches, staff]);

  return (
    <div className="daily-report-print">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} This workspace remains read-only and respects the signed-in staff branch scope.</p>
        </div>
        <div className="heading-actions">
          <button
            className="secondary-button"
            type="button"
            disabled
            title="Adding expense categories is a Windows desktop workflow."
          >
            <Plus size={14} /> Category
          </button>
          <button
            className="primary-button"
            type="button"
            disabled
            title="Expense creation and edits require a secure approval workflow before any write action can be enabled."
          >
            <Plus size={14} /> Record expense
          </button>
        </div>
      </div>

      <div className="daily-report-toolbar daily-report-no-print">
        {isAdmin && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select className="toolbar-select" value={branchId || "all"} onChange={(event) => setBranchId(event.target.value)}>
              <option value="all">All accessible branches</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </label>
        )}

        <label className="toolbar-control">
          <span>Category</span>
          <select className="toolbar-select" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="all">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </label>

        <label className="toolbar-control">
          <span>From</span>
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>

        <label className="toolbar-control">
          <span>To</span>
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>

        <label className="toolbar-control search-field">
          <span>Search</span>
          <div className="search-input-wrap">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="description, reference, notes"
              aria-label="Search expense descriptions"
            />
          </div>
        </label>

        <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
          {loading ? (<><LoaderCircle className="spinner" size={14} /> Loading…</>) : (<><RefreshCw size={14} /> Refresh</>)}
        </button>
      </div>

      {error && (
        <div className="card panel" role="alert">
          <div className="inline-message error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        </div>
      )}

      {loading && (
        <div className="card panel" aria-live="polite">
          <div className="empty loading-state">
            <LoaderCircle className="spinner" size={24} />
            <h2>Loading expenses</h2>
            <p>Checking the selected branch and date range.</p>
          </div>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="daily-report-metrics">
            <div className="metric-card green">
              <span>Total spend</span>
              <strong>{formatMoney(summary.totalPaisa)}</strong>
              <small>{summary.records} expense entries</small>
            </div>
            <div className="metric-card blue">
              <span>Average expense</span>
              <strong>{formatMoney(summary.avgPaisa)}</strong>
              <small>Per line item</small>
            </div>
            <div className="metric-card purple">
              <span>Top category</span>
              <strong>{summary.topCategory ? summary.topCategory.name : "—"}</strong>
              <small>{summary.topCategory ? formatMoney(summary.topCategory.total) : "No data"}</small>
            </div>
            <div className="metric-card amber">
              <span>Scope</span>
              <strong>{selectedBranchLabel}</strong>
              <small>{generatedAt ? new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(generatedAt)) : "Updated now"}</small>
            </div>
          </div>

          <section className="daily-report-panel card">
            <div className="daily-report-panel-heading">
              <h2>Expense details</h2>
              <TableDocumentTools tableId="admin-expenses-table" title={`${item.title} · ${branchName}`} disabled={!rows.length} />
            </div>

            <div className="table-wrap">
              <table id="admin-expenses-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Branch</th>
                    <th>Category</th>
                    <th>Description</th>
                    <th>Payment</th>
                    <th>Reference</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? (
                    rows.map((row) => (
                      <tr key={row.id}>
                        <td>{formatExpenseDate(row.spent_at)}</td>
                        <td>{row.branch_name}</td>
                        <td>{row.category_name}</td>
                        <td>{row.description || "—"}</td>
                        <td>{row.payment_method || "—"}</td>
                        <td>{row.reference || row.notes || "—"}</td>
                        <td className="text-right">{formatMoney(Number(row.amount_paisa || 0))}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="empty-cell">
                        <div className="empty">
                          <h3>No expenses found</h3>
                          <p>Adjust the date range, category or branch to review a different period.</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
