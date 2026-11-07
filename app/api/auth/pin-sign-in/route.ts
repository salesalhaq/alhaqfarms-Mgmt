import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServerEnvironment } from "@/lib/supabase/server-environment";
import {
  isSameOriginRequest,
  resolveStaffIdentity,
  setAuthCookies,
} from "@/lib/server/staff-auth";
import type { Database } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter your username and shared PIN." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Enter your username and shared PIN." }, { status: 400 });
  }

  const username = body.username;
  const mode = body.mode;
  const credential = body.credential;
  if (
    typeof username !== "string"
    || !/^[a-zA-Z0-9._-]{1,64}$/.test(username.trim())
    || (mode !== "password" && mode !== "pin")
    || typeof credential !== "string"
    || (mode === "password" && (credential.length < 10 || credential.length > 200))
    || (mode === "pin" && !/^[0-9]{4,8}$/.test(credential))
  ) {
    return NextResponse.json({ error: "Enter a valid username and password or 4 to 8 digit PIN." }, { status: 400 });
  }

  try {
    const env = await getServerEnvironment();
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !env.STAFF_PIN_LOGIN_SECRET) {
      return NextResponse.json({ error: "Shared PIN sign-in is not configured." }, { status: 503 });
    }

    const functionResponse = await fetch(
      `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/staff-pin-login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
          "x-staff-pin-login-secret": env.STAFF_PIN_LOGIN_SECRET,
        },
        body: JSON.stringify({ username: username.trim(), mode, credential }),
        cache: "no-store",
      },
    );

    if (functionResponse.status === 401) {
      return NextResponse.json({ error: "Username or password/PIN is incorrect." }, { status: 401 });
    }
    if (!functionResponse.ok) {
      console.error("PIN sign-in function returned status:", functionResponse.status);
      return NextResponse.json({ error: "PIN sign-in is temporarily unavailable." }, { status: 503 });
    }

    const result: unknown = await functionResponse.json();
    if (!isRecord(result) || !isRecord(result.session)) {
      console.error("PIN sign-in function returned an invalid session response.");
      return NextResponse.json({ error: "PIN sign-in is temporarily unavailable." }, { status: 503 });
    }

    const accessToken = result.session.access_token;
    const refreshToken = result.session.refresh_token;
    if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
      console.error("PIN sign-in function returned incomplete session tokens.");
      return NextResponse.json({ error: "PIN sign-in is temporarily unavailable." }, { status: 503 });
    }

    const client = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const { data: sessionData, error: sessionError } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (sessionError || !sessionData.session || !sessionData.user) {
      console.error("PIN sign-in session validation failed:", sessionError?.message || "Missing session.");
      return NextResponse.json({ error: "PIN sign-in is temporarily unavailable." }, { status: 503 });
    }

    const staffClient = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${sessionData.session.access_token}` } },
    });
    const identity = await resolveStaffIdentity(staffClient, sessionData.user);
    if (!identity) {
      return NextResponse.json({
        error: "This login is not linked to an active staff account and branch.",
      }, { status: 403 });
    }

    const response = NextResponse.json(identity, { headers: { "Cache-Control": "no-store" } });
    return setAuthCookies(response, sessionData.session, request);
  } catch (error) {
    console.error("PIN sign-in request failed:", error);
    return NextResponse.json({ error: "PIN sign-in is temporarily unavailable." }, { status: 503 });
  }
}
