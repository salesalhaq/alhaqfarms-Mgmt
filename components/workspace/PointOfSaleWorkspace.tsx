"use client";

import {
  AlertCircle, ArrowRight, Camera, LoaderCircle, Minus, Package, Plus,
  Search, ShoppingCart, Trash2, Warehouse,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatMoney, formatQuantity } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface PosProduct {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category_id: string | null;
  category_name: string | null;
  image_path: string | null;
  unit_code: string;
  price_paisa: number;
  on_sale: boolean;
  discounted_price_paisa: number | null;
  is_active: boolean;
  stock_milli: number;
}

interface PosCategory { id: string; name: string; }
interface CartLine { product: PosProduct; quantityMilli: number; }
interface PosResponse {
  products?: PosProduct[];
  categories?: PosCategory[];
  hasMore?: boolean;
  shift?: { openedAt: string } | null;
  error?: string;
}

function safeProductImage(value: string | null): string | null {
  if (!value || value.length > 1_500_000) return null;
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function productPrice(product: PosProduct): number {
  return product.on_sale && product.discounted_price_paisa != null
    ? product.discounted_price_paisa
    : product.price_paisa;
}

function quantityStep(product: PosProduct): number {
  return ["kg", "ltr"].includes(product.unit_code.toLowerCase()) ? 250 : 1000;
}

export function PointOfSaleWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [branchId, setBranchId] = useState(staff?.branch_id || "");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [offset, setOffset] = useState(0);
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [categories, setCategories] = useState<PosCategory[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const totalPaisa = useMemo(() => cart.reduce(
    (total, line) => total + Math.round(productPrice(line.product) * line.quantityMilli / 1000),
    0,
  ), [cart]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === "F2") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    let active = true;
    if (!branchId) {
      setProducts([]);
      setCategories([]);
      setHasMore(false);
      setShiftOpen(false);
      setLoading(false);
      return () => { active = false; };
    }

    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams({ branchId, offset: String(offset) });
    if (debouncedSearch) parameters.set("search", debouncedSearch);
    if (categoryId) parameters.set("categoryId", categoryId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/point-of-sale?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as PosResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load the point-of-sale catalog.");
        const page = result.products || [];
        setProducts((current) => offset ? [...current, ...page] : page);
        setCategories(result.categories || []);
        setHasMore(Boolean(result.hasMore));
        setShiftOpen(Boolean(result.shift));
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the point-of-sale catalog.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, categoryId, debouncedSearch, offset, reloadKey]);

  const addProduct = (product: PosProduct) => {
    const increment = Math.min(quantityStep(product), product.stock_milli);
    const existing = cart.find((line) => line.product.id === product.id);
    if (increment <= 0 || (existing?.quantityMilli || 0) + increment > product.stock_milli) {
      setError(`Only ${formatQuantity(product.stock_milli - (existing?.quantityMilli || 0))} ${product.unit_code} remains available.`);
      return;
    }
    setError(null);
    setCart((current) => {
      const line = current.find((entry) => entry.product.id === product.id);
      return line
        ? current.map((entry) => entry.product.id === product.id
          ? { ...entry, quantityMilli: entry.quantityMilli + increment }
          : entry)
        : [...current, { product, quantityMilli: increment }];
    });
  };

  const changeQuantity = (line: CartLine, change: number) => {
    const nextQuantity = line.quantityMilli + change;
    if (nextQuantity > line.product.stock_milli) {
      setError(`Only ${formatQuantity(line.product.stock_milli)} ${line.product.unit_code} is in branch stock.`);
      return;
    }
    setError(null);
    setCart((current) => nextQuantity <= 0
      ? current.filter((entry) => entry.product.id !== line.product.id)
      : current.map((entry) => entry.product.id === line.product.id
        ? { ...entry, quantityMilli: nextQuantity }
        : entry));
  };

  return (
    <div className="pos-workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>Browse live branch stock and build a local basket. Register, hold, and payment writes are not enabled in the web client.</p>
        </div>
        {!staff?.branch_id && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select className="toolbar-select" value={branchId} onChange={(event) => {
              setBranchId(event.target.value);
              setOffset(0);
              setCart([]);
            }}>
              <option value="">Choose a branch</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className={`pos-register-card card ${shiftOpen ? "is-open" : ""}`}>
        <span className="pos-register-icon"><Warehouse size={18} /></span>
        <div className="pos-register-copy">
          <strong>{!branchId ? "Choose a branch to view the register" : shiftOpen ? "Register shift open" : "Register shift is closed"}</strong>
          <small>{!branchId ? "Select an accessible branch to check register status." : shiftOpen ? "An open shift is linked to your staff account." : "Open a shift before recording sales. Shift management is not connected on the web yet."}</small>
        </div>
        <span className={`pos-shift-status ${shiftOpen ? "open" : ""}`}>{!branchId ? "Not selected" : shiftOpen ? "Active" : "Closed"}</span>
        <div className="pos-register-actions">
          <button className="button secondary" disabled title="Camera scanning is not connected in the web client." type="button"><Camera size={14} /> Camera scan</button>
          <button className="button secondary" disabled title="Cash movements require the transactional register workflow." type="button">Cash in</button>
          <button className="button secondary" disabled title="Cash movements require the transactional register workflow." type="button">Cash out</button>
          <button className="button secondary" disabled title="Held-sale storage is not connected in the web client." type="button">Held bills <span>0</span></button>
          <button className="button secondary" disabled title="Recording a cash movement requires the transactional register workflow." type="button">Record movement</button>
          <button className="button" disabled title="Shift changes require the transactional register workflow." type="button">{shiftOpen ? "Close shift" : "Open shift"}</button>
        </div>
      </div>

      <div className="live-readonly-note pos-readonly-note">
        <AlertCircle size={16} />
        <span>Live catalog · read-only. Adding items only changes this page&apos;s temporary basket; no sale, stock, or payment record is written.</span>
      </div>

      <div className="pos-workspace-grid">
        <section className="pos-catalog card" aria-label="Branch product catalog">
          <div className="pos-catalog-toolbar">
            <label className="search-field">
              <Search size={16} />
              <input
                ref={searchRef}
                aria-label="Search products or scan a SKU/barcode"
                placeholder="Search products or enter SKU/barcode"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <label className="visually-hidden-label">
              Category
              <select className="toolbar-select" value={categoryId} onChange={(event) => {
                setCategoryId(event.target.value);
                setOffset(0);
              }}>
                <option value="">All categories</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
            <button className="button secondary" disabled={loading} onClick={() => setReloadKey((value) => value + 1)} type="button">
              {loading ? <LoaderCircle size={15} className="spin" /> : "Refresh"}
            </button>
          </div>

          {error && <div className="notice" role="alert">{error}</div>}
          {loading && products.length === 0 && <div className="loading"><LoaderCircle size={18} className="spin" /> Loading branch products…</div>}
          {!branchId && <div className="empty"><Warehouse size={23} /><h2>Select a branch</h2><p>Choose an accessible branch to load products and stock.</p></div>}
          {!loading && branchId && !error && products.length === 0 && (
            <div className="empty"><Package size={23} /><h2>{debouncedSearch ? "No matching products" : "No active products found"}</h2><p>Try a different search or category.</p></div>
          )}

          <div className="pos-product-grid">
            {products.map((product) => {
              const image = safeProductImage(product.image_path);
              return (
                <button
                  type="button"
                  key={product.id}
                  className="pos-product-card card"
                  disabled={!product.is_active || product.stock_milli <= 0}
                  onClick={() => addProduct(product)}
                >
                  {image ? <img src={image} alt="" loading="lazy" /> : <span className="pos-product-placeholder"><Package size={22} /></span>}
                  <strong>{product.name}</strong>
                  <small>{product.sku || product.barcode || product.unit_code}</small>
                  <span className="pos-product-price">{formatMoney(productPrice(product))}</span>
                  <span className={`pos-product-stock ${product.stock_milli <= 0 ? "out" : ""}`}>
                    {formatQuantity(product.stock_milli)} {product.unit_code} in stock
                  </span>
                </button>
              );
            })}
          </div>
          {hasMore && (
            <div className="pos-load-more">
              <button className="button secondary" disabled={loading} onClick={() => setOffset((current) => current + 60)} type="button">
                {loading ? <LoaderCircle size={15} className="spin" /> : "Load more products"}
              </button>
            </div>
          )}
        </section>

        <aside className="pos-basket card" aria-label="Temporary sale basket">
          <div className="pos-basket-header">
            <div><h2>Current sale <span>{cart.length}</span></h2><small>Temporary basket · not saved</small></div>
            <button className="button secondary" disabled={!cart.length} onClick={() => { setCart([]); setError(null); }} type="button">
              <Trash2 size={14} /> Clear
            </button>
          </div>

          <button className="pos-customer-button" disabled title="Customer and loyalty workflows are not connected in the web client." type="button">
            <span><strong>Walk-in customer</strong><small>Customer and loyalty selection unavailable</small></span>
            <ArrowRight size={15} />
          </button>
          <div className="pos-basket-actions">
            <button className="button secondary" disabled title="Creating customer accounts requires the transactional register workflow." type="button">New customer account</button>
          </div>

          <div className="pos-basket-lines">
            {cart.map((line) => (
              <div className="pos-basket-line" key={line.product.id}>
                <div className="pos-basket-line-title">
                  <strong>{line.product.name}</strong>
                  <span>{formatMoney(Math.round(productPrice(line.product) * line.quantityMilli / 1000))}</span>
                </div>
                <small>{formatMoney(productPrice(line.product))} / {line.product.unit_code}</small>
                <div className="pos-quantity-controls">
                  <button aria-label={`Decrease ${line.product.name}`} onClick={() => changeQuantity(line, -quantityStep(line.product))} type="button"><Minus size={13} /></button>
                  <span>{formatQuantity(line.quantityMilli)}</span>
                  <button aria-label={`Increase ${line.product.name}`} onClick={() => changeQuantity(line, quantityStep(line.product))} type="button"><Plus size={13} /></button>
                  <button className="pos-remove-line" aria-label={`Remove ${line.product.name}`} onClick={() => setCart((current) => current.filter((entry) => entry.product.id !== line.product.id))} type="button">Remove</button>
                </div>
              </div>
            ))}
            {!cart.length && <div className="pos-basket-empty"><ShoppingCart size={23} /><p>Add products to preview a basket.</p></div>}
          </div>

          <div className="pos-basket-total">
            <div><span>Estimated subtotal</span><strong>{formatMoney(totalPaisa)}</strong></div>
            <small>Tax and discounts are calculated only in the secure checkout workflow.</small>
          </div>
          <div className="pos-basket-actions">
            <button className="button secondary" disabled={!cart.length} title="Bill discounts are applied only in the secure checkout workflow." type="button">Bill discount</button>
            <button className="button secondary" disabled={!cart.length} title="Held-sale storage is not connected in the web client." type="button">Hold sale</button>
            <button className="button" disabled={!shiftOpen || !cart.length} title="Checkout is disabled until a server-side transaction workflow is implemented." type="button">Take payment</button>
          </div>
          <div className="pos-basket-actions">
            <button className="button secondary" disabled title="Manager discount approval requires the transactional register workflow." type="button">Request on manager screen</button>
            <button className="button secondary" disabled title="Discount approval requires the transactional register workflow." type="button">Approve discount</button>
            <button className="button secondary" disabled title="Receipt printing follows a recorded sale." type="button">Print receipt</button>
            <button className="button secondary" disabled title="Starting a new sale requires the transactional register workflow." type="button">New sale</button>
          </div>
          <p className="pos-shortcut-note"><kbd>F2</kbd> Focus product search</p>
        </aside>
      </div>
    </div>
  );
}
