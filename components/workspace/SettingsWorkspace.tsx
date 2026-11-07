"use client";

import {
  Ban,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Database,
  DatabaseBackup,
  Download,
  Eye,
  FolderOpen,
  KeyRound,
  Monitor,
  Palette,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Scale,
  Search,
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
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_SCALE_SETTINGS,
  loadScaleSettings,
  saveScaleSettings,
  validateScaleSettings,
  type ScaleSettings,
} from "@/lib/scale-settings";
import type { WorkspaceModule } from "@/lib/workspace-modules";

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

function ScaleSettingsPanel() {
  const [form, setForm] = useState<ScaleSettings>({ ...DEFAULT_SCALE_SETTINGS });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    try {
      setForm(loadScaleSettings());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Scale settings could not be loaded.");
    }
  }, []);

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
      saveScaleSettings(validated);
      setForm(validated);
      setNotice("Scale settings saved on this device.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Scale settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card settings-workspace-panel">
      <h2><Scale size={14} /> Weighing scale configuration</h2>
      <p>Configure a USB-to-serial / RS-232 scale or an Ethernet TCP scale. These settings are saved locally in this browser and are not synced to other branches.</p>
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
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="notice info" role="status">{notice}</div>}
      <div className="heading-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={save}>
          {busy ? "Saving…" : <><Save size={13} /> Save scale settings</>}
        </button>
      </div>
      <p className="settings-workspace-note">USB-to-serial scales connect through Web Serial in Chrome or Edge. Ethernet TCP scales require the Windows desktop app.</p>
    </section>
  );
}

