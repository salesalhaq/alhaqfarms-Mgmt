import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

type TransfersClient = { from(table: string): any };
type TransferStatus = "draft" | "dispatched" | "received" | "cancelled";

const PAGE_SIZE = 25;
const TRANSFER_STATUSES: TransferStatus[] = ["draft", "dispatched", "received", "cancelled"];

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

function schemaUnavailable(error: { code?: string }): boolean {
  return ["42P01", "42703", "PGRST200", "PGRST204", "PGRST205"].includes(error.code || "");
}

function transferError(error: { code?: string; message?: string }): string {
  if (schemaUnavailable(error)) {
    return "Transfers are not available in Supabase yet. Apply the stock transfer schema and RLS migrations, then reload the API schema cache.";
  }
  return error.message || "Transfer records could not be loaded.";
}

function branchName(branches: { id: string; name: string }[], id: string): string {
  return branches.find((branch) => branch.id === id)?.name || "Branch unavailable";
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  if (!["admin", "manager"].includes(authentication.identity.staff.role)) {
    return authenticationResponse(
      request,
      authentication,
      { error: "Transfers are available to managers and admins only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const client = authentication.client as unknown as TransfersClient;
  const branches = authentication.identity.branches;
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
  const isHqAdmin = authentication.identity.staff.role === "admin" && !authentication.identity.staff.branch_id;
  const detailId = parameters.get("detailId") || "";

  try {
    if (detailId) {
      if (!isUuid(detailId)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid transfer." }, 400);
      }

      const { data: transfer, error: transferErrorResult } = await client
        .from("stock_transfers")
        .select("id,transfer_number,from_branch_id,to_branch_id,status,notes,created_at,dispatched_at,received_at,cancelled_at")
        .eq("id", detailId)
        .is("deleted_at", null)
        .maybeSingle();
      if (transferErrorResult) throw transferErrorResult;
      if (!transfer || !branches.some((branch) => branch.id === transfer.from_branch_id || branch.id === transfer.to_branch_id)) {
        return authenticationResponse(request, authentication, { error: "This transfer is not available to your account." }, 404);
      }

      const { data: items, error: itemsError } = await client
        .from("stock_transfer_items")
        .select("id,product_name,unit_code,quantity_milli,received_quantity_milli,unit_cost_paisa")
        .eq("transfer_id", detailId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (itemsError) throw itemsError;

      return authenticationResponse(request, authentication, {
        transfer: {
          ...transfer,
          from_branch_name: branchName(branches, transfer.from_branch_id),
          to_branch_name: branchName(branches, transfer.to_branch_id),
        },
        items: items || [],
      });
    }

    const requestedBranch = parameters.get("branchId") || "";
    const branchId = requestedBranch || (isHqAdmin ? "all" : authentication.identity.staff.branch_id || "");
    if (branchId !== "all" && !isUuid(branchId)) {
      return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
    }
    if (branchId === "all" && !isHqAdmin) {
      return authenticationResponse(request, authentication, { error: "You cannot access all branches." }, 403);
    }
    if (branchId !== "all" && !branches.some((branch) => branch.id === branchId)) {
      return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
    }

    const status = parameters.get("status") || "all";
    if (status !== "all" && !TRANSFER_STATUSES.includes(status as TransferStatus)) {
      return authenticationResponse(request, authentication, { error: "Choose a valid transfer status." }, 400);
    }

    const direction = parameters.get("direction") || "all";
    if (!["all", "incoming", "outgoing"].includes(direction)) {
      return authenticationResponse(request, authentication, { error: "Choose a valid transfer direction." }, 400);
    }

    const from = parameters.get("from") || "";
    const to = parameters.get("to") || "";
    if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to)) || (from && to && from > to)) {
      return authenticationResponse(request, authentication, { error: "Choose a valid transfer date range." }, 400);
    }

    const search = (parameters.get("search") || "").trim().slice(0, 80).replace(/[\\%_]/g, "\\$&");
    const pageValue = parameters.get("page") || "1";
    const page = Number(pageValue);
    if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(page) || page > 1_000_000) {
      return authenticationResponse(request, authentication, { error: "Choose a valid page." }, 400);
    }

    const branchScope = branchId === "all" ? branches.map((branch) => branch.id) : [branchId];
    if (!branchScope.length) {
      return authenticationResponse(request, authentication, { rows: [], total: 0, page, pageSize: PAGE_SIZE });
    }

    let query = client
      .from("stock_transfers")
      .select("id,transfer_number,from_branch_id,to_branch_id,status,created_at", { count: "exact" })
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (branchId !== "all") {
      query = query.or(`from_branch_id.eq.${branchId},to_branch_id.eq.${branchId}`);
    }
    if (status !== "all") query = query.eq("status", status);
    if (direction === "incoming") query = query.in("to_branch_id", branchScope);
    if (direction === "outgoing") query = query.in("from_branch_id", branchScope);
    if (from) query = query.gte("created_at", pakistanDateBoundary(from));
    if (to) query = query.lt("created_at", pakistanDateBoundary(to, true));
    if (search) query = query.ilike("transfer_number", `%${search}%`);

    const offset = (page - 1) * PAGE_SIZE;
    const { data: transfers, count, error: transfersError } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (transfersError) throw transfersError;

    const transferIds = (transfers || []).map((transfer: { id: string }) => transfer.id);
    let itemRows: { transfer_id: string; quantity_milli: number | string }[] = [];
    if (transferIds.length) {
      const { data, error: itemsError } = await client
        .from("stock_transfer_items")
        .select("transfer_id,quantity_milli")
        .in("transfer_id", transferIds)
        .is("deleted_at", null);
      if (itemsError) throw itemsError;
      itemRows = data || [];
    }

    const summaries = new Map<string, { item_count: number; quantity_milli: number }>();
    for (const row of itemRows) {
      const summary = summaries.get(row.transfer_id) || { item_count: 0, quantity_milli: 0 };
      summary.item_count += 1;
      summary.quantity_milli += Number(row.quantity_milli) || 0;
      summaries.set(row.transfer_id, summary);
    }

    return authenticationResponse(request, authentication, {
      rows: (transfers || []).map((transfer: {
        id: string;
        transfer_number: string;
        from_branch_id: string;
        to_branch_id: string;
        status: TransferStatus;
        created_at: string;
      }) => {
        const summary = summaries.get(transfer.id) || { item_count: 0, quantity_milli: 0 };
        return {
          ...transfer,
          from_branch_name: branchNames.get(transfer.from_branch_id) || "Branch unavailable",
          to_branch_name: branchNames.get(transfer.to_branch_id) || "Branch unavailable",
          ...summary,
        };
      }),
      total: count || 0,
      page,
      pageSize: PAGE_SIZE,
    });
  } catch (error) {
    const message = transferError(error as { code?: string; message?: string });
    return authenticationResponse(
      request,
      authentication,
      { error: message },
      schemaUnavailable(error as { code?: string }) ? 503 : 500,
    );
  }
}
