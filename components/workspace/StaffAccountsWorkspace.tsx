"use client";

import { AlertCircle, Ban, LoaderCircle, Pencil, Plus, RefreshCw, Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { formatDateTime, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface StaffRow {
  id: string;
  user_id: string | null;
  local_staff_id: string | null;
  full_name: string;
  email: string;
  username: string;
  role: string;
  branch_id: string | null;
  branch_name: string;
  is_active: boolean;
  web_enrolled: boolean;
  created_at: string;
}

interface StaffAccountsResponse {
  rows: StaffRow[];
  branches: Array<{ id: string; name: string; code?: string | null }>;
  summary: {
    total: number;
    active: number;
    inactive: number;
    webEnrolled: number;
    admins: number;
  };
  error?: string;
}

export function StaffAccountsWorkspace({ item }: { item: WorkspaceModule }) {
  const { branches } = useStaffAuth();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [branchId, setBranchId] = useState("all");
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [summary, setSummary] = useState<StaffAccountsResponse["summary"]>({
    total: 0, active: 0, inactive: 0, webEnrolled: 0, admins: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams();
    if (branchId && branchId !== "all") parameters.set("branchId", branchId);
    if (role && role !== "all") parameters.set("role", role);
    if (status && status !== "all") parameters.set("status", status);
    if (search.trim()) parameters.set("search", search.trim());

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/workspace/staff-accounts?${parameters.toString()}`, {
            cache: "no-store",
            credentials: "same-origin",
          });
          const payload = await response.json() as StaffAccountsResponse;
          if (!active) return;
          if (!response.ok) throw new Error(payload.error || "Could not load staff accounts.");
          setRows(payload.rows || []);
          setSummary(payload.summary);
        } catch (loadError) {
          if (!active) return;
          setError(loadError instanceof Error ? loadError.message : "Could not load staff accounts.");
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
  }, [branchId, reloadKey, role, search, status]);

  const cards = [
    { label: "Staff accounts", value: summary.total.toLocaleString(), note: `${summary.admins} administrators` },
    { label: "Active", value: summary.active.toLocaleString(), note: "Can sign in when enrolled" },
    { label: "Web enrolled", value: summary.webEnrolled.toLocaleString(), note: "Linked to a Supabase login" },
    { label: "Inactive", value: summary.inactive.toLocaleString(), note: "Access disabled" },
  ];

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Profiles, roles, and branch assignment are managed centrally and shown here read-only.</p>
        </div>
        <div className="heading-actions">
          <button className="primary-button" type="button" disabled title="Adding staff profiles is a Windows desktop workflow.">
            <Plus size={14} /> Add staff profile
          </button>
          <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            {loading ? <><LoaderCircle className="spin" size={15} /> Loading…</> : <><RefreshCw size={15} /> Refresh</>}
          </button>
        </div>
      </div>

      <div className="notice info" role="note">
        <Users size={16} />
        <span>Adding staff, issuing invitations, and changing roles are Windows desktop workflows. This web view mirrors the synchronized roster.</span>
      </div>

      <section className="dashboard-stats" aria-label="Staff account summary">
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
            aria-label="Search staff accounts"
            placeholder="Search name, email or username"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="visually-hidden-label">
          Role
          <select className="toolbar-select" value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="all">All roles</option>
            <option value="admin">Admin</option>
            <option value="manager">Manager</option>
            <option value="cashier">Cashier</option>
          </select>
        </label>
        <label className="visually-hidden-label">
          Status
          <select className="toolbar-select" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <label className="visually-hidden-label">
          Branch
          <select className="toolbar-select" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            <option value="all">All accessible branches</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </label>
      </div>

      {error && (
        <div className="card panel" role="alert">
          <div className="inline-message error"><AlertCircle size={16} /><span>{error}</span></div>
        </div>
      )}

      <section className="card table-wrap workspace-table" aria-label="Staff accounts">
        <div className="table-document-heading">
          <strong>{item.title}</strong>
          <TableDocumentTools tableId="staff-accounts-table" title={item.title} disabled={loading || Boolean(error) || !rows.length} />
        </div>

        {loading ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Loading staff accounts…</div>
        ) : !error && !rows.length ? (
          <div className="empty">
            <Users size={23} />
            <h2>No staff accounts found</h2>
            <p>Try a different search, role, status, or branch.</p>
          </div>
        ) : !error ? (
          <table id="staff-accounts-table">
            <thead>
              <tr>
                <th>Staff member</th><th>Username</th><th>Role</th><th>Branch</th>
                <th>Web access</th><th>Status</th><th>Created</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><span className="primary-cell">{row.full_name}</span><small className="sales-cell-subtext">{row.email}</small></td>
                  <td>{row.username || "Not set"}</td>
                  <td>{labelize(row.role)}</td>
                  <td>{row.branch_name}</td>
                  <td>{row.web_enrolled ? <span className="status green">Enrolled</span> : <span className="status">Not enrolled</span>}</td>
                  <td><span className={`status ${statusTone(row.is_active ? "active" : "inactive")}`}>{row.is_active ? "Active" : "Inactive"}</span></td>
                  <td className="nowrap">{formatDateTime(row.created_at)}</td>
                  <td className="row-actions">
                    <button className="secondary-button" type="button" disabled title="Editing staff profiles is a Windows desktop workflow."><Pencil size={12} /> Edit</button>
                    <button className="secondary-button" type="button" disabled title="Issuing staff invitations is a Windows desktop workflow.">Issue invite</button>
                    <button className="secondary-button" type="button" disabled title="Changing account status is a Windows desktop workflow.">{row.is_active ? "Deactivate" : "Activate"}</button>
                    <button className="secondary-button" type="button" disabled title="Restoring staff profiles is a Windows desktop workflow.">Restore</button>
                    <button className="secondary-button" type="button" disabled title="Archiving staff profiles is a Windows desktop workflow.">Archive</button>
                    <button className="secondary-button" type="button" disabled title="Deleting staff profiles is a Windows desktop workflow.">Delete</button>
                    <button className="secondary-button" type="button" disabled title="Blocking this terminal is a Windows desktop workflow."><Ban size={12} /> Block here</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <p className="list-limit-note">Showing {rows.length} staff account{rows.length === 1 ? "" : "s"} from the synchronized cloud roster.</p>
    </>
  );
}

export default StaffAccountsWorkspace;
