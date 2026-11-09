"use client";

import {
  Activity, ArrowRight, BarChart3, BriefcaseBusiness, ClipboardList, Cloud, LoaderCircle,
  Package, RotateCcw, Search, ShoppingCart, Store, Truck, Warehouse,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { getWorkspaceModule, type WorkspaceModule } from "@/lib/workspace-modules";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import type { Database } from "@/lib/supabase/database.types";
import { DailyReportWorkspace } from "@/components/workspace/DailyReportWorkspace";
import { BarcodeLabelsWorkspace } from "@/components/workspace/BarcodeLabelsWorkspace";
import { PointOfSaleWorkspace } from "@/components/workspace/PointOfSaleWorkspace";
import { SettingsWorkspace } from "@/components/workspace/SettingsWorkspace";
import { ReturnsWorkspace } from "@/components/workspace/ReturnsWorkspace";
import { SalesWorkspace } from "@/components/workspace/SalesWorkspace";
import { StockReportsWorkspace } from "@/components/workspace/StockReportsWorkspace";
import { StoreOrdersWorkspace } from "@/components/workspace/StoreOrdersWorkspace";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { TableControls } from "@/components/workspace/TableControls";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { TransfersWorkspace } from "@/components/workspace/TransfersWorkspace";
import { PurchasingWorkspace } from "@/components/workspace/PurchasingWorkspace";
import { ProductsWorkspace } from "@/components/workspace/ProductsWorkspace";
import { ErpWorkspace } from "@/components/workspace/ErpWorkspace";
import { InventoryWorkspace } from "@/components/workspace/InventoryWorkspace";
import { AdminDashboardWorkspace } from "@/components/workspace/AdminDashboardWorkspace";
import { AdminFinanceWorkspace } from "@/components/workspace/AdminFinanceWorkspace";
import { StoreDashboardWorkspace } from "@/components/workspace/StoreDashboardWorkspace";
import { StoreReportsWorkspace } from "@/components/workspace/StoreReportsWorkspace";
import { ReceiveStockWorkspace } from "@/components/workspace/ReceiveStockWorkspace";
import { ReportCenterWorkspace } from "@/components/workspace/ReportCenterWorkspace";
import { StaffAccountsWorkspace } from "@/components/workspace/StaffAccountsWorkspace";
import { DevicesWorkspace } from "@/components/workspace/DevicesWorkspace";
import { SalesReportsWorkspace } from "@/components/workspace/SalesReportsWorkspace";
import { ReturnReportsWorkspace } from "@/components/workspace/ReturnReportsWorkspace";
import { AdminPayrollWorkspace } from "@/components/workspace/AdminPayrollWorkspace";
import { AdminAuditWorkspace } from "@/components/workspace/AdminAuditWorkspace";
import { AdminExpensesWorkspace } from "@/components/workspace/AdminExpensesWorkspace";
import { FbrPctCategoriesWorkspace } from "@/components/workspace/FbrPctCategoriesWorkspace";
import { CloudSyncWorkspace } from "@/components/workspace/CloudSyncWorkspace";
import { postWorkspaceAction } from "@/lib/workspace/write-client";

type DashboardSale = Pick<
  Database["public"]["Tables"]["pos_sales"]["Row"],
  "id" | "receipt_number" | "status" | "total_paisa" | "completed_at"
>;
type DashboardReturn = Pick<
  Database["public"]["Tables"]["returns"]["Row"],
  "id" | "return_number" | "status" | "refund_total_paisa" | "created_at" | "completed_at"
>;
type DashboardOrder = Pick<
  Database["public"]["Tables"]["web_orders"]["Row"],
  "id" | "order_number" | "status" | "payment_status" | "payment_review_status" | "total_paisa" | "created_at"
>;
interface DashboardResponse {
  sales?: DashboardSale[];
  returns?: DashboardReturn[];
  orders?: DashboardOrder[];
  overview?: {
    productCount: number;
    stockCount: number;
    todaySales: { count: number; total: number };
    openShift: boolean;
  };
  error?: string;
}

interface OverviewDiscountRequest {
  id: string;
  branchId: string;
  branchName: string;
  cashierName: string;
  canReview: boolean;
  billDiscountPaisa: number;
  expiresAt: string;
}

interface OverviewDiscountResponse {
  requests?: OverviewDiscountRequest[];
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const dashboardTitles: Record<string, string> = {
  "admin-dashboard": "Online order activity",
  "store-dashboard": "Storefront order activity",
  "erp-dashboard": "Online order activity",
};

const dashboardLinks = [
  { slug: "point-of-sale", label: "Point of sale", detail: "Start a branch sale", icon: ShoppingCart },
  { slug: "products", label: "Products", detail: "Browse the catalog", icon: Package },
  { slug: "inventory", label: "Inventory", detail: "Review branch stock", icon: Warehouse },
  { slug: "sales", label: "Sales", detail: "Find a receipt", icon: ClipboardList },
  { slug: "online-orders", label: "Online orders", detail: "Review storefront orders", icon: Store },
  { slug: "cloud-sync", label: "Cloud sync", detail: "Check sync status", icon: Cloud },
];

function filterOptions(filter: string): string[] {
  const normalized = filter.toLowerCase();
  if (normalized.includes("date") || normalized.includes("period")) {
    return ["Today", "Last 7 days", "Last 30 days", "This month"];
  }
  if (normalized.includes("branch")) return ["All accessible branches"];
  if (normalized.includes("payment")) return ["All payment states", "Awaiting review", "Verified", "Rejected"];
  if (normalized.includes("category") || normalized.includes("report")) return [`All ${normalized.includes("category") ? "categories" : "reports"}`];
  if (normalized.includes("role")) return ["All roles", "Admin", "Manager", "Cashier"];
  if (normalized.includes("availability") || normalized.includes("stock level")) return ["All", "Available", "Low stock", "Out of stock"];
  return ["All statuses", "Open", "Pending", "Completed", "Cancelled"];
}

function StagedNotice() {
  return (
    <div className="workspace-preview-note" role="note">
      <Activity size={16} />
      <span><strong>Page layout preview.</strong> Live data, permissions, and save actions will be connected in the next phase. Nothing on this screen changes business records.</span>
    </div>
  );
}

const overviewActions = [
  { slug: "point-of-sale", label: "Point of sale", detail: "Search products, collect payment and record branch sales.", icon: ShoppingCart },
  { slug: "products", label: "Products", detail: "Maintain products, prices, categories and barcodes.", icon: Package },
  { slug: "inventory", label: "Inventory", detail: "Review branch stock and stock movements.", icon: Warehouse },
  { slug: "purchasing", label: "Purchasing", detail: "Manage supplier orders and received stock.", icon: Truck, managersOnly: true },
  { slug: "sales", label: "Sales", detail: "Search receipts and review completed sales.", icon: BriefcaseBusiness },
  { slug: "returns", label: "Returns", detail: "Review return requests and refund history.", icon: RotateCcw },
];

function localDayWindow() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function Overview({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [branchId, setBranchId] = useState(staff?.branch_id || "");
  const [metrics, setMetrics] = useState<DashboardResponse["overview"]>();
  const [discountRequests, setDiscountRequests] = useState<OverviewDiscountRequest[]>([]);
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [reviewingRequestId, setReviewingRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const canReviewDiscounts = staff?.role === "admin" || staff?.role === "manager";
  const isHqAdmin = staff?.role === "admin" && staff.branch_id === null;
  const actions = overviewActions.filter((action) =>
    !action.managersOnly || staff?.role === "admin" || staff?.role === "manager"
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setMetrics(undefined);
    const window = localDayWindow();
    const parameters = new URLSearchParams({ dayStart: window.start, dayEnd: window.end });
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/dashboard?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as DashboardResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load overview metrics.");
        if (!result.overview) throw new Error("Overview metrics were not returned.");
        setMetrics(result.overview);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load overview metrics.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, reloadKey]);

  useEffect(() => {
    if (!canReviewDiscounts) {
      setDiscountRequests([]);
      setDiscountError(null);
      return;
    }

    const requestBranchId = isHqAdmin ? (branchId || "all") : (staff?.branch_id || branchId);
    if (!requestBranchId) {
      setDiscountRequests([]);
      return;
    }

    let active = true;
    const loadRequests = async () => {
      try {
        const result = await postWorkspaceAction<OverviewDiscountResponse>(
          "/api/workspace/point-of-sale-discounts",
          { action: "list", branchId: requestBranchId },
        );
        if (!active) return;
        setDiscountRequests(result.requests || []);
        setDiscountError(null);
      } catch (loadError) {
        if (!active) return;
        setDiscountError(loadError instanceof Error ? loadError.message : "Could not load discount approvals.");
      }
    };

    void loadRequests();
    const timer = window.setInterval(() => void loadRequests(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [branchId, canReviewDiscounts, isHqAdmin, reloadKey, staff?.branch_id]);

  const reviewDiscountRequest = async (request: OverviewDiscountRequest, approve: boolean) => {
    setReviewingRequestId(request.id);
    setDiscountError(null);
    try {
      await postWorkspaceAction(
        "/api/workspace/point-of-sale-discounts",
        {
          action: approve ? "approve" : "decline",
          branchId: request.branchId,
          requestId: request.id,
        },
      );
      setReloadKey((value) => value + 1);
    } catch (reviewError) {
      setDiscountError(reviewError instanceof Error ? reviewError.message : "The discount request could not be reviewed.");
    } finally {
      setReviewingRequestId(null);
    }
  };

  return (
    <>
      <div className="page-heading overview-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>Business operations, in one place.</h1>
          <p>Catalog, stock, POS, purchasing and returns run on your staff account&apos;s cloud data. Branch access follows your signed-in permissions.</p>
        </div>
        {staff?.role === "admin" && !staff.branch_id && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select className="toolbar-select" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">All accessible branches</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && <div className="notice" role="alert">{error}</div>}
      {loading && <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading overview…</div>}

      {!loading && (
        <>
          <section className="dashboard-stats overview-stats" aria-label="Staff operations summary">
            <article className="dashboard-stat card"><span>Active products</span><strong>{metrics ? metrics.productCount.toLocaleString() : "Unavailable"}</strong></article>
            <article className="dashboard-stat card"><span>Branch stock</span><strong>{metrics ? `${formatQuantity(metrics.stockCount)} units` : "Unavailable"}</strong></article>
            <article className="dashboard-stat card"><span>Sales today</span><strong>{metrics ? metrics.todaySales.count.toLocaleString() : "Unavailable"}</strong><small>{metrics ? formatMoney(metrics.todaySales.total) : "Cloud metrics unavailable"}</small></article>
            <article className="dashboard-stat card"><span>Current shift</span><strong>{metrics ? (metrics.openShift ? "Open" : "Closed") : "Unavailable"}</strong><small>{metrics?.openShift ? "Register ready" : "Open from Point of sale"}</small></article>
          </section>

          {canReviewDiscounts && (
            <section className="card pos-held-sales-list" aria-label="Pending POS discount approvals">
              <div className="section-heading">
                <div><p className="eyebrow page">Manager review</p><h2>Discount approval requests</h2></div>
                <button
                  className="button secondary"
                  disabled={Boolean(reviewingRequestId)}
                  onClick={() => setReloadKey((value) => value + 1)}
                  type="button"
                >
                  Refresh
                </button>
              </div>
              {discountError && <div className="notice" role="alert">{discountError}</div>}
              {discountRequests.length === 0
                ? <p className="empty">No pending discount approvals.</p>
                : discountRequests.map((request) => (
                  <article className="pos-held-sale" key={request.id}>
                    <div>
                      <strong>{request.cashierName}</strong>
                      <small>{request.branchName}</small>
                      <small>Requested discount {formatMoney(request.billDiscountPaisa)}</small>
                      <small>Expires {new Date(request.expiresAt).toLocaleTimeString()}</small>
                    </div>
                    {request.canReview
                      ? <div>
                        <button
                          className="button"
                          disabled={Boolean(reviewingRequestId) || Date.parse(request.expiresAt) <= Date.now()}
                          onClick={() => void reviewDiscountRequest(request, true)}
                          type="button"
                        >
                          Approve
                        </button>
                        <button
                          className="button secondary"
                          disabled={Boolean(reviewingRequestId)}
                          onClick={() => void reviewDiscountRequest(request, false)}
                          type="button"
                        >
                          Decline
                        </button>
                      </div>
                      : <small>Another staff member must review this request.</small>}
                  </article>
                ))}
            </section>
          )}

          <section className="overview-workspace">
            <div className="section-heading">
              <div><p className="eyebrow page">Staff operations</p><h2>Quick access</h2></div>
              <button className="button secondary" onClick={() => setReloadKey((value) => value + 1)} type="button">Refresh</button>
            </div>
            <div className="overview-action-grid">
              {actions.map(({ slug, label, detail, icon: Icon }) => (
                <Link className="overview-action-card card" href={`/workspace/${slug}`} key={slug}>
                  <span className="shortcut-icon"><Icon size={18} /></span>
                  <span className="shortcut-copy"><strong>{label}</strong><small>{detail}</small></span>
                  <ArrowRight size={16} className="shortcut-arrow" />
                </Link>
              ))}
            </div>
          </section>

          <section className="overview-sync card">
            <span className="shortcut-icon"><Cloud size={19} /></span>
            <div><h2>{metrics ? "Cloud-connected staff view" : "Cloud metrics unavailable"}</h2><p>{metrics ? "Records shown here come from Supabase and are restricted by your staff account&apos;s existing branch access." : "Quick links remain available. Overview metrics will appear after the required Supabase migration is applied and the cloud query succeeds."}</p></div>
            <span className="overview-sync-tag">{metrics ? "Connected" : "Unavailable"}</span>
          </section>
        </>
      )}
    </>
  );
}

function Dashboard({ item }: { item: WorkspaceModule }) {
  const { staff, branches, canViewOrders } = useStaffAuth();
  const [branchId, setBranchId] = useState(staff?.branch_id || "");
  const [period, setPeriod] = useState("Today");
  const [sales, setSales] = useState<DashboardSale[]>([]);
  const [returns, setReturns] = useState<DashboardReturn[]>([]);
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const links = dashboardLinks.filter((entry) => entry.slug !== "online-orders" || canViewOrders);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";

    void (async () => {
      try {
        const response = await fetch(`/api/dashboard${query}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as DashboardResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load dashboard activity.");
        setSales(result.sales || []);
        setReturns(result.returns || []);
        setOrders(result.orders || []);
      } catch (dashboardError) {
        if (!active) return;
        setError(dashboardError instanceof Error ? dashboardError.message : "Could not load dashboard activity.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, canViewOrders, reloadKey]);

  const visibleSales = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    if (period === "Today") start.setHours(0, 0, 0, 0);
    else if (period === "Last 7 days") start.setDate(start.getDate() - 6);
    else if (period === "Last 30 days") start.setDate(start.getDate() - 29);
    else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    }
    return sales.filter((sale) => new Date(sale.completed_at) >= start && new Date(sale.completed_at) <= now);
  }, [period, sales]);
  const visibleReturns = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    if (period === "Today") start.setHours(0, 0, 0, 0);
    else if (period === "Last 7 days") start.setDate(start.getDate() - 6);
    else if (period === "Last 30 days") start.setDate(start.getDate() - 29);
    else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    }
    return returns.filter((item) => {
      const date = item.completed_at || item.created_at;
      return new Date(date) >= start && new Date(date) <= now;
    });
  }, [period, returns]);
  const visibleOrders = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    if (period === "Today") start.setHours(0, 0, 0, 0);
    else if (period === "Last 7 days") start.setDate(start.getDate() - 6);
    else if (period === "Last 30 days") start.setDate(start.getDate() - 29);
    else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    }
    return orders.filter((order) => new Date(order.created_at) >= start && new Date(order.created_at) <= now);
  }, [orders, period]);

  const paymentAwaiting = visibleOrders.filter((order) => order.payment_review_status === "awaiting_review").length;
  const verifiedPayments = visibleOrders.filter((order) =>
    order.payment_review_status === "verified" || order.payment_status === "paid"
  ).length;
  const salesTotalPaisa = visibleSales.reduce((sum, sale) => sum + sale.total_paisa, 0);
  const completedReturns = visibleReturns.filter((item) => item.status === "completed");
  const refundedPaisa = completedReturns.reduce((sum, item) => sum + item.refund_total_paisa, 0);
  const trend = useMemo(() => {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - 13);
    start.setHours(0, 0, 0, 0);
    const buckets = new Map<string, { count: number; total: number }>();
    for (let offset = 0; offset < 14; offset += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + offset);
      buckets.set(localDateKey(date), { count: 0, total: 0 });
    }
    for (const sale of sales) {
      const key = localDateKey(new Date(sale.completed_at));
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count += 1;
        bucket.total += sale.total_paisa;
      }
    }
    return [...buckets.entries()].map(([day, values]) => ({ day, ...values }));
  }, [sales]);
  const maxDailySales = Math.max(1, ...trend.map((day) => day.count));
  const dashboardTitle = dashboardTitles[item.slug] || dashboardTitles.overview;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} This page summarizes synchronized sales and returns, plus storefront orders when your role can view them.</p>
        </div>
        <HorizontalFilterScroller className="overview-dashboard-filterbar" ariaLabel="Dashboard filters">
          {staff?.role === "admin" && !staff.branch_id && (
            <label className="toolbar-control" style={{ flex: "0 0 220px" }}>
              <span>Branch</span>
              <SearchableFilter
                value={branchId}
                ariaLabel="Filter dashboard by branch"
                placeholder="All accessible branches"
                options={[
                  { value: "", label: "All accessible branches" },
                  ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
                ]}
                onChange={setBranchId}
              />
            </label>
          )}
          <label className="toolbar-control" style={{ flex: "0 0 175px" }}>
            <span>Period</span>
            <SearchableFilter
              value={period}
              ariaLabel="Filter dashboard by period"
              placeholder="Select period"
              options={["Today", "Last 7 days", "Last 30 days", "This month"].map((value) => ({ value, label: value }))}
              onChange={setPeriod}
            />
          </label>
          <button className="button secondary" disabled={loading} onClick={() => setReloadKey((value) => value + 1)} type="button">
            {loading ? <LoaderCircle size={15} className="spin" /> : "Refresh"}
          </button>
        </HorizontalFilterScroller>
      </div>

      {error ? (
        <div className="notice" role="alert">{error}</div>
      ) : loading ? (
        <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading branch sales activity…</div>
      ) : null}

      {!loading && !error && (
        <>
          <section className="dashboard-stats" aria-label={`${item.title} summary`}>
            <article className="dashboard-stat card"><span>Sales in period</span><strong>{visibleSales.length}</strong><small>Latest 100 synchronized receipts</small></article>
            <article className="dashboard-stat card"><span>Sales value</span><strong>{formatMoney(salesTotalPaisa)}</strong><small>Within the loaded receipt sample</small></article>
            <article className="dashboard-stat card"><span>Completed returns</span><strong>{completedReturns.length}</strong><small>{formatMoney(refundedPaisa)} refunded</small></article>
            <article className="dashboard-stat card"><span>{canViewOrders ? "Online orders" : "Unreviewed returns"}</span><strong>{canViewOrders ? visibleOrders.length : visibleReturns.filter((item) => item.status === "pending").length}</strong><small>{canViewOrders ? `${paymentAwaiting} awaiting payment review` : "Within the loaded return sample"}</small></article>
          </section>

          <div className="dashboard-grid">
            <section className="card dashboard-panel">
              <div className="section-heading">
                <div><p className="eyebrow page">Activity</p><h2>Sales receipts · last 14 days</h2></div>
                <BarChart3 size={19} aria-hidden="true" />
              </div>
              <div className="chart-bars" role="img" aria-label="Daily synchronized sales counts for the last 14 days">
                {trend.map((day) => (
                  <div className="chart-bar-column" key={day.day} title={`${day.day}: ${day.count} receipts · ${formatMoney(day.total)}`}>
                    <span className="chart-bar-value">{day.count || ""}</span>
                    <div className="chart-bar-track"><span style={{ height: `${Math.max(day.count ? 8 : 0, day.count / maxDailySales * 100)}%` }} /></div>
                    <small>{new Date(`${day.day}T12:00:00`).toLocaleDateString("en-PK", { day: "numeric", month: "short" })}</small>
                  </div>
                ))}
              </div>
              <p className="dashboard-period-note">Trend includes only the latest 100 receipts returned for your authorized branch scope.</p>
            </section>
            <section className="card dashboard-panel">
              <div className="section-heading">
                <div><p className="eyebrow page">Action required</p><h2>Awaiting payment review</h2></div>
                <ClipboardList size={19} aria-hidden="true" />
              </div>
              {canViewOrders && visibleOrders.filter((order) => order.payment_review_status === "awaiting_review").length ? (
                <div className="dashboard-alert-list">
                  {visibleOrders.filter((order) => order.payment_review_status === "awaiting_review").slice(0, 5).map((order) => (
                    <Link className="dashboard-alert-row" href={`/orders/${order.id}`} key={order.id}>
                      <span><strong>{order.order_number}</strong><small>{formatDateTime(order.created_at)}</small></span>
                      <span className="dashboard-alert-total">{formatMoney(order.total_paisa)} <ArrowRight size={14} /></span>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="dashboard-empty">
                  {canViewOrders
                    ? "No payments are awaiting review in this period."
                    : `There are ${visibleReturns.filter((item) => item.status === "pending").length} returns awaiting a manager decision in the loaded sample.`}
                </div>
              )}
            </section>
          </div>

          <section className="dashboard-shortcuts">
            <div className="section-heading">
              <div><p className="eyebrow page">Workspace</p><h2>Quick access</h2></div>
              <Link className="dashboard-view-all" href="/orders">View all orders <ArrowRight size={14} /></Link>
            </div>
            <div className="shortcut-grid">
              {links.map(({ slug, label, detail, icon: Icon }) => {
                const href = slug === "online-orders" ? "/orders" : `/workspace/${slug}`;
                return (
                  <Link className="shortcut-card card" href={href} key={slug}>
                    <span className="shortcut-icon"><Icon size={18} /></span>
                    <span className="shortcut-copy"><strong>{label}</strong><small>{detail}</small></span>
                    <ArrowRight size={16} className="shortcut-arrow" />
                  </Link>
                );
              })}
            </div>
          </section>

          <p className="dashboard-period-note">{dashboardTitle} · {period}{branchId ? ` · ${branches.find((branch) => branch.id === branchId)?.name || "Selected branch"}` : " · all authorized branches"}</p>
          {visibleSales.length > 0 && (
            <TableControls
              tableId={`dashboard-sales-${item.slug}`}
              ariaLabel="Recent sales receipts"
              filterColumns={[{ column: "Status" }]}
            />
          )}
          <section className="card table-wrap dashboard-recent-orders" aria-label="Recent sales receipts">
            <div className="section-heading dashboard-table-heading">
              <h2>Recent sales</h2>
              <span>Latest {sales.length} receipts</span>
              <TableDocumentTools tableId={`dashboard-sales-${item.slug}`} title={`${dashboardTitle} recent sales`} disabled={!visibleSales.length} />
            </div>
            {visibleSales.length ? (
              <table id={`dashboard-sales-${item.slug}`}>
                <thead><tr><th>Receipt</th><th>Status</th><th>Total</th><th>Completed</th></tr></thead>
                <tbody>{visibleSales.slice(0, 5).map((sale) => (
                    <tr key={sale.id}>
                      <td><span className="primary-cell">{sale.receipt_number}</span></td>
                      <td><span className={`status ${statusTone(sale.status)}`}>{labelize(sale.status)}</span></td>
                      <td className="nowrap">{formatMoney(sale.total_paisa)}</td>
                      <td className="nowrap">{formatDateTime(sale.completed_at)}</td>
                    </tr>
                  ))}</tbody>
              </table>
            ) : (
              <div className="empty"><ClipboardList size={23} /><h2>No sales in this period</h2><p>Try a longer date range or check back after the next receipt syncs.</p></div>
            )}
          </section>

          {canViewOrders && (
            <>
            {visibleOrders.length > 0 && (
              <TableControls
                tableId={`dashboard-orders-${item.slug}`}
                ariaLabel="Recent online orders"
                filterColumns={[{ column: "Status" }, { column: "Payment" }]}
              />
            )}
            <section className="card table-wrap dashboard-recent-orders" aria-label="Recent online orders">
              <div className="section-heading dashboard-table-heading">
                <h2>Recent online orders</h2>
                <Link className="dashboard-view-all" href="/orders">View all <ArrowRight size={14} /></Link>
                <TableDocumentTools tableId={`dashboard-orders-${item.slug}`} title={`${dashboardTitle} recent online orders`} disabled={!visibleOrders.length} />
              </div>
              {visibleOrders.length ? (
                <table id={`dashboard-orders-${item.slug}`}>
                  <thead><tr><th>Order</th><th>Status</th><th>Payment</th><th>Total</th><th>Placed</th><th /></tr></thead>
                  <tbody>{visibleOrders.slice(0, 5).map((order) => {
                    const paymentState = order.payment_review_status === "none" ? order.payment_status : order.payment_review_status;
                    return (
                      <tr key={order.id}>
                        <td><span className="primary-cell">{order.order_number}</span></td>
                        <td><span className={`status ${statusTone(order.status)}`}>{labelize(order.status)}</span></td>
                        <td><span className={`status ${statusTone(paymentState)}`}>{labelize(paymentState)}</span></td>
                        <td className="nowrap">{formatMoney(order.total_paisa)}</td>
                        <td className="nowrap">{formatDateTime(order.created_at)}</td>
                        <td><Link className="row-link" aria-label={`View ${order.order_number}`} href={`/orders/${order.id}`}><ArrowRight size={16} /></Link></td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              ) : (
                <div className="empty"><ClipboardList size={23} /><h2>No online orders in this period</h2><p>Try a longer date range or check back after orders arrive.</p></div>
              )}
            </section>
            </>
          )}
        </>
      )}
    </>
  );
}

function ModulePreview({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const canChooseBranch = staff?.role === "admin" && !staff.branch_id && item.filters.some((filter) => filter.toLowerCase().includes("branch"));

  const clearFilters = () => {
    setSearch("");
    setFilters({});
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description}</p>
        </div>
        {item.actionLabel && (
          <button
            className="button"
            disabled
            title="This action will be enabled after its data flow and authorization are implemented."
            type="button"
          >
            {item.actionLabel}
          </button>
        )}
      </div>

      <StagedNotice />

      <div className="workspace-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label={item.searchLabel}
            placeholder={item.searchLabel}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {canChooseBranch && (
          <label className="visually-hidden-label">
            Branch
            <select
              className="toolbar-select"
              value={filters.Branch || ""}
              onChange={(event) => setFilters((current) => ({ ...current, Branch: event.target.value }))}
            >
              <option value="">All accessible branches</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
        {item.filters.map((filter) => {
          if (filter.toLowerCase().includes("branch") && canChooseBranch) return null;
          return (
            <label className="visually-hidden-label" key={filter}>
              {filter}
              <select
                className="toolbar-select"
                value={filters[filter] || ""}
                onChange={(event) => setFilters((current) => ({ ...current, [filter]: event.target.value }))}
              >
                <option value="">{filterOptions(filter)[0]}</option>
                {filterOptions(filter).slice(1).map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
          );
        })}
        <button className="button secondary" onClick={clearFilters} type="button">Clear</button>
      </div>

      <section className="card table-wrap workspace-table" aria-label={`${item.title} preview`}>
        <div className="table-document-heading">
          <strong>{item.title} preview</strong>
          <TableDocumentTools tableId={`module-preview-${item.slug}`} title={item.title} />
        </div>
        <table id={`module-preview-${item.slug}`}>
          <thead><tr>{item.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            <tr>
              <td colSpan={item.columns.length}>
                <div className="empty">
                  <ClipboardList size={23} />
                  <h2>{search ? "No matching records" : `${item.title} data is not connected yet`}</h2>
                  <p>{search ? "Clear the search or adjust the filters." : "This page layout is ready for its data, permissions, and workflow in the next phase."}</p>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <div className="preview-controls-note">
        Controls are shown for the page layout pass. They do not load or edit live records yet.
      </div>
    </>
  );
}

export function WorkspacePage({ moduleSlug }: { moduleSlug: string }) {
  const item = getWorkspaceModule(moduleSlug);
  if (!item) return null;

  if (item.section === "Farm ERP") return <ErpWorkspace key={item.slug} item={item} />;

  const isDashboard = Object.hasOwn(dashboardTitles, item.slug);
  if (item.slug === "overview") return <Overview item={item} />;
  if (item.slug === "point-of-sale") return <PointOfSaleWorkspace item={item} />;
  if (item.slug === "sales") return <SalesWorkspace item={item} />;
  if (item.slug === "returns") return <ReturnsWorkspace item={item} />;
  if (item.slug === "admin-dashboard") return <AdminDashboardWorkspace item={item} />;
  if (item.slug === "store-orders" || item.slug === "online-orders") return <StoreOrdersWorkspace item={item} />;
  if (item.slug === "daily-report") return <DailyReportWorkspace item={item} />;
  if (item.slug === "barcode-labels") return <BarcodeLabelsWorkspace item={item} />;
  if (item.slug === "settings") return <SettingsWorkspace item={item} />;
  if (item.slug === "inventory") return <InventoryWorkspace item={item} />;
  if (item.slug === "purchasing") return <PurchasingWorkspace item={item} />;
  if (item.slug === "transfers") return <TransfersWorkspace item={item} />;
  if (item.slug === "stock-reports") return <StockReportsWorkspace item={item} />;
  if (item.slug === "profit-tax") return <AdminFinanceWorkspace item={item} />;
  if (item.slug === "products") {
    return <ProductsWorkspace item={item} />;
  }
  if (item.slug === "store-dashboard") return <StoreDashboardWorkspace item={item} />;
  if (item.slug === "store-returns") return <ReturnsWorkspace item={item} />;
  if (item.slug === "store-reports") return <StoreReportsWorkspace item={item} />;
  if (item.slug === "receive-stock") return <ReceiveStockWorkspace item={item} />;
  if (item.slug === "report-center") return <ReportCenterWorkspace item={item} />;
  if (item.slug === "staff-accounts") return <StaffAccountsWorkspace item={item} />;
  if (item.slug === "devices") return <DevicesWorkspace item={item} />;
  if (item.slug === "sales-reports") return <SalesReportsWorkspace item={item} />;
  if (item.slug === "return-reports") return <ReturnReportsWorkspace item={item} />;
  if (item.slug === "hr-payroll") return <AdminPayrollWorkspace item={item} />;
  if (item.slug === "audit-log") return <AdminAuditWorkspace item={item} />;
  if (item.slug === "store-expenses") return <AdminExpensesWorkspace item={item} />;
  if (item.slug === "fbr-pct-categories") return <FbrPctCategoriesWorkspace item={item} />;
  if (item.slug === "cloud-sync") return <CloudSyncWorkspace item={item} />;
  return isDashboard ? <Dashboard item={item} /> : <ModulePreview item={item} />;
}
