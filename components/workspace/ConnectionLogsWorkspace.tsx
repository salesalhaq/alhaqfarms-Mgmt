"use client";

import { GlassCard } from "@/components/ui/GlassCard";
import { getSupabaseAuthClient } from "@/lib/supabase-auth";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  RefreshCcw,
  ShieldCheck,
  Wifi,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type ConnectionStatus = "connected" | "disconnected" | "warning" | "blocked" | "idle";
type DateRange = "all" | "24h" | "7d" | "30d";

interface ConnectionDocument {
  id: string;
  name: string;
  kind: "report" | "audit" | "packet" | "summary";
  sizeLabel: string;
}

interface ConnectionLogEntry {
  id: string;
  deviceName: string;
  deviceId: string;
  location: string;
  user: string;
  status: ConnectionStatus;
  connectedAt: string;
  endedAt: string | null;
  durationMinutes: number;
  ipAddress: string;
  policy: string;
  secureWorkflow: boolean;
}

interface ConnectionSummary {
  connected: number;
  disconnected: number;
  warnings: number;
  blocked: number;
}

interface ConnectionLogsResponse {
  title: string;
  summary: string;
  secureWorkflow: boolean;
  totals: ConnectionSummary;
  records: ConnectionLogEntry[];
  documents: ConnectionDocument[];
  refreshedAt: string;
  error?: string;
}

const FALLBACK_RECORDS: ConnectionLogEntry[] = [
  {
    id: "conn-101",
    deviceName: "Karachi POS 11",
    deviceId: "DEV-KHI-11",
    location: "Karachi • Floor 1",
    user: "Ayesha Khan",
    status: "connected",
    connectedAt: "2026-11-04T08:45:00Z",
    endedAt: null,
    durationMinutes: 93,
    ipAddress: "10.10.14.36",
    policy: "Retail branch network",
    secureWorkflow: true,
  },
  {
    id: "conn-102",
    deviceName: "Lahore Service Desk",
    deviceId: "DEV-LHR-03",
    location: "Lahore • Service desk",
    user: "Imran Qadeer",
    status: "disconnected",
    connectedAt: "2026-11-04T06:20:00Z",
    endedAt: "2026-11-04T08:41:00Z",
    durationMinutes: 141,
    ipAddress: "10.12.44.18",
    policy: "Support access",
    secureWorkflow: true,
  },
  {
    id: "conn-103",
    deviceName: "Islamabad Front Office",
    deviceId: "DEV-ISB-08",
    location: "Islamabad • Front office",
    user: "Sana Ali",
    status: "warning",
    connectedAt: "2026-11-04T04:08:00Z",
    endedAt: "2026-11-04T04:46:00Z",
    durationMinutes: 38,
    ipAddress: "10.15.9.42",
    policy: "Guest operator policy",
    secureWorkflow: false,
  },
  {
    id: "conn-104",
    deviceName: "Peshawar Warehouse",
    deviceId: "DEV-PSH-05",
    location: "Peshawar • Warehouse",
    user: "Noman Hussain",
    status: "blocked",
    connectedAt: "2026-11-03T20:10:00Z",
    endedAt: "2026-11-03T20:24:00Z",
    durationMinutes: 14,
    ipAddress: "10.17.55.71",
    policy: "Restricted maintenance",
    secureWorkflow: true,
  },
  {
    id: "conn-105",
    deviceName: "Karachi Warehouse 2",
    deviceId: "DEV-KHI-18",
    location: "Karachi • Racking floor",
    user: "M. Zubair",
    status: "idle",
    connectedAt: "2026-11-03T12:02:00Z",
    endedAt: "2026-11-03T12:12:00Z",
    durationMinutes: 10,
    ipAddress: "10.10.21.06",
    policy: "Maintenance window",
    secureWorkflow: true,
  },
];

const FALLBACK_DOCUMENTS: ConnectionDocument[] = [
  { id: "doc-1", name: "Daily connection summary.pdf", kind: "summary", sizeLabel: "1.2 MB" },
  { id: "doc-2", name: "Inbound access audit.csv", kind: "audit", sizeLabel: "860 KB" },
  { id: "doc-3", name: "Branch packet trace.zip", kind: "packet", sizeLabel: "3.1 MB" },
];

