"use client";

import {
  Ban,
  Building2,
  CheckCircle2,
  Cloud,
  Database,
  DatabaseBackup,
  Download,
  Eye,
  FolderOpen,
  KeyRound,
  Menu,
  Monitor,
  Palette,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Scale,
  ShieldCheck,
  Smartphone,
  Store,
  Tag,
  Tags,
  Truck,
  Upload,
  UserRound,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  DEFAULT_SCALE_SETTINGS,
  loadScaleSettings,
  saveScaleSettings,
  validateScaleSettings,
  type ScaleSettings,
} from "@/lib/scale-settings";
import { getBridgeClient, probeBridge, type BridgeStatus } from "@/lib/bridge/client";
import type { BridgePrinter } from "@/lib/bridge/protocol";
import {
  DEFAULT_PRINTER_SETTINGS,
  loadPrinterSettings,
  savePrinterSettings,
  validatePrinterSettings,
  type PrinterSettings,
} from "@/lib/print/printer-settings";
import {
  buildStandalonePrintHtml,
  listBridgePrinters,
  printHtmlViaBridge,
} from "@/lib/print/bridge-print";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { WorkspaceDialog, WorkspaceError, WorkspaceField, WorkspaceSuccess } from "@/components/workspace/WorkspaceDialog";
import { useAppearance } from "@/components/AppearanceProvider";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import type { BusinessSettings } from "@/lib/business-settings";
import { appThemes, themeGroups } from "@/lib/themes";

type SettingsTab =
  | "profile"
  | "appearance"
  | "shop"
  | "branches"
  | "permissions"
  | "storefront"
  | "cloud"
  | "tax"
  | "printers"
  | "scale"
  | "tags"
  | "data"
  | "device";

interface BranchSetting {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  receipt_prefix: string;
  is_default: boolean;
  is_active: boolean;
}

interface PermissionSetting {
  branch_id: string;
  role: string;
  is_allowed: boolean;
  permission_key?: string;
  action?: string;
}

interface CheckoutSetting {
  branch_id: string;
  is_active: boolean;
  max_order_amount_paisa: number | null;
}

interface DeliveryAreaSetting {
  branch_id: string;
  area_name: string;
  delivery_charge_paisa: number;
  free_delivery_threshold_paisa: number;
  is_active: boolean;
}

interface SettingsResponse {
  profile: {
    email: string;
    fullName: string;
    role: string;
    branchId: string | null;
  };
  branches: BranchSetting[];
  permissions: {
    modules: PermissionSetting[];
    webOrders: PermissionSetting[];
    inventory: PermissionSetting[];
  };
  storefront: {
    cashOnDelivery: CheckoutSetting[];
    deliveryAreas: DeliveryAreaSetting[];
  } | null;
  error?: string;
}

const TABS: { id: SettingsTab; label: string; icon: typeof UserRound; roles?: string[]; requiresHq?: boolean }[] = [
  { id: "profile", label: "Profile & security", icon: UserRound },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "shop", label: "Shop & branding", icon: Store, roles: ["admin"] },
  { id: "storefront", label: "Storefront checkout", icon: Truck, roles: ["admin"], requiresHq: true },
  { id: "branches", label: "Branches", icon: Building2, roles: ["admin"] },
  { id: "permissions", label: "Permissions", icon: ShieldCheck, roles: ["admin"] },
  { id: "cloud", label: "Cloud access", icon: Cloud, roles: ["admin"] },
  { id: "tax", label: "Tax & loyalty", icon: Database, roles: ["admin"] },
  { id: "printers", label: "Printers", icon: Printer, roles: ["admin", "manager"] },
  { id: "scale", label: "Scale", icon: Scale, roles: ["admin", "manager"] },
  { id: "tags", label: "Barcode tags", icon: Tags, roles: ["admin", "manager"] },
  { id: "data", label: "Data & backups", icon: Database, roles: ["admin", "manager"] },
  { id: "device", label: "Device", icon: Monitor },
];

