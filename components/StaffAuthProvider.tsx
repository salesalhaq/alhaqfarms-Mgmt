"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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

/**
 * A tab keeps its own marker in sessionStorage: it survives reloads (Ctrl+F5)
 * but disappears the moment the tab or browser is closed. Cookies alone cannot
 * do this, because they survive both reloads and tab closes.
 */
const TAB_SESSION_KEY = "ah_mgmt_tab_session";
const TAB_SESSION_CHANNEL = "ah_mgmt_tab_session";
const TAB_PROBE_TIMEOUT_MS = 600;

function markTabSession() {
  try {
    window.sessionStorage.setItem(TAB_SESSION_KEY, "1");
  } catch {
    // Storage can be blocked; the cookie session still works.
  }
}

function hasTabSession() {
  try {
    return window.sessionStorage.getItem(TAB_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function clearTabSession() {
  try {
    window.sessionStorage.removeItem(TAB_SESSION_KEY);
  } catch {
    // Ignore.
  }
}

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
  const lastActivityRef = useRef(Date.now());

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
    lastActivityRef.current = Date.now();
    markTabSession();
  }, []);

  useEffect(() => {
    let active = true;
    const channel = typeof window !== "undefined" && "BroadcastChannel" in window
      ? new BroadcastChannel(TAB_SESSION_CHANNEL)
      : null;

    const handleChannelMessage = (event: MessageEvent) => {
      if (event.data === "ping" && hasTabSession()) channel?.postMessage("pong");
    };
    channel?.addEventListener("message", handleChannelMessage);

    const askOtherTabs = () => new Promise<boolean>((resolve) => {
      if (!channel) {
        resolve(false);
        return;
      }
      const finish = (value: boolean) => {
        window.clearTimeout(timer);
        channel.removeEventListener("message", onPong);
        resolve(value);
      };
      const onPong = (event: MessageEvent) => {
        if (event.data === "pong") finish(true);
      };
      const timer = window.setTimeout(() => finish(false), TAB_PROBE_TIMEOUT_MS);
      channel.addEventListener("message", onPong);
      channel.postMessage("ping");
    });

    const loadIdentity = () => {
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
    };

    void (async () => {
      // The tab marker survives reloads but not a tab/browser close. A brand-new
      // tab may only reuse the cookie session when another open tab confirms it
      // is still alive; otherwise the previous tab was closed, so sign out.
      if (!hasTabSession() && channel) {
        const otherTabOpen = await askOtherTabs();
        if (!active) return;
        if (!otherTabOpen) {
          await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin" })
            .catch(() => undefined);
          if (!active) return;
          setStaff(null);
          setBranches([]);
          setCanViewOrders(false);
          setModuleAccess({});
          setError(null);
          setLoading(false);
          return;
        }
      }
      markTabSession();
      loadIdentity();
    })();

    return () => {
      active = false;
      channel?.removeEventListener("message", handleChannelMessage);
      channel?.close();
    };
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
    clearTabSession();
  }, []);

  useEffect(() => {
    if (!staff) return undefined;
    const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
    const CHECK_INTERVAL = 60 * 1000; // Check every minute

    const markActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const checkInactivity = () => {
      if (Date.now() - lastActivityRef.current >= INACTIVITY_TIMEOUT) {
        void signOut();
      }
    };

    const events = ["mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((event) => {
      window.addEventListener(event, markActivity, { passive: true });
    });

    const interval = window.setInterval(checkInactivity, CHECK_INTERVAL);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") checkInactivity();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    lastActivityRef.current = Date.now();

    return () => {
      window.clearInterval(interval);
      events.forEach((event) => {
        window.removeEventListener(event, markActivity);
      });
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [staff, signOut]);

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
