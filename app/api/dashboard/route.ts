import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  if (requestedBranch && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }
  if (requestedBranch && !authentication.identity.branches.some((branch) => branch.id === requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  const dayStart = parameters.get("dayStart");
  const dayEnd = parameters.get("dayEnd");
  let dayStartDate: Date | null = null;
  let dayEndDate: Date | null = null;
  if (dayStart || dayEnd) {
    if (!dayStart || !dayEnd) {
      return authenticationResponse(request, authentication, { error: "Choose a complete local-day range." }, 400);
    }
    dayStartDate = new Date(dayStart);
    dayEndDate = new Date(dayEnd);
    const duration = dayEndDate.getTime() - dayStartDate.getTime();
    if (
      !Number.isFinite(dayStartDate.getTime())
      || !Number.isFinite(dayEndDate.getTime())
      || dayStartDate.toISOString() !== dayStart
      || dayEndDate.toISOString() !== dayEnd
      || duration < 22 * 60 * 60 * 1000
      || duration > 26 * 60 * 60 * 1000
    ) {
      return authenticationResponse(request, authentication, { error: "Choose a valid local-day range." }, 400);
    }
  }

  try {
    if (dayStartDate && dayEndDate) {
      const { data, error } = await authentication.client.rpc("get_staff_overview_metrics", {
        p_branch_id: authentication.identity.staff.branch_id || requestedBranch || null,
        p_day_start: dayStartDate.toISOString(),
        p_day_end: dayEndDate.toISOString(),
      });
      if (error) throw new Error(error.message);
      const metrics = data[0];
      if (!metrics) throw new Error("Overview metrics were not returned.");
      return authenticationResponse(request, authentication, {
        overview: {
          productCount: metrics.product_count,
          stockCount: metrics.stock_count,
          todaySales: { count: metrics.today_sales_count, total: metrics.today_sales_total_paisa },
          openShift: metrics.open_shift,
        },
      });
    }

    let salesQuery = authentication.client
      .from("pos_sales")
      .select("id,receipt_number,status,total_paisa,completed_at")
      .neq("status", "void")
      .is("deleted_at", null)
      .order("completed_at", { ascending: false })
      .limit(100);
    let returnsQuery = authentication.client
      .from("returns")
      .select("id,return_number,status,refund_total_paisa,created_at,completed_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(100);
    let ordersQuery = authentication.client
      .from("web_orders")
      .select("id,order_number,status,payment_status,payment_review_status,total_paisa,created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(100);

    if (authentication.identity.staff.branch_id) {
      salesQuery = salesQuery.eq("branch_id", authentication.identity.staff.branch_id);
      returnsQuery = returnsQuery.eq("branch_id", authentication.identity.staff.branch_id);
      ordersQuery = ordersQuery.eq("branch_id", authentication.identity.staff.branch_id);
    } else if (requestedBranch) {
      salesQuery = salesQuery.eq("branch_id", requestedBranch);
      returnsQuery = returnsQuery.eq("branch_id", requestedBranch);
      ordersQuery = ordersQuery.eq("branch_id", requestedBranch);
    }

    const [salesResult, returnsResult, ordersResult] = await Promise.all([
      salesQuery,
      returnsQuery,
      authentication.identity.canViewOrders ? ordersQuery : Promise.resolve({ data: [], error: null }),
    ]);
    if (salesResult.error || returnsResult.error || ordersResult.error) {
      throw new Error(salesResult.error?.message || returnsResult.error?.message || ordersResult.error?.message);
    }

    return authenticationResponse(request, authentication, {
      sales: salesResult.data || [],
      returns: returnsResult.data || [],
      orders: ordersResult.data || [],
    });
  } catch (error) {
    console.error("Could not load management dashboard data.", error);
    return authenticationResponse(
      request,
      authentication,
      { error: "Dashboard data could not be loaded. Please try again." },
      503,
    );
  }
}
