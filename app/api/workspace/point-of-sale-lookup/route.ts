import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import { parseWeightBarcode } from "@/lib/scale/weight-barcode";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

interface ProductRow {
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
  image_path: string | null;
}

function quotedFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function branchStock(
  client: SupabaseClient,
  productId: string,
  branchId: string,
): Promise<number> {
  const { data, error } = await client
    .from("stock_movements")
    .select("quantity_delta_milli")
    .eq("product_id", productId)
    .eq("branch_id", branchId)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  return (data || []).reduce((total, row) => total + Number(row.quantity_delta_milli || 0), 0);
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const parameters = new URL(request.url).searchParams;
  const branchId = parameters.get("branchId") || authentication.identity.staff.branch_id || "";
  const code = (parameters.get("code") || "").trim().slice(0, 100);
  if (!branchId || !isUuid(branchId)) {
    return authenticationResponse(request, authentication, { error: "Choose a branch before scanning." }, 400);
  }
  if (!authentication.identity.branches.some((branch) => branch.id === branchId)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }
  if (!code) {
    return authenticationResponse(request, authentication, { error: "Scan or enter a product code." }, 400);
  }

  const client = authentication.client as unknown as SupabaseClient;

  try {
    const { data: categories, error: categoryError } = await authentication.client
      .from("categories")
      .select("id,name")
      .is("deleted_at", null)
      .limit(500);
    if (categoryError) throw new Error(categoryError.message);
    const categoryNames = new Map((categories || []).map((category) => [category.id, category.name]));

    const hydrate = async (product: ProductRow) => ({
      ...product,
      price_paisa: Number(product.price_paisa || 0),
      discounted_price_paisa: product.discounted_price_paisa == null ? null : Number(product.discounted_price_paisa),
      category_name: (product.category_id && categoryNames.get(product.category_id)) || null,
      stock_milli: await branchStock(client, product.id, branchId),
    });

    const weight = parseWeightBarcode(code);
    if (weight) {
      const { data: matches, error } = await client
        .from("products")
        .select("id,name,sku,barcode,category_id,unit_code,price_paisa,on_sale,discounted_price_paisa,is_active,image_path")
        .filter("metadata_json->>weightBarcodeCode", "eq", String(weight.productCode))
        .eq("is_active", true)
        .is("deleted_at", null)
        .limit(5);
      if (error) throw new Error(error.message);
      if (!matches || matches.length === 0) {
        return authenticationResponse(request, authentication, {
          error: `No product is assigned weight-barcode code ${weight.productCode}. Reprint its labels in Barcode labels to assign one.`,
        }, 404);
      }
      if (matches.length > 1) {
        const names = matches.map((product) => product.name).join(", ");
        return authenticationResponse(request, authentication, {
          error: `Weight-barcode code ${weight.productCode} is duplicated between ${names}. Reprint each affected product's labels in Barcode labels.`,
        }, 409);
      }
      const product = matches[0] as ProductRow;
      if (!["kg", "ltr"].includes(String(product.unit_code || "").toLowerCase())) {
        return authenticationResponse(request, authentication, {
          error: "That weight barcode belongs to a product that is not sold by weight or volume.",
        }, 400);
      }
      const hydrated = await hydrate(product);
      return authenticationResponse(request, authentication, {
        kind: "weight",
        quantityMilli: weight.quantityMilli,
        product: hydrated,
      });
    }

    const quoted = quotedFilterValue(code);
    const { data: matches, error } = await client
      .from("products")
      .select("id,name,sku,barcode,category_id,unit_code,price_paisa,on_sale,discounted_price_paisa,is_active,image_path")
      .or(`sku.eq.${quoted},barcode.eq.${quoted}`)
      .eq("is_active", true)
      .is("deleted_at", null)
      .limit(5);
    if (error) throw new Error(error.message);
    if (!matches || matches.length === 0) {
      return authenticationResponse(request, authentication, {
        error: `No active product found for SKU/barcode "${code}".`,
      }, 404);
    }
    if (matches.length > 1) {
      return authenticationResponse(request, authentication, {
        error: `This code matches multiple products. Resolve the duplicate SKU/barcode in the catalog.`,
      }, 409);
    }
    const product = matches[0] as ProductRow;
    const hydrated = await hydrate(product);
    return authenticationResponse(request, authentication, {
      kind: "product",
      product: hydrated,
    });
  } catch (error) {
    console.error("Could not resolve a POS scan.", error);
    return authenticationResponse(request, authentication, {
      error: "The scanned code could not be resolved. Please try again.",
    }, 503);
  }
}
