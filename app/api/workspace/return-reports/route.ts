import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const RETURN_LIMIT = 500;

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

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const role = authentication.identity.staff.role;
  if (!["admin", "manager"].includes(role)) {
    return authenticationResponse(
      request,
      authentication,
      { error: "Return reports are available to managers and admins only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const from = parameters.get("from") || "";
  const to = parameters.get("to") || "";
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    return authenticationResponse(request, authentication, { error: "Choose a valid report date range." }, 400);
  }

  const requestedBranch = parameters.get("branchId") || "";
  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  const accessibleBranchIds = authentication.identity.branches.map((branch) => branch.id);
  let selectedBranchIds: string[];
  if (role === "admin") {
    if (requestedBranch && requestedBranch !== "all") {
      if (!accessibleBranchIds.includes(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }
      selectedBranchIds = [requestedBranch];
    } else {
      selectedBranchIds = accessibleBranchIds;
    }
  } else {
    const branchId = authentication.identity.staff.branch_id;
    if (!branchId) {
      return authenticationResponse(request, authentication, { error: "This account is not assigned to a branch." }, 403);
    }
    selectedBranchIds = [branchId];
  }

  const status = (parameters.get("status") || "").toLowerCase();
  const search = (parameters.get("search") || "").trim().toLowerCase();
  const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
  const branchName = selectedBranchIds.length === 1
    ? branchNames.get(selectedBranchIds[0]) || "Your branch"
    : "All accessible branches";

  const emptyPayload = {
    from,
    to,
    branchId: selectedBranchIds.length === 1 ? selectedBranchIds[0] : null,
    branchName,
    rows: [] as unknown[],
    reasons: [] as unknown[],
    totals: { returns: 0, pending: 0, completed: 0, refundPaisa: 0, restockMilli: 0 },
    capped: false,
    generatedAt: new Date().toISOString(),
  };

  if (!selectedBranchIds.length) {
    return authenticationResponse(request, authentication, emptyPayload);
  }

  const fromIso = pakistanDateBoundary(from);
  const toIso = pakistanDateBoundary(to, true);

  try {
    let query = authentication.client
      .from("returns")
      .select("id,return_number,branch_id,sale_id,status,reason,refund_total_paisa,restock_total_milli,created_by,created_at,completed_at")
      .in("branch_id", selectedBranchIds)
      .is("deleted_at", null)
      .gte("created_at", fromIso)
      .lt("created_at", toIso)
      .order("created_at", { ascending: false })
      .limit(RETURN_LIMIT);

    if (status && status !== "all") query = query.eq("status", status);

    const returnsResult = await query;
    if (returnsResult.error) throw new Error(returnsResult.error.message);

    const returns = (returnsResult.data || []) as Array<{
      id: string;
      return_number: string;
      branch_id: string;
      sale_id: string;
      status: string;
      reason: string | null;
      refund_total_paisa: number;
      restock_total_milli: number;
      created_by: string;
      created_at: string;
      completed_at: string | null;
    }>;

    const saleIds = [...new Set(returns.map((row) => row.sale_id).filter(Boolean))];
    const saleMap = new Map<string, { receipt_number: string; customer_name: string }>();
    for (let index = 0; index < saleIds.length; index += 200) {
      const ids = saleIds.slice(index, index + 200);
      const salesResult = await authentication.client
        .from("pos_sales")
        .select("id,receipt_number,customer_name")
        .in("id", ids)
        .is("deleted_at", null);
      if (salesResult.error) throw new Error(salesResult.error.message);
      for (const sale of (salesResult.data || []) as Array<{ id: string; receipt_number: string; customer_name: string }>) {
        saleMap.set(sale.id, { receipt_number: sale.receipt_number, customer_name: sale.customer_name });
      }
    }

    const staffIds = [...new Set(returns.map((row) => row.created_by).filter(Boolean))];
    const staffNames = new Map<string, string>();
    if (staffIds.length) {
      const staffResult = await authentication.client
        .from("staff_profiles")
        .select("id,full_name")
        .in("id", staffIds)
        .is("deleted_at", null)
        .limit(1_000);
      for (const member of (staffResult.data || []) as Array<{ id: string; full_name: string }>) {
        if (member.id) staffNames.set(member.id, member.full_name);
      }
    }

    const rows = returns
      .map((row) => {
        const sale = saleMap.get(row.sale_id);
        return {
          ...row,
          branch_name: branchNames.get(row.branch_id) || "Branch unavailable",
          receipt_number: sale?.receipt_number || "—",
          customer_name: sale?.customer_name || "Walk-in customer",
          created_by_name: staffNames.get(row.created_by) || "Staff unavailable",
        };
      })
      .filter((row) => {
        if (!search) return true;
        return [
          row.return_number,
          row.receipt_number,
          row.customer_name,
          row.reason || "",
          row.created_by_name,
          row.branch_name,
        ].some((value) => value.toLowerCase().includes(search));
      });

    const reasonBuckets = new Map<string, { reason: string; count: number; refundPaisa: number; restockMilli: number }>();
    for (const row of rows) {
      const reason = (row.reason || "No reason recorded").trim() || "No reason recorded";
      const bucket = reasonBuckets.get(reason) || { reason, count: 0, refundPaisa: 0, restockMilli: 0 };
      bucket.count += 1;
      bucket.refundPaisa += asNumber(row.refund_total_paisa);
      bucket.restockMilli += asNumber(row.restock_total_milli);
      reasonBuckets.set(reason, bucket);
    }

    const totals = rows.reduce((accumulator, row) => ({
      returns: accumulator.returns + 1,
      pending: accumulator.pending + (row.status === "pending" ? 1 : 0),
      completed: accumulator.completed + (row.status === "completed" ? 1 : 0),
      refundPaisa: accumulator.refundPaisa + asNumber(row.refund_total_paisa),
      restockMilli: accumulator.restockMilli + asNumber(row.restock_total_milli),
    }), { returns: 0, pending: 0, completed: 0, refundPaisa: 0, restockMilli: 0 });

    return authenticationResponse(request, authentication, {
      from,
      to,
      branchId: selectedBranchIds.length === 1 ? selectedBranchIds[0] : null,
      branchName,
      rows,
      reasons: [...reasonBuckets.values()].sort((left, right) => right.count - left.count).slice(0, 8),
      totals,
      capped: returns.length >= RETURN_LIMIT,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load the return report.",
    }, 500);
  }
}
