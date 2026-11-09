"use client";

import { AlertCircle, LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { formatMoney, formatQuantity } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { WorkspaceReportActions } from "@/components/workspace/WorkspaceReportActions";
import { generateBranchInventoryDocument } from "@/lib/print/reports";

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
  const { settings: businessSettings } = useBusinessSettings();
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
          {report.availability.activeProductsOnly && (
            <p className="daily-report-empty">This staff-scoped catalog includes active products only; inactive-product balances are not available here.</p>
          )}

          <div className="dashboard-stats daily-report-stats">
            <div className="dashboard-stat card"><span>Stock value</span><strong>{totals?.valuePaisa == null ? "Unavailable" : formatMoney(totals.valuePaisa)}</strong><small>At recorded cost</small></div>
            <div className="dashboard-stat card"><span>Positive units on hand</span><strong>{totals ? formatQuantity(totals.positiveUnitsMilli) : "Unavailable"}</strong><small>{totals ? `${totals.productCount} active products` : "Complete balance set required"}</small></div>
            <div className="dashboard-stat card"><span>At or below reorder</span><strong>{totals?.lowStockCount == null ? "Unavailable" : String(totals.lowStockCount)}</strong><small>Uses stored reorder points</small></div>
            <div className="dashboard-stat card"><span>Negative balances</span><strong>{totals ? String(totals.negativeCount) : "Unavailable"}</strong><small>Current ledger balance</small></div>
          </div>

          <HorizontalFilterScroller className="stock-reports-filterbar daily-report-no-print" ariaLabel="Stock report filters">
            <label className="search-field stock-reports-search">
              <Search size={16} aria-hidden="true" />
              <input
                aria-label="Search stock report products"
                placeholder="Name, SKU or barcode"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {isAdmin && (
              <label className="toolbar-control stock-reports-control">
                <span>Branch</span>
                <SearchableFilter
                  value={branchId}
                  ariaLabel="Filter stock report by branch"
                  placeholder="All branches"
                  options={[
                    { value: "all", label: "All branches" },
                    ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
                  ]}
                  onChange={setBranchId}
                />
              </label>
            )}
            <label className="toolbar-control stock-reports-control">
              <span>Category</span>
              <SearchableFilter
                value={categoryId}
                ariaLabel="Filter stock report by category"
                placeholder="All categories"
                options={[
                  { value: "all", label: "All categories" },
                  ...categories.map(([id, name]) => ({ value: id, label: name })),
                ]}
                onChange={setCategoryId}
              />
            </label>
            <label className="toolbar-control stock-reports-control">
              <span>Stock scope</span>
              <SearchableFilter
                value={scope}
                ariaLabel="Filter stock report by stock scope"
                placeholder="All active products"
                options={[
                  { value: "all", label: "All active products" },
                  ...((report.availability.replenishment || scope === "low")
                    ? [{ value: "low", label: "At or below reorder point" }]
                    : []),
                  { value: "out", label: "Out of stock" },
                  { value: "negative", label: "Negative balance" },
                ]}
                onChange={(value) => setScope(value as StockScope)}
              />
            </label>
          </HorizontalFilterScroller>
          <WorkspaceReportActions
            title={item.title}
            sections={[{
              title: `On-hand stock · ${report.branchName}`,
              columns: ["Product", "Category", "SKU / barcode", "On hand", "Reorder point", "Maximum", "Value at cost", "Replenishment"],
              rows: filteredProducts.map((product) => {
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
                return [
                  product.name,
                  product.category_name || "—",
                  product.sku || product.barcode || "—",
                  `${formatQuantity(product.stock_milli)} ${product.unit_code}`,
                  product.reorder_point_milli == null ? "Unavailable" : formatQuantity(product.reorder_point_milli),
                  product.max_stock_milli == null ? "Unavailable" : product.max_stock_milli > 0 ? formatQuantity(product.max_stock_milli) : "Not set",
                  value == null ? "Unavailable" : formatMoney(value),
                  `${status.label} · ${replenish}`,
                ];
              }),
            }]}
            summary={totals ? [
              ["Positive units on hand", formatQuantity(totals.positiveUnitsMilli)],
              ["Products", totals.productCount],
              ["Stock value", totals.valuePaisa == null ? "Unavailable" : formatMoney(totals.valuePaisa)],
              ["At or below reorder", totals.lowStockCount == null ? "Unavailable" : totals.lowStockCount],
              ["Negative balances", totals.negativeCount],
            ] : []}
            metadata={{
              branch: report.branchName,
              printedBy: staff?.full_name || "Staff",
              filterSummary: [
                search.trim() ? `Search: ${search.trim()}` : "",
                categoryId !== "all" ? `Category: ${categories.find(([id]) => id === categoryId)?.[1] || categoryId}` : "",
                scope !== "all" ? `Stock scope: ${scope}` : "",
                report.reportComplete ? "" : "Source report is incomplete due to the safe catalog limit",
              ].filter(Boolean).join(" · "),
            }}
            onRefresh={() => setReloadKey((key) => key + 1)}
            refreshing={loading}
            disabled={!report || loading}
          />

          <section className="daily-report-panel card">
            <div className="daily-report-panel-heading">
              <div><h2>On-hand stock · {report.branchName}</h2><p>{filteredProducts.length} matching products · {report.sourceProductCount} active in source catalog</p></div>
              <TableDocumentTools
                tableId="stock-reports-table"
                title={`Stock report · ${report.branchName}`}
                orientationKey="branch-inventory"
                disabled={!visibleProducts.length || loading}
                buildDocument={(orientation) => visibleProducts.length
                  ? generateBranchInventoryDocument({ products: visibleProducts, branchName: report.branchName }, {
                      branding: {
                        businessName: businessSettings.businessName,
                        businessTagline: businessSettings.businessTagline,
                        logoDataUrl: businessSettings.logoDataUrl,
                      },
                      orientationPreference: orientation,
                      branch: report.branchName,
                      printedBy: staff?.full_name || "Staff",
                    })
                  : null}
              />
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
        </>
      )}
    </div>
  );
}
