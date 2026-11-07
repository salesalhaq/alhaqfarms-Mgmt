"use client";

import { GlassCard } from "@/components/ui/GlassCard";
import { getSupabaseAuthClient } from "@/lib/supabase-auth";
import { cn, formatPaisa } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarRange,
  Download,
  FileText,
  Landmark,
  Percent,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface ProfitTaxMetrics {
  grossSalesPaisa: number;
  netMarginPaisa: number;
  taxCollectedPaisa: number;
  taxPayablePaisa: number;
  marginPercent: number;
}

interface ProfitTaxDocument {
  id: string;
  name: string;
  kind: "statement" | "tax-ledger" | "export";
}

interface ProfitTaxResponse {
  branch: string;
  dateFrom: string;
  dateTo: string;
  metrics: ProfitTaxMetrics | null;
  documents: ProfitTaxDocument[];
  unavailable?: boolean;
  limitation?: string;
  refreshedAt: string;
  error?: string;
}

const BRANCH_OPTIONS = [
  { value: "all", label: "All branches" },
  { value: "karachi", label: "Karachi" },
  { value: "lahore", label: "Lahore" },
  { value: "islamabad", label: "Islamabad" },
  { value: "peshawar", label: "Peshawar" },
] as const;

const DEFAULT_DOCS: ProfitTaxDocument[] = [
  { id: "statement", name: "Profit statement", kind: "statement" },
  { id: "tax-ledger", name: "Tax summary", kind: "tax-ledger" },
  { id: "export", name: "Export report", kind: "export" },
];

