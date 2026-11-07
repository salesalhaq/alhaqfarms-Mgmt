import { NextResponse } from "next/server";
import { clearAuthCookies, isSameOriginRequest } from "@/lib/server/staff-auth";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  return clearAuthCookies(NextResponse.json({ signedOut: true }), request);
}
