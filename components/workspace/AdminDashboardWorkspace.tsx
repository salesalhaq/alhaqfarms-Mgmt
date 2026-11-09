"use client";

import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  CalendarRange,
  ClipboardList,
  LoaderCircle,
  MonitorSmartphone,
  Receipt,
  RotateCcw,
  Settings,
  ShoppingCart,
  Users,
  Warehouse,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatDateTime, formatMoney, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { TableControls } from "@/components/workspace/TableControls";

type AdminDashboardRange = "today" | "7d" | "30d" | "month";

type SaleRow = {
  id: string;
  receipt_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  status: string;
  total_paisa: number;
  completed_at: string;
  branch_id: string | null;
};

type OrderRow = {
  id: string;
  order_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  status: string;
  payment_status: string | null;
  payment_review_status: string | null;
  total_paisa: number;
  created_at: string;
  branch_id: string | null;
};

type ReturnRow = {
  id: string;
  return_number: string;
  sale_id: string | null;
  status: string;
  refund_total_paisa: number;
  created_at: string;
  branch_id: string | null;
};

type CustomerRow = {
  customer_name: string;
  customer_phone: string | null;
  last_seen: string;
  transaction_count: number;
  total_paisa: number;
};

interface AdminDashboardSummary {
  salesCount: number;
  salesTotalPaisa: number;
  customerCount: number;
  orderCount: number;
  orderTotalPaisa: number;
  pendingReviewCount: number;
  openReturnCount: number;
  refundTotalPaisa: number;
}

interface AdminDashboardResponse {
  branchId: string | null;
  branchName: string;
  from: string;
  to: string;
  summary: AdminDashboardSummary;
  sales: SaleRow[];
  customers: CustomerRow[];
  orders: OrderRow[];
  returns: ReturnRow[];
  restrictionNote: string;
  error?: string;
}

function rangeToDates(range: AdminDashboardRange): { from: Date; to: Date } {
  const now = new Date();
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  const from = new Date(now);

  if (range === "today") {
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }

  if (range === "7d") {
    from.setDate(from.getDate() - 6);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }

  if (range === "30d") {
    from.setDate(from.getDate() - 29);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }

  from.setDate(1);
  from.setHours(0, 0, 0, 0);
  return { from, to };
}

function buildCustomerName(value: string | null | undefined): string {
  const cleaned = (value || "").trim();
  return cleaned || "Walk-in customer";
}

function buildCustomerKey(value: string | null | undefined): string {
  return buildCustomerName(value).toLowerCase();
}

function statusBadge(status: string | null | undefined): string {
  const tone = statusTone(status || "");
  return tone ? `status-badge ${tone}` : "status-badge";
}

function safeBranchName(branches: { id: string; name: string }[], branchId: string | null): string {
  if (!branchId || branchId === "all") return "All accessible branches";
  return branches.find((branch) => branch.id === branchId)?.name || "Selected branch";
}

