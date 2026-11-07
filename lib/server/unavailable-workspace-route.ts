import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";

export async function unavailableWorkspaceRoute(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(
      request,
      authentication,
      { error: authentication.error },
      authentication.status,
    );
  }

  return authenticationResponse(
    request,
    authentication,
    { error: "This read-only workspace is not available in the web client yet." },
    501,
  );
}
