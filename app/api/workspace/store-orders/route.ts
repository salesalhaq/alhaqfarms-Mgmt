import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import { cashierOrderVisibilityFilter } from "@/lib/server/staff-workflow-scope";
import type { Json } from "@/lib/supabase/database.types";
import {
  assertSameOrigin,
  readBoolean,
  readEnum,
  readJsonBody,
  readText,
  readUuid,
  writeFailure,
} from "@/lib/server/write";

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

const ORDER_ACTIONS = [
  "accept",
  "pack",
  "dispatch",
  "deliver",
  "verify_payment",
  "reject_payment",
  "cancel",
] as const;
const ORDER_STATUSES = ["pending", "accepted", "packed", "dispatched", "delivered", "cancelled"] as const;

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

function quotedFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
  if (requestedBranch && requestedBranch !== "all"
    && !authentication.identity.branches.some((branch) => branch.id === requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }
  if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to))) {
    return authenticationResponse(request, authentication, { error: "Choose valid calendar dates." }, 400);
  }
  if (requestedStatus !== "all" && !(ORDER_STATUSES as readonly string[]).includes(requestedStatus)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid order status filter." }, 400);
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
    let cashierFilter: string | null = null;

    if (authentication.identity.staff.branch_id) {
      query = query.eq("branch_id", authentication.identity.staff.branch_id);
    } else if (requestedBranch && requestedBranch !== "all") {
      query = query.eq("branch_id", requestedBranch);
    }
    if (authentication.identity.staff.role === "cashier") {
      const staffId = authentication.identity.staff.local_staff_id;
      if (!staffId) {
        return authenticationResponse(request, authentication, { error: "This account is not linked to a staff profile." }, 403);
      }
      cashierFilter = cashierOrderVisibilityFilter(staffId);
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

    let searchFilter: string | null = null;
    if (search) {
      const escaped = search.replace(/[\\%_]/g, "\\$&");
      const searchPattern = quotedFilterValue(`%${escaped}%`);
      searchFilter = `order_number.ilike.${searchPattern},customer_name.ilike.${searchPattern},customer_phone.ilike.${searchPattern}`;
    }
    if (cashierFilter && searchFilter) {
      query = query.or(`and(or(${cashierFilter}),or(${searchFilter}))`);
    } else if (cashierFilter) query = query.or(cashierFilter);
    else if (searchFilter) query = query.or(searchFilter);

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
      if (itemsResult.error) throw new Error(itemsResult.error.message);
      for (const item of (itemsResult.data || []) as unknown as Array<Record<string, unknown>>) {
        const key = String(item.order_id);
        const list = itemsByOrder.get(key) || [];
        list.push(item);
        itemsByOrder.set(key, list);
      }
    }
    return authenticationResponse(request, authentication, {
      orders: orders.map((order) => ({ ...order, items: itemsByOrder.get(String(order.id)) || [] })),
    });
  } catch (error) {
    console.error("Could not load online orders.", error);
    return authenticationResponse(
      request,
      authentication,
      { error: "Store orders could not be loaded. Please try again." },
      503,
    );
  }
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (!authentication.identity.canViewOrders) {
    return authenticationResponse(request, authentication, { error: "Your role does not have access to store orders." }, 403);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const action = readEnum(body.action, "Order action", ORDER_ACTIONS);
    const payload: Record<string, Json> = { id: readUuid(body.id, "Order") };
    if (action === "reject_payment") {
      payload.reason = readText(body.reason, "Rejection reason", 500);
    } else if (action === "deliver" && body.paymentReceived !== undefined) {
      payload.paymentReceived = readBoolean(body.paymentReceived, "Payment confirmation");
    } else if (action === "cancel") {
      payload.refundIssued = readBoolean(body.refundIssued, "Refund confirmation");
    }

    const { data, error } = await authentication.client.rpc("staff_manage_web_order", {
      p_action: action,
      p_payload: payload,
    });
    if (error) throw error;

    return authenticationResponse(request, authentication, { result: data });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P0001"
        && "message" in error && typeof error.message === "string") {
      const status = /cannot access|role cannot|sign in with an active staff|not linked to a staff profile/i.test(error.message)
        ? 403
        : 400;
      return authenticationResponse(request, authentication, { error: error.message }, status);
    }
    if (error && typeof error === "object" && "code" in error && error.code === "PGRST202") {
      return authenticationResponse(request, authentication, {
        error: "Online order actions are not configured in Supabase. Apply migration 019_online_order_workflow.sql.",
      }, 503);
    }
    return writeFailure(request, authentication, error);
  }
}