export function AdminDashboardWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [branchId, setBranchId] = useState<string>(staff?.branch_id || "all");
  const [range, setRange] = useState<AdminDashboardRange>("7d");
  const [data, setData] = useState<AdminDashboardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!staff) return;
    if (staff.branch_id) setBranchId(staff.branch_id);
    else if (staff.role === "admin") setBranchId("all");
  }, [staff?.branch_id, staff?.role]);

  useEffect(() => {
    if (!staff) return;

    let active = true;
    setLoading(true);
    setError(null);
    setData(null);

    const { from, to } = rangeToDates(range);
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });

    if (branchId && branchId !== "all") params.set("branchId", branchId);
    else if (branchId === "all") params.set("branchId", "all");

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/admin-dashboard?${params.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as AdminDashboardResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load the admin dashboard.");
        setData(result);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the admin dashboard.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [branchId, range, reloadKey, staff]);

  const selectedBranchName = useMemo(
    () => safeBranchName(branches, branchId),
    [branchId, branches],
  );

  const cards = data ? [
    {
      label: "Gross sales",
      value: formatMoney(data.summary.salesTotalPaisa),
      note: `${data.summary.salesCount} receipts in range`,
      icon: ShoppingCart,
    },
    {
      label: "Customers",
      value: String(data.summary.customerCount),
      note: "Distinct customers in range",
      icon: Users,
    },
    {
      label: "Orders",
      value: String(data.summary.orderCount),
      note: formatMoney(data.summary.orderTotalPaisa) + " order value",
      icon: BarChart3,
    },
    {
      label: "Operations",
      value: String(data.summary.pendingReviewCount + data.summary.openReturnCount),
      note: `${data.summary.pendingReviewCount} reviews / ${data.summary.openReturnCount} returns`,
      icon: Warehouse,
    },
  ] : [];

  const restrictionText = data?.restrictionNote ||
    "Read-only aggregation from live synchronized sales, returns, and storefront orders.";

  const salesTableId = `admin-dashboard-sales-${branchId}-${range}`;
  const customerTableId = `admin-dashboard-customers-${branchId}-${range}`;
  const orderTableId = `admin-dashboard-orders-${branchId}-${range}`;
  const operationsTableId = `admin-dashboard-operations-${branchId}-${range}`;

  const jumpCards = [
    { slug: "staff-accounts", title: "Staff accounts", text: "Add cashiers, reset passwords, deactivate leavers.", icon: Users },
    { slug: "sales-reports", title: "Sales reports", text: "Range totals by day, cashier, product and payment.", icon: BarChart3 },
    { slug: "return-reports", title: "Return reports", text: "Refunds, reasons and restocked units.", icon: RotateCcw },
    { slug: "stock-reports", title: "Stock reports", text: "On-hand balances, valuation and low-stock queues.", icon: ClipboardList },
    { slug: "transfers", title: "Transfers", text: "Move stock between branches with dispatch and receive.", icon: ArrowLeftRight },
    { slug: "store-expenses", title: "Store expenses", text: "Rent, utilities and other non-supplier spending.", icon: Receipt },
    { slug: "devices", title: "Devices", text: "Register and approve cashier terminals.", icon: MonitorSmartphone },
    { slug: "settings", title: "Settings", text: "Branch identity, taxes, printing and sync.", icon: Settings },
  ];

  return (
    <div className="page-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description}</p>
        </div>
        <div className="dashboard-controls">
          {staff?.role === "admin" && !staff.branch_id && (
            <label className="toolbar-control">
              <span>Branch</span>
              <select className="toolbar-select" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                <option value="all">All accessible branches</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="toolbar-control">
            <span>Period</span>
            <select className="toolbar-select" value={range} onChange={(event) => setRange(event.target.value as AdminDashboardRange)}>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="month">This month</option>
            </select>
          </label>
          <button className="button secondary" type="button" disabled={loading} onClick={() => setReloadKey((value) => value + 1)}>
            {loading ? <LoaderCircle size={15} className="spin" /> : "Refresh"}
          </button>
        </div>
      </div>

      <div className="notice info" role="status">
        <AlertTriangle size={16} aria-hidden="true" />
        <span>{restrictionText}</span>
      </div>

      {error ? (
        <div className="notice" role="alert">{error}</div>
      ) : null}

      {loading ? (
        <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading admin dashboard…</div>
      ) : null}

      {!loading && data && (
        <>
          <section className="dashboard-stats" aria-label="Admin dashboard summary cards">
            {cards.map(({ label, value, note, icon: Icon }) => (
              <article className="dashboard-stat card" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>
                  <Icon size={14} aria-hidden="true" />
                  {note}
                </small>
              </article>
            ))}
          </section>

          <section className="card dashboard-panel" aria-label="Needs attention">
            <div className="section-heading">
              <div><p className="eyebrow page">Admin</p><h2>Needs attention</h2></div>
            </div>
            <div className="attention-list">
              <Link className="attention-row" href="/workspace/store-orders">
                <span className="attention-main"><strong>Payment reviews</strong><small>Storefront orders waiting for payment verification.</small></span>
                <span className={`status ${data.summary.pendingReviewCount ? "amber" : "green"}`}>{data.summary.pendingReviewCount}</span>
              </Link>
              <Link className="attention-row" href="/workspace/return-reports">
                <span className="attention-main"><strong>Open returns</strong><small>Returns that still need a manager decision.</small></span>
                <span className={`status ${data.summary.openReturnCount ? "amber" : "green"}`}>{data.summary.openReturnCount}</span>
              </Link>
              <Link className="attention-row" href="/workspace/stock-reports">
                <span className="attention-main"><strong>Stock pressure</strong><small>Review low-stock and reorder queues for this scope.</small></span>
                <span className="status">Stock reports</span>
              </Link>
            </div>
          </section>

          <div className="dashboard-grid">
            <div className="dashboard-table-item">
              {data.sales.length > 0 && <TableControls tableId={salesTableId} ariaLabel="Recent sales" filterColumns={[{ column: "Status" }]} />}
              <section className="card table-wrap dashboard-recent-orders" aria-label="Recent sales">
              <div className="section-heading dashboard-table-heading">
                <div>
                  <p className="eyebrow page">Recent sales</p>
                  <h2>Sales</h2>
                </div>
                <TableDocumentTools tableId={salesTableId} title={`${item.title} recent sales`} disabled={!data.sales.length} />
              </div>
              {data.sales.length ? (
                <table id={salesTableId}>
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>Customer</th>
                      <th>Status</th>
                      <th>Total</th>
                      <th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sales.map((sale) => (
                      <tr key={sale.id}>
                        <td>{sale.receipt_number}</td>
                        <td>{buildCustomerName(sale.customer_name)}</td>
                        <td><span className={statusBadge(sale.status)}>{labelize(sale.status)}</span></td>
                        <td>{formatMoney(sale.total_paisa)}</td>
                        <td>{formatDateTime(sale.completed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="empty-state">No sales were recorded in this period.</p>
              )}
              </section>
            </div>

            <div className="dashboard-table-item">
              {data.customers.length > 0 && <TableControls tableId={customerTableId} ariaLabel="Recent customer activity" />}
              <section className="card table-wrap dashboard-recent-orders" aria-label="Recent customer activity">
              <div className="section-heading dashboard-table-heading">
                <div>
                  <p className="eyebrow page">Customer activity</p>
                  <h2>Customers</h2>
                </div>
                <TableDocumentTools tableId={customerTableId} title={`${item.title} recent customers`} disabled={!data.customers.length} />
              </div>
              {data.customers.length ? (
                <table id={customerTableId}>
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th>Transactions</th>
                      <th>Value</th>
                      <th>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.customers.map((customer) => (
                      <tr key={`${customer.customer_name}-${customer.customer_phone || "phone-unknown"}`}>
                        <td>{customer.customer_name}</td>
                        <td>{customer.customer_phone || "—"}</td>
                        <td>{customer.transaction_count}</td>
                        <td>{formatMoney(customer.total_paisa)}</td>
                        <td>{formatDateTime(customer.last_seen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="empty-state">No customer activity was captured in this period.</p>
              )}
              </section>
            </div>

            <div className="dashboard-table-item">
              {data.orders.length > 0 && <TableControls tableId={orderTableId} ariaLabel="Recent online orders" filterColumns={[{ column: "Status" }, { column: "Payment" }]} />}
              <section className="card table-wrap dashboard-recent-orders" aria-label="Recent online orders">
              <div className="section-heading dashboard-table-heading">
                <div>
                  <p className="eyebrow page">Recent orders</p>
                  <h2>Operations</h2>
                </div>
                <TableDocumentTools tableId={orderTableId} title={`${item.title} recent orders`} disabled={!data.orders.length} />
              </div>
              {data.orders.length ? (
                <table id={orderTableId}>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Customer</th>
                      <th>Status</th>
                      <th>Payment</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orders.map((order) => (
                      <tr key={order.id}>
                        <td>{order.order_number}</td>
                        <td>{buildCustomerName(order.customer_name)}</td>
                        <td><span className={statusBadge(order.status)}>{labelize(order.status)}</span></td>
                        <td>{labelize(order.payment_review_status || order.payment_status || "unknown")}</td>
                        <td>{formatMoney(order.total_paisa)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="empty-state">No storefront orders were recorded in this period.</p>
              )}
              </section>
            </div>

            <div className="dashboard-table-item">
              {data.returns.length > 0 && <TableControls tableId={operationsTableId} ariaLabel="Recent returns and queue" filterColumns={[{ column: "Status" }]} />}
              <section className="card table-wrap dashboard-recent-orders" aria-label="Recent operations review">
              <div className="section-heading dashboard-table-heading">
                <div>
                  <p className="eyebrow page">Recent actions</p>
                  <h2>Returns & queue</h2>
                </div>
                <TableDocumentTools tableId={operationsTableId} title={`${item.title} operations`} disabled={!data.returns.length} />
              </div>
              {data.returns.length ? (
                <table id={operationsTableId}>
                  <thead>
                    <tr>
                      <th>Return</th>
                      <th>Source sale</th>
                      <th>Status</th>
                      <th>Refund</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.returns.map((returnRow) => (
                      <tr key={returnRow.id}>
                        <td>{returnRow.return_number}</td>
                        <td>{returnRow.sale_id || "—"}</td>
                        <td><span className={statusBadge(returnRow.status)}>{labelize(returnRow.status)}</span></td>
                        <td>{formatMoney(returnRow.refund_total_paisa)}</td>
                        <td>{formatDateTime(returnRow.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="empty-state">No return activity was recorded in this period.</p>
              )}
              </section>
            </div>
          </div>

          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="section-heading dashboard-table-heading">
              <div>
                <p className="eyebrow page">Scope</p>
                <h2>Access snapshot</h2>
              </div>
            </div>
            <p>
              Showing data for <strong>{selectedBranchName}</strong> between <strong>{formatDateTime(data.from)}</strong> and <strong>{formatDateTime(data.to)}</strong>.
              Only the records permitted by your role and branch access are included.
            </p>
          </div>

          <section className="overview-workspace">
            <div className="section-heading">
              <div><p className="eyebrow page">Admin</p><h2>Jump to</h2></div>
            </div>
            <div className="overview-action-grid">
              {jumpCards.map(({ slug, title, text, icon: Icon }) => (
                <Link className="overview-action-card card" href={`/workspace/${slug}`} key={slug}>
                  <span className="shortcut-icon"><Icon size={18} /></span>
                  <span className="shortcut-copy"><strong>{title}</strong><small>{text}</small></span>
                  <ArrowRight size={16} className="shortcut-arrow" />
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
