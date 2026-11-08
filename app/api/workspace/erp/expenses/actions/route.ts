import { authenticateStaff, authenticationResponse, isSameOriginRequest } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (!isSameOriginRequest(request)) {
    return authenticationResponse(request, authentication, { error: "This request must come from the signed-in workspace." }, 403);
  }
  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Farm expense actions are restricted to administrators." }, 403);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return authenticationResponse(request, authentication, { error: "Send a valid farm expense action." }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!["record", "save-category"].includes(action)) {
    return authenticationResponse(request, authentication, { error: "Choose a supported farm expense action." }, 400);
  }

  const actionClient = authentication.client as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<{
      data: unknown;
      error: { code?: string; message: string } | null;
    }>;
  };
  const { data, error } = await actionClient.rpc("manage_web_erp_expense", {
    p_action: action,
    p_payload: body,
  });
  if (error) {
    if (error.code === "PGRST202" || /could not find the function|schema cache/i.test(error.message)) {
      return authenticationResponse(request, authentication, {
        error: "Farm expense web actions are not installed yet. Apply supabase/migrations/041_farm_erp_expense_actions.sql and retry.",
      }, 503);
    }
    const status = error.code === "P0001" ? 400 : 500;
    if (status === 500) console.error("Could not save a farm expense action.", error);
    return authenticationResponse(request, authentication, { error: error.message }, status);
  }
  return authenticationResponse(request, authentication, { result: data });
}
