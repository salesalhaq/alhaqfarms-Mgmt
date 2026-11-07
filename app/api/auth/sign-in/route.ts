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

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter your staff email and password." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Enter your staff email and password." }, { status: 400 });
  }
  const email = Reflect.get(body, "email");
  const password = Reflect.get(body, "password");
  if (typeof email !== "string" || typeof password !== "string"
      || !email.trim() || !password || email.length > 254 || password.length > 1024) {
    return NextResponse.json({ error: "Enter your staff email and password." }, { status: 400 });
  }

  try {
    const env = await getServerEnvironment();
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      return NextResponse.json({ error: "Staff sign-in is not configured." }, { status: 503 });
    }
    const client = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.session || !data.user) {
      return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
    }

    const staffClient = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    });
    const identity = await resolveStaffIdentity(staffClient, data.user);
    if (!identity) {
      return NextResponse.json({
        error: "This login is not linked to an active staff account and branch. Ask the HQ administrator for access.",
      }, { status: 403 });
    }

    const response = NextResponse.json(identity, { headers: { "Cache-Control": "no-store" } });
    return setAuthCookies(response, data.session, request);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Sign-in could not be completed.",
    }, { status: 503 });
  }
}
