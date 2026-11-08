import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertHqAdmin,
  assertSameOrigin,
  readEnum,
  readJsonBody,
  readText,
  writeFailure,
  WriteError,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

const CLOUD_ROLES = ["admin", "manager", "cashier"] as const;

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (authentication.identity.staff.role !== "admin" || authentication.identity.staff.branch_id) {
    return authenticationResponse(
      request,
      authentication,
      { error: "Cloud accounts are available to the HQ administrator only." },
      403,
    );
  }

  try {
    const { data, error } = await authentication.client.rpc("list_cloud_staff");
    if (error) throw new Error(error.message);
    return authenticationResponse(request, authentication, { accounts: data || [] });
  } catch (error) {
    console.error("Could not load cloud staff access.", error);
    return authenticationResponse(
      request,
      authentication,
      { error: error instanceof Error ? error.message : "Cloud accounts could not be loaded." },
      503,
    );
  }
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    assertHqAdmin(authentication.identity);
    const body = await readJsonBody(request);
    const email = readText(body.email, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new WriteError("Enter a valid user email address.");
    }
    const fullName = readText(body.fullName, "Staff name", 200);
    const role = readEnum(body.role, "Cloud role", CLOUD_ROLES);
    const branchCode = readText(body.branchCode, "Branch", 20).toUpperCase();
    const branch = authentication.identity.branches.find((item) =>
      item.is_active && item.code.toUpperCase() === branchCode
    );
    if (!branch) throw new WriteError("Choose an active branch available to this HQ account.");
    const { data: staffProfiles, error: staffProfilesError } = await authentication.client.rpc("list_staff_accounts");
    if (staffProfilesError) throw staffProfilesError;
    const localStaff = staffProfiles?.find((profile) =>
      profile.deleted_at === null && profile.email?.toLowerCase() === email
    );

    const { data, error } = await authentication.client.rpc("provision_cloud_staff", {
      p_email: email,
      p_full_name: fullName,
      p_role: role,
      p_branch_code: branch.code,
      p_local_staff_id: localStaff?.id || crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "P0001" || error.code === "42501") {
        throw new WriteError(error.message, error.code === "42501" ? 403 : 400);
      }
      throw error;
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new WriteError("Supabase did not confirm the cloud account assignment.", 503);
    }
    const assignment = data as { email?: unknown; role?: unknown; branch_id?: unknown };
    if (typeof assignment.email !== "string"
      || assignment.email.toLowerCase() !== email
      || assignment.role !== role
      || assignment.branch_id !== branch.id) {
      throw new WriteError("Supabase did not confirm the requested cloud account assignment.", 503);
    }

    return authenticationResponse(request, authentication, { success: true, email, fullName, role, branch });
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
