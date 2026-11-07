"use client";

import { GlassCard } from "@/components/ui/GlassCard";
import { getSupabaseAuthClient } from "@/lib/supabase-auth";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  RefreshCcw,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type SyncStatus = "healthy" | "syncing" | "warning" | "offline" | "blocked";

interface DeviceSyncStatus {
  id: string;
  name: string;
  location: string;
  status: SyncStatus;
  version: string;
  lastSeen: string;
  syncLag: string;
  secureWorkflow: boolean;
}

interface CloudDocument {
  id: string;
  name: string;
  kind: "policy" | "config" | "audit";
  sizeLabel: string;
}

interface CloudConfigMetadata {
  appName: string;
  environment: string;
  configVersion: string;
  scope: string;
  publishedBy: string;
  publishedAt: string;
  source: string;
  storage: string;
}

interface CloudConfigResponse {
  title: string;
  summary: string;
  secureWorkflow: boolean;
  syncSummary: {
    online: number;
    syncing: number;
    warning: number;
    blocked: number;
  };
  metadata: CloudConfigMetadata;
  devices: DeviceSyncStatus[];
  documents: CloudDocument[];
  lastSyncedAt: string;
  refreshedAt: string;
  error?: string;
}

const FALLBACK_RESPONSE: CloudConfigResponse = {
  title: "Cloud configuration workspace",
  summary: "Policy, software, and device sync state are readable in this shared RLS-scoped workspace.",
  secureWorkflow: true,
  syncSummary: { online: 3, syncing: 1, warning: 1, blocked: 0 },
  metadata: {
    appName: "E:Alhaqfm Web",
    environment: "Production",
    configVersion: "2026.11.04.2",
    scope: "All branches • Karachi / Lahore / Islamabad",
    publishedBy: "Operations Platform",
    publishedAt: "2026-11-04T00:32:00Z",
    source: "Windows desktop mirror",
    storage: "Supabase / secure config vault",
  },
  lastSyncedAt: "2026-11-04T00:41:00Z",
  refreshedAt: new Date().toISOString(),
  devices: [
    {
      id: "device-01",
      name: "Karachi POS 11",
      location: "Karachi • Floor 1",
      status: "healthy",
      version: "2.7.8",
      lastSeen: "2 minutes ago",
      syncLag: "0.8 min",
      secureWorkflow: true,
    },
    {
      id: "device-02",
      name: "Lahore Counter 03",
      location: "Lahore • Service desk",
      status: "syncing",
      version: "2.7.8",
      lastSeen: "38 seconds ago",
      syncLag: "1.3 min",
      secureWorkflow: true,
    },
    {
      id: "device-03",
      name: "Islamabad Retail Hub",
      location: "Islamabad • Front office",
      status: "warning",
      version: "2.7.6",
      lastSeen: "15 minutes ago",
      syncLag: "9.2 min",
      secureWorkflow: false,
    },
    {
      id: "device-04",
      name: "Warehouse Terminal 05",
      location: "Peshawar • Warehouse",
      status: "healthy",
      version: "2.7.8",
      lastSeen: "1 minute ago",
      syncLag: "0.5 min",
      secureWorkflow: true,
    },
  ],
  documents: [
    { id: "doc-policy", name: "Cloud sync policy", kind: "policy", sizeLabel: "814 KB" },
    { id: "doc-config", name: "Production config baseline", kind: "config", sizeLabel: "2.1 MB" },
    { id: "doc-audit", name: "Last audit trail", kind: "audit", sizeLabel: "1.4 MB" },
  ],
};

