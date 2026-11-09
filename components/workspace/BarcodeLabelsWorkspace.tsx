"use client";

import JsBarcode from "jsbarcode";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Printer,
  Search,
  Tags,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_BRAND_NAME } from "@/lib/branding";
import { formatMoney } from "@/lib/format";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { ean13ForWeight } from "@/lib/scale/weight-barcode";
import { printLabelsViaBridge } from "@/lib/print/bridge-print";
import { loadPrinterSettings } from "@/lib/print/printer-settings";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { SerialScale } from "./SerialScale";

interface Product {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category_id: string | null;
  unit_code: string;
  price_paisa: number;
  on_sale: boolean;
  discounted_price_paisa: number | null;
  is_active: boolean;
  metadata_json: unknown;
}

interface Category {
  id: string;
  name: string;
}

interface BarcodeLabelsResponse {
  products?: Product[];
  categories?: Category[];
  total?: number;
  hasMore?: boolean;
  error?: string;
}

interface SelectedProduct {
  product: Product;
  quantity: number;
}

interface WeightedLabel {
  key: string;
  code: string;
  barcodeFormat: "CODE128" | "EAN13";
  product: Product;
  measuredQuantity: number;
  totalPricePaisa: number;
  packedDate: string;
  expiryDate: string;
  companyName: string;
  labelFooter: string;
}

interface LabelSize {
  id: string;
  label: string;
  columns: number;
  widthMm: number;
  heightMm: number;
  barcodeHeight: number;
  font: number;
}

const PAGE_SIZE = 60;
const MAX_LABELS = 240;
const MAX_PER_PRODUCT = 99;

const SIZES: LabelSize[] = [
  { id: "100x50", label: "100 × 50 mm", columns: 2, widthMm: 100, heightMm: 50, barcodeHeight: 42, font: 12 },
  { id: "80x50", label: "80 × 50 mm", columns: 2, widthMm: 80, heightMm: 50, barcodeHeight: 42, font: 11 },
  { id: "75x50", label: "75 × 50 mm", columns: 2, widthMm: 75, heightMm: 50, barcodeHeight: 42, font: 10 },
  { id: "60x40", label: "60 × 40 mm", columns: 3, widthMm: 60, heightMm: 40, barcodeHeight: 32, font: 9 },
  { id: "50x30", label: "50 × 30 mm", columns: 4, widthMm: 50, heightMm: 30, barcodeHeight: 24, font: 8 },
];

function getCode(product: Product): string {
  const candidates = [product.barcode, product.sku, product.id]
    .map((value) => value?.trim() || "")
    .filter(Boolean);
  return candidates.find((candidate) => [...candidate].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code <= 126;
  })) || candidates[0] || product.id;
}

function pakistanDateString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function labelDate(dateString: string): string {
  if (!dateString) return "—";
  const [year, month, day] = dateString.split("-");
  return `${day}.${month}.${year}`;
}

function effectivePrice(product: Product): number {
  return product.on_sale && product.discounted_price_paisa != null
    ? product.discounted_price_paisa
    : product.price_paisa;
}

async function assignWeightBarcodeCode(productId: string): Promise<{ numericCode: number; reassigned: boolean }> {
  const response = await fetch("/api/workspace/weight-barcode-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ productId }),
  });
  const result = await response.json() as { numericCode?: number; reassigned?: boolean; error?: string };
  if (!response.ok || typeof result.numericCode !== "number" || !Number.isInteger(result.numericCode)) {
    throw new Error(result.error || "Could not assign a weight-barcode code.");
  }
  return { numericCode: result.numericCode, reassigned: Boolean(result.reassigned) };
}

function Barcode({
  value,
  height,
  fontSize,
  format = "CODE128",
}: {
  value: string;
  height: number;
  fontSize: number;
  format?: "CODE128" | "EAN13";
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    if (!svgRef.current) return;
    try {
      JsBarcode(svgRef.current, value, {
        format,
        width: 1.4,
        height,
        displayValue: true,
        fontSize,
        margin: 0,
        textMargin: 1,
      });
    } catch {
      /* An empty or invalid code simply renders no barcode. */
    }
  }, [value, height, fontSize, format]);
  return <svg ref={svgRef} className="label-barcode" />;
}

