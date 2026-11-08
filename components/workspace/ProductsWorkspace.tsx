"use client";

import { AlertCircle, LoaderCircle, Pencil, Plus, RefreshCw, Save, Search, Tags, X } from "lucide-react";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import {
  WorkspaceCheckbox,
  WorkspaceDialog,
  WorkspaceError,
  WorkspaceField,
  WorkspaceSuccess,
} from "@/components/workspace/WorkspaceDialog";
import { formatMoney, formatQuantity } from "@/lib/format";
import { DEFAULT_BRAND_NAME } from "@/lib/branding";
import { generateProductCatalogDocument } from "@/lib/print/reports";
import { postWorkspaceAction } from "@/lib/workspace/write-client";
import { useWorkspaceAction } from "@/lib/workspace/use-workspace-action";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface ProductRow {
  id: string;
  category_id: string | null;
  name: string;
  image_path: string | null;
  cost_price_paisa: number;
  category_name: string;
  fbr_pct_code: string;
  fbr_pct_category_name: string;
  sku: string | null;
  barcode: string | null;
  unit_code: string;
  price_paisa: number;
  on_sale: boolean;
  discounted_price_paisa: number | null;
  tax_rate_bps: number;
  min_stock_milli: number;
  reorder_point_milli: number;
  max_stock_milli: number;
  stock_milli: number;
  is_active: boolean;
}

interface CategoryOption { id: string; name: string; }

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  image_path: string | null;
  sort_order: number;
  is_active: boolean;
}

interface CategoryForm {
  id: string;
  name: string;
  description: string;
  imagePath: string;
  sortOrder: string;
  isActive: boolean;
}

const EMPTY_CATEGORY_FORM: CategoryForm = {
  id: "",
  name: "",
  description: "",
  imagePath: "",
  sortOrder: "0",
  isActive: true,
};

interface ProductsResponse {
  products?: ProductRow[];
  categories?: CategoryOption[];
  branchName?: string;
  error?: string;
}

interface ProductForm {
  id: string;
  name: string;
  categoryId: string;
  sku: string;
  barcode: string;
  unitCode: string;
  price: string;
  cost: string;
  taxRate: string;
  onSale: boolean;
  discountedPrice: string;
  minStock: string;
  reorderPoint: string;
  maxStock: string;
  isActive: boolean;
  imagePath: string;
}

const EMPTY_PRODUCT_FORM: ProductForm = {
  id: "",
  name: "",
  categoryId: "",
  sku: "",
  barcode: "",
  unitCode: "kg",
  price: "",
  cost: "0",
  taxRate: "0",
  onSale: false,
  discountedPrice: "",
  minStock: "0",
  reorderPoint: "10",
  maxStock: "1000",
  isActive: true,
  imagePath: "",
};

const PRODUCT_UNITS = [
  ["kg", "Kilogram (kg)"],
  ["g", "Gram (g)"],
  ["lb", "Pound (lb)"],
  ["each", "Each (Piece)"],
  ["piece", "Piece"],
  ["pack", "Pack"],
  ["box", "Box/Carton"],
  ["bag", "Bag"],
  ["ltr", "Liter (ltr)"],
  ["ml", "Milliliter (ml)"],
  ["dozen", "Dozen (12 pcs)"],
  ["head", "Head (cattle)"],
  ["bird", "Bird (chicken)"],
  ["tray", "Eggs Tray"],
  ["batch", "Batch/Lot"],
] as const;

function moneyInput(paisa: number | null | undefined): string {
  return paisa == null ? "" : (paisa / 100).toFixed(2);
}

