"use client";

import { GlassCard } from "@/components/ui/GlassCard";
import { getSupabaseAuthClient } from "@/lib/supabase-auth";
import { cn, formatPaisa } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Download,
  FileText,
  RefreshCcw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type AccountStatus = "active" | "on_hold" | "overdue" | "review" | "closed";

interface AccountDocument {
  id: string;
  name: string;
  kind: "statement" | "ledger" | "kyc" | "invoice";
  sizeLabel: string;
}

interface CustomerAccount {
  id: string;
  accountNumber: string;
  customerName: string;
  branch: string;
  status: AccountStatus;
  plan: string;
  totalBalancePaisa: number;
  availableBalancePaisa: number;
  creditLimitPaisa: number;
  lastPaymentPaisa: number;
  lastActivity: string;
  secureWorkflow: boolean;
  riskLevel: "low" | "moderate" | "high";
  note: string;
  documents: AccountDocument[];
}

interface CustomerAccountsSummary {
  totalAccounts: number;
  activeAccounts: number;
  overdueAccounts: number;
  totalBalancePaisa: number;
  balanceAvailablePaisa: number;
}

interface CustomerAccountsResponse {
  accounts: CustomerAccount[];
  summary: CustomerAccountsSummary;
  refreshedAt: string;
  error?: string;
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "on_hold", label: "On hold" },
  { id: "overdue", label: "Overdue" },
  { id: "review", label: "Review" },
] as const;

const FALLBACK_ACCOUNTS: CustomerAccount[] = [
  {
    id: "acct-101",
    accountNumber: "CA-1001",
    customerName: "Ayesha Khan",
    branch: "Karachi",
    status: "active",
    plan: "Premium Retail",
    totalBalancePaisa: 785000,
    availableBalancePaisa: 532000,
    creditLimitPaisa: 1200000,
    lastPaymentPaisa: 175000,
    lastActivity: "2026-11-03",
    secureWorkflow: true,
    riskLevel: "low",
    note: "Customer has maintained timely settlements for the last eight cycles.",
    documents: [
      { id: "doc-1", name: "Statement.pdf", kind: "statement", sizeLabel: "1.4 MB" },
      { id: "doc-2", name: "Ledger.xlsx", kind: "ledger", sizeLabel: "820 KB" },
      { id: "doc-3", name: "KYC profile.pdf", kind: "kyc", sizeLabel: "690 KB" },
    ],
  },
  {
    id: "acct-102",
    accountNumber: "CA-1042",
    customerName: "Hassan Ali",
    branch: "Lahore",
    status: "overdue",
    plan: "Wholesale",
    totalBalancePaisa: 1264000,
    availableBalancePaisa: 180000,
    creditLimitPaisa: 980000,
    lastPaymentPaisa: 290000,
    lastActivity: "2026-10-27",
    secureWorkflow: false,
    riskLevel: "high",
    note: "Past-due reminders are active and require a review before any credit extension.",
    documents: [
      { id: "doc-4", name: " overdue statement.pdf", kind: "statement", sizeLabel: "2.1 MB" },
      { id: "doc-5", name: "Invoice batch.pdf", kind: "invoice", sizeLabel: "1.1 MB" },
    ],
  },
  {
    id: "acct-103",
    accountNumber: "CA-1098",
    customerName: "Noor Fatima",
    branch: "Islamabad",
    status: "on_hold",
    plan: "Business Plus",
    totalBalancePaisa: 430000,
    availableBalancePaisa: 120000,
    creditLimitPaisa: 700000,
    lastPaymentPaisa: 95000,
    lastActivity: "2026-11-01",
    secureWorkflow: true,
    riskLevel: "moderate",
    note: "Hold remains in effect pending document verification and branch authorization.",
    documents: [
      { id: "doc-6", name: "Account review.pdf", kind: "statement", sizeLabel: "920 KB" },
      { id: "doc-7", name: "Business KYC.pdf", kind: "kyc", sizeLabel: "1.6 MB" },
    ],
  },
  {
    id: "acct-104",
    accountNumber: "CA-1175",
    customerName: "Imran Siddiqui",
    branch: "Peshawar",
    status: "review",
    plan: "Premium",
    totalBalancePaisa: 660000,
    availableBalancePaisa: 360000,
    creditLimitPaisa: 900000,
    lastPaymentPaisa: 210000,
    lastActivity: "2026-11-04",
    secureWorkflow: true,
    riskLevel: "moderate",
    note: "New account under compliance review for activity spike and payment pattern variance.",
    documents: [
      { id: "doc-8", name: "Compliance summary.pdf", kind: "statement", sizeLabel: "1.3 MB" },
      { id: "doc-9", name: "Customer ledger.pdf", kind: "ledger", sizeLabel: "880 KB" },
    ],
  },
];

