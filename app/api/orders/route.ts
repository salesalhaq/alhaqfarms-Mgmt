import { NextResponse } from "next/server";
import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const PAYMENT_FILTERS = new Set(["all", "awaiting_review", "verified", "rejected"]);
const ORDER_COLUMNS = [
  "id", "order_number", "branch_id", "status", "customer_name", "customer_phone",
  "payment_method", "payment_status", "payment_review_status", "total_paisa", "created_at",
].join(",");

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (!authentication.identity.canViewOrders) {
    return authenticationResponse(request, authentication, { error: "Your role does not have access to online orders." }, 403);
  }

  const parameters = new URL(request.url).searchParams;
  const requestedPaymentFilter = parameters.get("paymentFilter") || "all";
  if (!PAYMENT_FILTERS.has(requestedPaymentFilter)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid payment filter." }, 400);
  }
  const requestedBranch = parameters.get("branchId") || "";
  if (requestedBranch && !authentication.identity.staff.branch_id && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  try {
    let query = authentication.client
      .from("web_orders")
      .select(ORDER_COLUMNS)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(100);

    if (authentication.identity.staff.branch_id) {
      query = query.eq("branch_id", authentication.identity.staff.branch_id);
    } else if (requestedBranch) {
      query = query.eq("branch_id", requestedBranch);
    }

    if (requestedPaymentFilter !== "all") {
      query = query.eq("payment_review_status", requestedPaymentFilter);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return authenticationResponse(request, authentication, { orders: data || [] });
  } catch {
    return authenticationResponse(
      request,
      authentication,
      { error: "Online orders could not be loaded. Please try again." },
      503,
    );
  }
}
