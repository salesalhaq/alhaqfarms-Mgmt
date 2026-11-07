import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1_000;
const SALE_LIMIT = 20_000;
const ORDER_LIMIT = 10_000;
const RETURN_LIMIT = 10_000;
const RECENT_LIMIT = 25;

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoEndOfDay(date: Date): string {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next.toISOString();
}

function buildCustomerName(value: string | null | undefined): string {
  const cleaned = (value || "").trim();
  return cleaned || "Walk-in customer";
}

function normalizeStatus(value: string | null | undefined): string {
  return (value || "").toLowerCase();
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  const fromValue = parameters.get("from") || "";
  const toValue = parameters.get("to") || "";

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  if (requestedBranch && requestedBranch !== "all" && !authentication.identity.branches.some((branch) => branch.id === requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  const fromDate = parseIsoDate(fromValue);
  const toDate = parseIsoDate(toValue);
  if (!fromDate || !toDate) {
    return authenticationResponse(request, authentication, { error: "Choose a valid date range." }, 400);
  }

  if (toDate.getTime() < fromDate.getTime()) {
    return authenticationResponse(request, authentication, { error: "The end date must be after the start date." }, 400);
  }

  const branchConstraint = requestedBranch && requestedBranch !== "all" ? requestedBranch : null;
  const selectedBranch = branchConstraint || authentication.identity.staff.branch_id || null;

  if (!selectedBranch && authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Choose a branch before using the admin dashboard." }, 400);
  }

  const dateRange = {
    from: fromDate.toISOString(),
    to: isoEndOfDay(toDate),
  };

  try {
    const sales: Array<{
      id: string;
      receipt_number: string;
      customer_name: string | null;
      customer_phone: string | null;
      status: string;
      total_paisa: number;
      completed_at: string;
      branch_id: string | null;
    }> = [];

    for (let offset = 0; offset < SALE_LIMIT; offset += PAGE_SIZE) {
      let query = authentication.client
        .from("pos_sales")
        .select("id,receipt_number,customer_name,customer_phone,status,total_paisa,completed_at,branch_id")
        .is("deleted_at", null)
        .neq("status", "void")
        .gte("completed_at", dateRange.from)
        .lte("completed_at", dateRange.to)
        .order("completed_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (selectedBranch) query = query.eq("branch_id", selectedBranch);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const page = (data || []) as typeof sales;
      sales.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const orders: Array<{
      id: string;
      order_number: string;
      customer_name: string | null;
      customer_phone: string | null;
      status: string;
      payment_status: string | null;
      payment_review_status: string | null;
      total_paisa: number;
      created_at: string;
      branch_id: string | null;
    }> = [];

    for (let offset = 0; offset < ORDER_LIMIT; offset += PAGE_SIZE) {
      let query = authentication.client
        .from("web_orders")
        .select("id,order_number,customer_name,customer_phone,status,payment_status,payment_review_status,total_paisa,created_at,branch_id")
        .is("deleted_at", null)
        .gte("created_at", dateRange.from)
        .lte("created_at", dateRange.to)
        .order("created_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (selectedBranch) query = query.eq("branch_id", selectedBranch);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const page = (data || []) as typeof orders;
      orders.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const returns: Array<{
      id: string;
      return_number: string;
      sale_id: string | null;
      status: string;
      refund_total_paisa: number;
      created_at: string;
      branch_id: string | null;
    }> = [];

    for (let offset = 0; offset < RETURN_LIMIT; offset += PAGE_SIZE) {
      let query = authentication.client
        .from("returns")
        .select("id,return_number,sale_id,status,refund_total_paisa,created_at,branch_id")
        .is("deleted_at", null)
        .gte("created_at", dateRange.from)
        .lte("created_at", dateRange.to)
        .order("created_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (selectedBranch) query = query.eq("branch_id", selectedBranch);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const page = (data || []) as typeof returns;
      returns.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const customerMap = new Map<string, {
      customer_name: string;
      customer_phone: string | null;
      last_seen: string;
      transaction_count: number;
      total_paisa: number;
    }>();

    for (const entry of [...sales, ...orders]) {
      const customerName = buildCustomerName(entry.customer_name || "");
      const key = customerName.toLowerCase();
      const timestamp = "completed_at" in entry ? entry.completed_at : entry.created_at;
      const amount = Number("total_paisa" in entry ? entry.total_paisa || 0 : 0);
      const existing = customerMap.get(key);
      const next = {
        customer_name: customerName,
        customer_phone: entry.customer_phone || null,
        last_seen: existing && new Date(existing.last_seen).getTime() > new Date(timestamp).getTime() ? existing.last_seen : timestamp,
        transaction_count: (existing?.transaction_count || 0) + 1,
        total_paisa: (existing?.total_paisa || 0) + amount,
      };
      customerMap.set(key, next);
    }

    const customerRows = [...customerMap.values()]
      .sort((left, right) => new Date(right.last_seen).getTime() - new Date(left.last_seen).getTime())
      .slice(0, 10);

    const pendingReviews = orders.filter((order) => {
      const value = normalizeStatus(order.payment_review_status || order.payment_status || "");
      return value !== "verified" && value !== "paid" && value !== "rejected" && value !== "cancelled";
    }).length;

    const openReturns = returns.filter((entry) => {
      const value = normalizeStatus(entry.status);
      return value !== "approved" && value !== "completed" && value !== "refunded" && value !== "closed";
    }).length;

    const completedReturns = returns.filter((entry) => normalizeStatus(entry.status) === "completed");

    const summary = {
      salesCount: sales.length,
      salesTotalPaisa: sales.reduce((total, row) => total + Number(row.total_paisa || 0), 0),
      customerCount: customerMap.size,
      orderCount: orders.length,
      orderTotalPaisa: orders.reduce((total, row) => total + Number(row.total_paisa || 0), 0),
      pendingReviewCount: pendingReviews,
      openReturnCount: openReturns,
      refundTotalPaisa: completedReturns.reduce((total, row) => total + Number(row.refund_total_paisa || 0), 0),
      completedReturnCount: completedReturns.length,
    };

    const branchName = selectedBranch
      ? authentication.identity.branches.find((branch) => branch.id === selectedBranch)?.name || "Selected branch"
      : "All accessible branches";

    return authenticationResponse(request, authentication, {
      branchId: selectedBranch,
      branchName,
      from: dateRange.from,
      to: dateRange.to,
      summary,
      sales: sales.slice(0, RECENT_LIMIT),
      customers: customerRows,
      orders: orders.slice(0, RECENT_LIMIT),
      returns: returns.slice(0, RECENT_LIMIT),
      readOnly: true,
      restrictionNote:
        "Read-only aggregation from live synchronized sales, returns, and storefront orders. "
        + "Sales totals exclude voided receipts and refunds count completed returns.",
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "The admin dashboard could not be loaded.",
    }, 503);
  }
}
