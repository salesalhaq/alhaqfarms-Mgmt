import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import {
  assertHqAdmin,
  assertSameOrigin,
  readBoolean,
  readJsonBody,
  readText,
  writeFailure,
  WriteError,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

function throwRpcError(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  if (error.code === "P0001") throw new WriteError(error.message || "The staff account action was rejected.");
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function throwCredentialFunctionError(error: unknown): Promise<never> {
  if (isRecord(error) && error.context instanceof Response) {
    const response = error.context;
    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      throw new WriteError(`Credential reset service failed (HTTP ${response.status}).`, 503);
    }
    if (isRecord(payload) && typeof payload.error === "string") {
      throw new WriteError(payload.error, response.status >= 400 && response.status < 500 ? response.status : 503);
    }
    throw new WriteError(`Credential reset service failed (HTTP ${response.status}).`, 503);
  }

  if (isRecord(error) && (error.name === "FunctionsFetchError" || error.name === "FunctionsRelayError")) {
    throw new WriteError(
      "The credential reset service is unavailable. Confirm the staff-credential-update Supabase Edge Function is deployed, then retry.",
      503,
    );
  }

  throw new WriteError("The credential reset service could not be reached. Confirm its deployment and retry.", 503);
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  if (authentication.identity.staff.role !== "admin" || authentication.identity.staff.branch_id) {
    return authenticationResponse(
      request,
      authentication,
      { error: "Staff accounts are available to the HQ administrator only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  const roleFilter = (parameters.get("role") || "").toLowerCase();
  const statusFilter = (parameters.get("status") || "").toLowerCase();
  const search = (parameters.get("search") || "").trim().toLowerCase().slice(0, 100);

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
    const { data, error } = await authentication.client.rpc("list_staff_accounts");
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
      .filter((member) => {
        if (requestedBranch && requestedBranch !== "all" && member.branch_id !== requestedBranch) return false;
        if (roleFilter && roleFilter !== "all" && member.role !== roleFilter) return false;
        if (statusFilter === "archived" && !member.deleted_at) return false;
        if (statusFilter !== "archived" && member.deleted_at) return false;
        if (statusFilter === "active" && !member.is_active) return false;
        if (statusFilter === "inactive" && member.is_active) return false;
        if (!search) return true;
        return [member.full_name, member.email, member.username, member.role, member.branch_name]
          .some((value) => value?.toLowerCase().includes(search));
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
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load staff accounts.",
    }, 500);
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
    const action = readText(body.action, "Staff account action", 40);
    const id = body.id === undefined || body.id === null || body.id === ""
      ? null
      : readText(body.id, "Staff profile", 64);
    if (id && !isUuid(id)) throw new WriteError("Choose a valid staff profile.");

    if (action === "save_profile") {
      const fullName = readText(body.fullName, "Full name", 200);
      const email = readText(body.email, "Email", 254).toLowerCase();
      const username = readText(body.username, "Username", 50);
      const role = readText(body.role, "Role", 20).toLowerCase();
      if (!["admin", "manager", "cashier"].includes(role)) throw new WriteError("Choose a valid staff role.");
      const branchId = readText(body.branchId, "Branch", 64);
      if (!isUuid(branchId)) throw new WriteError("Choose an active branch.");
      const { data, error } = await authentication.client.rpc("staff_manage_account", {
        p_action: action,
        p_payload: { id, fullName, email, username, role, branchId },
      });
      throwRpcError(error);
      return authenticationResponse(request, authentication, { result: data });
    }

    if (action === "set_active") {
      if (!id) throw new WriteError("Choose a staff profile.");
      const isActive = readBoolean(body.isActive, "Account status");
      const { data, error } = await authentication.client.rpc("staff_manage_account", {
        p_action: action,
        p_payload: { id, isActive },
      });
      throwRpcError(error);
      return authenticationResponse(request, authentication, { result: data });
    }

    if (action === "archive" || action === "restore") {
      if (!id) throw new WriteError("Choose a staff profile.");
      const { data, error } = await authentication.client.rpc("staff_manage_account", {
        p_action: action,
        p_payload: { id },
      });
      throwRpcError(error);
      return authenticationResponse(request, authentication, { result: data });
    }

    if (action === "delete_profile") {
      if (!id) throw new WriteError("Choose a staff profile.");
      const { data, error } = await authentication.client.rpc("anonymize_cloud_staff_profile", {
        p_local_staff_id: id,
      });
      throwRpcError(error);
      return authenticationResponse(request, authentication, { result: data });
    }

    if (action === "issue_invitation") {
      if (!id) throw new WriteError("Choose a staff profile.");
      const { data, error } = await authentication.client.rpc("issue_staff_credential_invitation", {
        p_staff_id: id,
      });
      throwRpcError(error);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new WriteError("Supabase returned an invalid staff invitation.", 503);
      }
      const invitation = data as { code?: unknown; expiresAt?: unknown };
      if (typeof invitation.code !== "string" || !/^[0-9a-f]{32}$/i.test(invitation.code)
        || typeof invitation.expiresAt !== "string" || !Number.isFinite(Date.parse(invitation.expiresAt))) {
        throw new WriteError("Supabase returned an invalid staff invitation.", 503);
      }
      return authenticationResponse(request, authentication, {
        invitation: { code: invitation.code, expiresAt: invitation.expiresAt },
      });
    }

    if (action === "set_credential") {
      if (!id) throw new WriteError("Choose a staff profile.");
      const mode = readText(body.mode, "Credential type", 20);
      const value = body.value;
      if (mode !== "password" && mode !== "pin") throw new WriteError("Choose password or PIN.");
      if (typeof value !== "string"
        || (mode === "password" && (value.length < 10 || value.length > 200))
        || (mode === "pin" && !/^\d{4,8}$/.test(value))) {
        throw new WriteError(mode === "password"
          ? "Password must be between 10 and 200 characters."
          : "PIN must contain 4 to 8 digits.");
      }
      const { data, error } = await authentication.client.functions.invoke("staff-credential-update", {
        body: { adminReset: true, staffId: id, mode, value },
      });
      if (error) await throwCredentialFunctionError(error);
      if (!data || data.success !== true || !Number.isSafeInteger(data.securityVersion)) {
        throw new WriteError(typeof data?.error === "string" ? data.error : "The credential reset could not be confirmed.", 503);
      }
      return authenticationResponse(request, authentication, { result: data });
    }

    throw new WriteError("Choose a supported staff account action.");
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
