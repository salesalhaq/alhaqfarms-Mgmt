"use client";

import { Copy, Download, ExternalLink, LoaderCircle, Monitor, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WorkspaceError, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";
import { getBridgeClient, probeBridge } from "@/lib/bridge/client";
import { getDeviceId } from "@/lib/scale-settings";
import { loadPrinterSettings } from "@/lib/print/printer-settings";

interface Branch {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

interface DeviceDiagnostics {
  deviceId: string;
  generatedAt: string;
  branch: string;
  browser: string;
  platform: string;
  language: string;
  timezone: string;
  viewport: string;
  online: boolean;
  storageUsageBytes: number | null;
  storageQuotaBytes: number | null;
  localBridge: { status: string; version: string | null; platform: string | null };
}

export function SettingsDeviceWorkspace({
  branches,
  profileBranchId,
  role,
}: {
  branches: Branch[];
  profileBranchId: string | null;
  role: string;
}) {
  const activeBranches = useMemo(() => branches.filter((branch) => branch.is_active), [branches]);
  const [branchId, setBranchId] = useState(profileBranchId || activeBranches[0]?.id || "");
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [diagnostics, setDiagnostics] = useState<DeviceDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (profileBranchId && branchId !== profileBranchId) setBranchId(profileBranchId);
    else if (!profileBranchId && !activeBranches.some((branch) => branch.id === branchId)) {
      setBranchId(activeBranches[0]?.id || "");
    }
  }, [activeBranches, branchId, profileBranchId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const prefs = loadPrinterSettings({ branchId });
      setBridgeUrl(prefs.bridgeUrl);
      const storage = await navigator.storage?.estimate();
      const health = await probeBridge(prefs.bridgeUrl);
      setDiagnostics({
        deviceId: getDeviceId(),
        generatedAt: new Date().toISOString(),
        branch: activeBranches.find((branch) => branch.id === branchId)?.name || "Shared device settings",
        browser: navigator.userAgent,
        platform: navigator.platform || "Not reported",
        language: navigator.language || "Not reported",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Not reported",
        viewport: `${window.innerWidth} × ${window.innerHeight}`,
        online: navigator.onLine,
        storageUsageBytes: typeof storage?.usage === "number" ? storage.usage : null,
        storageQuotaBytes: typeof storage?.quota === "number" ? storage.quota : null,
        localBridge: {
          status: health ? "online" : "offline",
          version: health?.version || null,
          platform: health?.platform || null,
        },
      });
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Device information could not be loaded.");
      setDiagnostics(null);
    } finally {
      setLoading(false);
    }
  }, [activeBranches, branchId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const downloadDiagnostics = () => {
    if (!diagnostics) return;
    const blob = new Blob([JSON.stringify({ format: "alhaq-device-diagnostics", version: 1, ...diagnostics }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `alhaq-device-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setNotice("Device diagnostics downloaded. Review the file before sharing it.");
  };

  const copyDeviceId = async () => {
    try {
      if (!diagnostics) throw new Error("Refresh device details before copying the ID.");
      await navigator.clipboard.writeText(diagnostics.deviceId);
      setNotice("Browser device ID copied.");
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "The device ID could not be copied.");
    }
  };

  const bridgeClient = typeof window !== "undefined" && bridgeUrl ? getBridgeClient(bridgeUrl) : null;
  const bridgeStatus = bridgeClient?.status || "idle";

  return (
    <div className="settings-tax-stack">
      <section className="card settings-workspace-panel">
        <div className="settings-device-heading">
          <div><h2><Monitor size={14} /> This browser &amp; device</h2><p>Local device details and bridge connectivity for this browser. Device preferences remain on this device.</p></div>
          <button type="button" className="secondary-button" disabled={loading} onClick={() => void refresh()}>
            {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} {loading ? "Checking…" : "Refresh"}
          </button>
        </div>
        {role === "admin" && profileBranchId === null && (
          <label className="field settings-export-branch">
            <span>Branch device settings</span>
            <select value={branchId} onChange={(event) => setBranchId(event.target.value)} disabled={loading}>
              {activeBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>)}
            </select>
          </label>
        )}
        {diagnostics && (
          <dl className="settings-device-grid">
            <div><dt>Browser device ID</dt><dd><code>{diagnostics.deviceId}</code><button type="button" className="secondary-button" onClick={() => void copyDeviceId()}><Copy size={12} /> Copy</button></dd></div>
            <div><dt>Branch preference scope</dt><dd>{diagnostics.branch}</dd></div>
            <div><dt>Browser</dt><dd>{diagnostics.browser}</dd></div>
            <div><dt>Platform</dt><dd>{diagnostics.platform}</dd></div>
            <div><dt>Language / timezone</dt><dd>{diagnostics.language} · {diagnostics.timezone}</dd></div>
            <div><dt>Browser connectivity</dt><dd>{diagnostics.online ? "Online" : "Offline"}</dd></div>
            <div><dt>Local bridge</dt><dd>{diagnostics.localBridge.status}{diagnostics.localBridge.version ? ` · v${diagnostics.localBridge.version}` : ""}{diagnostics.localBridge.platform ? ` · ${diagnostics.localBridge.platform}` : ""}</dd></div>
            <div><dt>Bridge address</dt><dd><code>{bridgeUrl || "Not configured"}</code>{bridgeStatus === "connected" ? " · Connected" : ""}</dd></div>
            <div><dt>Browser storage</dt><dd>{diagnostics.storageUsageBytes == null ? "Usage unavailable" : `${(diagnostics.storageUsageBytes / 1_048_576).toFixed(1)} MB used of ${((diagnostics.storageQuotaBytes || 0) / 1_048_576).toFixed(0)} MB`}</dd></div>
          </dl>
        )}
        <WorkspaceError message={error} />
        <WorkspaceSuccess message={notice} />
        <div className="heading-actions">
          <button type="button" className="secondary-button" disabled={!diagnostics} onClick={downloadDiagnostics}><Download size={13} /> Download diagnostics</button>
          {role === "admin" && <Link className="secondary-button" href="/workspace/devices"><ExternalLink size={13} /> Device registry</Link>}
        </div>
        <p className="settings-workspace-note">The diagnostics file contains browser and device details but no passwords, auth tokens, or saved printer credentials. Review it before sharing.</p>
      </section>
      <section className="card settings-workspace-panel">
        <h2>Hardware and network controls</h2>
        <p>Web browsers cannot start the Windows LAN host, install drivers, or approve terminals. Use the Windows host application for those device-management actions; the admin device registry is available above.</p>
      </section>
    </div>
  );
}
