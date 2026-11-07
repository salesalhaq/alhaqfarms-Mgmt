import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const ORDER_SELECT = [
  "id",
  "order_number",
  "branch_id",
  "status",
  "fulfillment_type",
  "customer_name",
  "customer_phone",
  "delivery_address",
  "payment_method",
  "payment_status",
  "payment_review_status",
  "payment_reference",
  "payment_rejection_reason",
  "subtotal_paisa",
  "tax_paisa",
  "total_paisa",
  "notes",
  "packed_at",
  "dispatched_at",
  "delivered_at",
  "cancelled_at",
  "created_at",
].join(",");

const ORDER_ITEM_SELECT = [
  "id",
  "order_id",
  "line_number",
  "product_name",
  "sku",
  "unit_code",
  "quantity_milli",
  "unit_price_paisa",
  "tax_paisa",
  "line_total_paisa",
].join(",");

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateBoundary(value: string, endOfDay = false): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (!authentication.identity.canViewOrders) {
    return authenticationResponse(request, authentication, { error: "Your role does not have access to store orders." }, 403);
  }

  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  const requestedStatus = parameters.get("status") || "all";
  const search = (parameters.get("search") || "").trim();
  const from = parameters.get("from") || "";
  const to = parameters.get("to") || "";

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch filter." }, 400);
  }
  if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to))) {
    return authenticationResponse(request, authentication, { error: "Choose valid calendar dates." }, 400);
  }
  if (from && to && from > to) {
    return authenticationResponse(request, authentication, { error: "Start date must be on or before the end date." }, 400);
  }

  try {
    let query = authentication.client
      .from("web_orders")
      .select(ORDER_SELECT)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(100);

    if (authentication.identity.staff.branch_id) {
      query = query.eq("branch_id", authentication.identity.staff.branch_id);
    } else if (requestedBranch && requestedBranch !== "all") {
      query = query.eq("branch_id", requestedBranch);
    }

    if (requestedStatus !== "all") {
      query = query.eq("status", requestedStatus);
    }

    if (from) {
      query = query.gte("created_at", dateBoundary(from));
    }
    if (to) {
      query = query.lte("created_at", dateBoundary(to, true));
    }

    if (search) {
      const escaped = search.replace(/[\\%_]/g, "\\$&");
      const searchPattern = `%${escaped}%`;
      query = query.or(
        `order_number.ilike.${searchPattern},customer_name.ilike.${searchPattern},customer_phone.ilike.${searchPattern}`,
      );
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const orders = (data || []) as unknown as Array<Record<string, unknown>>;
    const orderIds = orders.map((order) => String(order.id));
    const itemsByOrder = new Map<string, Array<Record<string, unknown>>>();
    if (orderIds.length) {
      const itemsResult = await authentication.client
        .from("web_order_items")
        .select(ORDER_ITEM_SELECT)
        .in("order_id", orderIds)
        .is("deleted_at", null)
        .order("line_number", { ascending: true });
      if (!itemsResult.error) {
        for (const item of (itemsResult.data || []) as unknown as Array<Record<string, unknown>>) {
          const key = String(item.order_id);
          const list = itemsByOrder.get(key) || [];
          list.push(item);
          itemsByOrder.set(key, list);
        }
      }
    }
    return authenticationResponse(request, authentication, {
      orders: orders.map((order) => ({ ...order, items: itemsByOrder.get(String(order.id)) || [] })),
    });
  } catch {
    return authenticationResponse(
      request,
      authentication,
      { error: "Store orders could not be loaded. Please try again." },
      503,
    );
  }
}
