import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import { insertAuditEvent } from "@/lib/server/audit";
import type { Json } from "@/lib/supabase/database.types";
import {
  assertHqAdmin,
  assertSameOrigin,
  readBoolean,
  readEnum,
  readInteger,
  readJsonBody,
  readOptionalText,
  readOptionalUuid,
  readText,
  writeFailure,
  WriteError,
} from "@/lib/server/write";
import type { StaffAuthentication } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PRODUCT_BODY_BYTES = 3 * 1024 * 1024;
const UNIT_CODES = [
  "kg", "g", "lb", "each", "piece", "pack", "box", "bag",
  "ltr", "ml", "dozen", "head", "bird", "tray", "batch",
] as const;
const PRODUCT_COLUMNS = [
  "id", "category_id", "name", "sku", "barcode", "unit_code",
  "price_paisa", "on_sale", "discounted_price_paisa", "cost_price_paisa",
  "tax_rate_bps", "min_stock_milli", "reorder_point_milli", "max_stock_milli",
  "image_path", "is_active", "metadata_json",
].join(",");
type StaffClient = Extract<StaffAuthentication, { ok: true }>["client"];

function validateImage(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_IMAGE_BYTES * 1.4) {
    throw new WriteError("Product images must be 2 MB or smaller.");
  }
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new WriteError("Choose a PNG, JPEG, WebP or GIF product image.");
  const encoded = match[2];
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (Math.floor(encoded.length * 3 / 4) - padding > MAX_IMAGE_BYTES) {
    throw new WriteError("Product images must be 2 MB or smaller.");
  }
  return value;
}

function productSkuPrefix(name: string): string {
  return name.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 3)
    .toUpperCase() || "SKU";
}

