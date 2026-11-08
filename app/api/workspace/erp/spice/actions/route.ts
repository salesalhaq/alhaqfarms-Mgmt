import { authenticateStaff, authenticationResponse, isSameOriginRequest, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Spice management is restricted to administrators." }, 403);
  }

  const branchId = new URL(request.url).searchParams.get("branchId") || "";
  if (!isUuid(branchId) || !authentication.identity.branches.some((branch) => branch.id === branchId)) {
    return authenticationResponse(request, authentication, { error: "Choose a branch you can access." }, 400);
  }

  const { data: categories, error: categoriesError } = await authentication.client
    .from("categories")
    .select("id,name")
    .is("deleted_at", null);
  if (categoriesError) {
    console.error("Could not load spice product categories.", categoriesError);
    return authenticationResponse(request, authentication, { error: categoriesError.message }, 500);
  }
  const rawProducts: Array<Record<string, unknown> & { id: string }> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await authentication.client.from("products")
      .select("id,name,category_id,unit_code,cost_price_paisa")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Could not load spice products.", error);
      return authenticationResponse(request, authentication, { error: error.message }, 500);
    }
    rawProducts.push(...(data || []) as Array<Record<string, unknown> & { id: string }>);
    if ((data || []).length < PAGE_SIZE) break;
  }
  const categoryNames = new Map((categories || []).map((category: { id: string; name: string }) => [category.id, category.name]));
  const balances = new Map<string, number>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await authentication.client
      .from("stock_movements")
      .select("product_id,quantity_delta_milli")
      .eq("branch_id", branchId)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Could not load spice branch stock.", error);
      return authenticationResponse(request, authentication, { error: error.message }, 500);
    }
    for (const movement of data || []) {
      balances.set(
        movement.product_id,
        (balances.get(movement.product_id) || 0) + Number(movement.quantity_delta_milli || 0),
      );
    }
    if ((data || []).length < PAGE_SIZE) break;
  }

  const products = rawProducts.map((product) => ({
    ...product,
    category_name: typeof product.category_id === "string" ? categoryNames.get(product.category_id) || "" : "",
    stock_milli: balances.get(product.id) || 0,
  }));
  return authenticationResponse(request, authentication, { products });
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (!isSameOriginRequest(request)) {
    return authenticationResponse(request, authentication, { error: "This request must come from the signed-in workspace." }, 403);
  }
  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Spice management is restricted to administrators." }, 403);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return authenticationResponse(request, authentication, { error: "Send a valid spice batch action." }, 400);
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "open" && action !== "complete") {
    return authenticationResponse(request, authentication, { error: "Choose a supported spice batch action." }, 400);
  }
  if (action === "open" && (typeof body.branchId !== "string" || !isUuid(body.branchId)
    || !authentication.identity.branches.some((branch) => branch.id === body.branchId))) {
    return authenticationResponse(request, authentication, { error: "You cannot manage spice batches at that branch." }, 403);
  }
  if (action === "complete" && (typeof body.batchId !== "string" || !isUuid(body.batchId))) {
    return authenticationResponse(request, authentication, { error: "Choose a valid spice batch." }, 400);
  }

  const actionClient = authentication.client as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<{
      data: unknown;
      error: { code?: string; message: string } | null;
    }>;
  };
  const { data, error } = await actionClient.rpc("manage_web_spice_batch", {
    p_action: action,
    p_payload: body,
  });
  if (error) {
    if (error.code === "PGRST202" || /could not find the function|schema cache/i.test(error.message)) {
      return authenticationResponse(request, authentication, {
        error: "Spice web actions are not installed yet. Apply supabase/migrations/037_farm_erp_spice_actions.sql and retry.",
      }, 503);
    }
    const status = error.code === "P0001" ? 400 : 500;
    if (status === 500) console.error("Could not save a spice batch action.", error);
    return authenticationResponse(request, authentication, { error: error.message }, status);
  }
  return authenticationResponse(request, authentication, { result: data });
}
