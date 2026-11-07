import { NextResponse } from "next/server";
import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  return authenticationResponse(request, authentication, authentication.identity);
}
