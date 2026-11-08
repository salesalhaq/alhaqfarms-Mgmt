import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertSameOrigin,
  readJsonBody,
  writeFailure,
  WriteError,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const mode = body.mode;
    const currentSecret = body.currentSecret;
    const value = body.value;

    if (mode !== "password" && mode !== "pin") {
      throw new WriteError("Choose password or PIN.");
    }
    if (typeof currentSecret !== "string" || !currentSecret || currentSecret.length > 200) {
      throw new WriteError("Enter your current PIN or password.");
    }
    if (typeof value !== "string"
      || (mode === "password" && (value.length < 10 || value.length > 200))
      || (mode === "pin" && !/^[0-9]{4,8}$/.test(value))) {
      throw new WriteError(mode === "password"
        ? "Password must be between 10 and 200 characters."
        : "PIN must contain 4 to 8 digits.");
    }
    if (!authentication.identity.staff.local_staff_id) {
      throw new WriteError("This login is not linked to an active staff profile.", 403);
    }

    const { data, error } = await authentication.client.functions.invoke("staff-credential-update", {
      body: {
        staffId: authentication.identity.staff.local_staff_id,
        currentSecret,
        mode,
        value,
      },
    });

    if (error) {
      if (isRecord(error) && error.context instanceof Response) {
        const response = error.context;
        let payload: unknown;
        try {
          payload = await response.clone().json();
        } catch {
          throw new WriteError(`Credential update failed (HTTP ${response.status}).`, 503);
        }
        if (isRecord(payload) && typeof payload.error === "string") {
          throw new WriteError(
            payload.error,
            response.status >= 400 && response.status < 500 ? response.status : 503,
          );
        }
        throw new WriteError(`Credential update failed (HTTP ${response.status}).`, 503);
      }

      throw new WriteError(
        "The credential update service is unavailable. Confirm the staff-credential-update Supabase Edge Function is deployed, then retry.",
        503,
      );
    }

    if (!isRecord(data) || data.success !== true || !Number.isSafeInteger(data.securityVersion)) {
      throw new WriteError(
        isRecord(data) && typeof data.error === "string"
          ? data.error
          : "The credential update could not be confirmed.",
        503,
      );
    }

    return authenticationResponse(request, authentication, { success: true });
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
