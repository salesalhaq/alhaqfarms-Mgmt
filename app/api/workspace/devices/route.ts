import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const DEVICE_LIMIT = 500;
const VALID_STATUS = new Set(["pending", "approved", "revoked"]);

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const role = authentication.identity.staff.role;
  if (role !== "admin") {
    return authenticationResponse(
      request,
      authentication,
      { error: "Devices are available to administrators only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  const status = (parameters.get("status") || "").toLowerCase();
  const search = (parameters.get("search") || "").trim().toLowerCase();

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }
  if (status && status !== "all" && !VALID_STATUS.has(status)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid device status." }, 400);
  }

  const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
  if (requestedBranch && requestedBranch !== "all" && !branchNames.has(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  try {
    let query = authentication.client
      .from("devices")
      .select("id,branch_id,name,fingerprint,platform,status,notes,registered_by,approved_by,approved_at,last_seen_at,created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(DEVICE_LIMIT);

    if (requestedBranch && requestedBranch !== "all") query = query.eq("branch_id", requestedBranch);
    if (status && status !== "all") query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const devices = (data || []) as Array<{
      id: string;
      branch_id: string | null;
      name: string;
      fingerprint: string;
      platform: string | null;
      status: string;
      notes: string | null;
      registered_by: string | null;
      approved_by: string | null;
      approved_at: string | null;
      last_seen_at: string | null;
      created_at: string;
    }>;

    const staffIds = [...new Set(devices.flatMap((device) => [device.registered_by, device.approved_by]).filter(Boolean))] as string[];
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

    const rows = devices
      .map((device) => ({
        ...device,
        branch_name: device.branch_id ? branchNames.get(device.branch_id) || "Branch unavailable" : "Unassigned",
        registered_by_name: device.registered_by ? staffNames.get(device.registered_by) || "Staff unavailable" : "—",
        approved_by_name: device.approved_by ? staffNames.get(device.approved_by) || "Staff unavailable" : "—",
      }))
      .filter((device) => {
        if (!search) return true;
        return [device.name, device.fingerprint, device.platform || "", device.branch_name, device.status]
          .some((value) => value.toLowerCase().includes(search));
      });

    return authenticationResponse(request, authentication, {
      rows,
      branches: authentication.identity.branches.map((branch) => ({
        id: branch.id,
        name: branch.name,
        code: branch.code,
      })),
      summary: {
        total: rows.length,
        approved: rows.filter((device) => device.status === "approved").length,
        pending: rows.filter((device) => device.status === "pending").length,
        revoked: rows.filter((device) => device.status === "revoked").length,
        recentlySeen: rows.filter((device) => {
          if (!device.last_seen_at) return false;
          return Date.now() - new Date(device.last_seen_at).getTime() <= 15 * 60 * 1000;
        }).length,
      },
      readOnly: true,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load registered devices.",
    }, 500);
  }
}
