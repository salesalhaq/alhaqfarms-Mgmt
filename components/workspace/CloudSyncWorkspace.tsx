"use client";

import { AlertCircle, Cloud, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatDateTime, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface SyncDevice {
  id: string;
  branch_id: string | null;
  branch_name: string;
  name: string;
  platform: string | null;
  status: string;
  last_seen_at: string | null;
  created_at: string;
  online: boolean;
}

interface SyncEvent {
  id: string;
  occurred_at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  branch_id: string | null;
  branch_name: string;
  details: string;
}

interface CloudSyncResponse {
  branchId: string | null;
  branchName: string;
  rows: SyncDevice[];
  events: SyncEvent[];
  summary: {
    devices: number;
    approved: number;
    pending: number;
    revoked: number;
    online: number;
    lastSeenAt: string | null;
    eventCount?: number;
  };
  note?: string;
  eventsError?: string;
  error?: string;
}

export function CloudSyncWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [payload, setPayload] = useState<CloudSyncResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!staff) return;
    if (staff.role === "admin" && !branchId) setBranchId("all");
    else if (staff.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff]);

  useEffect(() => {
    if (!staff) return undefined;
    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams();
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/cloud-sync?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as CloudSyncResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load cloud synchronization status.");
        setPayload(result);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load cloud synchronization status.");
        setPayload(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, reloadKey, staff]);

  const summary = payload?.summary;
  const cards = summary ? [
    { label: "Devices", value: summary.devices.toLocaleString(), note: `${summary.online} seen in the last 15 minutes` },
    { label: "Approved", value: summary.approved.toLocaleString(), note: "Trusted terminals" },
    { label: "Pending", value: summary.pending.toLocaleString(), note: "Waiting for approval" },
    { label: "Revoked", value: summary.revoked.toLocaleString(), note: "Access disabled" },
    { label: "Last device seen", value: summary.lastSeenAt ? formatDateTime(summary.lastSeenAt) : "Never", note: payload?.branchName || "Branch scope" },
  ] : [];

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Monitor registered devices and recent synchronization events from the cloud ledger.</p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            {loading ? <><LoaderCircle className="spin" size={15} /> Loading…</> : <><RefreshCw size={15} /> Refresh</>}
          </button>
        </div>
      </div>

      <div className="notice info" role="note">
        <Cloud size={16} />
        <span>{payload?.note || "The desktop sync outbox, retries, and connection credentials stay on each Windows terminal."}</span>
      </div>

      <div className="daily-report-toolbar daily-report-no-print">
        {staff?.role === "admin" && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select className="toolbar-select" value={branchId || "all"} onChange={(event) => setBranchId(event.target.value)}>
              <option value="all">All accessible branches</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && (
        <div className="card panel" role="alert">
          <div className="inline-message error"><AlertCircle size={16} /><span>{error}</span></div>
        </div>
      )}

      {loading && !payload && <div className="card loading"><LoaderCircle size={18} className="spin" /> Checking cloud synchronization…</div>}

      {!loading && payload && (
        <>
          <section className="dashboard-stats" aria-label="Cloud synchronization summary">
            {cards.map((card) => (
              <article className="dashboard-stat card" key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.note}</small>
              </article>
            ))}
          </section>

          <section className="card table-wrap workspace-table" aria-label="Synchronizing devices">
            <div className="table-document-heading">
              <strong>Devices · {payload.branchName}</strong>
              <TableDocumentTools tableId="cloud-sync-devices" title={`${item.title} devices`} disabled={!payload.rows.length} />
            </div>
            <table id="cloud-sync-devices">
              <thead><tr><th>Device</th><th>Branch</th><th>Platform</th><th>Status</th><th>Last seen</th><th>Connection</th></tr></thead>
              <tbody>
                {payload.rows.length ? payload.rows.map((device) => (
                  <tr key={device.id}>
                    <td><span className="primary-cell">{device.name}</span></td>
                    <td>{device.branch_name}</td>
                    <td>{device.platform || "—"}</td>
                    <td><span className={`status ${statusTone(device.status)}`}>{labelize(device.status)}</span></td>
                    <td className="nowrap">{device.last_seen_at ? formatDateTime(device.last_seen_at) : "Never"}</td>
                    <td><span className={`status ${device.online ? "green" : ""}`}>{device.online ? "Online" : "Offline"}</span></td>
                  </tr>
                )) : <tr><td colSpan={6} className="empty">No devices are registered for this scope.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="card table-wrap workspace-table" aria-label="Recent synchronization events">
            <div className="table-document-heading">
              <strong>Recent synchronization events · last 7 days</strong>
              <TableDocumentTools tableId="cloud-sync-events" title={`${item.title} events`} disabled={!payload.events.length} />
            </div>
            {payload.eventsError && <p className="error-banner" role="alert">{payload.eventsError}</p>}
            <table id="cloud-sync-events">
              <thead><tr><th>When</th><th>Branch</th><th>Action</th><th>Record</th><th>Details</th></tr></thead>
              <tbody>
                {payload.events.length ? payload.events.map((event) => (
                  <tr key={event.id}>
                    <td className="nowrap">{formatDateTime(event.occurred_at)}</td>
                    <td>{event.branch_name}</td>
                    <td>{labelize(event.action)}</td>
                    <td>{event.entity_id || event.entity_type}</td>
                    <td>{event.details || "—"}</td>
                  </tr>
                )) : <tr><td colSpan={5} className="empty">No synchronization events recorded in the last 7 days.</td></tr>}
              </tbody>
            </table>
          </section>

          <div className="notice info" role="note">
            <Cloud size={16} />
            <span>Cloud monitoring is read-only here. To change a PC&apos;s connection, push or pull data, retry its local outbox, or manage an HQ support session, use that PC&apos;s Windows app.</span>
          </div>
        </>
      )}
    </>
  );
}

export default CloudSyncWorkspace;
