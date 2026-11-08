"use client";

import { AlertCircle, Ban, CheckCircle2, LoaderCircle, MonitorSmartphone, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatDateTime, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface DeviceRow {
  id: string;
  branch_id: string | null;
  branch_name: string;
  name: string;
  fingerprint: string;
  platform: string | null;
  status: string;
  notes: string | null;
  registered_by_name: string;
  approved_by_name: string;
  approved_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

interface DevicesResponse {
  rows: DeviceRow[];
  summary: {
    total: number;
    approved: number;
    pending: number;
    revoked: number;
    recentlySeen: number;
  };
  error?: string;
}

export function DevicesWorkspace({ item }: { item: WorkspaceModule }) {
  const { branches } = useStaffAuth();
  const [branchId, setBranchId] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [deviceNotes, setDeviceNotes] = useState("");
  const [deviceBranchId, setDeviceBranchId] = useState("");
  const [deviceFingerprint, setDeviceFingerprint] = useState("");
  const [devicePlatform, setDevicePlatform] = useState("");
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [summary, setSummary] = useState<DevicesResponse["summary"]>({
    total: 0, approved: 0, pending: 0, revoked: 0, recentlySeen: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [savingAction, setSavingAction] = useState("");

  useEffect(() => {
    try {
      const storageKey = "alhaqfarms.web-device-fingerprint";
      let fingerprint = window.localStorage.getItem(storageKey);
      if (!fingerprint) {
        fingerprint = window.crypto.randomUUID();
        window.localStorage.setItem(storageKey, fingerprint);
      }
      setDeviceFingerprint(`web-${fingerprint}`);
      setDevicePlatform(window.navigator.platform || "Web browser");
      setDeviceName(window.navigator.platform ? `${window.navigator.platform} browser` : "Web browser");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not identify this browser.");
    }
  }, []);

  useEffect(() => {
    if (!deviceBranchId && branches.length) setDeviceBranchId(branches[0].id);
  }, [branches, deviceBranchId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams();
    if (branchId !== "all") parameters.set("branchId", branchId);
    if (status !== "all") parameters.set("status", status);
    if (search.trim()) parameters.set("search", search.trim());

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/workspace/devices?${parameters.toString()}`, {
            cache: "no-store",
            credentials: "same-origin",
          });
          const payload = await response.json() as DevicesResponse;
          if (!active) return;
          if (!response.ok) throw new Error(payload.error || "Could not load registered devices.");
          setRows(payload.rows || []);
          setSummary(payload.summary);
        } catch (loadError) {
          if (!active) return;
          setError(loadError instanceof Error ? loadError.message : "Could not load registered devices.");
          setRows([]);
        } finally {
          if (active) setLoading(false);
        }
      })();
    }, search.trim() ? 220 : 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [branchId, reloadKey, search, status]);

  const cards = [
    { label: "Registered", value: summary.total.toLocaleString(), note: "All terminals in scope" },
    { label: "Approved", value: summary.approved.toLocaleString(), note: "Trusted terminals" },
    { label: "Pending", value: summary.pending.toLocaleString(), note: "Waiting for an administrator" },
    { label: "Seen recently", value: summary.recentlySeen.toLocaleString(), note: "Connected in the last 15 minutes" },
  ];

  const submitDeviceAction = async (action: "register" | "approve" | "revoke", deviceId?: string) => {
    setSavingAction(deviceId || action);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/workspace/devices", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          deviceId,
          name: deviceName,
          notes: deviceNotes,
          branchId: deviceBranchId,
          fingerprint: deviceFingerprint,
          platform: devicePlatform,
        }),
      });
      const payload = await response.json() as { error?: string; warning?: string };
      if (!response.ok) throw new Error(payload.error || "Could not update the device.");
      setNotice(payload.warning || null);
      setDialogOpen(false);
      setDeviceNotes("");
      setReloadKey((value) => value + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not update the device.");
    } finally {
      setSavingAction("");
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Review and manage registered terminals and browsers in your branch scope.</p>
        </div>
        <div className="heading-actions">
          <button className="primary-button" type="button" disabled={!deviceFingerprint || !branches.length} onClick={() => setDialogOpen(true)}>
            <Plus size={14} /> Register this computer
          </button>
          <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            {loading ? <><LoaderCircle className="spin" size={15} /> Loading…</> : <><RefreshCw size={15} /> Refresh</>}
          </button>
        </div>
      </div>

      <div className="notice info" role="note">
        <MonitorSmartphone size={16} />
        <span>Browser registration creates a separate web-device identity. It does not replace the fingerprint used by a Windows POS terminal.</span>
      </div>

      <section className="dashboard-stats" aria-label="Device summary">
        {cards.map((card) => (
          <article className="dashboard-stat card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.note}</small>
          </article>
        ))}
      </section>

      <div className="workspace-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="Search devices"
            placeholder="Search device, platform or branch"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="visually-hidden-label">
          Branch
          <select className="toolbar-select" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            <option value="all">All accessible branches</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </label>
        <label className="visually-hidden-label">
          Status
          <select className="toolbar-select" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending</option>
            <option value="revoked">Revoked</option>
          </select>
        </label>
      </div>

      {error && (
        <div className="card panel" role="alert">
          <div className="inline-message error"><AlertCircle size={16} /><span>{error}</span></div>
        </div>
      )}
      {notice && <div className="notice warning" role="status">{notice}</div>}

      <section className="card table-wrap workspace-table" aria-label="Registered devices">
        <div className="table-document-heading">
          <strong>{item.title}</strong>
          <TableDocumentTools tableId="devices-table" title={item.title} disabled={loading || Boolean(error) || !rows.length} />
        </div>

        {loading ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading registered devices…</div>
        ) : !error && !rows.length ? (
          <div className="empty">
            <MonitorSmartphone size={23} />
            <h2>No devices registered</h2>
            <p>Terminals appear after they synchronize with this branch network.</p>
          </div>
        ) : !error ? (
          <table id="devices-table">
            <thead>
              <tr>
                <th>Device</th><th>Platform</th><th>Fingerprint</th><th>Branch</th>
                <th>Status</th><th>Last seen</th><th>Registered</th><th>Approved by</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className="primary-cell">{row.name}</span>
                    {row.notes && <small className="sales-cell-subtext">{row.notes}</small>}
                  </td>
                  <td>{row.platform || "—"}</td>
                  <td><span className="mono">{row.fingerprint.slice(0, 16)}…</span></td>
                  <td>{row.branch_name}</td>
                  <td><span className={`status ${statusTone(row.status)}`}>{labelize(row.status)}</span></td>
                  <td className="nowrap">{row.last_seen_at ? formatDateTime(row.last_seen_at) : "Never"}</td>
                  <td className="nowrap">{formatDateTime(row.created_at)}</td>
                  <td>{row.approved_by_name}{row.approved_at && <small className="sales-cell-subtext">{formatDateTime(row.approved_at)}</small>}</td>
                  <td className="row-actions">
                    {row.status === "pending" && (
                      <button className="secondary-button" type="button" disabled={Boolean(savingAction)} onClick={() => void submitDeviceAction("approve", row.id)}>
                        {savingAction === row.id ? <LoaderCircle className="spin" size={12} /> : <CheckCircle2 size={12} />} Approve
                      </button>
                    )}
                    {row.status !== "revoked" && (
                      <button className="secondary-button" type="button" disabled={Boolean(savingAction)} onClick={() => void submitDeviceAction("revoke", row.id)}>
                        {savingAction === row.id ? <LoaderCircle className="spin" size={12} /> : <Ban size={12} />} Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <p className="list-limit-note">Showing {rows.length} device{rows.length === 1 ? "" : "s"} from the synchronized register.</p>

      {dialogOpen && (
        <div className="sales-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDialogOpen(false);
        }}>
          <section className="sales-dialog card" role="dialog" aria-modal="true" aria-labelledby="device-register-title">
            <header className="sales-dialog-header">
              <div><p className="eyebrow page">Device registry</p><h2 id="device-register-title">Register this browser</h2></div>
              <button className="button secondary" type="button" onClick={() => setDialogOpen(false)} aria-label="Close dialog">×</button>
            </header>
            <form className="workspace-form" onSubmit={(event) => { event.preventDefault(); void submitDeviceAction("register"); }}>
              <label className="workspace-field">Device name
                <input required maxLength={100} value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
              </label>
              <label className="workspace-field">Branch
                <select required value={deviceBranchId} onChange={(event) => setDeviceBranchId(event.target.value)}>
                  <option value="" disabled>Choose a branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </label>
              <label className="workspace-field">Notes
                <input maxLength={500} placeholder="Optional location or purpose" value={deviceNotes} onChange={(event) => setDeviceNotes(event.target.value)} />
              </label>
              <p className="muted">This browser will be registered as pending. An administrator must approve it.</p>
              {error && <div className="notice" role="alert">{error}</div>}
              <div className="modal-actions">
                <button className="button secondary" type="button" onClick={() => setDialogOpen(false)}>Cancel</button>
                <button className="primary-button" type="submit" disabled={Boolean(savingAction)}>
                  {savingAction ? "Registering…" : "Register browser"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

export default DevicesWorkspace;
