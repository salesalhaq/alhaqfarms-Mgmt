"use client";

import { CreditCard, ImagePlus, RefreshCw, Save, Store, Trash2, Truck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { WorkspaceError, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";

interface StorefrontBranch {
  id: string;
  name: string;
  is_active: boolean;
  is_default: boolean;
}

interface DeliveryArea {
  id: string;
  branch_id: string;
  area_name: string;
  delivery_charge_paisa: number;
  free_delivery_threshold_paisa: number;
  sort_order: number;
  is_active: boolean;
}

interface CodSetting {
  id: string;
  branch_id: string;
  is_active: boolean;
  max_order_amount_paisa: number | null;
  notes: string | null;
}

interface CodArea {
  id: string;
  branch_id: string;
  cod_setting_id: string;
  delivery_area_id: string;
  is_active: boolean;
}

interface PaymentAccount {
  id: string;
  payment_method: "easypaisa" | "jazzcash";
  account_title: string;
  account_number: string;
  instructions: string | null;
  qr_code_data_url: string | null;
  is_active: boolean;
}

interface StorefrontData {
  deliveryAreas: DeliveryArea[];
  codSettings: CodSetting[];
  codAreas: CodArea[];
  paymentAccounts: PaymentAccount[];
  error?: string;
}

interface AreaDraft {
  id: string;
  areaName: string;
  deliveryCharge: string;
  freeDeliveryThreshold: string;
  sortOrder: string;
  isActive: boolean;
}

interface PaymentDraft {
  id: string;
  accountTitle: string;
  accountNumber: string;
  instructions: string;
  qrCodeDataUrl: string;
  isActive: boolean;
}

const EMPTY_AREA: AreaDraft = {
  id: "",
  areaName: "",
  deliveryCharge: "0.00",
  freeDeliveryThreshold: "5000.00",
  sortOrder: "0",
  isActive: true,
};

const EMPTY_PAYMENT: PaymentDraft = {
  id: "",
  accountTitle: "",
  accountNumber: "",
  instructions: "",
  qrCodeDataUrl: "",
  isActive: true,
};

const PAYMENT_METHODS = [
  { id: "easypaisa", label: "EasyPaisa" },
  { id: "jazzcash", label: "JazzCash" },
] as const;

function rupeesToPaisa(value: string, label: string, optional = false): number | null {
  if (optional && !value.trim()) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    throw new Error(`${label} must be a non-negative amount with up to two decimal places.`);
  }
  const paisa = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(paisa)) throw new Error(`${label} is outside the allowed range.`);
  return paisa;
}

function paisaToRupees(value: number | null): string {
  return value == null ? "" : (value / 100).toFixed(2);
}

async function postStorefrontAction(payload: Record<string, unknown>) {
  const response = await fetch("/api/workspace/storefront-settings", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error || "The storefront setting could not be saved.");
}

