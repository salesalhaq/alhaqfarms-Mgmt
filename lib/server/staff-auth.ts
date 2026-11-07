import "server-only";

import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServerEnvironment } from "@/lib/supabase/server-environment";
import type { Database } from "@/lib/supabase/database.types";

const ACCESS_COOKIE = "ah_mgmt_access";
const REFRESH_COOKIE = "ah_mgmt_refresh";
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;

type Staff = Pick<
  Database["public"]["Tables"]["cloud_staff"]["Row"],
  "user_id" | "local_staff_id" | "branch_id" | "email" | "full_name" | "role" | "is_active"
>;
type Branch = Pick<
  Database["public"]["Tables"]["branches"]["Row"],
  "id" | "code" | "name" | "is_active" | "deleted_at"
>;

export interface StaffIdentity {
  staff: Staff;
  branches: Branch[];
  canViewOrders: boolean;
}

export type StaffAuthentication =
  | {
    ok: true;
    client: SupabaseClient<Database>;
    identity: StaffIdentity;
    refreshedSession: Session | null;
  }
  | {
    ok: false;
    status: 401 | 403 | 503;
    error: string;
    clearCookies: boolean;
  };

function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") || "";
  const entry = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return null;
  }
}

function createSupabaseClient(url: string, anonKey: string, accessToken?: string) {
  return createClient<Database>(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    ...(accessToken ? {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    } : {}),
  });
}

export async function resolveStaffIdentity(
  client: SupabaseClient<Database>,
  user: User,
): Promise<StaffIdentity | null> {
  const { data: staff, error: staffError } = await client
    .from("cloud_staff")
    .select("user_id, local_staff_id, branch_id, email, full_name, role, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (staffError) throw new Error(`Could not read staff access: ${staffError.message}`);
  if (!staff || !staff.is_active) return null;

  let branchQuery = client
    .from("branches")
    .select("id, code, name, is_active, deleted_at")
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("name", { ascending: true });

  if (staff.branch_id) branchQuery = branchQuery.eq("id", staff.branch_id);
  else if (staff.role !== "admin") return null;

  const { data: branches, error: branchError } = await branchQuery;
  if (branchError) throw new Error(`Could not read assigned branches: ${branchError.message}`);
  const activeBranches = branches || [];
  if (staff.branch_id && !activeBranches.some((branch) => branch.id === staff.branch_id)) return null;
  if (staff.role !== "admin" && !staff.branch_id) return null;

  let canViewOrders = true;
  if (staff.role !== "admin" && staff.branch_id) {
    const { data: permission, error: permissionError } = await client
      .from("branch_module_permissions")
      .select("is_allowed")
      .eq("branch_id", staff.branch_id)
      .eq("role", staff.role)
      .eq("permission_key", "module:orders:view")
      .maybeSingle();
    if (permissionError) throw new Error(`Could not read order access: ${permissionError.message}`);
    canViewOrders = permission?.is_allowed ?? ["cashier", "manager"].includes(staff.role);
  }

  return { staff, branches: activeBranches, canViewOrders };
}

export async function authenticateStaff(request: Request): Promise<StaffAuthentication> {
  const accessToken = readCookie(request, ACCESS_COOKIE);
  const refreshToken = readCookie(request, REFRESH_COOKIE);
  if (!accessToken && !refreshToken) {
    return { ok: false, status: 401, error: "Sign in to continue.", clearCookies: false };
  }

  try {
    const env = await getServerEnvironment();
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      return { ok: false, status: 503, error: "Staff sign-in is not configured.", clearCookies: false };
    }

    const authClient = createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    let activeAccessToken = accessToken;
    let refreshedSession: Session | null = null;
    let user: User | null = null;

    if (activeAccessToken) {
      const { data, error } = await authClient.auth.getUser(activeAccessToken);
      if (!error) user = data.user;
    }

    if (!user && refreshToken) {
      const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
      if (error || !data.session || !data.user) {
        return { ok: false, status: 401, error: "Your session expired. Sign in again.", clearCookies: true };
      }
      refreshedSession = data.session;
      activeAccessToken = data.session.access_token;
      user = data.user;
    }

    if (!user || !activeAccessToken) {
      return { ok: false, status: 401, error: "Your session expired. Sign in again.", clearCookies: true };
    }

    const client = createSupabaseClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      activeAccessToken,
    );
    const identity = await resolveStaffIdentity(client, user);
    if (!identity) {
      return { ok: false, status: 403, error: "This login is not linked to an active staff account and branch.", clearCookies: true };
    }

    return { ok: true, client, identity, refreshedSession };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      error: error instanceof Error ? error.message : "Staff access could not be verified.",
      clearCookies: false,
    };
  }
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function setAuthCookies(
  response: NextResponse,
  session: Session,
  request: Request,
): NextResponse {
  const secure = new URL(request.url).protocol === "https:";
  const common = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  response.cookies.set(ACCESS_COOKIE, session.access_token, {
    ...common,
    maxAge: Math.max(60, Math.min(session.expires_in || 3600, 3600)),
  });
  response.cookies.set(REFRESH_COOKIE, session.refresh_token, {
    ...common,
    maxAge: REFRESH_MAX_AGE,
  });
  return response;
}

export function clearAuthCookies(response: NextResponse, request: Request): NextResponse {
  const secure = new URL(request.url).protocol === "https:";
  const common = { httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: 0 };
  response.cookies.set(ACCESS_COOKIE, "", common);
  response.cookies.set(REFRESH_COOKIE, "", common);
  return response;
}

export function authenticationResponse(
  request: Request,
  authentication: StaffAuthentication,
  body: unknown,
  status = 200,
): NextResponse {
  const response = NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!authentication.ok && authentication.clearCookies) return clearAuthCookies(response, request);
  if (authentication.ok && authentication.refreshedSession) {
    return setAuthCookies(response, authentication.refreshedSession, request);
  }
  return response;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
