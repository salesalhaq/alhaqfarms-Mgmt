"use client";

import { AlertCircle, ExternalLink, LoaderCircle, Save, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DEFAULT_BRANCH_FBR_SETTINGS,
  DEFAULT_BRANCH_POS_SETTINGS,
  type BranchFbrSettings,
  type BranchPosSettings,
} from "@/lib/branch-pos-settings";
import { WorkspaceError, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";

interface Branch {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  is_default: boolean;
}

interface SettingsResponse {
  posSettings?: BranchPosSettings;
  fbrSettings?: BranchFbrSettings | null;
  encryptionConfigured?: boolean;
  error?: string;
}

interface FbrDraft extends Omit<BranchFbrSettings, "hasUsername" | "hasPassword" | "hasApiKey"> {
  username: string;
  password: string;
  apiKey: string;
  clearPassword: boolean;
  clearApiKey: boolean;
}

function toFbrDraft(settings: BranchFbrSettings): FbrDraft {
  return {
    environment: settings.environment,
    baseUrl: settings.baseUrl,
    registrationNumber: settings.registrationNumber,
    posId: settings.posId,
    paymentMode: settings.paymentMode,
    clientId: settings.clientId,
    enabled: settings.enabled,
    username: "",
    password: "",
    apiKey: "",
    clearPassword: false,
    clearApiKey: false,
  };
}

function percent(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2).replace(/\.?0+$/, "");
}

