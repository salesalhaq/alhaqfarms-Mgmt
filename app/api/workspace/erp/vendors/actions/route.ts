import { authenticateStaff, authenticationResponse, isSameOriginRequest, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 1000;

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Vendor management is restricted to administrators." }, 403);
  }
  const receiptId = new URL(request.url).searchParams.get("receiptId") || "";
  if (!isUuid(receiptId)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid purchase receipt." }, 400);
  }
  const { data: receiptData, error: receiptError } = await authentication.client
    .from("purchase_receipts")
    .select("id,branch_id")
    .eq("id", receiptId)
    .is("deleted_at", null)
    .maybeSingle();
  if (receiptError) {
    console.error("Could not load vendor return receipt.", receiptError);
    return authenticationResponse(request, authentication, { error: receiptError.message }, 500);
  }
  const receipt = receiptData as { id: string; branch_id: string } | null;
  if (!receipt || !authentication.identity.branches.some((branch) => branch.id === receipt.branch_id)) {
    return authenticationResponse(request, authentication, { error: "Purchase receipt not found at your branch." }, 404);
  }

  const { data: items, error: itemsError } = await authentication.client
    .from("purchase_receipt_items")
    .select("id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa")
    .eq("receipt_id", receiptId)
    .is("deleted_at", null)
    .order("product_name", { ascending: true })
    .limit(200);
  if (itemsError) {
    console.error("Could not load vendor return items.", itemsError);
    return authenticationResponse(request, authentication, { error: itemsError.message }, 500);
  }
  const receiptItems = (items || []) as Array<{
    id: string;
    product_id: string;
    product_name: string;
    unit_code: string;
    quantity_milli: number;
    unit_cost_paisa: number;
  }>;
  const itemIds = receiptItems.map((item) => item.id);
  const productIds = [...new Set(receiptItems.map((item) => item.product_id))];
  const returned = new Map<string, number>();
  const credited = new Map<string, number>();
  if (itemIds.length) {
    const records: Array<{ receipt_item_id: string; quantity_milli: number; return_id: string }> = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await authentication.client
        .from("supplier_return_items")
        .select("receipt_item_id,quantity_milli,return_id")
        .in("receipt_item_id", itemIds)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) {
        console.error("Could not load vendor return history.", error);
        return authenticationResponse(request, authentication, { error: error.message }, 500);
      }
      const page = (data || []) as Array<{ receipt_item_id: string; quantity_milli: number; return_id: string }>;
      records.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    if (records.length) {
      const creditIds = new Set<string>();
      const returnIds = [...new Set(records.map((item) => item.return_id))];
      for (let offset = 0; offset < returnIds.length; offset += 500) {
        const { data, error } = await authentication.client
          .from("supplier_returns")
          .select("id,disposition")
          .in("id", returnIds.slice(offset, offset + 500))
          .is("deleted_at", null);
        if (error) {
          console.error("Could not load vendor return records.", error);
          return authenticationResponse(request, authentication, { error: error.message }, 500);
        }
        for (const record of (data || []) as Array<{ id: string; disposition: string }>) {
          if (record.disposition === "credit") creditIds.add(record.id);
        }
      }
      for (const item of records) {
        returned.set(item.receipt_item_id, (returned.get(item.receipt_item_id) || 0) + Number(item.quantity_milli || 0));
        if (creditIds.has(item.return_id)) {
          credited.set(item.receipt_item_id, (credited.get(item.receipt_item_id) || 0) + Number(item.quantity_milli || 0));
        }
      }
    }
  }

  const stock = new Map<string, number>();
  if (productIds.length) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data: movements, error: movementError } = await authentication.client
        .from("stock_movements")
        .select("product_id,quantity_delta_milli")
        .eq("branch_id", receipt.branch_id)
        .in("product_id", productIds)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (movementError) {
        console.error("Could not load vendor return stock.", movementError);
        return authenticationResponse(request, authentication, { error: movementError.message }, 500);
      }
      for (const movement of (movements || []) as Array<{ product_id: string; quantity_delta_milli: number }>) {
        stock.set(movement.product_id, (stock.get(movement.product_id) || 0) + Number(movement.quantity_delta_milli || 0));
      }
      if ((movements || []).length < PAGE_SIZE) break;
    }
  }

  return authenticationResponse(request, authentication, {
    items: receiptItems.map((item) => ({
      ...item,
      remaining_quantity_milli: Math.max(0, Number(item.quantity_milli || 0) - (returned.get(item.id) || 0)),
      returnable_quantity_milli: Math.max(0, Math.min(
        Number(item.quantity_milli || 0) - (returned.get(item.id) || 0),
        stock.get(item.product_id) || 0,
      )),
      creditable_quantity_milli: Math.max(0, Number(item.quantity_milli || 0)
        - (credited.get(item.id) || 0)),
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
    return authenticationResponse(request, authentication, { error: "Vendor management is restricted to administrators." }, 403);
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return authenticationResponse(request, authentication, { error: "Send a valid vendor action." }, 400);
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (!["save", "set-active", "payment", "return"].includes(action)) {
    return authenticationResponse(request, authentication, { error: "Choose a supported vendor action." }, 400);
  }
  const actionClient = authentication.client as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<{
      data: unknown;
      error: { code?: string; message: string } | null;
    }>;
  };
  const { data, error } = await actionClient.rpc("manage_web_vendor", {
    p_action: action,
    p_payload: body,
  });
  if (error) {
    if (error.code === "PGRST202" || /could not find the function|schema cache/i.test(error.message)) {
      return authenticationResponse(request, authentication, {
        error: "Vendor web actions are not installed yet. Apply supabase/migrations/039_farm_erp_vendor_actions.sql and retry.",
      }, 503);
    }
    const status = error.code === "P0001" ? 400 : 500;
    if (status === 500) console.error("Could not save a vendor action.", error);
    return authenticationResponse(request, authentication, { error: error.message }, status);
  }
  return authenticationResponse(request, authentication, { result: data });
}
