"use client";

import {
  AlertCircle, BarChart3, LoaderCircle, Package, PackageSearch, Plus, RefreshCw,
  Search, X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatDateTime, formatMoney, formatQuantity, labelize } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface InventoryProduct {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category_name: string | null;
  unit_code: string;
  stock_milli: number;
  reorder_point_milli: number | null;
  min_stock_milli: number | null;
  cost_price_paisa: number | null;
  is_active: boolean;
}

interface InventoryMovement {
  id: string;
  branch_id: string;
  branch_name: string;
  product_id: string;
  product_name: string;
  unit_code: string;
  movement_type: string;
  label: string;
  quantity_delta_milli: number;
  balance_milli: number | null;
  unit_cost_paisa: number | null;
  reference_type: string | null;
  reference_id: string | null;
  receipt_number: string | null;
  occurred_at: string;
  notes: string | null;
  created_by_name: string | null;
}

interface InventoryStocktake {
  id: string;
  branch_id: string;
  branch_name: string;
  notes: string | null;
  created_at: string;
  created_by_name: string | null;
  item_count: number;
  changed_count: number;
  total_variance_milli: number;
}

interface InventoryResponse {
  branchId: string | null;
  branchName: string;
  products: InventoryProduct[];
  totals: {
    productCount: number;
    quantityMilli: number;
    lowStockCount: number;
    outOfStockCount: number;
    estimatedValuePaisa: number;
    productsShown: number;
    truncated: boolean;
    valuationComplete: boolean;
  };
  movements: InventoryMovement[];
  movementLimit: number;
  stocktakes: InventoryStocktake[];
  canViewStocktakes: boolean;
  note?: string;
  error?: string;
}

interface StocktakeDetail {
  id: string;
  branch_id: string;
  branch_name: string;
  notes: string | null;
  created_at: string;
  created_by_name: string;
  items: Array<{
    product_id: string;
    product_name: string;
    unit_code: string;
    system_quantity_milli: number;
    counted_quantity_milli: number;
    variance_milli: number;
  }>;
}

function stockTone(stockMilli: number, reorderMilli: number | null): { label: string; tone: string } {
  if (stockMilli <= 0) return { label: "Out of stock", tone: "red" };
  if (reorderMilli != null && stockMilli <= reorderMilli) return { label: "Reorder", tone: "amber" };
  return { label: "In stock", tone: "green" };
}

function signedQuantity(milli: number): string {
  return `${milli > 0 ? "+" : ""}${formatQuantity(milli)}`;
}

