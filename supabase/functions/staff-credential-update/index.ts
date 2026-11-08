import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const authorization = request.headers.get("Authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!authorization || !supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Sign in to the assigned cloud account first." }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "The credential change request is invalid." }, 400);
  }
  if (!isRecord(body)) return jsonResponse({ error: "The credential change request is invalid." }, 400);

  const staffId = body.staffId;
  const mode = body.mode;
  const value = body.value;
  const adminReset = body.adminReset === true;
  const currentSecret = body.currentSecret;
  if (
    typeof staffId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(staffId)
    || (mode !== "password" && mode !== "pin")
    || typeof value !== "string"
    || (mode === "password" && (value.length < 10 || value.length > 200))
    || (mode === "pin" && !/^[0-9]{4,8}$/.test(value))
    || (!adminReset && (typeof currentSecret !== "string" || !currentSecret))
  ) {
    return jsonResponse({ error: "The new shared credential is invalid." }, 400);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return jsonResponse({ error: "Your cloud session expired. Sign in again." }, 401);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });

  if (adminReset) {
    const { data: authorizationResult, error: authorizeError } = await userClient.rpc(
      "authorize_staff_admin_credential_reset",
      { p_staff_id: staffId },
    );
    if (authorizeError || !isRecord(authorizationResult) || authorizationResult.authorized !== true) {
      const message = isRecord(authorizationResult) && typeof authorizationResult.error === "string"
        ? authorizationResult.error
        : authorizeError?.message || "Only the HQ administrator can reset staff credentials.";
      return jsonResponse({ error: message }, 403);
    }
    if (authorizationResult.userId !== null && typeof authorizationResult.userId !== "string") {
      console.error("staff-credential-update authorization returned an invalid Auth user ID.");
      return jsonResponse({ error: "The credential reset could not be completed." }, 503);
    }
    if (typeof authorizationResult.userId !== "string") {
      return jsonResponse({ success: false, error: "No active web login is linked. Issue an enrollment invitation first." }, 200);
    }

    if (mode === "password") {
      const { error } = await adminClient.auth.admin.updateUserById(authorizationResult.userId, { password: value });
      if (error) {
        console.error("staff-credential-update could not change the Auth password:", error.message);
        return jsonResponse({ error: "The shared password could not be updated." }, 503);
      }
    }

    const { data: securityVersion, error: updateError } = await adminClient.rpc(
      "set_staff_shared_credential_by_admin",
      {
        p_actor_user_id: userData.user.id,
        p_staff_id: staffId,
        p_mode: mode,
        p_new_secret: value,
      },
    );
    if (updateError) {
      console.error("staff-credential-update could not save the admin reset:", updateError.message);
      return jsonResponse({
        error: mode === "password" && typeof authorizationResult.userId === "string"
          ? "The web password changed, but its shared credential did not. Retry with the same new password to finish the reset."
          : "The staff credential could not be updated. Retry the reset.",
      }, 503);
    }
    if (!Number.isSafeInteger(securityVersion) || Number(securityVersion) < 1) {
      return jsonResponse({ error: "The credential reset could not be confirmed. Retry the reset." }, 503);
    }
    return jsonResponse({ success: true, securityVersion }, 200);
  }

  const { data: authorizationResult, error: authorizeError } = await userClient.rpc(
    "authorize_staff_shared_credential_change",
    {
      p_staff_id: staffId,
      p_current_secret: currentSecret,
      p_mode: mode,
    },
  );
  if (authorizeError || !isRecord(authorizationResult) || authorizationResult.authorized !== true) {
    const message = isRecord(authorizationResult) && typeof authorizationResult.error === "string"
      ? authorizationResult.error
      : authorizeError?.message || "The current shared credential is incorrect.";
    return jsonResponse({ error: message }, 403);
  }
  if (authorizationResult.userId !== null && typeof authorizationResult.userId !== "string") {
    console.error("staff-credential-update authorization returned an invalid Auth user ID.");
    return jsonResponse({ error: "The shared credential could not be updated." }, 503);
  }
  const targetUserId = typeof authorizationResult.userId === "string" ? authorizationResult.userId : null;

  if (mode === "password" && targetUserId) {
    const { error } = await adminClient.auth.admin.updateUserById(targetUserId, { password: value });
    if (error) {
      console.error("staff-credential-update could not change the Auth password:", error.message);
      return jsonResponse({ error: "The shared password could not be updated." }, 503);
    }
  }

  const { data: securityVersion, error: updateError } = await adminClient.rpc("update_staff_shared_credential", {
    p_actor_user_id: userData.user.id,
    p_staff_id: staffId,
    p_current_secret: currentSecret,
    p_mode: mode,
    p_new_secret: value,
  });
  if (updateError) {
    if (mode === "password" && targetUserId) {
      const { error: rollbackError } = await adminClient.auth.admin.updateUserById(targetUserId, {
        password: currentSecret,
      });
      if (rollbackError) {
        console.error("staff-credential-update could not roll back Auth after cloud hash failure:", rollbackError.message);
        return jsonResponse({ error: "Credential update is incomplete. Contact the HQ administrator to reset your access." }, 503);
      }
    }
    return jsonResponse({ error: updateError.message }, 400);
  }

  if (!Number.isSafeInteger(securityVersion) || Number(securityVersion) < 1) {
    return jsonResponse({ error: "The credential was updated, but its security version could not be confirmed. Contact the HQ administrator before signing out." }, 503);
  }
  return jsonResponse({ success: true, securityVersion }, 200);
});