function formatLabel(value: string): string {
  return value
    .replace(/^module:/, "")
    .replace(/[_:.-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatMoney(paisa: number): string {
  return `PKR ${(paisa / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type DesktopFieldType = "text" | "number" | "select" | "checkbox" | "textarea" | "time";

interface DesktopField {
  label: string;
  type?: DesktopFieldType;
  options?: string[];
  wide?: boolean;
}

function DesktopControl({ field }: { field: DesktopField }) {
  const type = field.type || "text";
  const ariaLabel = `${field.label} — not available in this workspace`;
  if (type === "checkbox") {
    return (
      <label className="check-field settings-workspace-check">
        <input type="checkbox" disabled aria-label={ariaLabel} />
        <span>{field.label}</span>
      </label>
    );
  }
  return (
    <label className={`settings-workspace-disabled-control${field.wide ? " wide" : ""}`}>
      <span>{field.label}</span>
      {type === "select" ? (
        <select disabled defaultValue="" aria-label={ariaLabel}>
          <option value="">Not available in web workspace</option>
          {(field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : type === "textarea" ? (
        <textarea disabled rows={3} placeholder="Not available in web workspace" aria-label={ariaLabel} />
      ) : (
        <input type={type} disabled value="" placeholder="Not available in web workspace" aria-label={ariaLabel} />
      )}
    </label>
  );
}

function DesktopAction({ children, primary = false, title }: { children: ReactNode; primary?: boolean; title: string }) {
  return (
    <button className={primary ? "primary-button" : "secondary-button"} type="button" disabled title={title}>
      {children}
    </button>
  );
}

function LocalOnlyPanel({ title, description, fields, actions, children, note }: {
  title: string;
  description: string;
  fields: (string | DesktopField)[];
  actions?: ReactNode;
  children?: ReactNode;
  note?: string;
}) {
  const normalized = fields.map((field) => typeof field === "string" ? { label: field } : field);
  return (
    <section className="card settings-workspace-panel">
      <div className="hr-panel-heading">
        <h2>{title}</h2>
        {actions ? <div className="heading-actions">{actions}</div> : null}
      </div>
      <p>{description}</p>
      <div className="settings-workspace-disabled-grid">
        {normalized.map((field) => <DesktopControl key={field.label} field={field} />)}
      </div>
      {children}
      <p className="settings-workspace-note">
        {note || "These values are maintained on the Windows device and are not available as synced cloud settings. No value is inferred here, and all controls are disabled."}
      </p>
    </section>
  );
}

function ScaleSettingsPanel({ branchId }: { branchId: string | null }) {
  const [form, setForm] = useState<ScaleSettings>({ ...DEFAULT_SCALE_SETTINGS });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("idle");

  useEffect(() => {
    try {
      setForm(loadScaleSettings({ branchId }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Scale settings could not be loaded.");
    }
  }, [branchId]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const client = getBridgeClient(form.bridgeUrl);
    setBridgeStatus(client.status);
    return client.onStatus(setBridgeStatus);
  }, [form.bridgeUrl]);

  const update = <K extends keyof ScaleSettings>(key: K, value: ScaleSettings[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice("");
  };

  const save = () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const validated = validateScaleSettings(form);
      saveScaleSettings(validated, { branchId });
      setForm(validated);
      setNotice("Scale settings saved for this branch and device.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Scale settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const testBridge = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const health = await probeBridge(form.bridgeUrl);
      if (!health) throw new Error("The local bridge did not answer. Start Al Haq Local Bridge and try again.");
      setNotice(`Local bridge ${health.version} is online (${health.platform}).`);
    } catch (bridgeError) {
      setError(bridgeError instanceof Error ? bridgeError.message : "The local bridge could not be reached.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card settings-workspace-panel">
      <h2><Scale size={14} /> Weighing scale configuration</h2>
      <p>Configure a USB-to-serial / RS-232 scale or an Ethernet TCP scale. Settings are saved for this branch and device only.</p>
      <div className="settings-bridge-status">
        <span className={`status-dot ${bridgeStatus === "connected" ? "online" : ""}`} aria-hidden="true" />
        <span>
          {bridgeStatus === "connected"
            ? "Local bridge connected"
            : bridgeStatus === "connecting"
              ? "Connecting to the local bridge…"
              : "Local bridge offline"}
        </span>
        <code>{form.bridgeUrl}</code>
      </div>
      <div className="settings-scale-grid">
        <label className="field"><span>Connection</span><select value={form.connection} onChange={(event) => update("connection", event.target.value as ScaleSettings["connection"])}><option value="serial">USB-to-serial / RS-232</option><option value="ethernet">Ethernet TCP</option></select></label>
        <label className="field"><span>Protocol</span><select value={form.protocol} onChange={(event) => update("protocol", event.target.value as ScaleSettings["protocol"])}><option value="ascii">ASCII stream</option><option value="modbus-rtu">Modbus RTU</option><option value="modbus-tcp">Modbus TCP</option></select></label>
        {form.connection === "serial" && <>
          <label className="field"><span>Baud rate</span><input type="number" min="1200" max="115200" value={form.baudRate} onChange={(event) => update("baudRate", Number(event.target.value))} /></label>
          <label className="field"><span>Data bits</span><select value={form.dataBits} onChange={(event) => update("dataBits", Number(event.target.value) as 7 | 8)}><option value="8">8</option><option value="7">7</option></select></label>
          <label className="field"><span>Parity</span><select value={form.parity} onChange={(event) => update("parity", event.target.value as ScaleSettings["parity"])}><option value="none">None</option><option value="even">Even</option><option value="odd">Odd</option></select></label>
          <label className="field"><span>Stop bits</span><select value={form.stopBits} onChange={(event) => update("stopBits", Number(event.target.value) as 1 | 2)}><option value="1">1</option><option value="2">2</option></select></label>
        </>}
        {form.connection === "ethernet" && <>
          <label className="field"><span>Scale IP address / host</span><input value={form.host} onChange={(event) => update("host", event.target.value)} placeholder="192.168.1.50" /></label>
          <label className="field"><span>TCP port</span><input type="number" min="1" max="65535" value={form.tcpPort} onChange={(event) => update("tcpPort", Number(event.target.value))} /></label>
        </>}
        <label className="field"><span>Reading unit</span><select value={form.unit} onChange={(event) => update("unit", event.target.value as ScaleSettings["unit"])}><option value="auto">Auto (from scale / product)</option><option value="kg">Kilograms (kg)</option><option value="g">Grams (g)</option><option value="lb">Pounds (lb)</option><option value="ltr">Litres (ltr)</option><option value="ml">Millilitres (ml)</option></select></label>
        <label className="field"><span>Poll interval (ms)</span><input type="number" min="100" max="60000" value={form.pollMs} onChange={(event) => update("pollMs", Number(event.target.value))} /></label>
        {form.protocol === "ascii" && <>
          <label className="field"><span>Request command</span><input value={form.command} onChange={(event) => update("command", event.target.value)} placeholder="e.g. W\\r\\n" /></label>
          <label className="field"><span>Reading pattern (RegExp)</span><input value={form.asciiPattern} onChange={(event) => update("asciiPattern", event.target.value)} placeholder="Optional, e.g. ([0-9.]+)\\s*kg" /></label>
        </>}
        {form.protocol !== "ascii" && <>
          <label className="field"><span>Modbus unit ID</span><input type="number" min="0" max="247" value={form.unitId} onChange={(event) => update("unitId", Number(event.target.value))} /></label>
          <label className="field"><span>Register type</span><select value={form.registerType} onChange={(event) => update("registerType", event.target.value as ScaleSettings["registerType"])}><option value="holding">Holding register</option><option value="input">Input register</option></select></label>
          <label className="field"><span>Register address</span><input type="number" min="0" max="65535" value={form.registerAddress} onChange={(event) => update("registerAddress", Number(event.target.value))} /></label>
          <label className="field"><span>Register count</span><select value={form.registerCount} onChange={(event) => update("registerCount", Number(event.target.value) as 1 | 2)}><option value="1">1</option><option value="2">2</option></select></label>
          <label className="field"><span>Data type</span><select value={form.valueType} onChange={(event) => update("valueType", event.target.value as ScaleSettings["valueType"])}><option value="uint16">Unsigned 16-bit integer</option><option value="int16">Signed 16-bit integer</option><option value="uint32">Unsigned 32-bit integer</option><option value="int32">Signed 32-bit integer</option><option value="float32">32-bit float</option></select></label>
          <label className="field"><span>Byte order</span><select value={form.byteOrder} onChange={(event) => update("byteOrder", event.target.value as ScaleSettings["byteOrder"])}>{["ABCD", "BADC", "CDAB", "DCBA"].map((order) => <option key={order} value={order}>{order}</option>)}</select></label>
          <label className="field"><span>Scale factor</span><input type="number" step="any" value={form.scaleFactor} onChange={(event) => update("scaleFactor", Number(event.target.value))} /></label>
          <label className="field"><span>Offset</span><input type="number" step="any" value={form.offset} onChange={(event) => update("offset", Number(event.target.value))} /></label>
        </>}
        <label className="field"><span>Local bridge address</span><input value={form.bridgeUrl} onChange={(event) => update("bridgeUrl", event.target.value)} placeholder="ws://127.0.0.1:47654" /></label>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="notice info" role="status">{notice}</div>}
      <div className="heading-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void testBridge()}>
          {busy ? "Checking…" : "Test bridge"}
        </button>
        <button type="button" className="primary-button" disabled={busy} onClick={save}>
          {busy ? "Saving…" : <><Save size={13} /> Save scale settings</>}
        </button>
      </div>
      <p className="settings-workspace-note">USB-to-serial scales connect through Web Serial in Chrome or Edge. Ethernet TCP scales and Modbus TCP require Al Haq Local Bridge running on this computer.</p>
    </section>
  );
}

function PrinterSettingsPanel({ branchId }: { branchId: string | null }) {
  const [form, setForm] = useState<PrinterSettings>({ ...DEFAULT_PRINTER_SETTINGS });
  const [printers, setPrinters] = useState<BridgePrinter[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("idle");

  useEffect(() => {
    setForm(loadPrinterSettings({ branchId }));
  }, [branchId]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const client = getBridgeClient(form.bridgeUrl);
    setBridgeStatus(client.status);
    return client.onStatus(setBridgeStatus);
  }, [form.bridgeUrl]);

  const update = <K extends keyof PrinterSettings>(key: K, value: PrinterSettings[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice("");
  };

  const refreshPrinters = async (bridgeUrl = form.bridgeUrl) => {
    setLoadingPrinters(true);
    setError("");
    try {
      const list = await listBridgePrinters(bridgeUrl);
      setPrinters(list);
      if (!list.length) setNotice("The local bridge is running but Windows reports no printers.");
    } catch (listError) {
      setPrinters([]);
      setError(listError instanceof Error ? listError.message : "Could not list printers through the local bridge.");
    } finally {
      setLoadingPrinters(false);
    }
  };

  useEffect(() => {
    void refreshPrinters(form.bridgeUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.bridgeUrl]);

  const save = () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const validated = validatePrinterSettings(form);
      savePrinterSettings(validated, { branchId });
      setForm(validated);
      setNotice("Printer settings saved for this branch and device.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Printer settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const printTestPage = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const validated = validatePrinterSettings(form);
      savePrinterSettings(validated, { branchId });
      setForm(validated);
      const html = buildStandalonePrintHtml({
        title: "Al Haq printer test",
        pageCss: "@page { size: 80mm auto; margin: 4mm; }",
        bodyHtml: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;padding:4mm;text-align:center;">`
          + `<h3 style="margin:0 0 4px;">Al Haq Farms &amp; Meats</h3>`
          + `<p style="margin:0;">Printer test page</p>`
          + `<p style="margin:8px 0 0;">${new Date().toLocaleString()}</p></div>`,
      });
      const result = await printHtmlViaBridge(html, {
        printer: validated.receiptPrinter,
        copies: 1,
        title: "Printer test",
        pageSize: "80mm auto",
        bridgeUrl: validated.bridgeUrl,
      });
      if (!result.printed) {
        throw new Error(result.reason || "The test page could not be printed.");
      }
      setNotice("Test page sent to the selected printer.");
    } catch (printError) {
      setError(printError instanceof Error ? printError.message : "The test page could not be printed.");
    } finally {
      setBusy(false);
    }
  };

  const printerOptions = (selected: string) => {
    const names = new Set(printers.map((printer) => printer.name));
    if (selected) names.add(selected);
    return Array.from(names).sort((left, right) => left.localeCompare(right));
  };

  return (
    <section className="card settings-workspace-panel">
      <h2><Printer size={14} /> Printers</h2>
      <p>Choose the receipt, report, and barcode-tag printers for this branch and device. Silent printing runs through Al Haq Local Bridge.</p>
      <div className="settings-bridge-status">
        <span className={`status-dot ${bridgeStatus === "connected" ? "online" : ""}`} aria-hidden="true" />
        <span>
          {bridgeStatus === "connected"
            ? "Local bridge connected"
            : bridgeStatus === "connecting"
              ? "Connecting to the local bridge…"
              : "Local bridge offline"}
        </span>
        <code>{form.bridgeUrl}</code>
      </div>
      <div className="settings-scale-grid">
        <label className="field">
          <span>Receipt printer</span>
          <select value={form.receiptPrinter} onChange={(event) => update("receiptPrinter", event.target.value)}>
            <option value="">Use system default</option>
            {printerOptions(form.receiptPrinter).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>A4 / report printer</span>
          <select value={form.reportPrinter} onChange={(event) => update("reportPrinter", event.target.value)}>
            <option value="">Use system default</option>
            {printerOptions(form.reportPrinter).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Barcode tag printer</span>
          <select value={form.labelPrinter} onChange={(event) => update("labelPrinter", event.target.value)}>
            <option value="">Use system default</option>
            {printerOptions(form.labelPrinter).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Label size</span>
          <select value={form.labelSizeId} onChange={(event) => update("labelSizeId", event.target.value)}>
            {["100x50", "80x50", "75x50", "60x40", "50x30"].map((size) => <option key={size} value={size}>{size.replace("x", " × ")} mm</option>)}
          </select>
        </label>
        <label className="field">
          <span>Receipt copies</span>
          <input type="number" min="1" max="10" value={form.receiptCopies} onChange={(event) => update("receiptCopies", Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Local bridge address</span>
          <input value={form.bridgeUrl} onChange={(event) => update("bridgeUrl", event.target.value)} placeholder="ws://127.0.0.1:47654" />
        </label>
      </div>
      <div className="settings-toggle-grid">
        <label className="toggle-field"><input type="checkbox" checked={form.autoPrintReceipt} onChange={(event) => update("autoPrintReceipt", event.target.checked)} /> Print receipt automatically after checkout</label>
        <label className="toggle-field"><input type="checkbox" checked={form.silentPrint} onChange={(event) => update("silentPrint", event.target.checked)} /> Print silently to the selected printer</label>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="notice info" role="status">{notice}</div>}
      <div className="heading-actions">
        <button type="button" className="secondary-button" disabled={loadingPrinters} onClick={() => void refreshPrinters()}>
          <RefreshCw size={13} className={loadingPrinters ? "spin" : ""} /> {loadingPrinters ? "Loading printers…" : "Refresh printers"}
        </button>
        <button type="button" className="secondary-button" disabled={busy || !bridgeStatus || bridgeStatus !== "connected"} onClick={() => void printTestPage()}>
          <Printer size={13} /> Print test page
        </button>
        <button type="button" className="primary-button" disabled={busy} onClick={save}>
          {busy ? "Saving…" : <><Save size={13} /> Save printer settings</>}
        </button>
      </div>
      <p className="settings-workspace-note">Printer queues belong to this computer, so these choices stay on this device. Start Al Haq Local Bridge to list printers and print without the browser dialog. When the bridge is offline the app falls back to the browser print dialog.</p>
    </section>
  );
}

function ReadOnlyTable({ headers, rows, emptyMessage }: {
  headers: string[];
  rows: (string | number | ReactNode)[][];
  emptyMessage: string;
}) {
  return (
    <div className="settings-workspace-table">
      <div className="table-wrap">
        <table className="workspace-table">
          <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
          <tbody>
            {rows.length
              ? rows.map((row, index) => <tr key={`${index}-${row.map(String).join("-")}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${String(cell)}`}>{cell}</td>)}</tr>)
              : <tr><td colSpan={headers.length}>{emptyMessage}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SettingsWorkspace({ item }: { item: WorkspaceModule }) {
  const { themeId, setThemeId } = useAppearance();
  const {
    settings: businessSettings,
    loading: businessSettingsLoading,
    error: businessSettingsLoadError,
    saveSettings: saveBusinessSettings,
    reload: reloadBusinessSettings,
  } = useBusinessSettings();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("profile");
  const [settingsTabsOpen, setSettingsTabsOpen] = useState(false);
  const settingsTabsRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [defaultBranchBusy, setDefaultBranchBusy] = useState<string | null>(null);
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const [credentialMode, setCredentialMode] = useState<"pin" | "password">("pin");
  const [currentSecret, setCurrentSecret] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [confirmSecret, setConfirmSecret] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [businessDraft, setBusinessDraft] = useState<BusinessSettings>(businessSettings);
  const [businessSaving, setBusinessSaving] = useState(false);
  const [businessError, setBusinessError] = useState<string | null>(null);
  const [businessNotice, setBusinessNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!businessSettingsLoading) setBusinessDraft(businessSettings);
  }, [businessSettings, businessSettingsLoading]);

  useEffect(() => {
    if (!settingsTabsOpen) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !settingsTabsRef.current?.contains(event.target)) {
        setSettingsTabsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsTabsOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsTabsOpen]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch("/api/workspace/settings", {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as SettingsResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load settings.");
        setSettings(result);
      } catch (loadError) {
        if (!active) return;
        setSettings(null);
        setError(loadError instanceof Error ? loadError.message : "Could not load settings.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [reloadKey]);

  const branchNames = useMemo(
    () => new Map((settings?.branches || []).map((branch) => [branch.id, branch.name])),
    [settings?.branches],
  );
  const setDefaultBranch = async (branchId: string) => {
    setDefaultBranchBusy(branchId);
    setError(null);
    try {
      const response = await fetch("/api/workspace/settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_default_branch", branchId }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The default branch could not be changed.");
      setReloadKey((key) => key + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The default branch could not be changed.");
    } finally {
      setDefaultBranchBusy(null);
    }
  };
  const openCredentialDialog = () => {
    setCredentialMode("pin");
    setCurrentSecret("");
    setNewSecret("");
    setConfirmSecret("");
    setCredentialError(null);
    setCredentialDialogOpen(true);
  };
  const closeCredentialDialog = () => {
    if (credentialBusy) return;
    setCredentialDialogOpen(false);
    setCredentialError(null);
    setCurrentSecret("");
    setNewSecret("");
    setConfirmSecret("");
  };
  const changeOwnCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newSecret !== confirmSecret) {
      setCredentialError("The confirmation does not match.");
      return;
    }

    setCredentialBusy(true);
    setCredentialError(null);
    try {
      const response = await fetch("/api/auth/change-credential", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentSecret, mode: credentialMode, value: newSecret }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The credential could not be changed.");

      setCredentialDialogOpen(false);
      setCurrentSecret("");
      setNewSecret("");
      setConfirmSecret("");
      setCredentialNotice(credentialMode === "pin" ? "Your POS PIN has been changed." : "Your password has been changed.");
    } catch (saveError) {
      setCredentialError(saveError instanceof Error ? saveError.message : "The credential could not be changed.");
    } finally {
      setCredentialBusy(false);
    }
  };
  const updateBusinessDraft = <K extends keyof BusinessSettings>(key: K, value: BusinessSettings[K]) => {
    setBusinessDraft((current) => ({ ...current, [key]: value }));
    setBusinessError(null);
    setBusinessNotice(null);
  };
  const uploadBusinessLogo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      setBusinessError("Choose a PNG, JPEG, WebP, or GIF image for the shop logo.");
      return;
    }
    if (file.size > 1.5 * 1024 * 1024) {
      setBusinessError("Shop logo must be smaller than 1.5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => updateBusinessDraft("logoDataUrl", String(reader.result || ""));
    reader.onerror = () => setBusinessError("The shop logo could not be read.");
    reader.readAsDataURL(file);
  };
  const submitBusinessSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusinessSaving(true);
    setBusinessError(null);
    setBusinessNotice(null);
    try {
      await saveBusinessSettings(businessDraft);
      setBusinessNotice("Shop branding and receipt settings were saved.");
    } catch (saveError) {
      setBusinessError(saveError instanceof Error ? saveError.message : "Shop settings could not be saved.");
    } finally {
      setBusinessSaving(false);
    }
  };
  const visibleTabs = useMemo(() => settings
    ? TABS.filter(({ roles, requiresHq }) => (!roles || roles.includes(settings.profile.role))
      && (!requiresHq || (settings.profile.role === "admin" && settings.profile.branchId === null)))
    : TABS.filter(({ id }) => ["profile", "appearance", "device"].includes(id)), [settings]);

  const renderPermissionRows = (rows: PermissionSetting[]) => rows.map((permission) => [
    branchNames.get(permission.branch_id) || "Assigned branch",
    formatLabel(permission.role),
    formatLabel(permission.permission_key || permission.action || "Permission"),
    permission.is_allowed ? "Allowed" : "Blocked",
  ]);

  return (
    <section className="workspace-module settings-workspace">
      <div className="workspace-toolbar">
        <div>
          <h1>{item.title}</h1>
          <p>Settings available to your signed-in account. Sensitive changes require verification.</p>
        </div>
        <div className="settings-workspace-actions">
          <button type="button" className="secondary-button" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCw size={13} /> Refresh
          </button>
          {activeTab === "branches" && settings?.profile.role === "admin" && settings.profile.branchId === null && (
            <button type="button" className="primary-button" disabled title="Adding branches is a Windows desktop workflow.">
              <Plus size={14} /> Add branch
            </button>
          )}
        </div>
      </div>

      <div className="settings-tabs-menu" ref={settingsTabsRef}>
        <button
          type="button"
          className="settings-tabs-menu-trigger"
          aria-expanded={settingsTabsOpen}
          aria-controls="settings-tabs-menu-list"
          aria-label={`Settings tabs: ${visibleTabs.find(({ id }) => id === activeTab)?.label || "Choose a section"}`}
          onClick={() => setSettingsTabsOpen((open) => !open)}
        >
          <Menu size={16} />
          <span>{visibleTabs.find(({ id }) => id === activeTab)?.label || "Settings sections"}</span>
        </button>
        {settingsTabsOpen && (
          <nav className="settings-tabs-menu-list" id="settings-tabs-menu-list" aria-label="Settings sections">
            {visibleTabs.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className={activeTab === id ? "active" : ""}
                aria-current={activeTab === id ? "page" : undefined}
                onClick={() => {
                  setActiveTab(id);
                  setSettingsTabsOpen(false);
                }}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </nav>
        )}
      </div>

      {loading && <section className="card"><p>Loading settings…</p></section>}
      {error && <section className="card" role="alert"><p>{error}</p></section>}
      {!loading && settings && <>
        {activeTab === "profile" && <>
          <WorkspaceSuccess message={credentialNotice} />
          <section className="card settings-workspace-panel">
            <h2>Profile &amp; security</h2>
            <p>Your profile is loaded from the authenticated cloud staff record.</p>
            <ReadOnlyTable
              headers={["Setting", "Current value"]}
              rows={[
                ["Name", settings.profile.fullName],
                ["Email", settings.profile.email],
                ["Role", formatLabel(settings.profile.role)],
                ["Assigned branch", settings.branches.find((branch) => branch.id === settings.profile.branchId)?.name || (settings.profile.branchId ? "Assigned branch" : "HQ · all accessible branches")],
              ]}
              emptyMessage="No profile values are available."
            />
          </section>
          <section className="card settings-workspace-panel">
            <h2>Credential controls</h2>
            <p>Use your current password to change your password, or your current PIN or password to change your PIN. Your other credential stays unchanged.</p>
            <div className="heading-actions">
              <button className="secondary-button" onClick={openCredentialDialog} type="button">
                <KeyRound size={13} /> Change PIN or password
              </button>
            </div>
          </section>
          <section className="card settings-workspace-panel">
            <h2><ShieldCheck size={14} /> Access &amp; permissions</h2>
            <ReadOnlyTable
              headers={["Capability", "Access"]}
              rows={[
                ["Point of sale", "Allowed"],
                ["Sell & take payments", "Allowed"],
                ["Returns and exchanges", settings.profile.role === "admin" || settings.profile.role === "manager" ? "Allowed" : "Restricted"],
                ["Inventory & purchasing", settings.profile.role === "admin" || settings.profile.role === "manager" ? "Allowed" : "Restricted"],
                ["Reports & dashboard", settings.profile.role === "admin" || settings.profile.role === "manager" ? "Allowed" : "Restricted"],
                ["HR & payroll", settings.profile.role === "admin" || settings.profile.role === "manager" ? "Allowed" : "Restricted"],
                ["Users & roles", settings.profile.role === "admin" ? "Allowed" : "Restricted"],
                ["Cloud sync", settings.profile.role === "admin" ? "Allowed" : "Restricted"],
                ["Audit log", settings.profile.role === "admin" ? "Allowed" : "Restricted"],
              ]}
              emptyMessage="No permissions are available."
            />
            <p className="settings-workspace-note">Permissions are determined by your assigned role. Contact an administrator if you need additional access.</p>
          </section>
        </>}

        {activeTab === "appearance" && (
          <section className="card settings-workspace-panel">
            <h2>Your appearance</h2>
            <p>Choose a color palette for this workspace. Your selection is saved in this browser for your staff account and applies across the management pages.</p>
            {themeGroups.map((group) => (
              <div className="settings-appearance-group" key={group.id}>
                <h3>{group.label}</h3>
                <div className="settings-appearance-grid">
                  {appThemes.filter((theme) => theme.group === group.id).map((theme) => {
                    const selected = theme.id === themeId;
                    return (
                      <button
                        type="button"
                        key={theme.id}
                        className={`settings-appearance-option${selected ? " selected" : ""}`}
                        aria-pressed={selected}
                        onClick={() => setThemeId(theme.id)}
                      >
                        <span
                          className="settings-appearance-swatch"
                          aria-hidden="true"
                          style={{ background: `linear-gradient(135deg, ${theme.background} 0 38%, ${theme.accent} 38% 70%, ${theme.glass} 70%)` }}
                        />
                        <span className="settings-appearance-option-label">
                          <strong>{theme.name}</strong>
                          {selected && <CheckCircle2 size={15} aria-label="Selected" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="settings-workspace-note">This preference is separate from the Windows app and does not change settings for other staff accounts or devices.</p>
          </section>
        )}

        {activeTab === "shop" && (
          <section className="card settings-workspace-panel">
            <div className="settings-business-heading">
              <div>
                <h2>Shop &amp; branding</h2>
                <p>These shared settings are used on web receipts for all staff accounts.</p>
              </div>
              <button type="button" className="secondary-button" disabled={businessSettingsLoading || businessSaving} onClick={reloadBusinessSettings}>
                <RefreshCw size={13} /> Reload
              </button>
            </div>
            <form className="settings-business-form" onSubmit={(event) => void submitBusinessSettings(event)}>
              <fieldset disabled={businessSettingsLoading || businessSaving}>
              <div className="settings-business-logo">
                <div className="settings-business-logo-preview">
                  {businessDraft.logoDataUrl ? <img src={businessDraft.logoDataUrl} alt="Shop logo preview" /> : <Store size={23} />}
                </div>
                <div>
                  <strong>Shop logo</strong>
                  <small>PNG, JPEG, WebP, or GIF. Maximum 1.5 MB.</small>
                  <div className="settings-business-logo-actions">
                    <label className="secondary-button">
                      <Upload size={13} /> Upload logo
                      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={businessSettingsLoading || businessSaving} onChange={uploadBusinessLogo} />
                    </label>
                    {businessDraft.logoDataUrl && (
                      <button className="secondary-button" type="button" disabled={businessSaving} onClick={() => updateBusinessDraft("logoDataUrl", "")}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="workspace-form-grid">
                <WorkspaceField label="Business name">
                  <input maxLength={200} value={businessDraft.businessName} onChange={(event) => updateBusinessDraft("businessName", event.target.value)} />
                </WorkspaceField>
                <WorkspaceField label="Tagline">
                  <input maxLength={200} value={businessDraft.businessTagline} onChange={(event) => updateBusinessDraft("businessTagline", event.target.value)} />
                </WorkspaceField>
                <WorkspaceField label="Business address">
                  <input maxLength={500} value={businessDraft.businessAddress} onChange={(event) => updateBusinessDraft("businessAddress", event.target.value)} />
                </WorkspaceField>
                <WorkspaceField label="Business phone">
                  <input maxLength={50} value={businessDraft.businessPhone} onChange={(event) => updateBusinessDraft("businessPhone", event.target.value)} />
                </WorkspaceField>
                <WorkspaceField label="Email">
                  <input type="email" maxLength={254} value={businessDraft.businessEmail} onChange={(event) => updateBusinessDraft("businessEmail", event.target.value)} />
                </WorkspaceField>
                <WorkspaceField label="Website">
                  <input type="url" maxLength={254} placeholder="https://" value={businessDraft.businessWebsite} onChange={(event) => updateBusinessDraft("businessWebsite", event.target.value)} />
                </WorkspaceField>
                <WorkspaceField label="Receipt footer">
                  <input maxLength={300} value={businessDraft.receiptFooter} onChange={(event) => updateBusinessDraft("receiptFooter", event.target.value)} />
                </WorkspaceField>
                <WorkspaceField label="Receipt paper size">
                  <select value={businessDraft.paperSize} onChange={(event) => updateBusinessDraft("paperSize", event.target.value as BusinessSettings["paperSize"])}>
                    <option value="80mm">80 mm</option>
                    <option value="58mm">58 mm</option>
                    <option value="A4">A4</option>
                  </select>
                </WorkspaceField>
                <WorkspaceField label="Return policy">
                  <textarea maxLength={2000} rows={3} value={businessDraft.returnPolicy} onChange={(event) => updateBusinessDraft("returnPolicy", event.target.value)} />
                </WorkspaceField>
                <WorkspaceField label="Tax on receipts">
                  <select value={businessDraft.taxDisplay} onChange={(event) => updateBusinessDraft("taxDisplay", event.target.value as BusinessSettings["taxDisplay"])}>
                    <option value="summary">Summary</option>
                    <option value="detailed">Break down by rate</option>
                  </select>
                </WorkspaceField>
              </div>
              <div className="settings-business-checks">
                <label><input type="checkbox" checked={businessDraft.showLogoOnReceipt} onChange={(event) => updateBusinessDraft("showLogoOnReceipt", event.target.checked)} /> Show logo on receipts</label>
                <label><input type="checkbox" checked={businessDraft.showTaxOnReceipt} onChange={(event) => updateBusinessDraft("showTaxOnReceipt", event.target.checked)} /> Show tax breakdown</label>
              </div>
              </fieldset>
              <p className="settings-workspace-note">Receipt and business details are shared across the web workspace. Currency and shop-wide visual defaults remain managed separately; the web workspace currently displays amounts in PKR.</p>
              <WorkspaceError message={businessSettingsLoadError || businessError} />
              <WorkspaceSuccess message={businessNotice} />
              <div className="workspace-form-actions">
                <button className="primary-button" disabled={businessSettingsLoading || businessSaving || Boolean(businessSettingsLoadError)} type="submit">
                  <Save size={13} /> {businessSaving ? "Saving…" : "Save shop settings"}
                </button>
              </div>
            </form>
          </section>
        )}

        {activeTab === "branches" && <section className="card settings-workspace-panel">
          <h2>Branches</h2>
          <p>Only branches returned for this authenticated user's existing access are shown. HQ administrators can choose the default branch.</p>
          <ReadOnlyTable
            headers={["Branch", "Code", "Status", "Address", "Timezone", "Receipt prefix", "Default", "Contact", "Actions"]}
            rows={settings.branches.map((branch) => [
              branch.name,
              branch.code,
              branch.is_active ? "Active" : "Inactive",
              branch.address || "Not set",
              branch.timezone,
              branch.receipt_prefix,
              branch.is_default ? "Yes" : "No",
              [branch.phone, branch.email].filter(Boolean).join(" · ") || "Not set",
              <div className="row-actions" key={branch.id}>
                {settings.profile.role === "admin" && settings.profile.branchId === null && !branch.is_default && branch.is_active && (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={defaultBranchBusy !== null}
                    onClick={() => void setDefaultBranch(branch.id)}
                  >
                    {defaultBranchBusy === branch.id ? <RefreshCw size={12} className="spin" /> : <CheckCircle2 size={12} />}
                    Make default
                  </button>
                )}
                <button className="secondary-button" type="button" disabled title="Editing branch details requires the branch administration workflow."><Pencil size={12} /> Edit</button>
              </div>,
            ])}
            emptyMessage="No branches are available to this account."
          />
          <p className="settings-workspace-note">Address and contact details are shown only when present in the shared branch record. Default-branch changes are saved securely and recorded in the audit log.</p>
        </section>}

        {activeTab === "permissions" && settings.profile.role !== "admin" && <section className="card settings-workspace-panel"><h2>Permissions</h2><p>Permission management settings are available to administrators only.</p></section>}
        {activeTab === "permissions" && settings.profile.role === "admin" && <>
          <div className="heading-actions" aria-label="Desktop permission actions">
            <DesktopAction title="Changing permission branch scope is a Windows desktop workflow.">Branch scope</DesktopAction>
            <DesktopAction title="Saving online-order permissions is a Windows desktop workflow."><Save size={13} /> Save order permissions</DesktopAction>
            <DesktopAction title="Saving module permissions is a Windows desktop workflow."><Save size={13} /> Save module permissions</DesktopAction>
            <DesktopAction title="Saving inventory permissions is a Windows desktop workflow."><Save size={13} /> Save inventory permissions</DesktopAction>
          </div>
          <section className="card settings-workspace-panel">
            <h2>Branch module permissions</h2>
            <p>Explicit synced permission rows visible under the existing branch RLS policy. No missing-row defaults are inferred.</p>
            <ReadOnlyTable
              headers={["Branch", "Role", "Permission", "Access"]}
              rows={renderPermissionRows(settings.permissions.modules)}
              emptyMessage="No synced module permission overrides are available."
            />
          </section>
          <section className="card settings-workspace-panel">
            <h2>Online order permissions</h2>
            <ReadOnlyTable
              headers={["Branch", "Role", "Action", "Access"]}
              rows={renderPermissionRows(settings.permissions.webOrders)}
              emptyMessage="No synced online-order permission overrides are available."
            />
          </section>
          <section className="card settings-workspace-panel">
            <h2>Inventory permissions</h2>
            <ReadOnlyTable
              headers={["Branch", "Role", "Action", "Access"]}
              rows={renderPermissionRows(settings.permissions.inventory)}
              emptyMessage="No synced inventory permission overrides are available."
            />
          </section>
          <p className="settings-workspace-note">Permission management controls are disabled in this workspace.</p>
        </>}

        {activeTab === "storefront" && (settings.storefront
          ? <>
            <div className="heading-actions" aria-label="Desktop storefront actions">
              <DesktopAction title="Changing storefront payment accounts is a Windows desktop workflow.">Payment accounts</DesktopAction>
              <DesktopAction title="Changing delivery areas is a Windows desktop workflow.">Add delivery area</DesktopAction>
              <DesktopAction primary title="Saving storefront checkout settings is a Windows desktop workflow."><Save size={13} /> Save checkout settings</DesktopAction>
            </div>
            <section className="card settings-workspace-panel">
              <h2>Cash on delivery</h2>
              <p>Read-only values from the branch-scoped storefront settings table.</p>
              <ReadOnlyTable
                headers={["Branch", "Status", "Maximum order amount"]}
                rows={settings.storefront.cashOnDelivery.map((entry) => [
                  branchNames.get(entry.branch_id) || "Assigned branch",
                  entry.is_active ? "Enabled" : "Disabled",
                  entry.max_order_amount_paisa === null ? "No maximum configured" : formatMoney(entry.max_order_amount_paisa),
                ])}
                emptyMessage="No synced cash-on-delivery settings were found."
              />
            </section>
            <section className="card settings-workspace-panel">
              <h2>Delivery areas</h2>
              <ReadOnlyTable
                headers={["Branch", "Area", "Status", "Delivery charge", "Free delivery threshold"]}
                rows={settings.storefront.deliveryAreas.map((area) => [
                  branchNames.get(area.branch_id) || "Assigned branch",
                  area.area_name,
                  area.is_active ? "Active" : "Inactive",
                  formatMoney(area.delivery_charge_paisa),
                  formatMoney(area.free_delivery_threshold_paisa),
                ])}
                emptyMessage="No synced delivery areas were found."
              />
            </section>
            <p className="settings-workspace-note">Payment account numbers, QR data, credentials, and checkout controls are not exposed here.</p>
          </>
          : <section className="card settings-workspace-panel"><h2>Storefront checkout</h2><p>These settings are available to manager and admin roles only under the existing database policies.</p></section>)}

        {activeTab === "cloud" && <>
          <div className="heading-actions" aria-label="Desktop cloud access actions">
            <DesktopAction title="Opening the Cloud sync workspace from Settings is a Windows desktop workflow."><Cloud size={13} /> Open Cloud Sync</DesktopAction>
            <DesktopAction title="Refreshing cloud accounts is a Windows desktop workflow."><RefreshCw size={13} /> Refresh accounts</DesktopAction>
            <DesktopAction primary title="Assigning cloud accounts is a Windows desktop workflow."><Plus size={14} /> Assign cloud account</DesktopAction>
          </div>
          <section className="card settings-workspace-panel">
            <h2><Cloud size={14} /> Cloud access</h2>
            <p>The signed-in cloud staff record and accessible branches are shown in Profile &amp; security. The existing staff-account RLS does not expose a branch-wide account directory to this workspace.</p>
            <div className="settings-workspace-disabled-grid">
              <DesktopControl field={{ label: "Email", type: "text" }} />
              <DesktopControl field={{ label: "Full name", type: "text" }} />
              <DesktopControl field={{ label: "Role", type: "select", options: ["Cashier", "Manager", "Admin"] }} />
              <DesktopControl field={{ label: "Branch", type: "select", options: settings.branches.filter((branch) => branch.is_active).map((branch) => `${branch.name} (${branch.code})`) }} />
            </div>
            <p className="settings-workspace-note">Account assignment and credential administration are disabled; no staff accounts or credentials are inferred. Use the Staff accounts page for the read-only roster available to HQ administrators.</p>
          </section>
        </>}

        {activeTab === "tax" && <>
          <LocalOnlyPanel
            title="Tax & loyalty"
            description="Applied to new sales unless a product overrides the rate. Global tax mode, tax rounding, discount limits, and loyalty rules are desktop business settings and are not represented as shared settings in the web database."
            fields={[
              { label: "Tax mode", type: "select", options: ["Tax inclusive prices", "Add tax at checkout"] },
              { label: "Tax rate (%)", type: "number" },
              { label: "Tax rounding scope", type: "select", options: ["Each sale line", "Whole sale"] },
              { label: "Tax rounding method", type: "select", options: ["Nearest paisa", "Round down", "Round up"] },
              { label: "Tax rounding increment (paisa)", type: "select", options: ["1", "5", "10", "25", "50", "100"] },
              { label: "Receipt tax detail", type: "select", options: ["Summary", "Per tax rate"] },
              { label: "Maximum item discount (%)", type: "number" },
              { label: "Maximum bill discount (%)", type: "number" },
              { label: "Loyalty points per PKR 100", type: "number" },
              { label: "Value per loyalty point (PKR)", type: "number" },
              { label: "Low stock threshold", type: "number" },
              { label: "Allow sales when this would take stock below zero", type: "checkbox", wide: true },
            ]}
            actions={<DesktopAction primary title="Saving tax and loyalty settings is a Windows desktop workflow."><Save size={13} /> Save settings</DesktopAction>}
            note="Discount and loyalty rules are enforced at checkout. Set points per PKR 100 to zero to disable earning; each point is worth the configured PKR value when redeemed. Nothing is inferred here, and all controls are disabled."
          />
          <section className="card settings-workspace-panel">
            <div className="hr-panel-heading">
              <h2><ShieldCheck size={14} /> FBR setup</h2>
              <DesktopAction title="Managing PCT categories is a Windows desktop workflow."><Tag size={13} /> Manage PCT categories</DesktopAction>
            </div>
            <p>Configure FBR credentials per branch. Invoice submission is not available until the official API protocol and verification response are implemented.</p>
            <div className="settings-workspace-disabled-grid">
              <DesktopControl field={{ label: "Branch", type: "select", options: settings.branches.map((branch) => `${branch.name} (${branch.code})`) }} />
              <DesktopControl field={{ label: "Environment", type: "select", options: ["Sandbox / test", "Production"] }} />
              <DesktopControl field={{ label: "FBR API base URL (HTTPS only)", wide: true }} />
              <DesktopControl field={{ label: "NTN / STRN / registration ID" }} />
              <DesktopControl field={{ label: "FBR POS ID" }} />
              <DesktopControl field={{ label: "Payment mode code", type: "number" }} />
              <DesktopControl field={{ label: "Branch / API client ID" }} />
            </div>
            <div className="heading-actions" style={{ marginTop: "12px" }}>
              <DesktopAction title="Previewing the latest sale payload is a Windows desktop workflow."><Eye size={13} /> Preview latest sale payload</DesktopAction>
              <DesktopAction primary title="Saving FBR settings is a Windows desktop workflow."><Save size={13} /> Save FBR settings</DesktopAction>
            </div>
            <p className="settings-workspace-note">Saving these settings does not submit invoices or mark sales as FBR-verified. Credentials are encrypted using the Windows device&apos;s secure storage and are excluded from cloud sync.</p>
          </section>
        </>}

        {activeTab === "printers" && <PrinterSettingsPanel branchId={settings.profile.branchId} />}

        {activeTab === "scale" && <ScaleSettingsPanel branchId={settings.profile.branchId} />}

        {activeTab === "tags" && <>
          <LocalOnlyPanel
            title="Barcode tags"
            description="Choose the physical size of each printed product tag. This setting is shared by staff at the selected branch on the Windows host."
            fields={[
              { label: "Label size", type: "select", options: ["100 × 50 mm", "80 × 50 mm", "75 × 50 mm", "60 × 40 mm", "50 × 30 mm"] },
              { label: "Barcode tag printer", type: "select", options: ["Use system default"] },
            ]}
            actions={<DesktopAction title="Saving barcode tag settings is a Windows desktop workflow."><Save size={13} /> Save settings</DesktopAction>}
            note="The physical label size and printer selection belong to the desktop print setup. Use the Barcode labels page to preview and print labels with the current web label sizes."
          />
          <section className="card settings-workspace-panel">
            <h2><Tags size={14} /> Barcode tag size</h2>
            <p>Barcode labels can be printed from the Barcode labels page. Choose the shared physical label size there.</p>
            <div className="heading-actions">
              <DesktopAction title="Opening the desktop barcode label workflow is a Windows workflow.">Barcode label workflow</DesktopAction>
            </div>
          </section>
        </>}

        {activeTab === "data" && <>
          <div className="heading-actions" aria-label="Desktop data and backup actions">
            <DesktopAction title="Exporting a full JSON backup is a Windows desktop workflow."><Database size={13} /> Full JSON</DesktopAction>
            <DesktopAction title="Opening the backup folder is a Windows desktop workflow."><FolderOpen size={13} /> Open folder</DesktopAction>
            <DesktopAction primary title="Creating a local backup is a Windows desktop workflow."><DatabaseBackup size={13} /> Back up now</DesktopAction>
          </div>
          <section className="card settings-workspace-panel">
            <h2><DatabaseBackup size={14} /> Report export folder</h2>
            <p>PDF exports default to Downloads on the Windows host. Choose a separate folder there if preferred.</p>
            <div className="heading-actions">
              <DesktopAction title="Choosing a report folder is a Windows desktop workflow."><FolderOpen size={13} /> Choose report folder</DesktopAction>
            </div>
          </section>
          <section className="card settings-workspace-panel">
            <h2><DatabaseBackup size={14} /> Local backups</h2>
            <p>A backup is a complete, internally consistent copy of the local database, written without closing the app. Take one before upgrades, month close or any risky change.</p>
            <div className="heading-actions">
              <DesktopAction title="Exporting a full JSON backup is a Windows desktop workflow."><Database size={13} /> Full JSON</DesktopAction>
              <DesktopAction title="Opening the backup folder is a Windows desktop workflow."><FolderOpen size={13} /> Open folder</DesktopAction>
              <DesktopAction primary title="Creating a local backup is a Windows desktop workflow."><DatabaseBackup size={13} /> Back up now</DesktopAction>
            </div>
            <div className="settings-workspace-disabled-grid" style={{ marginTop: "12px" }}>
              <DesktopControl field={{ label: "Backup schedule", type: "select", options: ["Disabled", "Enabled"] }} />
              <DesktopControl field={{ label: "Backup time", type: "time" }} />
              <DesktopControl field={{ label: "Frequency", type: "select", options: ["Daily", "Every 2 days", "Every 3 days", "Weekly", "Custom interval"] }} />
              <DesktopControl field={{ label: "Additional backup copy folder", wide: true }} />
            </div>
            <div className="heading-actions">
              <DesktopAction title="Choosing a backup copy folder is a Windows desktop workflow."><FolderOpen size={13} /> Choose folder</DesktopAction>
              <DesktopAction primary title="Saving the automatic backup schedule is a Windows desktop workflow."><Save size={13} /> Save schedule</DesktopAction>
            </div>
            <ReadOnlyTable
              headers={["Backup", "Created", "Size", "Actions"]}
              rows={[]}
              emptyMessage="Local backup files exist only on the Windows host and are not listed here."
            />
            <div className="heading-actions" style={{ marginTop: "10px" }}>
              <DesktopAction title="Restoring a backup is a Windows desktop workflow.">Restore</DesktopAction>
              <DesktopAction primary title="Restoring a backup and restarting is a Windows desktop workflow.">Restore and restart</DesktopAction>
            </div>
            <p className="settings-workspace-note">Restoring validates the backup, replaces the live database on the next launch and keeps a pre-restore copy beside the backups. Sign in again afterwards; anything recorded after the backup is gone. All backup actions are disabled in this workspace.</p>
          </section>
        </>}

        {activeTab === "device" && <>
          <section className="dashboard-stats" aria-label="Device summary">
            <article className="dashboard-stat card"><span>Branches</span><strong>{settings.branches.length}</strong><small>{settings.branches.filter((branch) => branch.is_active).length} active</small><Building2 size={16} aria-hidden="true" /></article>
            <article className="dashboard-stat card"><span>Database</span><strong>Cloud</strong><small>Supabase · read-only</small><Database size={16} aria-hidden="true" /></article>
            <article className="dashboard-stat card"><span>Setup</span><strong>{settings.profile.role === "admin" ? "Admin" : formatLabel(settings.profile.role)}</strong><small>Signed-in staff profile</small><ShieldCheck size={16} aria-hidden="true" /></article>
            <article className="dashboard-stat card"><span>Version</span><strong>Web</strong><small>Alhaqfm workspace</small><Monitor size={16} aria-hidden="true" /></article>
          </section>
          <section className="card settings-workspace-panel">
            <h2><Monitor size={14} /> This device</h2>
            <ReadOnlyTable
              headers={["Setting", "Current value"]}
              rows={[
                ["Signed-in profile", `${settings.profile.fullName} · ${formatLabel(settings.profile.role)}`],
                ["Branch", settings.branches.find((branch) => branch.id === settings.profile.branchId)?.name || "HQ · all accessible branches"],
                ["Cloud sync", "Connected through Supabase"],
                ["Local database", "SQLite on the Windows host · available offline"],
              ]}
              emptyMessage="No device values are available."
            />
          </section>
          <section className="card settings-workspace-panel">
            <div className="hr-panel-heading">
              <h2><Wifi size={14} /> Local network access</h2>
              <DesktopAction primary title="LAN access controls are available on the Windows host PC."><Wifi size={13} /> Start LAN access</DesktopAction>
            </div>
            <p>The host PC serves the app to approved devices on the same private Wi-Fi network. Each staff member signs in with their own profile and branch permissions.</p>
            <div className="settings-workspace-disabled-grid">
              <DesktopControl field={{ label: "Start LAN access automatically when this app opens", type: "checkbox", wide: true }} />
              <DesktopControl field={{ label: "Approved devices", wide: true }} />
            </div>
            <div className="heading-actions">
              <DesktopAction title="Saving the LAN certificate is a Windows desktop workflow."><Download size={13} /> Save CA for devices</DesktopAction>
              <DesktopAction title="Refreshing device requests is a Windows desktop workflow."><RefreshCw size={14} /></DesktopAction>
              <DesktopAction primary title="Approving devices is a Windows desktop workflow."><CheckCircle2 size={13} /> Approve</DesktopAction>
              <DesktopAction title="Declining devices is a Windows desktop workflow."><Ban size={13} /> Decline</DesktopAction>
              <DesktopAction title="Revoking devices is a Windows desktop workflow."><Smartphone size={13} /> Revoke</DesktopAction>
            </div>
            <p className="settings-workspace-note">LAN server controls, device approval requests, and certificate export are available on the Windows host PC only.</p>
          </section>
        </>}
      </>}
      {credentialDialogOpen && (
        <WorkspaceDialog
          title="Change security details"
          eyebrow="Profile & security"
          label="Change PIN or password"
          onClose={closeCredentialDialog}
          footer={(
            <>
              <button className="button secondary" disabled={credentialBusy} onClick={closeCredentialDialog} type="button">
                Cancel
              </button>
              <button className="button" disabled={credentialBusy} form="settings-credential-form" type="submit">
                {credentialBusy ? "Saving…" : "Save"}
              </button>
            </>
          )}
        >
          <form className="form-stack" id="settings-credential-form" onSubmit={(event) => void changeOwnCredential(event)}>
            <p>{credentialMode === "password"
              ? "Enter your current password to change your password."
              : "Enter your current PIN or password to change your PIN."} The other sign-in credential will remain unchanged.</p>
            <div className="heading-actions">
              {(["pin", "password"] as const).map((mode) => (
                <button
                  className={credentialMode === mode ? "button" : "button secondary"}
                  key={mode}
                  onClick={() => {
                    setCredentialMode(mode);
                    setCredentialError(null);
                    setNewSecret("");
                    setConfirmSecret("");
                  }}
                  type="button"
                >
                  {mode === "pin" ? "Change PIN" : "Change password"}
                </button>
              ))}
            </div>
            <WorkspaceField label={credentialMode === "password" ? "Current password" : "Current PIN or password"}>
              <input
                autoComplete="current-password"
                autoFocus
                onChange={(event) => setCurrentSecret(event.target.value)}
                required
                type="password"
                value={currentSecret}
              />
            </WorkspaceField>
            <WorkspaceField label={credentialMode === "pin" ? "New PIN (4–8 digits)" : "New password (10–200 characters)"}>
              <input
                autoComplete="new-password"
                inputMode={credentialMode === "pin" ? "numeric" : undefined}
                maxLength={credentialMode === "pin" ? 8 : 200}
                minLength={credentialMode === "pin" ? 4 : 10}
                onChange={(event) => setNewSecret(credentialMode === "pin"
                  ? event.target.value.replace(/\D/g, "").slice(0, 8)
                  : event.target.value)}
                pattern={credentialMode === "pin" ? "[0-9]{4,8}" : undefined}
                required
                type="password"
                value={newSecret}
              />
            </WorkspaceField>
            <WorkspaceField label={`Confirm new ${credentialMode}`}>
              <input
                autoComplete="new-password"
                maxLength={credentialMode === "pin" ? 8 : 200}
                onChange={(event) => setConfirmSecret(credentialMode === "pin"
                  ? event.target.value.replace(/\D/g, "").slice(0, 8)
                  : event.target.value)}
                required
                type="password"
                value={confirmSecret}
              />
            </WorkspaceField>
            <WorkspaceError message={credentialError} />
          </form>
        </WorkspaceDialog>
      )}
      <style jsx>{`
        .settings-workspace { display: grid; gap: 14px; }
        .workspace-toolbar { align-items: center; justify-content: space-between; }
        .workspace-toolbar h1 { margin: 0 0 5px; font-size: 20px; }
        .workspace-toolbar p { margin: 0; color: var(--muted); font-size: 12px; }
        .settings-workspace-actions { display: flex; align-items: center; gap: 8px; }
        .settings-workspace-table { display: grid; gap: 8px; min-width: 0; }
        .settings-tabs-menu { position: relative; z-index: 2; width: fit-content; }
        .settings-tabs-menu-trigger { display: inline-flex; min-height: 38px; align-items: center; gap: 9px; border: 1px solid var(--line); border-radius: 9px; padding: 0 12px; color: var(--ink); background: var(--surface); font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
        .settings-tabs-menu-trigger:hover, .settings-tabs-menu-trigger[aria-expanded="true"] { border-color: var(--green); }
        .settings-tabs-menu-list { position: absolute; top: calc(100% + 6px); left: 0; display: grid; width: min(300px, calc(100vw - 48px)); max-height: min(65vh, 480px); gap: 3px; overflow-y: auto; border: 1px solid var(--line); border-radius: 11px; padding: 6px; background: var(--surface); box-shadow: var(--shadow); }
        .settings-tabs-menu-list button { display: flex; min-height: 37px; align-items: center; gap: 9px; border: 1px solid transparent; border-radius: 7px; padding: 0 9px; color: var(--muted); background: transparent; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
        .settings-tabs-menu-list button:hover, .settings-tabs-menu-list button.active { border-color: var(--line); color: var(--green-dark); background: var(--surface-soft); }
        .settings-workspace-panel { min-width: 0; padding: 18px; }
        .settings-workspace-panel h2 { margin: 0 0 8px; color: var(--ink); font-size: 15px; }
        .settings-workspace-panel > p { margin: 0 0 14px; color: var(--muted); font-size: 11px; line-height: 1.55; }
        .settings-workspace-panel .table-wrap { border: 1px solid var(--line); border-radius: 10px; }
        .settings-workspace-panel .table-wrap tr td[colspan] { padding: 18px; color: var(--muted); }
        .settings-workspace-disabled-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; }
        .settings-workspace-disabled-control { display: grid; gap: 6px; color: var(--muted); font-size: 10px; font-weight: 700; }
        .settings-workspace-disabled-control.wide { grid-column: 1 / -1; }
        .settings-workspace-disabled-control input, .settings-workspace-disabled-control select, .settings-workspace-disabled-control textarea { width: 100%; min-height: 38px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; color: var(--muted); background: #f5f7f5; font: inherit; }
        .settings-workspace-disabled-control textarea { padding: 8px 10px; resize: vertical; }
        .settings-workspace-disabled-control input[type="checkbox"] { width: 16px; min-height: 16px; }
        .settings-workspace-check { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 10px; font-weight: 700; }
        .settings-workspace-check input[type="checkbox"] { width: 16px; height: 16px; }
        .settings-workspace-note { margin: 13px 0 0 !important; border-left: 3px solid var(--amber); padding: 8px 10px; background: var(--surface-soft); }
        .settings-business-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .settings-business-heading p { margin: 0 0 14px; color: var(--muted); font-size: 11px; line-height: 1.55; }
        .settings-business-form { display: grid; gap: 14px; }
        .settings-business-form fieldset { display: grid; gap: 14px; min-width: 0; border: 0; margin: 0; padding: 0; }
        .settings-business-logo { display: flex; align-items: center; gap: 13px; }
        .settings-business-logo-preview { display: grid; width: 76px; height: 64px; flex: 0 0 76px; place-items: center; overflow: hidden; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); background: var(--surface-soft); }
        .settings-business-logo-preview img { width: 100%; height: 100%; object-fit: contain; }
        .settings-business-logo strong, .settings-business-logo small { display: block; }
        .settings-business-logo strong { font-size: 11px; }
        .settings-business-logo small { margin-top: 4px; color: var(--muted); font-size: 9px; }
        .settings-business-logo-actions { display: flex; gap: 7px; margin-top: 8px; }
        .settings-business-logo-actions input[type="file"] { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
        .settings-business-checks { display: flex; flex-wrap: wrap; gap: 12px 20px; }
        .settings-business-checks label { display: inline-flex; align-items: center; gap: 7px; color: var(--ink); font-size: 11px; }
        .settings-business-checks input { accent-color: var(--green); }
        .settings-appearance-group { display: grid; gap: 9px; margin-top: 20px; }
        .settings-appearance-group h3 { margin: 0; color: var(--muted); font-size: 11px; font-weight: 700; }
        .settings-appearance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 10px; }
        .settings-appearance-option { display: grid; gap: 10px; border: 1px solid var(--line); border-radius: 11px; padding: 9px; color: var(--ink); background: var(--surface-soft); text-align: left; cursor: pointer; }
        .settings-appearance-option:hover { border-color: var(--green); }
        .settings-appearance-option.selected { border-color: var(--green); box-shadow: 0 0 0 2px color-mix(in srgb, var(--green) 18%, transparent); }
        .settings-appearance-swatch { display: block; height: 66px; border: 1px solid var(--line); border-radius: 7px; }
        .settings-appearance-option-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; }
        .settings-appearance-option-label svg { flex: 0 0 auto; color: var(--green); }
        .settings-scale-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 10px; }
        .settings-scale-grid .field { margin: 0; }
        @media (max-width: 640px) {
          .settings-workspace-panel { padding: 14px; }
          .settings-workspace-actions { align-items: stretch; }
          .settings-business-heading { align-items: flex-start; }
        }
      `}</style>
    </section>
  );
}
