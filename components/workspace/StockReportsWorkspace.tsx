"use client";

import { AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatMoney, formatQuantity } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";

interface StockReportProduct {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category_id: string | null;
  category_name: string | null;
  unit_code: string;
  stock_milli: number;
  cost_price_paisa: number | null;
  reorder_point_milli: number | null;
  max_stock_milli: number | null;
}

interface StockReportsResponse {
  branchId: string | null;
  branchName: string;
  products: StockReportProduct[];
  sourceProductCount: number;
  reportComplete: boolean;
  availability: {
    stock: boolean;
    valuation: boolean;
    replenishment: boolean;
    movements: boolean;
    activeProductsOnly: boolean;
  };
  error?: string;
}

type StockScope = "all" | "low" | "out" | "negative";

const PAGE_SIZES = [25, 50, 100];

function stockValuePaisa(product: StockReportProduct): number | null {
  if (product.cost_price_paisa == null) return null;
  return Math.round(Math.max(product.stock_milli, 0) * product.cost_price_paisa / 1000);
}

function stockStatus(product: StockReportProduct): { label: string; tone: string } {
  if (product.stock_milli < 0) return { label: "Negative", tone: "red" };
  if (product.stock_milli === 0) return { label: "Out of stock", tone: "red" };
  if (product.reorder_point_milli != null && product.stock_milli <= product.reorder_point_milli) {
    return { label: "Reorder", tone: "amber" };
  }
  return { label: "In stock", tone: "green" };
}

