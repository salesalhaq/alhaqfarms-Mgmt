"use client";

import { AlertCircle, CheckCircle2, Cloud, LoaderCircle, RefreshCw, UserRound, UserRoundPlus } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { WorkspaceError, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";

interface Branch {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

interface CloudAccount {
  user_id: string;
  branch_id: string | null;
  branch_code: string | null;
  branch_name: string | null;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
}

interface CloudAccessResponse {
  accounts?: CloudAccount[];
  error?: string;
}

export function CloudAccessWorkspace({ branches }: { branches: Branch[] }) {
  const activeBranches = useMemo(() => branches.filter((branch) => branch.is_active), [branches]);
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"cashier" | "manager" | "admin">("cashier");
  const [branchCode, setBranchCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!activeBranches.some((branch) => branch.code === branchCode)) {
      setBranchCode(activeBranches[0]?.code || "");
    }
  }, [activeBranches, branchCode]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void fetch("/api/workspace/cloud-access", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        const result = await response.json() as CloudAccessResponse;
        if (!response.ok) throw new Error(result.error || "Cloud accounts could not be loaded.");
        if (active) setAccounts(result.accounts || []);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setLoadError(loadError instanceof Error ? loadError.message : "Cloud accounts could not be loaded.");
        setAccounts([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [reloadKey]);

  const assign = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const branch = activeBranches.find((item) => item.code === branchCode);
    if (!branch) {
      setError("Choose an active branch.");
      return;
    }
    if (!window.confirm(
      `Assign ${email.trim()} as ${role} at ${branch.name}? If this account already has cloud access, its current role and branch will be replaced.`,
    )) return;

    setBusy(true);
    try {
      const response = await fetch("/api/workspace/cloud-access", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, fullName, role, branchCode }),
      });
      const result = await response.json() as CloudAccessResponse;
      if (!response.ok) throw new Error(result.error || "Cloud account could not be assigned.");
      setEmail("");
      setFullName("");
      setSuccess(`${email.trim()} is assigned to ${branch.name} as ${role}.`);
      setReloadKey((value) => value + 1);
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : "Cloud account could not be assigned.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card settings-workspace-panel">
        <h2><UserRoundPlus size={14} /> Assign a cloud account to a branch</h2>
        <p>Create the user first in Supabase Authentication. This form links that existing login to a branch and role; it does not create an Auth user or set a password.</p>
        {activeBranches.length ? (
          <form className="settings-cloud-access-form" onSubmit={(event) => void assign(event)}>
            <label className="field">
              <span>Supabase Auth email</span>
              <input autoComplete="email" type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className="field">
              <span>Staff name</span>
              <input autoComplete="name" required maxLength={200} value={fullName} onChange={(event) => setFullName(event.target.value)} />
            </label>
            <label className="field">
              <span>Branch</span>
              <select required value={branchCode} onChange={(event) => setBranchCode(event.target.value)}>
                {activeBranches.map((branch) => <option key={branch.id} value={branch.code}>{branch.name} ({branch.code})</option>)}
              </select>
            </label>
            <label className="field">
              <span>Cloud role</span>
              <select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
                <option value="cashier">Cashier</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <WorkspaceError message={error} />
            <WorkspaceSuccess message={success} />
            <div className="heading-actions">
              <button className="primary-button" type="submit" disabled={busy || !branchCode}>
                {busy ? <LoaderCircle size={14} className="spin" /> : <UserRoundPlus size={14} />}
                {busy ? "Assigning…" : "Assign cloud account"}
              </button>
            </div>
          </form>
        ) : (
          <div className="notice info"><AlertCircle size={15} /><span>Add an active branch before assigning cloud accounts.</span></div>
        )}
        <p className="settings-workspace-note">The email must already exist in Supabase Authentication. Account assignments do not change a staff member&apos;s password, PIN, or enrollment credentials.</p>
      </section>

      <section className="card settings-workspace-panel">
        <div className="settings-business-heading">
          <div>
            <h2><Cloud size={14} /> Cloud accounts</h2>
            <p>Current Supabase cloud access assignments.</p>
          </div>
          <div className="heading-actions">
            <Link className="secondary-button" href="/workspace/cloud-sync"><Cloud size={13} /> View Cloud Sync</Link>
            <button type="button" className="secondary-button" disabled={loading} onClick={() => setReloadKey((value) => value + 1)}>
              {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>
        {loadError && <WorkspaceError message={loadError} />}
        {loading ? (
          <div className="card loading"><LoaderCircle size={17} className="spin" /> Loading cloud accounts…</div>
        ) : (
          <ReadOnlyTable accounts={accounts} />
        )}
      </section>
    </>
  );
}

function ReadOnlyTable({ accounts }: { accounts: CloudAccount[] }) {
  return (
    <div className="settings-workspace-table">
      <div className="table-wrap">
        <table className="workspace-table">
          <thead><tr><th>Staff</th><th>Email</th><th>Branch</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>
            {accounts.length ? accounts.map((account) => (
              <tr key={account.user_id}>
                <td><span className="primary-cell"><UserRound size={14} /> {account.full_name}</span></td>
                <td>{account.email}</td>
                <td>{account.branch_name ? `${account.branch_name}${account.branch_code ? ` (${account.branch_code})` : ""}` : "HQ · All branches"}</td>
                <td>{account.role.charAt(0).toUpperCase() + account.role.slice(1)}</td>
                <td><span className={`status ${account.is_active ? "green" : "grey"}`}><CheckCircle2 size={12} /> {account.is_active ? "Active" : "Inactive"}</span></td>
              </tr>
            )) : <tr><td colSpan={5}>No cloud accounts assigned yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
