"use client";

import {
  AlertCircle, ChevronLeft, ChevronRight, Eye, LoaderCircle, Printer,
  RefreshCw, Search, X,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { ReceiptQr } from "@/components/workspace/ReceiptQr";
import { formatReportDate, formatReportMoney, formatReportQuantity } from "@/lib/print/document";
import {
  buildReceiptQrData,
  DEFAULT_RECEIPT_SETTINGS,
  receiptPageCss,
  receiptWidth,
} from "@/lib/print/receipt";
import { waitForReceiptQr } from "@/lib/print/print-window";
import { DEFAULT_BRAND_NAME } from "@/lib/branding";
import { generateSalesHistoryDocument } from "@/lib/print/reports";

interface SaleBase {
  id: string;
  receipt_number: string;
  branch_id: string;
  branch_name: string;
  cashier_id: string;
  cashier_name: string;
  customer_name: string;
  customer_phone: string | null;
  source_type: string;
  status: string;
  tax_mode: string;
  subtotal_paisa: number;
  item_discount_paisa: number;
  bill_discount_paisa: number;
  discount_paisa: number;
  tax_paisa: number;
  rounding_paisa: number;
  total_paisa: number;
  paid_paisa: number;
  due_paisa: number;
  change_paisa: number;
  loyalty_earned: number;
  loyalty_redeemed: number;
  loyalty_discount_paisa: number;
  completed_at: string;
}

interface SaleRow extends SaleBase {
  unit_count_milli: number;
  payment_methods: string[];
}

interface SaleItem {
  id: string;
  line_number: number;
  product_name: string;
  sku: string | null;
  unit_code: string;
  quantity_milli: number;
  unit_price_paisa: number;
  discount_paisa: number;
  tax_rate_bps: number;
  tax_paisa: number;
  line_total_paisa: number;
}

interface SalePayment {
  id: string;
  sequence_number: number;
  method: string;
  amount_paisa: number;
  tendered_paisa: number | null;
  reference: string | null;
}

interface SaleReturn {
  id: string;
  return_number: string;
  status: string;
  reason: string;
  refund_total_paisa: number;
  created_at: string;
}

interface CashierOption { id: string; name: string; }
interface SalesResponse {
  rows?: SaleRow[];
  total?: number;
  cashiers?: CashierOption[];
  sale?: SaleBase;
  items?: SaleItem[];
  payments?: SalePayment[];
  returns?: SaleReturn[];
  error?: string;
}

interface SaleDetails {
  sale: SaleBase;
  items: SaleItem[];
  payments: SalePayment[];
  returns: SaleReturn[];
}

const PAGE_SIZE = 25;
const SALES_STATUSES = ["all", "completed", "void", "refunded", "partially_refunded"] as const;

function localDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initialDateRange(): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return [localDateInput(from), localDateInput(to)];
}

function saleStatusTone(status: string): string {
  if (status === "completed") return "green";
  if (status === "void" || status === "refunded") return "red";
  if (status === "partially_refunded") return "amber";
  return statusTone(status);
}