function parsePaisa(value: string, label: string): number {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label} must be a non-negative amount with up to 2 decimal places.`);
  const paisa = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(paisa)) throw new Error(`${label} is too large.`);
  return paisa;
}

function parseMilli(value: string, label: string): number {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) throw new Error(`${label} must be a non-negative quantity with up to 3 decimal places.`);
  const milli = Math.round(Number(text) * 1000);
  if (!Number.isSafeInteger(milli)) throw new Error(`${label} is too large.`);
  return milli;
}

const AVAILABILITY_OPTIONS = [
  { value: "all", label: "All availability" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "on_sale", label: "On sale" },
];

const MAX_SOURCE_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_OPTIMIZED_IMAGE_BYTES = 300 * 1024;
const MAX_IMAGE_DIMENSION = 640;

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The selected image could not be optimized."));
    }, type, quality);
  });
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("The selected image could not be prepared."));
    reader.onerror = () => reject(new Error("The selected image could not be read."));
    reader.readAsDataURL(blob);
  });
}

async function optimizeCatalogImage(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("Choose an image smaller than 15 MB.");
  }

  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The selected image could not be optimized.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    let optimized: Blob | null = null;
    for (const quality of [0.82, 0.72, 0.62, 0.52]) {
      optimized = await canvasBlob(canvas, "image/webp", quality);
      if (optimized.size <= MAX_OPTIMIZED_IMAGE_BYTES) break;
    }
    if (!optimized || optimized.size > MAX_OPTIMIZED_IMAGE_BYTES) {
      throw new Error("This image could not be reduced enough. Choose a simpler image.");
    }
    return await blobDataUrl(optimized);
  } finally {
    bitmap.close();
  }
}

export function ProductsWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const isAdmin = staff?.role === "admin";
  const isHqAdmin = staff?.role === "admin" && !staff.branch_id;
  const [branchId, setBranchId] = useState(staff?.role === "admin" && !staff.branch_id ? "all" : staff?.branch_id || "");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [availability, setAvailability] = useState("all");
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [branchName, setBranchName] = useState("Your branch");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [productForm, setProductForm] = useState<ProductForm>(EMPTY_PRODUCT_FORM);
  const [productSaving, setProductSaving] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [categoryList, setCategoryList] = useState<CategoryRow[]>([]);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryForm, setCategoryForm] = useState<CategoryForm>(EMPTY_CATEGORY_FORM);
  const categoryAction = useWorkspaceAction();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (staff?.role === "admin" && !staff.branch_id && !branchId) setBranchId("all");
    else if (staff?.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff?.branch_id, staff?.role]);

  useEffect(() => {
    if (!staff) return undefined;
    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams();
    if (debouncedSearch) parameters.set("search", debouncedSearch);
    if (categoryId) parameters.set("categoryId", categoryId);
    if (availability !== "all") parameters.set("availability", availability);
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/products?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as ProductsResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load the product catalog.");
        setProducts(result.products || []);
        setCategories(result.categories || []);
        setBranchName(result.branchName || "Your branch");
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the product catalog.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [availability, branchId, categoryId, debouncedSearch, reloadKey, staff]);

  const clearFilters = () => {
    setSearch("");
    setCategoryId("");
    setAvailability("all");
  };

  const loadCategories = async () => {
    setCategoryLoading(true);
    try {
      const response = await fetch("/api/workspace/categories", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as { categories?: CategoryRow[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not load product categories.");
      setCategoryList(result.categories || []);
    } catch (loadError) {
      categoryAction.setError(loadError instanceof Error
        ? loadError.message
        : "Could not load product categories.");
    } finally {
      setCategoryLoading(false);
    }
  };

  const openCategories = async () => {
    setCategoryDialogOpen(true);
    setCategoryForm(EMPTY_CATEGORY_FORM);
    categoryAction.clearFeedback();
    await loadCategories();
  };

  const editCategory = (category: CategoryRow) => {
    categoryAction.clearFeedback();
    setCategoryForm({
      id: category.id,
      name: category.name,
      description: category.description || "",
      imagePath: category.image_path || "",
      sortOrder: String(category.sort_order ?? 0),
      isActive: category.is_active ?? true,
    });
  };

  const importProductImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setProductError(null);
    try {
      const imagePath = await optimizeCatalogImage(file);
      setProductForm((form) => ({ ...form, imagePath }));
    } catch (imageError) {
      setProductError(imageError instanceof Error ? imageError.message : "The product image could not be prepared.");
    }
  };

  const importCategoryImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    categoryAction.clearFeedback();
    try {
      const imagePath = await optimizeCatalogImage(file);
      setCategoryForm((form) => ({ ...form, imagePath }));
    } catch (imageError) {
      categoryAction.setError(imageError instanceof Error ? imageError.message : "The category image could not be prepared.");
    }
  };

  const saveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await categoryAction.run(() => postWorkspaceAction<{ category: CategoryRow }>(
      "/api/workspace/categories",
      {
        id: categoryForm.id || undefined,
        name: categoryForm.name,
        description: categoryForm.description,
        imagePath: categoryForm.imagePath || null,
        sortOrder: Number(categoryForm.sortOrder || "0"),
        isActive: categoryForm.isActive,
      },
    ));
    if (!result) return;
    categoryAction.setMessage(categoryForm.id ? "Category updated." : "Category added.");
    setCategoryForm(EMPTY_CATEGORY_FORM);
    await loadCategories();
    setReloadKey((key) => key + 1);
  };

  const openProductEditor = (product?: ProductRow) => {
    setProductError(null);
    setSaveMessage("");
    setProductForm(product ? {
      id: product.id,
      name: product.name,
      categoryId: product.category_id || "",
      sku: product.sku || "",
      barcode: product.barcode || "",
      unitCode: product.unit_code,
      price: moneyInput(product.price_paisa),
      cost: moneyInput(product.cost_price_paisa),
      taxRate: (product.tax_rate_bps / 100).toFixed(2).replace(/\.?0+$/, ""),
      onSale: product.on_sale,
      discountedPrice: moneyInput(product.discounted_price_paisa),
      minStock: formatQuantity(product.min_stock_milli),
      reorderPoint: formatQuantity(product.reorder_point_milli),
      maxStock: formatQuantity(product.max_stock_milli),
      isActive: product.is_active,
      imagePath: product.image_path || "",
    } : EMPTY_PRODUCT_FORM);
    setProductDialogOpen(true);
  };

  const saveProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProductSaving(true);
    setProductError(null);
    try {
      await postWorkspaceAction("/api/workspace/product", {
        id: productForm.id || undefined,
        name: productForm.name,
        categoryId: productForm.categoryId || null,
        sku: productForm.sku,
        barcode: productForm.barcode,
        unitCode: productForm.unitCode,
        pricePaisa: parsePaisa(productForm.price, "Price"),
        costPricePaisa: parsePaisa(productForm.cost || "0", "Cost price"),
        taxRateBps: Math.round(Number(productForm.taxRate || 0) * 100),
        onSale: productForm.onSale,
        discountedPricePaisa: productForm.discountedPrice
          ? parsePaisa(productForm.discountedPrice, "Sale price")
          : null,
        minStockMilli: parseMilli(productForm.minStock || "0", "Minimum stock"),
        reorderPointMilli: parseMilli(productForm.reorderPoint || "0", "Reorder point"),
        maxStockMilli: parseMilli(productForm.maxStock || "0", "Maximum stock"),
        isActive: productForm.isActive,
        imagePath: productForm.imagePath || null,
      });
      setProductDialogOpen(false);
      setSaveMessage(productForm.id ? "Product updated." : "Product added.");
      setReloadKey((key) => key + 1);
    } catch (saveError) {
      setProductError(saveError instanceof Error ? saveError.message : "The product could not be saved.");
    } finally {
      setProductSaving(false);
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>Product catalog</h1>
          <p>Manage products, categories, units, prices and barcodes. Prices are entered in PKR; the database stores paisa. Stock shown is for {branchName}.</p>
        </div>
        <div className="heading-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={isHqAdmin ? () => void openCategories() : undefined}
            disabled={!isHqAdmin}
            title={isHqAdmin
              ? "Add or edit product categories."
              : "Only an HQ administrator can manage product categories."}
          >
            <Tags size={14} /> Categories
          </button>
          <button className="primary-button" type="button" disabled={!isHqAdmin} onClick={() => openProductEditor()} title={isHqAdmin ? "Add a product to the cloud catalog." : "Only an HQ administrator can manage products."}>
            <Plus size={15} /> Add product
          </button>
          <button className="secondary-button" type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
            {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </div>

      <div className="live-readonly-note">
        <AlertCircle size={16} />
        <span>Product changes are saved to the shared cloud catalog. Assign weight-barcode product codes from Barcode Labels.</span>
      </div>

      <div className="workspace-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="Search name, SKU or barcode"
            placeholder="Search name, SKU or barcode"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
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
          <span>Category</span>
          <select className="toolbar-select" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">All categories</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
        <label className="toolbar-control">
          <span>Availability</span>
          <select className="toolbar-select" value={availability} onChange={(event) => setAvailability(event.target.value)}>
            {AVAILABILITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <span className="result-count">{products.length} products</span>
        <button className="secondary-button" type="button" onClick={clearFilters}>Clear</button>
      </div>

      {error && <div className="notice" role="alert">{error}</div>}
      <WorkspaceSuccess message={saveMessage} />

      <section className="card table-wrap workspace-table" aria-label="Product catalog">
        <div className="table-document-heading">
          <strong>Product catalog</strong>
          <TableDocumentTools
            tableId="products-table"
            title="Product catalog"
            orientationKey="product-catalog"
            disabled={loading || Boolean(error) || !products.length}
            buildDocument={(orientation) => products.length
              ? generateProductCatalogDocument({ products, branchName }, {
                  branding: { businessName: DEFAULT_BRAND_NAME },
                  orientationPreference: orientation,
                  branch: branchName,
                  printedBy: staff?.full_name || "Staff",
                })
              : null}
          />
        </div>
        {loading ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading products…</div>
        ) : !error && !products.length ? (
          <div className="empty">
            <Search size={23} />
            <h2>{search ? "No matching products" : "No products found"}</h2>
            <p>{search ? "Try a different search or clear the filters." : "Products will appear here once the catalog syncs to the cloud."}</p>
          </div>
        ) : !error ? (
          <table id="products-table">
            <thead>
              <tr>
                <th>Product</th><th>Category</th><th>FBR PCT</th><th>SKU / barcode</th>
                <th>Unit</th><th>Price</th><th>Branch stock</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>
                    <div className="product-catalog-cell">
                      {product.image_path?.startsWith("data:image/") && (
                        <img className="product-thumbnail" src={product.image_path} alt="" loading="lazy" />
                      )}
                      <div>
                        <strong>{product.name}</strong>
                        <small>Cost {formatMoney(product.cost_price_paisa)}</small>
                      </div>
                    </div>
                  </td>
                  <td>{product.category_name || "—"}</td>
                  <td>
                    <span className="mono">{product.fbr_pct_code || "—"}</span>
                    {product.fbr_pct_category_name && <small className="sales-cell-subtext">{product.fbr_pct_category_name}</small>}
                  </td>
                  <td>
                    <span className="mono">{product.sku || "—"}</span>
                    {product.barcode && <small className="sales-cell-subtext mono">{product.barcode}</small>}
                  </td>
                  <td>{product.unit_code}</td>
                  <td>
                    {product.on_sale && product.discounted_price_paisa != null ? (
                      <>
                        <del>{formatMoney(product.price_paisa)}</del>
                        <small className="sales-cell-subtext">{formatMoney(product.discounted_price_paisa)}</small>
                      </>
                    ) : formatMoney(product.price_paisa)}
                  </td>
                  <td className="numeric-cell">{formatQuantity(product.stock_milli)}</td>
                  <td>
                    <span className={`status ${product.is_active ? "green" : "grey"}`}>
                      {product.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="row-actions">
                    <button className="secondary-button" type="button" disabled={!isHqAdmin} onClick={() => openProductEditor(product)} title={isHqAdmin ? `Edit ${product.name}.` : "Only an HQ administrator can manage products."}>
                      <Pencil size={13} /> Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {!loading && !error && (
        <p className="list-limit-note">Showing {products.length} products, limited to 500 per request. Branch stock is calculated from the synchronized movement ledger.</p>
      )}

      {productDialogOpen && (
        <WorkspaceDialog
          eyebrow="Catalog"
          onClose={() => setProductDialogOpen(false)}
          title={productForm.id ? "Edit product" : "Add product"}
        >
          <form className="workspace-form" onSubmit={saveProduct}>
            <WorkspaceError message={productError} />
            <div className="workspace-form-grid">
              <WorkspaceField label="Product name">
                <input
                  maxLength={200}
                  onChange={(event) => setProductForm((form) => ({ ...form, name: event.target.value }))}
                  required
                  value={productForm.name}
                />
              </WorkspaceField>
              <WorkspaceField label="Category">
                <select
                  onChange={(event) => setProductForm((form) => ({ ...form, categoryId: event.target.value }))}
                  value={productForm.categoryId}
                >
                  <option value="">Uncategorized</option>
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </WorkspaceField>
              <WorkspaceField label="Unit">
                <select
                  onChange={(event) => setProductForm((form) => ({ ...form, unitCode: event.target.value }))}
                  value={productForm.unitCode}
                >
                  {PRODUCT_UNITS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
              </WorkspaceField>
              <WorkspaceField label="SKU" hint="Leave blank to generate one automatically.">
                <input
                  maxLength={100}
                  onChange={(event) => setProductForm((form) => ({ ...form, sku: event.target.value }))}
                  value={productForm.sku}
                />
              </WorkspaceField>
              <WorkspaceField label="Barcode">
                <input
                  maxLength={100}
                  onChange={(event) => setProductForm((form) => ({ ...form, barcode: event.target.value }))}
                  value={productForm.barcode}
                />
              </WorkspaceField>
              <WorkspaceField label="Price (PKR)">
                <input
                  inputMode="decimal"
                  onChange={(event) => setProductForm((form) => ({ ...form, price: event.target.value }))}
                  required
                  value={productForm.price}
                />
              </WorkspaceField>
              <WorkspaceField label="Cost (PKR)">
                <input
                  inputMode="decimal"
                  onChange={(event) => setProductForm((form) => ({ ...form, cost: event.target.value }))}
                  value={productForm.cost}
                />
              </WorkspaceField>
              <WorkspaceField label="Tax rate (%)">
                <input
                  max={100}
                  min={0}
                  onChange={(event) => setProductForm((form) => ({ ...form, taxRate: event.target.value }))}
                  step="0.01"
                  type="number"
                  value={productForm.taxRate}
                />
              </WorkspaceField>
              <WorkspaceField label="Sale price (PKR)">
                <input
                  inputMode="decimal"
                  onChange={(event) => setProductForm((form) => ({
                    ...form,
                    discountedPrice: event.target.value,
                    onSale: Boolean(event.target.value),
                  }))}
                  value={productForm.discountedPrice}
                />
              </WorkspaceField>
              <WorkspaceField label="Minimum stock">
                <input
                  inputMode="decimal"
                  onChange={(event) => setProductForm((form) => ({ ...form, minStock: event.target.value }))}
                  value={productForm.minStock}
                />
              </WorkspaceField>
              <WorkspaceField label="Reorder point">
                <input
                  inputMode="decimal"
                  onChange={(event) => setProductForm((form) => ({ ...form, reorderPoint: event.target.value }))}
                  value={productForm.reorderPoint}
                />
              </WorkspaceField>
              <WorkspaceField label="Maximum stock">
                <input
                  inputMode="decimal"
                  onChange={(event) => setProductForm((form) => ({ ...form, maxStock: event.target.value }))}
                  value={productForm.maxStock}
                />
              </WorkspaceField>
              {productForm.id && (
                <WorkspaceField label="Catalog status">
                  <select
                    onChange={(event) => setProductForm((form) => ({ ...form, isActive: event.target.value === "active" }))}
                    value={productForm.isActive ? "active" : "inactive"}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </WorkspaceField>
              )}
              <WorkspaceField label="Product image" hint="PNG, JPEG, WebP or GIF · optimized to 640 px / 300 KB">
                <input accept="image/png,image/jpeg,image/webp,image/gif" onChange={importProductImage} type="file" />
              </WorkspaceField>
            </div>
            {productForm.imagePath.startsWith("data:image/") && (
              <div className="product-image-preview">
                <img src={productForm.imagePath} alt="Product preview" />
                <button
                  className="secondary-button"
                  onClick={() => setProductForm((form) => ({ ...form, imagePath: "" }))}
                  type="button"
                >
                  Remove image
                </button>
              </div>
            )}
            <div className="workspace-form-actions">
              <button className="secondary-button" onClick={() => setProductDialogOpen(false)} type="button">Cancel</button>
              <button className="primary-button" disabled={productSaving} type="submit">
                {productSaving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                {productSaving ? "Saving…" : "Save product"}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}

      {categoryDialogOpen && (
        <WorkspaceDialog
          eyebrow="Catalog"
          onClose={() => setCategoryDialogOpen(false)}
          title="Product categories"
        >
          <WorkspaceError message={categoryAction.error} />
          <WorkspaceSuccess message={categoryAction.message} />
          {categoryLoading ? (
            <div className="loading"><LoaderCircle size={18} className="spin" /> Loading categories…</div>
          ) : (
            <div className="workspace-category-list">
              {categoryList.map((category) => (
                <div className="workspace-category-row" key={category.id}>
                  <div className="workspace-category-copy">
                    {category.image_path?.startsWith("data:image/") && (
                      <img className="category-thumbnail" src={category.image_path} alt="" loading="lazy" />
                    )}
                    <div className="workspace-category-details">
                      <strong>{category.name}</strong>
                      {category.description && <small>{category.description}</small>}
                    </div>
                  </div>
                  <div className="workspace-inline-actions">
                    <span className={`status ${category.is_active ? "green" : "grey"}`}>
                      {category.is_active ? "Active" : "Inactive"}
                    </span>
                    <button className="secondary-button" type="button" onClick={() => editCategory(category)}>
                      <Pencil size={13} /> Edit
                    </button>
                  </div>
                </div>
              ))}
              {!categoryList.length && <p>No categories have been created yet.</p>}
            </div>
          )}

          <form className="workspace-form" onSubmit={saveCategory}>
            <div className="workspace-section-heading">
              <h3>{categoryForm.id ? "Edit category" : "Add category"}</h3>
              {categoryForm.id && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setCategoryForm(EMPTY_CATEGORY_FORM);
                    categoryAction.clearFeedback();
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
            <div className="workspace-form-grid">
              <WorkspaceField label="Name">
                <input
                  maxLength={120}
                  onChange={(event) => setCategoryForm((form) => ({ ...form, name: event.target.value }))}
                  required
                  value={categoryForm.name}
                />
              </WorkspaceField>
              <WorkspaceField label="Sort order">
                <input
                  onChange={(event) => setCategoryForm((form) => ({ ...form, sortOrder: event.target.value }))}
                  step={1}
                  type="number"
                  value={categoryForm.sortOrder}
                />
              </WorkspaceField>
              <WorkspaceField label="Description">
                <input
                  maxLength={1000}
                  onChange={(event) => setCategoryForm((form) => ({ ...form, description: event.target.value }))}
                  value={categoryForm.description}
                />
              </WorkspaceField>
              <WorkspaceField label="Category image" hint="PNG, JPEG, WebP or GIF · optimized to 640 px / 300 KB">
                <input accept="image/png,image/jpeg,image/webp,image/gif" onChange={importCategoryImage} type="file" />
              </WorkspaceField>
              <div className="workspace-field">
                <span>Status</span>
                <WorkspaceCheckbox
                  checked={categoryForm.isActive}
                  label="Active in the catalog"
                  onChange={(checked) => setCategoryForm((form) => ({ ...form, isActive: checked }))}
                />
              </div>
            </div>
            {categoryForm.imagePath.startsWith("data:image/") && (
              <div className="product-image-preview">
                <img src={categoryForm.imagePath} alt="Category preview" />
                <button
                  className="secondary-button"
                  onClick={() => setCategoryForm((form) => ({ ...form, imagePath: "" }))}
                  type="button"
                >
                  <X size={13} /> Remove image
                </button>
              </div>
            )}
            <div className="workspace-form-actions">
              <button className="primary-button" disabled={categoryAction.pending} type="submit">
                {categoryAction.pending ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                {categoryForm.id ? "Save category" : "Add category"}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </>
  );
}

export default ProductsWorkspace;
