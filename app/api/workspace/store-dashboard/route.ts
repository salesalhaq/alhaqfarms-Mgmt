import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1_000;
const SALE_LIMIT = 20_000;
const RETURN_LIMIT = 10_000;
const ORDER_LIMIT = 10_000;
const RECENT_LIMIT = 50;

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

  const hasBranchConstraint = !!requestedBranch && requestedBranch !== "all";
  const selectedBranch = hasBranchConstraint
    ? requestedBranch
    : authentication.identity.staff.branch_id || null;

  if (!selectedBranch && authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Choose a branch before using the store dashboard." }, 400);
  }

  const dateRange = {
    from: fromDate.toISOString(),
    to: isoEndOfDay(toDate),
  };

  try {
    const sales: Array<{ id: string; receipt_number: string; status: string; total_paisa: number; completed_at: string }> = [];
    for (let offset = 0; offset < SALE_LIMIT; offset += PAGE_SIZE) {
      let query = authentication.client
        .from("pos_sales")
        .select("id,receipt_number,status,total_paisa,completed_at,branch_id")
        .neq("status", "void")
        .is("deleted_at", null)
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

    const returns: Array<{ id: string; return_number: string; status: string; refund_total_paisa: number; created_at: string }> = [];
    for (let offset = 0; offset < RETURN_LIMIT; offset += PAGE_SIZE) {
      let query = authentication.client
        .from("returns")
        .select("id,return_number,status,refund_total_paisa,created_at,branch_id")
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

    const orders: Array<{
      id: string;
      order_number: string;
      status: string;
      payment_status: string;
      payment_review_status: string;
      total_paisa: number;
      created_at: string;
    }> = [];

    if (authentication.identity.canViewOrders) {
      for (let offset = 0; offset < ORDER_LIMIT; offset += PAGE_SIZE) {
        let query = authentication.client
          .from("web_orders")
          .select("id,order_number,status,payment_status,payment_review_status,total_paisa,created_at,branch_id")
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
    }

    const completedReturns = returns.filter((row) => row.status === "completed");
    const salesTotalPaisa = sales.reduce((total, row) => total + Number(row.total_paisa || 0), 0);

    const summary = {
      salesCount: sales.length,
      salesTotalPaisa,
      refundCount: completedReturns.length,
      refundTotalPaisa: completedReturns.reduce((total, row) => total + Number(row.refund_total_paisa || 0), 0),
      orderCount: orders.length,
      orderTotalPaisa: orders.reduce((total, row) => total + Number(row.total_paisa || 0), 0),
      averageTicketPaisa: sales.length ? Math.round(salesTotalPaisa / sales.length) : 0,
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
      returns: returns.slice(0, RECENT_LIMIT),
      orders: orders.slice(0, RECENT_LIMIT),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "The store dashboard could not be loaded.",
    }, 503);
  }
}
