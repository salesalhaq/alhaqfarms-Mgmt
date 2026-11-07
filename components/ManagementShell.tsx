"use client";

import {
  ArrowLeftRight, BarChart3, Beef, BookUser, Boxes, BriefcaseBusiness, Building2,
  ClipboardList, Cloud, Factory, FlaskConical, Globe, LayoutDashboard, LogOut,
  MonitorSmartphone, Package, PackageCheck, PanelsTopLeft, Receipt, RotateCcw,
  Settings, ShoppingCart, Store, Tag, Tags, TrendingUp, Truck, Users, Wallet, Warehouse,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { BrandLockup } from "@/components/BrandLockup";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { workspaceSections } from "@/lib/workspace-modules";

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

export function ManagementShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { staff, branches, canViewOrders, loading, error, signOut } = useStaffAuth();
  const assignedBranch = branches.find((branch) => branch.id === staff?.branch_id);

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <BrandLockup className="brand-row" />
        <nav aria-label="Main navigation">
          {workspaceSections.filter((section) => canSeeSection(section.title)).map((section) => (
            <div className="nav-group" key={section.title}>
              <p className="nav-caption">{section.title}</p>
              {section.modules
                .filter((item) => item.slug !== "online-orders" || canViewOrders)
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
          <button className="button link" onClick={() => void signOut()} type="button"><LogOut size={15} /> Sign out</button>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <span className="topbar-kicker">Staff management workspace</span>
          <div className="topbar-right">
            <span className="branch-pill"><Store size={13} />{assignedBranch?.name || "HQ · All branches"}</span>
          </div>
        </header>
        <main className="content">
          {!pathname.startsWith("/orders") || canViewOrders ? children : (
            <section className="card panel">
              <h1>Online orders are restricted</h1>
              <p className="muted">Your staff role does not have the Orders module view permission for this branch. Ask your manager or HQ administrator if you need access.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
