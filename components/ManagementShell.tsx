"use client";

import {
  ArrowLeftRight, BarChart3, Beef, BookUser, Boxes, BriefcaseBusiness, Building2,
  Check, ClipboardList, Cloud, Factory, FlaskConical, Globe, LayoutDashboard, LogOut,
  Maximize2, Minimize2, MonitorSmartphone, Package, PackageCheck, Palette, PanelsTopLeft, Receipt, RotateCcw,
  Settings, ShoppingCart, Store, Tag, Tags, TrendingUp, Truck, User, Users, Wallet, Warehouse,
  ZoomIn, ZoomOut,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppearanceProvider, useAppearance } from "@/components/AppearanceProvider";
import { BusinessSettingsProvider } from "@/components/BusinessSettingsProvider";
import { BrandLockup } from "@/components/BrandLockup";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { workspacePermissionId } from "@/lib/branch-permissions";
import { workspaceModules, workspaceSections, type WorkspaceModule } from "@/lib/workspace-modules";
import { appThemes, themeGroups } from "@/lib/themes";

const icons: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  "point-of-sale": ShoppingCart,
  sales: BriefcaseBusiness,
  returns: RotateCcw,
  "daily-report": BarChart3,
  "barcode-labels": Tags,
  "cloud-sync": Cloud,
  settings: Settings,
  "online-orders": Globe,
  products: Package,
  inventory: Warehouse,
  purchasing: Truck,
  transfers: ArrowLeftRight,
  "stock-reports": ClipboardList,
  "store-dashboard": Store,
  "store-orders": ClipboardList,
  "receive-stock": PackageCheck,
  "store-returns": RotateCcw,
  "store-reports": BarChart3,
  "admin-dashboard": LayoutDashboard,
  "report-center": BarChart3,
  "staff-accounts": Users,
  devices: MonitorSmartphone,
  "sales-reports": BarChart3,
  "profit-tax": TrendingUp,
  "return-reports": RotateCcw,
  "hr-payroll": Wallet,
  "audit-log": ClipboardList,
  "store-expenses": Receipt,
  "fbr-pct-categories": Tag,
  "erp-dashboard": LayoutDashboard,
  animals: Beef,
  production: Factory,
  spice: FlaskConical,
  "bulk-sales": Boxes,
  vendors: Building2,
  "farm-stores": Warehouse,
  "customer-accounts": BookUser,
  "erp-expenses": Receipt,
  "erp-reports": BarChart3,
};

const managerOnly = new Set(["purchasing", "transfers", "stock-reports"]);
const adminSections = new Set(["Admin", "Farm ERP"]);
const routeTitles: Record<string, Pick<WorkspaceModule, "section" | "title">> = {
  "/workspace/admin-reports": { section: "Admin", title: "Admin reports" },
  "/workspace/store-reports": { section: "Store portal", title: "Store reports" },
};
const pageTitleOverrides: Record<string, string> = {
  sales: "Sales history",
  returns: "Returns & refunds",
  products: "Product catalog",
  transfers: "Stock transfers",
};

