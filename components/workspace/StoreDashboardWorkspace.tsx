"use client";

import {
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  CalendarRange,
  ClipboardList,
  LoaderCircle,
  PackageCheck,
  Receipt,
  ReceiptText,
  RotateCcw,
  Search,
  ShoppingCart,
  Store,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { formatDateTime, formatMoney, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";

type StoreDashboardRange = "today" | "7d" | "30d" | "month";

type StoreSale = {
  id: string;
  receipt_number: string;
  status: string;
  total_paisa: number;
  completed_at: string;
};

type StoreReturn = {
  id: string;
  return_number: string;
  status: string;
  refund_total_paisa: number;
  created_at: string;
};

type StoreOrder = {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  payment_review_status: string;
  total_paisa: number;
  created_at: string;
};

interface StoreDashboardSummary {
  salesCount: number;
  salesTotalPaisa: number;
  refundCount: number;
  refundTotalPaisa: number;
  orderCount: number;
  orderTotalPaisa: number;
  averageTicketPaisa: number;
}

interface StoreDashboardResponse {
  branchId: string | null;
  branchName: string;
  from: string;
  to: string;
  summary: StoreDashboardSummary;
  sales: StoreSale[];
  returns: StoreReturn[];
  orders: StoreOrder[];
  error?: string;
}

function rangeToDates(range: StoreDashboardRange): { from: Date; to: Date } {
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

function safeBranchName(branches: { id: string; name: string }[], branchId: string | null): string {
  if (!branchId || branchId === "all") return "All accessible branches";
  return branches.find((branch) => branch.id === branchId)?.name || "Selected branch";
}

function orderPaymentStatus(order: StoreOrder): string {
  return order.payment_review_status === "none" ? order.payment_status : order.payment_review_status;
}

export function StoreDashboardWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [branchId, setBranchId] = useState<string>(staff?.branch_id || "all");
  const [range, setRange] = useState<StoreDashboardRange>("7d");
  const [salesSearch, setSalesSearch] = useState("");
  const [salesStatus, setSalesStatus] = useState("all");
  const [returnsSearch, setReturnsSearch] = useState("");
  const [returnsStatus, setReturnsStatus] = useState("all");
  const [ordersSearch, setOrdersSearch] = useState("");
  const [ordersStatus, setOrdersStatus] = useState("all");
  const [ordersPaymentStatus, setOrdersPaymentStatus] = useState("all");
  const [data, setData] = useState<StoreDashboardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!staff) return;
    if (staff.branch_id) setBranchId(staff.branch_id);
    else if (staff.role === "admin") setBranchId("all");
  }, [staff?.branch_id, staff?.role]);

  useEffect(() => {
    setSalesSearch("");
    setSalesStatus("all");
    setReturnsSearch("");
    setReturnsStatus("all");
    setOrdersSearch("");
    setOrdersStatus("all");
    setOrdersPaymentStatus("all");
  }, [branchId, range]);

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
        const response = await fetch(`/api/workspace/store-dashboard?${params.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as StoreDashboardResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load the store dashboard.");
        setData(result);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the store dashboard.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, range, reloadKey, staff]);

  const selectedBranchName = useMemo(
    () => safeBranchName(branches, branchId),
    [branchId, branches],
  );

  const visibleSales = useMemo(() => {
    const query = salesSearch.trim().toLocaleLowerCase();
    return (data?.sales || []).filter((sale) =>
      (salesStatus === "all" || sale.status === salesStatus)
      && (!query || sale.receipt_number.toLocaleLowerCase().includes(query)));
  }, [data?.sales, salesSearch, salesStatus]);
  const visibleReturns = useMemo(() => {
    const query = returnsSearch.trim().toLocaleLowerCase();
    return (data?.returns || []).filter((returnItem) =>
      (returnsStatus === "all" || returnItem.status === returnsStatus)
      && (!query || returnItem.return_number.toLocaleLowerCase().includes(query)));
  }, [data?.returns, returnsSearch, returnsStatus]);
  const visibleOrders = useMemo(() => {
    const query = ordersSearch.trim().toLocaleLowerCase();
    return (data?.orders || []).filter((order) =>
      (ordersStatus === "all" || order.status === ordersStatus)
      && (ordersPaymentStatus === "all" || orderPaymentStatus(order) === ordersPaymentStatus)
      && (!query || order.order_number.toLocaleLowerCase().includes(query)));
  }, [data?.orders, ordersPaymentStatus, ordersSearch, ordersStatus]);
  const salesStatusOptions = useMemo(() => [
    { value: "all", label: "All statuses" },
    ...[...new Set((data?.sales || []).map((sale) => sale.status))].sort().map((status) => ({ value: status, label: labelize(status) })),
  ], [data?.sales]);
  const returnsStatusOptions = useMemo(() => [
    { value: "all", label: "All statuses" },
    ...[...new Set((data?.returns || []).map((returnItem) => returnItem.status))].sort().map((status) => ({ value: status, label: labelize(status) })),
  ], [data?.returns]);
  const orderStatusOptions = useMemo(() => [
    { value: "all", label: "All statuses" },
    ...[...new Set((data?.orders || []).map((order) => order.status))].sort().map((status) => ({ value: status, label: labelize(status) })),
  ], [data?.orders]);
  const orderPaymentOptions = useMemo(() => [
    { value: "all", label: "All payments" },
    ...[...new Set((data?.orders || []).map(orderPaymentStatus))].sort().map((status) => ({ value: status, label: labelize(status) })),
  ], [data?.orders]);

  const cards = data ? [
    {
      label: "Gross sales",
      value: formatMoney(data.summary.salesTotalPaisa),
      note: `${data.summary.salesCount} receipts in range`,
      icon: ShoppingCart,
    },
    {
      label: "Refunds",
      value: formatMoney(data.summary.refundTotalPaisa),
      note: `${data.summary.refundCount} returns processed`,
      icon: RotateCcw,
    },
    {
      label: "Store orders",
      value: String(data.summary.orderCount),
      note: formatMoney(data.summary.orderTotalPaisa) + " order value",
      icon: ReceiptText,
    },
    {
      label: "Average ticket",
      value: formatMoney(data.summary.averageTicketPaisa),
      note: "Across settled sales",
      icon: BarChart3,
    },
  ] : [];

  const jumpCards = [
    { slug: "receive-stock", title: "Receive stock", text: "Confirm incoming branch transfers line by line.", icon: PackageCheck },
    { slug: "store-orders", title: "Store orders", text: "Accept, pack and dispatch online orders.", icon: ClipboardList },
    { slug: "store-returns", title: "Store returns", text: "Raise and approve returns for this store.", icon: RotateCcw },
    { slug: "store-reports", title: "Store reports", text: "Daily sales, product mix and payment split.", icon: BarChart3 },
    { slug: "transfers", title: "Transfers", text: "Draft an outgoing transfer for another branch.", icon: ArrowLeftRight },
    { slug: "store-expenses", title: "Store expenses", text: "Record rent, utilities and other spending.", icon: Receipt },
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
            <select className="toolbar-select" value={range} onChange={(event) => setRange(event.target.value as StoreDashboardRange)}>
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

      {error ? (
        <div className="notice" role="alert">{error}</div>
      ) : null}

      {loading ? (
        <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading store dashboard…</div>
      ) : null}

      {!loading && data && (
        <>
          <section className="dashboard-stats" aria-label="Store dashboard summary">
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

          <div className="dashboard-grid">
            <section className="card table-wrap dashboard-recent-orders" aria-label="Recent sales">
              <div className="section-heading dashboard-table-heading">
                <div>
                  <p className="eyebrow page">Recent sales</p>
                  <h2>Sales</h2>
                </div>
                <TableDocumentTools tableId={`store-dashboard-sales-${branchId}-${range}`} title={`${item.title} recent sales`} disabled={!visibleSales.length} />
              </div>
              {data.sales.length ? (
                <>
                <HorizontalFilterScroller className="store-dashboard-table-filters" ariaLabel="Recent sales filters">
                  <label className="search-field store-dashboard-table-search">
                    <Search size={16} aria-hidden="true" />
                    <input aria-label="Search recent sales" placeholder="Search receipt number" value={salesSearch} onChange={(event) => setSalesSearch(event.target.value)} />
                  </label>
                  <label className="toolbar-control store-dashboard-table-filter">
                    <span>Status</span>
                    <SearchableFilter value={salesStatus} ariaLabel="Filter recent sales by status" placeholder="All statuses" options={salesStatusOptions} onChange={setSalesStatus} />
                  </label>
                </HorizontalFilterScroller>
                <table id={`store-dashboard-sales-${branchId}-${range}`}>
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>Status</th>
                      <th>Total</th>
                      <th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSales.map((sale) => (
                      <tr key={sale.id}>
                        <td><span className="primary-cell">{sale.receipt_number}</span></td>
                        <td><span className={`status ${statusTone(sale.status)}`}>{labelize(sale.status)}</span></td>
                        <td className="nowrap">{formatMoney(sale.total_paisa)}</td>
                        <td className="nowrap">{formatDateTime(sale.completed_at)}</td>
                      </tr>
                    ))}
                    {!visibleSales.length && <tr><td className="dashboard-table-empty" colSpan={4}>No sales match these filters.</td></tr>}
                  </tbody>
                </table>
                </>
              ) : (
                <div className="empty"><ShoppingCart size={23} /><h2>No sales in this range</h2><p>Try another period or branch selection.</p></div>
              )}
            </section>

            <section className="card table-wrap dashboard-recent-orders" aria-label="Recent returns">
              <div className="section-heading dashboard-table-heading">
                <div>
                  <p className="eyebrow page">Recent returns</p>
                  <h2>Returns</h2>
                </div>
                <TableDocumentTools tableId={`store-dashboard-returns-${branchId}-${range}`} title={`${item.title} recent returns`} disabled={!visibleReturns.length} />
              </div>
              {data.returns.length ? (
                <>
                <HorizontalFilterScroller className="store-dashboard-table-filters" ariaLabel="Recent returns filters">
                  <label className="search-field store-dashboard-table-search">
                    <Search size={16} aria-hidden="true" />
                    <input aria-label="Search recent returns" placeholder="Search return number" value={returnsSearch} onChange={(event) => setReturnsSearch(event.target.value)} />
                  </label>
                  <label className="toolbar-control store-dashboard-table-filter">
                    <span>Status</span>
                    <SearchableFilter value={returnsStatus} ariaLabel="Filter recent returns by status" placeholder="All statuses" options={returnsStatusOptions} onChange={setReturnsStatus} />
                  </label>
                </HorizontalFilterScroller>
                <table id={`store-dashboard-returns-${branchId}-${range}`}>
                  <thead>
                    <tr>
                      <th>Return</th>
                      <th>Status</th>
                      <th>Refund</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleReturns.map((returnItem) => (
                      <tr key={returnItem.id}>
                        <td><span className="primary-cell">{returnItem.return_number}</span></td>
                        <td><span className={`status ${statusTone(returnItem.status)}`}>{labelize(returnItem.status)}</span></td>
                        <td className="nowrap">{formatMoney(returnItem.refund_total_paisa)}</td>
                        <td className="nowrap">{formatDateTime(returnItem.created_at)}</td>
                      </tr>
                    ))}
                    {!visibleReturns.length && <tr><td className="dashboard-table-empty" colSpan={4}>No returns match these filters.</td></tr>}
                  </tbody>
                </table>
                </>
              ) : (
                <div className="empty"><RotateCcw size={23} /><h2>No returns in this range</h2><p>No return records were created for this branch and period.</p></div>
              )}
            </section>
          </div>

          <section className="card table-wrap dashboard-recent-orders" aria-label="Recent online orders">
            <div className="section-heading dashboard-table-heading">
              <div>
                <p className="eyebrow page">Recent orders</p>
                <h2>Store orders</h2>
              </div>
              <TableDocumentTools tableId={`store-dashboard-orders-${branchId}-${range}`} title={`${item.title} recent orders`} disabled={!visibleOrders.length} />
            </div>
            {data.orders.length ? (
              <>
              <HorizontalFilterScroller className="store-dashboard-table-filters" ariaLabel="Recent store order filters">
                <label className="search-field store-dashboard-table-search">
                  <Search size={16} aria-hidden="true" />
                  <input aria-label="Search recent store orders" placeholder="Search order number" value={ordersSearch} onChange={(event) => setOrdersSearch(event.target.value)} />
                </label>
                <label className="toolbar-control store-dashboard-table-filter">
                  <span>Status</span>
                  <SearchableFilter value={ordersStatus} ariaLabel="Filter recent store orders by status" placeholder="All statuses" options={orderStatusOptions} onChange={setOrdersStatus} />
                </label>
                <label className="toolbar-control store-dashboard-table-filter">
                  <span>Payment</span>
                  <SearchableFilter value={ordersPaymentStatus} ariaLabel="Filter recent store orders by payment" placeholder="All payments" options={orderPaymentOptions} onChange={setOrdersPaymentStatus} />
                </label>
              </HorizontalFilterScroller>
              <table id={`store-dashboard-orders-${branchId}-${range}`}>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Status</th>
                    <th>Payment</th>
                    <th>Total</th>
                    <th>Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((order) => {
                    const paymentStatus = orderPaymentStatus(order);
                    return (
                      <tr key={order.id}>
                        <td><span className="primary-cell">{order.order_number}</span></td>
                        <td><span className={`status ${statusTone(order.status)}`}>{labelize(order.status)}</span></td>
                        <td><span className={`status ${statusTone(paymentStatus)}`}>{labelize(paymentStatus)}</span></td>
                        <td className="nowrap">{formatMoney(order.total_paisa)}</td>
                        <td className="nowrap">{formatDateTime(order.created_at)}</td>
                      </tr>
                    );
                  })}
                  {!visibleOrders.length && <tr><td className="dashboard-table-empty" colSpan={5}>No orders match these filters.</td></tr>}
                  </tbody>
              </table>
              </>
            ) : (
              <div className="empty"><Store size={23} /><h2>No orders in this range</h2><p>Orders that match the selected branch and period will appear here.</p></div>
            )}
          </section>

          <p className="dashboard-period-note">
            {item.title} · {selectedBranchName} · {new Date(data.from).toLocaleDateString("en-PK", { dateStyle: "medium" })} to {new Date(data.to).toLocaleDateString("en-PK", { dateStyle: "medium" })}
          </p>

          <section className="overview-workspace">
            <div className="section-heading">
              <div><p className="eyebrow page">Store portal</p><h2>Jump to</h2></div>
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