export function TaxSettingsWorkspace({ branches }: { branches: Branch[] }) {
  const activeBranches = useMemo(() => branches.filter((branch) => branch.is_active), [branches]);
  const [branchId, setBranchId] = useState("");
  const [posSettings, setPosSettings] = useState<BranchPosSettings>({ ...DEFAULT_BRANCH_POS_SETTINGS });
  const [fbrSettings, setFbrSettings] = useState<FbrDraft>(toFbrDraft(DEFAULT_BRANCH_FBR_SETTINGS));
  const [hasUsername, setHasUsername] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [encryptionConfigured, setEncryptionConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingFbr, setSavingFbr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fbrError, setFbrError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fbrNotice, setFbrNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!activeBranches.some((branch) => branch.id === branchId)) {
      setBranchId((activeBranches.find((branch) => branch.is_default) || activeBranches[0])?.id || "");
    }
  }, [activeBranches, branchId]);

  useEffect(() => {
    if (!branchId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setFbrError(null);
    void fetch(`/api/workspace/tax-settings?branchId=${encodeURIComponent(branchId)}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        const result = await response.json() as SettingsResponse;
        if (!response.ok) throw new Error(result.error || "Tax settings could not be loaded.");
        if (!active) return;
        setPosSettings(result.posSettings || { ...DEFAULT_BRANCH_POS_SETTINGS });
        const fbr = result.fbrSettings || { ...DEFAULT_BRANCH_FBR_SETTINGS };
        setFbrSettings(toFbrDraft(fbr));
        setHasUsername(fbr.hasUsername);
        setHasPassword(fbr.hasPassword);
        setHasApiKey(fbr.hasApiKey);
        setEncryptionConfigured(Boolean(result.encryptionConfigured));
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        const message = loadError instanceof Error ? loadError.message : "Tax settings could not be loaded.";
        setError(message);
        setFbrError(message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [branchId, reloadKey]);

  const savePosSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/workspace/tax-settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_pos", branchId, settings: posSettings }),
      });
      const result = await response.json() as SettingsResponse;
      if (!response.ok) throw new Error(result.error || "Branch POS settings could not be saved.");
      setPosSettings(result.posSettings || posSettings);
      setNotice("Tax, discount, loyalty, and stock settings saved for this branch.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Branch POS settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const saveFbrSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingFbr(true);
    setFbrError(null);
    setFbrNotice(null);
    try {
      const response = await fetch("/api/workspace/tax-settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_fbr",
          branchId,
          settings: {
            environment: fbrSettings.environment,
            baseUrl: fbrSettings.baseUrl,
            registrationNumber: fbrSettings.registrationNumber,
            posId: fbrSettings.posId,
            paymentMode: fbrSettings.paymentMode,
            clientId: fbrSettings.clientId,
            enabled: fbrSettings.enabled,
          },
          credentials: {
            username: fbrSettings.username,
            password: fbrSettings.password,
            apiKey: fbrSettings.apiKey,
            clearPassword: fbrSettings.clearPassword,
            clearApiKey: fbrSettings.clearApiKey,
          },
        }),
      });
      const result = await response.json() as SettingsResponse;
      if (!response.ok) throw new Error(result.error || "FBR settings could not be saved.");
      if (result.fbrSettings) {
        setFbrSettings(toFbrDraft(result.fbrSettings));
        setHasUsername(result.fbrSettings.hasUsername);
        setHasPassword(result.fbrSettings.hasPassword);
        setHasApiKey(result.fbrSettings.hasApiKey);
      }
      setFbrNotice("FBR settings and encrypted credentials saved for this branch.");
    } catch (saveError) {
      setFbrError(saveError instanceof Error ? saveError.message : "FBR settings could not be saved.");
    } finally {
      setSavingFbr(false);
    }
  };

  const updatePos = <K extends keyof BranchPosSettings>(key: K, value: BranchPosSettings[K]) => {
    setPosSettings((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };

  const updateFbr = <K extends keyof FbrDraft>(key: K, value: FbrDraft[K]) => {
    setFbrSettings((current) => ({ ...current, [key]: value }));
    setFbrNotice(null);
  };

  return (
    <div className="settings-tax-stack">
      <section className="card settings-workspace-panel">
        <div className="settings-tax-branch">
          <label className="field">
            <span>Branch</span>
            <select value={branchId} onChange={(event) => setBranchId(event.target.value)} disabled={loading || busy || savingFbr}>
              {activeBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>)}
            </select>
          </label>
          <button type="button" className="secondary-button" disabled={loading || busy || savingFbr} onClick={() => setReloadKey((value) => value + 1)}>
            <LoaderCircle className={loading ? "spin" : ""} size={13} /> {loading ? "Loading…" : "Reload branch settings"}
          </button>
        </div>
      </section>

      <section className="card settings-workspace-panel">
        <h2>Tax, discounts, loyalty &amp; stock</h2>
        <p>These settings control branch POS checkout. Product tax rates are still managed on each product; the web app does not submit FBR invoices.</p>
        {loading ? <div className="card loading"><LoaderCircle size={17} className="spin" /> Loading branch settings…</div> : (
          <form className="settings-tax-form" onSubmit={(event) => void savePosSettings(event)}>
            <fieldset disabled={busy}>
              <div className="workspace-form-grid">
                <label className="field"><span>Tax mode</span><select value={posSettings.taxMode} onChange={(event) => updatePos("taxMode", event.target.value as BranchPosSettings["taxMode"])}><option value="inclusive">Tax included in prices</option><option value="exclusive">Add tax to prices</option></select></label>
                <label className="field"><span>Maximum bill discount (%)</span><input type="number" min="0" max="100" step="0.01" value={percent(posSettings.maxBillDiscountBps)} onChange={(event) => updatePos("maxBillDiscountBps", Math.round(Number(event.target.value) * 100))} /></label>
                <label className="field"><span>Loyalty points per PKR 100</span><input type="number" min="0" max="10000" step="1" value={posSettings.loyaltyPointsPer100} onChange={(event) => updatePos("loyaltyPointsPer100", Number(event.target.value))} /></label>
                <label className="field"><span>Value per loyalty point (PKR)</span><input type="number" min="0.01" max="10000" step="0.01" value={(posSettings.loyaltyPointValuePaisa / 100).toFixed(2)} onChange={(event) => updatePos("loyaltyPointValuePaisa", Math.round(Number(event.target.value) * 100))} /></label>
              </div>
              <label className="settings-tax-toggle"><input type="checkbox" checked={posSettings.allowNegativeStock} onChange={(event) => updatePos("allowNegativeStock", event.target.checked)} /><span>Allow sales when stock would go below zero</span></label>
            </fieldset>
            <WorkspaceError message={error} />
            <WorkspaceSuccess message={notice} />
            <div className="workspace-form-actions"><button className="primary-button" type="submit" disabled={busy || loading || !branchId}><Save size={13} /> {busy ? "Saving…" : "Save branch POS settings"}</button></div>
          </form>
        )}
      </section>

      <section className="card settings-workspace-panel">
        <div className="settings-business-heading">
          <div><h2><ShieldCheck size={14} /> FBR setup</h2><p>Configure a branch&apos;s FBR connection details. The web app does not submit invoices or mark sales as verified.</p></div>
          <Link className="secondary-button" href="/workspace/fbr-pct-categories"><ExternalLink size={13} /> Manage PCT categories</Link>
        </div>
        {!encryptionConfigured && (
          <div className="notice info" role="note"><AlertCircle size={15} /><span>Before saving FBR settings, configure the dedicated <code>FBR_CONFIG_ENCRYPTION_KEY</code> Cloudflare secret. Generate 32 random bytes and store them as 64 hexadecimal characters.</span></div>
        )}
        {loading ? <div className="card loading"><LoaderCircle size={17} className="spin" /> Loading FBR settings…</div> : (
          <form className="settings-tax-form" onSubmit={(event) => void saveFbrSettings(event)}>
            <fieldset disabled={savingFbr || !encryptionConfigured}>
              <div className="workspace-form-grid">
                <label className="field"><span>Environment</span><select value={fbrSettings.environment} onChange={(event) => updateFbr("environment", event.target.value as FbrDraft["environment"])}><option value="sandbox">Sandbox / test</option><option value="production">Production</option></select></label>
                <label className="field"><span>FBR API base URL (HTTPS only)</span><input type="url" maxLength={500} placeholder="https://…" value={fbrSettings.baseUrl} onChange={(event) => updateFbr("baseUrl", event.target.value)} /></label>
                <label className="field"><span>NTN / STRN / registration ID</span><input maxLength={100} value={fbrSettings.registrationNumber} onChange={(event) => updateFbr("registrationNumber", event.target.value)} /></label>
                <label className="field"><span>FBR POS ID</span><input maxLength={100} value={fbrSettings.posId} onChange={(event) => updateFbr("posId", event.target.value)} /></label>
                <label className="field"><span>Payment mode code</span><input type="number" min="0" max="2147483647" step="1" value={fbrSettings.paymentMode} onChange={(event) => updateFbr("paymentMode", Number(event.target.value))} /></label>
                <label className="field"><span>Branch / API client ID</span><input maxLength={200} value={fbrSettings.clientId} onChange={(event) => updateFbr("clientId", event.target.value)} /></label>
                <label className="field"><span>API username {hasUsername ? "· saved" : ""}</span><input autoComplete="off" maxLength={2000} value={fbrSettings.username} onChange={(event) => updateFbr("username", event.target.value)} /></label>
                <label className="field"><span>API password {hasPassword ? "· saved; blank keeps existing" : ""}</span><input type="password" autoComplete="new-password" maxLength={2000} value={fbrSettings.password} onChange={(event) => updateFbr("password", event.target.value)} /></label>
                <label className="field"><span>API key / token {hasApiKey ? "· saved; blank keeps existing" : ""}</span><input type="password" autoComplete="new-password" maxLength={2000} value={fbrSettings.apiKey} onChange={(event) => updateFbr("apiKey", event.target.value)} /></label>
              </div>
              {(hasPassword || hasApiKey) && <div className="settings-tax-toggle-row">
                {hasPassword && <label className="settings-tax-toggle"><input type="checkbox" checked={fbrSettings.clearPassword} onChange={(event) => updateFbr("clearPassword", event.target.checked)} /><span>Remove saved password</span></label>}
                {hasApiKey && <label className="settings-tax-toggle"><input type="checkbox" checked={fbrSettings.clearApiKey} onChange={(event) => updateFbr("clearApiKey", event.target.checked)} /><span>Remove saved API key</span></label>}
              </div>}
              <label className="settings-tax-toggle"><input type="checkbox" checked={fbrSettings.enabled} onChange={(event) => updateFbr("enabled", event.target.checked)} /><span>Mark FBR setup as enabled (does not submit invoices)</span></label>
            </fieldset>
            <p className="settings-workspace-note">Credentials are encrypted with AES-GCM before being stored in Supabase. The encryption key is held only as a server secret; saved values are never sent back to the browser. Keep the key backed up securely—without it, stored credentials cannot be recovered. The Windows app continues to use its separate device-encrypted credential store.</p>
            <WorkspaceError message={fbrError} />
            <WorkspaceSuccess message={fbrNotice} />
            <div className="workspace-form-actions"><button className="primary-button" type="submit" disabled={savingFbr || loading || !encryptionConfigured || !branchId}><Save size={13} /> {savingFbr ? "Saving…" : "Save FBR settings"}</button></div>
          </form>
        )}
      </section>
    </div>
  );
}