export function BarcodeLabelsWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff } = useStaffAuth();
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Record<string, SelectedProduct>>({});
  const [sizeId, setSizeId] = useState("50x30");
  const [showName, setShowName] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  const [showCode, setShowCode] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [weightedProductId, setWeightedProductId] = useState("");
  const [selectedWeightedProduct, setSelectedWeightedProduct] = useState<Product | null>(null);
  const [weight, setWeight] = useState("0.500");
  const [weightLabelCopies, setWeightLabelCopies] = useState("1");
  const [weightBarcodeMode, setWeightBarcodeMode] = useState<"weight" | "product">("weight");
  const [packedDate, setPackedDate] = useState(pakistanDateString);
  const [shelfLifeDays, setShelfLifeDays] = useState("7");
  const [companyName, setCompanyName] = useState(DEFAULT_BRAND_NAME);
  const [labelFooter, setLabelFooter] = useState("Keep Refrigerated");
  const [weightedLabels, setWeightedLabels] = useState<WeightedLabel[]>([]);
  const [weightError, setWeightError] = useState("");
  const [scaleMode, setScaleMode] = useState(false);
  const [scaleConfirmed, setScaleConfirmed] = useState(false);
  const [weightCode, setWeightCode] = useState<number | null>(null);
  const [weightCodeBusy, setWeightCodeBusy] = useState(false);
  const [weightCodeNotice, setWeightCodeNotice] = useState("");
  const [weightCodeError, setWeightCodeError] = useState("");
  const [printNotice, setPrintNotice] = useState("");
  const [weightBusy, setWeightBusy] = useState(false);

  useEffect(() => {
    const savedSize = loadPrinterSettings({ branchId: staff?.branch_id ?? null }).labelSizeId;
    if (SIZES.some((option) => option.id === savedSize)) setSizeId(savedSize);
  }, [staff?.branch_id]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams({
      page: String(page),
      categoryId,
      search: debouncedSearch,
    });

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/barcode-labels?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as BarcodeLabelsResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load products for barcode labels.");
        setProducts(result.products || []);
        setCategories(result.categories || []);
        setTotal(result.total || 0);
        setHasMore(Boolean(result.hasMore));
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load products for barcode labels.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [categoryId, debouncedSearch, page]);

  const size = SIZES.find((option) => option.id === sizeId) || SIZES[SIZES.length - 1];
  const queuedProducts = useMemo(() => Object.values(selected).filter((entry) => entry.quantity > 0), [selected]);
  const labelCount = useMemo(() => queuedProducts.reduce((sum, entry) => sum + entry.quantity, 0), [queuedProducts]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const weighedProducts = useMemo(
    () => products.filter((product) => ["kg", "ltr"].includes(String(product.unit_code || "").toLowerCase())),
    [products],
  );
  const weightedProduct = weighedProducts.find((product) => product.id === weightedProductId)
    || (selectedWeightedProduct?.id === weightedProductId ? selectedWeightedProduct : null);
  const weightQuantityMilli = /^\d{1,2}(?:\.\d{1,3})?$/.test(weight.trim())
    ? Math.round(Number(weight) * 1000)
    : null;
  const weightedUnitPrice = weightedProduct ? effectivePrice(weightedProduct) : 0;
  const weightedTotalPaisa = weightQuantityMilli == null
    ? null
    : Math.round(weightedUnitPrice * weightQuantityMilli / 1000);
  const expiryDate = packedDate
    ? addDays(packedDate, Math.max(0, Number.parseInt(shelfLifeDays, 10) || 0))
    : "";

  useEffect(() => {
    let active = true;
    setWeightCode(null);
    setWeightCodeNotice("");
    setWeightCodeError("");
    if (!weightedProductId || weightBarcodeMode !== "weight") {
      setWeightCodeBusy(false);
      return () => { active = false; };
    }
    setWeightCodeBusy(true);
    void (async () => {
      try {
        const result = await assignWeightBarcodeCode(weightedProductId);
        if (!active) return;
        setWeightCode(result.numericCode);
        if (result.reassigned) {
          setWeightedLabels((current) => current.filter((label) => label.product.id !== weightedProductId));
          setWeightCodeNotice(`Assigned weight-barcode code ${result.numericCode}; older measured labels for this product were removed. Reprint them before scanning.`);
        }
      } catch (codeError) {
        if (active) setWeightCodeError(codeError instanceof Error ? codeError.message : "Could not assign a weight-barcode code.");
      } finally {
        if (active) setWeightCodeBusy(false);
      }
    })();
    return () => { active = false; };
  }, [weightedProductId, weightBarcodeMode]);

  const setQuantity = (product: Product, requested: number) => {
    setSelected((current) => {
      const previousQuantity = current[product.id]?.quantity || 0;
      const otherLabels = Object.values(current).reduce((sum, entry) => sum + entry.quantity, 0) - previousQuantity;
      const available = MAX_LABELS - weightedLabels.length - otherLabels;
      const quantity = Math.max(0, Math.min(MAX_PER_PRODUCT, available, Math.floor(requested) || 0));
      const next = { ...current };
      if (quantity === 0) delete next[product.id];
      else next[product.id] = { product, quantity };
      return next;
    });
  };

  const addWeightedLabels = async () => {
    setWeightError("");
    if (!weightedProduct) {
      setWeightError("Select a kg or ltr product first.");
      return;
    }
    if (scaleMode && !scaleConfirmed) {
      setWeightError("Connect the scale and apply a fresh, stable reading first.");
      return;
    }
    if (weightQuantityMilli == null || weightQuantityMilli < 1 || weightQuantityMilli > 99999) {
      setWeightError("Enter a quantity from 0.001 to 99.999.");
      return;
    }
    const copies = Number.parseInt(weightLabelCopies, 10);
    if (!Number.isInteger(copies) || copies < 1 || copies > 99) {
      setWeightError("Number of labels must be from 1 to 99.");
      return;
    }
    if (!packedDate || !expiryDate) {
      setWeightError("Choose a valid packed date and shelf life.");
      return;
    }
    if (copies > MAX_LABELS - labelCount - weightedLabels.length) {
      setWeightError(`Only ${Math.max(0, MAX_LABELS - labelCount - weightedLabels.length)} label(s) fit in the ${MAX_LABELS}-label queue.`);
      return;
    }

    setWeightBusy(true);
    try {
      let numericCode = weightCode;
      if (weightBarcodeMode === "weight") {
        const assigned = await assignWeightBarcodeCode(weightedProduct.id);
        numericCode = assigned.numericCode;
        setWeightCode(assigned.numericCode);
        if (assigned.reassigned) {
          setWeightedLabels((current) => current.filter((label) => label.product.id !== weightedProduct.id));
          setWeightCodeNotice(`Assigned weight-barcode code ${assigned.numericCode}; older measured labels for this product were removed. Reprint them before scanning.`);
        }
      }

      let code = getCode(weightedProduct);
      let barcodeFormat: WeightedLabel["barcodeFormat"] = "CODE128";
      if (weightBarcodeMode === "weight") {
        if (numericCode == null) {
          throw new Error(weightCodeError || "Could not assign a weight-barcode code.");
        }
        code = ean13ForWeight(numericCode, weightQuantityMilli);
        barcodeFormat = "EAN13";
      }
      const total = Math.round(weightedUnitPrice * weightQuantityMilli / 1000);
      const items: WeightedLabel[] = Array.from({ length: copies }, (_, index) => ({
        key: `weighted-${Date.now()}-${index}`,
        code,
        barcodeFormat,
        product: weightedProduct,
        measuredQuantity: weightQuantityMilli / 1000,
        totalPricePaisa: total,
        packedDate,
        expiryDate,
        companyName: companyName.trim() || DEFAULT_BRAND_NAME,
        labelFooter: labelFooter.trim(),
      }));
      setWeightedLabels((current) => [...current, ...items]);
    } catch (addError) {
      setWeightError(addError instanceof Error ? addError.message : "Could not prepare measured labels.");
    } finally {
      setWeightBusy(false);
    }
  };

  const printLabels = () => window.print();
  const printToTagPrinter = async () => {
    if (!allLabelCount) return;
    setPrintNotice("");
    const pageCss = `@page label { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }`;
    const root = document.querySelector("[data-barcode-print-root]");
    const bridgeResult = await printLabelsViaBridge(root, { pageCss, title: "Product labels", branchId: staff?.branch_id ?? null });
    if (bridgeResult.printed) {
      setPrintNotice("Labels sent to the configured tag printer through the local bridge.");
      return;
    }
    if (!bridgeResult.bridgeUnavailable && bridgeResult.reason
      && !/not configured/i.test(bridgeResult.reason)) {
      setPrintNotice(bridgeResult.reason);
    }
    const pageStyleId = "direct-label-page-size";
    let pageStyle = document.getElementById(pageStyleId) as HTMLStyleElement | null;
    if (!pageStyle) {
      pageStyle = document.createElement("style");
      pageStyle.id = pageStyleId;
      document.head.append(pageStyle);
    }
    pageStyle.textContent = pageCss;
    document.documentElement.classList.add("direct-label-print");
    const cleanup = () => {
      document.documentElement.classList.remove("direct-label-print");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
    window.setTimeout(cleanup, 60_000);
  };
  const clearFilters = () => {
    setSearch("");
    setCategoryId("");
    setPage(1);
  };

  const sheetStyle = {
    "--label-columns": size.columns,
    "--label-width": `${size.widthMm}mm`,
    "--label-height": `${size.heightMm}mm`,
  } as CSSProperties;

  const renderLabels = () => {
    const productLabels = queuedProducts.flatMap(({ product, quantity }) => {
      const code = getCode(product);
      return Array.from({ length: quantity }, (_, index) => (
        <article className="barcode-label" key={`${product.id}-${index}`}>
          {showName && <strong className="label-name">{product.name}</strong>}
          <Barcode value={code} height={size.barcodeHeight} fontSize={size.font} />
          {showCode && <small className="label-code">{code}</small>}
          {showPrice && <span className="label-price">{formatMoney(effectivePrice(product))}</span>}
        </article>
      ));
    });
    const measuredLabels = weightedLabels.map((label) => (
      <article className="barcode-label" key={label.key}>
        {showName && <strong className="label-name">{label.product.name}</strong>}
        <Barcode
          value={label.code}
          height={size.barcodeHeight}
          fontSize={size.font}
          format={label.barcodeFormat}
        />
        {showCode && <small className="label-code">{label.code}</small>}
        <div className="label-weight-meta">
          <span>WT {label.measuredQuantity.toFixed(3)} {label.product.unit_code}</span>
          <span>Packed {labelDate(label.packedDate)}</span>
          <span>Expiry {labelDate(label.expiryDate)}</span>
        </div>
        {showPrice && (
          <div className="label-weight-price">
            <span>PKR/{label.product.unit_code} {formatMoney(effectivePrice(label.product))}</span>
            <strong>Total {formatMoney(label.totalPricePaisa)}</strong>
          </div>
        )}
        <div className="label-weight-footer">
          <span>{label.companyName}</span>
          <i>{label.labelFooter}</i>
        </div>
      </article>
    ));
    return [...productLabels, ...measuredLabels].slice(0, MAX_LABELS);
  };

  const allLabelCount = labelCount + weightedLabels.length;

  return (
    <section className="module labels-module" aria-label={item.title}>
      <div className="module-heading">
        <div>
          <p className="eyebrow">{item.section.toUpperCase()}</p>
          <h1>{item.title}</h1>
          <p className="lead">Print CODE 128 shelf and product labels straight from the catalogue, or print measured weight/volume labels from a connected scale.</p>
        </div>
        <div className="labels-print-actions">
          <button type="button" className="secondary-button" onClick={printLabels} disabled={!allLabelCount}>
            <Printer size={14} /> Choose printer
          </button>
          <button type="button" className="primary-button" onClick={printToTagPrinter} disabled={!allLabelCount}>
            <Printer size={14} /> Print to tag printer
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {printNotice && <div className="notice info" role="status">{printNotice}</div>}

      <div className="stats-grid compact">
        <article className="stat-card"><span>Products selected</span><strong>{queuedProducts.length}</strong><small>With at least one label</small></article>
        <article className="stat-card"><span>Labels queued</span><strong>{allLabelCount}</strong><small>Max {MAX_LABELS} per sheet</small></article>
        <article className="stat-card"><span>Label size</span><strong>{size.label}</strong><small>Shared printer setting</small></article>
      </div>

      <HorizontalFilterScroller className="toolbar labels-toolbar" ariaLabel="Barcode label filters and settings">
        <label className="search-field labels-product-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Search products or scan a code"
            placeholder="Search products or scan a code"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="toolbar-control labels-category-filter">
          <span>Category</span>
          <SearchableFilter
            value={categoryId}
            ariaLabel="Filter products by category"
            placeholder="All categories"
            options={[
              { value: "", label: "All categories" },
              ...categories.map((category) => ({ value: category.id, label: category.name })),
            ]}
            onChange={(value) => { setCategoryId(value); setPage(1); }}
          />
        </label>
        <label className="toolbar-control labels-size-filter">
          <span>Label size</span>
          <SearchableFilter
            value={sizeId}
            ariaLabel="Choose label size"
            placeholder="Select label size"
            options={SIZES.map((option) => ({ value: option.id, label: option.label }))}
            onChange={setSizeId}
          />
        </label>
        <label className="toggle-field"><input type="checkbox" checked={showName} onChange={(event) => setShowName(event.target.checked)} /> Name</label>
        <label className="toggle-field"><input type="checkbox" checked={showPrice} onChange={(event) => setShowPrice(event.target.checked)} /> Price</label>
        <label className="toggle-field"><input type="checkbox" checked={showCode} onChange={(event) => setShowCode(event.target.checked)} /> Code</label>
        <button type="button" className="secondary-button" onClick={() => setSelected({})} disabled={!labelCount || weightBusy}>Clear</button>
        {(search || categoryId) && <button type="button" className="secondary-button" onClick={clearFilters}>Clear filters</button>}
      </HorizontalFilterScroller>

      <section className="labels-measured">
        <div className="labels-measured-heading">
          <div>
            <h2>Measured product labels</h2>
            <p>Print a weight/volume-specific label using a configured USB-to-serial scale.</p>
          </div>
          <button type="button" className="secondary-button" onClick={() => setWeightedLabels([])} disabled={!weightedLabels.length || weightBusy}>
            Clear measured labels
          </button>
        </div>
        <div className="labels-measured-grid">
          <div className="labels-measured-controls">
            <label className="field">
              <span>Product</span>
              <select
                value={weightedProductId}
                onChange={(event) => {
                  const productId = event.target.value;
                  setWeightedProductId(productId);
                  setSelectedWeightedProduct(weighedProducts.find((product) => product.id === productId) || null);
                  setWeightError("");
                  setScaleConfirmed(false);
                }}
              >
                <option value="">Choose kg/ltr product</option>
                {selectedWeightedProduct && !weighedProducts.some((product) => product.id === selectedWeightedProduct.id) && (
                  <option value={selectedWeightedProduct.id}>
                    {selectedWeightedProduct.name} · {formatMoney(effectivePrice(selectedWeightedProduct))}/{selectedWeightedProduct.unit_code}
                  </option>
                )}
                {weighedProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name} · {formatMoney(effectivePrice(product))}/{product.unit_code}
                  </option>
                ))}
              </select>
            </label>
            <div className="labels-measured-tabs">
              <button type="button" className={!scaleMode ? "active" : ""} onClick={() => { setScaleMode(false); setScaleConfirmed(false); }}>Manual</button>
              <button type="button" className={scaleMode ? "active" : ""} onClick={() => { setScaleMode(true); setScaleConfirmed(false); }}>From scale</button>
            </div>
            {!scaleMode && (
              <label className="field">
                <span>Weight ({weightedProduct?.unit_code || "unit"})</span>
                <input
                  inputMode="decimal"
                  placeholder="0.000"
                  value={weight}
                  onChange={(event) => { setWeight(event.target.value); setScaleConfirmed(false); }}
                />
              </label>
            )}
            {scaleMode && weightedProduct && (
              <SerialScale
                key={weightedProductId}
                unitCode={weightedProduct.unit_code}
                onUseReading={(quantity) => {
                  setWeight(quantity.toFixed(3));
                  setScaleConfirmed(true);
                }}
              />
            )}
            <div className="two-fields">
              <label className="field"><span>Packed on</span><input type="date" value={packedDate} onChange={(event) => setPackedDate(event.target.value)} /></label>
              <label className="field"><span>Shelf life (days)</span><input type="number" min="0" max="3650" value={shelfLifeDays} onChange={(event) => setShelfLifeDays(event.target.value)} /></label>
            </div>
            <div className="two-fields">
              <label className="field"><span>Expiry date</span><input value={expiryDate} readOnly /></label>
              <label className="field"><span>Number of labels</span><input type="number" min="1" max="99" value={weightLabelCopies} onChange={(event) => setWeightLabelCopies(event.target.value)} /></label>
            </div>
            <label className="field">
              <span>Barcode contains</span>
              <select value={weightBarcodeMode} onChange={(event) => { setWeightBarcodeMode(event.target.value as "weight" | "product"); setWeightError(""); }}>
                <option value="weight">Product + measured quantity (EAN-13)</option>
                <option value="product">Product code only</option>
              </select>
            </label>
            <div className="two-fields">
              <label className="field"><span>Company name</span><input value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>
              <label className="field"><span>Footer text</span><input value={labelFooter} onChange={(event) => setLabelFooter(event.target.value)} /></label>
            </div>
            {weightError && <div className="error-banner">{weightError}</div>}
            {weightedProduct && weightBarcodeMode === "weight" && (
              <div className="weight-barcode-notice" role="status">
                {weightCodeBusy
                  ? "Preparing this product's weight-barcode code…"
                  : weightCodeError
                    ? weightCodeError
                    : weightCodeNotice
                      || `Weight-barcode code ${weightCode ?? "—"}. Scanner lookup uses EAN-13 21 + this code + the measured quantity.`}
              </div>
            )}
          </div>
          <div className="labels-measured-preview">
            <h3>Label preview</h3>
            {weightedProduct ? (
              <>
                <div className="labels-measured-preview-card">
                  <strong>{weightedProduct.name}</strong>
                  {weightBarcodeMode === "weight" && weightCode != null && weightQuantityMilli && weightQuantityMilli > 0
                    ? <Barcode value={ean13ForWeight(weightCode, weightQuantityMilli)} height={35} fontSize={8} format="EAN13" />
                    : <span className="labels-weight-barcode-placeholder">{weightBarcodeMode === "weight" ? "Preparing EAN-13…" : "Product barcode"}</span>}
                  <div><span>Packed {packedDate || "—"}</span><span>Expiry {expiryDate || "—"}</span></div>
                  <div>
                    <span>WT {weightQuantityMilli == null ? "—" : `${(weightQuantityMilli / 1000).toFixed(3)} ${weightedProduct.unit_code}`}</span>
                    <span>PKR/{weightedProduct.unit_code} {formatMoney(weightedUnitPrice)}</span>
                  </div>
                  <b>{weightedTotalPaisa == null ? "—" : formatMoney(weightedTotalPaisa)}</b>
                  <footer>{companyName || DEFAULT_BRAND_NAME} <i>{labelFooter}</i></footer>
                </div>
                <p>{weightQuantityMilli == null ? "Enter a valid quantity." : `${(weightQuantityMilli / 1000).toFixed(3)} ${weightedProduct.unit_code} · total ${formatMoney(weightedTotalPaisa ?? 0)}`}</p>
              </>
            ) : <p className="labels-empty">Select a kg/ltr product to preview its measured label.</p>}
            <button
              type="button"
              className="primary-button"
              disabled={weightBusy || weightCodeBusy || (scaleMode && !scaleConfirmed)}
              onClick={addWeightedLabels}
            >
              {weightBusy ? "Preparing labels…" : `Add ${weightLabelCopies || 1} measured label${Number(weightLabelCopies) === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </section>

      <div className="labels-layout">
        <div className="labels-picker">
          <h2 className="section-title">Choose products</h2>
          {loading ? (
            <div className="labels-empty"><LoaderCircle size={17} className="spin" /> Loading products…</div>
          ) : !error && products.length ? (
            <div className="labels-list">
              {products.map((product) => {
                const quantity = selected[product.id]?.quantity || 0;
                const totalWithoutProduct = labelCount - quantity;
                const addDisabled = quantity >= MAX_PER_PRODUCT || totalWithoutProduct + quantity + weightedLabels.length >= MAX_LABELS;
                return (
                  <div className={quantity ? "labels-row selected" : "labels-row"} key={product.id}>
                    <div className="labels-info">
                      <strong>{product.name}</strong>
                      <small>{getCode(product)}{!product.is_active ? " · Inactive" : ""}</small>
                    </div>
                    <div className="labels-controls">
                      <button
                        type="button"
                        className="secondary-button icon-button"
                        aria-label={`Remove one label for ${product.name}`}
                        onClick={() => setQuantity(product, quantity - 1)}
                        disabled={!quantity || weightBusy}
                      >−</button>
                      <input
                        aria-label={`Labels for ${product.name}`}
                        inputMode="numeric"
                        value={quantity || ""}
                        placeholder="0"
                        disabled={weightBusy}
                        onChange={(event) => setQuantity(product, Number.parseInt(event.target.value, 10) || 0)}
                      />
                      <button
                        type="button"
                        className="secondary-button icon-button"
                        aria-label={`Add one label for ${product.name}`}
                        onClick={() => setQuantity(product, quantity + 1)}
                        disabled={addDisabled || weightBusy}
                      >+</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !error ? (
            <p className="labels-empty">{debouncedSearch || categoryId ? "No products match these filters." : "No products are available for labels."}</p>
          ) : null}
          <nav className="labels-pagination" aria-label="Product catalogue pages">
            <button type="button" className="secondary-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={loading || page <= 1}>
              <ChevronLeft size={15} /> Previous
            </button>
            <span>Page {page} of {pageCount}</span>
            <button type="button" className="secondary-button" onClick={() => setPage((current) => current + 1)} disabled={loading || !hasMore}>
              Next <ChevronRight size={15} />
            </button>
          </nav>
        </div>

        <div className="labels-preview">
          <h2 className="section-title"><Tags size={11} /> Preview</h2>
          {allLabelCount ? (
            <div className="label-sheet-scroll">
              <div className="label-sheet" style={sheetStyle}>
                {renderLabels()}
              </div>
            </div>
          ) : (
            <p className="labels-empty">Nothing queued yet. Use + on a product to add labels, or add measured labels above.</p>
          )}
        </div>
      </div>

      <div className="page-note">
        Choose printer opens the system print dialog. Print to tag printer sends one label per page at the exact
        label size, matching the Windows tag-printer layout. Configure the matching label size in your printer
        driver. Measured labels use a USB-to-serial scale through Web Serial in Chrome or Edge; Ethernet scales
        use the local scale bridge.
      </div>

      <div className="barcode-print-root" data-barcode-print-root aria-hidden="true">
        <div className="label-sheet" style={sheetStyle}>{renderLabels()}</div>
      </div>
    </section>
  );
}
