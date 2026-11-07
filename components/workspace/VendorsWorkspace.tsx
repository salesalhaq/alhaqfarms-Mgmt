"use client";

import { GlassCard } from "@/components/ui/GlassCard";
import { getSupabaseAuthClient } from "@/lib/supabase-auth";
import { cn, formatPaisa } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowUpRight,
  Download,
  FileText,
  Landmark,
  PencilLine,
  Plus,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type VendorStatus = "active" | "pending" | "overdue" | "blocked" | "archived";

interface VendorDocument {
  id: string;
  name: string;
  kind: "invoice" | "statement" | "ledger" | "receipt" | "contract";
  sizeLabel: string;
}

interface VendorRecord {
  id: string;
  vendorNumber: string;
  vendorName: string;
  category: string;
  contactName: string;
  branch: string;
  status: VendorStatus;
  balancePaisa: number;
  creditLimitPaisa: number;
  pendingPaisa: number;
  lastInvoiceDate: string;
  lastPaymentPaisa: number;
  secureWorkflow: boolean;
  note: string;
  documents: VendorDocument[];
}

interface VendorSummary {
  totalVendors: number;
  activeVendors: number;
  overdueVendors: number;
  totalBalancePaisa: number;
  pendingPaisa: number;
}

interface VendorResponse {
  vendors: VendorRecord[];
  summary: VendorSummary;
  refreshedAt: string;
  error?: string;
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "pending", label: "Pending" },
  { id: "overdue", label: "Overdue" },
  { id: "blocked", label: "Blocked" },
] as const;