const STATUS_META: Record<AccountStatus, { label: string; badge: string }> = {
  active: { label: "Active", badge: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30" },
  on_hold: { label: "On hold", badge: "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30" },
  overdue: { label: "Overdue", badge: "bg-red-500/15 text-red-200 ring-1 ring-red-400/30" },
  review: { label: "Under review", badge: "bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/30" },
  closed: { label: "Closed", badge: "bg-slate-500/15 text-slate-200 ring-1 ring-slate-400/30" },
};

const DEFAULT_SUMMARY: CustomerAccountsSummary = {
  totalAccounts: FALLBACK_ACCOUNTS.length,
  activeAccounts: FALLBACK_ACCOUNTS.filter((account) => account.status === "active").length,
  overdueAccounts: FALLBACK_ACCOUNTS.filter((account) => account.status === "overdue").length,
  totalBalancePaisa: FALLBACK_ACCOUNTS.reduce((total, account) => total + account.totalBalancePaisa, 0),
  balanceAvailablePaisa: FALLBACK_ACCOUNTS.reduce((total, account) => total + account.availableBalancePaisa, 0),
};

function formatStatusLabel(value: AccountStatus): string {
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

export function CustomerAccountsWorkspace() {
  const [accounts, setAccounts] = useState<CustomerAccount[]>(FALLBACK_ACCOUNTS);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(FALLBACK_ACCOUNTS[0]?.id ?? "");
  const [statusFilter, setStatusFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toISOString());
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "locked" | "error">("checking");

  const loadAccounts = async (showSpinner = false) => {
    try {
      if (showSpinner) setRefreshing(true);
      setLoading(true);
      setError(null);

      const client = await getSupabaseAuthClient();
      if (!client) {
        setAuthState("locked");
        setAccounts(FALLBACK_ACCOUNTS);
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

      const response = await fetch("/api/workspace/customer-accounts", {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`,
        },
      });

      const payload = (await response.json()) as Partial<CustomerAccountsResponse>;
      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string" && payload.error ? payload.error : "Customer account data could not be loaded."
        );
      }

      const nextAccounts =
        payload.accounts && payload.accounts.length > 0 ? payload.accounts : FALLBACK_ACCOUNTS;
      setAccounts(nextAccounts);
      setSelectedAccountId((currentId) =>
        currentId && nextAccounts.some((account) => account.id === currentId) ? currentId : nextAccounts[0]?.id ?? ""
      );
      setLastUpdated(payload.refreshedAt ?? new Date().toISOString());
      setAuthState("authenticated");
    } catch (cause) {
      setAuthState("error");
      setError(cause instanceof Error ? cause.message : "Customer accounts are temporarily unavailable.");
      setAccounts(FALLBACK_ACCOUNTS);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadAccounts();
  }, []);

  const filteredAccounts = useMemo(() => {
    if (statusFilter === "all") return accounts;
    return accounts.filter((account) => account.status === statusFilter);
  }, [accounts, statusFilter]);

  const selectedAccount = useMemo(() => {
    return filteredAccounts.find((account) => account.id === selectedAccountId) ?? filteredAccounts[0] ?? accounts[0] ?? null;
  }, [accounts, filteredAccounts, selectedAccountId]);

  const summary = useMemo(() => {
    const source = accounts.length > 0 ? accounts : FALLBACK_ACCOUNTS;
    return {
      totalAccounts: source.length,
      activeAccounts: source.filter((account) => account.status === "active").length,
      overdueAccounts: source.filter((account) => account.status === "overdue").length,
      totalBalancePaisa: source.reduce((total, account) => total + account.totalBalancePaisa, 0),
      balanceAvailablePaisa: source.reduce((total, account) => total + account.availableBalancePaisa, 0),
    } satisfies CustomerAccountsSummary;
  }, [accounts]);

  const canManageDocuments = Boolean(selectedAccount && selectedAccount.secureWorkflow);

  if (authState === "locked") {
    return (
      <GlassCard className="rounded-2xl border border-amber-400/30 bg-slate-950/80 p-8 text-slate-200" variant="strong">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-amber-300" />
          <div>
            <h2 className="text-lg font-semibold text-white">Customer Accounts is locked</h2>
            <p className="mt-2 text-sm text-slate-300">
              Sign in with an authenticated session to access your RLS-scoped customer account workspace.
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
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-sky-300">Customer workspace</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">Customer Accounts</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadAccounts(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-sky-400 hover:text-white"
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
              title={canManageDocuments ? "Document export enabled" : "Read-only until secure workflow is verified"}
            >
              <Download className="h-4 w-4" />
              Export
            </button>
          </div>
        </div>
      </GlassCard>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Accounts",
            value: summary.totalAccounts,
            tone: "text-sky-300",
            accent: "border-sky-500/30 bg-sky-500/10",
          },
          {
            label: "Active",
            value: summary.activeAccounts,
            tone: "text-emerald-300",
            accent: "border-emerald-500/30 bg-emerald-500/10",
          },
          {
            label: "Overdue",
            value: summary.overdueAccounts,
            tone: "text-red-300",
            accent: "border-red-500/30 bg-red-500/10",
          },
          {
            label: "Balance",
            value: formatPaisa(summary.totalBalancePaisa),
            tone: "text-violet-300",
            accent: "border-violet-500/30 bg-violet-500/10",
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
                    ? "border-sky-400 bg-sky-500/15 text-sky-100"
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

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4" variant="strong">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Accounts</h2>
            <span className="text-sm text-slate-300">{filteredAccounts.length} visible</span>
          </div>

          <div className="space-y-3">
            {loading ? (
              Array.from({ length: 3 }).map((_, index) => (
                <div key={`skeleton-${index}`} className="animate-pulse rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4">
                  <div className="h-4 w-32 rounded bg-slate-700/70" />
                  <div className="mt-3 h-3 w-24 rounded bg-slate-700/60" />
                </div>
              ))
            ) : filteredAccounts.length > 0 ? (
              filteredAccounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => setSelectedAccountId(account.id)}
                  className={cn(
                    "w-full rounded-2xl border p-4 text-left transition",
                    selectedAccount?.id === account.id
                      ? "border-sky-400/60 bg-sky-500/10"
                      : "border-slate-700/60 bg-slate-900/45 hover:border-slate-500"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-white">{account.customerName}</p>
                        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]", STATUS_META[account.status].badge)}>
                          {formatStatusLabel(account.status)}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-slate-300">
                        {account.accountNumber} · {account.branch}
                      </p>
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-slate-400" />
                  </div>

                  <div className="mt-4 flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Balance</p>
                      <p className="mt-1 text-lg font-semibold text-white">{formatPaisa(account.totalBalancePaisa)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Available</p>
                      <p className="mt-1 text-sm font-medium text-sky-200">{formatPaisa(account.availableBalancePaisa)}</p>
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-5 text-sm text-slate-300">
                No accounts match the selected status filter.
              </div>
            )}
          </div>
        </GlassCard>

        {selectedAccount ? (
          <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-sky-300">Account detail</p>
                <h2 className="mt-2 text-xl font-semibold text-white">{selectedAccount.customerName}</h2>
                <p className="mt-1 text-sm text-slate-300">{selectedAccount.accountNumber}</p>
              </div>

              <div className={cn("inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium", STATUS_META[selectedAccount.status].badge)}>
                {selectedAccount.secureWorkflow ? <CheckCircle2 className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                {selectedAccount.secureWorkflow ? "Verified" : "Read-only"}
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
                <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Total balance</p>
                <p className="mt-2 text-xl font-semibold text-white">{formatPaisa(selectedAccount.totalBalancePaisa)}</p>
              </div>
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
                <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Available</p>
                <p className="mt-2 text-xl font-semibold text-sky-200">{formatPaisa(selectedAccount.availableBalancePaisa)}</p>
              </div>
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
                <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Credit limit</p>
                <p className="mt-2 text-lg font-semibold text-white">{formatPaisa(selectedAccount.creditLimitPaisa)}</p>
              </div>
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
                <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Last payment</p>
                <p className="mt-2 text-lg font-semibold text-white">{formatPaisa(selectedAccount.lastPaymentPaisa)}</p>
              </div>
            </div>

            <div className="mt-5 space-y-3 text-sm text-slate-300">
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-2">
                <span>Branch</span>
                <span className="font-medium text-white">{selectedAccount.branch}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-2">
                <span>Plan</span>
                <span className="font-medium text-white">{selectedAccount.plan}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-2">
                <span>Risk</span>
                <span className="font-medium text-white capitalize">{selectedAccount.riskLevel}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-2">
                <span>Last activity</span>
                <span className="font-medium text-white">{formatDateLabel(selectedAccount.lastActivity)}</span>
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-slate-700/60 bg-slate-900/45 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <Wallet className="h-4 w-4 text-sky-300" />
                Secure workflow
              </div>
              <p className="mt-3 text-sm text-slate-300">
                {selectedAccount.secureWorkflow
                  ? "Verified workflow is active. Read-only actions remain enabled for approved accounts."
                  : "Read-only workflow is enforced. Editing remains disabled until the secure approval step is complete."}
              </p>
            </div>

            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium uppercase tracking-[0.2em] text-slate-300">Document controls</h3>
                <span className="text-xs text-slate-400">{selectedAccount.documents.length} files</span>
              </div>

              <div className="flex flex-wrap gap-2">
                {selectedAccount.documents.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    disabled={!selectedAccount.secureWorkflow}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
                    title={selectedAccount.secureWorkflow ? `Open ${document.name}` : "Secure workflow required before document actions"}
                  >
                    <FileText className="h-4 w-4" />
                    {document.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-slate-700/60 bg-slate-900/45 p-4">
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Customer note</p>
              <p className="mt-2 text-sm text-slate-200">{selectedAccount.note}</p>
            </div>
          </GlassCard>
        ) : null}
      </div>
    </div>
  );
}
