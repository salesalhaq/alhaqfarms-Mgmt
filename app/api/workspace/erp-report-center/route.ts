import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import { buildErpReportCenter } from "@/lib/server/reports/erp-report-center";
import type { ReportClient } from "@/lib/server/report-center";

export const dynamic = "force-dynamic";

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(
      request,
      authentication,
      { error: "ERP reports are available to administrators only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const from = parameters.get("from") || "";
  const to = parameters.get("to") || "";
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    return authenticationResponse(request, authentication, { error: "Choose valid dates for the report window." }, 400);
  }
  if (new Date(`${to}T00:00:00.000Z`).getTime() < new Date(`${from}T00:00:00.000Z`).getTime()) {
    return authenticationResponse(request, authentication, { error: "The report end date must be on or after the start date." }, 400);
  }

  const requestedBranch = parameters.get("branchId") || "";
  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  const accessibleBranches = authentication.identity.branches.map((branch) => ({ id: branch.id, name: branch.name }));
  const accessibleBranchIds = accessibleBranches.map((branch) => branch.id);

  let selectedBranchIds: string[] = accessibleBranchIds;
  if (requestedBranch && requestedBranch !== "all") {
    if (!accessibleBranchIds.includes(requestedBranch)) {
      return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
    }
    selectedBranchIds = [requestedBranch];
  }

  const branches = selectedBranchIds.length === 1
    ? accessibleBranches.filter((branch) => branch.id === selectedBranchIds[0])
    : accessibleBranches;

  const branchName = selectedBranchIds.length === 1
    ? branches[0]?.name || "Your branch"
    : "All accessible branches";

  if (!branches.length) {
    return authenticationResponse(request, authentication, { error: "Choose a branch before viewing reports." }, 400);
  }

  try {
    const payload = await buildErpReportCenter(authentication.client as unknown as ReportClient, {
      from,
      to,
      branchId: selectedBranchIds.length === 1 ? selectedBranchIds[0] : null,
      branchName,
      branches,
      selectedBranchIds,
    });
    return authenticationResponse(request, authentication, payload);
  } catch (error) {
    return authenticationResponse(
      request,
      authentication,
      { error: error instanceof Error ? error.message : "Could not load the report data." },
      500,
    );
  }
}
