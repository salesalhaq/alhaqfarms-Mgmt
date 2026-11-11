"use client";

import {
  ArrowLeftRight, BarChart3, Beef, BookUser, Boxes, BriefcaseBusiness, Building2,
  Check, ClipboardList, Cloud, Factory, FlaskConical, Globe, LayoutDashboard, LogOut,
  Maximize2, Minimize2, MonitorSmartphone, Package, PackageCheck, Palette, PanelsTopLeft, Receipt, RotateCcw,
  Settings, ShoppingCart, Store, Tag, Tags, TrendingUp, Truck, Users, Wallet, Warehouse,
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

export function ManagementShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { staff, branches, moduleAccess, loading, error, signOut } = useStaffAuth();
  const { themeId, setThemeId } = useAppearance();
  const assignedBranch = branches.find((branch) => branch.id === staff?.branch_id);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
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
      if (themeMenuRef && !themeMenuRef.contains(event.target as Node)) setThemeOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [themeOpen]);

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
    <AppearanceProvider staffId={staff.user_id}>
    <BusinessSettingsProvider staffId={staff.user_id}>
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
        <header className="topbar">
          <div className="topbar-title-block" aria-live="polite">
            <span className="topbar-kicker">{pageHeading.section.toUpperCase()}</span>
            <h1 className="topbar-title">{pageHeading.title}</h1>
          </div>
          <div className="topbar-right">
            {fullscreenError && <span className="fullscreen-error" role="status">{fullscreenError}</span>}
            <span className="branch-pill"><Store size={13} />{assignedBranch?.name || "HQ · All branches"}</span>
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
                          <span className="theme-swatch" style={{ "--theme-accent": theme.swatch, "--theme-background": theme.background }} />
                          <span>{theme.name}</span>
                          {theme.id === themeId && <Check size={14} />}
                        </button>
                      ))}
                    </div>
                  ))}
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
    </BusinessSettingsProvider>
    </AppearanceProvider>
  );
}
