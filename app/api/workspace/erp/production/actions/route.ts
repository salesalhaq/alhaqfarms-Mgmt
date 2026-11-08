import { authenticateStaff, authenticationResponse, isSameOriginRequest, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Production management is restricted to administrators." }, 403);
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
    console.error("Could not load production categories.", categoriesError);
    return authenticationResponse(request, authentication, { error: categoriesError.message }, 500);
  }
  const categoryNames = new Map((categories || []).map((category: { id: string; name: string }) => [category.id, category.name]));

  const products: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await authentication.client
      .from("products")
      .select("id,name,category_id,unit_code,cost_price_paisa")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Could not load production products.", error);
      return authenticationResponse(request, authentication, { error: error.message }, 500);
    }
    products.push(...(data || []).map((product: Record<string, unknown>) => ({
      ...product,
      category_name: typeof product.category_id === "string" ? categoryNames.get(product.category_id) || "" : "",
    })));
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
      console.error("Could not load production branch stock.", error);
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

  const { data: batches, error: batchesError } = await authentication.client
    .from("animal_batches")
    .select("id,branch_id,name,batch_type,status,species,opening_heads,opening_cost_paisa")
    .eq("branch_id", branchId)
    .eq("status", "open")
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (batchesError) {
    console.error("Could not load production animal batches.", batchesError);
    return authenticationResponse(request, authentication, { error: batchesError.message }, 500);
  }

  const eventsByBatch = new Map<string, Array<{ event_type: string; heads_delta: number; amount_paisa: number }>>();
  const batchIds = (batches || []).map((batch: { id: string }) => batch.id);
  for (let batchOffset = 0; batchOffset < batchIds.length; batchOffset += 500) {
    const chunk = batchIds.slice(batchOffset, batchOffset + 500);
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await authentication.client
        .from("animal_batch_events")
        .select("batch_id,event_type,heads_delta,amount_paisa")
        .in("batch_id", chunk)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) {
        console.error("Could not load production animal batch events.", error);
        return authenticationResponse(request, authentication, { error: error.message }, 500);
      }
      const eventRows = (data || []) as Array<{
        batch_id: string;
        event_type: string;
        heads_delta: number;
        amount_paisa: number;
      }>;
      for (const event of eventRows) {
        const events = eventsByBatch.get(event.batch_id) || [];
        events.push(event);
        eventsByBatch.set(event.batch_id, events);
      }
      if (eventRows.length < PAGE_SIZE) break;
    }
  }

  const animalBatches = (batches || []).map((batch: Record<string, unknown> & { id: string }) => {
    const events = eventsByBatch.get(batch.id) || [];
    const headCount = Number(batch.opening_heads || 0)
      + events.reduce((total, event) => total + Number(event.heads_delta || 0), 0);
    const costPaisa = Math.max(0, Number(batch.opening_cost_paisa || 0) + events.reduce((total, event) => {
      if (event.event_type === "purchase" || event.event_type === "feed") return total + Number(event.amount_paisa || 0);
      if (event.event_type === "mortality" || event.event_type === "sale" || event.event_type === "production") {
        return total - Number(event.amount_paisa || 0);
      }
      return total;
    }, 0));
    return { ...batch, head_count: headCount, unallocated_cost_paisa: costPaisa };
  }).filter((batch: Record<string, unknown>) => Number(batch.head_count) > 0);

  return authenticationResponse(request, authentication, {
    products: products.map((product) => ({
      ...product,
      stock_milli: balances.get(String(product.id)) || 0,
    })),
    animalBatches,
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
    return authenticationResponse(request, authentication, { error: "Production management is restricted to administrators." }, 403);
  }

  let payload: unknown;
  try {
    payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
  } catch {
    return authenticationResponse(request, authentication, { error: "Send a valid production run." }, 400);
  }
  const branchId = (payload as Record<string, unknown>).branchId;
  if (typeof branchId !== "string" || !isUuid(branchId)
    || !authentication.identity.branches.some((branch) => branch.id === branchId)) {
    return authenticationResponse(request, authentication, { error: "You cannot manage production at that branch." }, 403);
  }

  const actionClient = authentication.client as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<{
      data: unknown;
      error: { code?: string; message: string } | null;
    }>;
  };
  const { data, error } = await actionClient.rpc("manage_web_production_run", { p_payload: payload });
  if (error) {
    if (error.code === "PGRST202" || /could not find the function|schema cache/i.test(error.message)) {
      return authenticationResponse(request, authentication, {
        error: "Production web actions are not installed yet. Apply supabase/migrations/036_farm_erp_production_actions.sql and retry.",
      }, 503);
    }
    const status = error.code === "P0001" ? 400 : 500;
    if (status === 500) console.error("Could not save a production run.", error);
    return authenticationResponse(request, authentication, { error: error.message }, status);
  }
  return authenticationResponse(request, authentication, { result: data });
}
