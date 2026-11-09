"use client";

import { AlertCircle, Cloud, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
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
  const [deviceSearch, setDeviceSearch] = useState("");
  const [deviceBranch, setDeviceBranch] = useState("");
  const [deviceStatus, setDeviceStatus] = useState("");
  const [deviceConnection, setDeviceConnection] = useState("");
  const [eventSearch, setEventSearch] = useState("");
  const [eventBranch, setEventBranch] = useState("");
  const [eventAction, setEventAction] = useState("");

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
  const deviceRows = useMemo(() => (payload?.rows || []).filter((device) => {
    const query = deviceSearch.trim().toLocaleLowerCase();
    return (!query || [device.name, device.branch_name, device.platform, device.status, device.online ? "online" : "offline"]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query)))
      && (!deviceBranch || device.branch_name === deviceBranch)
      && (!deviceStatus || device.status === deviceStatus)
      && (!deviceConnection || (device.online ? "online" : "offline") === deviceConnection);
  }), [deviceBranch, deviceConnection, deviceSearch, deviceStatus, payload?.rows]);
  const eventRows = useMemo(() => (payload?.events || []).filter((event) => {
    const query = eventSearch.trim().toLocaleLowerCase();
    return (!query || [event.occurred_at, event.branch_name, event.action, event.entity_type, event.entity_id, event.details]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query)))
      && (!eventBranch || event.branch_name === eventBranch)
      && (!eventAction || event.action === eventAction);
  }), [eventAction, eventBranch, eventSearch, payload?.events]);
  const deviceBranches = [...new Set((payload?.rows || []).map((device) => device.branch_name))].sort();
  const eventBranches = [...new Set((payload?.events || []).map((event) => event.branch_name))].sort();
  const deviceStatuses = [...new Set((payload?.rows || []).map((device) => device.status))].sort();
  const eventActions = [...new Set((payload?.events || []).map((event) => event.action))].sort();
  const clearDeviceFilters = () => {
    setDeviceSearch("");
    setDeviceBranch("");
    setDeviceStatus("");
    setDeviceConnection("");
  };
  const clearEventFilters = () => {
    setEventSearch("");
    setEventBranch("");
    setEventAction("");
  };
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

      <HorizontalFilterScroller
        className="cloud-sync-branch-filter"
        ariaLabel="Cloud Sync branch filter"
        style={{ justifyContent: "flex-end", marginBottom: "14px" }}
      >
        {staff?.role === "admin" && (
          <label className="toolbar-control" style={{ flex: "0 0 220px" }}>
            <span>Branch</span>
            <SearchableFilter
              value={branchId || "all"}
              ariaLabel="Filter Cloud Sync by branch"
              placeholder="All accessible branches"
              options={[
                { value: "all", label: "All accessible branches" },
                ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
              ]}
              onChange={setBranchId}
            />
          </label>
        )}
      </HorizontalFilterScroller>

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

          <div className="workspace-table-group" role="group" aria-label="Synchronizing devices">
            <HorizontalFilterScroller className="cloud-sync-filter-row" ariaLabel="Device table filters">
              <label className="search-field" style={{ flex: "1 0 220px", minWidth: 180 }}>
                <Search size={16} aria-hidden="true" />
                <input aria-label="Search devices" placeholder="Search devices" value={deviceSearch} onChange={(event) => setDeviceSearch(event.target.value)} />
              </label>
              <label className="toolbar-control" style={{ flex: "0 0 155px" }}>
                <span>Branch</span>
                <SearchableFilter value={deviceBranch} ariaLabel="Filter devices by branch" placeholder="All branches"
                  options={[{ value: "", label: "All branches" }, ...deviceBranches.map((branch) => ({ value: branch, label: branch }))]}
                  onChange={setDeviceBranch} />
              </label>
              <label className="toolbar-control" style={{ flex: "0 0 145px" }}>
                <span>Status</span>
                <SearchableFilter value={deviceStatus} ariaLabel="Filter devices by status" placeholder="All statuses"
                  options={[{ value: "", label: "All statuses" }, ...deviceStatuses.map((status) => ({ value: status, label: labelize(status) }))]}
                  onChange={setDeviceStatus} />
              </label>
              <label className="toolbar-control" style={{ flex: "0 0 145px" }}>
                <span>Connection</span>
                <SearchableFilter value={deviceConnection} ariaLabel="Filter devices by connection" placeholder="All connections"
                  options={[{ value: "", label: "All connections" }, { value: "online", label: "Online" }, { value: "offline", label: "Offline" }]}
                  onChange={setDeviceConnection} />
              </label>
              <button className="button link" type="button" onClick={clearDeviceFilters}>Clear</button>
            </HorizontalFilterScroller>
            <section className="card table-wrap workspace-table" aria-label="Synchronizing devices">
            <div className="table-document-heading">
              <strong>Devices · {payload.branchName} · {deviceRows.length} shown</strong>
              <TableDocumentTools tableId="cloud-sync-devices" title={`${item.title} devices`} disabled={!deviceRows.length} />
            </div>
            <table id="cloud-sync-devices">
              <thead><tr><th>Device</th><th>Branch</th><th>Platform</th><th>Status</th><th>Last seen</th><th>Connection</th></tr></thead>
              <tbody>
                {deviceRows.length ? deviceRows.map((device) => (
                  <tr key={device.id}>
                    <td><span className="primary-cell">{device.name}</span></td>
                    <td>{device.branch_name}</td>
                    <td>{device.platform || "—"}</td>
                    <td><span className={`status ${statusTone(device.status)}`}>{labelize(device.status)}</span></td>
                    <td className="nowrap">{device.last_seen_at ? formatDateTime(device.last_seen_at) : "Never"}</td>
                    <td><span className={`status ${device.online ? "green" : ""}`}>{device.online ? "Online" : "Offline"}</span></td>
                  </tr>
                )) : <tr><td colSpan={6} className="empty">{payload.rows.length ? "No devices match these filters." : "No devices are registered for this scope."}</td></tr>}
              </tbody>
            </table>
            </section>
          </div>

          <div className="workspace-table-group" role="group" aria-label="Recent synchronization events">
            <HorizontalFilterScroller className="cloud-sync-filter-row" ariaLabel="Synchronization event table filters">
              <label className="search-field" style={{ flex: "1 0 220px", minWidth: 180 }}>
                <Search size={16} aria-hidden="true" />
                <input aria-label="Search synchronization events" placeholder="Search events" value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} />
              </label>
              <label className="toolbar-control" style={{ flex: "0 0 155px" }}>
                <span>Branch</span>
                <SearchableFilter value={eventBranch} ariaLabel="Filter events by branch" placeholder="All branches"
                  options={[{ value: "", label: "All branches" }, ...eventBranches.map((branch) => ({ value: branch, label: branch }))]}
                  onChange={setEventBranch} />
              </label>
              <label className="toolbar-control" style={{ flex: "0 0 170px" }}>
                <span>Action</span>
                <SearchableFilter value={eventAction} ariaLabel="Filter events by action" placeholder="All actions"
                  options={[{ value: "", label: "All actions" }, ...eventActions.map((action) => ({ value: action, label: labelize(action) }))]}
                  onChange={setEventAction} />
              </label>
              <button className="button link" type="button" onClick={clearEventFilters}>Clear</button>
            </HorizontalFilterScroller>
            <section className="card table-wrap workspace-table" aria-label="Recent synchronization events">
            <div className="table-document-heading">
              <strong>Recent synchronization events · {eventRows.length} shown</strong>
              <TableDocumentTools tableId="cloud-sync-events" title={`${item.title} events`} disabled={!eventRows.length} />
            </div>
            {payload.eventsError && <p className="error-banner" role="alert">{payload.eventsError}</p>}
            <table id="cloud-sync-events">
              <thead><tr><th>When</th><th>Branch</th><th>Action</th><th>Record</th><th>Details</th></tr></thead>
              <tbody>
                {eventRows.length ? eventRows.map((event) => (
                  <tr key={event.id}>
                    <td className="nowrap">{formatDateTime(event.occurred_at)}</td>
                    <td>{event.branch_name}</td>
                    <td>{labelize(event.action)}</td>
                    <td>{event.entity_id || event.entity_type}</td>
                    <td>{event.details || "—"}</td>
                  </tr>
                )) : <tr><td colSpan={5} className="empty">{payload.events.length ? "No events match these filters." : "No synchronization events recorded in the last 7 days."}</td></tr>}
              </tbody>
            </table>
            </section>
          </div>

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