function ManagementShellContent({ children, staff, branches, moduleAccess, signOut }: {
  children: ReactNode;
  staff: NonNullable<ReturnType<typeof useStaffAuth>["staff"]>;
  branches: ReturnType<typeof useStaffAuth>["branches"];
  moduleAccess: ReturnType<typeof useStaffAuth>["moduleAccess"];
  signOut: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { themeId, setThemeId } = useAppearance();
  const assignedBranch = branches.find((branch) => branch.id === staff?.branch_id);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const [zoomPercent, setZoomPercent] = useState(() => Number(localStorage.getItem('alhaqfarms.zoom') || 100));
  const [profileOpen, setProfileOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const pageHeading = useMemo(() => {
    if (pathname.startsWith("/orders")) {
      return workspaceModules.find((item) => item.slug === "online-orders")
        || { section: "Operations", title: "Online orders" };
    }
    if (pathname === "/") {
      return workspaceModules.find((item) => item.slug === "overview")
        || { section: "Operations", title: "Overview" };
    }
    const route = routeTitles[pathname];
    if (route) return route;
    const prefix = "/workspace/";
    if (pathname.startsWith(prefix)) {
      const slug = pathname.slice(prefix.length).split("/")[0];
      const module = workspaceModules.find((item) => item.slug === slug);
      if (module) return { ...module, title: pageTitleOverrides[slug] || module.title };
    }
    return { section: "Workspace", title: "Staff workspace" };
  }, [pathname]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
      setFullscreenError(null);
    } catch (fullscreenFailure) {
      setFullscreenError(fullscreenFailure instanceof Error
        ? fullscreenFailure.message
        : "Fullscreen mode could not be changed.");
    }
  }, []);

  useEffect(() => {
    const updateFullscreen = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      setFullscreenError(null);
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    updateFullscreen();
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    if (!themeOpen) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(event.target as Node)) setThemeOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [themeOpen]);

  useEffect(() => {
    const mainArea = document.querySelector('.main-area') as HTMLElement;
    if (mainArea) {
      mainArea.style.zoom = `${zoomPercent}%`;
    }
    localStorage.setItem('alhaqfarms.zoom', String(zoomPercent));
  }, [zoomPercent]);

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!profileOpen) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) setProfileOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [profileOpen]);

  const canSeeSection = (section: string) => !adminSections.has(section) || staff.role === "admin";
  const canViewModule = (slug: string) => {
    if (staff.role === "admin") return true;
    const permissionId = workspacePermissionId(slug);
    return Boolean(permissionId && moduleAccess[permissionId]);
  };
  const routeModuleSlug = pathname.startsWith("/orders")
    ? "online-orders"
    : pathname === "/workspace/admin-reports"
      ? "admin-reports"
      : pathname === "/workspace/store-reports"
        ? "store-reports"
        : pathname.startsWith("/workspace/")
          ? pathname.slice("/workspace/".length).split("/")[0]
          : pathname === "/"
            ? "overview"
            : null;
  const currentModule = routeModuleSlug ? workspaceModules.find((item) =>
    item.slug === routeModuleSlug
  ) : undefined;
  const routeAllowed = routeModuleSlug ? canViewModule(routeModuleSlug) : true;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <BrandLockup className="brand-row" />
        <nav aria-label="Main navigation">
          {workspaceSections.filter((section) => canSeeSection(section.title)).map((section) => (
            <div className="nav-group" key={section.title}>
              <p className="nav-caption">{section.title}</p>
              {section.modules
                .filter((item) => canViewModule(item.slug))
                .filter((item) => !managerOnly.has(item.slug) || staff.role !== "cashier")
                .map((item) => {
                  const href = item.slug === "online-orders" ? "/orders" : `/workspace/${item.slug}`;
                  const active = item.slug === "online-orders"
                    ? pathname.startsWith("/orders")
                    : pathname === href || (item.slug === "overview" && pathname === "/");
                  const Icon = icons[item.slug] || PanelsTopLeft;
                  return (
                    <Link
                      className={`nav-link ${active ? "active" : ""}`}
                      href={href}
                      key={item.slug}
                      title={item.title}
                      aria-current={active ? "page" : undefined}
                    >
                      <Icon size={17} /><span>{item.title}</span>
                    </Link>
                  );
                })}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="staff-mini">
            <div className="avatar">{staff.full_name.trim().slice(0, 1).toUpperCase()}</div>
            <div><strong>{staff.full_name}</strong><small>{staff.role}{assignedBranch ? ` · ${assignedBranch.code}` : " · HQ"}</small></div>
          </div>
          <button className="button link" onClick={() => void signOut()} type="button"><LogOut size={15} /><span>Sign out</span></button>
        </div>
      </aside>
      <div className="main-area">
        <div className="topbar-header-wrapper">
          <header className="topbar">
            <div className="topbar-title-block" aria-live="polite">
            <h1 className="topbar-title">{pageHeading.title}</h1>
            <span className="topbar-arrow">{">"}</span>
            <span className="topbar-kicker">({pageHeading.section.toUpperCase()})</span>
            <span className="topbar-arrow">{"--->"}</span>
            <div className="topbar-date">
              {clock.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              <span> · {clock.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()}</span>
            </div>
          </div>
          <div className="topbar-right">
            {fullscreenError && <span className="fullscreen-error" role="status">{fullscreenError}</span>}
            <span className="branch-pill"><Store size={13} />{assignedBranch?.name || "HQ · All branches"}</span>
            <div className="zoom-control" aria-label="Display zoom">
              <button type="button" aria-label="Zoom out" title="Zoom out" disabled={zoomPercent <= 70} onClick={() => setZoomPercent(Math.max(70, zoomPercent - 10))}><ZoomOut size={14} /></button>
              <button type="button" className="zoom-reset" aria-label="Reset zoom to 100%" title="Reset zoom to 100%" onClick={() => setZoomPercent(100)}>{zoomPercent}%</button>
              <button type="button" aria-label="Zoom in" title="Zoom in" disabled={zoomPercent >= 130} onClick={() => setZoomPercent(Math.min(130, zoomPercent + 10))}><ZoomIn size={14} /></button>
            </div>
            <div className="theme-picker">
              <button
                className="icon-button"
                type="button"
                onClick={() => setThemeOpen((open) => !open)}
                aria-label="Change theme"
                aria-expanded={themeOpen}
                title="Change theme"
              >
                <Palette size={16} />
              </button>
              {themeOpen && (
                <div className="theme-menu" ref={themeMenuRef}>
                  <div className="theme-menu-title">Appearance</div>
                  {themeGroups.map((group) => (
                    <div className="theme-group" key={group.id}>
                      <div className="theme-group-title">{group.label}</div>
                      {appThemes.filter((theme) => theme.group === group.id).map((theme) => (
                        <button
                          key={theme.id}
                          type="button"
                          className={`theme-option ${theme.id === themeId ? "active" : ""}`}
                          onClick={() => { setThemeId(theme.id); setThemeOpen(false); }}
                        >
                          <span className="theme-swatch" style={{ "--theme-accent": theme.swatch, "--theme-background": theme.background } as React.CSSProperties} />
                          <span>{theme.name}</span>
                          {theme.id === themeId && <Check size={14} />}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="profile-picker">
              <button
                className="icon-button profile-button"
                type="button"
                onClick={() => setProfileOpen((open) => !open)}
                aria-label="User menu"
                aria-expanded={profileOpen}
                title={staff.full_name}
              >
                <User size={16} />
              </button>
              {profileOpen && (
                <div className="profile-menu" ref={profileMenuRef}>
                  <div className="profile-header">
                    <div className="profile-avatar">{staff.full_name.trim().slice(0, 1).toUpperCase()}</div>
                    <div className="profile-info">
                      <strong>{staff.full_name}</strong>
                      <small>{staff.role}{assignedBranch ? ` · ${assignedBranch.code}` : " · HQ"}</small>
                    </div>
                  </div>
                  <button className="profile-option" onClick={() => void signOut()} type="button">
                    <LogOut size={14} /><span>Sign out</span>
                  </button>
                </div>
              )}
            </div>
            <button
              className="icon-button fullscreen-toggle"
              type="button"
              onClick={() => void toggleFullscreen()}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              aria-pressed={isFullscreen}
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>
        </header>
        </div>
        <main className="content">
          {routeAllowed ? children : (
            <section className="card panel">
              <h1>{currentModule?.title || "This page"} is restricted</h1>
              <p className="muted">Your staff role does not have permission to view this page for this branch. Ask your manager or HQ administrator if you need access.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

export function ManagementShell({ children }: { children: ReactNode }) {
  const { staff, branches, moduleAccess, loading, error, signOut } = useStaffAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !staff && !error) router.replace("/login");
  }, [error, loading, router, staff]);

  if (loading) return <main className="auth-screen"><p className="muted">Loading your secure staff session…</p></main>;
  if (!staff && !error) return <main className="auth-screen"><p className="muted">Redirecting to sign in…</p></main>;
  if (error || !staff) {
    return (
      <main className="auth-screen">
        <section className="login-card">
          <BrandLockup />
          <p className="eyebrow">Staff access</p>
          <h1>Account unavailable</h1>
          <p className="muted">{error || "Your active staff profile could not be loaded."}</p>
          <button className="button secondary" onClick={() => void signOut()}>Sign out</button>
        </section>
      </main>
    );
  }

  return (
    <AppearanceProvider staffId={staff.user_id}>
      <BusinessSettingsProvider staffId={staff.user_id}>
        <ManagementShellContent
          children={children}
          staff={staff}
          branches={branches}
          moduleAccess={moduleAccess}
          signOut={signOut}
        />
      </BusinessSettingsProvider>
    </AppearanceProvider>
  );
}
