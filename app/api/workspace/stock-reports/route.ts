import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import type { Database } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

type CatalogProduct = Database["public"]["Functions"]["get_staff_pos_catalog"]["Returns"][number];

interface BranchCatalog {
  branchId: string;
  branchName: string;
  products: CatalogProduct[];
  total: number;
  complete: boolean;
}

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

const CATALOG_PAGE_SIZE = 60;
const MAX_PRODUCTS_PER_BRANCH = 2_400;
const CATALOG_REQUEST_CONCURRENCY = 6;

async function loadBranchCatalog(
  client: SupabaseClient<Database>,
  branchId: string,
  branchName: string,
): Promise<BranchCatalog> {
  const firstPage = await client.rpc("get_staff_pos_catalog", {
    p_branch_id: branchId,
    p_search: "",
    p_category_id: null,
    p_limit: CATALOG_PAGE_SIZE,
    p_offset: 0,
  });
  if (firstPage.error) throw new Error(firstPage.error.message);

  const products = [...(firstPage.data || [])];
  const total = products[0]?.total_count || 0;
  const limit = Math.min(total, MAX_PRODUCTS_PER_BRANCH);
  const offsets = Array.from(
    { length: Math.ceil(Math.max(0, limit - products.length) / CATALOG_PAGE_SIZE) },
    (_, index) => products.length + index * CATALOG_PAGE_SIZE,
  );

  for (let index = 0; index < offsets.length; index += CATALOG_REQUEST_CONCURRENCY) {
    const batch = offsets.slice(index, index + CATALOG_REQUEST_CONCURRENCY);
    const pages = await Promise.all(batch.map((offset) => client.rpc("get_staff_pos_catalog", {
      p_branch_id: branchId,
      p_search: "",
      p_category_id: null,
      p_limit: CATALOG_PAGE_SIZE,
      p_offset: offset,
    })));
    const failedPage = pages.find((page) => page.error);
    if (failedPage?.error) throw new Error(failedPage.error.message);
    pages.forEach((page) => products.push(...(page.data || [])));
  }

  const uniqueProducts = [...new Map(products.map((product) => [product.id, product])).values()];
  return {
    branchId,
    branchName,
    products: uniqueProducts,
    total,
    complete: total <= MAX_PRODUCTS_PER_BRANCH && uniqueProducts.length >= total,
  };
}

async function loadProductMetadata(
  client: SupabaseClient<Database>,
  productIds: string[],
) {
  const costs = new Map<string, number>();
  const replenishment = new Map<string, { reorder: number; maximum: number }>();
  if (productIds.length === 0) return { costs, replenishment, costsAvailable: true, replenishmentAvailable: true };

  let costsAvailable = true;
  let replenishmentAvailable = true;
  for (let index = 0; index < productIds.length; index += 500) {
    const ids = productIds.slice(index, index + 500);
    const [costResult, replenishmentResult] = await Promise.all([
      client.from("products").select("id,cost_price_paisa").in("id", ids).is("deleted_at", null),
      client.from("products").select("id,reorder_point_milli,max_stock_milli").in("id", ids).is("deleted_at", null),
    ]);

    if (costResult.error) costsAvailable = false;
    else (costResult.data || []).forEach((product) => costs.set(product.id, product.cost_price_paisa));
    if (replenishmentResult.error) replenishmentAvailable = false;
    else (replenishmentResult.data || []).forEach((product) => replenishment.set(product.id, {
      reorder: product.reorder_point_milli,
      maximum: product.max_stock_milli,
    }));
  }

  if (costs.size !== productIds.length) costsAvailable = false;
  if (replenishment.size !== productIds.length) replenishmentAvailable = false;
  return { costs, replenishment, costsAvailable, replenishmentAvailable };
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const identity = authentication.identity;
  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  const isAdmin = identity.staff.role === "admin";
  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }
  if (!isAdmin && requestedBranch && requestedBranch !== identity.staff.branch_id) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  const branchId = isAdmin
    ? requestedBranch && requestedBranch !== "all" ? requestedBranch : null
    : identity.staff.branch_id;
  const branches = branchId
    ? identity.branches.filter((branch) => branch.id === branchId)
    : identity.branches;

  if (!branches.length || (branchId && !branches[0])) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  try {
    const catalogs = await Promise.all(branches.map((branch) =>
      loadBranchCatalog(authentication.client, branch.id, branch.name)));
    const completeCatalog = catalogs.every((catalog) => catalog.complete);
    const baseProductIds = catalogs[0].products.map((product) => product.id).sort();
    const sameProductSet = catalogs.every((catalog) => {
      const ids = catalog.products.map((product) => product.id).sort();
      return ids.length === baseProductIds.length && ids.every((id, index) => id === baseProductIds[index]);
    });

    if (branchId == null && completeCatalog && !sameProductSet) {
      return authenticationResponse(request, authentication, {
        error: "Branch stock catalogs differ. Choose an individual branch to avoid incomplete all-branch balances.",
      }, 503);
    }

    const stockSource = branchId ? catalogs[0].products : catalogs[0].products;
    const productIds = [...new Set(stockSource.map((product) => product.id))];
    const metadata = await loadProductMetadata(authentication.client, productIds);
    const branchName = branchId
      ? branches[0].name
      : "All branches";

    const products: StockReportProduct[] = stockSource.map((product) => {
      const stockMilli = branchId
        ? product.stock_milli
        : catalogs.reduce((total, catalog) => {
          const branchProduct = catalog.products.find((candidate) => candidate.id === product.id);
          return total + (branchProduct?.stock_milli || 0);
        }, 0);
      const costs = metadata.costs.get(product.id);
      const thresholds = metadata.replenishment.get(product.id);
      return {
        id: product.id,
        name: product.name,
        sku: product.sku,
        barcode: product.barcode,
        category_id: product.category_id,
        category_name: product.category_name,
        unit_code: product.unit_code,
        stock_milli: stockMilli,
        cost_price_paisa: metadata.costsAvailable ? costs ?? null : null,
        reorder_point_milli: metadata.replenishmentAvailable ? thresholds?.reorder ?? null : null,
        max_stock_milli: metadata.replenishmentAvailable ? thresholds?.maximum ?? null : null,
      };
    });

    return authenticationResponse(request, authentication, {
      branchId,
      branchName,
      products,
      sourceProductCount: branchId ? catalogs[0].total : catalogs[0].total,
      reportComplete: completeCatalog && (branchId != null || sameProductSet),
      availability: {
        stock: true,
        valuation: metadata.costsAvailable,
        replenishment: metadata.replenishmentAvailable,
        movements: false,
        activeProductsOnly: true,
      },
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load live stock report data.",
    }, 500);
  }
}