function formatRelativeRange(dateFrom: string, dateTo: string): string {
  if (!dateFrom || !dateTo) return "Current period";

  try {
    const start = new Date(`${dateFrom}T00:00:00`);
    const end = new Date(`${dateTo}T00:00:00`);
    const formatter = new Intl.DateTimeFormat("en-PK", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `${formatter.format(start)} - ${formatter.format(end)}`;
  } catch {
    return `${dateFrom} to ${dateTo}`;
  }
}

export function ProfitTaxWorkspace() {
  const [branch, setBranch] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<string>("2026-10-01");
  const [dateTo, setDateTo] = useState<string>("2026-10-31");
  const [payload, setPayload] = useState<ProfitTaxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "locked" | "error">("checking");

  const loadData = async (showSpinner = false) => {
    try {
      if (showSpinner) setRefreshing(true);
      setLoading(true);
      setError(null);

      const client = await getSupabaseAuthClient();
      if (!client) {
        setAuthState("locked");
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

      const query = new URLSearchParams({
        branch,
        dateFrom,
        dateTo,
      });

      const response = await fetch(`/api/workspace/profit-tax?${query.toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`,
        },
      });

      const json = (await response.json()) as Partial<ProfitTaxResponse>;
      if (!response.ok) {
        throw new Error(
          typeof json?.error === "string" && json.error ? json.error : "Profit & tax data could not be loaded."
        );
      }

      const nextPayload: ProfitTaxResponse = {
        branch: json.branch ?? branch,
        dateFrom: json.dateFrom ?? dateFrom,
        dateTo: json.dateTo ?? dateTo,
        metrics: json.metrics ?? null,
        documents: json.documents && json.documents.length > 0 ? json.documents : DEFAULT_DOCS,
        unavailable: json.unavailable ?? false,
        limitation: json.limitation ?? "No profit or tax aggregation is currently available for this selection.",
        refreshedAt: json.refreshedAt ?? new Date().toISOString(),
        error: json.error ?? undefined,
      };

      setPayload(nextPayload);
      setAuthState("authenticated");
    } catch (cause) {
      setAuthState("error");
      setError(cause instanceof Error ? cause.message : "Profit and tax data is temporarily unavailable.");
      setPayload({
        branch,
        dateFrom,
        dateTo,
        metrics: null,
        documents: DEFAULT_DOCS,
        unavailable: true,
        limitation:
          "Profit & tax aggregation is not currently exposed in this workspace. The underlying branch-scoped financial summary is unavailable, so no values are shown for this range.",
        refreshedAt: new Date().toISOString(),
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [branch, dateFrom, dateTo]);

  const metrics = useMemo(() => payload?.metrics ?? null, [payload]);
  const hasMetrics = Boolean(metrics && !payload?.unavailable);
  const availableDocs = (payload?.documents ?? DEFAULT_DOCS).slice(0, 3);

  if (authState === "locked") {
    return (
      <GlassCard className="rounded-2xl border border-amber-400/30 bg-slate-950/80 p-8 text-slate-200" variant="strong">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-amber-300" />
          <div>
            <h2 className="text-lg font-semibold text-white">Profit & Tax is locked</h2>
            <p className="mt-2 text-sm text-slate-300">
              Sign in with an authenticated session to access your RLS-scoped report workspace.
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
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-violet-300">Finance workspace</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">Profit & Tax</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadData(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-violet-400 hover:text-white"
            >
              <RefreshCcw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
            <button
              type="button"
              disabled={!hasMetrics}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileText className="h-4 w-4" />
              Statements
            </button>
            <button
              type="button"
              disabled={!hasMetrics}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              Export
            </button>
          </div>
        </div>
      </GlassCard>

      <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-2 text-sm text-slate-300">
              <span className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                <Landmark className="h-3.5 w-3.5" /> Branch
              </span>
              <select
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-violet-400"
              >
                {BRANCH_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm text-slate-300">
              <span className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                <CalendarRange className="h-3.5 w-3.5" /> From
              </span>
              <input
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-violet-400"
              />
            </label>

            <label className="space-y-2 text-sm text-slate-300">
              <span className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                <CalendarRange className="h-3.5 w-3.5" /> To
              </span>
              <input
                type="date"
                value={dateTo}
                min={dateFrom}
                onChange={(event) => setDateTo(event.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-violet-400"
              />
            </label>
          </div>

          <div className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-3 text-sm text-slate-300">
            <span className="text-xs uppercase tracking-[0.18em] text-slate-400">Range</span>
            <p className="mt-2 font-medium text-white">{formatRelativeRange(dateFrom, dateTo)}</p>
          </div>
        </div>
      </GlassCard>

      {loading ? (
        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
          <p className="text-sm text-slate-300">Loading profit & tax summary...</p>
        </GlassCard>
      ) : payload?.unavailable || !hasMetrics ? (
        <GlassCard className="rounded-2xl border border-amber-400/30 bg-amber-500/5 p-5 text-slate-200" variant="strong">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-300" />
            <div>
              <h2 className="text-lg font-semibold text-white">Financial aggregation unavailable</h2>
              <p className="mt-2 text-sm text-slate-300">
                {payload?.limitation ??
                  "Profit & tax aggregation is not currently exposed for this workspace. The branch-scoped financial summary is not available, so no values are shown for this range."}
              </p>
              <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-400">
                {payload?.branch ? `Branch: ${payload.branch}` : "Branch: all"}
              </p>
            </div>
          </div>
        </GlassCard>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Gross sales</p>
              <p className="mt-3 text-2xl font-semibold text-white">{formatPaisa(metrics?.grossSalesPaisa ?? 0)}</p>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Net margin</p>
              <p className="mt-3 text-2xl font-semibold text-emerald-300">{formatPaisa(metrics?.netMarginPaisa ?? 0)}</p>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Tax collected</p>
              <p className="mt-3 text-2xl font-semibold text-sky-300">{formatPaisa(metrics?.taxCollectedPaisa ?? 0)}</p>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Tax payable</p>
              <p className="mt-3 text-2xl font-semibold text-amber-300">{formatPaisa(metrics?.taxPayablePaisa ?? 0)}</p>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Margin rate</p>
              <p className="mt-3 flex items-center gap-2 text-2xl font-semibold text-violet-300">
                {metrics?.marginPercent ?? 0}%
                <ArrowUpRight className="h-4 w-4" />
              </p>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.8fr)]">
            <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-white">Operational summary</h2>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-emerald-200">
                  Read-only
                </span>
              </div>

              <div className="mt-5 space-y-4">
                <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm">
                  <span className="text-slate-300">Gross margin</span>
                  <span className="font-medium text-white">{formatPaisa(metrics?.netMarginPaisa ?? 0)}</span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm">
                  <span className="text-slate-300">Tax contribution</span>
                  <span className="font-medium text-white">{formatPaisa((metrics?.taxCollectedPaisa ?? 0) - (metrics?.taxPayablePaisa ?? 0))}</span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm">
                  <span className="text-slate-300">Margin percent</span>
                  <span className="font-medium text-white">{metrics?.marginPercent ?? 0}%</span>
                </div>
              </div>
            </GlassCard>

            <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-white">Document controls</h2>
                <FileText className="h-4 w-4 text-slate-400" />
              </div>

              <div className="mt-4 space-y-2">
                {availableDocs.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    className="flex w-full items-center justify-between rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-left text-sm text-slate-200 transition hover:border-violet-400 hover:text-white"
                  >
                    <span className="inline-flex items-center gap-2">
                      {document.kind === "tax-ledger" ? <Percent className="h-4 w-4 text-sky-300" /> : <FileText className="h-4 w-4 text-violet-300" />}
                      {document.name}
                    </span>
                    <Download className="h-4 w-4 text-slate-400" />
                  </button>
                ))}
              </div>
            </GlassCard>
          </div>
        </>
      )}

      {error && (
        <p className="text-sm text-red-300">{error}</p>
      )}

      {payload?.refreshedAt && (
        <p className="text-right text-xs text-slate-400">
          Last updated: {new Date(payload.refreshedAt).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })}
        </p>
      )}
    </div>
  );
}
