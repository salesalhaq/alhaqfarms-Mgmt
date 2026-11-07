import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const EVENT_LIMIT = 500;

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

function compactDetails(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
    .slice(0, 4)
    .map(([key, entry]) => {
      const text = typeof entry === "object" ? JSON.stringify(entry) : String(entry);
      return `${key.replace(/[_-]+/g, " ")}: ${text}`;
    });
  return entries.join(" · ").slice(0, 220);
}

function schemaUnavailable(error: { code?: string }): boolean {
  return ["42P01", "42703", "PGRST200", "PGRST204", "PGRST205"].includes(error.code || "");
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
  const actionValue = (parameters.get("action") || "").trim();
  const actorValue = (parameters.get("actor") || "").trim().toLowerCase();

  const defaultTo = new Date();
  const defaultFrom = new Date(defaultTo);
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const toDay = isCalendarDate(toValue)
    ? toValue
    : new Date(defaultTo.getTime() - defaultTo.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const fromDay = isCalendarDate(fromValue)
    ? fromValue
    : new Date(defaultFrom.getTime() - defaultFrom.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

  if (fromDay > toDay) {
    return authenticationResponse(request, authentication, { error: "The end date must be after the start date." }, 400);
  }

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  const branches = authentication.identity.branches;
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
  if (requestedBranch && requestedBranch !== "all" && !branchNames.has(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot view that branch's audit trail." }, 403);
  }

  const role = authentication.identity.staff.role;
  let selectedBranchIds: string[];
  if (role === "admin") {
    selectedBranchIds = requestedBranch && requestedBranch !== "all"
      ? [requestedBranch]
      : branches.map((branch) => branch.id);
  } else {
    const branchId = authentication.identity.staff.branch_id;
    if (!branchId) {
      return authenticationResponse(request, authentication, { error: "This account is not assigned to a branch." }, 403);
    }
    selectedBranchIds = [branchId];
  }

  const fromIso = pakistanDateBoundary(fromDay);
  const toIso = pakistanDateBoundary(toDay, true);

  try {
    let query = authentication.client
      .from("audit_log")
      .select("id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at")
      .in("branch_id", selectedBranchIds)
      .is("deleted_at", null)
      .gte("occurred_at", fromIso)
      .lt("occurred_at", toIso)
      .order("occurred_at", { ascending: false })
      .limit(EVENT_LIMIT);

    if (actionValue && actionValue !== "all") query = query.eq("action", actionValue);

    const { data, error } = await query;
    if (error) throw error;

    const events = (data || []) as Array<{
      id: string;
      actor_id: string | null;
      branch_id: string | null;
      action: string;
      entity_type: string;
      entity_id: string | null;
      details_json: unknown;
      occurred_at: string;
    }>;

    const actorIds = [...new Set(events.map((event) => event.actor_id).filter(Boolean))] as string[];
    const actors = new Map<string, { name: string; role: string }>();
    if (actorIds.length) {
      const staffResult = await authentication.client
        .from("staff_profiles")
        .select("id,full_name,role")
        .in("id", actorIds)
        .is("deleted_at", null)
        .limit(1_000);
      for (const member of (staffResult.data || []) as Array<{ id: string; full_name: string; role: string }>) {
        if (member.id) actors.set(member.id, { name: member.full_name, role: member.role });
      }
    }

    const rows = events
      .map((event) => {
        const actor = event.actor_id ? actors.get(event.actor_id) : undefined;
        return {
          id: event.id,
          occurred_at: event.occurred_at,
          actor_name: actor?.name || "System",
          actor_role: actor?.role || "service",
          branch_id: event.branch_id || "",
          branch_name: event.branch_id ? branchNames.get(event.branch_id) || "Branch unavailable" : "Unassigned",
          action: event.action,
          record: event.entity_id ? `${event.entity_type} · ${event.entity_id}` : event.entity_type,
          summary: compactDetails(event.details_json),
          source: "desktop",
          actor_id: event.actor_id || "",
        };
      })
      .filter((row) => {
        if (!actorValue) return true;
        return `${row.actor_name} ${row.actor_role} ${row.actor_id}`.toLowerCase().includes(actorValue);
      });

    let actions: string[] = [];
    try {
      const actionsResult = await authentication.client
        .from("audit_log")
        .select("action")
        .in("branch_id", selectedBranchIds)
        .is("deleted_at", null)
        .gte("occurred_at", fromIso)
        .lt("occurred_at", toIso)
        .order("action", { ascending: true })
        .limit(2_000);
      if (!actionsResult.error) {
        actions = [...new Set(((actionsResult.data || []) as Array<{ action: string }>).map((row) => row.action))];
      }
    } catch {
      actions = [];
    }

    return authenticationResponse(request, authentication, {
      rows,
      actions,
      branches: branches.map((branch) => ({ id: branch.id, name: branch.name, code: branch.code })),
      summary: {
        count: rows.length,
        scope: selectedBranchIds.length === 1
          ? branchNames.get(selectedBranchIds[0]) || "Selected branch"
          : "All accessible branches",
        from: fromDay,
        to: toDay,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const unavailable = schemaUnavailable(error as { code?: string });
    return authenticationResponse(request, authentication, {
      error: unavailable
        ? "The cloud audit log schema is not available yet. Apply the audit log migration and reload the API schema cache."
        : error instanceof Error
          ? error.message
          : "Audit events could not be loaded.",
    }, unavailable ? 503 : 500);
  }
}
