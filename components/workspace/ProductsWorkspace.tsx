"use client";

import { AlertCircle, LoaderCircle, Pencil, Plus, RefreshCw, Save, Search, Tags } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
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
  stock_milli: number;
  is_active: boolean;
}

interface CategoryOption { id: string; name: string; }

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
}

interface CategoryForm {
  id: string;
  name: string;
  description: string;
  sortOrder: string;
  isActive: boolean;
}

const EMPTY_CATEGORY_FORM: CategoryForm = {
  id: "",
  name: "",
  description: "",
  sortOrder: "0",
  isActive: true,
};

interface ProductsResponse {
  products?: ProductRow[];
  categories?: CategoryOption[];
  branchName?: string;
  error?: string;
}

const AVAILABILITY_OPTIONS = [
  { value: "all", label: "All availability" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "on_sale", label: "On sale" },
];

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
  const [reloadKey, setReloadKey] = useState(0);
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
      sortOrder: String(category.sort_order ?? 0),
      isActive: category.is_active ?? true,
    });
  };

  const saveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await categoryAction.run(() => postWorkspaceAction<{ category: CategoryRow }>(
      "/api/workspace/categories",
      {
        id: categoryForm.id || undefined,
        name: categoryForm.name,
        description: categoryForm.description,
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

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>Product catalog</h1>
          <p>Manage the internal POS catalog. Prices are entered in PKR; the database stores paisa. Product rows are read-only for now and show stock for {branchName}.</p>
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
          <button className="primary-button" type="button" disabled title="Adding products is a Windows desktop workflow.">
            <Plus size={15} /> Add product
          </button>
          <button className="secondary-button" type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
            {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </div>

      <div className="live-readonly-note">
        <AlertCircle size={16} />
        <span>Live cloud catalog. Category changes save to the cloud; product images, prices, and barcodes remain in the Windows desktop app.</span>
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
                        <img className="product-thumbnail" src={product.image_path} alt="" />
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
                    <button className="secondary-button" type="button" disabled title={`Editing ${product.name} is a Windows desktop workflow.`}>
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
                  <div>
                    <strong>{category.name}</strong>
                    {category.description && <small>{category.description}</small>}
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
              <div className="workspace-field">
                <span>Status</span>
                <WorkspaceCheckbox
                  checked={categoryForm.isActive}
                  label="Active in the catalog"
                  onChange={(checked) => setCategoryForm((form) => ({ ...form, isActive: checked }))}
                />
              </div>
            </div>
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