export function StorefrontCheckoutWorkspace({ branches }: { branches: StorefrontBranch[] }) {
  const activeBranches = useMemo(() => branches.filter((branch) => branch.is_active), [branches]);
  const [data, setData] = useState<StorefrontData | null>(null);
  const [branchId, setBranchId] = useState("");
  const [areaDraft, setAreaDraft] = useState<AreaDraft>(EMPTY_AREA);
  const [codDraft, setCodDraft] = useState({ isActive: false, maxOrderAmount: "", notes: "" });
  const [paymentMethod, setPaymentMethod] = useState<"easypaisa" | "jazzcash">("easypaisa");
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>(EMPTY_PAYMENT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const qrInput = useRef<HTMLInputElement>(null);

  const load = async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/workspace/storefront-settings", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as StorefrontData;
      if (!response.ok) throw new Error(result.error || "Storefront checkout settings could not be loaded.");
      setData(result);
      setBranchId((current) => current || activeBranches.find((branch) => branch.is_default)?.id || activeBranches[0]?.id || "");
      return true;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Storefront checkout settings could not be loaded.");
      return false;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [activeBranches]);

  const areas = useMemo(
    () => (data?.deliveryAreas || []).filter((area) => area.branch_id === branchId),
    [data?.deliveryAreas, branchId],
  );
  const codSetting = data?.codSettings.find((setting) => setting.branch_id === branchId);
  const codAreas = useMemo(
    () => (data?.codAreas || []).filter((area) => area.branch_id === branchId),
    [data?.codAreas, branchId],
  );
  const currentPaymentAccount = data?.paymentAccounts.find((account) => account.payment_method === paymentMethod);

  useEffect(() => {
    setAreaDraft(EMPTY_AREA);
    const saved = data?.codSettings.find((setting) => setting.branch_id === branchId);
    setCodDraft({
      isActive: saved?.is_active ?? false,
      maxOrderAmount: paisaToRupees(saved?.max_order_amount_paisa ?? null),
      notes: saved?.notes || "",
    });
  }, [data?.codSettings, branchId]);

  useEffect(() => {
    const account = currentPaymentAccount;
    setPaymentDraft(account ? {
      id: account.id,
      accountTitle: account.account_title,
      accountNumber: account.account_number,
      instructions: account.instructions || "",
      qrCodeDataUrl: account.qr_code_data_url || "",
      isActive: account.is_active,
    } : EMPTY_PAYMENT);
  }, [currentPaymentAccount, paymentMethod]);

  const runAction = async (payload: Record<string, unknown>, successMessage: string) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await postStorefrontAction(payload);
      if (!await load()) return;
      setNotice(successMessage);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The storefront setting could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const saveArea = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const deliveryChargePaisa = rupeesToPaisa(areaDraft.deliveryCharge, "Delivery charge");
      const freeDeliveryThresholdPaisa = rupeesToPaisa(areaDraft.freeDeliveryThreshold, "Free-delivery threshold");
      const sortOrder = Number(areaDraft.sortOrder);
      if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error("Display order must be a non-negative whole number.");
      await runAction({
        action: "save_delivery_area",
        branchId,
        id: areaDraft.id || undefined,
        areaName: areaDraft.areaName,
        deliveryChargePaisa,
        freeDeliveryThresholdPaisa,
        sortOrder,
        isActive: areaDraft.isActive,
      }, areaDraft.id ? "Delivery area updated." : "Delivery area added.");
      setAreaDraft(EMPTY_AREA);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Delivery area could not be saved.");
    }
  };

  const saveCod = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await runAction({
        action: "save_cod_settings",
        branchId,
        id: codSetting?.id,
        isActive: codDraft.isActive,
        maxOrderAmountPaisa: rupeesToPaisa(codDraft.maxOrderAmount, "COD order limit", true),
        notes: codDraft.notes,
      }, "COD settings saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "COD settings could not be saved.");
    }
  };

  const savePayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAction({
      action: "save_payment_account",
      ...paymentDraft,
      paymentMethod,
    }, `${PAYMENT_METHODS.find((method) => method.id === paymentMethod)?.label} account saved.`);
  };

  const uploadQr = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      setError("Choose a PNG, JPEG, WebP, or GIF image for the QR code.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("QR code images must be 2 MB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPaymentDraft((current) => ({ ...current, qrCodeDataUrl: String(reader.result || "") }));
    reader.onerror = () => setError("Could not read the selected QR code image.");
    reader.readAsDataURL(file);
  };

  return (
    <section className="settings-storefront-workspace">
      <div className="card settings-workspace-panel">
        <div className="settings-storefront-heading">
          <div>
            <h2><Store size={15} /> Storefront checkout</h2>
            <p>Manage delivery pricing, cash on delivery, and mobile-wallet accounts.</p>
          </div>
          <button type="button" className="secondary-button" disabled={loading || saving} onClick={() => void load()}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
        <label className="settings-storefront-branch">
          <span>Branch</span>
          <select value={branchId} disabled={!activeBranches.length || loading || saving} onChange={(event) => setBranchId(event.target.value)}>
            {activeBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </label>
        <WorkspaceError message={error} />
        <WorkspaceSuccess message={notice} />
        {!activeBranches.length && !loading && <p className="settings-workspace-note">No active branches are available to configure.</p>}
        {loading && <p className="muted">Loading storefront settings…</p>}
      </div>

      {branchId && data && !loading && <>
        <section className="card settings-workspace-panel">
          <h2><Truck size={15} /> Delivery areas &amp; charges</h2>
          <p>Set a delivery charge, free-delivery threshold, and display order for each active area.</p>
          <form className="settings-storefront-form" onSubmit={(event) => void saveArea(event)}>
            <label><span>Area name</span><input required maxLength={120} value={areaDraft.areaName} disabled={saving} onChange={(event) => setAreaDraft({ ...areaDraft, areaName: event.target.value })} /></label>
            <label><span>Delivery charge (PKR)</span><input required type="number" min="0" step="0.01" value={areaDraft.deliveryCharge} disabled={saving} onChange={(event) => setAreaDraft({ ...areaDraft, deliveryCharge: event.target.value })} /></label>
            <label><span>Free delivery from (PKR)</span><input required type="number" min="0" step="0.01" value={areaDraft.freeDeliveryThreshold} disabled={saving} onChange={(event) => setAreaDraft({ ...areaDraft, freeDeliveryThreshold: event.target.value })} /></label>
            <label><span>Display order</span><input required type="number" min="0" step="1" value={areaDraft.sortOrder} disabled={saving} onChange={(event) => setAreaDraft({ ...areaDraft, sortOrder: event.target.value })} /></label>
            <label className="settings-storefront-check"><input type="checkbox" checked={areaDraft.isActive} disabled={saving} onChange={(event) => setAreaDraft({ ...areaDraft, isActive: event.target.checked })} /> Active</label>
            <div className="settings-storefront-form-actions">
              <button type="submit" className="primary-button" disabled={saving}><Save size={13} /> {areaDraft.id ? "Update area" : "Add area"}</button>
              {areaDraft.id && <button type="button" className="secondary-button" disabled={saving} onClick={() => setAreaDraft(EMPTY_AREA)}>Cancel edit</button>}
            </div>
          </form>
          <div className="settings-storefront-list">
            {!areas.length && <p className="settings-storefront-empty">No delivery areas are configured for this branch.</p>}
            {areas.map((area) => (
              <article className="settings-storefront-row" key={area.id}>
                <div><strong>{area.area_name}</strong><small>PKR {paisaToRupees(area.delivery_charge_paisa)} delivery · free from PKR {paisaToRupees(area.free_delivery_threshold_paisa)}</small></div>
                <label className="settings-storefront-check"><input type="checkbox" checked={area.is_active} disabled={saving} onChange={(event) => void runAction({
                  action: "set_delivery_area_active", id: area.id, branchId, isActive: event.target.checked,
                }, "Delivery area status updated.")} /> Active</label>
                <button type="button" className="secondary-button" disabled={saving} onClick={() => setAreaDraft({
                  id: area.id,
                  areaName: area.area_name,
                  deliveryCharge: paisaToRupees(area.delivery_charge_paisa),
                  freeDeliveryThreshold: paisaToRupees(area.free_delivery_threshold_paisa),
                  sortOrder: String(area.sort_order),
                  isActive: area.is_active,
                })}>Edit</button>
                <button type="button" className="icon-button" disabled={saving} aria-label={`Remove ${area.area_name}`} onClick={() => {
                  if (window.confirm(`Remove ${area.area_name} from delivery areas?`)) {
                    void runAction({ action: "delete_delivery_area", id: area.id, branchId }, "Delivery area removed.");
                  }
                }}><Trash2 size={14} /></button>
              </article>
            ))}
          </div>
        </section>

        <section className="card settings-workspace-panel">
          <h2><CreditCard size={15} /> Cash on delivery</h2>
          <p>Choose COD-eligible delivery areas and optionally set a maximum order total.</p>
          <form className="settings-storefront-cod" onSubmit={(event) => void saveCod(event)}>
            <label className="settings-storefront-check"><input type="checkbox" checked={codDraft.isActive} disabled={saving} onChange={(event) => setCodDraft({ ...codDraft, isActive: event.target.checked })} /> Enable COD for this branch</label>
            <label><span>Maximum order (PKR, optional)</span><input type="number" min="0" step="0.01" value={codDraft.maxOrderAmount} disabled={saving} onChange={(event) => setCodDraft({ ...codDraft, maxOrderAmount: event.target.value })} /></label>
            <label><span>Notes</span><input maxLength={500} value={codDraft.notes} disabled={saving} onChange={(event) => setCodDraft({ ...codDraft, notes: event.target.value })} /></label>
            <div className="settings-storefront-form-actions">
              <button type="submit" className="primary-button" disabled={saving}><Save size={13} /> Save COD settings</button>
              {codSetting && <button type="button" className="secondary-button" disabled={saving} onClick={() => {
                if (window.confirm("Remove COD settings for this branch?")) {
                  void runAction({ action: "delete_cod_settings", id: codSetting.id, branchId }, "COD settings removed.");
                }
              }}><Trash2 size={13} /> Remove COD settings</button>}
            </div>
          </form>
          <div className="settings-storefront-list">
            {!areas.length && <p className="settings-storefront-empty">Add delivery areas before assigning COD eligibility.</p>}
            {areas.map((area) => {
              const eligible = codAreas.find((entry) => entry.delivery_area_id === area.id);
              return (
                <article className="settings-storefront-row" key={area.id}>
                  <div><strong>{area.area_name}</strong><small>{area.is_active ? "Delivery area active" : "Delivery area inactive"}</small></div>
                  <label className="settings-storefront-check"><input type="checkbox" checked={Boolean(eligible?.is_active)} disabled={!area.is_active || !codSetting || saving} onChange={(event) => void runAction({
                    action: "set_cod_area", branchId, deliveryAreaId: area.id, isActive: event.target.checked,
                  }, "COD delivery eligibility updated.")} /> COD eligible</label>
                  {eligible && <button type="button" className="icon-button" disabled={saving} aria-label={`Remove COD eligibility for ${area.area_name}`} onClick={() => void runAction({
                    action: "remove_cod_area", branchId, id: eligible.id,
                  }, "COD delivery eligibility removed.")}><Trash2 size={14} /></button>}
                </article>
              );
            })}
          </div>
        </section>

        <section className="card settings-workspace-panel">
          <h2><CreditCard size={15} /> EasyPaisa &amp; JazzCash</h2>
          <p>Configure one account per provider. The QR image and instructions are shown at checkout.</p>
          <div className="settings-storefront-provider-tabs" role="group" aria-label="Payment provider">
            {PAYMENT_METHODS.map((method) => (
              <button key={method.id} type="button" className={paymentMethod === method.id ? "active" : ""} aria-pressed={paymentMethod === method.id} onClick={() => setPaymentMethod(method.id)}>
                {method.label}
              </button>
            ))}
          </div>
          <form className="settings-storefront-payment" onSubmit={(event) => void savePayment(event)}>
            <label><span>Account title</span><input required maxLength={160} value={paymentDraft.accountTitle} disabled={saving} onChange={(event) => setPaymentDraft({ ...paymentDraft, accountTitle: event.target.value })} /></label>
            <label><span>Account number</span><input required maxLength={80} value={paymentDraft.accountNumber} disabled={saving} onChange={(event) => setPaymentDraft({ ...paymentDraft, accountNumber: event.target.value })} /></label>
            <label className="settings-storefront-wide"><span>Checkout instructions</span><textarea rows={2} maxLength={500} value={paymentDraft.instructions} disabled={saving} onChange={(event) => setPaymentDraft({ ...paymentDraft, instructions: event.target.value })} /></label>
            <div className="settings-storefront-qr settings-storefront-wide">
              <input ref={qrInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={uploadQr} />
              {paymentDraft.qrCodeDataUrl && <img src={paymentDraft.qrCodeDataUrl} alt={`${paymentMethod} payment QR preview`} />}
              <div><strong>Payment QR code</strong><small>PNG, JPEG, WebP, or GIF. Maximum 2 MB.</small></div>
              <button type="button" className="secondary-button" disabled={saving} onClick={() => qrInput.current?.click()}><ImagePlus size={13} /> Upload QR</button>
              {paymentDraft.qrCodeDataUrl && <button type="button" className="secondary-button" disabled={saving} onClick={() => setPaymentDraft({ ...paymentDraft, qrCodeDataUrl: "" })}>Remove QR</button>}
            </div>
            <label className="settings-storefront-check"><input type="checkbox" checked={paymentDraft.isActive} disabled={saving} onChange={(event) => setPaymentDraft({ ...paymentDraft, isActive: event.target.checked })} /> Active at checkout</label>
            <div className="settings-storefront-form-actions settings-storefront-wide">
              <button type="submit" className="primary-button" disabled={saving}><Save size={13} /> Save {PAYMENT_METHODS.find((method) => method.id === paymentMethod)?.label} account</button>
              {paymentDraft.id && <button type="button" className="secondary-button" disabled={saving} onClick={() => {
                if (window.confirm(`Remove the ${PAYMENT_METHODS.find((method) => method.id === paymentMethod)?.label} account?`)) {
                  void runAction({ action: "delete_payment_account", id: paymentDraft.id }, "Payment account removed.");
                }
              }}><Trash2 size={13} /> Remove account</button>}
            </div>
          </form>
        </section>
      </>}

      <style jsx>{`
        .settings-storefront-workspace { display: grid; gap: 14px; }
        .settings-workspace-panel h2 { display: flex; align-items: center; gap: 8px; }
        .settings-workspace-panel > p { margin: 0 0 14px; color: var(--muted); font-size: 11px; line-height: 1.55; }
        .settings-storefront-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .settings-storefront-heading h2 { margin: 0 0 6px; font-size: 15px; }
        .settings-storefront-heading p { margin: 0 0 14px; color: var(--muted); font-size: 11px; }
        .settings-storefront-branch, .settings-storefront-form > label:not(.settings-storefront-check), .settings-storefront-cod > label:not(.settings-storefront-check), .settings-storefront-payment > label:not(.settings-storefront-check) { display: grid; min-width: 0; gap: 6px; color: var(--muted); font-size: 10px; font-weight: 700; }
        .settings-storefront-branch { max-width: 380px; }
        .settings-storefront-branch select, .settings-storefront-form input:not([type="checkbox"]), .settings-storefront-cod input:not([type="checkbox"]), .settings-storefront-payment input:not([type="checkbox"]), .settings-storefront-payment textarea { width: 100%; min-width: 0; min-height: 38px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; color: var(--ink); background: var(--surface); font: inherit; font-size: 11px; }
        .settings-storefront-payment textarea { resize: vertical; }
        .settings-storefront-form, .settings-storefront-cod, .settings-storefront-payment { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); align-items: end; gap: 12px; }
        .settings-storefront-form-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; grid-column: 1 / -1; }
        .settings-storefront-check { display: inline-flex; min-height: 38px; align-items: center; gap: 7px; color: var(--ink); font-size: 11px; }
        .settings-storefront-check input { accent-color: var(--green); }
        .settings-storefront-list { display: grid; gap: 7px; margin-top: 14px; }
        .settings-storefront-row { display: flex; min-width: 0; align-items: center; gap: 9px; border: 1px solid var(--line); border-radius: 9px; padding: 9px 10px; background: var(--surface-soft); }
        .settings-storefront-row > div { min-width: 0; flex: 1; }
        .settings-storefront-row strong, .settings-storefront-row small { display: block; }
        .settings-storefront-row strong { overflow-wrap: anywhere; font-size: 11px; }
        .settings-storefront-row small { margin-top: 4px; color: var(--muted); font-size: 9px; }
        .settings-storefront-empty { margin: 0; border: 1px dashed var(--line); border-radius: 9px; padding: 12px; color: var(--muted); font-size: 10px; }
        .settings-storefront-provider-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
        .settings-storefront-provider-tabs button { min-height: 34px; border: 1px solid var(--line); border-radius: 8px; padding: 0 12px; color: var(--muted); background: var(--surface-soft); font: inherit; font-size: 10px; cursor: pointer; }
        .settings-storefront-provider-tabs button.active { border-color: var(--green); color: var(--green-dark); background: var(--green-soft); }
        .settings-storefront-wide { grid-column: 1 / -1; }
        .settings-storefront-qr { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
        .settings-storefront-qr > img { width: 64px; height: 64px; border: 1px solid var(--line); border-radius: 7px; object-fit: contain; background: white; }
        .settings-storefront-qr > div { display: grid; flex: 1; gap: 3px; }
        .settings-storefront-qr strong { font-size: 10px; }
        .settings-storefront-qr small { color: var(--muted); font-size: 9px; }
        @media (max-width: 640px) {
          .settings-workspace-panel { padding: 14px; }
          .settings-storefront-row { flex-wrap: wrap; }
          .settings-storefront-row > div { flex-basis: 100%; }
        }
      `}</style>
    </section>
  );
}
