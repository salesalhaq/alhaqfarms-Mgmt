"use client";

import {
  AlertCircle, BarChart3, LoaderCircle, Package, PackageSearch, Plus, RefreshCw,
  Save, Search, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { TableControls } from "@/components/workspace/TableControls";
import {
  WorkspaceDialog,
  WorkspaceError,
  WorkspaceField,
  WorkspaceSuccess,
} from "@/components/workspace/WorkspaceDialog";
import { formatDateTime, formatMoney, formatQuantity, labelize } from "@/lib/format";
import { postWorkspaceAction } from "@/lib/workspace/write-client";
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
  canRecordMovements: boolean;
  canRecordStocktakes: boolean;
  branches: Array<{ id: string; name: string; code: string }>;
  note?: string;
  error?: string;
}

type MovementType = "adjustment" | "damage" | "loss" | "expiry";

interface MovementForm {
  productId: string;
  movementType: MovementType;
  direction: "add" | "remove";
  quantity: string;
  reason: string;
}

const EMPTY_MOVEMENT_FORM: MovementForm = {
  productId: "",
  movementType: "adjustment",
  direction: "add",
  quantity: "",
  reason: "",
};

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

function quantityToMilli(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] || "").padEnd(3, "0"));
  const result = whole * 1000 + fraction;
  return Number.isSafeInteger(result) ? result : null;
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
  const [movementOpen, setMovementOpen] = useState(false);
  const [stocktakeOpen, setStocktakeOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [movementForm, setMovementForm] = useState<MovementForm>(EMPTY_MOVEMENT_FORM);
  const [stocktakeCounts, setStocktakeCounts] = useState<Record<string, string>>({});
  const [stocktakeNotes, setStocktakeNotes] = useState("");
  const [targetBranchId, setTargetBranchId] = useState("");
  const [targetBranchProducts, setTargetBranchProducts] = useState<InventoryProduct[]>([]);
  const [targetProductsLoading, setTargetProductsLoading] = useState(false);
  const targetProductsRequest = useRef(0);

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

  const loadTargetBranchProducts = async (selectedBranchId: string) => {
    const requestId = ++targetProductsRequest.current;
    setTargetProductsLoading(true);
    setActionError(null);
    try {
      const parameters = new URLSearchParams({ branchId: selectedBranchId });
      if (search.trim()) parameters.set("search", search.trim());
      const response = await fetch(`/api/workspace/inventory?${parameters.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as InventoryResponse;
      if (!response.ok) throw new Error(result.error || "Could not load products for this branch.");
      if (requestId !== targetProductsRequest.current) return;
      setTargetBranchProducts(result.products);
    } catch (loadError) {
      if (requestId !== targetProductsRequest.current) return;
      setTargetBranchProducts([]);
      setActionError(loadError instanceof Error ? loadError.message : "Could not load products for this branch.");
    } finally {
      if (requestId === targetProductsRequest.current) setTargetProductsLoading(false);
    }
  };

  const handleTargetBranchChange = (selectedBranchId: string) => {
    targetProductsRequest.current += 1;
    setTargetBranchId(selectedBranchId);
    setTargetBranchProducts([]);
    if (selectedBranchId) void loadTargetBranchProducts(selectedBranchId);
    else setTargetProductsLoading(false);
  };

  const openMovementDialog = () => {
    setActionError(null);
    setActionMessage(null);
    setMovementForm(EMPTY_MOVEMENT_FORM);
    targetProductsRequest.current += 1;
    setTargetProductsLoading(false);
    setTargetBranchId(branchId === "all" ? "" : branchId);
    setTargetBranchProducts([]);
    setMovementOpen(true);
  };

  const openStocktakeDialog = () => {
    setActionError(null);
    setActionMessage(null);
    setStocktakeCounts({});
    setStocktakeNotes("");
    targetProductsRequest.current += 1;
    setTargetProductsLoading(false);
    setTargetBranchId(branchId === "all" ? "" : branchId);
    setTargetBranchProducts([]);
    setStocktakeOpen(true);
  };

  const submitMovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const quantityMilli = quantityToMilli(movementForm.quantity);
    if (quantityMilli == null || quantityMilli <= 0) {
      setActionError("Enter a quantity greater than zero with no more than three decimal places.");
      return;
    }
    if (!actionBranchId) {
      setActionError("Choose a target branch before recording stock.");
      return;
    }

    setActionBusy(true);
    setActionError(null);
    try {
      await postWorkspaceAction("/api/workspace/inventory", {
        action: "movement",
        branchId: actionBranchId,
        productId: movementForm.productId,
        quantityDeltaMilli: movementForm.movementType === "adjustment" && movementForm.direction === "add"
          ? quantityMilli
          : -quantityMilli,
        movementType: movementForm.movementType,
        reason: movementForm.reason,
      });
      setMovementOpen(false);
      setMovementForm(EMPTY_MOVEMENT_FORM);
      setActionMessage("Stock movement recorded.");
      setReloadKey((value) => value + 1);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : "The stock movement could not be recorded.");
    } finally {
      setActionBusy(false);
    }
  };

  const submitStocktake = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const items: Array<{ productId: string; countedQuantityMilli: number }> = [];
    for (const [productIdValue, count] of Object.entries(stocktakeCounts)) {
      if (!count.trim()) continue;
      const countedQuantityMilli = quantityToMilli(count);
      if (countedQuantityMilli == null) {
        const product = actionProducts.find((row) => row.id === productIdValue);
        setActionError(`Enter a valid count for ${product?.name || "each product"} with no more than three decimal places.`);
        return;
      }
      items.push({ productId: productIdValue, countedQuantityMilli });
    }
    if (!items.length) {
      setActionError("Enter at least one physical count to reconcile stock.");
      return;
    }
    if (!actionBranchId) {
      setActionError("Choose a target branch before recording counts.");
      return;
    }

    setActionBusy(true);
    setActionError(null);
    try {
      const response = await postWorkspaceAction<{
        result?: { itemCount?: number; changedCount?: number };
      }>("/api/workspace/inventory", {
        action: "stocktake",
        branchId: actionBranchId,
        items,
        notes: stocktakeNotes,
      });
      setStocktakeOpen(false);
      setStocktakeCounts({});
      setStocktakeNotes("");
      setActionMessage(
        `Stocktake recorded: ${response.result?.itemCount ?? items.length} counted, ${response.result?.changedCount ?? 0} adjusted.`,
      );
      setReloadKey((value) => value + 1);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : "The stocktake could not be recorded.");
    } finally {
      setActionBusy(false);
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
  const actionBranchId = branchId === "all" ? targetBranchId : branchId;
  const actionProducts = branchId === "all" ? targetBranchProducts : payload?.products || [];

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Stock-on-hand is calculated from the append-only movement ledger and matches the desktop inventory.</p>
        </div>
        <div className="inventory-actions">
          {payload?.canRecordStocktakes && (
            <button className="button secondary" type="button" onClick={openStocktakeDialog}>
              <PackageSearch size={15} /> Start stocktake
            </button>
          )}
          {payload?.canRecordMovements && (
            <button className="button primary" type="button" onClick={openMovementDialog}>
              <Plus size={15} /> Record movement
            </button>
          )}
        </div>
      </div>

      <div className="notice info" role="note">
        <Package size={16} />
        <span>{payload?.note || "On-hand stock is calculated from the append-only movement ledger."}</span>
      </div>
      <WorkspaceSuccess message={actionMessage} />

      <HorizontalFilterScroller className="inventory-filterbar daily-report-no-print" ariaLabel="Inventory filters">
        {isAdmin && (
          <label className="toolbar-control inventory-filter">
            <span>Branch</span>
            <SearchableFilter
              value={branchId || "all"}
              ariaLabel="Filter inventory by branch"
              placeholder="All accessible branches"
              options={[
                { value: "all", label: "All accessible branches" },
                ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
              ]}
              onChange={(value) => {
                setDetail(null);
                setProductId("");
                setBranchId(value);
              }}
            />
          </label>
        )}
        <label className="search-field inventory-search">
          <Search size={16} />
          <input
            aria-label="Search inventory"
            placeholder="Search name, SKU or barcode"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="toolbar-control inventory-filter">
          <span>Movement product</span>
          <SearchableFilter
            value={productId}
            ariaLabel="Filter inventory by movement product"
            placeholder="All products"
            options={[
              { value: "", label: "All products" },
              ...movementProductOptions.map((product) => ({ value: product.id, label: product.name })),
            ]}
            onChange={setProductId}
          />
        </label>
        <button className="button secondary inventory-refresh" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
          {loading ? <><LoaderCircle className="spin" size={14} /> Loading…</> : <><RefreshCw size={14} /> Refresh</>}
        </button>
      </HorizontalFilterScroller>

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

          {payload.products.length > 0 && (
            <TableControls
              tableId="inventory-products"
              ariaLabel="Branch inventory"
              includeSearch={false}
              filterColumns={[{ column: "Status" }]}
            />
          )}
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

          {payload.movements.length > 0 && (
            <TableControls
              tableId="inventory-movements"
              ariaLabel="Stock movement history"
              includeSearch={false}
              filterColumns={[{ column: "Movement" }]}
            />
          )}
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

              {payload.stocktakes.length > 0 && (
                <TableControls
                  tableId="inventory-stocktakes"
                  ariaLabel="Stocktake history"
                  filterColumns={isAdmin ? [{ column: "Branch" }] : []}
                />
              )}
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
            {" "}Stock changes are recorded in the append-only ledger.
          </p>
        </>
      )}

      {movementOpen && (
        <WorkspaceDialog eyebrow="Inventory" onClose={() => setMovementOpen(false)} title="Record stock movement">
          <form className="workspace-form" onSubmit={submitMovement}>
            <WorkspaceError message={actionError} />
            {isAdmin && branchId === "all" && (
              <WorkspaceField label="Target branch">
                <select required value={targetBranchId} onChange={(event) => handleTargetBranchChange(event.target.value)}>
                  <option value="">Choose branch</option>
                  {(payload?.branches || branches).map((branch) => (
                    <option key={branch.id} value={branch.id}>{branch.name}</option>
                  ))}
                </select>
              </WorkspaceField>
            )}
            <WorkspaceField label="Product">
              <select
                required
                value={movementForm.productId}
                onChange={(event) => setMovementForm((form) => ({ ...form, productId: event.target.value }))}
                disabled={targetProductsLoading || !actionProducts.length}
              >
                <option value="">{targetProductsLoading ? "Loading products…" : "Choose product"}</option>
                {actionProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name} · {formatQuantity(product.stock_milli)} {product.unit_code}
                  </option>
                ))}
              </select>
            </WorkspaceField>
            <div className="workspace-form-grid">
              <WorkspaceField label="Movement reason">
                <select
                  value={movementForm.movementType}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "adjustment" || value === "damage" || value === "loss" || value === "expiry") {
                      setMovementForm((form) => ({ ...form, movementType: value }));
                    }
                  }}
                >
                  <option value="adjustment">General adjustment</option>
                  <option value="damage">Damage</option>
                  <option value="loss">Loss</option>
                  <option value="expiry">Expired stock</option>
                </select>
              </WorkspaceField>
              {movementForm.movementType === "adjustment" && (
                <WorkspaceField label="Direction">
                  <select
                    value={movementForm.direction}
                    onChange={(event) => setMovementForm((form) => ({
                      ...form,
                      direction: event.target.value === "remove" ? "remove" : "add",
                    }))}
                  >
                    <option value="add">Add stock</option>
                    <option value="remove">Remove stock</option>
                  </select>
                </WorkspaceField>
              )}
              <WorkspaceField label="Quantity" hint="Use up to three decimal places.">
                <input inputMode="decimal" placeholder="0.000" required value={movementForm.quantity} onChange={(event) => setMovementForm((form) => ({ ...form, quantity: event.target.value }))} />
              </WorkspaceField>
              {movementForm.movementType !== "adjustment" && (
                <p className="list-limit-note">Damage, loss and expiry always remove stock and are recorded as audited inventory losses.</p>
              )}
            </div>
            <WorkspaceField label="Reason">
              <input maxLength={200} placeholder="Opening count, damage, correction…" required value={movementForm.reason} onChange={(event) => setMovementForm((form) => ({ ...form, reason: event.target.value }))} />
            </WorkspaceField>
            <div className="workspace-form-actions">
              <button className="button secondary" type="button" onClick={() => setMovementOpen(false)}>Cancel</button>
              <button className="button primary" disabled={actionBusy || targetProductsLoading || !actionBranchId || !actionProducts.length} type="submit">
                {actionBusy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                {actionBusy ? "Saving…" : "Record movement"}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}

      {stocktakeOpen && (
        <WorkspaceDialog eyebrow="Inventory" onClose={() => setStocktakeOpen(false)} title="Physical stocktake">
          <form className="workspace-form" onSubmit={submitStocktake}>
            <WorkspaceError message={actionError} />
            {isAdmin && branchId === "all" && (
              <WorkspaceField label="Target branch">
                <select required value={targetBranchId} onChange={(event) => handleTargetBranchChange(event.target.value)}>
                  <option value="">Choose branch</option>
                  {(payload?.branches || branches).map((branch) => (
                    <option key={branch.id} value={branch.id}>{branch.name}</option>
                  ))}
                </select>
              </WorkspaceField>
            )}
            <p className="list-limit-note">Enter actual counts for products you counted. Leave uncounted products blank; only entered counts are reconciled against the selected branch’s current ledger balance.</p>
            {targetProductsLoading ? (
              <div className="loading"><LoaderCircle size={16} className="spin" /> Loading branch balances…</div>
            ) : (
              <div className="inventory-stocktake-counts">
                {actionProducts.map((product) => (
                  <label className="inventory-stocktake-count" key={product.id}>
                    <span>
                      <strong>{product.name}</strong>
                      <small>System: {formatQuantity(product.stock_milli)} {product.unit_code}</small>
                    </span>
                    <input
                      aria-label={`Physical count for ${product.name}`}
                      inputMode="decimal"
                      placeholder="Skip"
                      value={stocktakeCounts[product.id] || ""}
                      onChange={(event) => setStocktakeCounts((counts) => ({ ...counts, [product.id]: event.target.value }))}
                    />
                  </label>
                ))}
                {!actionProducts.length && <p className="empty">Choose a branch or search for products to count.</p>}
              </div>
            )}
            <WorkspaceField label="Stocktake notes (optional)">
              <input maxLength={500} placeholder="Count reference or location" value={stocktakeNotes} onChange={(event) => setStocktakeNotes(event.target.value)} />
            </WorkspaceField>
            <div className="workspace-form-actions">
              <button className="button secondary" type="button" onClick={() => setStocktakeOpen(false)}>Cancel</button>
              <button className="button primary" disabled={actionBusy || targetProductsLoading || !actionBranchId || !actionProducts.length || !Object.values(stocktakeCounts).some((count) => count.trim())} type="submit">
                {actionBusy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                {actionBusy ? "Reconciling…" : "Record counts"}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}

export default InventoryWorkspace;
