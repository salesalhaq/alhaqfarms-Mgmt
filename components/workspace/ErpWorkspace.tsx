"use client";

import {
  AlertCircle, ArrowRight, BarChart3, CheckCircle2, ClipboardList, CreditCard, Download, Eye, FileText, LoaderCircle, Lock,
  MapPin, Pencil, Plus, Power, Printer, RefreshCw, Search, Store, Trash2, X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { TableControls } from "@/components/workspace/TableControls";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import type { GeneratedDocument, PrintOrientation } from "@/lib/print/document";
import { generateErpReportDocument } from "@/lib/print/reports";
import { printHtmlDocument } from "@/lib/print/print-window";
import { WorkspaceDialog, WorkspaceError, WorkspaceField } from "@/components/workspace/WorkspaceDialog";
import { ErpProductionActions } from "@/components/workspace/ErpProductionActions";
import { ErpSpiceActions } from "@/components/workspace/ErpSpiceActions";
import { ErpBulkSalesActions } from "@/components/workspace/ErpBulkSalesActions";
import { ErpVendorActions, type Vendor, type VendorReceipt, type VendorRequest } from "@/components/workspace/ErpVendorActions";
import { ErpFarmStoreActions, type FarmStore } from "@/components/workspace/ErpFarmStoreActions";
import {
  ErpCustomerAccountActions,
  type CustomerAccount,
  type CustomerAccountRequest,
} from "@/components/workspace/ErpCustomerAccountActions";
import { ErpExpenseActions, type ExpenseCategory } from "@/components/workspace/ErpExpenseActions";

type ErpRow = Record<string, any>;
type BranchOption = { id: string; name: string };
type SpiceBatchAction = {
  id: string;
  batch_number: string;
  name: string;
  status: string;
  output_product_name: string;
  input_cost_paisa: number;
  labor_cost_paisa: number;
  other_cost_paisa: number;
};
type BulkSalePaymentTarget = { id: string; invoice_number: string; due_paisa: number };

interface ErpOverview {
  animals: { openBatches: number; heads: number; purchaseCostPaisa: number; feedCostPaisa: number };
  production: { runs: number; costPaisa: number };
  spice: { openBatches: number; completedThisMonth: number; completedCostPaisa: number };
  bulk: { invoices: number; totalPaisa: number; duePaisa: number };
  customers: { accounts: number; receivablePaisa: number };
  vendors: { duePaisa: number };
  expenses: { count: number; totalPaisa: number };
  stores: number;
  today: string;
  month: string;
  approximate: boolean;
}

interface ErpTrendDay {
  day: string;
  purchasesPaisa: number;
  wholesalePaisa: number;
  expensesPaisa: number;
}

interface ErpReport {
  range: { from: string; to: string };
  bulk: { invoices: number; totalPaisa: number; discountPaisa: number; paidPaisa: number };
  customers: { invoices: number; invoicedPaisa: number; payments: number; paidPaisa: number };
  production: {
    runs: number; inputCostPaisa: number; overheadPaisa: number; totalCostPaisa: number;
    top: { name: string; runs: number; quantityMilli: number; totalCost: number }[];
  };
  spice: {
    batches: number; inputCostPaisa: number; laborCostPaisa: number; otherCostPaisa: number;
    totalCostPaisa: number; outputQuantityMilli: number; batchRows: ErpRow[];
  };
  animals: {
    mortality: number; purchased: number; purchaseCostPaisa: number; sold: number;
    feedCostPaisa: number; feedQuantityMilli: number;
  };
  expenses: {
    count: number; totalPaisa: number;
    byCategory: { name: string; count: number; total: number }[];
  };
  purchases: {
    receipts: number; totalPaisa: number; payments: number; paidPaisa: number;
    returns: number; returnedPaisa: number;
  };
  approximate: boolean;
}

interface ErpDetail {
  record: ErpRow;
  items?: ErpRow[];
  secondaryItems?: ErpRow[];
  payments?: ErpRow[];
  summary?: Record<string, any>;
}

interface ErpResponse {
  module?: string;
  branchId?: string;
  branches?: BranchOption[];
  limit?: number;
  approximate?: boolean;
  rows?: ErpRow[];
  categories?: ExpenseCategory[];
  overview?: ErpOverview;
  trend?: ErpTrendDay[];
  report?: ErpReport;
  detail?: ErpDetail;
  error?: string;
}

type AnimalSpeciesOption = { id: string; name: string; is_active: number; sort_order: number };
type AnimalProductOption = { id: string; name: string; unit_code: string; cost_price_paisa: number; stock_milli: number };
type AnimalBatchForm = {
  id: string;
  branchId: string;
  name: string;
  speciesId: string;
  batchType: string;
  openingHeads: string;
  openingCost: string;
  openingDate: string;
  notes: string;
};
type AnimalEventForm = {
  eventType: string;
  eventDate: string;
  heads: string;
  purchaseCost: string;
  quantity: string;
  unitCost: string;
  productId: string;
  notes: string;
};
type AnimalSpeciesForm = { id: string; name: string; sortOrder: string; isActive: boolean };
type AnimalDialogState =
  | { kind: "batch"; form: AnimalBatchForm; error: string | null }
  | { kind: "event"; batchId: string; batchName: string; form: AnimalEventForm; error: string | null }
  | { kind: "close"; batchId: string; batchName: string; error: string | null }
  | { kind: "species-list"; error: string | null }
  | { kind: "species-form"; form: AnimalSpeciesForm; error: string | null };

const ERP_LINKS = [
  { slug: "animals", label: "Animals", detail: "Batches, head counts and feed" },
  { slug: "production", label: "Production", detail: "Runs, inputs and outputs" },
  { slug: "spice", label: "Spice", detail: "Batches, grades and yields" },
  { slug: "bulk-sales", label: "Bulk sales", detail: "Invoices and balances" },
  { slug: "vendors", label: "Vendors", detail: "Purchases and payables" },
  { slug: "farm-stores", label: "Farm stores", detail: "Store network and stock" },
  { slug: "customer-accounts", label: "Customer accounts", detail: "Receivables and activity" },
  { slug: "erp-expenses", label: "ERP expenses", detail: "Farm and production spend" },
  { slug: "erp-reports", label: "ERP reports", detail: "Combined farm ledgers" },
];

const DATE_MODULES = new Set(["erp-dashboard", "production", "spice", "bulk-sales", "erp-expenses", "erp-reports"]);
const DETAIL_MODULES = new Set(["animals", "production", "spice", "bulk-sales", "vendors", "customer-accounts"]);
const ANIMAL_EVENT_TYPES = [
  { value: "mortality", label: "Mortality" },
  { value: "purchase", label: "Head purchase" },
  { value: "feed", label: "Feed issued" },
  { value: "weight", label: "Weight check" },
  { value: "sale", label: "Head sold" },
  { value: "note", label: "Note" },
];

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value.length <= 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-PK", { dateStyle: "medium" });
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-PK");
}

function moneyInput(value: number): string {
  return (Number(value || 0) / 100).toFixed(2);
}

function decimalToMinorUnits(value: string, digits: number, label: string): number {
  const normalized = value.trim();
  const match = normalized.match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${digits}}))?$`));
  if (!match) throw new Error(`${label} must be a non-negative number with up to ${digits} decimal places.`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] || "").padEnd(digits, "0"));
  const factor = 10 ** digits;
  const result = whole * factor + fraction;
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is too large.`);
  return result;
}

function animalToday(): string {
  return localDateKey(new Date());
}

