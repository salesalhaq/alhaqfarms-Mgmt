import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const RECENT_LIMIT = 20;

function schemaUnavailable(error: { code?: string }): boolean {
  return ["42P01", "42703", "PGRST200", "PGRST204", "PGRST205"].includes(error.code || "");
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const role = authentication.identity.staff.role;
  const client = authentication.client as unknown as { from(table: string): any; rpc(name: string): Promise<any> };
  const parameters = new URL(request.url).searchParams;
  const branches = authentication.identity.branches;
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
  const detailId = parameters.get("detailId") || "";
  const requestedBranch = parameters.get("branchId") || "";

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  let selectedBranchIds: string[];
  if (role === "admin") {
    if (requestedBranch && requestedBranch !== "all") {
      if (!branchNames.has(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }
      selectedBranchIds = [requestedBranch];
    } else {
      selectedBranchIds = branches.map((branch) => branch.id);
    }
  } else {
    const branchId = authentication.identity.staff.branch_id;
    if (!branchId) {
      return authenticationResponse(request, authentication, { error: "This account is not assigned to a branch." }, 403);
    }
    selectedBranchIds = [branchId];
  }
  const isManager = role === "manager";
  const permissionRows = role !== "admin"
    ? await client
      .from("branch_module_permissions")
      .select("branch_id,permission_key,is_allowed,updated_at,id")
      .in("branch_id", selectedBranchIds)
      .eq("role", role)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
    : { data: [], error: null };
  if (permissionRows.error) {
    return authenticationResponse(request, authentication, { error: permissionRows.error.message }, 500);
  }
  const transferPermissionMap = new Map<string, boolean>();
  for (const row of permissionRows.data || []) {
    const key = `${row.branch_id}:${row.permission_key}`;
    if (!transferPermissionMap.has(key)) transferPermissionMap.set(key, Boolean(row.is_allowed));
  }
  const effectiveTransferPermission = (branchId: string, key: string) =>
    transferPermissionMap.get(`${branchId}:${key}`) ?? true;
  const canView = role === "admin" || selectedBranchIds.some((branchId) =>
    effectiveTransferPermission(branchId, "module:receive_stock:view"));
  if (!canView) {
    return authenticationResponse(request, authentication, { error: "Receive Stock is not available to your account at this branch." }, 403);
  }
  const canReceive = role === "admin" || (role === "manager" && selectedBranchIds.some((branchId) =>
    effectiveTransferPermission(branchId, "module:receive_stock:view")
      && effectiveTransferPermission(branchId, "action:receive_transfer")));

  try {
    if (detailId) {
      if (!isUuid(detailId)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid transfer." }, 400);
      }
      const { data: transfer, error: transferError } = await client
        .from("stock_transfers")
        .select("id,transfer_number,from_branch_id,to_branch_id,status,notes,created_at,dispatched_at,received_at")
        .eq("id", detailId)
        .is("deleted_at", null)
        .maybeSingle();
      if (transferError) throw transferError;
      if (!transfer || !selectedBranchIds.includes(transfer.to_branch_id)) {
        return authenticationResponse(request, authentication, { error: "This incoming transfer is not available to your account." }, 404);
      }

      const { data: items, error: itemsError } = await client
        .from("stock_transfer_items")
        .select("id,product_name,unit_code,quantity_milli,received_quantity_milli,unit_cost_paisa")
        .eq("transfer_id", detailId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (itemsError) throw itemsError;
      const branchResult = await client.rpc("get_staff_transfer_branches");
      if (branchResult.error) throw branchResult.error;
      const allBranchNames = new Map((branchResult.data || []).map((branch: { id: string; name: string }) => [branch.id, branch.name]));

      return authenticationResponse(request, authentication, {
        transfer: {
          ...transfer,
          from_branch_name: allBranchNames.get(transfer.from_branch_id) || "Branch unavailable",
          to_branch_name: allBranchNames.get(transfer.to_branch_id) || "Branch unavailable",
        },
        items: items || [],
      });
    }

    if (!selectedBranchIds.length) {
      const branchResult = await client.rpc("get_staff_transfer_branches");
      if (branchResult.error) throw branchResult.error;
      return authenticationResponse(request, authentication, {
        incoming: [],
        received: [],
        branches: branchResult.data || [],
        summary: { arriving: 0, unitsInTransit: 0, receivedRecently: 0, canReceive },
        generatedAt: new Date().toISOString(),
      });
    }

    const [incomingResult, receivedResult] = await Promise.all([
      client
        .from("stock_transfers")
        .select("id,transfer_number,from_branch_id,to_branch_id,status,notes,dispatched_at,created_at")
        .in("to_branch_id", selectedBranchIds)
        .is("deleted_at", null)
        .eq("status", "dispatched")
        .order("dispatched_at", { ascending: true })
        .limit(100),
      client
        .from("stock_transfers")
        .select("id,transfer_number,from_branch_id,to_branch_id,status,notes,dispatched_at,received_at,created_at")
        .in("to_branch_id", selectedBranchIds)
        .is("deleted_at", null)
        .eq("status", "received")
        .order("received_at", { ascending: false })
        .limit(RECENT_LIMIT),
    ]);

    if (incomingResult.error) throw incomingResult.error;
    if (receivedResult.error) throw receivedResult.error;

    const incoming = (incomingResult.data || []) as Array<Record<string, string | null>>;
    const received = (receivedResult.data || []) as Array<Record<string, string | null>>;
    const transferIds = [...new Set([...incoming, ...received].map((row) => String(row.id)))];

    const summaries = new Map<string, { item_count: number; quantity_milli: number; received_quantity_milli: number }>();
    if (transferIds.length) {
      const { data: itemRows, error: itemsError } = await client
        .from("stock_transfer_items")
        .select("transfer_id,quantity_milli,received_quantity_milli")
        .in("transfer_id", transferIds)
        .is("deleted_at", null);
      if (itemsError) throw itemsError;
      for (const row of (itemRows || []) as Array<{
        transfer_id: string;
        quantity_milli: number;
        received_quantity_milli: number;
      }>) {
        const summary = summaries.get(row.transfer_id) || { item_count: 0, quantity_milli: 0, received_quantity_milli: 0 };
        summary.item_count += 1;
        summary.quantity_milli += Number(row.quantity_milli) || 0;
        summary.received_quantity_milli += Number(row.received_quantity_milli) || 0;
        summaries.set(row.transfer_id, summary);
      }
    }

    const branchResult = await client.rpc("get_staff_transfer_branches");
    if (branchResult.error) throw branchResult.error;
    const allBranchNames = new Map((branchResult.data || []).map((branch: { id: string; name: string }) => [branch.id, branch.name]));
    const decorate = (transfer: Record<string, string | null>) => {
      const summary = summaries.get(String(transfer.id)) || { item_count: 0, quantity_milli: 0, received_quantity_milli: 0 };
      return {
        ...transfer,
        from_branch_name: allBranchNames.get(String(transfer.from_branch_id)) || "Branch unavailable",
        to_branch_name: allBranchNames.get(String(transfer.to_branch_id)) || "Branch unavailable",
        ...summary,
      };
    };

    const incomingRows = incoming.map(decorate);
    const receivedRows = received.map(decorate);

    return authenticationResponse(request, authentication, {
      incoming: incomingRows,
      received: receivedRows,
      branches: branches.map((branch) => ({ id: branch.id, name: branch.name, code: branch.code })),
      summary: {
        arriving: incomingRows.length,
        unitsInTransit: incomingRows.reduce((total, row) => total + row.quantity_milli, 0),
        receivedRecently: receivedRows.length,
        branchId: selectedBranchIds.length === 1 ? selectedBranchIds[0] : null,
        branchName: selectedBranchIds.length === 1
          ? allBranchNames.get(selectedBranchIds[0]) || "Your branch"
          : "All accessible branches",
        canReceive,
      },
      readOnly: !canReceive,
      note: canReceive
        ? "Confirm received quantities here. Only the quantity confirmed as received is added to destination stock."
        : "You can view incoming transfers, but a manager must confirm receipt to post stock movements.",
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = schemaUnavailable(error as { code?: string })
      ? "Stock transfers are not available in Supabase yet. Apply the stock transfer schema and RLS migrations, then reload the API schema cache."
      : error instanceof Error
        ? error.message
        : "Could not load incoming transfers.";
    return authenticationResponse(request, authentication, { error: message }, schemaUnavailable(error as { code?: string }) ? 503 : 500);
  }
}