function isRecord(value: Json): value is { [key: string]: Json | undefined } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function generateSku(
  client: StaffClient,
  name: string,
): Promise<string> {
  const prefix = productSkuPrefix(name);
  const { data, error } = await client
    .from("products")
    .select("sku")
    .like("sku", `${prefix}-%`)
    .is("deleted_at", null)
    .limit(10000);
  if (error) throw error;

  const pattern = new RegExp(`^${prefix}-(\\d{5})$`);
  const sequence = (data || []).reduce((maximum, row) => {
    const match = pattern.exec(row.sku || "");
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
  if (sequence > 99999) {
    throw new WriteError(`No more auto-generated SKUs are available for ${prefix}.`);
  }
  return `${prefix}-${String(sequence).padStart(5, "0")}`;
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    assertHqAdmin(authentication.identity);

    const body = await readJsonBody(request, MAX_PRODUCT_BODY_BYTES);
    if (body.action === "delete") {
      const productId = readOptionalUuid(body.id, "Product");
      if (!productId) throw new WriteError("Choose a product to delete.");
      const { data: product, error: productError } = await authentication.client
        .from("products")
        .select("id,name")
        .eq("id", productId)
        .is("deleted_at", null)
        .maybeSingle();
      if (productError) throw productError;
      if (!product) throw new WriteError("Product not found.", 404);
      const now = new Date().toISOString();
      const { data, error } = await authentication.client.from("products")
        .update({ deleted_at: now, updated_at: now })
        .eq("id", productId)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new WriteError("The product is already deleted.", 409);
      await insertAuditEvent(authentication.client, authentication.identity, {
        action: "product.deleted",
        entityType: "product",
        entityId: productId,
        details: { name: product.name },
      });
      return authenticationResponse(request, authentication, { success: true });
    }

    const id = readOptionalUuid(body.id, "Product");
    const name = readText(body.name, "Product name", 200);
    const categoryId = readOptionalUuid(body.categoryId, "Category");
    const sku = readOptionalText(body.sku, "SKU", 100);
    const barcode = readOptionalText(body.barcode, "Barcode", 100);
    const unitCode = readEnum(body.unitCode, "Unit", UNIT_CODES);
    const price = readInteger(body.pricePaisa, "Price", { minimum: 0 });
    const cost = body.costPricePaisa === undefined
      ? 0
      : readInteger(body.costPricePaisa, "Cost price", { minimum: 0 });
    const taxRate = body.taxRateBps === undefined
      ? 0
      : readInteger(body.taxRateBps, "Tax rate", { minimum: 0, maximum: 10000 });
    const pctSelection = readOptionalText(body.fbrPctCategoryId, "FBR PCT category", 200);
    const discountedPrice = body.discountedPricePaisa == null || body.discountedPricePaisa === ""
      ? null
      : readInteger(body.discountedPricePaisa, "Sale price", { minimum: 0 });
    if (discountedPrice != null && discountedPrice > price) {
      throw new WriteError("Sale price cannot exceed regular price.");
    }
    const minStock = body.minStockMilli === undefined
      ? 0
      : readInteger(body.minStockMilli, "Minimum stock", { minimum: 0 });
    const reorderPoint = body.reorderPointMilli === undefined
      ? 10000
      : readInteger(body.reorderPointMilli, "Reorder point", { minimum: 0 });
    const maxStock = body.maxStockMilli === undefined
      ? 1000000
      : readInteger(body.maxStockMilli, "Maximum stock", { minimum: 0 });
    const isActive = body.isActive === undefined ? true : readBoolean(body.isActive, "Active");
    const imagePath = body.imagePath === undefined ? undefined : validateImage(body.imagePath);
    const onSale = discountedPrice != null
      && (body.onSale === undefined || readBoolean(body.onSale, "On sale"));
    const now = new Date().toISOString();

    if (categoryId) {
      const { data: category, error } = await authentication.client
        .from("categories")
        .select("id")
        .eq("id", categoryId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      if (!category) throw new WriteError("Choose a valid product category.");
    }

    let existingMetadata: Json = {};
    let existingImage: string | null = null;
    if (id) {
      const { data: existing, error } = await authentication.client
        .from("products")
        .select("id,metadata_json,image_path")
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      if (!existing) throw new WriteError("Product not found.", 404);
      existingMetadata = existing.metadata_json || {};
      existingImage = existing.image_path;
    }

    const productId = id || crypto.randomUUID();
    const productSku = sku || await generateSku(authentication.client, name);
    let metadata = isRecord(existingMetadata) ? { ...existingMetadata } : {};
    for (const key of ["fbrPctCategoryId", "fbrPctCategoryName", "fbrPctCode", "fbrPctDescription"]) {
      delete metadata[key];
    }
    if (pctSelection) {
      const { data: pctCategory, error: pctError } = await authentication.client
        .from("fbr_pct_categories")
        .select("id,name,pct_code,description,is_active")
        .eq("id", pctSelection)
        .maybeSingle();
      if (pctError) throw pctError;
      if (pctCategory) {
        const existingCategoryId = isRecord(existingMetadata)
          ? existingMetadata.fbrPctCategoryId
          : undefined;
        if (!pctCategory.is_active && pctCategory.id !== existingCategoryId) {
          throw new WriteError("Choose an active FBR PCT category.");
        }
        metadata.fbrPctCategoryId = pctCategory.id;
        metadata.fbrPctCategoryName = pctCategory.name;
        metadata.fbrPctCode = pctCategory.pct_code;
        if (pctCategory.description) metadata.fbrPctDescription = pctCategory.description;
        else delete metadata.fbrPctDescription;
      } else {
        const { data: pctProducts, error: legacyError } = await authentication.client
          .from("products")
          .select("metadata_json")
          .is("deleted_at", null)
          .limit(2000);
        if (legacyError) throw legacyError;
        const matchingMetadata = (pctProducts || [])
          .map((product) => product.metadata_json)
          .filter(isRecord)
          .find((candidate) => {
            const key = [candidate.fbrPctCategoryId, candidate.fbrPctCode, candidate.fbrPctCategoryName]
              .find((value) => typeof value === "string" && value.trim());
            return key === pctSelection;
          });
        if (!matchingMetadata) {
          throw new WriteError("Choose an FBR PCT category from the available list.");
        }
        for (const key of ["fbrPctCategoryId", "fbrPctCategoryName", "fbrPctCode", "fbrPctDescription"]) {
          if (typeof matchingMetadata[key] === "string") metadata[key] = matchingMetadata[key];
        }
      }
    }

    const values = {
      category_id: categoryId,
      name,
      sku: productSku,
      barcode,
      unit_code: unitCode,
      price_paisa: price,
      on_sale: onSale,
      discounted_price_paisa: discountedPrice,
      cost_price_paisa: cost,
      tax_rate_bps: taxRate,
      min_stock_milli: minStock,
      reorder_point_milli: reorderPoint,
      max_stock_milli: maxStock,
      image_path: imagePath === undefined ? (id ? existingImage : null) : imagePath,
      is_active: isActive,
      metadata_json: metadata,
      updated_at: now,
    };

    const query = id
      ? authentication.client.from("products").update(values).eq("id", productId).is("deleted_at", null)
      : authentication.client.from("products").insert({ id: productId, ...values, created_at: now });
    const { data, error } = await query.select(PRODUCT_COLUMNS).maybeSingle();
    if (error) throw error;
    if (!data) throw new WriteError("The product could not be saved.", 409);

    await insertAuditEvent(authentication.client, authentication.identity, {
      action: id ? "product.updated" : "product.created",
      entityType: "product",
      entityId: productId,
      details: { name, sku: productSku },
    });
    return authenticationResponse(request, authentication, { product: data }, id ? 200 : 201);
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