function ReadOnlyTable({ headers, rows, emptyMessage, searchQuery }: {
  headers: string[];
  rows: (string | number | ReactNode)[][];
  emptyMessage: string;
  searchQuery: string;
}) {
  const [sortColumn, setSortColumn] = useState(0);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [pageSize, setPageSize] = useState(10);
  const [requestedPage, setRequestedPage] = useState(0);
  const [tableFilter, setTableFilter] = useState("");
  useEffect(() => setRequestedPage(0), [searchQuery]);
  const filteredRows = useMemo(() => {
    const query = [searchQuery, tableFilter].map((value) => value.trim().toLocaleLowerCase()).filter(Boolean).join(" ");
    const matches = query
      ? rows.filter((row) => {
        const rowText = row.map(String).join(" ").toLocaleLowerCase();
        return query.split(/\s+/).every((term) => rowText.includes(term));
      })
      : rows;
    return [...matches].sort((left, right) => {
      const comparison = String(left[sortColumn] ?? "").localeCompare(String(right[sortColumn] ?? ""), undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [rows, searchQuery, sortColumn, sortDirection, tableFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const page = Math.min(requestedPage, pageCount - 1);
  const pageRows = filteredRows.slice(page * pageSize, (page + 1) * pageSize);
  const firstRow = filteredRows.length ? page * pageSize + 1 : 0;
  const lastRow = Math.min((page + 1) * pageSize, filteredRows.length);

  return (
    <div className="settings-workspace-table">
      <label className="settings-workspace-table-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={tableFilter}
          aria-label="Search this settings table"
          placeholder="Filter rows…"
          onChange={(event) => {
            setTableFilter(event.target.value);
            setRequestedPage(0);
          }}
        />
      </label>
      <div className="table-wrap">
        <table className="workspace-table">
          <thead><tr>{headers.map((header, index) => (
            <th key={header} aria-sort={sortColumn === index ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
              <button
                type="button"
                className="settings-workspace-sort"
                aria-label={`Sort by ${header}${sortColumn === index ? `, ${sortDirection === "asc" ? "ascending" : "descending"}` : ""}`}
                onClick={() => {
                  if (sortColumn === index) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
                  else {
                    setSortColumn(index);
                    setSortDirection("asc");
                  }
                  setRequestedPage(0);
                }}
              >
                {header}{sortColumn === index ? (sortDirection === "asc" ? " ↑" : " ↓") : ""}
              </button>
            </th>
          ))}</tr></thead>
          <tbody>
            {pageRows.length
              ? pageRows.map((row, index) => <tr key={`${page * pageSize + index}-${row.join("-")}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{cell}</td>)}</tr>)
              : <tr><td colSpan={headers.length}>{(searchQuery || tableFilter).trim() ? "No rows match this filter." : emptyMessage}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="settings-workspace-table-controls">
        <span>Showing {firstRow}–{lastRow} of {filteredRows.length}</span>
        <label>
          Rows
          <select aria-label="Rows per page" value={pageSize} onChange={(event) => {
            setPageSize(Number(event.target.value));
            setRequestedPage(0);
          }}>
            {[10, 25, 50].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => setRequestedPage(page - 1)}>
          <ChevronLeft size={14} />
        </button>
        <span>Page {page + 1} of {pageCount}</span>
        <button type="button" aria-label="Next page" disabled={page >= pageCount - 1} onClick={() => setRequestedPage(page + 1)}>
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

export function SettingsWorkspace({ item }: { item: WorkspaceModule }) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("profile");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [globalSearch, setGlobalSearch] = useState("");

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
          <p>Read-only view of settings available to your signed-in account.</p>
        </div>
        <div className="settings-workspace-actions">
          <label className="settings-workspace-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search settings tables"
              placeholder="Search settings tables…"
              value={globalSearch}
              onChange={(event) => setGlobalSearch(event.target.value)}
            />
          </label>
          <button type="button" className="secondary-button" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCw size={13} /> Refresh
          </button>
          {activeTab === "branches" && settings?.profile.role === "admin" && (
            <button type="button" className="primary-button" disabled title="Adding branches is a Windows desktop workflow.">
              <Plus size={14} /> Add branch
            </button>
          )}
        </div>
      </div>

      <nav className="settings-workspace-tabs" aria-label="Settings sections">
        {visibleTabs.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            className={activeTab === id ? "active" : ""}
            aria-current={activeTab === id ? "page" : undefined}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </nav>

      {loading && <section className="card"><p>Loading settings…</p></section>}
      {error && <section className="card" role="alert"><p>{error}</p></section>}
      {!loading && settings && <>
        {activeTab === "profile" && <>
          <section className="card settings-workspace-panel">
            <h2>Profile &amp; security</h2>
            <p>Your profile is loaded from the authenticated cloud staff record.</p>
            <ReadOnlyTable
              headers={["Setting", "Current value"]}
              searchQuery={globalSearch}
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
            <p>Credential values are never read by this Settings API. PIN and password changes require the secure credential workflow, which is not available in this read-only workspace.</p>
            <div className="heading-actions">
              <DesktopAction title="Changing a PIN or password is a Windows desktop workflow.">
                <KeyRound size={13} /> Change PIN or password
              </DesktopAction>
            </div>
          </section>
          <section className="card settings-workspace-panel">
            <h2><ShieldCheck size={14} /> Access &amp; permissions</h2>
            <ReadOnlyTable
              headers={["Capability", "Access"]}
              searchQuery={globalSearch}
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

        {activeTab === "appearance" && <LocalOnlyPanel
          title="Your appearance"
          description="Your theme is saved on this device. Choosing one changes your view without changing another staff member's settings."
          fields={[
            { label: "Application theme", type: "select", options: ["Light", "Dark", "System"] },
            { label: "Display density", type: "select", options: ["Comfortable", "Compact"] },
            { label: "Corner style", type: "select", options: ["Large", "Soft", "Sharp"] },
            { label: "Enable glass effects", type: "checkbox" },
          ]}
          actions={<DesktopAction title="Saving appearance preferences is a Windows desktop workflow."><Save size={13} /> Save appearance</DesktopAction>}
          note="The desktop theme preference is stored on that device. A desktop theme selection is not assumed to be the web user's theme, so all appearance controls are disabled."
        />}

        {activeTab === "shop" && <LocalOnlyPanel
          title="Shop & branding"
          description="Business identity, receipt text, logo, and shop default appearance are stored in the desktop app's local settings, not in the cloud tables used by this workspace."
          fields={[
            { label: "Business name", wide: true },
            { label: "Business address", wide: true },
            { label: "Business phone" },
            { label: "Email" },
            { label: "Website" },
            { label: "Tagline" },
            { label: "Currency (ISO code)" },
            { label: "Receipt footer", wide: true },
            { label: "Return policy", type: "textarea", wide: true },
            { label: "Show logo on receipts", type: "checkbox" },
            { label: "Show tax breakdown", type: "checkbox" },
            { label: "Shop theme", type: "select", options: ["Light", "Dark", "System"] },
            { label: "Density", type: "select", options: ["Comfortable", "Compact"] },
            { label: "Corners", type: "select", options: ["Large", "Soft", "Sharp"] },
            { label: "Enable glass effects for new staff and devices", type: "checkbox", wide: true },
          ]}
          actions={<>
            <DesktopAction title="Uploading a shop logo is a Windows desktop workflow."><Upload size={13} /> Upload logo</DesktopAction>
            <DesktopAction title="Removing the shop logo is a Windows desktop workflow.">Remove</DesktopAction>
            <DesktopAction primary title="Saving shop branding is a Windows desktop workflow."><Save size={13} /> Save settings</DesktopAction>
          </>}
          note="Business identity, receipt text, logo, and shop default appearance are stored in the desktop app's local settings. Nothing is inferred here, and all controls are disabled."
        />}

        {activeTab === "branches" && <section className="card settings-workspace-panel">
          <h2>Branches</h2>
          <p>Only branches returned for this authenticated user's existing access are shown. Branch administration is read-only here.</p>
          <ReadOnlyTable
            headers={["Branch", "Code", "Status", "Address", "Timezone", "Receipt prefix", "Default", "Contact", "Actions"]}
            searchQuery={globalSearch}
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
                <button className="secondary-button" type="button" disabled title="Making a branch default is a Windows desktop workflow.">Make default</button>
                <button className="secondary-button" type="button" disabled title="Editing branches is a Windows desktop workflow."><Pencil size={12} /> Edit</button>
              </div>,
            ])}
            emptyMessage="No branches are available to this account."
          />
          <p className="settings-workspace-note">Address and contact details are shown only when present in the shared branch record. Branch changes are disabled.</p>
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
              searchQuery={globalSearch}
              rows={renderPermissionRows(settings.permissions.modules)}
              emptyMessage="No synced module permission overrides are available."
            />
          </section>
          <section className="card settings-workspace-panel">
            <h2>Online order permissions</h2>
            <ReadOnlyTable
              headers={["Branch", "Role", "Action", "Access"]}
              searchQuery={globalSearch}
              rows={renderPermissionRows(settings.permissions.webOrders)}
              emptyMessage="No synced online-order permission overrides are available."
            />
          </section>
          <section className="card settings-workspace-panel">
            <h2>Inventory permissions</h2>
            <ReadOnlyTable
              headers={["Branch", "Role", "Action", "Access"]}
              searchQuery={globalSearch}
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
                searchQuery={globalSearch}
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
                searchQuery={globalSearch}
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

        {activeTab === "printers" && <LocalOnlyPanel
          title="Printers"
          description="Printer queues, paper width, copies, and auto-print behavior depend on the Windows host and are not synced."
          fields={[
            { label: "Receipt printer", type: "select", options: ["Use system default"] },
            { label: "A4 / report printer", type: "select", options: ["Use system default"] },
            { label: "Barcode tag printer", type: "select", options: ["Use system default"] },
            { label: "Receipt paper width", type: "select", options: ["80 mm", "58 mm"] },
            { label: "Receipt copies", type: "number" },
            { label: "Print receipt automatically after checkout", type: "checkbox", wide: true },
            { label: "Print silently to the selected printer", type: "checkbox", wide: true },
          ]}
          actions={<DesktopAction primary title="Saving printer settings is a Windows desktop workflow."><Save size={13} /> Save settings</DesktopAction>}
          note="Cash-drawer pulse commands are not supported by the current operating-system print integration. Printer queues are local to the Windows host, so all controls are disabled."
        />}

        {activeTab === "scale" && <ScaleSettingsPanel />}

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
              searchQuery={globalSearch}
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
              searchQuery={globalSearch}
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
      <style jsx>{`
        .settings-workspace { display: grid; gap: 14px; }
        .workspace-toolbar { align-items: center; justify-content: space-between; }
        .workspace-toolbar h1 { margin: 0 0 5px; font-size: 20px; }
        .workspace-toolbar p { margin: 0; color: var(--muted); font-size: 12px; }
        .settings-workspace-actions { display: flex; align-items: center; gap: 8px; }
        .settings-workspace-search, .settings-workspace-table-search { display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 9px; padding: 0 10px; color: var(--muted); background: var(--surface); }
        .settings-workspace-search { min-height: 36px; width: min(280px, 42vw); }
        .settings-workspace-search input, .settings-workspace-table-search input { width: 100%; min-width: 0; border: 0; outline: 0; color: var(--ink); background: transparent; font: inherit; font-size: 11px; }
        .settings-workspace-search input { min-height: 34px; }
        .settings-workspace-table { display: grid; gap: 8px; min-width: 0; }
        .settings-workspace-table-search { width: min(260px, 100%); min-height: 32px; }
        .settings-workspace-table-search input { min-height: 30px; }
        .settings-workspace-sort { border: 0; padding: 0; color: inherit; background: transparent; font: inherit; font-weight: inherit; text-align: left; cursor: pointer; }
        .settings-workspace-table-controls { display: flex; align-items: center; justify-content: flex-end; gap: 10px; color: var(--muted); font-size: 10px; }
        .settings-workspace-table-controls label { display: inline-flex; align-items: center; gap: 5px; }
        .settings-workspace-table-controls select, .settings-workspace-table-controls button { min-height: 28px; border: 1px solid var(--line); border-radius: 7px; padding: 0 7px; color: var(--ink); background: var(--surface); font: inherit; }
        .settings-workspace-table-controls button { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
        .settings-workspace-table-controls button:disabled { opacity: .45; cursor: default; }
        .settings-workspace-tabs { display: flex; gap: 6px; overflow-x: auto; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
        .settings-workspace-tabs button { display: inline-flex; min-height: 36px; flex: 0 0 auto; align-items: center; gap: 7px; border: 1px solid transparent; border-radius: 9px; padding: 0 10px; color: var(--muted); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
        .settings-workspace-tabs button:hover, .settings-workspace-tabs button.active { border-color: var(--line); color: var(--green-dark); background: var(--surface); }
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
        .settings-scale-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 10px; }
        .settings-scale-grid .field { margin: 0; }
        @media (max-width: 640px) {
          .settings-workspace-panel { padding: 14px; }
          .settings-workspace-tabs { margin-right: -4px; }
          .settings-workspace-actions { align-items: stretch; }
          .settings-workspace-search { width: 100%; }
          .settings-workspace-table-controls { justify-content: flex-start; flex-wrap: wrap; }
        }
      `}</style>
    </section>
  );
}