async function loadAnimalOptions(branchId?: string): Promise<{
  species: AnimalSpeciesOption[];
  products: AnimalProductOption[];
}> {
  const parameters = new URLSearchParams();
  if (branchId) parameters.set("branchId", branchId);
  const query = parameters.size ? `?${parameters.toString()}` : "";
  const response = await fetch(`/api/workspace/erp/animals/actions${query}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  const result = await response.json() as {
    species?: AnimalSpeciesOption[];
    products?: AnimalProductOption[];
    error?: string;
  };
  if (!response.ok) throw new Error(result.error || "Could not load animal options.");
  return { species: result.species || [], products: result.products || [] };
}

function statusOptions(slug: string): { label: string; options: { value: string; label: string }[] } | null {
  if (slug === "animals") {
    return { label: "Status", options: [
      { value: "", label: "All statuses" }, { value: "open", label: "Open" }, { value: "closed", label: "Closed" },
    ] };
  }
  if (slug === "spice") {
    return { label: "Status", options: [
      { value: "", label: "All statuses" }, { value: "open", label: "Open" }, { value: "completed", label: "Completed" },
    ] };
  }
  if (slug === "vendors" || slug === "farm-stores" || slug === "customer-accounts") {
    return { label: "Status", options: [
      { value: "", label: "All statuses" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" },
    ] };
  }
  return null;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="dashboard-stat card">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </article>
  );
}

function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return <tr><td className="empty-cell" colSpan={colSpan}>{children}</td></tr>;
}

export function ErpWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const { settings: businessSettings } = useBusinessSettings();
  const isHqAdmin = staff?.role === "admin" && !staff.branch_id;
  const today = localDateKey(new Date());
  const defaultFrom = `${today.slice(0, 7)}-01`;
  const trendFrom = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - 13);
    return localDateKey(date);
  }, []);

  const [branchId, setBranchId] = useState(isHqAdmin ? "all" : staff?.branch_id || "");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [balanceFilter, setBalanceFilter] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<ErpResponse | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState<ErpDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [animalSpecies, setAnimalSpecies] = useState<AnimalSpeciesOption[]>([]);
  const [animalProducts, setAnimalProducts] = useState<AnimalProductOption[]>([]);
  const [animalDialog, setAnimalDialog] = useState<AnimalDialogState | null>(null);
  const [animalBusy, setAnimalBusy] = useState(false);
  const [animalOptionsLoading, setAnimalOptionsLoading] = useState(false);
  const [animalOptionsError, setAnimalOptionsError] = useState<string | null>(null);
  const [spiceBatchToComplete, setSpiceBatchToComplete] = useState<SpiceBatchAction | null>(null);
  const [bulkSaleToPay, setBulkSaleToPay] = useState<BulkSalePaymentTarget | null>(null);
  const [vendorActionRequest, setVendorActionRequest] = useState<VendorRequest | null>(null);
  const [farmStoreToEdit, setFarmStoreToEdit] = useState<FarmStore | null>(null);
  const [customerAccountActionRequest, setCustomerAccountActionRequest] = useState<CustomerAccountRequest | null>(null);

  const isDashboard = item.slug === "erp-dashboard";
  const isReports = item.slug === "erp-reports";
  const isFarmStores = item.slug === "farm-stores";
  const usesDates = DATE_MODULES.has(item.slug);
  const canOpenDetail = DETAIL_MODULES.has(item.slug);
  const filter = statusOptions(item.slug);
  const showBranchColumn = branchId === "all";
  const rows = data?.rows || [];
  const report = data?.report;
  const [reportPreview, setReportPreview] = useState<GeneratedDocument | null>(null);

  const buildErpDocument = (orientation: PrintOrientation): GeneratedDocument | null => {
    if (!report) return null;
    return generateErpReportDocument(report, {
      branding: {
        businessName: businessSettings.businessName,
        businessTagline: businessSettings.businessTagline,
        logoDataUrl: businessSettings.logoDataUrl,
      },
      orientationPreference: orientation,
      branch: branchId === "all"
        ? "All branches"
        : branches.find((branch) => branch.id === branchId)?.name || "Your branch",
      printedBy: staff?.full_name || "Staff",
    });
  };

  const exportReportCsv = () => {
    if (!report) return;
    const lines: string[][] = [
      ["Section", "Metric", "Value"],
      ["Range", "From", report.range.from],
      ["Range", "To", report.range.to],
      ["Wholesale", "Invoices", String(report.bulk.invoices)],
      ["Wholesale", "Invoiced", (report.bulk.totalPaisa / 100).toFixed(2)],
      ["Wholesale", "Discounts", (report.bulk.discountPaisa / 100).toFixed(2)],
      ["Wholesale", "Paid", (report.bulk.paidPaisa / 100).toFixed(2)],
      ["Customers", "Invoices", String(report.customers.invoices)],
      ["Customers", "Invoiced", (report.customers.invoicedPaisa / 100).toFixed(2)],
      ["Customers", "Payments", String(report.customers.payments)],
      ["Customers", "Received", (report.customers.paidPaisa / 100).toFixed(2)],
      ["Production", "Runs", String(report.production.runs)],
      ["Production", "Input cost", (report.production.inputCostPaisa / 100).toFixed(2)],
      ["Production", "Overhead", (report.production.overheadPaisa / 100).toFixed(2)],
      ["Production", "Total cost", (report.production.totalCostPaisa / 100).toFixed(2)],
      ...report.production.top.map((row) => ["Production output", row.name, (row.totalCost / 100).toFixed(2)]),
      ["Spice", "Batches completed", String(report.spice.batches)],
      ["Spice", "Input cost", (report.spice.inputCostPaisa / 100).toFixed(2)],
      ["Spice", "Packing labor", (report.spice.laborCostPaisa / 100).toFixed(2)],
      ["Spice", "Other cost", (report.spice.otherCostPaisa / 100).toFixed(2)],
      ["Spice", "Total batch cost", (report.spice.totalCostPaisa / 100).toFixed(2)],
      ["Animals", "Mortality heads", String(report.animals.mortality)],
      ["Animals", "Purchased heads", String(report.animals.purchased)],
      ["Animals", "Purchase cost", (report.animals.purchaseCostPaisa / 100).toFixed(2)],
      ["Animals", "Sold heads", String(report.animals.sold)],
      ["Animals", "Feed cost", (report.animals.feedCostPaisa / 100).toFixed(2)],
      ["Expenses", "Entries", String(report.expenses.count)],
      ["Expenses", "Total", (report.expenses.totalPaisa / 100).toFixed(2)],
      ...report.expenses.byCategory.map((row) => ["Expense category", row.name, (row.total / 100).toFixed(2)]),
      ["Purchases", "Receipts", String(report.purchases.receipts)],
      ["Purchases", "Received", (report.purchases.totalPaisa / 100).toFixed(2)],
      ["Purchases", "Payments", String(report.purchases.payments)],
      ["Purchases", "Paid", (report.purchases.paidPaisa / 100).toFixed(2)],
    ];
    const csv = lines.map((line) => line.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `erp-report-${report.range.from}-to-${report.range.to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (staff?.role === "admin" && !staff.branch_id && !branchId) setBranchId("all");
    else if (staff?.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff?.branch_id, staff?.role]);

  useEffect(() => {
    if (!staff) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    setData(null);
    setDetail(null);
    setDetailError(null);

    const parameters = new URLSearchParams({ module: item.slug });
    if (branchId) parameters.set("branchId", branchId);
    if (debouncedSearch) parameters.set("search", debouncedSearch);
    if (status) parameters.set("status", status);
    if (categoryId) parameters.set("categoryId", categoryId);
    if (usesDates) {
      parameters.set("from", from);
      parameters.set("to", to);
    }
    if (isDashboard) {
      parameters.set("today", today);
      parameters.set("trendFrom", trendFrom);
    }

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/erp?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as ErpResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load Farm ERP records.");
        setData(result);
        if (result.categories) setCategories(result.categories);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load Farm ERP records.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [
    branchId, categoryId, debouncedSearch, from, isDashboard, item.slug, reloadKey, staff, status, to, today, trendFrom, usesDates,
  ]);

  useEffect(() => {
    if (item.slug !== "animals" || staff?.role !== "admin") return undefined;
    let active = true;
    setAnimalOptionsLoading(true);
    void loadAnimalOptions().then((options) => {
      if (active) setAnimalSpecies(options.species);
    }).catch((loadError: unknown) => {
      if (active) {
        setAnimalOptionsError(loadError instanceof Error ? loadError.message : "Could not load animal species.");
      }
    }).finally(() => {
      if (active) setAnimalOptionsLoading(false);
    });
    return () => { active = false; };
  }, [item.slug, staff?.role]);

  const openDetail = async (id: string) => {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const parameters = new URLSearchParams({ module: item.slug, detailId: id });
    if (branchId) parameters.set("branchId", branchId);
    try {
      const response = await fetch(`/api/workspace/erp?${parameters.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as ErpResponse;
      if (!response.ok) throw new Error(result.error || "Could not load the record details.");
      if (!result.detail) throw new Error("The record details were not returned.");
      setDetail(result.detail);
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "Could not load the record details.");
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetail(null);
    setDetailError(null);
  };

  const clearFilters = () => {
    setSearch("");
    setStatus("");
    setCategoryId("");
    setPaymentFilter("");
    setBalanceFilter("");
    setFrom(defaultFrom);
    setTo(today);
  };

  const runAnimalAction = async (action: string, payload: Record<string, unknown>) => {
    const response = await fetch("/api/workspace/erp/animals/actions", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json() as { error?: string; result?: ErpRow };
    if (!response.ok) throw new Error(result.error || "Could not save the animal action.");
    if (!result.result) throw new Error("The animal action did not return a result.");
    return result.result;
  };

  const openAnimalBatch = (row?: ErpRow) => {
    const activeSpecies = animalSpecies.find((species) => species.is_active === 1);
    setAnimalDialog({
      kind: "batch",
      error: null,
      form: {
        id: row?.id || "",
        branchId: row?.branch_id || (branchId !== "all" ? branchId : staff?.branch_id || ""),
        name: row?.name || "",
        speciesId: row?.species_id || activeSpecies?.id || "",
        batchType: row?.batch_type || "terminal",
        openingHeads: String(row?.opening_heads ?? 0),
        openingCost: moneyInput(Number(row?.opening_cost_paisa || 0)),
        openingDate: row?.opening_date || animalToday(),
        notes: row?.notes || "",
      },
    });
  };

  const openAnimalEvent = async (record: ErpRow) => {
    setAnimalOptionsLoading(true);
    setAnimalOptionsError(null);
    try {
      const options = await loadAnimalOptions(record.branch_id);
      setAnimalSpecies(options.species);
      setAnimalProducts(options.products);
      setAnimalDialog({
        kind: "event",
        batchId: record.id,
        batchName: record.name,
        error: null,
        form: {
          eventType: "mortality",
          eventDate: animalToday(),
          heads: "",
          purchaseCost: "",
          quantity: "",
          unitCost: "0.00",
          productId: "",
          notes: "",
        },
      });
    } catch (loadError) {
      setAnimalOptionsError(loadError instanceof Error ? loadError.message : "Could not load feed products.");
    } finally {
      setAnimalOptionsLoading(false);
    }
  };

  const openSpeciesManager = async () => {
    setAnimalOptionsLoading(true);
    setAnimalOptionsError(null);
    try {
      const options = await loadAnimalOptions();
      setAnimalSpecies(options.species);
      setAnimalDialog({ kind: "species-list", error: null });
    } catch (loadError) {
      setAnimalOptionsError(loadError instanceof Error ? loadError.message : "Could not load animal species.");
    } finally {
      setAnimalOptionsLoading(false);
    }
  };

  const setAnimalDialogError = (error: string | null) => {
    setAnimalDialog((current) => current ? { ...current, error } : current);
  };

  const updateAnimalBatchForm = (update: Partial<AnimalBatchForm>) => {
    setAnimalDialog((current) => current?.kind === "batch"
      ? { ...current, form: { ...current.form, ...update } }
      : current);
  };

  const updateAnimalEventForm = (update: Partial<AnimalEventForm>) => {
    setAnimalDialog((current) => current?.kind === "event"
      ? { ...current, form: { ...current.form, ...update } }
      : current);
  };

  const updateAnimalSpeciesForm = (update: Partial<AnimalSpeciesForm>) => {
    setAnimalDialog((current) => current?.kind === "species-form"
      ? { ...current, form: { ...current.form, ...update } }
      : current);
  };

  const submitAnimalBatch = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (animalDialog?.kind !== "batch") return;
    setAnimalBusy(true);
    try {
      const headsValue = animalDialog.form.openingHeads.trim();
      if (!/^\d+$/.test(headsValue) || !Number.isSafeInteger(Number(headsValue)) || Number(headsValue) > 1000000) {
        throw new Error("Opening head count must be between 0 and 1,000,000.");
      }
      if (!animalDialog.form.branchId) throw new Error("Choose a branch.");
      const result = await runAnimalAction("save-batch", {
        id: animalDialog.form.id || undefined,
        branchId: animalDialog.form.branchId,
        name: animalDialog.form.name,
        speciesId: animalDialog.form.speciesId,
        batchType: animalDialog.form.batchType,
        openingHeads: Number(headsValue),
        openingCostPaisa: decimalToMinorUnits(animalDialog.form.openingCost, 2, "Opening purchase cost"),
        openingDate: animalDialog.form.openingDate,
        notes: animalDialog.form.notes,
      });
      setAnimalDialog(null);
      setReloadKey((key) => key + 1);
      if (typeof result.id === "string") void openDetail(result.id);
    } catch (saveError) {
      setAnimalDialogError(saveError instanceof Error ? saveError.message : "Could not save the animal batch.");
    } finally {
      setAnimalBusy(false);
    }
  };

  const submitAnimalEvent = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (animalDialog?.kind !== "event") return;
    setAnimalBusy(true);
    try {
      const form = animalDialog.form;
      const payload: Record<string, unknown> = {
        batchId: animalDialog.batchId,
        eventType: form.eventType,
        eventDate: form.eventDate,
        notes: form.notes,
      };
      if (["mortality", "purchase", "sale"].includes(form.eventType)) {
        if (!/^\d+$/.test(form.heads.trim()) || !Number.isSafeInteger(Number(form.heads))) {
          throw new Error("Enter a whole-number head count.");
        }
        payload.heads = Number(form.heads);
      }
      if (form.eventType === "purchase") {
        payload.amountPaisa = decimalToMinorUnits(form.purchaseCost, 2, "Total purchase cost");
      }
      if (form.eventType === "feed" || form.eventType === "weight") {
        payload.quantityMilli = decimalToMinorUnits(form.quantity, 3, "Quantity");
      }
      if (form.eventType === "feed") {
        payload.unitCostPaisa = decimalToMinorUnits(form.unitCost || "0", 2, "Unit cost");
        payload.productId = form.productId || undefined;
      }
      await runAnimalAction("record-event", payload);
      const batchId = animalDialog.batchId;
      setAnimalDialog(null);
      setReloadKey((key) => key + 1);
      void openDetail(batchId);
    } catch (saveError) {
      setAnimalDialogError(saveError instanceof Error ? saveError.message : "Could not record the animal event.");
    } finally {
      setAnimalBusy(false);
    }
  };

  const submitCloseAnimalBatch = async () => {
    if (animalDialog?.kind !== "close") return;
    setAnimalBusy(true);
    try {
      const batchId = animalDialog.batchId;
      await runAnimalAction("close-batch", { batchId });
      setAnimalDialog(null);
      setReloadKey((key) => key + 1);
      void openDetail(batchId);
    } catch (saveError) {
      setAnimalDialogError(saveError instanceof Error ? saveError.message : "Could not close the animal batch.");
    } finally {
      setAnimalBusy(false);
    }
  };

  const openSpeciesForm = (species?: AnimalSpeciesOption) => {
    setAnimalDialog({
      kind: "species-form",
      error: null,
      form: {
        id: species?.id || "",
        name: species?.name || "",
        sortOrder: String(species?.sort_order ?? animalSpecies.length + 1),
        isActive: species ? species.is_active === 1 : true,
      },
    });
  };

  const submitAnimalSpecies = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (animalDialog?.kind !== "species-form") return;
    setAnimalBusy(true);
    try {
      const sortOrder = animalDialog.form.sortOrder.trim();
      if (!/^\d+$/.test(sortOrder) || !Number.isSafeInteger(Number(sortOrder)) || Number(sortOrder) > 100000) {
        throw new Error("Species sort order must be between 0 and 100,000.");
      }
      await runAnimalAction("save-species", {
        id: animalDialog.form.id || undefined,
        name: animalDialog.form.name,
        sortOrder: Number(sortOrder),
        isActive: animalDialog.form.isActive,
      });
      setAnimalDialog({ kind: "species-list", error: null });
      setAnimalOptionsError(null);
      try {
        const options = await loadAnimalOptions();
        setAnimalSpecies(options.species);
      } catch (refreshError) {
        const message = refreshError instanceof Error ? refreshError.message : "Could not reload animal species.";
        setAnimalDialog((current) => current?.kind === "species-list"
          ? { ...current, error: `Species saved, but the list could not be refreshed: ${message}` }
          : current);
      }
    } catch (saveError) {
      setAnimalDialogError(saveError instanceof Error ? saveError.message : "Could not save the animal species.");
    } finally {
      setAnimalBusy(false);
    }
  };

  const toggleAnimalSpecies = async (species: AnimalSpeciesOption) => {
    const action = species.is_active === 1 ? "deactivate-species" : "save-species";
    if (species.is_active === 1 && !window.confirm(`Deactivate ${species.name}? Existing animal batches will keep their species history.`)) return;
    setAnimalBusy(true);
    setAnimalDialogError(null);
    try {
      if (action === "deactivate-species") {
        await runAnimalAction(action, { id: species.id });
      } else {
        await runAnimalAction(action, {
          id: species.id,
          name: species.name,
          sortOrder: species.sort_order,
          isActive: true,
        });
      }
      try {
        const options = await loadAnimalOptions();
        setAnimalSpecies(options.species);
      } catch (refreshError) {
        const message = refreshError instanceof Error ? refreshError.message : "Could not reload animal species.";
        setAnimalDialog((current) => current?.kind === "species-list"
          ? { ...current, error: `Species updated, but the list could not be refreshed: ${message}` }
          : current);
      }
    } catch (saveError) {
      setAnimalDialogError(saveError instanceof Error ? saveError.message : "Could not update the animal species.");
    } finally {
      setAnimalBusy(false);
    }
  };

  const visibleRows = useMemo(() => {
    if (item.slug === "bulk-sales" && paymentFilter) {
      return rows.filter((row) => {
        const due = Number(row.due_paisa || 0);
        const paid = Number(row.paid_paisa || 0);
        if (paymentFilter === "paid") return due <= 0;
        if (paymentFilter === "partial") return due > 0 && paid > 0;
        if (paymentFilter === "unpaid") return due > 0 && paid <= 0;
        return true;
      });
    }
    if (item.slug === "customer-accounts" && balanceFilter) {
      return rows.filter((row) => {
        const balance = Number(row.balance_paisa || 0);
        if (balanceFilter === "outstanding") return balance > 0;
        if (balanceFilter === "clear") return balance <= 0;
        if (balanceFilter === "over") return Boolean(row.over_limit);
        return true;
      });
    }
    return rows;
  }, [balanceFilter, item.slug, paymentFilter, rows]);

  const summary = useMemo(() => {
    if (item.slug === "animals") {
      return [
        { label: "Batches", value: formatNumber(visibleRows.length), hint: `${visibleRows.filter((row) => row.status === "open").length} open` },
        { label: "Head count", value: formatNumber(visibleRows.reduce((total, row) => total + Number(row.head_count || 0), 0)), hint: "Live head count across loaded batches" },
        { label: "Feed cost", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.feed_paisa || 0), 0)), hint: "Recorded feed issues" },
        { label: "Purchase cost", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.purchase_paisa || 0), 0)), hint: "Opening and purchased animals" },
        { label: "Events recorded", value: formatNumber(visibleRows.reduce((total, row) => total + Number(row.event_count || 0), 0)), hint: "Append-only ledger entries" },
      ];
    }
    if (item.slug === "production") {
      return [
        { label: "Production runs", value: formatNumber(visibleRows.length), hint: "Within the selected period" },
        { label: "Output quantity", value: formatQuantity(visibleRows.reduce((total, row) => total + Number(row.output_quantity_milli || 0), 0)), hint: "Milli-units converted to units" },
        { label: "Input cost", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.input_cost_paisa || 0), 0)), hint: "Consumed materials" },
        { label: "Total cost", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.total_cost_paisa || 0), 0)), hint: "Inputs, labour and overhead" },
      ];
    }
    if (item.slug === "spice") {
      return [
        { label: "Batches", value: formatNumber(visibleRows.length), hint: `${visibleRows.filter((row) => row.status === "open").length} open` },
        { label: "Completed", value: formatNumber(visibleRows.filter((row) => row.status === "completed").length), hint: "Within the selected period" },
        { label: "Total cost", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.total_cost_paisa || 0), 0)), hint: "Inputs, labour and other" },
        { label: "Output", value: formatQuantity(visibleRows.reduce((total, row) => total + Number(row.output_quantity_milli || 0), 0)), hint: "Finished quantity in units" },
      ];
    }
    if (item.slug === "bulk-sales") {
      return [
        { label: "Invoices", value: formatNumber(visibleRows.length), hint: "Within the selected period" },
        { label: "Invoiced", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.total_paisa || 0), 0)), hint: "After discounts" },
        { label: "Paid", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.paid_paisa || 0), 0)), hint: "Recorded payments" },
        { label: "Outstanding", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.due_paisa || 0), 0)), hint: "Balance still due" },
      ];
    }
    if (item.slug === "vendors") {
      return [
        { label: "Vendors", value: formatNumber(visibleRows.length), hint: `${visibleRows.filter((row) => row.is_active).length} active` },
        { label: "Purchases", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.purchases_paisa || 0), 0)), hint: "Received stock value" },
        { label: "Paid", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.paid_paisa || 0), 0)), hint: "Supplier payments" },
        { label: "Payable", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.balance_paisa || 0), 0)), hint: "Outstanding balance" },
      ];
    }
    if (item.slug === "farm-stores") {
      const valued = visibleRows.filter((row) => row.stock_value_available);
      const complete = valued.every((row) => row.stock_value_complete);
      return [
        { label: "Stores", value: formatNumber(visibleRows.length), hint: `${visibleRows.filter((row) => row.is_active).length} active` },
        { label: "Active staff", value: formatNumber(visibleRows.reduce((total, row) => total + Number(row.active_staff || 0), 0)), hint: "Assigned to loaded stores" },
        { label: "Sales today", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.sales_paisa || 0), 0)), hint: `${visibleRows.reduce((total, row) => total + Number(row.sales_receipts || 0), 0)} receipts` },
        {
          label: "Stock value",
          value: valued.length ? formatMoney(valued.reduce((total, row) => total + Number(row.stock_value_paisa || 0), 0)) : "Choose a branch",
          hint: valued.length ? (complete ? "Based on current cost and stock" : "Based on the first 1,200 catalog products") : "Available for one branch at a time",
        },
      ];
    }
    if (item.slug === "customer-accounts") {
      return [
        { label: "Accounts", value: formatNumber(visibleRows.length), hint: `${visibleRows.filter((row) => row.is_active).length} active` },
        { label: "Invoiced", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.invoiced_paisa || 0), 0)), hint: "All loaded invoices" },
        { label: "Received", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.paid_paisa || 0), 0)), hint: `${formatMoney(visibleRows.reduce((total, row) => total + Number(row.credited_paisa || 0), 0))} in account credits` },
        { label: "Receivable", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.balance_paisa || 0), 0)), hint: `${visibleRows.filter((row) => row.over_limit).length} over credit limit` },
      ];
    }
    if (item.slug === "erp-expenses") {
      return [
        { label: "Expenses", value: formatNumber(visibleRows.length), hint: "Within the selected period" },
        { label: "Total spend", value: formatMoney(visibleRows.reduce((total, row) => total + Number(row.amount_paisa || 0), 0)), hint: "All loaded categories" },
        { label: "Categories", value: formatNumber(new Set(visibleRows.map((row) => row.category_id)).size), hint: "Represented in this period" },
        { label: "Average", value: visibleRows.length ? formatMoney(visibleRows.reduce((total, row) => total + Number(row.amount_paisa || 0), 0) / visibleRows.length) : formatMoney(0), hint: "Per expense record" },
      ];
    }
    return [];
  }, [item.slug, visibleRows]);

  const detailTitle = detail
    ? {
      animals: detail.record.name || "Animal batch",
      production: detail.record.run_number || "Production run",
      spice: detail.record.batch_number || detail.record.name || "Spice batch",
      "bulk-sales": detail.record.invoice_number || "Bulk sale",
      vendors: detail.record.name || "Vendor",
      "customer-accounts": detail.record.name || "Customer account",
    }[item.slug] || "Record details"
    : "Record details";

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>
            {isDashboard
              ? "A live, branch-scoped snapshot of livestock, production, wholesale, receivables, payables and farm expenses."
              : isReports
                ? "Combined farm ledgers for the selected period. Totals are computed from the records available to your signed-in branch access."
                : item.slug === "animals"
                  ? "Manage livestock batches, head-count events, feed issues, species and batch closure."
                  : item.slug === "production"
                    ? "Record product and animal-based production runs, consume inputs, allocate costs and update branch stock atomically."
                    : item.slug === "spice"
                      ? "Open spice batches by consuming RAW inputs, then complete them with a grade, output quantity, and derived stock cost."
                      : item.slug === "bulk-sales"
                        ? "Create wholesale invoices with branch stock deduction, discounts, optional payments, and outstanding balance tracking."
                      : item.slug === "vendors"
                        ? "Manage suppliers, collect invoice payments, and record stock returns with supplier credits or replacement deliveries."
                      : item.slug === "farm-stores"
                        ? "Register and edit stores shared with branch settings, and review their stock, staff, sales and day-close activity."
                      : item.slug === "customer-accounts"
                        ? "Manage customer accounts, record invoices and balance-limited payments, and review immutable account statements."
                      : item.slug === "erp-expenses"
                        ? "Record farm operating expenses by branch, category and payment method; every expense is audited and append-only."
                    : `${item.description} This workspace is a live read-only view; changes stay in the Windows app.`}
          </p>
        </div>
        <div className="heading-actions">
          {!isDashboard && !isReports && item.slug === "production" && item.actionLabel && (
            <ErpProductionActions
              branches={branches}
              selectedBranchId={branchId}
              staffBranchId={staff?.branch_id}
              isHqAdmin={isHqAdmin}
              actionLabel={item.actionLabel}
              onSaved={(runId) => {
                setReloadKey((key) => key + 1);
                void openDetail(runId);
              }}
            />
          )}
          {!isDashboard && !isReports && item.slug === "spice" && item.actionLabel && (
            <ErpSpiceActions
              branches={branches}
              selectedBranchId={branchId}
              staffBranchId={staff?.branch_id}
              isHqAdmin={isHqAdmin}
              actionLabel={item.actionLabel}
              batchToComplete={spiceBatchToComplete}
              onCloseCompletion={() => setSpiceBatchToComplete(null)}
              onSaved={(batchId) => {
                setReloadKey((key) => key + 1);
                void openDetail(batchId);
              }}
            />
          )}
          {!isDashboard && !isReports && item.slug === "bulk-sales" && item.actionLabel && (
            <ErpBulkSalesActions
              branches={branches}
              selectedBranchId={branchId}
              staffBranchId={staff?.branch_id}
              isHqAdmin={isHqAdmin}
              actionLabel={item.actionLabel}
              saleToPay={bulkSaleToPay}
              onClosePayment={() => setBulkSaleToPay(null)}
              onSaved={(saleId) => {
                setReloadKey((key) => key + 1);
                void openDetail(saleId);
              }}
            />
          )}
          {!isDashboard && !isReports && item.slug === "vendors" && item.actionLabel && (
            <ErpVendorActions
              actionLabel={item.actionLabel}
              request={vendorActionRequest}
              onCloseRequest={() => setVendorActionRequest(null)}
              onSaved={(vendorId) => {
                setReloadKey((key) => key + 1);
                void openDetail(vendorId);
              }}
            />
          )}
          {!isDashboard && !isReports && isHqAdmin && item.slug === "farm-stores" && item.actionLabel && (
            <ErpFarmStoreActions
              actionLabel={item.actionLabel}
              storeToEdit={farmStoreToEdit}
              onCloseEdit={() => setFarmStoreToEdit(null)}
              onSaved={() => setReloadKey((key) => key + 1)}
            />
          )}
          {!isDashboard && !isReports && staff?.role === "admin" && item.slug === "customer-accounts" && item.actionLabel && (
            <ErpCustomerAccountActions
              actionLabel={item.actionLabel}
              request={customerAccountActionRequest}
              branches={branches}
              selectedBranchId={branchId}
              staffBranchId={staff.branch_id}
              isHqAdmin={isHqAdmin}
              onCloseRequest={() => setCustomerAccountActionRequest(null)}
              onSaved={(accountId) => {
                setReloadKey((key) => key + 1);
                void openDetail(accountId);
              }}
            />
          )}
          {!isDashboard && !isReports && staff?.role === "admin" && item.slug === "erp-expenses" && item.actionLabel && (
            <ErpExpenseActions
              actionLabel={item.actionLabel}
              branches={branches}
              categories={categories}
              selectedBranchId={branchId}
              staffBranchId={staff.branch_id}
              isHqAdmin={isHqAdmin}
              onSaved={() => setReloadKey((key) => key + 1)}
            />
          )}
          {!isDashboard && !isReports && item.actionLabel
            && !["production", "spice", "bulk-sales", "vendors", "farm-stores", "customer-accounts", "erp-expenses"].includes(item.slug) && (
            <button
              className="primary-button"
              type="button"
              disabled={item.slug !== "animals" || animalOptionsLoading}
              onClick={item.slug === "animals" ? () => openAnimalBatch() : undefined}
              title={item.slug === "animals" ? undefined : "This write workflow is available in the Windows app."}
            >
              {animalOptionsLoading && item.slug === "animals"
                ? <LoaderCircle size={14} className="spin" />
                : <Plus size={14} />}
              {item.actionLabel}
            </button>
          )}
          {!isDashboard && !isReports && item.slug === "animals" && (
            <button className="secondary-button" type="button" onClick={() => void openSpeciesManager()} disabled={animalOptionsLoading}>
              <Plus size={14} /> Manage species
            </button>
          )}
          {isReports && (
            <button className="secondary-button" type="button" onClick={exportReportCsv} disabled={!report}>
              <Download size={14} /> Export CSV
            </button>
          )}
          {isReports && (
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={!report}
                onClick={() => {
                  const document = buildErpDocument("auto");
                  if (document && !printHtmlDocument(document.html, { title: document.title })) {
                    setError("The print window was blocked. Allow pop-ups for this site and try again.");
                  }
                }}
              >
                <Printer size={14} /> Print A4
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={!report}
                onClick={() => setReportPreview(buildErpDocument("auto"))}
              >
                <Eye size={14} /> Preview
              </button>
            </>
          )}
          <button className="secondary-button" type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
            {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} {isReports ? "REF" : "Refresh"}
          </button>
        </div>
      </div>

      {item.slug === "animals" && animalOptionsError && (
        <div className="notice" role="alert"><AlertCircle size={17} /> {animalOptionsError}</div>
      )}

      <section className="card" aria-label={`${item.title} controls`}>
        <div className="workspace-toolbar">
          {!isDashboard && !isReports && (
            <label className="search-field">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={item.searchLabel}
                aria-label={item.searchLabel}
              />
              {search && (
                <button type="button" className="secondary-button" onClick={() => setSearch("")} aria-label="Clear search">
                  Clear
                </button>
              )}
            </label>
          )}
          {isHqAdmin && (
            <label className="toolbar-control">
              <span>Branch</span>
              <select className="toolbar-select" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                <option value="all">All branches</option>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </label>
          )}
          {filter && (
            <label className="toolbar-control">
              <span>{filter.label}</span>
              <select className="toolbar-select" value={status} onChange={(event) => setStatus(event.target.value)}>
                {filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          )}
          {item.slug === "erp-expenses" && categories.length > 0 && (
            <label className="toolbar-control">
              <span>Category</span>
              <select className="toolbar-select" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                <option value="">All categories</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
          )}
          {item.slug === "bulk-sales" && (
            <label className="toolbar-control">
              <span>Payment</span>
              <select className="toolbar-select" value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)}>
                <option value="">All balances</option>
                <option value="paid">Paid in full</option>
                <option value="partial">Part paid</option>
                <option value="unpaid">Unpaid</option>
              </select>
            </label>
          )}
          {item.slug === "customer-accounts" && (
            <label className="toolbar-control">
              <span>Balance</span>
              <select className="toolbar-select" value={balanceFilter} onChange={(event) => setBalanceFilter(event.target.value)}>
                <option value="">All balances</option>
                <option value="outstanding">Outstanding</option>
                <option value="clear">Clear</option>
                <option value="over">Over credit limit</option>
              </select>
            </label>
          )}
          {usesDates && (
            <>
              <label className="toolbar-control">
                <span>From</span>
                <input className="toolbar-select" type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <label className="toolbar-control">
                <span>To</span>
                <input className="toolbar-select" type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
              </label>
            </>
          )}
          <button className="button secondary" type="button" onClick={clearFilters}>Clear</button>
        </div>
      </section>

      {error && <div className="notice" role="alert"><AlertCircle size={17} /> {error}</div>}
      {loading && <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading Farm ERP records…</div>}

      {!loading && !error && isDashboard && data?.overview && (
        <DashboardView overview={data.overview} trend={data.trend || []} />
      )}

      {!loading && !error && isReports && data?.report && (
        <ReportView report={data.report} />
      )}

      {!loading && !error && !isDashboard && !isReports && (
        <>
          {summary.length > 0 && (
            <section className="dashboard-stats" aria-label={`${item.title} summary`}>
              {summary.map((entry) => <StatCard key={entry.label} label={entry.label} value={entry.value} hint={entry.hint} />)}
            </section>
          )}

          <section className="card table-wrap" aria-label={`${item.title} records`}>
            <div className="table-document-heading">
              <strong>{item.title}</strong>
              <TableDocumentTools tableId={`erp-${item.slug}`} title={`Farm ERP ${item.title}`} disabled={!visibleRows.length} />
            </div>
            <div className="table-wrap">
              <table id={`erp-${item.slug}`}>
                <thead>{renderHead(item.slug, showBranchColumn, canOpenDetail)}</thead>
                <tbody>{renderBody(
                  item.slug,
                  visibleRows,
                  showBranchColumn,
                  canOpenDetail,
                  openDetail,
                  (row) => openAnimalBatch(row),
                  (row) => setSpiceBatchToComplete({
                    id: row.id,
                    batch_number: row.batch_number,
                    name: row.name,
                    status: row.status,
                    output_product_name: row.output_product_name,
                    input_cost_paisa: row.input_cost_paisa,
                    labor_cost_paisa: row.labor_cost_paisa,
                    other_cost_paisa: row.other_cost_paisa,
                  }),
                  (row) => setBulkSaleToPay({
                    id: row.id,
                    invoice_number: row.invoice_number,
                    due_paisa: Number(row.due_paisa || 0),
                  }),
                  (row) => setVendorActionRequest({ kind: "edit", vendor: row as Vendor }),
                  (row) => setVendorActionRequest({ kind: "toggle", vendor: row as Vendor }),
                  (row) => setFarmStoreToEdit(row as FarmStore),
                  isHqAdmin,
                  (row) => setCustomerAccountActionRequest({ kind: "edit", account: row as CustomerAccount }),
                  (row) => setCustomerAccountActionRequest({ kind: "toggle", account: row as CustomerAccount }),
                  (row) => setCustomerAccountActionRequest({ kind: "invoice", account: row as CustomerAccount }),
                  (row) => setCustomerAccountActionRequest({ kind: "payment", account: row as CustomerAccount }),
                  staff?.role === "admin",
                )}</tbody>
              </table>
            </div>
            <p className="form-hint">
              {data?.approximate ? "Some summary totals use the most recent records returned. " : ""}
              {visibleRows.length >= (data?.limit || 0) && data?.limit
                ? `Showing up to ${data.limit} records. Narrow the branch, search or date range to find older records.`
                : isFarmStores
                  ? "Stock value is calculated from the live branch catalog when a single branch is selected."
                  : item.slug === "animals"
                    ? "Events are append-only. Mortality and sale allocate batch cost; feed issues can atomically deduct branch stock."
                    : item.slug === "production"
                      ? "Production runs are posted atomically with input deductions, output stock, cost allocation, and terminal-batch animal events."
                      : item.slug === "spice"
                        ? "RAW inputs are deducted when a batch opens; completing it adds graded output to stock and updates its product cost atomically."
                        : item.slug === "bulk-sales"
                          ? "Posting an invoice deducts stock atomically; invoice payments settle only the balance and never change stock."
                        : item.slug === "customer-accounts"
                          ? "Account, invoice and payment changes are written atomically; invoices and payments cannot be edited or deleted."
                        : "Live read-only records. Create and edit actions remain in the Windows app."}
            </p>
          </section>

          {isFarmStores && branchId === "all" && (
            <p className="preview-controls-note">
              Choose one branch to calculate its live stock value. All-branch view stays fast by omitting valuation.
            </p>
          )}

          {isFarmStores && (
            <div className="settings-grid">
              <section className="card" style={{ padding: "18px" }}>
                <h2 className="section-title"><MapPin size={11} /> How stores work</h2>
                <ul className="settings-list">
                  <li><span>Scope</span><strong>Stock, sales, staff and day close per store</strong></li>
                  <li><span>Receipts</span><strong>Prefix + timestamp, printed from the saved sale</strong></li>
                  <li><span>Transfers</span><strong>Move stock between stores with dispatch and receive</strong></li>
                  <li><span>Reports</span><strong>Sales and stock reports are store-scoped</strong></li>
                </ul>
                <p className="settings-workspace-note">Editing a store&apos;s receipt prefix only affects new sales. Existing receipts keep their number forever.</p>
              </section>
              <section className="card" style={{ padding: "18px" }}>
                <h2 className="section-title"><Store size={11} /> Quick links</h2>
                <div className="heading-actions">
                  <Link className="secondary-button" href="/workspace/transfers">Transfers</Link>
                  <Link className="secondary-button" href="/workspace/stock-reports">Stock reports</Link>
                  <Link className="secondary-button" href="/workspace/sales-reports">Sales reports</Link>
                  <Link className="secondary-button" href="/workspace/settings">Branch settings</Link>
                </div>
                <p className="settings-workspace-note">Staff accounts, devices and branch identity are managed in the Admin section and apply everywhere.</p>
              </section>
            </div>
          )}

          {(detailLoading || detailError || detail) && (
            <section className="card purchasing-detail" aria-live="polite">
              <div className="section-heading">
                <h2>{detailTitle}</h2>
                <button type="button" className="secondary-button" onClick={closeDetail} aria-label="Close details">
                  <X size={17} /> Close
                </button>
              </div>
              {detailLoading && <div className="loading"><LoaderCircle size={18} className="spin" /> Loading record details…</div>}
              {detailError && <div className="notice" role="alert">{detailError}</div>}
              {detail && (
                <DetailView
                  slug={item.slug}
                  detail={detail}
                  onRecordAnimalEvent={item.slug === "animals" ? openAnimalEvent : undefined}
                  onCloseAnimalBatch={item.slug === "animals"
                    ? (record) => setAnimalDialog({
                      kind: "close",
                      batchId: record.id,
                      batchName: record.name,
                      error: null,
                    })
                    : undefined}
                  onRecordBulkPayment={item.slug === "bulk-sales"
                    ? (record) => setBulkSaleToPay({
                      id: record.id,
                      invoice_number: record.invoice_number,
                      due_paisa: Number(record.due_paisa || 0),
                    })
                    : undefined}
                  onEditVendor={item.slug === "vendors"
                    ? (record) => setVendorActionRequest({ kind: "edit", vendor: record as Vendor })
                    : undefined}
                  onToggleVendor={item.slug === "vendors"
                    ? (record) => setVendorActionRequest({ kind: "toggle", vendor: record as Vendor })
                    : undefined}
                  onPaySupplierInvoice={item.slug === "vendors"
                    ? (record, receipt) => setVendorActionRequest({
                      kind: "payment",
                      vendorId: record.id,
                      receipt: receipt as VendorReceipt,
                    })
                    : undefined}
                  onReturnSupplierStock={item.slug === "vendors"
                    ? (record, receipt) => setVendorActionRequest({
                      kind: "return",
                      vendorId: record.id,
                      receipt: receipt as VendorReceipt,
                    })
                    : undefined}
                  onEditCustomerAccount={item.slug === "customer-accounts" && staff?.role === "admin"
                    ? (record) => setCustomerAccountActionRequest({ kind: "edit", account: record as CustomerAccount })
                    : undefined}
                  onToggleCustomerAccount={item.slug === "customer-accounts" && staff?.role === "admin"
                    ? (record) => setCustomerAccountActionRequest({ kind: "toggle", account: record as CustomerAccount })
                    : undefined}
                  onInvoiceCustomerAccount={item.slug === "customer-accounts" && staff?.role === "admin"
                    ? (record) => setCustomerAccountActionRequest({ kind: "invoice", account: record as CustomerAccount })
                    : undefined}
                  onPayCustomerAccount={item.slug === "customer-accounts" && staff?.role === "admin"
                    ? (record) => setCustomerAccountActionRequest({ kind: "payment", account: record as CustomerAccount })
                    : undefined}
                />
              )}
            </section>
          )}
        </>
      )}

      {animalDialog?.kind === "batch" && (
        <WorkspaceDialog
          title={animalDialog.form.id ? "Edit animal batch" : "Open animal batch"}
          eyebrow="Farm ERP · Animals"
          onClose={() => !animalBusy && setAnimalDialog(null)}
          footer={(
            <div className="workspace-form-actions">
              <button className="button secondary" type="button" onClick={() => setAnimalDialog(null)} disabled={animalBusy}>Cancel</button>
              <button className="button" type="submit" form="animal-batch-form" disabled={animalBusy || animalSpecies.every((species) => species.is_active !== 1)}>
                {animalBusy ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}
                {animalBusy ? "Saving…" : animalDialog.form.id ? "Save batch" : "Open batch"}
              </button>
            </div>
          )}
        >
          <form id="animal-batch-form" className="workspace-form" onSubmit={(event) => void submitAnimalBatch(event)}>
            <div className="workspace-form-grid">
              <WorkspaceField label="Branch">
                <select
                  required
                  value={animalDialog.form.branchId}
                  onChange={(event) => updateAnimalBatchForm({ branchId: event.target.value })}
                  disabled={Boolean(animalDialog.form.id)}
                >
                  <option value="">Choose a branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </WorkspaceField>
              <WorkspaceField label="Batch name">
                <input required maxLength={120} value={animalDialog.form.name} onChange={(event) => updateAnimalBatchForm({ name: event.target.value })} />
              </WorkspaceField>
              <WorkspaceField label="Species">
                <select required value={animalDialog.form.speciesId} onChange={(event) => updateAnimalBatchForm({ speciesId: event.target.value })}>
                  <option value="">Choose a species</option>
                  {animalSpecies
                    .filter((species) => species.is_active === 1 || species.id === animalDialog.form.speciesId)
                    .map((species) => (
                      <option key={species.id} value={species.id}>
                        {species.name}{species.is_active === 1 ? "" : " (inactive)"}
                      </option>
                    ))}
                </select>
              </WorkspaceField>
              <WorkspaceField label="Batch type">
                <select value={animalDialog.form.batchType} onChange={(event) => updateAnimalBatchForm({ batchType: event.target.value })}>
                  <option value="terminal">Terminal batch (meat production)</option>
                  <option value="continuous">Continuous batch (eggs &amp; milk production)</option>
                </select>
              </WorkspaceField>
              <WorkspaceField label="Opening head count">
                <input type="number" min="0" max="1000000" step="1" required value={animalDialog.form.openingHeads} onChange={(event) => updateAnimalBatchForm({ openingHeads: event.target.value })} />
              </WorkspaceField>
              <WorkspaceField label="Opening purchase cost">
                <input type="number" min="0" step="0.01" required value={animalDialog.form.openingCost} onChange={(event) => updateAnimalBatchForm({ openingCost: event.target.value })} />
              </WorkspaceField>
              <WorkspaceField label="Opening date">
                <input type="date" required max={today} value={animalDialog.form.openingDate} onChange={(event) => updateAnimalBatchForm({ openingDate: event.target.value })} />
              </WorkspaceField>
            </div>
            <p className="form-hint">
              {animalDialog.form.batchType === "continuous"
                ? "Continuous batches keep their animals for ongoing production; head count changes through mortality, sales, or culling."
                : "Terminal batches are intended for meat production; production runs can consume animals and allocate their cost."}
            </p>
            <p className="form-hint">Opening purchase cost applies to the opening head count. Record later purchases as dated ledger events.</p>
            <WorkspaceField label="Notes">
              <textarea maxLength={500} value={animalDialog.form.notes} onChange={(event) => updateAnimalBatchForm({ notes: event.target.value })} />
            </WorkspaceField>
            {animalSpecies.every((species) => species.is_active !== 1) && (
              <p className="form-hint">Add or activate a species before opening a batch.</p>
            )}
            <WorkspaceError message={animalDialog.error} />
          </form>
        </WorkspaceDialog>
      )}

      {animalDialog?.kind === "event" && (
        <WorkspaceDialog
          title={`Record event · ${animalDialog.batchName}`}
          eyebrow="Farm ERP · Animals"
          onClose={() => !animalBusy && setAnimalDialog(null)}
          footer={(
            <div className="workspace-form-actions">
              <button className="button secondary" type="button" onClick={() => setAnimalDialog(null)} disabled={animalBusy}>Cancel</button>
              <button className="button" type="submit" form="animal-event-form" disabled={animalBusy}>
                {animalBusy ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}
                {animalBusy ? "Recording…" : "Record event"}
              </button>
            </div>
          )}
        >
          <form id="animal-event-form" className="workspace-form" onSubmit={(event) => void submitAnimalEvent(event)}>
            <div className="workspace-form-grid">
              <WorkspaceField label="Event type">
                <select value={animalDialog.form.eventType} onChange={(event) => updateAnimalEventForm({ eventType: event.target.value })}>
                  {ANIMAL_EVENT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
              </WorkspaceField>
              <WorkspaceField label="Event date">
                <input type="date" required max={today} value={animalDialog.form.eventDate} onChange={(event) => updateAnimalEventForm({ eventDate: event.target.value })} />
              </WorkspaceField>
              {["mortality", "purchase", "sale"].includes(animalDialog.form.eventType) && (
                <WorkspaceField label="Head count">
                  <input type="number" min="1" max="100000" step="1" required value={animalDialog.form.heads} onChange={(event) => updateAnimalEventForm({ heads: event.target.value })} />
                </WorkspaceField>
              )}
              {animalDialog.form.eventType === "purchase" && (
                <WorkspaceField label="Total purchase cost" hint="Include transport or other acquisition charges.">
                  <input type="number" min="0" step="0.01" required value={animalDialog.form.purchaseCost} onChange={(event) => updateAnimalEventForm({ purchaseCost: event.target.value })} />
                </WorkspaceField>
              )}
              {["feed", "weight"].includes(animalDialog.form.eventType) && (
                <WorkspaceField label={animalDialog.form.eventType === "feed" ? "Quantity issued" : "Total weight or measurement"} hint="Up to three decimal places.">
                  <input type="number" min="0.001" step="0.001" required value={animalDialog.form.quantity} onChange={(event) => updateAnimalEventForm({ quantity: event.target.value })} />
                </WorkspaceField>
              )}
              {animalDialog.form.eventType === "feed" && (
                <>
                  <WorkspaceField label="Unit cost">
                    <input type="number" min="0" step="0.01" required value={animalDialog.form.unitCost} onChange={(event) => updateAnimalEventForm({ unitCost: event.target.value })} />
                  </WorkspaceField>
                  <WorkspaceField label="Deduct feed from branch stock" hint="Optional. Feed cost is quantity × unit cost.">
                    <select
                      value={animalDialog.form.productId}
                      onChange={(event) => {
                        const product = animalProducts.find((candidate) => candidate.id === event.target.value);
                        updateAnimalEventForm({
                          productId: event.target.value,
                          ...(product ? { unitCost: moneyInput(product.cost_price_paisa) } : {}),
                        });
                      }}
                    >
                      <option value="">Do not change stock</option>
                      {animalProducts.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} · {formatQuantity(product.stock_milli)} {product.unit_code} available
                        </option>
                      ))}
                    </select>
                  </WorkspaceField>
                </>
              )}
            </div>
            <WorkspaceField label="Notes">
              <textarea maxLength={500} value={animalDialog.form.notes} onChange={(event) => updateAnimalEventForm({ notes: event.target.value })} />
            </WorkspaceField>
            <WorkspaceError message={animalDialog.error} />
          </form>
        </WorkspaceDialog>
      )}

      {animalDialog?.kind === "close" && (
        <WorkspaceDialog
          title="Close animal batch?"
          eyebrow="Farm ERP · Animals"
          onClose={() => !animalBusy && setAnimalDialog(null)}
          footer={(
            <div className="workspace-form-actions">
              <button className="button secondary" type="button" onClick={() => setAnimalDialog(null)} disabled={animalBusy}>Cancel</button>
              <button className="button" type="button" onClick={() => void submitCloseAnimalBatch()} disabled={animalBusy}>
                {animalBusy ? <LoaderCircle size={14} className="spin" /> : <Lock size={14} />}
                {animalBusy ? "Closing…" : "Close batch"}
              </button>
            </div>
          )}
        >
          <p>Close <strong>{animalDialog.batchName}</strong>? Once closed, this batch cannot be edited or receive more events.</p>
          <WorkspaceError message={animalDialog.error} />
        </WorkspaceDialog>
      )}

      {animalDialog?.kind === "species-list" && (
        <WorkspaceDialog
          title="Manage animal species"
          eyebrow="Farm ERP · Animals"
          onClose={() => !animalBusy && setAnimalDialog(null)}
          footer={(
            <div className="workspace-form-actions">
              <button className="button secondary" type="button" onClick={() => setAnimalDialog(null)} disabled={animalBusy}>Close</button>
              <button className="button" type="button" onClick={() => openSpeciesForm()} disabled={animalBusy}>
                <Plus size={14} /> Add species
              </button>
            </div>
          )}
        >
          <WorkspaceError message={animalDialog.error} />
          <div className="workspace-category-list">
            {animalSpecies.map((species) => (
              <div className="workspace-category-row" key={species.id}>
                <div>
                  <strong>{species.name}</strong>
                  <small>Sort order {species.sort_order}</small>
                </div>
                <div className="workspace-inline-actions">
                  <span className={`status ${species.is_active === 1 ? "green" : "red"}`}>
                    {species.is_active === 1 ? "Active" : "Inactive"}
                  </span>
                  <button className="button secondary" type="button" onClick={() => openSpeciesForm(species)} disabled={animalBusy}>
                    <Pencil size={12} /> Edit
                  </button>
                  <button className="button secondary" type="button" onClick={() => void toggleAnimalSpecies(species)} disabled={animalBusy}>
                    {species.is_active === 1 ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            ))}
            {!animalSpecies.length && <p className="form-hint">No animal species are configured.</p>}
          </div>
        </WorkspaceDialog>
      )}

      {animalDialog?.kind === "species-form" && (
        <WorkspaceDialog
          title={animalDialog.form.id ? "Edit species" : "Add species"}
          eyebrow="Farm ERP · Animals"
          onClose={() => !animalBusy && setAnimalDialog({ kind: "species-list", error: null })}
          footer={(
            <div className="workspace-form-actions">
              <button className="button secondary" type="button" onClick={() => setAnimalDialog({ kind: "species-list", error: null })} disabled={animalBusy}>Cancel</button>
              <button className="button" type="submit" form="animal-species-form" disabled={animalBusy}>
                {animalBusy ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}
                {animalBusy ? "Saving…" : "Save species"}
              </button>
            </div>
          )}
        >
          <form id="animal-species-form" className="workspace-form" onSubmit={(event) => void submitAnimalSpecies(event)}>
            <div className="workspace-form-grid">
              <WorkspaceField label="Species name">
                <input required maxLength={60} value={animalDialog.form.name} onChange={(event) => updateAnimalSpeciesForm({ name: event.target.value })} />
              </WorkspaceField>
              <WorkspaceField label="Sort order">
                <input type="number" min="0" max="100000" step="1" required value={animalDialog.form.sortOrder} onChange={(event) => updateAnimalSpeciesForm({ sortOrder: event.target.value })} />
              </WorkspaceField>
            </div>
            <label className="workspace-checkbox">
              <input type="checkbox" checked={animalDialog.form.isActive} onChange={(event) => updateAnimalSpeciesForm({ isActive: event.target.checked })} />
              <span>Active and selectable for new batches</span>
            </label>
            <WorkspaceError message={animalDialog.error} />
          </form>
        </WorkspaceDialog>
      )}

      {reportPreview && (
        <div
          className="table-document-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setReportPreview(null);
          }}
        >
          <section
            aria-label="ERP report preview"
            aria-modal="true"
            className={`table-document-preview ${reportPreview.orientation}`}
            role="dialog"
          >
            <header>
              <div>
                <h2>ERP report</h2>
                <p>A4 {reportPreview.orientation}</p>
              </div>
              <button type="button" className="button secondary" onClick={() => setReportPreview(null)}>
                Close
              </button>
            </header>
            <div className="table-document-paper">
              <iframe title="ERP report preview" srcDoc={reportPreview.html} sandbox="" />
            </div>
            <footer>
              <span>PDF opens the browser print dialog; choose “Save as PDF”.</span>
              <button
                type="button"
                className="button"
                onClick={() => {
                  if (printHtmlDocument(reportPreview.html, { title: reportPreview.title })) {
                    setReportPreview(null);
                  }
                }}
              >
                <Printer size={14} /> Print / Save as PDF
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

function DashboardView({ overview, trend }: { overview: ErpOverview; trend: ErpTrendDay[] }) {
  const maxWholesale = Math.max(1, ...trend.map((day) => day.wholesalePaisa));
  return (
    <>
      <section className="dashboard-stats" aria-label="Farm ERP overview">
        <StatCard label="Open animal batches" value={formatNumber(overview.animals.openBatches)} hint={`${formatNumber(overview.animals.heads)} head on hand`} />
        <StatCard label="Production in period" value={formatNumber(overview.production.runs)} hint={formatMoney(overview.production.costPaisa)} />
        <StatCard label="Wholesale in period" value={formatMoney(overview.bulk.totalPaisa)} hint={`${formatNumber(overview.bulk.invoices)} invoices`} />
        <StatCard label="Wholesale due" value={formatMoney(overview.bulk.duePaisa)} hint="All outstanding bulk balances" />
        <StatCard label="Customer receivable" value={formatMoney(overview.customers.receivablePaisa)} hint={`${formatNumber(overview.customers.accounts)} active accounts`} />
        <StatCard label="Vendor payable" value={formatMoney(overview.vendors.duePaisa)} hint="Outstanding supplier balances" />
        <StatCard label="Expenses in period" value={formatMoney(overview.expenses.totalPaisa)} hint={`${formatNumber(overview.expenses.count)} records`} />
        <StatCard label="Farm stores" value={formatNumber(overview.stores)} hint="Active branch network" />
      </section>

      <div className="dashboard-grid">
        <section className="card dashboard-panel">
          <div className="section-heading">
            <div><p className="eyebrow page">Trend</p><h2>Wholesale · last 14 days</h2></div>
            <BarChart3 size={19} aria-hidden="true" />
          </div>
          <div className="chart-bars" role="img" aria-label="Wholesale value for the last 14 days">
            {trend.map((day) => (
              <div
                className="chart-bar-column"
                key={day.day}
                title={`${day.day}: wholesale ${formatMoney(day.wholesalePaisa)} · purchases ${formatMoney(day.purchasesPaisa)} · expenses ${formatMoney(day.expensesPaisa)}`}
              >
                <span className="chart-bar-value">{day.wholesalePaisa ? "•" : ""}</span>
                <div className="chart-bar-track">
                  <span style={{ height: `${Math.max(day.wholesalePaisa ? 8 : 0, day.wholesalePaisa / maxWholesale * 100)}%` }} />
                </div>
                <small>{new Date(`${day.day}T12:00:00`).toLocaleDateString("en-PK", { day: "numeric", month: "short" })}</small>
              </div>
            ))}
          </div>
          <p className="dashboard-period-note">Hover a bar for purchases, wholesale and expenses on that day.</p>
        </section>

        <section className="card dashboard-panel">
          <div className="section-heading">
            <div><p className="eyebrow page">Selected period</p><h2>Costs and balances</h2></div>
            <ClipboardList size={19} aria-hidden="true" />
          </div>
          <div className="sales-detail-context" style={{ gridTemplateColumns: "1fr" }}>
            <div><span>Animal purchases</span><strong>{formatMoney(overview.animals.purchaseCostPaisa)}</strong></div>
            <div><span>Animal feed</span><strong>{formatMoney(overview.animals.feedCostPaisa)}</strong></div>
            <div><span>Spice completed</span><strong>{formatNumber(overview.spice.completedThisMonth)} batches · {formatMoney(overview.spice.completedCostPaisa)}</strong></div>
            <div><span>Open spice batches</span><strong>{formatNumber(overview.spice.openBatches)}</strong></div>
          </div>
          {overview.approximate && <p className="form-hint">Some totals are based on the most recent records returned for this branch.</p>}
        </section>
      </div>

      <div className="admin-grid">
        <section className="card dashboard-panel">
          <div className="section-heading">
            <div><p className="eyebrow page">Farm ERP</p><h2>Needs attention</h2></div>
            <AlertCircle size={19} aria-hidden="true" />
          </div>
          <div className="attention-list">
            <Link className="attention-row" href="/workspace/animals">
              <span className="attention-main"><strong>Open animal batches</strong><small>Batches still carrying live head count.</small></span>
              <span className="status amber">{formatNumber(overview.animals.openBatches)}</span>
            </Link>
            <Link className="attention-row" href="/workspace/spice">
              <span className="attention-main"><strong>Open spice batches</strong><small>Batches awaiting completion and costing.</small></span>
              <span className="status amber">{formatNumber(overview.spice.openBatches)}</span>
            </Link>
            <Link className="attention-row" href="/workspace/bulk-sales">
              <span className="attention-main"><strong>Wholesale due</strong><small>Outstanding balances on bulk invoices.</small></span>
              <span className="status">{formatMoney(overview.bulk.duePaisa)}</span>
            </Link>
            <Link className="attention-row" href="/workspace/vendors">
              <span className="attention-main"><strong>Vendor payable</strong><small>Supplier balances still owed.</small></span>
              <span className="status">{formatMoney(overview.vendors.duePaisa)}</span>
            </Link>
          </div>

          <div className="section-heading" style={{ marginTop: "16px" }}>
            <div><p className="eyebrow page">Money position</p><h2>Balances</h2></div>
            <CreditCard size={19} aria-hidden="true" />
          </div>
          <div className="close-strip">
            <div><span>Receivable</span><strong>{formatMoney(overview.customers.receivablePaisa)}</strong></div>
            <div><span>Payable</span><strong>{formatMoney(overview.vendors.duePaisa)}</strong></div>
            <div><span>Bulk due</span><strong>{formatMoney(overview.bulk.duePaisa)}</strong></div>
            <div><span>Active stores</span><strong>{formatNumber(overview.stores)}</strong></div>
          </div>
        </section>

        <section className="card dashboard-panel">
          <div className="section-heading">
            <div><p className="eyebrow page">This month</p><h2>Farm activity</h2></div>
            <ClipboardList size={19} aria-hidden="true" />
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ledger</th><th className="numeric-cell">This month</th></tr></thead>
              <tbody>
                <tr><td>Spice batches completed</td><td className="numeric-cell">{formatNumber(overview.spice.completedThisMonth)}</td></tr>
                <tr><td>Production runs</td><td className="numeric-cell">{formatNumber(overview.production.runs)}</td></tr>
                <tr><td>Wholesale invoices</td><td className="numeric-cell">{formatNumber(overview.bulk.invoices)}</td></tr>
                <tr><td>Customer accounts</td><td className="numeric-cell">{formatNumber(overview.customers.accounts)}</td></tr>
                <tr><td>Farm expenses</td><td className="numeric-cell">{formatNumber(overview.expenses.count)}</td></tr>
                <tr><td>Feed issued</td><td className="numeric-cell">{formatMoney(overview.animals.feedCostPaisa)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="dashboard-period-note">Every figure comes from its own immutable ledger. Nothing on this page is typed in or cached from another system.</p>
        </section>
      </div>

      <section className="dashboard-shortcuts">
        <div className="section-heading">
          <div><p className="eyebrow page">Farm ERP</p><h2>Open a module</h2></div>
        </div>
        <div className="shortcut-grid">
          {ERP_LINKS.map((entry) => (
            <Link className="shortcut-card card" href={`/workspace/${entry.slug}`} key={entry.slug}>
              <span className="shortcut-copy"><strong>{entry.label}</strong><small>{entry.detail}</small></span>
              <ArrowRight size={16} className="shortcut-arrow" />
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

function ReportView({ report }: { report: ErpReport }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p className="dashboard-period-note">
        Period {formatDay(report.range.from)} – {formatDay(report.range.to)}
        {report.approximate ? " · some sections are based on the most recent records returned" : ""}
      </p>

      <section className="card dashboard-panel">
        <div className="section-heading"><div><p className="eyebrow page">Wholesale</p><h2>Bulk sales</h2></div></div>
        <section className="dashboard-stats" aria-label="Bulk sales report">
          <StatCard label="Invoices" value={formatNumber(report.bulk.invoices)} />
          <StatCard label="Invoiced" value={formatMoney(report.bulk.totalPaisa)} />
          <StatCard label="Discounts" value={formatMoney(report.bulk.discountPaisa)} />
          <StatCard label="Paid" value={formatMoney(report.bulk.paidPaisa)} />
        </section>
      </section>

      <section className="card dashboard-panel">
        <div className="section-heading"><div><p className="eyebrow page">Receivables</p><h2>Customer accounts</h2></div></div>
        <section className="dashboard-stats" aria-label="Customer accounts report">
          <StatCard label="Invoices" value={formatNumber(report.customers.invoices)} />
          <StatCard label="Invoiced" value={formatMoney(report.customers.invoicedPaisa)} />
          <StatCard label="Payments" value={formatNumber(report.customers.payments)} />
          <StatCard label="Received" value={formatMoney(report.customers.paidPaisa)} />
        </section>
      </section>

      {report.production.top.length > 0 && (
        <TableControls
          tableId="erp-report-production-table"
          ariaLabel="Production report output"
          filterColumns={[{ column: "Output product" }]}
        />
      )}
      <section className="card dashboard-panel">
        <div className="section-heading"><div><p className="eyebrow page">Production</p><h2>Runs and output</h2></div></div>
        <section className="dashboard-stats" aria-label="Production report">
          <StatCard label="Runs" value={formatNumber(report.production.runs)} />
          <StatCard label="Input cost" value={formatMoney(report.production.inputCostPaisa)} />
          <StatCard label="Overhead" value={formatMoney(report.production.overheadPaisa)} />
          <StatCard label="Total cost" value={formatMoney(report.production.totalCostPaisa)} />
        </section>
        {report.production.top.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table id="erp-report-production-table">
              <thead><tr><th>Output product</th><th className="numeric-cell">Runs</th><th className="numeric-cell">Quantity</th><th className="numeric-cell">Cost</th></tr></thead>
              <tbody>{report.production.top.map((entry) => (
                <tr key={entry.name}>
                  <td>{entry.name}</td>
                  <td className="numeric-cell">{formatNumber(entry.runs)}</td>
                  <td className="numeric-cell">{formatQuantity(entry.quantityMilli)}</td>
                  <td className="numeric-cell">{formatMoney(entry.totalCost)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      {report.spice.batchRows.length > 0 && (
        <TableControls
          tableId="erp-report-spice-table"
          ariaLabel="Completed spice batch report"
          filterColumns={[{ column: "Batch" }, { column: "Name" }]}
        />
      )}
      <section className="card dashboard-panel">
        <div className="section-heading"><div><p className="eyebrow page">Spice</p><h2>Completed batches</h2></div></div>
        <section className="dashboard-stats" aria-label="Spice report">
          <StatCard label="Batches" value={formatNumber(report.spice.batches)} />
          <StatCard label="Total cost" value={formatMoney(report.spice.totalCostPaisa)} />
          <StatCard label="Labour" value={formatMoney(report.spice.laborCostPaisa)} />
          <StatCard label="Output" value={formatQuantity(report.spice.outputQuantityMilli)} />
        </section>
        {report.spice.batchRows.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table id="erp-report-spice-table">
              <thead><tr><th>Batch</th><th>Name</th><th>Output</th><th className="numeric-cell">Cost</th><th className="numeric-cell">Quantity</th></tr></thead>
              <tbody>{report.spice.batchRows.map((batch) => (
                <tr key={batch.id || `${batch.batch_number}-${batch.name}`}>
                  <td>{batch.batch_number}</td>
                  <td>{batch.name}</td>
                  <td>{batch.output_product_name}</td>
                  <td className="numeric-cell">{formatMoney(Number(batch.input_cost_paisa || 0) + Number(batch.labor_cost_paisa || 0) + Number(batch.other_cost_paisa || 0))}</td>
                  <td className="numeric-cell">{formatQuantity(Number(batch.output_quantity_milli || 0))} {batch.output_unit_code}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {report.spice.batches > report.spice.batchRows.length && (
          <p className="form-hint">Showing the first {report.spice.batchRows.length} completed batches.</p>
        )}
      </section>

      <section className="card dashboard-panel">
        <div className="section-heading"><div><p className="eyebrow page">Livestock</p><h2>Animal activity</h2></div></div>
        <section className="dashboard-stats" aria-label="Animal report">
          <StatCard label="Mortality" value={formatNumber(report.animals.mortality)} />
          <StatCard label="Purchased" value={formatNumber(report.animals.purchased)} />
          <StatCard label="Purchase cost" value={formatMoney(report.animals.purchaseCostPaisa)} />
          <StatCard label="Sold" value={formatNumber(report.animals.sold)} />
          <StatCard label="Feed cost" value={formatMoney(report.animals.feedCostPaisa)} />
          <StatCard label="Feed quantity" value={formatQuantity(report.animals.feedQuantityMilli)} />
        </section>
      </section>

      {report.expenses.byCategory.length > 0 && (
        <TableControls
          tableId="erp-report-expenses-table"
          ariaLabel="Expense category report"
          filterColumns={[{ column: "Category" }]}
        />
      )}
      <section className="card dashboard-panel">
        <div className="section-heading"><div><p className="eyebrow page">Expenses</p><h2>Spend by category</h2></div></div>
        <section className="dashboard-stats" aria-label="Expense report">
          <StatCard label="Expenses" value={formatNumber(report.expenses.count)} />
          <StatCard label="Total spend" value={formatMoney(report.expenses.totalPaisa)} />
        </section>
        {report.expenses.byCategory.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table id="erp-report-expenses-table">
              <thead><tr><th>Category</th><th className="numeric-cell">Records</th><th className="numeric-cell">Total</th></tr></thead>
              <tbody>{report.expenses.byCategory.map((entry) => (
                <tr key={entry.name}>
                  <td>{entry.name}</td>
                  <td className="numeric-cell">{formatNumber(entry.count)}</td>
                  <td className="numeric-cell">{formatMoney(entry.total)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card dashboard-panel">
        <div className="section-heading"><div><p className="eyebrow page">Purchases</p><h2>Supplier activity</h2></div></div>
        <section className="dashboard-stats" aria-label="Purchases report">
          <StatCard label="Receipts" value={formatNumber(report.purchases.receipts)} />
          <StatCard label="Received value" value={formatMoney(report.purchases.totalPaisa)} />
          <StatCard label="Payments" value={formatNumber(report.purchases.payments)} />
          <StatCard label="Paid" value={formatMoney(report.purchases.paidPaisa)} />
          <StatCard label="Supplier returns" value={formatNumber(report.purchases.returns)} />
          <StatCard label="Credit value" value={formatMoney(report.purchases.returnedPaisa)} />
        </section>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

function ViewButton({ onClick, label = "View" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="secondary-button" onClick={onClick}>
      <Eye size={15} /> {label}
    </button>
  );
}

function renderHead(slug: string, showBranch: boolean, canOpenDetail: boolean) {
  const details = canOpenDetail ? <th>{slug === "customer-accounts" ? "Statement" : "Details"}</th> : null;
  const actions = ["vendors", "customer-accounts"].includes(slug) ? <th>Actions</th> : null;
  if (slug === "animals") return (
    <tr><th>Batch</th>{showBranch && <th>Branch</th>}<th>Type</th><th className="numeric-cell">Head count</th><th>Opened</th><th className="numeric-cell">Feed</th><th>Last event</th><th>Status</th>{details}</tr>
  );
  if (slug === "production") return (
    <tr><th>Run</th>{showBranch && <th>Branch</th>}<th>Output</th><th className="numeric-cell">Quantity</th><th>Run date</th><th className="numeric-cell">Input cost</th><th className="numeric-cell">Total cost</th><th>Process</th>{details}</tr>
  );
  if (slug === "spice") return (
    <tr><th>Batch</th>{showBranch && <th>Branch</th>}<th>Name</th><th>Output</th><th>Grade</th><th className="numeric-cell">Cost</th><th>Date</th><th>Status</th>{details}</tr>
  );
  if (slug === "bulk-sales") return (
    <tr><th>Invoice</th>{showBranch && <th>Branch</th>}<th>Customer</th><th>Date</th><th className="numeric-cell">Total</th><th className="numeric-cell">Paid</th><th className="numeric-cell">Balance</th>{details}</tr>
  );
  if (slug === "vendors") return (
    <tr><th>Vendor</th><th>Contact</th><th className="numeric-cell">Purchases</th><th className="numeric-cell">Paid</th><th className="numeric-cell">Payable</th><th>Last purchase</th><th>Status</th>{details}{actions}</tr>
  );
  if (slug === "farm-stores") return (
    <tr><th>Store</th><th>Location</th><th>Prefix</th><th className="numeric-cell">Staff</th><th className="numeric-cell">Products</th><th className="numeric-cell">Stock value</th><th className="numeric-cell">Sales today</th><th>Last close</th><th>Status</th><th>Actions</th></tr>
  );
  if (slug === "customer-accounts") return (
    <tr><th>Customer</th>{showBranch && <th>Branch</th>}<th>Phone</th><th className="numeric-cell">Invoices</th><th className="numeric-cell">Invoiced</th><th className="numeric-cell">Paid</th><th className="numeric-cell">Balance</th><th>Last activity</th><th>Status</th>{details}{actions}</tr>
  );
  if (slug === "erp-expenses") return (
    <tr><th>Date</th>{showBranch && <th>Branch</th>}<th>Category</th><th>Description</th><th>Method</th><th>Reference</th><th>Recorded by</th><th className="numeric-cell">Amount</th></tr>
  );
  return (
    <tr><th>Record</th><th>Details</th></tr>
  );
}

function renderBody(
  slug: string,
  rows: ErpRow[],
  showBranch: boolean,
  canOpenDetail: boolean,
  openDetail: (id: string) => void,
  editAnimal: (row: ErpRow) => void,
  completeSpice: (row: ErpRow) => void,
  recordBulkPayment: (row: ErpRow) => void,
  editVendor: (row: ErpRow) => void,
  toggleVendor: (row: ErpRow) => void,
  editFarmStore: (row: ErpRow) => void,
  canManageStores: boolean,
  editCustomerAccount: (row: ErpRow) => void,
  toggleCustomerAccount: (row: ErpRow) => void,
  invoiceCustomerAccount: (row: ErpRow) => void,
  payCustomerAccount: (row: ErpRow) => void,
  canManageCustomerAccounts: boolean,
) {
  const detailCell = (row: ErpRow) => {
    if (!canOpenDetail) return null;
    const view = <ViewButton onClick={() => openDetail(row.id)} label={slug === "customer-accounts" ? "Statement" : "View"} />;
    if (slug === "animals") return (
      <td className="row-actions">
        {view}
        <button
          className="secondary-button"
          type="button"
          disabled={row.status !== "open"}
          onClick={() => editAnimal(row)}
          title={row.status === "open" ? "Edit animal batch" : "Closed batches cannot be edited."}
        >
          <Pencil size={12} /> Edit
        </button>
      </td>
    );
    if (slug === "spice") return (
      <td className="row-actions">
        {view}
        <button className="primary-button" type="button" disabled={row.status !== "open"}
          onClick={() => completeSpice(row)} title={row.status === "open" ? "Complete this spice batch." : "This batch has already been completed."}>
          <CheckCircle2 size={12} /> Complete
        </button>
      </td>
    );
    if (slug === "bulk-sales") return (
      <td className="row-actions">
        {view}
        <button className="secondary-button" type="button" disabled={Number(row.due_paisa || 0) <= 0}
          onClick={() => recordBulkPayment(row)} title={Number(row.due_paisa || 0) > 0 ? "Record a payment against this invoice." : "This invoice is fully settled."}>
          <CreditCard size={12} /> Payment
        </button>
      </td>
    );
    return <td>{view}</td>;
  };
  const actionCell = (row?: ErpRow) => {
    if (slug === "vendors") return (
      <td className="row-actions">
        <button className="secondary-button" type="button"
          onClick={() => row && editVendor(row)}>
          <Pencil size={12} /> Edit
        </button>
        <button className="secondary-button" type="button"
          onClick={() => row && toggleVendor(row)}>
          <Power size={12} /> {row?.is_active ? "Deactivate" : "Activate"}
        </button>
      </td>
    );
    if (slug === "customer-accounts") return (
      <td className="row-actions">
        <button className="secondary-button" type="button" disabled={!canManageCustomerAccounts || !row?.is_active}
          onClick={() => row && invoiceCustomerAccount(row)} title={!row?.is_active ? "Activate the account before invoicing." : undefined}>
          <FileText size={12} /> Invoice
        </button>
        <button className="secondary-button" type="button"
          disabled={!canManageCustomerAccounts || !row?.is_active || Number(row?.balance_paisa || 0) <= 0}
          onClick={() => row && payCustomerAccount(row)} title={Number(row?.balance_paisa || 0) <= 0 ? "This account has no outstanding balance." : undefined}>
          <CreditCard size={12} /> Payment
        </button>
        <button className="secondary-button" type="button" disabled={!canManageCustomerAccounts}
          onClick={() => row && editCustomerAccount(row)}>
          <Pencil size={12} /> Edit
        </button>
        <button className="secondary-button" type="button" disabled={!canManageCustomerAccounts}
          onClick={() => row && toggleCustomerAccount(row)}>
          <Power size={12} /> {row?.is_active ? "Deactivate" : "Activate"}
        </button>
      </td>
    );
    return null;
  };
  if (!rows.length) {
    const baseColumns: Record<string, number> = {
      animals: 7,
      production: 7,
      spice: 7,
      "bulk-sales": 6,
      vendors: 7,
      "farm-stores": 10,
      "customer-accounts": 8,
      "erp-expenses": 7,
    };
    const hasBranchColumn = ["animals", "production", "spice", "bulk-sales", "customer-accounts", "erp-expenses"].includes(slug);
    const columns = (baseColumns[slug] || 2) + (showBranch && hasBranchColumn ? 1 : 0) + (canOpenDetail ? 1 : 0)
      + (["vendors", "customer-accounts"].includes(slug) ? 1 : 0);
    return <EmptyRow colSpan={columns}>No records match these filters.</EmptyRow>;
  }

  if (slug === "animals") return rows.map((row) => (
    <tr key={row.id}>
      <td><span className="primary-cell">{row.name}</span><small>{labelize(row.species)}</small></td>
      {showBranch && <td>{row.branch_name}</td>}
      <td>{labelize(row.batch_type)}</td>
      <td className="numeric-cell">{formatNumber(row.head_count)}</td>
      <td className="nowrap">{formatDay(row.opening_date)}</td>
      <td className="numeric-cell">{formatMoney(row.feed_paisa)}<small>{formatQuantity(row.feed_quantity_milli)} {row.feed_quantity_milli ? "issued" : ""}</small></td>
      <td className="nowrap">{row.last_event_date ? formatDay(row.last_event_date) : "—"}</td>
      <td><span className={`status ${statusTone(row.status)}`}>{labelize(row.status)}</span></td>
      {detailCell(row)}
    </tr>
  ));

  if (slug === "production") return rows.map((row) => (
    <tr key={row.id}>
      <td><span className="primary-cell">{row.run_number}</span></td>
      {showBranch && <td>{row.branch_name}</td>}
      <td>{row.output_product_name}</td>
      <td className="numeric-cell">{formatQuantity(row.output_quantity_milli)} {row.output_unit_code}</td>
      <td className="nowrap">{formatDay(row.run_date)}</td>
      <td className="numeric-cell">{formatMoney(row.input_cost_paisa)}</td>
      <td className="numeric-cell">{formatMoney(row.total_cost_paisa)}</td>
      <td>{labelize(row.process_type)}</td>
      {detailCell(row)}
    </tr>
  ));

  if (slug === "spice") return rows.map((row) => (
    <tr key={row.id}>
      <td><span className="primary-cell">{row.batch_number}</span></td>
      {showBranch && <td>{row.branch_name}</td>}
      <td>{row.name}</td>
      <td>{row.output_product_name}<small>{formatQuantity(row.output_quantity_milli)} {row.output_unit_code}</small></td>
      <td>{row.grade ? labelize(row.grade) : "—"}</td>
      <td className="numeric-cell">{formatMoney(row.total_cost_paisa)}</td>
      <td className="nowrap">{formatDay(row.batch_date)}</td>
      <td><span className={`status ${statusTone(row.status)}`}>{labelize(row.status)}</span></td>
      {detailCell(row)}
    </tr>
  ));

  if (slug === "bulk-sales") return rows.map((row) => (
    <tr key={row.id}>
      <td><span className="primary-cell">{row.invoice_number}</span></td>
      {showBranch && <td>{row.branch_name}</td>}
      <td>{row.customer_name}<small>{row.customer_phone || "No phone"}</small></td>
      <td className="nowrap">{formatDay(row.sale_date)}</td>
      <td className="numeric-cell">{formatMoney(row.total_paisa)}</td>
      <td className="numeric-cell">{formatMoney(row.paid_paisa)}</td>
      <td className="numeric-cell">{formatMoney(row.due_paisa)}</td>
      {detailCell(row)}
    </tr>
  ));

  if (slug === "vendors") return rows.map((row) => (
    <tr key={row.id}>
      <td><span className="primary-cell">{row.name}</span><small>{row.email || "No email"}</small></td>
      <td>{row.contact_name || "—"}<small>{row.phone || "No phone"}</small></td>
      <td className="numeric-cell">{formatMoney(row.purchases_paisa)}<small>{formatNumber(row.purchase_count)} receipts</small></td>
      <td className="numeric-cell">{formatMoney(row.paid_paisa)}</td>
      <td className="numeric-cell">{formatMoney(row.balance_paisa)}</td>
      <td className="nowrap">{row.last_purchase_at ? formatDay(row.last_purchase_at) : "—"}</td>
      <td><span className={`status ${row.is_active ? "green" : "red"}`}>{row.is_active ? "Active" : "Inactive"}</span></td>
      {detailCell(row)}
      {actionCell(row)}
    </tr>
  ));

  if (slug === "farm-stores") return rows.map((row) => (
    <tr key={row.id}>
      <td><span className="primary-cell">{row.name}</span><small>{row.is_default ? "Default store · " : ""}{row.code}</small></td>
      <td>{row.address || "—"}<small>{row.phone || "No phone"}</small></td>
      <td>{row.receipt_prefix || "—"}</td>
      <td className="numeric-cell">{formatNumber(row.active_staff)}</td>
      <td className="numeric-cell">{row.products === null ? "—" : formatNumber(row.products)}</td>
      <td className="numeric-cell">
        {row.stock_value_available ? formatMoney(row.stock_value_paisa) : "Select a branch"}
        {row.stock_value_available && !row.stock_value_complete ? <small>Partial catalog</small> : null}
      </td>
      <td className="numeric-cell">{formatMoney(row.sales_paisa)}<small>{formatNumber(row.sales_receipts)} receipts</small></td>
      <td className="nowrap">{row.last_close ? formatDay(row.last_close.business_date) : "—"}<small>{row.last_close ? formatMoney(row.last_close.difference_paisa) : "No close"}</small></td>
      <td><span className={`status ${row.is_active ? "green" : "red"}`}>{row.is_active ? "Active" : "Inactive"}</span></td>
      <td className="row-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={!canManageStores}
          onClick={() => editFarmStore(row)}
          title={canManageStores ? `Edit ${row.name}.` : "Only an HQ administrator can manage stores."}
        >
          <Pencil size={12} /> Edit
        </button>
      </td>
    </tr>
  ));

  if (slug === "customer-accounts") return rows.map((row) => (
    <tr key={row.id}>
      <td><span className="primary-cell">{row.name}</span><small>{row.email || "No email"}</small></td>
      {showBranch && <td>{row.branch_name}</td>}
      <td>{row.phone || "—"}</td>
      <td className="numeric-cell">{formatNumber(row.invoice_count)}</td>
      <td className="numeric-cell">{formatMoney(row.invoiced_paisa)}</td>
      <td className="numeric-cell">{formatMoney(row.paid_paisa)}</td>
      <td className="numeric-cell">{formatMoney(row.balance_paisa)}<small>{row.over_limit ? "Over credit limit" : ""}</small></td>
      <td className="nowrap">{row.last_activity ? formatDay(row.last_activity) : "—"}</td>
      <td><span className={`status ${row.is_active ? "green" : "red"}`}>{row.is_active ? "Active" : "Inactive"}</span></td>
      {detailCell(row)}
      {actionCell(row)}
    </tr>
  ));

  if (slug === "erp-expenses") return rows.map((row) => (
    <tr key={row.id}>
      <td className="nowrap">{formatDay(row.spent_at)}</td>
      {showBranch && <td>{row.branch_name}</td>}
      <td>{row.category_name}</td>
      <td>{row.description}</td>
      <td>{labelize(row.payment_method)}</td>
      <td>{row.reference || "—"}</td>
      <td>{row.recorded_by_name || "—"}</td>
      <td className="numeric-cell">{formatMoney(row.amount_paisa)}</td>
    </tr>
  ));

  return rows.map((row) => <tr key={row.id}><td>{row.name || row.id}</td><td>—</td></tr>);
}

/* ------------------------------------------------------------------ */
/* Details                                                             */
/* ------------------------------------------------------------------ */

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span>{label}</span><strong>{children}</strong></div>;
}

function DetailView({
  slug,
  detail,
  onRecordAnimalEvent,
  onCloseAnimalBatch,
  onRecordBulkPayment,
  onEditVendor,
  onToggleVendor,
  onPaySupplierInvoice,
  onReturnSupplierStock,
  onEditCustomerAccount,
  onToggleCustomerAccount,
  onInvoiceCustomerAccount,
  onPayCustomerAccount,
}: {
  slug: string;
  detail: ErpDetail;
  onRecordAnimalEvent?: (record: ErpRow) => void;
  onCloseAnimalBatch?: (record: ErpRow) => void;
  onRecordBulkPayment?: (record: ErpRow) => void;
  onEditVendor?: (record: ErpRow) => void;
  onToggleVendor?: (record: ErpRow) => void;
  onPaySupplierInvoice?: (record: ErpRow, receipt: ErpRow) => void;
  onReturnSupplierStock?: (record: ErpRow, receipt: ErpRow) => void;
  onEditCustomerAccount?: (record: ErpRow) => void;
  onToggleCustomerAccount?: (record: ErpRow) => void;
  onInvoiceCustomerAccount?: (record: ErpRow) => void;
  onPayCustomerAccount?: (record: ErpRow) => void;
}) {
  const record = detail.record;
  const items = detail.items || [];

  if (slug === "animals") return (
    <>
      <div className="sales-detail-context">
        <MetaItem label="Species">{labelize(record.species)}</MetaItem>
        <MetaItem label="Batch type">{labelize(record.batch_type)}</MetaItem>
        <MetaItem label="Opened">{formatDay(record.opening_date)}</MetaItem>
        <MetaItem label="Status">{labelize(record.status)}</MetaItem>
        <MetaItem label="Head count">{formatNumber(detail.summary?.headCount)}</MetaItem>
        <MetaItem label="Feed cost">{formatMoney(detail.summary?.feedPaisa || 0)}</MetaItem>
      </div>
      <div className="heading-actions" aria-label="Animal batch actions">
        <button
          className="primary-button"
          type="button"
          disabled={record.status !== "open" || !onRecordAnimalEvent}
          onClick={() => onRecordAnimalEvent?.(record)}
        >
          <Plus size={13} /> Record event
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={record.status !== "open" || !onCloseAnimalBatch}
          onClick={() => onCloseAnimalBatch?.(record)}
        >
          <Lock size={12} /> Close batch
        </button>
      </div>
      {record.notes && <p>{record.notes}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Event</th><th className="numeric-cell">Heads</th><th className="numeric-cell">Quantity</th><th className="numeric-cell">Cost</th><th>Product</th><th>Notes</th><th>Recorded by</th></tr></thead>
          <tbody>{items.length ? items.map((event) => (
            <tr key={event.id}>
              <td className="nowrap">{formatDay(event.event_date)}</td>
              <td>{labelize(event.event_type)}</td>
              <td className="numeric-cell">{event.heads_delta > 0 ? "+" : ""}{formatNumber(event.heads_delta)}</td>
              <td className="numeric-cell">{formatQuantity(event.quantity_milli)}</td>
              <td className="numeric-cell">{formatMoney(event.amount_paisa)}</td>
              <td>{event.product_name || "—"}</td>
              <td>{event.notes || "—"}</td>
              <td>{event.recorded_by_name || "—"}</td>
            </tr>
          )) : <EmptyRow colSpan={8}>No batch events have been recorded.</EmptyRow>}</tbody>
        </table>
      </div>
    </>
  );

  if (slug === "production") return (
    <>
      <div className="sales-detail-context">
        <MetaItem label="Run date">{formatDay(record.run_date)}</MetaItem>
        <MetaItem label="Output">{record.output_product_name}</MetaItem>
        <MetaItem label="Quantity">{formatQuantity(record.output_quantity_milli)} {record.output_unit_code}</MetaItem>
        <MetaItem label="Process">{labelize(record.process_type)}</MetaItem>
        <MetaItem label="Animals used">{formatNumber(record.animal_heads)}</MetaItem>
        <MetaItem label="Total cost">{formatMoney(record.total_cost_paisa)}</MetaItem>
        <MetaItem label="Unit cost">{formatMoney(record.unit_cost_paisa)}</MetaItem>
      </div>
      {record.notes && <p>{record.notes}</p>}
      <h3>Consumed inputs</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Product</th><th className="numeric-cell">Quantity</th><th className="numeric-cell">Unit cost</th><th className="numeric-cell">Line total</th></tr></thead>
          <tbody>{items.length ? items.map((line) => (
            <tr key={line.id}>
              <td>{line.product_name}</td>
              <td className="numeric-cell">{formatQuantity(line.quantity_milli)} {line.unit_code}</td>
              <td className="numeric-cell">{formatMoney(line.unit_cost_paisa)}</td>
              <td className="numeric-cell">{formatMoney(line.line_total_paisa)}</td>
            </tr>
          )) : <EmptyRow colSpan={4}>No input lines are available.</EmptyRow>}</tbody>
        </table>
      </div>
      <h3>Finished outputs</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Product</th><th className="numeric-cell">Quantity</th><th className="numeric-cell">Unit cost</th><th className="numeric-cell">Line total</th></tr></thead>
          <tbody>{(detail.secondaryItems || []).length ? (detail.secondaryItems || []).map((line) => (
            <tr key={line.id}>
              <td>{line.product_name}</td>
              <td className="numeric-cell">{formatQuantity(line.quantity_milli)} {line.unit_code}</td>
              <td className="numeric-cell">{formatMoney(line.unit_cost_paisa)}</td>
              <td className="numeric-cell">{formatMoney(line.line_total_paisa)}</td>
            </tr>
          )) : <EmptyRow colSpan={4}>No output lines are available.</EmptyRow>}</tbody>
        </table>
      </div>
    </>
  );

  if (slug === "spice") return (
    <>
      <div className="sales-detail-context">
        <MetaItem label="Batch date">{formatDay(record.batch_date)}</MetaItem>
        <MetaItem label="Output">{record.output_product_name}</MetaItem>
        <MetaItem label="Quantity">{formatQuantity(record.output_quantity_milli)} {record.output_unit_code}</MetaItem>
        <MetaItem label="Grade">{record.grade ? labelize(record.grade) : "—"}</MetaItem>
        <MetaItem label="Status">{labelize(record.status)}</MetaItem>
        <MetaItem label="Total cost">{formatMoney(record.total_cost_paisa)}</MetaItem>
        <MetaItem label="Unit cost">{formatMoney(record.unit_cost_paisa)}</MetaItem>
      </div>
      {record.notes && <p>{record.notes}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Input product</th><th className="numeric-cell">Quantity</th><th className="numeric-cell">Unit cost</th><th className="numeric-cell">Line total</th></tr></thead>
          <tbody>{items.length ? items.map((line) => (
            <tr key={line.id}>
              <td>{line.product_name}</td>
              <td className="numeric-cell">{formatQuantity(line.quantity_milli)} {line.unit_code}</td>
              <td className="numeric-cell">{formatMoney(line.unit_cost_paisa)}</td>
              <td className="numeric-cell">{formatMoney(line.line_total_paisa)}</td>
            </tr>
          )) : <EmptyRow colSpan={4}>No spice inputs are available.</EmptyRow>}</tbody>
        </table>
      </div>
    </>
  );

  if (slug === "bulk-sales") return (
    <>
      <div className="sales-detail-context">
        <MetaItem label="Customer">{record.customer_name}</MetaItem>
        <MetaItem label="Phone">{record.customer_phone || "—"}</MetaItem>
        <MetaItem label="Sale date">{formatDay(record.sale_date)}</MetaItem>
        <MetaItem label="Total">{formatMoney(record.total_paisa)}</MetaItem>
        <MetaItem label="Paid">{formatMoney(record.paid_paisa)}</MetaItem>
        <MetaItem label="Balance">{formatMoney(record.due_paisa)}</MetaItem>
      </div>
      <div className="heading-actions" aria-label="Bulk sale actions">
        <button className="secondary-button" type="button"
          disabled={Number(record.due_paisa || 0) <= 0 || !onRecordBulkPayment}
          onClick={() => onRecordBulkPayment?.(record)}>
          <CreditCard size={12} /> Payment
        </button>
      </div>
      {record.notes && <p>{record.notes}</p>}
      <h3>Invoice items</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Product</th><th className="numeric-cell">Quantity</th><th className="numeric-cell">Unit price</th><th className="numeric-cell">Line total</th></tr></thead>
          <tbody>{items.length ? items.map((line) => (
            <tr key={line.id}>
              <td>{line.product_name}</td>
              <td className="numeric-cell">{formatQuantity(line.quantity_milli)} {line.unit_code}</td>
              <td className="numeric-cell">{formatMoney(line.unit_price_paisa)}</td>
              <td className="numeric-cell">{formatMoney(line.line_total_paisa)}</td>
            </tr>
          )) : <EmptyRow colSpan={4}>No invoice items are available.</EmptyRow>}</tbody>
        </table>
      </div>
      <h3>Payments</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th className="numeric-cell">Amount</th></tr></thead>
          <tbody>{(detail.payments || []).length ? (detail.payments || []).map((payment) => (
            <tr key={payment.id}>
              <td className="nowrap">{formatDateTime(payment.paid_at)}</td>
              <td>{labelize(payment.method)}</td>
              <td>{payment.reference || "—"}</td>
              <td className="numeric-cell">{formatMoney(payment.amount_paisa)}</td>
            </tr>
          )) : <EmptyRow colSpan={4}>No payments have been recorded.</EmptyRow>}</tbody>
        </table>
      </div>
    </>
  );

  if (slug === "vendors") return (
    <>
      <div className="heading-actions" aria-label="Vendor actions">
        <button className="secondary-button" type="button" onClick={() => onEditVendor?.(record)}>
          <Pencil size={12} /> Edit
        </button>
        <button className="secondary-button" type="button" onClick={() => onToggleVendor?.(record)}>
          <Power size={12} /> {record.is_active ? "Deactivate" : "Activate"}
        </button>
      </div>
      <div className="sales-detail-context">
        <MetaItem label="Contact">{record.contact_name || "—"}</MetaItem>
        <MetaItem label="Phone">{record.phone || "—"}</MetaItem>
        <MetaItem label="Email">{record.email || "—"}</MetaItem>
        <MetaItem label="Status">{record.is_active ? "Active" : "Inactive"}</MetaItem>
        <MetaItem label="Address">{record.address || "—"}</MetaItem>
      </div>
      {record.notes && <p>{record.notes}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Received</th><th>Supplier invoice</th><th className="numeric-cell">Total</th><th className="numeric-cell">Paid</th><th className="numeric-cell">Returned</th><th className="numeric-cell">Due</th><th>Actions</th></tr></thead>
          <tbody>{items.length ? items.map((receipt) => (
            <tr key={receipt.id}>
              <td className="nowrap">{formatDateTime(receipt.received_at)}</td>
              <td>{receipt.supplier_invoice_number || "No invoice"}</td>
              <td className="numeric-cell">{formatMoney(receipt.subtotal_paisa)}</td>
              <td className="numeric-cell">{formatMoney(receipt.paid_paisa)}</td>
              <td className="numeric-cell">{formatMoney(receipt.returned_paisa)}</td>
              <td className="numeric-cell">{formatMoney(receipt.due_paisa)}</td>
              <td className="row-actions">
                <button className="secondary-button" type="button" disabled={Number(receipt.due_paisa || 0) <= 0}
                  onClick={() => onPaySupplierInvoice?.(record, receipt)}>
                  <CreditCard size={12} /> Payment
                </button>
                <button className="secondary-button" type="button" disabled={!onReturnSupplierStock}
                  onClick={() => onReturnSupplierStock?.(record, receipt)}>
                  <RefreshCw size={12} /> Return stock
                </button>
              </td>
            </tr>
          )) : <EmptyRow colSpan={7}>No purchase receipts are available for this vendor.</EmptyRow>}</tbody>
        </table>
      </div>
    </>
  );

  if (slug === "customer-accounts") return (
    <>
      <div className="heading-actions" aria-label="Customer account actions">
        <button className="secondary-button" type="button" disabled={!onInvoiceCustomerAccount || !record.is_active}
          onClick={() => onInvoiceCustomerAccount?.(record)}>
          <FileText size={12} /> Invoice
        </button>
        <button className="secondary-button" type="button"
          disabled={!onPayCustomerAccount || !record.is_active || Number(detail.summary?.balancePaisa || 0) <= 0}
          onClick={() => onPayCustomerAccount?.(record)}>
          <CreditCard size={12} /> Payment
        </button>
        <button className="secondary-button" type="button" disabled={!onEditCustomerAccount}
          onClick={() => onEditCustomerAccount?.(record)}>
          <Pencil size={12} /> Edit
        </button>
        <button className="secondary-button" type="button" disabled={!onToggleCustomerAccount}
          onClick={() => onToggleCustomerAccount?.(record)}>
          <Power size={12} /> {record.is_active ? "Deactivate" : "Activate"}
        </button>
      </div>
      <div className="sales-detail-context">
        <MetaItem label="Phone">{record.phone || "—"}</MetaItem>
        <MetaItem label="Email">{record.email || "—"}</MetaItem>
        <MetaItem label="Status">{record.is_active ? "Active" : "Inactive"}</MetaItem>
        <MetaItem label="Credit limit">{formatMoney(detail.summary?.creditLimitPaisa || 0)}</MetaItem>
        <MetaItem label="Balance">{formatMoney(detail.summary?.balancePaisa || 0)}</MetaItem>
        <MetaItem label="Over limit">{detail.summary?.overLimit ? "Yes" : "No"}</MetaItem>
      </div>
      {record.notes && <p>{record.notes}</p>}
      <h3>Invoices</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Invoice</th><th>Date</th><th>Description</th><th className="numeric-cell">Amount</th></tr></thead>
          <tbody>{items.length ? items.map((invoice) => (
            <tr key={invoice.id}>
              <td>{invoice.invoice_number}</td>
              <td className="nowrap">{formatDay(invoice.invoice_date)}</td>
              <td>{invoice.description}</td>
              <td className="numeric-cell">{formatMoney(invoice.amount_paisa)}</td>
            </tr>
          )) : <EmptyRow colSpan={4}>No invoices are available.</EmptyRow>}</tbody>
        </table>
      </div>
      <h3>Payments and credits</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th className="numeric-cell">Amount</th></tr></thead>
          <tbody>{(detail.payments || []).length ? (detail.payments || []).map((payment) => (
            <tr key={payment.id}>
              <td className="nowrap">{formatDateTime(payment.paid_at)}</td>
              <td>{labelize(payment.method)}</td>
              <td>{payment.reference || "—"}</td>
              <td className="numeric-cell">{formatMoney(payment.amount_paisa)}</td>
            </tr>
          )) : <EmptyRow colSpan={4}>No payments or credits are available.</EmptyRow>}</tbody>
        </table>
      </div>
    </>
  );

  return null;
}