export function SalesWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [from, to] = useMemo(initialDateRange, []);
  const [fromDate, setFromDate] = useState(from);
  const [toDate, setToDate] = useState(to);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [cashierId, setCashierId] = useState("");
  const [status, setStatus] = useState<(typeof SALES_STATUSES)[number]>("all");
  const [search, setSearch] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [debouncedCustomer, setDebouncedCustomer] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [cashiers, setCashiers] = useState<CashierOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedSaleId, setSelectedSaleId] = useState("");
  const [saleDetails, setSaleDetails] = useState<SaleDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const isAdmin = staff?.role === "admin";
  const receiptSettings = DEFAULT_RECEIPT_SETTINGS;
  const reportBranchName = branchId === "all"
    ? "All branches"
    : branches.find((branch) => branch.id === branchId)?.name || "Your branch";
  const canFilterCashiers = staff?.role === "admin" || staff?.role === "manager";
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setDebouncedCustomer(customerSearch.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [customerSearch, search]);

  useEffect(() => {
    if (staff?.role === "admin" && !branchId) setBranchId("all");
    else if (staff?.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff?.branch_id, staff?.role]);

  useEffect(() => {
    let active = true;
    if (!staff) {
      setLoading(false);
      return () => { active = false; };
    }

    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams({
      from: fromDate,
      to: toDate,
      status,
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (branchId) parameters.set("branchId", branchId);
    if (cashierId) parameters.set("cashierId", cashierId);
    if (debouncedSearch) parameters.set("search", debouncedSearch);
    if (debouncedCustomer) parameters.set("customer", debouncedCustomer);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/sales?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as SalesResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load sales history.");
        setRows(result.rows || []);
        setTotal(result.total || 0);
        setCashiers(result.cashiers || []);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load sales history.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, cashierId, debouncedCustomer, debouncedSearch, fromDate, page, reloadKey, staff, status, toDate]);

  useEffect(() => {
    if (!selectedSaleId) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedSaleId("");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedSaleId]);

  const pageTotals = useMemo(() => rows.reduce((totals, sale) => {
    if (sale.status !== "void") {
      totals.net += sale.total_paisa;
      totals.tax += sale.tax_paisa;
      totals.discount += sale.discount_paisa;
    }
    return totals;
  }, { net: 0, tax: 0, discount: 0 }), [rows]);

  const openReceipt = async (saleId: string) => {
    setSelectedSaleId(saleId);
    setSaleDetails(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/workspace/sales?detailId=${encodeURIComponent(saleId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as SalesResponse;
      if (!response.ok) throw new Error(result.error || "Could not load the sale receipt.");
      if (!result.sale) throw new Error("The sale receipt was not found.");
      setSaleDetails({
        sale: result.sale,
        items: result.items || [],
        payments: result.payments || [],
        returns: result.returns || [],
      });
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "Could not load the sale receipt.");
    } finally {
      setDetailLoading(false);
    }
  };

  const clearFilters = () => {
    const [defaultFrom, defaultTo] = initialDateRange();
    setFromDate(defaultFrom);
    setToDate(defaultTo);
    setBranchId(isAdmin ? "all" : staff?.branch_id || "");
    setCashierId("");
    setStatus("all");
    setSearch("");
    setCustomerSearch("");
    setPage(1);
  };

  const updateFilter = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setPage(1);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>Sales history</h1>
          <p>Search receipts, review itemized sales, and print a receipt. Records are read-only and scoped to your staff access.</p>
        </div>
      </div>

      <div className="live-readonly-note">
        <AlertCircle size={16} />
        <span>Live cloud records · read-only. Receipt details and printing do not change sales, inventory, payments, or returns.</span>
      </div>

      <section className="sales-history-filters card" aria-label="Sales history filters">
        <label className="search-field sales-history-search">
          <Search size={16} />
          <input
            aria-label="Search receipt number or customer phone"
            placeholder="Receipt number or customer phone"
            value={search}
            onChange={(event) => updateFilter(setSearch, event.target.value)}
          />
        </label>
        <label className="sales-history-control">
          <span>Customer</span>
          <input value={customerSearch} placeholder="All customers" onChange={(event) => updateFilter(setCustomerSearch, event.target.value)} />
        </label>
        <label className="sales-history-control">
          <span>From</span>
          <input type="date" aria-label="Sales from date" value={fromDate} max={toDate || undefined} onChange={(event) => updateFilter(setFromDate, event.target.value)} />
        </label>
        <label className="sales-history-control">
          <span>To</span>
          <input type="date" aria-label="Sales to date" value={toDate} min={fromDate || undefined} onChange={(event) => updateFilter(setToDate, event.target.value)} />
        </label>
        <label className="sales-history-control">
          <span>Status</span>
          <select value={status} onChange={(event) => updateFilter(setStatus, event.target.value as (typeof SALES_STATUSES)[number])}>
            {SALES_STATUSES.map((value) => <option key={value} value={value}>{value === "all" ? "All statuses" : labelize(value)}</option>)}
          </select>
        </label>
        {canFilterCashiers && (
          <label className="sales-history-control">
            <span>Cashier</span>
            <select value={cashierId} onChange={(event) => updateFilter(setCashierId, event.target.value)}>
              <option value="">All cashiers</option>
              {cashiers.map((cashier) => <option key={cashier.id} value={cashier.id}>{cashier.name}</option>)}
            </select>
          </label>
        )}
        {staff?.role === "cashier" && (
          <label className="sales-history-control">
            <span>Cashier</span>
            <select value={cashierId} onChange={(event) => updateFilter(setCashierId, event.target.value)}>
              <option value="">All cashiers</option>
              <option value="self">My sales</option>
            </select>
          </label>
        )}
        {isAdmin && (
          <label className="sales-history-control">
            <span>Branch</span>
            <select value={branchId} onChange={(event) => updateFilter(setBranchId, event.target.value)}>
              <option value="all">All branches</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
        <div className="sales-history-filter-actions">
          <button className="button secondary" disabled={loading} onClick={() => setReloadKey((value) => value + 1)} type="button">
            {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={14} />} REF
          </button>
          <button className="button link" onClick={clearFilters} type="button">Clear filters</button>
        </div>
      </section>

      {error && <div className="notice" role="alert">{error}</div>}
      <section className="card table-wrap workspace-table sales-history-table" aria-label="Sales history data">
        <div className="table-document-heading">
          <strong>Sales history · page {page}</strong>
          <TableDocumentTools
            tableId="sales-history-table"
            title="Sales history"
            orientationKey="sales-history"
            disabled={loading || Boolean(error) || !rows.length}
            buildDocument={(orientation) => rows.length
              ? generateSalesHistoryDocument({
                  rows,
                  period: `${formatReportDate(fromDate)} - ${formatReportDate(toDate)}`,
                  filterSummary: [
                    status !== "all" ? `Status: ${labelize(status)}` : "",
                    search ? `Search: ${search}` : "",
                    customerSearch ? `Customer: ${customerSearch}` : "",
                  ].filter(Boolean).join(" · "),
                }, {
                  branding: { businessName: DEFAULT_BRAND_NAME },
                  orientationPreference: orientation,
                  branch: reportBranchName,
                  printedBy: staff?.full_name || "Staff",
                })
              : null}
          />
        </div>
        {loading && rows.length === 0 ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading sales history…</div>
        ) : !error && rows.length === 0 ? (
          <div className="empty">
            <Search size={23} />
            <h2>No sales found</h2>
            <p>Adjust the date range or clear the search and filters.</p>
          </div>
        ) : !error ? (
          <table id="sales-history-table">
            <thead>
              <tr>
                <th>Receipt</th><th>Date</th><th>Customer</th><th>Cashier</th>
                {isAdmin && <th>Branch</th>}
                <th>Channel</th><th>Items</th><th>Payment</th><th>Total</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((sale) => (
                <tr key={sale.id}>
                  <td><button className="sales-receipt-link" onClick={() => void openReceipt(sale.id)} type="button">{sale.receipt_number}</button></td>
                  <td>{formatDateTime(sale.completed_at)}</td>
                  <td>{sale.customer_name || "Walk-in Customer"}{sale.customer_phone && <small className="sales-cell-subtext">{sale.customer_phone}</small>}</td>
                  <td>{sale.cashier_name}</td>
                  {isAdmin && <td>{sale.branch_name}</td>}
                  <td>{sale.source_type === "web_order" ? "Web" : "POS"}</td>
                  <td className="numeric-cell">{formatQuantity(sale.unit_count_milli)}</td>
                  <td>{sale.payment_methods.map(labelize).join(", ") || "—"}</td>
                  <td className="numeric-cell"><strong>{formatMoney(sale.total_paisa)}</strong></td>
                  <td><span className={`status ${saleStatusTone(sale.status)}`}>{labelize(sale.status)}</span></td>
                  <td>
                    <div className="row-actions">
                      <button className="button secondary sales-view-button" onClick={() => void openReceipt(sale.id)} type="button"><Eye size={14} /> View</button>
                      <button className="icon-button" title="Print receipt" aria-label={`Print ${sale.receipt_number}`} onClick={() => void openReceipt(sale.id)} type="button"><Printer size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {!loading && !error && (
        <div className="sales-history-footer">
          <div className="sales-history-totals">
            <span>Page net <strong>{formatMoney(pageTotals.net)}</strong></span>
            <span>Tax <strong>{formatMoney(pageTotals.tax)}</strong></span>
            <span>Discounts <strong>{formatMoney(pageTotals.discount)}</strong></span>
            <span>{total} sale{total === 1 ? "" : "s"} in range</span>
          </div>
          <div className="sales-pagination">
            <span>{total ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}` : "0 sales"}</span>
            <div>
              <button className="button secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button"><ChevronLeft size={14} /> Previous</button>
              <span>Page {page} of {pageCount}</span>
              <button className="button secondary" disabled={page >= pageCount || loading} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} type="button">Next <ChevronRight size={14} /></button>
            </div>
          </div>
        </div>
      )}

      {selectedSaleId && (
        <div className="sales-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedSaleId("");
        }}>
          <section aria-label="Sale receipt" aria-modal="true" className="sales-dialog card" role="dialog">
            <header className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Sale receipt</p>
                <h2>{saleDetails ? saleDetails.sale.receipt_number : "Receipt details"}</h2>
              </div>
              <button aria-label="Close receipt" className="button secondary" onClick={() => setSelectedSaleId("")} type="button"><X size={16} /></button>
            </header>
            {detailLoading && <div className="loading"><LoaderCircle size={18} className="spin" /> Loading receipt details…</div>}
            {detailError && <div className="notice" role="alert">{detailError}</div>}
            {saleDetails && (
              <>
                <div className="sales-detail-context">
                  <div><span>Status</span><strong className={`status ${saleStatusTone(saleDetails.sale.status)}`}>{labelize(saleDetails.sale.status)}</strong></div>
                  <div><span>Date</span><strong>{formatDateTime(saleDetails.sale.completed_at)}</strong></div>
                  <div><span>Customer</span><strong>{saleDetails.sale.customer_name || "Walk-in Customer"}</strong></div>
                  {saleDetails.sale.customer_phone && <div><span>Phone</span><strong>{saleDetails.sale.customer_phone}</strong></div>}
                  <div><span>Branch</span><strong>{saleDetails.sale.branch_name}</strong></div>
                  <div><span>Cashier</span><strong>{saleDetails.sale.cashier_name}</strong></div>
                </div>
                <style>{receiptPageCss(receiptSettings)}</style>
                <article
                  className="receipt-print"
                  style={{ "--print-receipt-width": receiptWidth(receiptSettings) } as CSSProperties}
                >
                  <header className="receipt-business">
                    {receiptSettings.showLogoOnReceipt && receiptSettings.logoDataUrl ? (
                      <img
                        src={receiptSettings.logoDataUrl}
                        alt=""
                        style={{ maxWidth: "36mm", maxHeight: "18mm", objectFit: "contain" }}
                      />
                    ) : null}
                    <strong>{receiptSettings.businessName || saleDetails.sale.branch_name}</strong>
                    {receiptSettings.businessTagline ? <small>{receiptSettings.businessTagline}</small> : null}
                    {receiptSettings.businessAddress ? <small>{receiptSettings.businessAddress}</small> : null}
                    {receiptSettings.businessPhone ? <small>{receiptSettings.businessPhone}</small> : null}
                    {receiptSettings.businessEmail ? <small>{receiptSettings.businessEmail}</small> : null}
                  </header>
                  <div className="receipt-meta">
                    <div><span>Receipt</span><strong>{saleDetails.sale.receipt_number}</strong></div>
                    <div><span>Date</span><strong>{new Date(saleDetails.sale.completed_at).toLocaleString()}</strong></div>
                    <div><span>Cashier</span><strong>{saleDetails.sale.cashier_name}</strong></div>
                    <div><span>Customer</span><strong>{saleDetails.sale.customer_name || "Walk-in Customer"}</strong></div>
                    {saleDetails.sale.customer_phone ? <div><span>Phone</span><strong>{saleDetails.sale.customer_phone}</strong></div> : null}
                  </div>
                  <div className="receipt-items">
                    {saleDetails.items.map((line) => (
                      <div className="receipt-item" key={line.id}>
                        <div>
                          <strong>{line.product_name}</strong>
                          <small>{formatReportQuantity(line.quantity_milli)} {line.unit_code} × {formatReportMoney(line.unit_price_paisa)}</small>
                          {line.discount_paisa > 0 && <small>Discount: − {formatReportMoney(line.discount_paisa)}</small>}
                        </div>
                        <strong>{formatReportMoney(line.line_total_paisa)}</strong>
                      </div>
                    ))}
                  </div>
                  <div className="receipt-totals">
                    <div><span>Subtotal</span><strong>{formatReportMoney(saleDetails.sale.subtotal_paisa)}</strong></div>
                    {saleDetails.sale.discount_paisa - saleDetails.sale.loyalty_discount_paisa > 0 && (
                      <div><span>Discount</span><strong>− {formatReportMoney(saleDetails.sale.discount_paisa - saleDetails.sale.loyalty_discount_paisa)}</strong></div>
                    )}
                    {saleDetails.sale.loyalty_redeemed > 0 && (
                      <div><span>{saleDetails.sale.loyalty_redeemed} loyalty points</span><strong>− {formatReportMoney(saleDetails.sale.loyalty_discount_paisa)}</strong></div>
                    )}
                    {receiptSettings.showTaxOnReceipt && (
                      receiptSettings.taxDisplay === "detailed"
                        ? [...new Set(saleDetails.items.map((line) => line.tax_rate_bps))].map((rate) => (
                            <div key={rate}>
                              <span>Tax {rate / 100}%</span>
                              <strong>{formatReportMoney(saleDetails.items.filter((line) => line.tax_rate_bps === rate).reduce((sum, line) => sum + line.tax_paisa, 0))}</strong>
                            </div>
                          ))
                        : <div><span>Tax ({saleDetails.sale.tax_mode})</span><strong>{formatReportMoney(saleDetails.sale.tax_paisa)}</strong></div>
                    )}
                    {saleDetails.sale.rounding_paisa !== 0 && (
                      <div><span>Rounding</span><strong>{formatReportMoney(saleDetails.sale.rounding_paisa)}</strong></div>
                    )}
                    <div className="receipt-total"><span>Total</span><strong>{formatReportMoney(saleDetails.sale.total_paisa)}</strong></div>
                    {saleDetails.sale.loyalty_earned > 0 && (
                      <div><span>Loyalty points earned</span><strong>{saleDetails.sale.loyalty_earned}</strong></div>
                    )}
                    {saleDetails.payments.map((payment) => (
                      <div key={payment.id}>
                        <span>
                          {payment.method.replaceAll("_", " ")}
                          {payment.reference ? <small className="sale-payment-reference">{payment.reference}</small> : null}
                        </span>
                        <strong>{formatReportMoney(payment.amount_paisa)}</strong>
                      </div>
                    ))}
                    {saleDetails.sale.due_paisa > 0 && <div><span>Due</span><strong>{formatReportMoney(saleDetails.sale.due_paisa)}</strong></div>}
                    {saleDetails.sale.change_paisa > 0 && <div><span>Change</span><strong>{formatReportMoney(saleDetails.sale.change_paisa)}</strong></div>}
                  </div>
                  {receiptSettings.returnPolicy ? <p className="receipt-thanks">{receiptSettings.returnPolicy}</p> : null}
                  <ReceiptQr
                    value={buildReceiptQrData({
                      sale: saleDetails.sale,
                      items: saleDetails.items,
                      payments: saleDetails.payments,
                      returns: saleDetails.returns,
                    })}
                    label="Scan for order details · not FBR verified"
                  />
                  <footer className="receipt-thanks">{receiptSettings.receiptFooter}</footer>
                </article>
                {saleDetails.returns.length > 0 && (
                  <section className="sales-return-history">
                    <h3>Returns</h3>
                    {saleDetails.returns.map((returnRecord) => (
                      <div key={returnRecord.id}>
                        <span>{returnRecord.return_number} · {labelize(returnRecord.status)} · {formatDateTime(returnRecord.created_at)}</span>
                        <strong>{formatMoney(returnRecord.refund_total_paisa)}</strong>
                      </div>
                    ))}
                  </section>
                )}
                <div className="sales-dialog-actions">
                  <button className="button" onClick={async () => { await waitForReceiptQr(); window.print(); }} type="button"><Printer size={15} /> Print receipt</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
