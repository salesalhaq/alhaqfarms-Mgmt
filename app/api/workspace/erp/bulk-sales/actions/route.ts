import { authenticateStaff, authenticationResponse, isSameOriginRequest, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 1000;

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Bulk sales management is restricted to administrators." }, 403);
  }
  const branchId = new URL(request.url).searchParams.get("branchId") || "";
  if (!isUuid(branchId) || !authentication.identity.branches.some((branch) => branch.id === branchId)) {
    return authenticationResponse(request, authentication, { error: "Choose a branch you can access." }, 400);
  }

  const products: Array<Record<string, unknown> & { id: string }> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await authentication.client
      .from("products")
      .select("id,name,unit_code,price_paisa,cost_price_paisa")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Could not load bulk sale products.", error);
      return authenticationResponse(request, authentication, { error: error.message }, 500);
    }
    products.push(...(data || []) as Array<Record<string, unknown> & { id: string }>);
    if ((data || []).length < PAGE_SIZE) break;
  }

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
      console.error("Could not load bulk sale branch stock.", error);
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
  return authenticationResponse(request, authentication, {
    products: products.map((product) => ({
      ...product,
      stock_milli: balances.get(product.id) || 0,
    })),
  });
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
    return authenticationResponse(request, authentication, { error: "Bulk sales management is restricted to administrators." }, 403);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return authenticationResponse(request, authentication, { error: "Send a valid bulk sale action." }, 400);
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "record" && action !== "payment") {
    return authenticationResponse(request, authentication, { error: "Choose a supported bulk sale action." }, 400);
  }
  if (action === "record" && (typeof body.branchId !== "string" || !isUuid(body.branchId)
    || !authentication.identity.branches.some((branch) => branch.id === body.branchId))) {
    return authenticationResponse(request, authentication, { error: "You cannot manage bulk sales at that branch." }, 403);
  }
  if (action === "payment" && (typeof body.saleId !== "string" || !isUuid(body.saleId))) {
    return authenticationResponse(request, authentication, { error: "Choose a valid bulk invoice." }, 400);
  }

  const actionClient = authentication.client as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<{
      data: unknown;
      error: { code?: string; message: string } | null;
    }>;
  };
  const { data, error } = await actionClient.rpc("manage_web_bulk_sale", {
    p_action: action,
    p_payload: body,
  });
  if (error) {
    if (error.code === "PGRST202" || /could not find the function|schema cache/i.test(error.message)) {
      return authenticationResponse(request, authentication, {
        error: "Bulk sales web actions are not installed yet. Apply supabase/migrations/038_farm_erp_bulk_sales_actions.sql and retry.",
      }, 503);
    }
    const status = error.code === "P0001" ? 400 : 500;
    if (status === 500) console.error("Could not save a bulk sale action.", error);
    return authenticationResponse(request, authentication, { error: error.message }, status);
  }
  return authenticationResponse(request, authentication, { result: data });
}
