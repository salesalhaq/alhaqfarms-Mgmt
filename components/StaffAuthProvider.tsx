"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Database } from "@/lib/supabase/database.types";

type Staff = Pick<
  Database["public"]["Tables"]["cloud_staff"]["Row"],
  "user_id" | "branch_id" | "email" | "full_name" | "role" | "is_active"
>;
type Branch = Pick<
  Database["public"]["Tables"]["branches"]["Row"],
  "id" | "code" | "name" | "is_active" | "deleted_at"
>;
interface IdentityResponse {
  staff?: Staff;
  branches?: Branch[];
  canViewOrders?: boolean;
  moduleAccess?: Record<string, boolean>;
  success?: boolean;
  error?: string;
}

interface StaffAuthValue {
  staff: Staff | null;
  branches: Branch[];
  canViewOrders: boolean;
  moduleAccess: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithUsername: (username: string, mode: "password" | "pin", credential: string) => Promise<void>;
  enrollWithInvitation: (code: string, password: string, pin: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const StaffAuthContext = createContext<StaffAuthValue | null>(null);

async function readIdentity(response: Response): Promise<IdentityResponse> {
  try {
    return await response.json() as IdentityResponse;
  } catch {
    return { error: "The management server returned an invalid response." };
  }
}

export function StaffAuthProvider({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [canViewOrders, setCanViewOrders] = useState(false);
  const [moduleAccess, setModuleAccess] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyIdentity = useCallback((identity: IdentityResponse) => {
    if (
      !identity.staff
      || !identity.branches
      || typeof identity.canViewOrders !== "boolean"
      || !identity.moduleAccess
    ) {
      throw new Error("The server did not return an active staff profile.");
    }
    setStaff(identity.staff);
    setBranches(identity.branches);
    setCanViewOrders(identity.canViewOrders);
    setModuleAccess(identity.moduleAccess);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const identity = await readIdentity(response);
        if (!active) return;
        if (response.status === 401) {
          setStaff(null);
          setBranches([]);
          setCanViewOrders(false);
          setModuleAccess({});
          return;
        }
        if (!response.ok) throw new Error(identity.error || "Staff access could not be verified.");
        applyIdentity(identity);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Staff access could not be verified.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [applyIdentity]);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await fetch("/api/auth/sign-in", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const identity = await readIdentity(response);
    if (!response.ok) throw new Error(identity.error || "Sign-in failed.");
    applyIdentity(identity);
  }, [applyIdentity]);

  const signInWithUsername = useCallback(async (
    username: string,
    mode: "password" | "pin",
    credential: string,
  ) => {
    const response = await fetch("/api/auth/pin-sign-in", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, mode, credential }),
    });
    const identity = await readIdentity(response);
    if (!response.ok) throw new Error(identity.error || "Staff sign-in failed.");
    applyIdentity(identity);
  }, [applyIdentity]);

  const enrollWithInvitation = useCallback(async (code: string, password: string, pin: string) => {
    const response = await fetch("/api/auth/enroll", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, password, pin }),
    });
    const identity = await readIdentity(response);
    if (!response.ok) throw new Error(identity.error || "Staff enrollment failed.");
    applyIdentity(identity);
  }, [applyIdentity]);

  const signOut = useCallback(async () => {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
    });
    const result = await readIdentity(response);
    if (!response.ok) throw new Error(result.error || "Could not sign out.");
    setStaff(null);
    setBranches([]);
    setCanViewOrders(false);
    setModuleAccess({});
    setError(null);
  }, []);

  const value = useMemo(() => ({
    staff, branches, canViewOrders, moduleAccess, loading, error, signIn, signInWithUsername, enrollWithInvitation, signOut,
  }), [branches, canViewOrders, enrollWithInvitation, error, loading, moduleAccess, signIn, signInWithUsername, signOut, staff]);

  return <StaffAuthContext.Provider value={value}>{children}</StaffAuthContext.Provider>;
}

export function useStaffAuth(): StaffAuthValue {
  const value = useContext(StaffAuthContext);
  if (!value) throw new Error("useStaffAuth must be used within StaffAuthProvider.");
  return value;
}