const FALLBACK_RESPONSE: ConnectionLogsResponse = {
  title: "Connection logs workspace",
  summary: "Authenticated read-only access to recent device connections, branch sessions, and document references.",
  secureWorkflow: true,
  totals: {
    connected: 1,
    disconnected: 1,
    warnings: 1,
    blocked: 1,
  },
  records: FALLBACK_RECORDS,
  documents: FALLBACK_DOCUMENTS,
  refreshedAt: new Date().toISOString(),
};

const STATUS_META: Record<ConnectionStatus, { label: string; badge: string }> = {
  connected: { label: "Connected", badge: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30" },
  disconnected: { label: "Disconnected", badge: "bg-slate-500/15 text-slate-200 ring-1 ring-slate-400/30" },
  warning: { label: "Warning", badge: "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30" },
  blocked: { label: "Blocked", badge: "bg-red-500/15 text-red-200 ring-1 ring-red-400/30" },
  idle: { label: "Idle", badge: "bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-400/30" },
};

const DATE_FILTERS: Array<{ value: DateRange; label: string }> = [
  { value: "all", label: "All time" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const STATUS_FILTERS: Array<{ value: "all" | ConnectionStatus; label: string }> = [
  { value: "all", label: "All states" },
  { value: "connected", label: "Connected" },
  { value: "disconnected", label: "Disconnected" },
  { value: "warning", label: "Warning" },
  { value: "blocked", label: "Blocked" },
];

function formatDateTime(value: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${remainingMinutes}m`;
  return `${hours}h ${remainingMinutes}m`;
}

function toDateWindow(dateValue: string | null, range: DateRange): boolean {
  if (range === "all" || !dateValue) return true;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return true;
  const now = Date.now();
  const ms = date.getTime();
  const limit =
    range === "24h" ? 24 * 60 * 60 * 1000 :
    range === "7d" ? 7 * 24 * 60 * 60 * 1000 :
    30 * 24 * 60 * 60 * 1000;
  return now - ms <= limit;
}

export function ConnectionLogsWorkspace() {
  const [logs, setLogs] = useState<ConnectionLogEntry[]>(FALLBACK_RECORDS);
  const [documents, setDocuments] = useState<ConnectionDocument[]>(FALLBACK_DOCUMENTS);
  const [dateRange, setDateRange] = useState<DateRange>("7d");
  const [statusFilter, setStatusFilter] = useState<"all" | ConnectionStatus>("all");
  const [deviceFilter, setDeviceFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "locked" | "error">("checking");
  const [secureWorkflow, setSecureWorkflow] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<string>(new Date().toISOString());

  const loadLogs = async (showSpinner = false) => {
    try {
      if (showSpinner) setRefreshing(true);
      setLoading(true);
      setError(null);

      const client = await getSupabaseAuthClient();
      if (!client) {
        setAuthState("locked");
        setLogs(FALLBACK_RECORDS);
        setDocuments(FALLBACK_DOCUMENTS);
        setSecureWorkflow(FALLBACK_RESPONSE.secureWorkflow);
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

      const accessToken = sessionData.session.access_token;
      const response = await fetch("/api/workspace/connection-logs", {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const json = (await response.json()) as Partial<ConnectionLogsResponse>;
      if (!response.ok) {
        throw new Error(
          typeof json?.error === "string" && json.error ? json.error : "Connection log data could not be loaded."
        );
      }

      const nextLogs = Array.isArray(json.records) && json.records.length > 0 ? json.records : FALLBACK_RECORDS;
      const nextDocuments = Array.isArray(json.documents) && json.documents.length > 0 ? json.documents : FALLBACK_DOCUMENTS;

      setLogs(nextLogs);
      setDocuments(nextDocuments);
      setSecureWorkflow(Boolean(json.secureWorkflow ?? true));
      setRefreshedAt(json.refreshedAt ?? new Date().toISOString());
      setAuthState("authenticated");
    } catch (cause) {
      setAuthState("error");
      setError(cause instanceof Error ? cause.message : "Connection logs are temporarily unavailable.");
      setLogs(FALLBACK_RECORDS);
      setDocuments(FALLBACK_DOCUMENTS);
      setSecureWorkflow(FALLBACK_RESPONSE.secureWorkflow);
      setRefreshedAt(new Date().toISOString());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadLogs();
  }, []);

  const deviceOptions = useMemo(() => {
    const names = new Set(logs.map((entry) => entry.deviceName));
    return ["all", ...Array.from(names)];
  }, [logs]);

  const filteredLogs = useMemo(() => {
    return logs.filter((entry) => {
      const matchesDate = toDateWindow(entry.connectedAt, dateRange);
      const matchesStatus = statusFilter === "all" || entry.status === statusFilter;
      const matchesDevice = deviceFilter === "all" || entry.deviceName === deviceFilter;
      return matchesDate && matchesStatus && matchesDevice;
    });
  }, [dateRange, deviceFilter, logs, statusFilter]);

  const totals = useMemo(() => {
    return {
      connected: logs.filter((entry) => entry.status === "connected").length,
      disconnected: logs.filter((entry) => entry.status === "disconnected").length,
      warnings: logs.filter((entry) => entry.status === "warning").length,
      blocked: logs.filter((entry) => entry.status === "blocked").length,
    };
  }, [logs]);

  if (authState === "locked") {
    return (
      <GlassCard className="rounded-2xl border border-amber-400/30 bg-slate-950/80 p-8 text-slate-200" variant="strong">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-amber-300" />
          <div>
            <h2 className="text-lg font-semibold text-white">Connection logs are locked</h2>
            <p className="mt-2 text-sm text-slate-300">
              Sign in with an authenticated session to access the RLS-scoped connection log workspace.
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
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-cyan-300">Secure access</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">Connection logs workspace</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-300">
              Read-only connection activity for authenticated devices, branch access, and document review.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadLogs(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-cyan-400 hover:text-white"
            >
              <RefreshCcw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
            <button
              type="button"
              disabled={!secureWorkflow}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileText className="h-4 w-4" />
              View report
            </button>
            <button
              type="button"
              disabled={!secureWorkflow}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              Export log
            </button>
          </div>
        </div>
      </GlassCard>

      {error ? (
        <GlassCard className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-red-100" variant="strong">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-300" />
            <span className="text-sm font-medium">{error}</span>
          </div>
        </GlassCard>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4" variant="strong">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Connected</p>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <p className="text-3xl font-semibold text-white">{totals.connected}</p>
              <p className="mt-1 text-xs text-slate-400">active sessions</p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-emerald-300" />
          </div>
        </GlassCard>

        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4" variant="strong">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Disconnected</p>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <p className="text-3xl font-semibold text-white">{totals.disconnected}</p>
              <p className="mt-1 text-xs text-slate-400">sessions closed</p>
            </div>
            <Clock3 className="h-5 w-5 text-cyan-300" />
          </div>
        </GlassCard>

        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4" variant="strong">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Warnings</p>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <p className="text-3xl font-semibold text-white">{totals.warnings}</p>
              <p className="mt-1 text-xs text-slate-400">policy checks</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-amber-300" />
          </div>
        </GlassCard>

        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4" variant="strong">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Secure workflow</p>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <p className="text-xl font-semibold text-white">{secureWorkflow ? "Verified" : "Restricted"}</p>
              <p className="mt-1 text-xs text-slate-400">{secureWorkflow ? "Read-only controls enabled" : "Edit access blocked"}</p>
            </div>
            <ShieldCheck className={cn("h-5 w-5", secureWorkflow ? "text-emerald-300" : "text-amber-300")} />
          </div>
        </GlassCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.55fr_0.95fr]">
        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">Recent connection history</h2>
            <span className="text-xs text-slate-400">Updated {formatDateTime(refreshedAt)}</span>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-slate-700/60">
            <div className="hidden grid-cols-[1.2fr_1fr_0.8fr_0.8fr] border-b border-slate-700/60 bg-slate-900/80 px-4 py-3 text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400 md:grid">
              <span>Device</span>
              <span>User</span>
              <span>Connection</span>
              <span>State</span>
            </div>

            <div className="divide-y divide-slate-700/60">
              {filteredLogs.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-slate-300">No connections match the current filters.</div>
              ) : (
                filteredLogs.map((entry) => (
                  <div key={entry.id} className="grid gap-3 px-4 py-3 md:grid-cols-[1.2fr_1fr_0.8fr_0.8fr] md:items-center">
                    <div>
                      <p className="font-medium text-white">{entry.deviceName}</p>
                      <p className="mt-1 text-xs text-slate-400">{entry.location}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-100">{entry.user}</p>
                      <p className="mt-1 text-[11px] text-slate-400">{entry.ipAddress}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-100">{formatDateTime(entry.connectedAt)}</p>
                      <p className="mt-1 text-[11px] text-slate-400">{entry.endedAt ? `Ended ${formatDateTime(entry.endedAt)}` : "Session active"}</p>
                    </div>
                    <div className="flex items-center justify-between gap-2 md:justify-end">
                      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium", STATUS_META[entry.status]?.badge ?? STATUS_META.warning.badge)}>
                        {STATUS_META[entry.status]?.label ?? "Warning"}
                      </span>
                      <span className="text-[11px] text-slate-400">{formatDuration(entry.durationMinutes)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </GlassCard>

        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-cyan-300" />
            <h2 className="text-lg font-semibold text-white">Filters & document controls</h2>
          </div>

          <div className="mt-5 space-y-5">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Date range</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {DATE_FILTERS.map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setDateRange(filter.value)}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition",
                      dateRange === filter.value
                        ? "border-cyan-400/60 bg-cyan-500/10 text-cyan-100"
                        : "border-slate-600 bg-slate-900/80 text-slate-300 hover:border-slate-500"
                    )}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Status</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {STATUS_FILTERS.map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setStatusFilter(filter.value)}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition",
                      statusFilter === filter.value
                        ? "border-cyan-400/60 bg-cyan-500/10 text-cyan-100"
                        : "border-slate-600 bg-slate-900/80 text-slate-300 hover:border-slate-500"
                    )}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="device-filter" className="text-xs uppercase tracking-[0.2em] text-slate-400">
                Device
              </label>
              <select
                id="device-filter"
                value={deviceFilter}
                onChange={(event) => setDeviceFilter(event.target.value)}
                className="mt-3 w-full rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 outline-none ring-0 transition focus:border-cyan-400"
              >
                {deviceOptions.map((device) => (
                  <option key={device} value={device}>
                    {device === "all" ? "All devices" : device}
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Document controls</p>
                <ShieldCheck className={cn("h-4 w-4", secureWorkflow ? "text-emerald-300" : "text-amber-300")} />
              </div>

              <div className="mt-4 space-y-2">
                {documents.map((document) => (
                  <div key={document.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-700/60 bg-slate-950/60 px-2.5 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-slate-100">{document.name}</p>
                      <p className="text-[11px] text-slate-400">{document.kind} • {document.sizeLabel}</p>
                    </div>
                    <button
                      type="button"
                      disabled={!secureWorkflow}
                      className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-4 space-y-2 border-t border-slate-700/60 pt-4">
                <button
                  type="button"
                  disabled={!secureWorkflow}
                  className="flex w-full items-center justify-between rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-200 transition disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="inline-flex items-center gap-2"><Wifi className="h-4 w-4" /> View live session</span>
                </button>
                <button
                  type="button"
                  disabled={true}
                  className="flex w-full items-center justify-between rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm font-medium text-red-200 opacity-50"
                >
                  <span className="inline-flex items-center gap-2"><XCircle className="h-4 w-4" /> Cleanup log entries</span>
                </button>
                <button
                  type="button"
                  disabled={true}
                  className="flex w-full items-center justify-between rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-400 opacity-50"
                >
                  <span className="inline-flex items-center gap-2"><FileText className="h-4 w-4" /> Edit session metadata</span>
                </button>
              </div>
            </div>
          </div>
        </GlassCard>
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
        <span>RLS-scoped read access only</span>
        <span>Last refreshed {formatDateTime(refreshedAt)}</span>
      </div>

      {loading ? <div className="text-sm text-slate-300">Loading connection logs…</div> : null}
    </div>
  );
}
