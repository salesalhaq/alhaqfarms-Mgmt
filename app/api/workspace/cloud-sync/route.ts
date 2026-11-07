import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const DEVICE_LIMIT = 300;
const EVENT_LIMIT = 100;

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
  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
  let selectedBranchIds: string[];
  if (role === "admin") {
    if (requestedBranch && requestedBranch !== "all") {
      if (!branchNames.has(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }
      selectedBranchIds = [requestedBranch];
    } else {
      selectedBranchIds = authentication.identity.branches.map((branch) => branch.id);
    }
  } else {
    const branchId = authentication.identity.staff.branch_id;
    if (!branchId) {
      return authenticationResponse(request, authentication, { error: "This account is not assigned to a branch." }, 403);
    }
    selectedBranchIds = [branchId];
  }

  const branchName = selectedBranchIds.length === 1
    ? branchNames.get(selectedBranchIds[0]) || "Your branch"
    : "All accessible branches";

  if (!selectedBranchIds.length) {
    return authenticationResponse(request, authentication, {
      branchId: null,
      branchName: "No accessible branch",
      rows: [],
      events: [],
      summary: { devices: 0, approved: 0, pending: 0, revoked: 0, online: 0, lastSeenAt: null },
      generatedAt: new Date().toISOString(),
    });
  }

  try {
    const devicesResult = await authentication.client
      .from("devices")
      .select("id,branch_id,name,platform,status,last_seen_at,created_at")
      .in("branch_id", selectedBranchIds)
      .is("deleted_at", null)
      .order("last_seen_at", { ascending: false })
      .limit(DEVICE_LIMIT);
    if (devicesResult.error) throw new Error(devicesResult.error.message);

    const devices = (devicesResult.data || []) as Array<{
      id: string;
      branch_id: string | null;
      name: string;
      platform: string | null;
      status: string;
      last_seen_at: string | null;
      created_at: string;
    }>;

    let events: Array<{
      id: string;
      occurred_at: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      branch_id: string | null;
      details_json: unknown;
    }> = [];

    try {
      const since = new Date();
      since.setDate(since.getDate() - 7);
      const eventsResult = await authentication.client
        .from("audit_log")
        .select("id,occurred_at,action,entity_type,entity_id,branch_id,details_json")
        .in("branch_id", selectedBranchIds)
        .is("deleted_at", null)
        .gte("occurred_at", since.toISOString())
        .or("action.ilike.%sync%,action.ilike.%device%,entity_type.eq.device")
        .order("occurred_at", { ascending: false })
        .limit(EVENT_LIMIT);
      if (!eventsResult.error) {
        events = (eventsResult.data || []) as typeof events;
      }
    } catch {
      events = [];
    }

    const rows = devices.map((device) => ({
      ...device,
      branch_name: device.branch_id ? branchNames.get(device.branch_id) || "Branch unavailable" : "Unassigned",
      online: Boolean(device.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() <= 15 * 60 * 1000),
    }));

    const seen = rows
      .map((device) => device.last_seen_at)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left));

    return authenticationResponse(request, authentication, {
      branchId: selectedBranchIds.length === 1 ? selectedBranchIds[0] : null,
      branchName,
      rows,
      events: events.map((event) => ({
        ...event,
        branch_name: event.branch_id ? branchNames.get(event.branch_id) || "Branch unavailable" : "Unassigned",
        details:
          event.details_json && typeof event.details_json === "object"
            ? Object.entries(event.details_json as Record<string, unknown>)
                .slice(0, 4)
                .map(([key, value]) => `${key}: ${String(value).slice(0, 80)}`)
                .join(" · ")
            : "",
      })),
      summary: {
        devices: rows.length,
        approved: rows.filter((device) => device.status === "approved").length,
        pending: rows.filter((device) => device.status === "pending").length,
        revoked: rows.filter((device) => device.status === "revoked").length,
        online: rows.filter((device) => device.online).length,
        lastSeenAt: seen[0] || null,
        eventCount: events.length,
      },
      readOnly: true,
      note: "This page shows cloud-side device registration and recent synchronization events. The desktop sync outbox, retries, and connection credentials stay on each Windows terminal.",
      generatedAt: new Date().toISOString(),
      totalDevices: asNumber(rows.length),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load cloud synchronization status.",
    }, 500);
  }
}