const STATUS_META: Record<VendorStatus, { label: string; badge: string }> = {
  active: { label: "Active", badge: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30" },
  pending: { label: "Pending", badge: "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30" },
  overdue: { label: "Overdue", badge: "bg-red-500/15 text-red-200 ring-1 ring-red-400/30" },
  blocked: { label: "Blocked", badge: "bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/30" },
  archived: { label: "Archived", badge: "bg-slate-500/15 text-slate-200 ring-1 ring-slate-400/30" },
};

const FALLBACK_VENDORS: VendorRecord[] = [
  {
    id: "vendor-101",
    vendorNumber: "V-1001",
    vendorName: "Prime Industrial Supply",
    category: "Industrial goods",
    contactName: "Naveed Akhtar",
    branch: "Karachi",
    status: "active",
    balancePaisa: 842500,
    creditLimitPaisa: 1500000,
    pendingPaisa: 224000,
    lastInvoiceDate: "2026-11-02",
    lastPaymentPaisa: 315000,
    secureWorkflow: true,
    note: "Vendor remains in healthy standing with no unresolved compliance items.",
    documents: [
      { id: "doc-1", name: "Statement.pdf", kind: "statement", sizeLabel: "1.4 MB" },
      { id: "doc-2", name: "Purchase ledger.xlsx", kind: "ledger", sizeLabel: "860 KB" },
      { id: "doc-3", name: "Invoice batch.pdf", kind: "invoice", sizeLabel: "1.9 MB" },
    ],
  },
  {
    id: "vendor-102",
    vendorNumber: "V-1042",
    vendorName: "Metro Packaging Ltd",
    category: "Packaging",
    contactName: "Sana Malik",
    branch: "Lahore",
    status: "overdue",
    balancePaisa: 1264000,
    creditLimitPaisa: 980000,
    pendingPaisa: 520000,
    lastInvoiceDate: "2026-10-21",
    lastPaymentPaisa: 180000,
    secureWorkflow: false,
    note: "Past-due terms remain active; payment escalation and verification are required before new orders.",
    documents: [
      { id: "doc-4", name: "Overdue statement.pdf", kind: "statement", sizeLabel: "2.1 MB" },
      { id: "doc-5", name: "Invoice archive.pdf", kind: "invoice", sizeLabel: "1.1 MB" },
    ],
  },
  {
    id: "vendor-103",
    vendorNumber: "V-1098",
    vendorName: "Castle Foods & Fresh",
    category: "Procurement",
    contactName: "Ammar Raza",
    branch: "Islamabad",
    status: "pending",
    balancePaisa: 430000,
    creditLimitPaisa: 700000,
    pendingPaisa: 310000,
    lastInvoiceDate: "2026-11-04",
    lastPaymentPaisa: 95000,
    secureWorkflow: true,
    note: "Awaiting final approval on invoice matching and receiving verification.",
    documents: [
      { id: "doc-6", name: "Approval memo.pdf", kind: "contract", sizeLabel: "910 KB" },
      { id: "doc-7", name: "Receipt summary.pdf", kind: "receipt", sizeLabel: "1.2 MB" },
    ],
  },
  {
    id: "vendor-104",
    vendorNumber: "V-1175",
    vendorName: "North Valley Logistics",
    category: "Logistics",
    contactName: "Bilal Qureshi",
    branch: "Peshawar",
    status: "blocked",
    balancePaisa: 990000,
    creditLimitPaisa: 1200000,
    pendingPaisa: 610000,
    lastInvoiceDate: "2026-10-18",
    lastPaymentPaisa: 120000,
    secureWorkflow: true,
    note: "Account is under block review due to repeated delivery variance and risk policy mismatch.",
    documents: [
      { id: "doc-8", name: "Risk review.pdf", kind: "statement", sizeLabel: "1.3 MB" },
      { id: "doc-9", name: "Contract terms.pdf", kind: "contract", sizeLabel: "760 KB" },
    ],
  },
];

const DEFAULT_SUMMARY: VendorSummary = {
  totalVendors: FALLBACK_VENDORS.length,
  activeVendors: FALLBACK_VENDORS.filter((vendor) => vendor.status === "active").length,
  overdueVendors: FALLBACK_VENDORS.filter((vendor) => vendor.status === "overdue").length,
  totalBalancePaisa: FALLBACK_VENDORS.reduce((total, vendor) => total + vendor.balancePaisa, 0),
  pendingPaisa: FALLBACK_VENDORS.reduce((total, vendor) => total + vendor.pendingPaisa, 0),
};

function formatStatusLabel(value: VendorStatus): string {
  return STATUS_META[value]?.label ?? value;
}

function formatDateLabel(value: string): string {
  if (!value) return "No activity";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-PK", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function VendorsWorkspace() {
  const [vendors, setVendors] = useState<VendorRecord[]>(FALLBACK_VENDORS);
  const [selectedVendorId, setSelectedVendorId] = useState<string>(FALLBACK_VENDORS[0]?.id ?? "");
  const [statusFilter, setStatusFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toISOString());
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "locked" | "error">("checking");

  const loadVendors = async (showSpinner = false) => {
    try {
      if (showSpinner) setRefreshing(true);
      setLoading(true);
      setError(null);

      const client = await getSupabaseAuthClient();
      if (!client) {
        setAuthState("locked");
        setVendors(FALLBACK_VENDORS);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError || !sessionData.session) {
        setAuthState("locked");
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const response = await fetch("/api/workspace/vendors", {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`,
        },
      });

      const payload = (await response.json()) as Partial<VendorResponse>;
      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string" && payload.error ? payload.error : "Vendor data could not be loaded."
        );
      }

      const nextVendors = payload.vendors && payload.vendors.length > 0 ? payload.vendors : FALLBACK_VENDORS;
      setVendors(nextVendors);
      setSelectedVendorId((currentId) =>
        currentId && nextVendors.some((vendor) => vendor.id === currentId) ? currentId : nextVendors[0]?.id ?? ""
      );
      setLastUpdated(payload.refreshedAt ?? new Date().toISOString());
      setAuthState("authenticated");
    } catch (cause) {
      setAuthState("error");
      setError(cause instanceof Error ? cause.message : "Vendor records are temporarily unavailable.");
      setVendors(FALLBACK_VENDORS);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadVendors();
  }, []);

  const filteredVendors = useMemo(() => {
    if (statusFilter === "all") return vendors;
    return vendors.filter((vendor) => vendor.status === statusFilter);
  }, [statusFilter, vendors]);

  const selectedVendor = useMemo(() => {
    return filteredVendors.find((vendor) => vendor.id === selectedVendorId) ?? filteredVendors[0] ?? vendors[0] ?? null;
  }, [filteredVendors, selectedVendorId, vendors]);

  const summary = useMemo(() => {
    const source = vendors.length > 0 ? vendors : FALLBACK_VENDORS;
    return {
      totalVendors: source.length,
      activeVendors: source.filter((vendor) => vendor.status === "active").length,
      overdueVendors: source.filter((vendor) => vendor.status === "overdue").length,
      totalBalancePaisa: source.reduce((total, vendor) => total + vendor.balancePaisa, 0),
      pendingPaisa: source.reduce((total, vendor) => total + vendor.pendingPaisa, 0),
    } satisfies VendorSummary;
  }, [vendors]);

  const canManageDocuments = Boolean(selectedVendor && selectedVendor.secureWorkflow && selectedVendor.documents.length > 0);

  if (authState === "locked") {
    return (
      <GlassCard className="rounded-2xl border border-amber-400/30 bg-slate-950/80 p-8 text-slate-200" variant="strong">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-amber-300" />
          <div>
            <h2 className="text-lg font-semibold text-white">Vendor workspace is locked</h2>
            <p className="mt-2 text-sm text-slate-300">
              Sign in with an authenticated session to access your RLS-scoped vendor balance workspace.
            </p>
          </div>
        </div>
      </GlassCard>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-violet-300">Vendor workspace</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">Vendors</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadVendors(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-violet-400 hover:text-white"
            >
              <RefreshCcw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
            <button
              type="button"
              disabled={!canManageDocuments}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
              title={canManageDocuments ? "Statement export enabled" : "Read-only until secure workflow is verified"}
            >
              <FileText className="h-4 w-4" />
              Statements
            </button>
            <button
              type="button"
              disabled={!canManageDocuments}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
              title={canManageDocuments ? "Download ledger enabled" : "Read-only until secure workflow is verified"}
            >
              <Download className="h-4 w-4" />
              Ledger
            </button>
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
              title="Create vendor is disabled in read-only workspace"
            >
              <Plus className="h-4 w-4" />
              New vendor
            </button>
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
              title="Edit vendor is disabled in read-only workspace"
            >
              <PencilLine className="h-4 w-4" />
              Edit
            </button>
          </div>
        </div>
      </GlassCard>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Vendors",
            value: summary.totalVendors,
            tone: "text-violet-300",
            accent: "border-violet-500/30 bg-violet-500/10",
          },
          {
            label: "Active",
            value: summary.activeVendors,
            tone: "text-emerald-300",
            accent: "border-emerald-500/30 bg-emerald-500/10",
          },
          {
            label: "Overdue",
            value: summary.overdueVendors,
            tone: "text-red-300",
            accent: "border-red-500/30 bg-red-500/10",
          },
          {
            label: "Open balance",
            value: formatPaisa(summary.totalBalancePaisa),
            tone: "text-amber-300",
            accent: "border-amber-500/30 bg-amber-500/10",
          },
        ].map((item) => (
          <GlassCard key={item.label} className={cn("rounded-2xl border p-4", item.accent)} variant="strong">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-300">{item.label}</p>
            <p className={cn("mt-3 text-2xl font-semibold text-white", item.tone)}>{item.value}</p>
          </GlassCard>
        ))}
      </div>

      <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setStatusFilter(filter.id)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm font-medium transition",
                  statusFilter === filter.id
                    ? "border-violet-400 bg-violet-500/15 text-violet-100"
                    : "border-slate-600 bg-slate-900/60 text-slate-300 hover:border-slate-500 hover:text-white"
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-300">
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              {authState === "authenticated" ? "Live RLS read" : authState === "checking" ? "Checking" : "Fallback"}
            </span>
            <span>Updated {formatDateLabel(lastUpdated)}</span>
          </div>
        </div>
      </GlassCard>

      {error ? (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4" variant="strong">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Vendor balances</h2>
            <span className="text-sm text-slate-300">{filteredVendors.length} visible</span>
          </div>

          <div className="space-y-3">
            {loading ? (
              Array.from({ length: 3 }).map((_, index) => (
                <div
                  key={`skeleton-${index}`}
                  className="animate-pulse rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4"
                >
                  <div className="h-4 w-32 rounded bg-slate-700/70" />
                  <div className="mt-3 h-3 w-24 rounded bg-slate-700/70" />
                </div>
              ))
            ) : filteredVendors.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-600 bg-slate-900/40 p-6 text-sm text-slate-300">
                No vendors match the selected status filter.
              </div>
            ) : (
              filteredVendors.map((vendor) => {
                const isSelected = selectedVendor?.id === vendor.id;
                const statusMeta = STATUS_META[vendor.status];

                return (
                  <button
                    key={vendor.id}
                    type="button"
                    onClick={() => setSelectedVendorId(vendor.id)}
                    className={cn(
                      "w-full rounded-2xl border p-4 text-left transition",
                      isSelected
                        ? "border-violet-400/60 bg-violet-500/10"
                        : "border-slate-700/60 bg-slate-900/50 hover:border-slate-500 hover:bg-slate-900/70"
                    )}
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-base font-semibold text-white">{vendor.vendorName}</span>
                          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", statusMeta.badge)}>
                            {formatStatusLabel(vendor.status)}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-300">
                          <span>{vendor.vendorNumber}</span>
                          <span>{vendor.category}</span>
                          <span>{vendor.branch}</span>
                        </div>
                      </div>

                      <div className="text-left md:text-right">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Balance</p>
                        <p className="text-xl font-semibold text-white">{formatPaisa(vendor.balancePaisa)}</p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-2 text-sm text-slate-300 sm:grid-cols-3">
                      <div>
                        <span className="text-slate-400">Pending</span>
                        <div className="mt-1 font-medium text-slate-100">{formatPaisa(vendor.pendingPaisa)}</div>
                      </div>
                      <div>
                        <span className="text-slate-400">Credit limit</span>
                        <div className="mt-1 font-medium text-slate-100">{formatPaisa(vendor.creditLimitPaisa)}</div>
                      </div>
                      <div>
                        <span className="text-slate-400">Last invoice</span>
                        <div className="mt-1 font-medium text-slate-100">{formatDateLabel(vendor.lastInvoiceDate)}</div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </GlassCard>

        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
          {selectedVendor ? (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-violet-300">Vendor detail</p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">{selectedVendor.vendorName}</h2>
                </div>
                <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", STATUS_META[selectedVendor.status].badge)}>
                  {formatStatusLabel(selectedVendor.status)}
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Contact</p>
                  <p className="mt-2 text-sm font-medium text-white">{selectedVendor.contactName}</p>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Category</p>
                  <p className="mt-2 text-sm font-medium text-white">{selectedVendor.category}</p>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Branch</p>
                  <p className="mt-2 text-sm font-medium text-white">{selectedVendor.branch}</p>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Vendor ref</p>
                  <p className="mt-2 text-sm font-medium text-white">{selectedVendor.vendorNumber}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-700/60 bg-slate-900/70 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-slate-200">
                    <Landmark className="h-4 w-4 text-violet-300" />
                    <span className="text-sm font-medium">Open balance</span>
                  </div>
                  <ArrowUpRight className="h-4 w-4 text-violet-300" />
                </div>
                <p className="mt-3 text-3xl font-semibold text-white">{formatPaisa(selectedVendor.balancePaisa)}</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Credit limit</p>
                    <p className="mt-1 text-sm font-medium text-slate-100">{formatPaisa(selectedVendor.creditLimitPaisa)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Pending payments</p>
                    <p className="mt-1 text-sm font-medium text-slate-100">{formatPaisa(selectedVendor.pendingPaisa)}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Workflow</p>
                <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                  <div>
                    <p className="text-sm font-medium text-white">Secure workflow</p>
                    <p className="text-xs text-slate-400">
                      {selectedVendor.secureWorkflow ? "Verified and read-only approved" : "Requires review before write access"}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-medium",
                      selectedVendor.secureWorkflow
                        ? "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30"
                        : "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30"
                    )}
                  >
                    {selectedVendor.secureWorkflow ? "Approved" : "Locked"}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Notes</p>
                <p className="mt-3 text-sm leading-6 text-slate-200">{selectedVendor.note}</p>
              </div>

              <div className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Documents</p>
                  <span className="text-xs text-slate-300">{selectedVendor.documents.length} files</span>
                </div>

                <div className="space-y-2">
                  {selectedVendor.documents.map((document) => (
                    <div
                      key={document.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-3"
                    >
                      <div className="flex items-center gap-3">
                        <FileText className="h-4 w-4 text-violet-300" />
                        <div>
                          <p className="text-sm font-medium text-white">{document.name}</p>
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">{document.kind}</p>
                        </div>
                      </div>
                      <span className="text-xs text-slate-300">{document.sizeLabel}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!canManageDocuments}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <FileText className="h-4 w-4" />
                    View statement
                  </button>
                  <button
                    type="button"
                    disabled={!canManageDocuments}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Download className="h-4 w-4" />
                    Download
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[280px] items-center justify-center rounded-2xl border border-dashed border-slate-600 bg-slate-900/40 p-6 text-sm text-slate-300">
              Select a vendor record to review balances and documents.
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}
