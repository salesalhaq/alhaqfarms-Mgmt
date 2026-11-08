import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import { cashierCanViewReturn, cashierReturnVisibilityFilter, isHqAdmin } from "@/lib/server/staff-workflow-scope";

export const dynamic = "force-dynamic";

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function pakistanDateBoundary(value: string, nextDay = false): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+05:00`).toISOString();
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const parameters = new URL(request.url).searchParams;
  const detailId = parameters.get("detailId") || "";
  const requestedBranch = parameters.get("branchId") || "";
  const role = authentication.identity.staff.role;
  const allowedBranches = authentication.identity.branches.map((branch) => branch.id);

  if (detailId) {
    if (!isUuid(detailId)) {
      return authenticationResponse(request, authentication, { error: "Choose a valid return." }, 400);
    }

    const { data: returnRecord, error: returnError } = await authentication.client
      .from("returns")
      .select("id,return_number,branch_id,sale_id,shift_id,status,reason,notes,refund_total_paisa,restock_total_milli,created_by,approved_by,approved_at,rejected_by,rejected_at,rejection_reason,completed_by,completed_at,created_at")
      .eq("id", detailId)
      .is("deleted_at", null)
      .maybeSingle();
    if (returnError) throw new Error(returnError.message);
    if (!returnRecord) {
      return authenticationResponse(request, authentication, { error: "Return not found for this branch." }, 404);
    }
    if (!allowedBranches.includes(returnRecord.branch_id)) {
      return authenticationResponse(request, authentication, { error: "You cannot access that store return." }, 403);
    }
    if (role === "cashier"
      && (!authentication.identity.staff.local_staff_id
        || !cashierCanViewReturn(returnRecord, authentication.identity.staff.local_staff_id))) {
      return authenticationResponse(request, authentication, { error: "Return not found for this branch." }, 404);
    }

    const [saleResult, itemsResult, refundsResult] = await Promise.all([
      authentication.client
        .from("pos_sales")
        .select("id,receipt_number,customer_name,total_paisa")
        .eq("id", returnRecord.sale_id)
        .is("deleted_at", null)
        .maybeSingle(),
      authentication.client
        .from("return_items")
        .select("id,product_name,unit_code,quantity_milli,unit_price_paisa,line_refund_paisa,condition,restock")
        .eq("return_id", detailId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true }),
      authentication.client
        .from("return_refunds")
        .select("id,method,amount_paisa,credited_paisa,status,reference,processed_at")
        .eq("return_id", detailId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true }),
    ]);
    if (saleResult.error || itemsResult.error || refundsResult.error) {
      throw new Error(saleResult.error?.message || itemsResult.error?.message || refundsResult.error?.message);
    }
    if (!saleResult.data) throw new Error("The linked sale receipt could not be loaded.");

    const { data: actorRows, error: actorError } = await authentication.client
      .rpc("get_return_actor_names", { p_return_id: detailId });
    if (actorError) throw new Error(actorError.message);
    const staffNames = new Map((actorRows || []).map((actor) => [actor.actor_id, actor.full_name]));

    return authenticationResponse(request, authentication, {
      ...returnRecord,
      receipt_number: saleResult.data.receipt_number,
      customer_name: saleResult.data.customer_name,
      sale_total_paisa: saleResult.data.total_paisa,
      branch_name: authentication.identity.branches.find((branch) => branch.id === returnRecord.branch_id)?.name || "Branch",
      created_by_name: staffNames.get(returnRecord.created_by) || "Staff member",
      approved_by_name: returnRecord.approved_by ? staffNames.get(returnRecord.approved_by) || "Staff member" : null,
      rejected_by_name: returnRecord.rejected_by ? staffNames.get(returnRecord.rejected_by) || "Staff member" : null,
      completed_by_name: returnRecord.completed_by ? staffNames.get(returnRecord.completed_by) || "Staff member" : null,
      items: itemsResult.data || [],
      refunds: (refundsResult.data || []).map((refund) => ({
        ...refund,
        paid_out_paisa: refund.amount_paisa - refund.credited_paisa,
      })),
    });
  }

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  const hqAdmin = isHqAdmin(authentication.identity.staff);
  const branchId = hqAdmin
    ? requestedBranch && requestedBranch !== "all" ? requestedBranch : null
    : authentication.identity.staff.branch_id;

  if (requestedBranch && requestedBranch !== "all" && branchId !== requestedBranch) {
    return authenticationResponse(request, authentication, { error: "You cannot access that store." }, 403);
  }

  if (branchId && !allowedBranches.includes(branchId)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that store." }, 403);
  }

  if (!branchId && !hqAdmin) {
    return authenticationResponse(request, authentication, { error: "Choose a store before viewing returns." }, 400);
  }

  const from = parameters.get("from") || "";
  const to = parameters.get("to") || "";
  if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to))) {
    return authenticationResponse(request, authentication, { error: "Choose valid calendar dates." }, 400);
  }
  if (from && to && from > to) {
    return authenticationResponse(request, authentication, { error: "The start date must be on or before the end date." }, 400);
  }

  const status = parameters.get("status") || "all";
  if (!["all", "pending", "approved", "rejected", "completed", "cancelled"].includes(status)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid return status." }, 400);
  }

  const pageValue = parameters.get("page") || "1";
  const pageSizeValue = parameters.get("pageSize") || "25";
  const page = Number(pageValue);
  const pageSize = Number(pageSizeValue);
  if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(page) || page > 1_000_000
    || !/^[1-9]\d*$/.test(pageSizeValue) || !Number.isSafeInteger(pageSize) || pageSize > 100) {
    return authenticationResponse(request, authentication, { error: "Choose a valid page." }, 400);
  }

  const search = (parameters.get("search") || "").trim().slice(0, 80);
  const offset = (page - 1) * pageSize;

  let query = authentication.client
    .from("returns")
    .select("id,return_number,branch_id,sale_id,status,reason,refund_total_paisa,restock_total_milli,created_by,created_at,completed_at", { count: "exact" })
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (branchId) query = query.eq("branch_id", branchId);
  if (role === "cashier") {
    const staffId = authentication.identity.staff.local_staff_id;
    if (!staffId) {
      return authenticationResponse(request, authentication, { error: "This account is not linked to a staff profile." }, 403);
    }
    query = query.or(cashierReturnVisibilityFilter(staffId));
  }
  if (status !== "all") query = query.eq("status", status);
  if (from) query = query.gte("created_at", pakistanDateBoundary(from));
  if (to) query = query.lt("created_at", pakistanDateBoundary(to, true));

  const { data, count, error } = await query.range(0, 499);
  if (error) throw new Error(error.message);

  const returnRows = data || [];
  const saleIds = [...new Set(returnRows.map((returnRecord) => returnRecord.sale_id))];
  let saleDetails = new Map<string, { receipt_number: string; customer_name: string }>();
  if (saleIds.length) {
    const { data: sales, error: salesError } = await authentication.client
      .from("pos_sales")
      .select("id,receipt_number,customer_name")
      .in("id", saleIds)
      .is("deleted_at", null);
    if (salesError) throw new Error(salesError.message);
    saleDetails = new Map((sales || []).map((sale) => [sale.id, {
      receipt_number: sale.receipt_number,
      customer_name: sale.customer_name,
    }]));
  }

  const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
  let filteredRows = returnRows.map((returnRecord) => {
    const sale = saleDetails.get(returnRecord.sale_id);
    return {
      ...returnRecord,
      branch_name: branchNames.get(returnRecord.branch_id) || "Branch",
      receipt_number: sale?.receipt_number || "—",
      customer_name: sale?.customer_name || "Walk-in customer",
    };
  });

  if (search) {
    const normalized = search.toLowerCase();
    filteredRows = filteredRows.filter((row) => {
      const haystack = [row.return_number, row.receipt_number, row.customer_name, row.reason].join(" ").toLowerCase();
      return haystack.includes(normalized);
    });
  }

  const total = filteredRows.length;
  const capped = Boolean(count && count >= 500) || (returnRows.length >= 500);
  const rows = filteredRows.slice(offset, offset + pageSize);

  return authenticationResponse(request, authentication, {
    rows,
    total,
    capped,
  });
}
