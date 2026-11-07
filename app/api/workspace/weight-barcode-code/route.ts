import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import { MAX_PRODUCT_CODE, MIN_PRODUCT_CODE } from "@/lib/scale/weight-barcode";

export const dynamic = "force-dynamic";

interface ProductMetadataRow {
  id: string;
  unit_code: string;
  metadata_json: unknown;
}

function readMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numericCode(value: unknown): number | null {
  const code = Number(value);
  return Number.isInteger(code) && code >= MIN_PRODUCT_CODE && code <= MAX_PRODUCT_CODE ? code : null;
}

function missingFunction(error: { message?: string; code?: string }): boolean {
  return error.code === "PGRST202"
    || /could not find the function|schema cache/i.test(error.message || "");
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  let body: { productId?: unknown };
  try {
    body = await request.json() as { productId?: unknown };
  } catch {
    return authenticationResponse(request, authentication, { error: "Send a JSON body with a productId." }, 400);
  }
  const productId = typeof body.productId === "string" ? body.productId : "";
  if (!isUuid(productId)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid product." }, 400);
  }

  try {
    const { data: product, error: productError } = await authentication.client
      .from("products")
      .select("id,unit_code,metadata_json")
      .eq("id", productId)
      .is("deleted_at", null)
      .maybeSingle();
    if (productError) throw new Error(productError.message);
    if (!product) {
      return authenticationResponse(request, authentication, { error: "Product not found." }, 404);
    }

    const row = product as ProductMetadataRow;
    if (!["kg", "ltr"].includes(String(row.unit_code || "").toLowerCase())) {
      return authenticationResponse(request, authentication, {
        error: "Weight barcodes can only be assigned to kg or ltr products.",
      }, 400);
    }

    const current = numericCode(readMetadata(row.metadata_json).weightBarcodeCode);

    const { data: assigned, error: rpcError } = await authentication.client
      .rpc("assign_product_weight_barcode_code", { p_product_id: productId });
    if (rpcError) {
      if (missingFunction(rpcError)) {
        return authenticationResponse(request, authentication, {
          error: "Weight-barcode assignment is not installed in the database yet. Apply supabase/migrations/008_print_scale_device_settings.sql and try again.",
        }, 503);
      }
      throw new Error(rpcError.message);
    }
    if (!Number.isInteger(assigned) || (assigned as number) < MIN_PRODUCT_CODE || (assigned as number) > MAX_PRODUCT_CODE) {
      throw new Error("The database did not return a valid weight-barcode code.");
    }

    return authenticationResponse(request, authentication, {
      numericCode: assigned as number,
      reassigned: current != null && current !== assigned,
      productId,
    });
  } catch (error) {
    console.error("Could not assign a weight-barcode code.", error);
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "The weight-barcode code could not be saved.",
    }, 503);
  }
}
