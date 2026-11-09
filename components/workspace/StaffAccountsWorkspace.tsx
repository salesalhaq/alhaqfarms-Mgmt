"use client";

import { AlertCircle, Archive, Copy, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import { WorkspaceDialog, WorkspaceError, WorkspaceField, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";
import { formatDateTime, labelize } from "@/lib/format";
import { postWorkspaceAction } from "@/lib/workspace/write-client";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface StaffRow {
  id: string;
  user_id: string | null;
  full_name: string;
  email: string | null;
  username: string | null;
  role: string;
  branch_id: string | null;
  branch_name: string;
  is_active: boolean;
  web_enrolled: boolean;
  pin_configured: boolean;
  created_at: string;
  deleted_at: string | null;
  permanently_deleted_at: string | null;
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

interface StaffForm {
  id: string | null;
  fullName: string;
  email: string;
  username: string;
  role: string;
  branchId: string;
}

interface InvitationState {
  name: string;
  code: string;
  expiresAt: string;
}

interface CredentialForm {
  staffId: string;
  staffName: string;
  mode: "password" | "pin";
  value: string;
  confirmation: string;
}

const EMPTY_SUMMARY: StaffAccountsResponse["summary"] = {
  total: 0,
  active: 0,
  inactive: 0,
  webEnrolled: 0,
  admins: 0,
};

function isArchived(row: StaffRow): boolean {
  return Boolean(row.deleted_at);
}

export function StaffAccountsWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const canManageHq = staff?.role === "admin" && !staff.branch_id;
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [branchId, setBranchId] = useState("all");
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [summary, setSummary] = useState<StaffAccountsResponse["summary"]>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [staffForm, setStaffForm] = useState<StaffForm | null>(null);
  const [credentialForm, setCredentialForm] = useState<CredentialForm | null>(null);
  const [invitation, setInvitation] = useState<InvitationState | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams();
    if (branchId && branchId !== "all") parameters.set("branchId", branchId);
    if (role !== "all") parameters.set("role", role);
    if (status !== "all") parameters.set("status", status);
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
          setSummary(payload.summary || EMPTY_SUMMARY);
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

  const startCreate = () => {
    setActionError(null);
    setStaffForm({
      id: null,
      fullName: "",
      email: "",
      username: "",
      role: "cashier",
      branchId: branches[0]?.id || "",
    });
  };

  const startEdit = (row: StaffRow) => {
    setActionError(null);
    setStaffForm({
      id: row.id,
      fullName: row.full_name,
      email: row.email || "",
      username: row.username || "",
      role: row.role,
      branchId: row.branch_id || "",
    });
  };

  const saveStaff = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!staffForm) return;
    setBusy(true);
    setActionError(null);
    try {
      await postWorkspaceAction("/api/workspace/staff-accounts", {
        action: "save_profile",
        ...staffForm,
      });
      setStaffForm(null);
      setSuccess(staffForm.id ? "Staff profile updated." : "Staff profile created.");
      setReloadKey((value) => value + 1);
    } catch (saveError) {
      setActionError(saveError instanceof Error ? saveError.message : "The staff profile could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (
    action: string,
    row: StaffRow,
    confirmation?: string,
  ) => {
    if (confirmation && !window.confirm(confirmation)) return;
    setBusy(true);
    setActionError(null);
    setSuccess(null);
    try {
      await postWorkspaceAction("/api/workspace/staff-accounts", { action, id: row.id });
      setSuccess(
        action === "archive" ? `${row.full_name} archived.`
          : action === "restore" ? `${row.full_name} restored inactive.`
            : `${row.full_name}'s profile was permanently deleted and anonymized.`,
      );
      setReloadKey((value) => value + 1);
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "The staff account action failed.");
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (row: StaffRow) => {
    setBusy(true);
    setActionError(null);
    setSuccess(null);
    try {
      await postWorkspaceAction("/api/workspace/staff-accounts", {
        action: "set_active",
        id: row.id,
        isActive: !row.is_active,
      });
      setSuccess(`${row.full_name} ${row.is_active ? "deactivated" : "activated"}.`);
      setReloadKey((value) => value + 1);
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "The staff account status could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  const issueInvitation = async (row: StaffRow) => {
    setBusy(true);
    setActionError(null);
    setSuccess(null);
    try {
      const result = await postWorkspaceAction<{ invitation: { code: string; expiresAt: string } }>(
        "/api/workspace/staff-accounts",
        { action: "issue_invitation", id: row.id },
      );
      setInvitation({ name: row.full_name, ...result.invitation });
      setReloadKey((value) => value + 1);
    } catch (inviteError) {
      setActionError(inviteError instanceof Error ? inviteError.message : "The invitation could not be issued.");
    } finally {
      setBusy(false);
    }
  };

  const saveCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!credentialForm) return;
    if (credentialForm.value !== credentialForm.confirmation) {
      setActionError("The new credential and confirmation do not match.");
      return;
    }
    if (credentialForm.mode === "password"
      ? credentialForm.value.length < 10 || credentialForm.value.length > 200
      : !/^\d{4,8}$/.test(credentialForm.value)) {
      setActionError(credentialForm.mode === "password"
        ? "Password must be between 10 and 200 characters."
        : "PIN must contain 4 to 8 digits.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await postWorkspaceAction("/api/workspace/staff-accounts", {
        action: "set_credential",
        id: credentialForm.staffId,
        mode: credentialForm.mode,
        value: credentialForm.value,
      });
      setCredentialForm(null);
      setSuccess(`${credentialForm.mode === "password" ? "Password" : "PIN"} reset for ${credentialForm.staffName}.`);
      setReloadKey((value) => value + 1);
    } catch (credentialError) {
      setActionError(credentialError instanceof Error ? credentialError.message : "The credential could not be reset.");
    } finally {
      setBusy(false);
    }
  };

  const copyInvitation = async () => {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.code);
      setSuccess("Invitation code copied to clipboard.");
    } catch {
      setActionError("The invitation code could not be copied. Select and copy it manually.");
    }
  };

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
          <p>{item.description} HQ can manage profiles, roles, branch assignments, invitations and credentials. Branch-local blocking remains a Windows-only action.</p>
        </div>
        <div className="heading-actions">
          {canManageHq && (
            <button className="primary-button" type="button" onClick={startCreate}>
              <Plus size={14} /> Add staff profile
            </button>
          )}
          <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            {loading ? <><LoaderCircle className="spin" size={15} /> Loading…</> : <><RefreshCw size={15} /> Refresh</>}
          </button>
        </div>
      </div>

      <WorkspaceError message={actionError} />
      <WorkspaceSuccess message={success} />

      <section className="dashboard-stats" aria-label="Staff account summary">
        {cards.map((card) => (
          <article className="dashboard-stat card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.note}</small>
          </article>
        ))}
      </section>

      <HorizontalFilterScroller className="staff-accounts-filterbar" ariaLabel="Staff account filters">
        <label className="search-field">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Search staff accounts"
            placeholder="Search name, email or username"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="toolbar-control">
          <span>Role</span>
          <SearchableFilter
            value={role}
            ariaLabel="Filter staff by role"
            placeholder="All roles"
            options={[
              { value: "all", label: "All roles" },
              { value: "admin", label: "Admin" },
              { value: "manager", label: "Manager" },
              { value: "cashier", label: "Cashier" },
            ]}
            onChange={setRole}
          />
        </label>
        <label className="toolbar-control">
          <span>Status</span>
          <SearchableFilter
            value={status}
            ariaLabel="Filter staff by status"
            placeholder="All statuses"
            options={[
              { value: "all", label: "All statuses" },
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
              ...(canManageHq ? [{ value: "archived", label: "Archived / deleted" }] : []),
            ]}
            onChange={setStatus}
          />
        </label>
        {canManageHq && (
          <label className="toolbar-control">
            <span>Branch</span>
            <SearchableFilter
              value={branchId}
              ariaLabel="Filter staff by branch"
              placeholder="All branches"
              options={[
                { value: "all", label: "All branches" },
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
                <th>Web access</th><th>PIN</th><th>Status</th><th>Created</th>
                {canManageHq && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const archived = isArchived(row);
                const permanentlyDeleted = Boolean(row.permanently_deleted_at);
                const isSelf = row.user_id === staff?.user_id;
                return (
                  <tr key={row.id}>
                    <td>
                      <span className="primary-cell">{row.full_name}</span>
                      {row.email && <small className="sales-cell-subtext">{row.email}</small>}
                      {isSelf && <small className="sales-cell-subtext">You</small>}
                    </td>
                    <td>{row.username || "Not set"}</td>
                    <td>{labelize(row.role)}</td>
                    <td>{row.branch_name}</td>
                    <td>{row.web_enrolled ? <span className="status green">Enrolled</span> : <span className="status">Not enrolled</span>}</td>
                    <td>{row.pin_configured ? <span className="status green">Enabled</span> : <span className="status">Not set</span>}</td>
                    <td>
                      {permanentlyDeleted
                        ? <span className="status">Deleted</span>
                        : archived
                          ? <span className="status">Archived</span>
                          : <span className={`status ${row.is_active ? "green" : "red"}`}>{row.is_active ? "Active" : "Inactive"}</span>}
                    </td>
                    <td className="nowrap">{formatDateTime(row.created_at)}</td>
                    {canManageHq && (
                      <td className="row-actions">
                        {canManageHq && !archived && !permanentlyDeleted && (
                          <>
                            <button className="secondary-button" type="button" onClick={() => startEdit(row)} disabled={busy}>
                              <Pencil size={12} /> Edit
                            </button>
                            <button className="secondary-button" type="button" onClick={() => void issueInvitation(row)} disabled={busy || !row.is_active}>
                              <KeyRound size={12} /> Issue invite
                            </button>
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={() => { setActionError(null); setCredentialForm({ staffId: row.id, staffName: row.full_name, mode: "password", value: "", confirmation: "" }); }}
                              disabled={busy || !row.is_active}
                            >
                              Change password / PIN
                            </button>
                            <button className="secondary-button" type="button" onClick={() => void toggleActive(row)} disabled={busy || isSelf}>
                              {row.is_active ? "Deactivate" : "Activate"}
                            </button>
                          </>
                        )}
                        {canManageHq && !permanentlyDeleted && (archived
                          ? <button className="secondary-button" type="button" onClick={() => void runAction("restore", row)} disabled={busy}><RotateCcw size={12} /> Restore</button>
                          : <button className="secondary-button" type="button" onClick={() => void runAction(
                              "archive",
                              row,
                              `Archive ${row.full_name}'s staff profile? Sign-in will be disabled, but it can be restored later.`,
                            )} disabled={busy || isSelf}><Archive size={12} /> Archive</button>)}
                        {canManageHq && !permanentlyDeleted && (
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => void runAction(
                              "delete_profile",
                              row,
                              `Permanently delete ${row.full_name}? Personal account details will be anonymized and cannot be restored. Sales and audit history will be retained.`,
                            )}
                            disabled={busy || isSelf}
                          >
                            <Trash2 size={12} /> Delete
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>

      <p className="list-limit-note">
        Archive is reversible; restoring leaves the profile inactive until HQ reactivates it. Delete anonymizes the profile permanently while retaining sales and audit history. HR records are independent.
      </p>

      {staffForm && canManageHq && (
        <WorkspaceDialog
          eyebrow="Staff accounts"
          onClose={() => setStaffForm(null)}
          title={staffForm.id ? `Edit ${staffForm.fullName}` : "Add staff profile"}
        >
          <form className="workspace-form" onSubmit={saveStaff}>
            <WorkspaceError message={actionError} />
            <div className="workspace-form-grid">
              <WorkspaceField label="Full name">
                <input required maxLength={200} value={staffForm.fullName} onChange={(event) => setStaffForm((form) => form ? { ...form, fullName: event.target.value } : form)} />
              </WorkspaceField>
              <WorkspaceField label="Email">
                <input required type="email" maxLength={254} autoComplete="off" value={staffForm.email} onChange={(event) => setStaffForm((form) => form ? { ...form, email: event.target.value } : form)} />
              </WorkspaceField>
              <WorkspaceField label="Username" hint="3–50 letters, numbers, dots, underscores or hyphens">
                <input required minLength={3} maxLength={50} pattern="[A-Za-z0-9._-]{3,50}" autoComplete="off" value={staffForm.username} onChange={(event) => setStaffForm((form) => form ? { ...form, username: event.target.value } : form)} />
              </WorkspaceField>
              <WorkspaceField label="Role">
                <select
                  required
                  value={staffForm.role}
                  disabled={Boolean(staffForm.id && rows.find((row) => row.id === staffForm.id)?.user_id === staff?.user_id)}
                  onChange={(event) => setStaffForm((form) => form ? { ...form, role: event.target.value } : form)}
                >
                  <option value="cashier">Cashier</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </WorkspaceField>
              <WorkspaceField label="Branch">
                <select required value={staffForm.branchId} onChange={(event) => setStaffForm((form) => form ? { ...form, branchId: event.target.value } : form)}>
                  <option value="">Choose branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </WorkspaceField>
            </div>
            <p className="list-limit-note">Issue an enrollment invitation after saving. Staff choose their own shared password and optional PIN during enrollment.</p>
            <div className="workspace-form-actions">
              <button className="secondary-button" type="button" onClick={() => setStaffForm(null)}>Cancel</button>
              <button className="primary-button" disabled={busy || !branches.length} type="submit">
                {busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}
                {busy ? "Saving…" : staffForm.id ? "Save changes" : "Create account"}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}

      {credentialForm && canManageHq && (
        <WorkspaceDialog
          eyebrow="Staff accounts"
          onClose={() => setCredentialForm(null)}
          title={`Reset credentials for ${credentialForm.staffName}`}
        >
          <form className="workspace-form" onSubmit={saveCredential}>
            <WorkspaceError message={actionError} />
            <WorkspaceField label="Credential to change">
              <select
                value={credentialForm.mode}
                onChange={(event) => {
                  const mode = event.target.value;
                  if (mode === "password" || mode === "pin") {
                    setCredentialForm((form) => form ? { ...form, mode, value: "", confirmation: "" } : form);
                  }
                }}
              >
                <option value="password">Password</option>
                <option value="pin">PIN</option>
              </select>
            </WorkspaceField>
            <WorkspaceField label={credentialForm.mode === "password" ? "New password" : "New PIN"}>
              <input
                autoComplete="new-password"
                required
                type="password"
                inputMode={credentialForm.mode === "pin" ? "numeric" : undefined}
                minLength={credentialForm.mode === "password" ? 10 : 4}
                maxLength={credentialForm.mode === "password" ? 200 : 8}
                pattern={credentialForm.mode === "pin" ? "[0-9]{4,8}" : undefined}
                value={credentialForm.value}
                onChange={(event) => setCredentialForm((form) => form ? { ...form, value: event.target.value } : form)}
              />
            </WorkspaceField>
            <WorkspaceField label="Confirm new credential">
              <input
                autoComplete="new-password"
                required
                type="password"
                inputMode={credentialForm.mode === "pin" ? "numeric" : undefined}
                value={credentialForm.confirmation}
                onChange={(event) => setCredentialForm((form) => form ? { ...form, confirmation: event.target.value } : form)}
              />
            </WorkspaceField>
            <p className="list-limit-note">Credential resets update the linked web login only. They do not change credentials stored on Windows devices. Use an enrollment invitation to set up or reset credentials on an assigned Windows device.</p>
            <div className="workspace-form-actions">
              <button className="secondary-button" type="button" onClick={() => setCredentialForm(null)}>Cancel</button>
              <button className="primary-button" disabled={busy} type="submit">
                {busy ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}
                {busy ? "Updating…" : `Reset ${credentialForm.mode}`}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}

      {invitation && canManageHq && (
        <WorkspaceDialog eyebrow="Staff accounts" onClose={() => setInvitation(null)} title="One-time staff enrollment invitation">
          <div className="workspace-form">
            <p>Give this code to <strong>{invitation.name}</strong>. It expires {formatDateTime(invitation.expiresAt)} and can be redeemed once for web enrollment and once on the assigned Windows device.</p>
            <code className="mono">{invitation.code}</code>
            <p className="list-limit-note">This code is shown only now. If it is lost or expires, issue a new invitation.</p>
            <div className="workspace-form-actions">
              <button className="secondary-button" type="button" onClick={() => void copyInvitation()}><Copy size={14} /> Copy code</button>
              <button className="primary-button" type="button" onClick={() => setInvitation(null)}>Done</button>
            </div>
          </div>
        </WorkspaceDialog>
      )}
    </>
  );
}

export default StaffAccountsWorkspace;
