import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import { insertAuditEvent } from "@/lib/server/audit";
import {
  assertSameOrigin,
  readBoolean,
  readJsonBody,
  readOptionalText,
  readText,
  writeFailure,
  WriteError,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

const PRODUCT_LIMIT = 2_000;

interface ProductMetadata {
  fbrPctCategoryId?: unknown;
  fbrPctCategoryName?: unknown;
  fbrPctCode?: unknown;
  fbrPctDescription?: unknown;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(
      request,
      authentication,
      { error: "FBR PCT categories are available to administrators only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const search = (parameters.get("search") || "").trim().toLowerCase();
  const status = (parameters.get("status") || "").toLowerCase();
  if (status && status !== "all" && status !== "active" && status !== "inactive") {
    return authenticationResponse(request, authentication, { error: "Choose a valid category status." }, 400);
  }

  try {
    const [categoriesResult, productsResult] = await Promise.all([
      authentication.client
        .from("fbr_pct_categories")
        .select("id,name,pct_code,description,is_active")
        .order("name", { ascending: true })
        .limit(500),
      authentication.client
        .from("products")
        .select("id,name,is_active,metadata_json")
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .limit(PRODUCT_LIMIT),
    ]);
    if (categoriesResult.error || productsResult.error) {
      throw new Error(categoriesResult.error?.message || productsResult.error?.message);
    }

    const categoryByName = new Map<string, string>();
    const categoryByCode = new Map<string, string>();
    for (const category of categoriesResult.data || []) {
      categoryByName.set(category.name.trim().toLowerCase(), category.id);
      if (category.pct_code) categoryByCode.set(category.pct_code, category.id);
    }

    const grouped = new Map<string, {
      id: string;
      name: string;
      pct_code: string;
      description: string;
      product_count: number;
      active_count: number;
      is_active: boolean;
    }>((categoriesResult.data || []).map((category) => [category.id, {
      id: category.id,
      name: category.name,
      pct_code: category.pct_code,
      description: category.description || "",
      product_count: 0,
      active_count: 0,
      is_active: category.is_active,
    }]));

    for (const product of (productsResult.data || []) as Array<{ id: string; name: string; is_active: boolean; metadata_json: unknown }>) {
      const metadata = (product.metadata_json || {}) as ProductMetadata;
      const categoryId = readString(metadata.fbrPctCategoryId);
      const categoryName = readString(metadata.fbrPctCategoryName);
      const pctCode = readString(metadata.fbrPctCode);
      if (!categoryId && !categoryName && !pctCode) continue;

      const key = categoryId || pctCode || categoryName;
      const categoryKey = grouped.has(key)
        ? key
        : categoryId && grouped.has(categoryId)
          ? categoryId
          : categoryByCode.get(pctCode) || categoryByName.get(categoryName.toLowerCase()) || key;
      const bucket = grouped.get(categoryKey) || {
        id: key,
        name: categoryName || pctCode || "Unnamed category",
        pct_code: pctCode || "—",
        description: readString(metadata.fbrPctDescription) || "Linked from product tax metadata.",
        product_count: 0,
        active_count: 0,
        is_active: true,
      };
      if (!bucket.name || bucket.name === "Unnamed category") bucket.name = categoryName || pctCode || bucket.name;
      if (bucket.pct_code === "—" && pctCode) bucket.pct_code = pctCode;
      bucket.product_count += 1;
      if (product.is_active) bucket.active_count += 1;
      grouped.set(bucket.id, bucket);
    }

    const rows = [...grouped.values()]
      .map((row) => ({
        ...row,
        status: row.is_active ? "active" : "inactive",
      }))
      .filter((row) => {
        if (status === "active" && row.status !== "active") return false;
        if (status === "inactive" && row.status !== "inactive") return false;
        if (!search) return true;
        return [row.name, row.pct_code, row.description].some((value) => value.toLowerCase().includes(search));
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    return authenticationResponse(request, authentication, {
      rows,
      summary: {
        categories: rows.length,
        linkedProducts: rows.reduce((total, row) => total + row.product_count, 0),
        activeCategories: rows.filter((row) => row.status === "active").length,
        unclassifiedProducts: (productsResult.data || []).filter((product) => {
          const metadata = (product.metadata_json || {}) as ProductMetadata;
          return !readString(metadata.fbrPctCategoryId) && !readString(metadata.fbrPctCode) && !readString(metadata.fbrPctCategoryName);
        }).length,
      },
      note: "PCT categories are managed here and linked to products through their saved tax metadata.",
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load FBR PCT categories.",
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
    if (authentication.identity.staff.role !== "admin") {
      throw new WriteError("FBR PCT category management is restricted to administrators.", 403);
    }

    const body = await readJsonBody(request);
    const id = readOptionalText(body.id, "PCT category", 200);
    const name = readText(body.name, "PCT category name", 120);
    const pctCode = readText(body.pctCode, "PCT code", 32);
    const description = readOptionalText(body.description, "Description", 1000);
    const isActive = body.isActive === undefined ? true : readBoolean(body.isActive, "Active");
    const now = new Date().toISOString();

    const { data: existingCategories, error: existingError } = await authentication.client
      .from("fbr_pct_categories")
      .select("id,name")
      .limit(500);
    if (existingError) throw existingError;
    if ((existingCategories || []).some((category) =>
      category.id !== id && category.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new WriteError("A PCT category with this name already exists.", 409);
    }

    const categoryId = id || crypto.randomUUID();
    const values = {
      id: categoryId,
      name,
      pct_code: pctCode,
      description,
      is_active: isActive,
      updated_at: now,
    };
    const { data: existing, error: lookupError } = await authentication.client
      .from("fbr_pct_categories")
      .select("id")
      .eq("id", categoryId)
      .maybeSingle();
    if (lookupError) throw lookupError;

    const query = existing
      ? authentication.client.from("fbr_pct_categories").update(values).eq("id", categoryId)
      : authentication.client.from("fbr_pct_categories").insert({ ...values, created_at: now });
    const { data, error } = await query
      .select("id,name,pct_code,description,is_active")
      .single();
    if (error?.code === "23505") throw new WriteError("A PCT category with this name already exists.", 409);
    if (error) throw error;

    await insertAuditEvent(authentication.client, authentication.identity, {
      action: existing ? "fbr.pct_category.updated" : "fbr.pct_category.created",
      entityType: "fbr_pct_category",
      entityId: categoryId,
      details: { name, pctCode, isActive },
    });

    return authenticationResponse(request, authentication, { category: data }, existing ? 200 : 201);
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
