import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const STAFF_LIMIT = 500;

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(
      request,
      authentication,
      { error: "Staff accounts are available to administrators only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  const roleFilter = (parameters.get("role") || "").toLowerCase();
  const statusFilter = (parameters.get("status") || "").toLowerCase();
  const search = (parameters.get("search") || "").trim().toLowerCase();

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
  if (requestedBranch && requestedBranch !== "all" && !branchNames.has(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  if (roleFilter && roleFilter !== "all" && !["admin", "manager", "cashier"].includes(roleFilter)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid staff role." }, 400);
  }

  try {
    // cloud_staff only exposes the signed-in user's own row through RLS, so the
    // desktop roster is read through the same SECURITY DEFINER RPC it uses.
    const client = authentication.client as unknown as {
      rpc(name: string): Promise<{
        data: Array<{
          user_id: string | null;
          local_staff_id: string | null;
          branch_id: string | null;
          branch_name: string | null;
          email: string;
          full_name: string;
          role: string;
          is_active: boolean;
          created_at: string;
        }> | null;
        error: { message: string; code?: string } | null;
      }>;
    };
    const { data, error } = await client.rpc("list_cloud_staff");
    if (error) {
      if (error.code === "42501") {
        return authenticationResponse(
          request,
          authentication,
          { error: "Staff accounts are available to the HQ administrator only." },
          403,
        );
      }
      throw new Error(error.message);
    }

    const rows = (data || [])
      .slice(0, STAFF_LIMIT)
      .map((member) => ({
        id: member.user_id || member.local_staff_id || member.email,
        user_id: member.user_id,
        local_staff_id: member.local_staff_id,
        full_name: member.full_name,
        email: member.email,
        username: member.email ? member.email.split("@")[0] : "",
        role: member.role,
        branch_id: member.branch_id,
        branch_name: member.branch_name
          || (member.branch_id ? branchNames.get(member.branch_id) || "Branch unavailable" : "Head office"),
        is_active: Boolean(member.is_active),
        web_enrolled: Boolean(member.user_id),
        created_at: member.created_at,
      }))
      .filter((member) => {
        if (requestedBranch && requestedBranch !== "all" && member.branch_id !== requestedBranch) return false;
        if (roleFilter && roleFilter !== "all" && member.role !== roleFilter) return false;
        if (statusFilter === "active" && !member.is_active) return false;
        if (statusFilter === "inactive" && member.is_active) return false;
        if (!search) return true;
        return [member.full_name, member.email, member.username, member.role, member.branch_name]
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
        active: rows.filter((member) => member.is_active).length,
        inactive: rows.filter((member) => !member.is_active).length,
        webEnrolled: rows.filter((member) => member.web_enrolled).length,
        admins: rows.filter((member) => member.role === "admin").length,
      },
      readOnly: true,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load staff accounts.",
    }, 500);
  }
}
