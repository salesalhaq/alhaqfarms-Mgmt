import "server-only";

export type ReportClient = {
  from(table: string): any;
  rpc(name: string, args?: Record<string, unknown>): any;
};

export const REPORT_ROW_LIMIT = 5_000;
export const REPORT_PAGE_SIZE = 1_000;
export const CATALOG_PAGE_SIZE = 60;
export const CATALOG_MAX_PER_BRANCH = 2_400;

export function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

export function sumBy<T>(rows: T[], read: (row: T) => number): number {
  return rows.reduce((total, row) => total + read(row), 0);
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Pakistan has no daylight saving time, so a fixed +05:00 offset is exact. */
export function pakistanDateBoundary(value: string, nextDay = false): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+05:00`).toISOString();
}

export function pakistanDayKey(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (value.length <= 10) return value.slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return new Date(parsed.getTime() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function monthKey(value: unknown): string {
  return pakistanDayKey(value).slice(0, 7);
}

export function monthLabel(key: string): string {
  if (!/^\d{4}-\d{2}$/.test(key)) return key;
  const date = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(date);
}

export function addMonths(key: string, count: number): string {
  const date = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + count, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Supabase caps a single PostgREST response at 1,000 rows by default. */
export async function fetchPaged<T>(
  build: () => any,
  limit = REPORT_ROW_LIMIT,
  pageSize = REPORT_PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < limit; offset += pageSize) {
    const { data, error } = await build().range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data || []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export interface CatalogProduct {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category_id: string | null;
  category_name: string | null;
  unit_code: string;
  price_paisa: number;
  on_sale: boolean;
  discounted_price_paisa: number | null;
  is_active: boolean;
  stock_milli: number;
  total_count?: number;
}

export interface BranchCatalog {
  branchId: string;
  branchName: string;
  products: CatalogProduct[];
  complete: boolean;
}

/** Current branch stock, read through the staff-scoped POS catalog function. */
export async function loadBranchCatalog(
  client: ReportClient,
  branchId: string,
  branchName: string,
): Promise<BranchCatalog> {
  const first = await client.rpc("get_staff_pos_catalog", {
    p_branch_id: branchId,
    p_search: "",
    p_category_id: null,
    p_limit: CATALOG_PAGE_SIZE,
    p_offset: 0,
  });
  if (first.error) throw new Error(first.error.message);

  const products: CatalogProduct[] = [...(first.data || [])];
  const total = products[0]?.total_count || 0;
  const limit = Math.min(total, CATALOG_MAX_PER_BRANCH);
  const offsets = Array.from(
    { length: Math.ceil(Math.max(0, limit - products.length) / CATALOG_PAGE_SIZE) },
    (_, index) => products.length + index * CATALOG_PAGE_SIZE,
  );

  for (let index = 0; index < offsets.length; index += 6) {
    const batch = offsets.slice(index, index + 6);
    const pages = await Promise.all(batch.map((offset) => client.rpc("get_staff_pos_catalog", {
      p_branch_id: branchId,
      p_search: "",
      p_category_id: null,
      p_limit: CATALOG_PAGE_SIZE,
      p_offset: offset,
    })));
    const failed = pages.find((page: any) => page.error);
    if (failed?.error) throw new Error(failed.error.message);
    for (const page of pages) products.push(...(page.data || []));
  }

  const unique = [...new Map(products.map((product) => [product.id, product])).values()];
  return {
    branchId,
    branchName,
    products: unique,
    complete: total <= CATALOG_MAX_PER_BRANCH && unique.length >= total,
  };
}

export interface StockRow {
  id: string;
  name: string;
  sku: string | null;
  category: string;
  unit: string;
  quantityMilli: number;
  costPaisa: number;
  pricePaisa: number;
  reorderMilli: number;
  minMilli: number;
  status: "Out of stock" | "Low" | "OK";
}

export interface StockSnapshot {
  rows: StockRow[];
  byBranch: Array<{
    branchId: string;
    branchName: string;
    items: Array<{
      id: string;
      name: string;
      unit: string;
      quantityMilli: number;
      costPaisa: number;
    }>;
  }>;
  complete: boolean;
}

/**
 * Builds the current stock position from the branch catalog plus product
 * metadata (cost, reorder point, minimum level and category).
 */
export async function loadStockSnapshot(
  client: ReportClient,
  branches: Array<{ id: string; name: string }>,
): Promise<StockSnapshot> {
  if (!branches.length) return { rows: [], byBranch: [], complete: true };

  const catalogs = await Promise.all(
    branches.map((branch) => loadBranchCatalog(client, branch.id, branch.name)),
  );

  const productIds = [...new Set(catalogs.flatMap((catalog) => catalog.products.map((product) => product.id)))];
  const metadata = new Map<string, {
    cost: number;
    price: number;
    reorder: number;
    minimum: number;
    category: string;
    unit: string;
  }>();

  const categoryNames = new Map<string, string>();
  for (const ids of chunk(productIds, 200)) {
    if (!ids.length) continue;
    const [productResult, categoryResult] = await Promise.all([
      client
        .from("products")
        .select("id,cost_price_paisa,price_paisa,reorder_point_milli,min_stock_milli,category_id,unit_code")
        .in("id", ids)
        .is("deleted_at", null),
      client.from("categories").select("id,name").is("deleted_at", null),
    ]);
    if (productResult.error) throw new Error(productResult.error.message);
    if (categoryResult.error) throw new Error(categoryResult.error.message);
    for (const category of (categoryResult.data || []) as Array<{ id: string; name: string }>) {
      categoryNames.set(category.id, category.name);
    }
    for (const product of (productResult.data || []) as Array<{
      id: string;
      cost_price_paisa: number;
      price_paisa: number;
      reorder_point_milli: number;
      min_stock_milli: number;
      category_id: string | null;
      unit_code: string;
    }>) {
      metadata.set(product.id, {
        cost: asNumber(product.cost_price_paisa),
        price: asNumber(product.price_paisa),
        reorder: asNumber(product.reorder_point_milli),
        minimum: asNumber(product.min_stock_milli),
        category: product.category_id ? categoryNames.get(product.category_id) || "Uncategorised" : "Uncategorised",
        unit: product.unit_code,
      });
    }
  }

  const byBranch = catalogs.map((catalog) => ({
    branchId: catalog.branchId,
    branchName: catalog.branchName,
    items: catalog.products.map((product) => ({
      id: product.id,
      name: product.name,
      unit: product.unit_code,
      quantityMilli: asNumber(product.stock_milli),
      costPaisa: metadata.get(product.id)?.cost ?? 0,
    })),
  }));

  const aggregated = new Map<string, StockRow>();
  for (const catalog of catalogs) {
    for (const product of catalog.products) {
      const info = metadata.get(product.id);
      const existing = aggregated.get(product.id);
      if (existing) {
        existing.quantityMilli += asNumber(product.stock_milli);
        continue;
      }
      aggregated.set(product.id, {
        id: product.id,
        name: product.name,
        sku: product.sku,
        category: info?.category || product.category_name || "Uncategorised",
        unit: info?.unit || product.unit_code,
        quantityMilli: asNumber(product.stock_milli),
        costPaisa: info?.cost ?? 0,
        pricePaisa: info?.price ?? asNumber(product.price_paisa),
        reorderMilli: info?.reorder ?? 0,
        minMilli: info?.minimum ?? 0,
        status: "OK",
      });
    }
  }

  const rows = [...aggregated.values()].map((row) => {
    const threshold = Math.max(row.reorderMilli, row.minMilli);
    const status: StockRow["status"] = row.quantityMilli <= 0
      ? "Out of stock"
      : threshold > 0 && row.quantityMilli <= threshold
        ? "Low"
        : "OK";
    return { ...row, status };
  });

  return {
    rows,
    byBranch,
    complete: catalogs.every((catalog) => catalog.complete),
  };
}

export function stockValuePaisa(quantityMilli: number, unitCostPaisa: number): number {
  return Math.round((asNumber(quantityMilli) * asNumber(unitCostPaisa)) / 1000);
}

export function displayQuantity(quantityMilli: number): number {
  return Math.round(asNumber(quantityMilli)) / 1000;
}
