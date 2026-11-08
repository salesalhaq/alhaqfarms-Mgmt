import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import {
  assertSameOrigin,
  readInteger,
  readJsonBody,
  readOptionalText,
  readText,
  writeFailure,
  WriteError,
} from "@/lib/server/write";
import type { Database, Json } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

type CatalogProduct = Database["public"]["Functions"]["get_staff_pos_catalog"]["Returns"][number];

interface CatalogResult {
  branchId: string;
  branchName: string;
  products: CatalogProduct[];
  total: number;
  complete: boolean;
}

interface StockMovementRow {
  id: string;
  branch_id: string;
  product_id: string;
  movement_type: string;
  quantity_delta_milli: number;
  unit_cost_paisa: number | null;
  reference_type: string | null;
  reference_id: string | null;
  occurred_at: string;
  created_by: string | null;
  notes: string | null;
}

const CATALOG_PAGE_SIZE = 60;
const MAX_PRODUCTS_PER_BRANCH = 300;
const MAX_PRODUCTS_DISPLAY = 500;
const MOVEMENT_LIMIT = 100;
const STOCKTAKE_LIMIT = 30;
const ID_CHUNK = 200;

function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadBranchCatalog(
  client: SupabaseClient<Database>,
  branchId: string,
  branchName: string,
  search: string,
): Promise<CatalogResult> {
  const firstPage = await client.rpc("get_staff_pos_catalog", {
    p_branch_id: branchId,
    p_search: search,
    p_category_id: null,
    p_limit: CATALOG_PAGE_SIZE,
    p_offset: 0,
  });
  if (firstPage.error) throw new Error(firstPage.error.message);

  const products = [...(firstPage.data || [])];
  const total = products[0]?.total_count || 0;
  const limit = Math.min(total, MAX_PRODUCTS_PER_BRANCH);

  while (products.length < limit) {
    const page = await client.rpc("get_staff_pos_catalog", {
      p_branch_id: branchId,
      p_search: search,
      p_category_id: null,
      p_limit: CATALOG_PAGE_SIZE,
      p_offset: products.length,
    });
    if (page.error) throw new Error(page.error.message);
    const rows = page.data || [];
    if (!rows.length) break;
    products.push(...rows);
    if (rows.length < CATALOG_PAGE_SIZE) break;
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

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const identity = authentication.identity;
  const role = identity.staff.role;
  const rawClient = authentication.client as unknown as { from(table: string): any };
  const parameters = new URL(request.url).searchParams;

  const requestedBranch = parameters.get("branchId") || "";
  const search = (parameters.get("search") || "").trim();
  const productId = parameters.get("productId") || "";
  const detailId = parameters.get("detailId") || "";

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }
  if (productId && !isUuid(productId)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid product." }, 400);
  }

  const branchNames = new Map(identity.branches.map((branch) => [branch.id, branch.name]));
  if (requestedBranch && requestedBranch !== "all" && !branchNames.has(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  let selectedBranchIds: string[];
  if (role === "admin") {
    selectedBranchIds = requestedBranch && requestedBranch !== "all"
      ? [requestedBranch]
      : identity.branches.map((branch) => branch.id);
  } else {
    const branchId = identity.staff.branch_id;
    if (!branchId) {
      return authenticationResponse(request, authentication, { error: "This account is not assigned to a branch." }, 403);
    }
    selectedBranchIds = [branchId];
  }

  const branchName = selectedBranchIds.length === 1
    ? branchNames.get(selectedBranchIds[0]) || "Your branch"
    : "All accessible branches";

  if (!selectedBranchIds.length) {
    return authenticationResponse(request, authentication, {
      branchId: null,
      branchName: "No accessible branch",
      products: [],
      totals: {
        productCount: 0, quantityMilli: 0, lowStockCount: 0, outOfStockCount: 0,
        estimatedValuePaisa: 0, productsShown: 0, truncated: false, valuationComplete: true,
      },
      movements: [],
      stocktakes: [],
      canViewStocktakes: false,
      canRecordMovements: false,
      canRecordStocktakes: false,
      branches: [],
      readOnly: true,
      generatedAt: new Date().toISOString(),
    });
  }

  try {
    // Stocktake history mirrors the desktop rule: administrators always, managers
    // only when the branch permission allows it, cashiers never.
    let canRecordMovements = role === "admin";
    let canRecordStocktakes = role === "admin";
    if (role === "manager") {
      const permissions = await rawClient
        .from("inventory_permissions")
        .select("branch_id,action,is_allowed")
        .in("branch_id", selectedBranchIds)
        .is("deleted_at", null)
        .eq("role", "manager")
        .in("action", ["record_stock_movement", "record_stocktake"])
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false });
      if (permissions.error) throw new Error(permissions.error.message);
      const currentPermissions = new Map<string, boolean>();
      for (const permission of permissions.data || []) {
        const key = `${permission.branch_id}:${permission.action}`;
        if (!currentPermissions.has(key)) currentPermissions.set(key, Boolean(permission.is_allowed));
      }
      canRecordMovements = selectedBranchIds.some((id) => currentPermissions.get(`${id}:record_stock_movement`) === true);
      canRecordStocktakes = selectedBranchIds.some((id) => currentPermissions.get(`${id}:record_stocktake`) === true);
    }
    const canViewStocktakes = canRecordStocktakes;

    if (detailId) {
      if (!canViewStocktakes) {
        return authenticationResponse(request, authentication, { error: "Stocktake history is not available to your account." }, 403);
      }
      if (!isUuid(detailId)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid stocktake." }, 400);
      }

      const stocktakeResult = await rawClient
        .from("inventory_stocktakes")
        .select("id,branch_id,notes,created_at,created_by")
        .eq("id", detailId)
        .is("deleted_at", null)
        .maybeSingle();
      if (stocktakeResult.error) throw new Error(stocktakeResult.error.message);
      const stocktake = stocktakeResult.data as {
        id: string; branch_id: string; notes: string | null; created_at: string; created_by: string | null;
      } | null;
      if (!stocktake || !selectedBranchIds.includes(stocktake.branch_id)) {
        return authenticationResponse(request, authentication, { error: "This stocktake is not available to your account." }, 404);
      }

      const itemsResult = await rawClient
        .from("inventory_stocktake_items")
        .select("product_id,product_name,unit_code,system_quantity_milli,counted_quantity_milli,variance_milli")
        .eq("stocktake_id", detailId)
        .is("deleted_at", null)
        .order("product_name", { ascending: true });
      if (itemsResult.error) throw new Error(itemsResult.error.message);

      let createdByName = "Staff unavailable";
      if (stocktake.created_by) {
        const staffResult = await authentication.client
          .from("staff_profiles")
          .select("id,full_name")
          .eq("id", stocktake.created_by)
          .is("deleted_at", null)
          .limit(1);
        createdByName = (staffResult.data || [])[0]?.full_name || createdByName;
      }

      return authenticationResponse(request, authentication, {
        detail: {
          id: stocktake.id,
          branch_id: stocktake.branch_id,
          branch_name: branchNames.get(stocktake.branch_id) || "Branch unavailable",
          notes: stocktake.notes,
          created_at: stocktake.created_at,
          created_by_name: createdByName,
          items: itemsResult.data || [],
        },
      });
    }

    const catalogs = await Promise.all(selectedBranchIds.map((branchId) =>
      loadBranchCatalog(authentication.client, branchId, branchNames.get(branchId) || "Branch", search),
    ));

    const stockByProduct = new Map<string, number>();
    const stockByBranchProduct = new Map<string, number>();
    const productInfo = new Map<string, CatalogProduct>();
    for (const catalog of catalogs) {
      for (const product of catalog.products) {
        stockByProduct.set(product.id, (stockByProduct.get(product.id) || 0) + asNumber(product.stock_milli));
        stockByBranchProduct.set(`${catalog.branchId}:${product.id}`, asNumber(product.stock_milli));
        if (!productInfo.has(product.id)) productInfo.set(product.id, product);
      }
    }

    const productIds = [...productInfo.keys()];
    const costs = new Map<string, number>();
    const replenishment = new Map<string, { reorder: number; minimum: number }>();
    for (const ids of chunk(productIds, 500)) {
      const result = await authentication.client
        .from("products")
        .select("id,cost_price_paisa,reorder_point_milli,min_stock_milli")
        .in("id", ids)
        .is("deleted_at", null);
      if (result.error) continue;
      for (const product of result.data || []) {
        costs.set(product.id, asNumber(product.cost_price_paisa));
        replenishment.set(product.id, {
          reorder: asNumber(product.reorder_point_milli),
          minimum: asNumber(product.min_stock_milli),
        });
      }
    }

    const allProducts = [...productInfo.values()]
      .map((product) => {
        const stockMilli = stockByProduct.get(product.id) || 0;
        const thresholds = replenishment.get(product.id);
        return {
          id: product.id,
          name: product.name,
          sku: product.sku,
          barcode: product.barcode,
          category_name: product.category_name,
          unit_code: product.unit_code,
          stock_milli: stockMilli,
          reorder_point_milli: thresholds?.reorder ?? null,
          min_stock_milli: thresholds?.minimum ?? null,
          cost_price_paisa: costs.get(product.id) ?? null,
          is_active: product.is_active,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    const catalogTruncated = catalogs.some((catalog) => !catalog.complete);
    const products = allProducts.slice(0, MAX_PRODUCTS_DISPLAY);
    const truncated = catalogTruncated || allProducts.length > products.length;
    const totals = allProducts.reduce((accumulator, product) => ({
      productCount: accumulator.productCount + 1,
      quantityMilli: accumulator.quantityMilli + product.stock_milli,
      lowStockCount: accumulator.lowStockCount + (
        product.reorder_point_milli != null && product.stock_milli <= product.reorder_point_milli ? 1 : 0
      ),
      outOfStockCount: accumulator.outOfStockCount + (product.stock_milli <= 0 ? 1 : 0),
      estimatedValuePaisa: accumulator.estimatedValuePaisa + Math.round(
        Math.max(product.stock_milli, 0) * (product.cost_price_paisa || 0) / 1000,
      ),
    }), {
      productCount: 0, quantityMilli: 0, lowStockCount: 0, outOfStockCount: 0, estimatedValuePaisa: 0,
    });

    let movementQuery = rawClient
      .from("stock_movements")
      .select("id,branch_id,product_id,movement_type,quantity_delta_milli,unit_cost_paisa,reference_type,reference_id,occurred_at,created_by,notes")
      .in("branch_id", selectedBranchIds)
      .is("deleted_at", null)
      .order("occurred_at", { ascending: false })
      .limit(MOVEMENT_LIMIT);
    if (productId) movementQuery = movementQuery.eq("product_id", productId);

    const movementResult = await movementQuery;
    if (movementResult.error) throw new Error(movementResult.error.message);
    const movementRows = (movementResult.data || []) as StockMovementRow[];

    const missingProductIds = [...new Set(movementRows.map((row) => row.product_id))].filter((id) => !productInfo.has(id));
    for (const ids of chunk(missingProductIds, 500)) {
      const result = await authentication.client
        .from("products")
        .select("id,name,sku,barcode,category_id,unit_code,is_active")
        .in("id", ids)
        .is("deleted_at", null);
      for (const product of result.data || []) {
        if (productInfo.has(product.id)) continue;
        productInfo.set(product.id, {
          id: product.id,
          name: product.name,
          sku: product.sku,
          barcode: product.barcode,
          category_id: product.category_id,
          category_name: null,
          image_path: null,
          unit_code: product.unit_code,
          price_paisa: 0,
          on_sale: false,
          discounted_price_paisa: null,
          is_active: product.is_active,
          stock_milli: stockByProduct.get(product.id) || 0,
          total_count: 0,
        });
      }
    }

    const referenceIds = [...new Set(movementRows
      .filter((row) => row.reference_type === "pos_sale" && row.reference_id)
      .map((row) => String(row.reference_id)))];
    const receipts = new Map<string, string>();
    for (const ids of chunk(referenceIds, ID_CHUNK)) {
      const result = await authentication.client
        .from("pos_sales")
        .select("id,receipt_number")
        .in("id", ids)
        .is("deleted_at", null);
      for (const sale of result.data || []) receipts.set(sale.id, sale.receipt_number);
    }

    const staffIds = [...new Set(movementRows.map((row) => row.created_by).filter(Boolean))] as string[];
    const staffNames = new Map<string, string>();
    for (const ids of chunk(staffIds, ID_CHUNK)) {
      const result = await authentication.client
        .from("staff_profiles")
        .select("id,full_name")
        .in("id", ids)
        .is("deleted_at", null)
        .limit(1_000);
      for (const member of result.data || []) {
        if (member.id) staffNames.set(member.id, member.full_name);
      }
    }

    // The desktop builds a running balance from the append-only ledger. The cloud
    // page walks the newest page backwards starting at the catalog's current
    // branch balance, so every row shown carries an exact balance-after value.
    const runningBalance = new Map<string, number>();
    const movements = movementRows.map((row) => {
      const key = `${row.branch_id}:${row.product_id}`;
      let balance = runningBalance.get(key);
      if (balance === undefined) balance = stockByBranchProduct.get(key) ?? Number.NaN;
      const balanceAfter = Number.isFinite(balance) ? balance : null;
      if (Number.isFinite(balance)) runningBalance.set(key, balance - asNumber(row.quantity_delta_milli));
      const product = productInfo.get(row.product_id);
      const label = row.reference_type?.startsWith("inventory_")
        ? row.reference_type.slice("inventory_".length)
        : row.reference_type === "supplier_return"
          ? "supplier return"
          : row.movement_type;
      return {
        ...row,
        branch_name: branchNames.get(row.branch_id) || "Branch unavailable",
        product_name: product?.name || "Product unavailable",
        unit_code: product?.unit_code || "",
        balance_milli: balanceAfter,
        label,
        receipt_number: row.reference_id ? receipts.get(row.reference_id) || null : null,
        created_by_name: row.created_by ? staffNames.get(row.created_by) || "Staff unavailable" : null,
      };
    });

    let stocktakes: Array<Record<string, unknown>> = [];
    if (canViewStocktakes) {
      const stocktakeResult = await rawClient
        .from("inventory_stocktakes")
        .select("id,branch_id,notes,created_at,created_by")
        .in("branch_id", selectedBranchIds)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(STOCKTAKE_LIMIT);
      if (stocktakeResult.error) throw new Error(stocktakeResult.error.message);

      const headers = (stocktakeResult.data || []) as Array<{
        id: string; branch_id: string; notes: string | null; created_at: string; created_by: string | null;
      }>;
      const stocktakeIds = headers.map((row) => row.id);
      const itemAggregates = new Map<string, { itemCount: number; changedCount: number; totalVarianceMilli: number }>();
      for (const ids of chunk(stocktakeIds, ID_CHUNK)) {
        const itemsResult = await rawClient
          .from("inventory_stocktake_items")
          .select("stocktake_id,variance_milli")
          .in("stocktake_id", ids)
          .is("deleted_at", null);
        if (itemsResult.error) throw new Error(itemsResult.error.message);
        for (const item of (itemsResult.data || []) as Array<{ stocktake_id: string; variance_milli: number }>) {
          const bucket = itemAggregates.get(item.stocktake_id) || { itemCount: 0, changedCount: 0, totalVarianceMilli: 0 };
          bucket.itemCount += 1;
          bucket.changedCount += asNumber(item.variance_milli) !== 0 ? 1 : 0;
          bucket.totalVarianceMilli += asNumber(item.variance_milli);
          itemAggregates.set(item.stocktake_id, bucket);
        }
      }

      const stocktakeStaffIds = [...new Set(headers.map((row) => row.created_by).filter(Boolean))] as string[];
      for (const ids of chunk(stocktakeStaffIds, ID_CHUNK)) {
        const result = await authentication.client
          .from("staff_profiles")
          .select("id,full_name")
          .in("id", ids)
          .is("deleted_at", null)
          .limit(1_000);
        for (const member of result.data || []) {
          if (member.id) staffNames.set(member.id, member.full_name);
        }
      }

      stocktakes = headers.map((header) => {
        const aggregate = itemAggregates.get(header.id) || { itemCount: 0, changedCount: 0, totalVarianceMilli: 0 };
        return {
          ...header,
          branch_name: branchNames.get(header.branch_id) || "Branch unavailable",
          created_by_name: header.created_by ? staffNames.get(header.created_by) || "Staff unavailable" : null,
          item_count: aggregate.itemCount,
          changed_count: aggregate.changedCount,
          total_variance_milli: aggregate.totalVarianceMilli,
        };
      });
    }

    return authenticationResponse(request, authentication, {
      branchId: selectedBranchIds.length === 1 ? selectedBranchIds[0] : null,
      branchName,
      branches: identity.branches.map((branch) => ({ id: branch.id, name: branch.name, code: branch.code })),
      products,
      totals: {
        ...totals,
        productsShown: products.length,
        truncated,
        valuationComplete: !truncated,
      },
      movements,
      movementLimit: MOVEMENT_LIMIT,
      stocktakes,
      canViewStocktakes,
      canRecordMovements,
      canRecordStocktakes,
      readOnly: !canRecordMovements && !canRecordStocktakes,
      note: canRecordMovements || canRecordStocktakes
        ? "On-hand stock is calculated from the append-only movement ledger. Web changes are recorded atomically and included in stock history."
        : "Your account can review inventory but cannot record stock movements or stocktakes.",
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load branch inventory.",
    }, 500);
  }
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const action = body.action;
    if (action !== "movement" && action !== "stocktake") {
      throw new WriteError("Choose a supported inventory action.");
    }
    const branchId = readText(body.branchId, "Target branch", 64);
    if (!isUuid(branchId)) throw new WriteError("Choose a valid target branch.");
    const idempotencyKey = readText(body.idempotencyKey, "Request key", 100);
    let payload: Json;

    if (action === "movement") {
      const productId = readText(body.productId, "Product", 64);
      if (!isUuid(productId)) throw new WriteError("Choose a valid product.");
      const quantityDeltaMilli = readInteger(body.quantityDeltaMilli, "Quantity change");
      if (quantityDeltaMilli === 0) throw new WriteError("Quantity change must be greater than zero.");
      const movementType = readText(body.movementType, "Movement reason", 20);
      if (!["opening", "adjustment", "damage", "loss", "expiry"].includes(movementType)) {
        throw new WriteError("Choose a supported stock movement reason.");
      }
      payload = {
        branchId,
        productId,
        quantityDeltaMilli,
        movementType,
        reason: readText(body.reason, "Reason", 200),
        idempotencyKey,
      };
    } else {
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 1000) {
        throw new WriteError("A stocktake must include between 1 and 1,000 product counts.");
      }
      const items = body.items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new WriteError("Enter a valid product count for every stocktake item.");
        }
        const product = item as Record<string, unknown>;
        const productId = readText(product.productId, "Product", 64);
        if (!isUuid(productId)) throw new WriteError("Choose a valid product for every stocktake count.");
        return {
          productId,
          countedQuantityMilli: readInteger(product.countedQuantityMilli, "Counted quantity", { minimum: 0 }),
        };
      });
      payload = {
        branchId,
        items,
        notes: readOptionalText(body.notes, "Stocktake notes", 500),
        idempotencyKey,
      };
    }

    const { data, error } = await authentication.client.rpc("staff_record_inventory_action", {
      p_action: action,
      p_payload: payload,
    });
    if (error?.code === "P0001") throw new WriteError(error.message);
    if (error) throw error;
    return authenticationResponse(request, authentication, { result: data });
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
