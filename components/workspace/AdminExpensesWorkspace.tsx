"use client";

import { AlertCircle, LoaderCircle, Plus, Search, Save } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { TableControls } from "@/components/workspace/TableControls";
import { WorkspaceReportActions } from "@/components/workspace/WorkspaceReportActions";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { WorkspaceDialog, WorkspaceError, WorkspaceField, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";
import { formatMoney } from "@/lib/format";
import { postWorkspaceAction } from "@/lib/workspace/write-client";

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

interface ExpenseForm {
  branchId: string;
  categoryId: string;
  description: string;
  amount: string;
  paymentMethod: string;
  reference: string;
  notes: string;
}

const EMPTY_EXPENSE_FORM: ExpenseForm = {
  branchId: "",
  categoryId: "",
  description: "",
  amount: "",
  paymentMethod: "cash",
  reference: "",
  notes: "",
};

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultDateRange(): [string, string] {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth(), 1);
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
  const [expenseDialogOpen, setExpenseDialogOpen] = useState(false);
  const [expenseForm, setExpenseForm] = useState<ExpenseForm>(EMPTY_EXPENSE_FORM);
  const [expenseSaving, setExpenseSaving] = useState(false);
  const [expenseError, setExpenseError] = useState<string | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState("");

  const isAdmin = staff?.role === "admin";
  const isHqAdmin = staff?.role === "admin" && !staff.branch_id;
  const canRecordExpense = staff?.role === "admin" || staff?.role === "manager";

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

  const openExpenseDialog = () => {
    setExpenseError(null);
    setSuccessMessage("");
    setExpenseForm({
      ...EMPTY_EXPENSE_FORM,
      branchId: branchId !== "all" ? branchId : branches[0]?.id || "",
      categoryId: categories[0]?.id || "",
    });
    setExpenseDialogOpen(true);
  };

  const recordExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amountText = expenseForm.amount.trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(amountText)) {
      setExpenseError("Amount must be a positive amount with up to 2 decimal places.");
      return;
    }
    const amountPaisa = Math.round(Number(amountText) * 100);
    if (!Number.isSafeInteger(amountPaisa) || amountPaisa < 1) {
      setExpenseError("Expense amount must be greater than zero.");
      return;
    }

    setExpenseSaving(true);
    setExpenseError(null);
    try {
      await postWorkspaceAction("/api/workspace/expense", {
        ...expenseForm,
        amountPaisa,
      });
      setExpenseDialogOpen(false);
      setSuccessMessage("Expense recorded.");
      setReloadKey((value) => value + 1);
    } catch (saveError) {
      setExpenseError(saveError instanceof Error ? saveError.message : "The expense could not be recorded.");
    } finally {
      setExpenseSaving(false);
    }
  };

  const saveExpenseCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCategorySaving(true);
    setCategoryError(null);
    try {
      await postWorkspaceAction("/api/workspace/expense-category", { name: categoryName });
      setCategoryDialogOpen(false);
      setCategoryName("");
      setSuccessMessage("Expense category added.");
      setReloadKey((value) => value + 1);
    } catch (saveError) {
      setCategoryError(saveError instanceof Error ? saveError.message : "The expense category could not be saved.");
    } finally {
      setCategorySaving(false);
    }
  };

  return (
    <div className="daily-report-print">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Expenses are recorded to an accessible branch and remain immutable after posting.</p>
        </div>
        <div className="heading-actions">
          {isHqAdmin && <button className="secondary-button" type="button" onClick={() => {
            setCategoryName("");
            setCategoryError(null);
            setCategoryDialogOpen(true);
          }}>
            <Plus size={14} /> Category
          </button>}
          {canRecordExpense && <button className="primary-button" type="button" onClick={openExpenseDialog}>
            <Plus size={14} /> Record expense
          </button>}
        </div>
      </div>

      <WorkspaceSuccess message={successMessage} />

      <HorizontalFilterScroller className="daily-report-toolbar daily-report-no-print" ariaLabel="Expense report filters">
        {isAdmin && (
          <label className="toolbar-control" style={{ flex: "0 0 220px" }}>
            <span>Branch</span>
            <SearchableFilter
              value={branchId || "all"}
              ariaLabel="Filter expenses by branch"
              placeholder="All accessible branches"
              options={[
                { value: "all", label: "All accessible branches" },
                ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
              ]}
              onChange={setBranchId}
            />
          </label>
        )}

        <label className="toolbar-control" style={{ flex: "0 0 180px" }}>
          <span>Category</span>
          <SearchableFilter
            value={categoryId}
            ariaLabel="Filter expenses by category"
            placeholder="All categories"
            options={[
              { value: "all", label: "All categories" },
              ...categories.map((category) => ({ value: category.id, label: category.name })),
            ]}
            onChange={setCategoryId}
          />
        </label>

        <label className="toolbar-control">
          <span>From</span>
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>

        <label className="toolbar-control">
          <span>To</span>
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>

        <label className="search-field admin-expenses-search">
          <Search size={16} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Description, reference or notes"
            aria-label="Search expense descriptions"
          />
        </label>

      </HorizontalFilterScroller>
      <WorkspaceReportActions
        title={item.title}
        sections={[{
          title: "Expense details",
          columns: ["Date", "Branch", "Category", "Description", "Payment", "Reference", "Amount"],
          rows: rows.map((row) => [
            formatExpenseDate(row.spent_at),
            row.branch_name,
            row.category_name,
            row.description || "—",
            row.payment_method || "—",
            row.reference || row.notes || "—",
            formatMoney(Number(row.amount_paisa || 0)),
          ]),
        }]}
        summary={[
          ["Total spend", formatMoney(summary.totalPaisa)],
          ["Expense entries", summary.records],
          ["Average expense", formatMoney(summary.avgPaisa)],
          ["Top category", summary.topCategory?.name || "—"],
          ["Top category total", summary.topCategory ? formatMoney(summary.topCategory.total) : "—"],
        ]}
        metadata={{
          branch: branchName || selectedBranchLabel,
          period: `${fromDate} – ${toDate}`,
          printedBy: staff?.full_name || "Staff",
          filterSummary: [
            categoryId !== "all" ? `Category: ${categories.find((category) => category.id === categoryId)?.name || categoryId}` : "",
            search.trim() ? `Search: ${search.trim()}` : "",
          ].filter(Boolean).join(" · "),
        }}
        onRefresh={() => setReloadKey((value) => value + 1)}
        refreshing={loading}
        disabled={loading || Boolean(error)}
      />

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

          {rows.length > 0 && (
            <TableControls
              tableId="admin-expenses-table"
              ariaLabel="Expense details"
              includeSearch={false}
              filterColumns={[{ column: "Payment" }]}
            />
          )}
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

      {expenseDialogOpen && (
        <WorkspaceDialog
          eyebrow="Expenses"
          onClose={() => setExpenseDialogOpen(false)}
          title="Record expense"
        >
          <form className="workspace-form" onSubmit={recordExpense}>
            <WorkspaceError message={expenseError} />
            <div className="workspace-form-grid">
              <WorkspaceField label="Branch">
                <select
                  onChange={(event) => setExpenseForm((form) => ({ ...form, branchId: event.target.value }))}
                  required
                  value={expenseForm.branchId}
                >
                  <option value="">Choose a branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </WorkspaceField>
              <WorkspaceField label="Category">
                <select
                  onChange={(event) => setExpenseForm((form) => ({ ...form, categoryId: event.target.value }))}
                  required
                  value={expenseForm.categoryId}
                >
                  <option value="">Choose a category</option>
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </WorkspaceField>
              <WorkspaceField label="Description">
                <input
                  maxLength={200}
                  onChange={(event) => setExpenseForm((form) => ({ ...form, description: event.target.value }))}
                  required
                  value={expenseForm.description}
                />
              </WorkspaceField>
              <WorkspaceField label="Amount (PKR)">
                <input
                  inputMode="decimal"
                  onChange={(event) => setExpenseForm((form) => ({ ...form, amount: event.target.value }))}
                  required
                  value={expenseForm.amount}
                />
              </WorkspaceField>
              <WorkspaceField label="Payment method">
                <select
                  onChange={(event) => setExpenseForm((form) => ({ ...form, paymentMethod: event.target.value }))}
                  value={expenseForm.paymentMethod}
                >
                  <option value="cash">Cash</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="card">Card</option>
                  <option value="jazzcash">JazzCash</option>
                  <option value="easypaisa">Easypaisa</option>
                  <option value="other">Other</option>
                </select>
              </WorkspaceField>
              <WorkspaceField label="Reference">
                <input
                  maxLength={100}
                  onChange={(event) => setExpenseForm((form) => ({ ...form, reference: event.target.value }))}
                  value={expenseForm.reference}
                />
              </WorkspaceField>
              <WorkspaceField label="Notes">
                <textarea
                  maxLength={500}
                  onChange={(event) => setExpenseForm((form) => ({ ...form, notes: event.target.value }))}
                  rows={3}
                  value={expenseForm.notes}
                />
              </WorkspaceField>
            </div>
            {!categories.length && <p className="notice">No expense categories are available. An HQ administrator must add one first.</p>}
            <div className="workspace-form-actions">
              <button className="secondary-button" onClick={() => setExpenseDialogOpen(false)} type="button">Cancel</button>
              <button className="primary-button" disabled={expenseSaving || !categories.length} type="submit">
                {expenseSaving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                {expenseSaving ? "Recording…" : "Record expense"}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}

      {categoryDialogOpen && (
        <WorkspaceDialog
          eyebrow="Expenses"
          onClose={() => setCategoryDialogOpen(false)}
          title="Add expense category"
        >
          <form className="workspace-form" onSubmit={saveExpenseCategory}>
            <WorkspaceError message={categoryError} />
            <WorkspaceField label="Category name">
              <input
                autoFocus
                maxLength={100}
                onChange={(event) => setCategoryName(event.target.value)}
                required
                value={categoryName}
              />
            </WorkspaceField>
            <div className="workspace-form-actions">
              <button className="secondary-button" onClick={() => setCategoryDialogOpen(false)} type="button">Cancel</button>
              <button className="primary-button" disabled={categorySaving} type="submit">
                {categorySaving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                {categorySaving ? "Saving…" : "Add category"}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </div>
  );
}
