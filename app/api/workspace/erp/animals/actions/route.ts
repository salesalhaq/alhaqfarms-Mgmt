import { authenticateStaff, authenticationResponse, isSameOriginRequest, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

type AnimalActionBody = Record<string, unknown> & { action?: string };

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Animal management is restricted to administrators." }, 403);
  }

  const branchId = new URL(request.url).searchParams.get("branchId") || "";
  if (branchId && (!isUuid(branchId) || !authentication.identity.branches.some((branch) => branch.id === branchId))) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  const { data: species, error: speciesError } = await authentication.client
    .from("animal_species")
    .select("id,name,is_active,sort_order")
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (speciesError) {
    console.error("Could not load animal species.", speciesError);
    return authenticationResponse(request, authentication, { error: speciesError.message }, 500);
  }

  if (!branchId) {
    return authenticationResponse(request, authentication, { species: species || [], products: [] });
  }

  const balances = new Map<string, number>();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data: movements, error: movementsError } = await authentication.client
      .from("stock_movements")
      .select("product_id,quantity_delta_milli")
      .eq("branch_id", branchId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (movementsError) {
      console.error("Could not load branch stock for animal feed.", movementsError);
      return authenticationResponse(request, authentication, { error: movementsError.message }, 500);
    }
    for (const movement of movements || []) {
      balances.set(
        movement.product_id,
        (balances.get(movement.product_id) || 0) + Number(movement.quantity_delta_milli || 0),
      );
    }
    if ((movements || []).length < pageSize) break;
  }

  const products: Array<{ id: string; name: string; unit_code: string; cost_price_paisa: number }> = [];
  const inStockProductIds = [...balances]
    .filter(([, balance]) => balance > 0)
    .map(([productId]) => productId);
  for (let offset = 0; offset < inStockProductIds.length; offset += 500) {
    const { data, error } = await authentication.client
      .from("products")
      .select("id,name,unit_code,cost_price_paisa")
      .in("id", inStockProductIds.slice(offset, offset + 500))
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .order("id", { ascending: true });
    if (error) {
      console.error("Could not load animal feed products.", error);
      return authenticationResponse(request, authentication, { error: error.message }, 500);
    }
    products.push(...(data || []));
  }

  return authenticationResponse(request, authentication, {
    species: species || [],
    products: products
      .map((product) => ({
        ...product,
        stock_milli: balances.get(product.id) || 0,
      }))
      .filter((product) => product.stock_milli > 0),
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
    return authenticationResponse(request, authentication, { error: "Animal management is restricted to administrators." }, 403);
  }

  let body: AnimalActionBody;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as AnimalActionBody;
  } catch {
    return authenticationResponse(request, authentication, { error: "Send a valid animal action." }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!new Set(["save-batch", "save-species", "deactivate-species", "record-event", "close-batch"]).has(action)) {
    return authenticationResponse(request, authentication, { error: "Choose a supported animal action." }, 400);
  }
  if (action === "save-batch" && typeof body.branchId === "string"
    && !authentication.identity.branches.some((branch) => branch.id === body.branchId)) {
    return authenticationResponse(request, authentication, { error: "You cannot manage animals at that branch." }, 403);
  }
  if ((action === "record-event" || action === "close-batch")
    && (typeof body.batchId !== "string" || !isUuid(body.batchId))) {
    return authenticationResponse(request, authentication, { error: "Choose a valid animal batch." }, 400);
  }

  const actionClient = authentication.client as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<{
      data: unknown;
      error: { code?: string; message: string } | null;
    }>;
  };
  const { data, error } = await actionClient.rpc("manage_web_animal", {
    p_action: action,
    p_payload: body,
  });
  if (error) {
    if (error.code === "PGRST202" || /could not find the function|schema cache/i.test(error.message)) {
      return authenticationResponse(request, authentication, {
        error: "Animal web actions are not installed yet. Apply supabase/migrations/035_farm_erp_animals_actions.sql and retry.",
      }, 503);
    }
    const status = error.code === "P0001" ? 400 : 500;
    if (status === 500) console.error("Could not save an animal action.", error);
    return authenticationResponse(request, authentication, { error: error.message }, status);
  }
  return authenticationResponse(request, authentication, { result: data });
}