export function InventoryWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [search, setSearch] = useState("");
  const [productId, setProductId] = useState("");
  const [payload, setPayload] = useState<InventoryResponse | null>(null);
  const [detail, setDetail] = useState<StocktakeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isAdmin = staff?.role === "admin";

  useEffect(() => {
    if (!staff) return;
    if (staff.role === "admin" && !branchId) setBranchId("all");
    else if (staff.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff]);

  useEffect(() => {
    if (!staff) return undefined;
    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams();
    if (branchId) parameters.set("branchId", branchId);
    if (search.trim()) parameters.set("search", search.trim());
    if (productId) parameters.set("productId", productId);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/workspace/inventory?${parameters.toString()}`, {
            cache: "no-store",
            credentials: "same-origin",
          });
          const result = await response.json() as InventoryResponse;
          if (!active) return;
          if (!response.ok) throw new Error(result.error || "Could not load branch inventory.");
          setPayload(result);
        } catch (loadError) {
          if (!active) return;
          setError(loadError instanceof Error ? loadError.message : "Could not load branch inventory.");
          setPayload(null);
        } finally {
          if (active) setLoading(false);
        }
      })();
    }, search.trim() ? 220 : 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [branchId, productId, reloadKey, search, staff]);

  const openDetail = async (stocktake: InventoryStocktake) => {
    setDetailLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspace/inventory?detailId=${encodeURIComponent(stocktake.id)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as { detail?: StocktakeDetail; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not load the stocktake counts.");
      setDetail(result.detail || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the stocktake counts.");
    } finally {
      setDetailLoading(false);
    }
  };

  const totals = payload?.totals;
  const cards = totals ? [
    { label: "Products shown", value: totals.productCount.toLocaleString(), note: totals.truncated ? `Showing the first ${totals.productsShown}` : "All matching products" },
    { label: "Quantity shown", value: `${formatQuantity(totals.quantityMilli)} units`, note: `${totals.outOfStockCount} out of stock` },
    { label: "Low stock · shown", value: totals.lowStockCount.toLocaleString(), note: "At or below the reorder point" },
    {
      label: "Estimated value",
      value: formatMoney(totals.estimatedValuePaisa),
      note: totals.valuationComplete ? "Current product cost · shown products" : "Shown products · search-scoped",
    },
  ] : [];

  const movementProductOptions = useMemo(() => payload?.products || [], [payload?.products]);
  const stocktakeColumnCount = isAdmin ? 8 : 7;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Stock-on-hand is calculated from the append-only movement ledger and matches the desktop inventory.</p>
        </div>
        <div className="inventory-actions">
          <button
            className="button secondary"
            type="button"
            disabled
            title="Recording stock movements remains a Windows desktop workflow."
          >
            <Plus size={15} /> Record movement
          </button>
          <button
            className="button secondary"
            type="button"
            disabled
            title="Physical stocktakes remain a Windows desktop workflow."
          >
            <PackageSearch size={15} /> Start stocktake
          </button>
        </div>
      </div>

      <div className="notice info" role="note">
        <Package size={16} />
        <span>{payload?.note || "On-hand stock is calculated from the synchronized movement ledger. Recording movements and stocktakes remains a Windows desktop workflow."}</span>
      </div>

      <div className="daily-report-toolbar daily-report-no-print">
        {isAdmin && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select
              className="toolbar-select"
              value={branchId || "all"}
              onChange={(event) => {
                setDetail(null);
                setProductId("");
                setBranchId(event.target.value);
              }}
            >
              <option value="all">All accessible branches</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="Search inventory"
            placeholder="Search name, SKU or barcode"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="toolbar-control">
          <span>Movement product</span>
          <select className="toolbar-select" value={productId} onChange={(event) => setProductId(event.target.value)}>
            <option value="">All products</option>
            {movementProductOptions.map((product) => (
              <option key={product.id} value={product.id}>{product.name}</option>
            ))}
          </select>
        </label>
        <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
          {loading ? <><LoaderCircle className="spin" size={14} /> Loading…</> : <><RefreshCw size={14} /> Refresh</>}
        </button>
      </div>

      {error && (
        <div className="card panel" role="alert">
          <div className="inline-message error"><AlertCircle size={16} /><span>{error}</span></div>
        </div>
      )}

      {loading && !payload && <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading branch inventory…</div>}

      {payload && (
        <>
          <section className="dashboard-stats" aria-label="Inventory summary">
            {cards.map((card) => (
              <article className="dashboard-stat card" key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.note}</small>
              </article>
            ))}
          </section>

          <section className="card table-wrap workspace-table" aria-label="Branch inventory">
            <div className="table-document-heading">
              <strong>Branch inventory · {payload.branchName}</strong>
              <TableDocumentTools tableId="inventory-products" title={`${item.title} · ${payload.branchName}`} disabled={!payload.products.length} />
            </div>
            {payload.products.length ? (
              <table id="inventory-products">
                <thead>
                  <tr>
                    <th>Product</th><th>SKU / barcode</th><th>On hand</th>
                    <th>Reorder point</th><th>Unit</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.products.map((product) => {
                    const tone = stockTone(product.stock_milli, product.reorder_point_milli);
                    return (
                      <tr key={product.id}>
                        <td>
                          <span className="primary-cell">{product.name}</span>
                          <small className="sales-cell-subtext">{product.category_name || "Uncategorized"}</small>
                        </td>
                        <td className="mono">{product.sku || "—"}<small className="sales-cell-subtext">{product.barcode || ""}</small></td>
                        <td className="nowrap">{formatQuantity(product.stock_milli)}</td>
                        <td className="nowrap">{product.reorder_point_milli == null ? "—" : formatQuantity(product.reorder_point_milli)}</td>
                        <td>{product.unit_code}</td>
                        <td><span className={`status ${tone.tone}`}>{tone.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="empty">
                <Package size={23} />
                <h2>No products found</h2>
                <p>Try a different search or branch selection.</p>
              </div>
            )}
          </section>

          <div className="section-heading">
            <div><p className="eyebrow page">Ledger</p><h2>Stock movement history</h2></div>
            <BarChart3 size={19} aria-hidden="true" />
          </div>

          <section className="card table-wrap workspace-table" aria-label="Stock movement history">
            <div className="table-document-heading">
              <strong>Latest {payload.movements.length} movement{payload.movements.length === 1 ? "" : "s"} · {payload.branchName}</strong>
              <TableDocumentTools tableId="inventory-movements" title={`${item.title} · movements`} disabled={!payload.movements.length} />
            </div>
            <table id="inventory-movements">
              <thead>
                <tr>
                  <th>Date</th>{isAdmin && <th>Branch</th>}<th>Product</th><th>Movement</th>
                  <th>Change</th><th>Balance after</th><th>Unit cost</th><th>Reference / reason</th><th>Staff</th>
                </tr>
              </thead>
              <tbody>
                {payload.movements.length ? payload.movements.map((movement) => (
                  <tr key={movement.id}>
                    <td className="nowrap">{formatDateTime(movement.occurred_at)}</td>
                    {isAdmin && <td>{movement.branch_name}</td>}
                    <td><span className="primary-cell">{movement.product_name}</span></td>
                    <td><span className={`status ${movement.quantity_delta_milli < 0 ? "amber" : "green"}`}>{labelize(movement.label)}</span></td>
                    <td className={`nowrap ${movement.quantity_delta_milli < 0 ? "movement-negative" : "movement-positive"}`}>
                      {signedQuantity(movement.quantity_delta_milli)} {movement.unit_code}
                    </td>
                    <td className="nowrap">{movement.balance_milli == null ? "—" : `${formatQuantity(movement.balance_milli)} ${movement.unit_code}`}</td>
                    <td className="nowrap">{movement.unit_cost_paisa == null ? "—" : formatMoney(movement.unit_cost_paisa)}</td>
                    <td>{movement.receipt_number || movement.notes || (movement.reference_type ? labelize(movement.reference_type) : "—")}</td>
                    <td>{movement.created_by_name || "—"}</td>
                  </tr>
                )) : <tr><td colSpan={isAdmin ? 9 : 8} className="empty">No stock movements recorded for this scope.</td></tr>}
              </tbody>
            </table>
          </section>

          {payload.canViewStocktakes && (
            <>
              <div className="section-heading">
                <div><p className="eyebrow page">Counts</p><h2>Stocktake history</h2></div>
                <PackageSearch size={19} aria-hidden="true" />
              </div>

              <section className="card table-wrap workspace-table" aria-label="Stocktake history">
                <div className="table-document-heading">
                  <strong>Immutable count snapshots · {payload.branchName}</strong>
                  <TableDocumentTools tableId="inventory-stocktakes" title={`${item.title} · stocktakes`} disabled={!payload.stocktakes.length} />
                </div>
                <table id="inventory-stocktakes">
                  <thead>
                    <tr>
                      <th>Date</th>{isAdmin && <th>Branch</th>}<th>Counted by</th><th>Notes</th>
                      <th>Products counted</th><th>Adjusted</th><th>Net variance</th><th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.stocktakes.length ? payload.stocktakes.map((stocktake) => (
                      <tr key={stocktake.id}>
                        <td className="nowrap">{formatDateTime(stocktake.created_at)}</td>
                        {isAdmin && <td>{stocktake.branch_name}</td>}
                        <td>{stocktake.created_by_name || "—"}</td>
                        <td>{stocktake.notes || "—"}</td>
                        <td>{stocktake.item_count}</td>
                        <td>{stocktake.changed_count}</td>
                        <td className={`nowrap ${stocktake.total_variance_milli < 0 ? "movement-negative" : stocktake.total_variance_milli > 0 ? "movement-positive" : ""}`}>
                          {stocktake.total_variance_milli === 0 ? "0" : signedQuantity(stocktake.total_variance_milli)}
                        </td>
                        <td>
                          <button className="button secondary" type="button" disabled={detailLoading} onClick={() => void openDetail(stocktake)}>
                            View counts
                          </button>
                        </td>
                      </tr>
                    )) : <tr><td colSpan={stocktakeColumnCount} className="empty">No stocktakes recorded for this branch.</td></tr>}
                  </tbody>
                </table>
              </section>
            </>
          )}

          {detail && (
            <section className="card table-wrap workspace-table" aria-label="Stocktake count details">
              <div className="table-document-heading">
                <strong>{formatDateTime(detail.created_at)} · {detail.created_by_name} · {detail.branch_name}</strong>
                <div className="heading-actions">
                  <button className="button secondary" type="button" disabled title="Recording stocktake counts is a Windows desktop workflow.">Record counts</button>
                  <button className="button secondary" type="button" onClick={() => setDetail(null)}><X size={13} /> Close</button>
                </div>
              </div>
              {detail.notes && <p className="list-limit-note">{detail.notes}</p>}
              <table id="inventory-stocktake-details">
                <thead><tr><th>Product</th><th>System</th><th>Counted</th><th>Variance</th></tr></thead>
                <tbody>
                  {detail.items.length ? detail.items.map((line) => (
                    <tr key={line.product_id}>
                      <td><span className="primary-cell">{line.product_name}</span><small className="sales-cell-subtext">{line.unit_code}</small></td>
                      <td>{formatQuantity(line.system_quantity_milli)}</td>
                      <td>{formatQuantity(line.counted_quantity_milli)}</td>
                      <td className={line.variance_milli < 0 ? "movement-negative" : line.variance_milli > 0 ? "movement-positive" : ""}>
                        {line.variance_milli === 0 ? "0" : signedQuantity(line.variance_milli)}
                      </td>
                    </tr>
                  )) : <tr><td colSpan={4} className="empty">No product counts are available for this stocktake.</td></tr>}
                </tbody>
              </table>
            </section>
          )}

          <p className="list-limit-note">
            Showing {payload.products.length} product{payload.products.length === 1 ? "" : "s"} · latest {payload.movements.length} movement{payload.movements.length === 1 ? "" : "s"}
            {payload.canViewStocktakes ? ` · latest ${payload.stocktakes.length} stocktake${payload.stocktakes.length === 1 ? "" : "s"}` : ""}.
            {" "}Read-only view of the synchronized ledger.
          </p>
        </>
      )}
    </>
  );
}

export default InventoryWorkspace;