const STATUS_META: Record<SyncStatus, { label: string; badge: string }> = {
  healthy: { label: "Healthy", badge: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30" },
  syncing: { label: "Syncing", badge: "bg-sky-500/15 text-sky-200 ring-1 ring-sky-400/30" },
  warning: { label: "Warning", badge: "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30" },
  offline: { label: "Offline", badge: "bg-slate-500/15 text-slate-200 ring-1 ring-slate-400/30" },
  blocked: { label: "Blocked", badge: "bg-red-500/15 text-red-200 ring-1 ring-red-400/30" },
};

function formatDateTime(value: string): string {
  if (!value) return "Not available";
  try {
    return new Date(value).toLocaleString("en-PK", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return value;
  }
}

export function CloudConfigWorkspace() {
  const [payload, setPayload] = useState<CloudConfigResponse>(FALLBACK_RESPONSE);
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

      const response = await fetch("/api/workspace/cloud-config", {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`,
        },
      });

      const json = (await response.json()) as Partial<CloudConfigResponse>;
      if (!response.ok) {
        throw new Error(
          typeof json?.error === "string" && json.error ? json.error : "Cloud config data could not be loaded."
        );
      }

      const nextPayload: CloudConfigResponse = {
        title: json.title ?? FALLBACK_RESPONSE.title,
        summary: json.summary ?? FALLBACK_RESPONSE.summary,
        secureWorkflow: json.secureWorkflow ?? FALLBACK_RESPONSE.secureWorkflow,
        syncSummary: json.syncSummary ?? FALLBACK_RESPONSE.syncSummary,
        metadata: json.metadata ?? FALLBACK_RESPONSE.metadata,
        devices: json.devices && json.devices.length > 0 ? json.devices : FALLBACK_RESPONSE.devices,
        documents: json.documents && json.documents.length > 0 ? json.documents : FALLBACK_RESPONSE.documents,
        lastSyncedAt: json.lastSyncedAt ?? FALLBACK_RESPONSE.lastSyncedAt,
        refreshedAt: json.refreshedAt ?? new Date().toISOString(),
      };

      setPayload(nextPayload);
      setAuthState("authenticated");
    } catch (cause) {
      setAuthState("error");
      setError(cause instanceof Error ? cause.message : "Cloud sync state is temporarily unavailable.");
      setPayload(FALLBACK_RESPONSE);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const canEdit = useMemo(() => payload.secureWorkflow, [payload.secureWorkflow]);

  if (authState === "locked") {
    return (
      <GlassCard className="rounded-2xl border border-amber-400/30 bg-slate-950/80 p-8 text-slate-200" variant="strong">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-amber-300" />
          <div>
            <h2 className="text-lg font-semibold text-white">Cloud config is locked</h2>
            <p className="mt-2 text-sm text-slate-300">
              Sign in with an authenticated session to access the RLS-scoped cloud configuration workspace.
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
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-cyan-300">Cloud workspace</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">{payload.title}</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-300">{payload.summary}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadData(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-cyan-400 hover:text-white"
            >
              <RefreshCcw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
            <button
              type="button"
              disabled={!canEdit}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileText className="h-4 w-4" />
              View config
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-cyan-400 hover:text-white"
            >
              <Download className="h-4 w-4" />
              Download
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
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Sync health</p>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <p className="text-3xl font-semibold text-white">{payload.syncSummary.online}</p>
              <p className="mt-1 text-xs text-slate-400">/ {payload.devices.length} devices online</p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-emerald-300" />
          </div>
        </GlassCard>

        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4" variant="strong">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Running</p>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <p className="text-3xl font-semibold text-white">{payload.syncSummary.syncing}</p>
              <p className="mt-1 text-xs text-slate-400">device(s) syncing</p>
            </div>
            <Wifi className="h-5 w-5 text-cyan-300" />
          </div>
        </GlassCard>

        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4" variant="strong">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Warnings</p>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <p className="text-3xl font-semibold text-white">{payload.syncSummary.warning}</p>
              <p className="mt-1 text-xs text-slate-400">sync anomalies</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-amber-300" />
          </div>
        </GlassCard>

        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4" variant="strong">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Secure workflow</p>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <p className="text-xl font-semibold text-white">{payload.secureWorkflow ? "Verified" : "Restricted"}</p>
              <p className="mt-1 text-xs text-slate-400">{payload.secureWorkflow ? "Read-only controls enabled" : "Edit access not verified"}</p>
            </div>
            <ShieldCheck className={cn("h-5 w-5", payload.secureWorkflow ? "text-emerald-300" : "text-amber-300")} />
          </div>
        </GlassCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_0.9fr]">
        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">Device sync status</h2>
            <span className="text-xs text-slate-400">Last synced {formatDateTime(payload.lastSyncedAt)}</span>
          </div>

          <div className="mt-4 space-y-3">
            {payload.devices.map((device) => {
              const meta = STATUS_META[device.status] ?? STATUS_META.warning;
              return (
                <div key={device.id} className="flex flex-col gap-3 rounded-xl border border-slate-700/60 bg-slate-900/70 p-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-white">{device.name}</p>
                      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium", meta.badge)}>
                        {meta.label}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-400">{device.location}</p>
                  </div>
                  <div className="grid gap-2 text-right text-xs text-slate-300 sm:grid-cols-3">
                    <div>
                      <p className="text-slate-500">Version</p>
                      <p className="font-medium text-slate-200">{device.version}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">Last seen</p>
                      <p className="font-medium text-slate-200">{device.lastSeen}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">Lag</p>
                      <p className="font-medium text-slate-200">{device.syncLag}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </GlassCard>

        <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
          <h2 className="text-lg font-semibold text-white">Config metadata</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
              <dt className="text-slate-400">Application</dt>
              <dd className="text-right font-medium text-slate-100">{payload.metadata.appName}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
              <dt className="text-slate-400">Environment</dt>
              <dd className="text-right font-medium text-slate-100">{payload.metadata.environment}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
              <dt className="text-slate-400">Version</dt>
              <dd className="text-right font-medium text-slate-100">{payload.metadata.configVersion}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
              <dt className="text-slate-400">Scope</dt>
              <dd className="text-right font-medium text-slate-100">{payload.metadata.scope}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
              <dt className="text-slate-400">Published by</dt>
              <dd className="text-right font-medium text-slate-100">{payload.metadata.publishedBy}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
              <dt className="text-slate-400">Published</dt>
              <dd className="text-right font-medium text-slate-100">{formatDateTime(payload.metadata.publishedAt)}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
              <dt className="text-slate-400">Source</dt>
              <dd className="text-right font-medium text-slate-100">{payload.metadata.source}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 pb-1">
              <dt className="text-slate-400">Storage</dt>
              <dd className="text-right font-medium text-slate-100">{payload.metadata.storage}</dd>
            </div>
          </dl>
        </GlassCard>
      </div>

      <GlassCard className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-5" variant="strong">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Document controls</h2>
          <button
            type="button"
            disabled={!canEdit}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-100 transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ShieldCheck className="h-4 w-4" />
            {canEdit ? "Secure edit flow" : "Secure edit required"}
          </button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {payload.documents.map((document) => (
            <div key={document.id} className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">{document.name}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-400">{document.kind}</p>
                </div>
                <FileText className="h-5 w-5 text-cyan-300" />
              </div>
              <div className="mt-4 flex items-center justify-between gap-2 text-xs text-slate-300">
                <span>{document.sizeLabel}</span>
                <div className="flex items-center gap-2">
                  <button type="button" className="rounded-lg border border-slate-600 px-2 py-1 text-slate-100 transition hover:border-cyan-400">
                    Open
                  </button>
                  <button type="button" className="rounded-lg border border-slate-600 px-2 py-1 text-slate-100 transition hover:border-cyan-400">
                    Download
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </GlassCard>
    </div>
  );
}
