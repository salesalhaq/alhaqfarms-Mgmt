"use client";

import { AlertCircle, Cloud, Download, LoaderCircle, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { WorkspaceError, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";

interface Branch {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

interface BackupRecord {
  id: string;
  branch_ids: string[];
  file_name: string;
  size_bytes: number;
  date_from: string;
  date_to: string;
  trigger_type: "manual" | "scheduled";
  created_at: string;
}

interface BackupPreferences {
  branch_ids: string[];
  frequency: "manual" | "daily" | "weekly";
  schedule_day: number | null;
  schedule_time: string;
  retention_days: number;
  last_run_at: string | null;
}

interface CloudBackupResponse {
  backups?: BackupRecord[];
  preferences?: BackupPreferences;
  backupId?: string;
  warning?: string;
  error?: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pakistanDateValue(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function saveDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SettingsBackupWorkspace({
  branches,
  profileBranchId,
}: {
  branches: Branch[];
  profileBranchId: string | null;
}) {
  const activeBranches = useMemo(() => branches.filter((branch) => branch.is_active), [branches]);
  const [branchIds, setBranchIds] = useState<string[]>(() => profileBranchId
    ? [profileBranchId]
    : branches.filter((branch) => branch.is_active).map((branch) => branch.id));
  const [from, setFrom] = useState(() => {
    const date = new Date(`${pakistanDateValue(new Date())}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 89);
    return date.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => pakistanDateValue(new Date()));
  const [frequency, setFrequency] = useState<BackupPreferences["frequency"]>("weekly");
  const [scheduleDay, setScheduleDay] = useState(0);
  const [scheduleTime, setScheduleTime] = useState("02:00");
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"local" | "cloud" | "schedule" | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetch("/api/workspace/cloud-backups", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const result = await response.json() as CloudBackupResponse;
        if (!response.ok) throw new Error(result.error || "Cloud backup settings could not be loaded.");
        if (!active) return;
        setBackups(result.backups || []);
        const preference = result.preferences;
        if (preference) {
          setFrequency(preference.frequency);
          setScheduleDay(preference.schedule_day ?? 0);
          setScheduleTime(preference.schedule_time.slice(0, 5));
          setLastRunAt(preference.last_run_at);
          if (preference.branch_ids?.length) {
            setBranchIds(preference.branch_ids.filter((id) => activeBranches.some((branch) => branch.id === id)));
          }
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Cloud backup settings could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [activeBranches, reloadKey]);

  const downloadLocal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("local");
    setError(null);
    setNotice(null);
    try {
      const parameters = new URLSearchParams({ from, to });
      parameters.set("branchIds", branchIds.join(","));
      const response = await fetch(`/api/workspace/data-export?${parameters.toString()}`, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || "The local export could not be prepared.");
      }
      const filename = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/i)?.[1]
        || `alhaq-operational-export-${from}-${to}.json`;
      saveDownload(await response.blob(), filename);
      setNotice("Local export downloaded to your browser's Downloads folder.");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "The local export could not be prepared.");
    } finally {
      setBusy(null);
    }
  };

  const createCloudBackup = async () => {
    if (!branchIds.length) {
      setError("Select at least one branch for the cloud backup.");
      return;
    }
    setBusy("cloud");
    setError(null);
    setNotice(null);
    try {
      const parameters = new URLSearchParams({ from, to });
      parameters.set("branchIds", branchIds.join(","));
      const exportResponse = await fetch(`/api/workspace/data-export?${parameters.toString()}`, { cache: "no-store", credentials: "same-origin" });
      const archive = await exportResponse.json() as Record<string, unknown> & { error?: string };
      if (!exportResponse.ok) throw new Error(archive.error || "The cloud backup data could not be prepared.");
      const response = await fetch("/api/workspace/cloud-backups", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", archive }),
      });
      const result = await response.json() as CloudBackupResponse;
      if (!response.ok) throw new Error(result.error || "The private cloud backup could not be created.");
      setNotice(result.warning || "Private cloud backup saved. It will be kept for 90 days.");
      setReloadKey((key) => key + 1);
    } catch (backupError) {
      setError(backupError instanceof Error ? backupError.message : "The private cloud backup could not be created.");
    } finally {
      setBusy(null);
    }
  };

  const saveSchedule = async () => {
    if (!branchIds.length) {
      setError("Select at least one branch for automatic backups.");
      return;
    }
    setBusy("schedule");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/workspace/cloud-backups", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_schedule",
          branchIds,
          frequency,
          scheduleDay: frequency === "weekly" ? scheduleDay : null,
          scheduleTime,
        }),
      });
      const result = await response.json() as CloudBackupResponse;
      if (!response.ok) throw new Error(result.error || "The cloud backup schedule could not be saved.");
      setNotice(frequency === "manual"
        ? "Automatic cloud backups are off. Manual local and cloud backups remain available."
        : `Automatic cloud backups saved: ${frequency === "daily" ? "daily" : `every ${WEEKDAYS[scheduleDay]}`} at ${scheduleTime} Asia/Karachi.`);
      setReloadKey((key) => key + 1);
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : "The cloud backup schedule could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  const downloadCloudBackup = async (backup: BackupRecord) => {
    setBusy(backup.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/workspace/cloud-backups?id=${encodeURIComponent(backup.id)}`, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || "The cloud backup could not be downloaded.");
      }
      saveDownload(await response.blob(), backup.file_name);
      setNotice("Cloud backup downloaded.");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "The cloud backup could not be downloaded.");
    } finally {
      setBusy(null);
    }
  };

  const deleteCloudBackup = async (backup: BackupRecord) => {
    if (!window.confirm(`Permanently delete cloud backup ${backup.file_name}?`)) return;
    setBusy(backup.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/workspace/cloud-backups?id=${encodeURIComponent(backup.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const result = await response.json() as CloudBackupResponse;
      if (!response.ok) throw new Error(result.error || "The cloud backup could not be deleted.");
      setBackups((current) => current.filter((entry) => entry.id !== backup.id));
      setNotice("Cloud backup deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The cloud backup could not be deleted.");
    } finally {
      setBusy(null);
    }
  };

  const toggleBranch = (id: string) => {
    setBranchIds((current) => current.includes(id)
      ? current.filter((branchId) => branchId !== id)
      : [...current, id]);
  };

  const branchLabel = (ids: string[]) => ids
    .map((id) => activeBranches.find((branch) => branch.id === id)?.name)
    .filter(Boolean)
    .join(", ") || "Branch unavailable";

  return (
    <div className="settings-tax-stack">
      <section className="card settings-workspace-panel">
        <h2><Cloud size={14} /> Local and cloud backups</h2>
        <p>Choose the operational data and date range. Local backups download to this device; cloud backups are stored privately in your Supabase project.</p>
        <div className="settings-backup-branches">
          <strong>Branches to include</strong>
          {activeBranches.map((branch) => (
            <label className="settings-tax-toggle" key={branch.id}>
              <input type="checkbox" checked={branchIds.includes(branch.id)} disabled={busy !== null}
                onChange={() => toggleBranch(branch.id)} />
              <span>{branch.name} ({branch.code})</span>
            </label>
          ))}
        </div>
        <form className="settings-export-form" onSubmit={(event) => void downloadLocal(event)}>
          <label className="field"><span>From</span><input type="date" required value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label className="field"><span>Through</span><input type="date" required value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <button className="secondary-button" disabled={busy !== null || !branchIds.length || from > to} type="submit">
            {busy === "local" ? <><LoaderCircle size={14} className="spin" /> Preparing local file…</> : <><Download size={14} /> Download local backup</>}
          </button>
          <button className="primary-button" disabled={busy !== null || loading || !branchIds.length || from > to} onClick={() => void createCloudBackup()} type="button">
            {busy === "cloud" ? <><LoaderCircle size={14} className="spin" /> Uploading…</> : <><Cloud size={14} /> Back up to cloud</>}
          </button>
        </form>
        <WorkspaceError message={error} />
        <WorkspaceSuccess message={notice} />
        <div className="notice info" role="note"><AlertCircle size={15} /><span>Includes catalog, POS sales and payments, stock movements, returns/refunds, and expenses. Staff credentials and product cost fields are excluded. Export up to 366 days at a time; each table is capped at 25,000 rows. This is a business-data backup, not a restorable copy of the full Supabase database.</span></div>
      </section>

      <section className="card settings-workspace-panel">
        <h2>Automatic cloud backup schedule</h2>
        <p>Automatic cloud backups are created by the scheduled Supabase job. Set the frequency and time in Asia/Karachi. Cloud copies are retained for 90 days.</p>
        <div className="settings-backup-schedule">
          <label className="field"><span>Schedule</span><select value={frequency} disabled={loading || busy !== null} onChange={(event) => setFrequency(event.target.value as BackupPreferences["frequency"])}>
            <option value="manual">Manual only</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
          </select></label>
          {frequency === "weekly" && <label className="field"><span>Day</span><select value={scheduleDay} disabled={loading || busy !== null} onChange={(event) => setScheduleDay(Number(event.target.value))}>
            {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select></label>}
          {frequency !== "manual" && <label className="field"><span>Time (Asia/Karachi)</span><input type="time" step={900} value={scheduleTime} disabled={loading || busy !== null} onChange={(event) => setScheduleTime(event.target.value)} /></label>}
          <button className="primary-button" type="button" disabled={loading || busy !== null} onClick={() => void saveSchedule()}>
            {busy === "schedule" ? <><LoaderCircle size={14} className="spin" /> Saving…</> : <><Save size={14} /> Save schedule</>}
          </button>
        </div>
        <p className="settings-workspace-note">{lastRunAt ? `Last automatic cloud backup: ${new Date(lastRunAt).toLocaleString()}.` : "No automatic cloud backup has completed yet."} Scheduled cloud backups need the Supabase backup function and scheduler migrations to be deployed and enabled.</p>
      </section>

      <section className="card settings-workspace-panel">
        <div className="settings-backup-heading">
          <div><h2>Cloud backup history</h2><p>Your latest private cloud backups (up to 100).</p></div>
          <button type="button" className="secondary-button" disabled={loading || busy !== null} onClick={() => setReloadKey((key) => key + 1)}>
            {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
          </button>
        </div>
        {loading ? <div className="card loading"><LoaderCircle size={16} className="spin" /> Loading cloud backups…</div> : backups.length ? (
          <div className="settings-backup-list">
            {backups.map((backup) => (
              <article className="settings-backup-row" key={backup.id}>
                <div><strong>{backup.file_name}</strong><small>{branchLabel(backup.branch_ids)} · {backup.date_from} to {backup.date_to} · {(backup.size_bytes / 1_048_576).toFixed(2)} MB</small><small>{new Date(backup.created_at).toLocaleString()} · {backup.trigger_type === "scheduled" ? "Automatic" : "Manual"}</small></div>
                <div className="heading-actions">
                  <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void downloadCloudBackup(backup)}><Download size={13} /> Download</button>
                  <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void deleteCloudBackup(backup)}>{busy === backup.id ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />} Delete</button>
                </div>
              </article>
            ))}
          </div>
        ) : <div className="empty"><Cloud size={22} /><p>No cloud backups have been created.</p></div>}
      </section>
    </div>
  );
}