export function StockReportsWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [branchId, setBranchId] = useState("all");
  const [report, setReport] = useState<StockReportsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [scope, setScope] = useState<StockScope>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isAdmin = staff?.role === "admin";
  const selectedBranchId = isAdmin ? branchId : staff?.branch_id || "";
  const selectedBranchName = selectedBranchId === "all"
    ? "All branches"
    : branches.find((branch) => branch.id === selectedBranchId)?.name || "Your branch";

  useEffect(() => {
    if (!staff || !selectedBranchId) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams({ branchId: selectedBranchId });

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/stock-reports?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as StockReportsResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load stock reports.");
        setReport(result);
      } catch (loadError) {
        if (!active) return;
        setReport(null);
        setError(loadError instanceof Error ? loadError.message : "Could not load stock reports.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [reloadKey, selectedBranchId, staff]);

  useEffect(() => {
    setPage(1);
  }, [branchId, categoryId, pageSize, scope, search]);

  const categories = useMemo(() => {
    const entries = new Map<string, string>();
    (report?.products || []).forEach((product) => {
      if (product.category_id && product.category_name) entries.set(product.category_id, product.category_name);
    });
    return [...entries.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [report?.products]);

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (report?.products || []).filter((product) => {
      if (categoryId !== "all" && product.category_id !== categoryId) return false;
      if (query && ![product.name, product.sku || "", product.barcode || ""]
        .some((value) => value.toLocaleLowerCase().includes(query))) return false;
      if (scope === "low") {
        return product.reorder_point_milli != null && product.stock_milli <= product.reorder_point_milli;
      }
      if (scope === "out") return product.stock_milli === 0;
      if (scope === "negative") return product.stock_milli < 0;
      return true;
    }).sort((left, right) =>
      (left.stock_milli - right.stock_milli) || left.name.localeCompare(right.name));
  }, [categoryId, report?.products, scope, search]);

  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const visibleProducts = filteredProducts.slice((page - 1) * pageSize, page * pageSize);
  const totals = useMemo(() => {
    if (!report?.reportComplete) return null;
    const products = report.products;
    const valuationAvailable = report.availability.valuation
      && products.every((product) => product.cost_price_paisa != null);
    const replenishmentAvailable = report.availability.replenishment
      && products.every((product) => product.reorder_point_milli != null);
    return {
      productCount: products.length,
      positiveUnitsMilli: products.reduce((sum, product) => sum + Math.max(product.stock_milli, 0), 0),
      valuePaisa: valuationAvailable
        ? products.reduce((sum, product) => sum + (stockValuePaisa(product) || 0), 0)
        : null,
      lowStockCount: replenishmentAvailable
        ? products.filter((product) => product.stock_milli <= (product.reorder_point_milli || 0)).length
        : null,
      negativeCount: products.filter((product) => product.stock_milli < 0).length,
    };
  }, [report]);

  const reportComplete = Boolean(report?.reportComplete);

  return (
    <div className="daily-report-print">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>Read-only on-hand balances, cost valuation, and replenishment thresholds for {selectedBranchName}.</p>
        </div>
      </div>

      <div className="daily-report-toolbar daily-report-no-print">
        {isAdmin && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select className="toolbar-select" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="all">All branches</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
        <label className="toolbar-control">
          <span>Search products</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, SKU or barcode" />
        </label>
        <label className="toolbar-control">
          <span>Category</span>
          <select className="toolbar-select" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="all">All categories</option>
            {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="toolbar-control">
          <span>Stock scope</span>
          <select className="toolbar-select" value={scope} onChange={(event) => setScope(event.target.value as StockScope)}>
            <option value="all">All active products</option>
            <option value="low" disabled={!report?.availability.replenishment}>At or below reorder point</option>
            <option value="out">Out of stock</option>
            <option value="negative">Negative balance</option>
          </select>
        </label>
        <button className="button secondary" type="button" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}>
          {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      <div className="live-readonly-note daily-report-no-print">
        <AlertCircle size={16} />
        <span>Live cloud figures · read-only. Balances use the staff-scoped stock catalog and product costs/thresholds are shown only when RLS permits.</span>
      </div>

      {error && <div className="notice" role="alert">{error}</div>}
      {loading && !report && <div className="loading"><LoaderCircle className="spin" size={18} /> Loading stock reports…</div>}
      {!loading && !report && !error && <div className="empty"><h2>No stock report available</h2><p>Refresh to load the latest permitted branch stock.</p></div>}

      {report && (
        <>
          {!report.reportComplete && (
            <div className="notice" role="status">
              This result is incomplete: the full active catalog is larger than the safe report limit. Summary totals are withheld; choose a branch or contact an administrator for a complete report.
            </div>
          )}
          {(!report.availability.valuation || !report.availability.replenishment) && (
            <div className="notice" role="status">
              {[
                !report.availability.valuation ? "Cost valuation is unavailable under this login's row-level access." : "",
                !report.availability.replenishment ? "Reorder thresholds are unavailable under this login's row-level access." : "",
              ].filter(Boolean).join(" ")}
            </div>
          )}
          {!report.availability.movements && (
            <div className="notice" role="status">
              Stock movement history is not exposed through the typed, staff-authorized cloud report API. This page does not infer movement totals from current balances.
            </div>
          )}
          {report.availability.activeProductsOnly && (
            <p className="daily-report-empty">This staff-scoped catalog includes active products only; inactive-product balances are not available here.</p>
          )}

          <div className="dashboard-stats daily-report-stats">
            <div className="dashboard-stat card"><span>Stock value</span><strong>{totals?.valuePaisa == null ? "Unavailable" : formatMoney(totals.valuePaisa)}</strong><small>At recorded cost</small></div>
            <div className="dashboard-stat card"><span>Positive units on hand</span><strong>{totals ? formatQuantity(totals.positiveUnitsMilli) : "Unavailable"}</strong><small>{totals ? `${totals.productCount} active products` : "Complete balance set required"}</small></div>
            <div className="dashboard-stat card"><span>At or below reorder</span><strong>{totals?.lowStockCount == null ? "Unavailable" : String(totals.lowStockCount)}</strong><small>Uses stored reorder points</small></div>
            <div className="dashboard-stat card"><span>Negative balances</span><strong>{totals ? String(totals.negativeCount) : "Unavailable"}</strong><small>Current ledger balance</small></div>
          </div>

          <section className="daily-report-panel card">
            <div className="daily-report-panel-heading">
              <div><h2>On-hand stock · {report.branchName}</h2><p>{filteredProducts.length} matching products · {report.sourceProductCount} active in source catalog</p></div>
              <TableDocumentTools tableId="stock-reports-table" title={`Stock report · ${report.branchName}`} disabled={!visibleProducts.length || loading} />
            </div>
            <div className="table-wrap">
              <table id="stock-reports-table">
                <thead>
                  <tr>
                    <th>Product</th><th>Category</th><th>On hand</th><th>Reorder point</th>
                    <th>Maximum</th><th>Value at cost</th><th>Replenishment</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProducts.length ? visibleProducts.map((product) => {
                    const status = stockStatus(product);
                    const value = stockValuePaisa(product);
                    const replenish = product.reorder_point_milli == null
                      ? "Unavailable"
                      : product.stock_milli <= product.reorder_point_milli
                        ? "At or below reorder point"
                        : product.max_stock_milli != null && product.max_stock_milli > 0
                          && product.stock_milli < product.max_stock_milli
                          ? `Top up by ${formatQuantity(product.max_stock_milli - product.stock_milli)}`
                          : "No reorder indicated";
                    return (
                      <tr key={product.id}>
                        <td><strong>{product.name}</strong><small className="row-note mono">{product.sku || product.barcode || "—"}</small></td>
                        <td>{product.category_name || "—"}</td>
                        <td>{formatQuantity(product.stock_milli)} <small className="unit-note">{product.unit_code}</small></td>
                        <td>{product.reorder_point_milli == null ? "Unavailable" : formatQuantity(product.reorder_point_milli)}</td>
                        <td>{product.max_stock_milli == null ? "Unavailable" : product.max_stock_milli > 0 ? formatQuantity(product.max_stock_milli) : "Not set"}</td>
                        <td>{value == null ? "Unavailable" : formatMoney(value)}</td>
                        <td><span className={`status ${status.tone}`}>{status.label}</span><small className="row-note">{replenish}</small></td>
                      </tr>
                    );
                  }) : (
                    <tr><td className="daily-report-empty-cell" colSpan={7}>No products match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="daily-report-toolbar daily-report-no-print">
              <label className="toolbar-control">
                <span>Rows per page</span>
                <select className="toolbar-select" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                  {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
              <span className="daily-report-empty">
                {filteredProducts.length ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filteredProducts.length)} of ${filteredProducts.length}` : "0 results"}
                {" · Export and print include this page"}
              </span>
              <button className="button secondary" type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
              <span className="daily-report-empty">Page {page} of {pageCount}</span>
              <button className="button secondary" type="button" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>Next</button>
            </div>
          </section>

          <section className="daily-report-panel card">
            <h2>Stock movements</h2>
            <p className="daily-report-empty">Movement dates, quantities, and references are not available in the cloud schema exposed to this staff session. A staff-safe, RLS-protected movement report endpoint is required before this section can show live transactions.</p>
          </section>
        </>
      )}
    </div>
  );
}
