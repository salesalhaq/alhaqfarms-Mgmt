import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServerEnvironment } from "@/lib/supabase/server-environment";
import {
  resolveStaffIdentity,
  setAuthCookies,
  isSameOriginRequest,
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
    return NextResponse.json({ error: "Enter your invitation code and choose a password." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Enter your invitation code and choose a password." }, { status: 400 });
  }

  const code = body.code;
  const password = body.password;
  const pin = body.pin;
  if (
    typeof code !== "string"
    || !/^[0-9a-f]{32}$/i.test(code.trim())
    || typeof password !== "string"
    || password.length < 10
    || password.length > 200
    || typeof pin !== "string"
    || (pin !== "" && !/^[0-9]{4,8}$/.test(pin))
  ) {
    return NextResponse.json({
      error: "Check the invitation code, choose a password of 10 to 200 characters, and enter an optional 4 to 8 digit PIN.",
    }, { status: 400 });
  }

  try {
    const env = await getServerEnvironment();
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !env.STAFF_PIN_LOGIN_SECRET) {
      return NextResponse.json({ error: "Staff enrollment is not configured." }, { status: 503 });
    }

    const functionResponse = await fetch(
      `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/staff-web-enroll`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
          "x-staff-pin-login-secret": env.STAFF_PIN_LOGIN_SECRET,
        },
        body: JSON.stringify({ code: code.trim().toLowerCase(), password, pin }),
        cache: "no-store",
      },
    );
    const result: unknown = await functionResponse.json().catch(() => null);
    if (!functionResponse.ok) {
      const error = isRecord(result) && typeof result.error === "string"
        ? result.error
        : "Staff enrollment could not be completed.";
      return NextResponse.json({ error }, { status: functionResponse.status === 400 ? 400 : 503 });
    }
    if (!isRecord(result) || !isRecord(result.session)
        || typeof result.session.access_token !== "string"
        || typeof result.session.refresh_token !== "string") {
      console.error("Staff enrollment function returned an invalid session response.");
      return NextResponse.json({ error: "Staff enrollment could not be completed." }, { status: 503 });
    }

    const authClient = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const { data: sessionData, error: sessionError } = await authClient.auth.setSession({
      access_token: result.session.access_token,
      refresh_token: result.session.refresh_token,
    });
    if (sessionError || !sessionData.session || !sessionData.user) {
      console.error("Staff enrollment session validation failed:", sessionError?.message || "Missing session.");
      return NextResponse.json({ error: "Staff enrollment could not be completed." }, { status: 503 });
    }

    const staffClient = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${sessionData.session.access_token}` } },
    });
    const identity = await resolveStaffIdentity(staffClient, sessionData.user);
    if (!identity) {
      return NextResponse.json({ error: "The active staff profile could not be verified." }, { status: 403 });
    }

    return setAuthCookies(
      NextResponse.json(identity, { headers: { "Cache-Control": "no-store" } }),
      sessionData.session,
      request,
    );
  } catch (error) {
    console.error("Staff enrollment request failed:", error);
    return NextResponse.json({ error: "Staff enrollment could not be completed." }, { status: 503 });
  }
}
