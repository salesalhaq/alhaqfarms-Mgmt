import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";

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

  try {
    const { data, error } = await authentication.client
      .from("products")
      .select("id,name,is_active,metadata_json")
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .limit(PRODUCT_LIMIT);
    if (error) throw new Error(error.message);

    const grouped = new Map<string, {
      id: string;
      name: string;
      pct_code: string;
      description: string;
      product_count: number;
      active_count: number;
    }>();

    for (const product of (data || []) as Array<{ id: string; name: string; is_active: boolean; metadata_json: unknown }>) {
      const metadata = (product.metadata_json || {}) as ProductMetadata;
      const categoryId = readString(metadata.fbrPctCategoryId);
      const categoryName = readString(metadata.fbrPctCategoryName);
      const pctCode = readString(metadata.fbrPctCode);
      if (!categoryId && !categoryName && !pctCode) continue;

      const key = categoryId || pctCode || categoryName;
      const bucket = grouped.get(key) || {
        id: key,
        name: categoryName || pctCode || "Unnamed category",
        pct_code: pctCode || "—",
        description: readString(metadata.fbrPctDescription) || "Linked from product tax metadata.",
        product_count: 0,
        active_count: 0,
      };
      if (!bucket.name || bucket.name === "Unnamed category") bucket.name = categoryName || pctCode || bucket.name;
      if (bucket.pct_code === "—" && pctCode) bucket.pct_code = pctCode;
      bucket.product_count += 1;
      if (product.is_active) bucket.active_count += 1;
      grouped.set(key, bucket);
    }

    const rows = [...grouped.values()]
      .map((row) => ({
        ...row,
        status: row.active_count > 0 ? "active" : "inactive",
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
        unclassifiedProducts: (data || []).filter((product) => {
          const metadata = (product.metadata_json || {}) as ProductMetadata;
          return !readString(metadata.fbrPctCategoryId) && !readString(metadata.fbrPctCode) && !readString(metadata.fbrPctCategoryName);
        }).length,
      },
      readOnly: true,
      note: "FBR PCT categories are derived from the tax metadata stored on synchronized products. Creating or editing PCT categories remains a Windows desktop workflow.",
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load FBR PCT categories.",
    }, 500);
  }
}
