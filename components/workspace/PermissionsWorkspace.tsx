"use client";

import { useEffect, useMemo, useState } from "react";
import { Save } from "lucide-react";
import {
  BRANCH_ACTIONS,
  BRANCH_MODULES,
  INVENTORY_ACTIONS,
  PERMISSION_ROLES,
  WEB_ORDER_ACTIONS,
  defaultActionAccess,
  defaultModuleAccess,
  type BranchActionId,
  type BranchModuleId,
  type InventoryActionId,
  type PermissionRole,
  type WebOrderActionId,
} from "@/lib/branch-permissions";

interface Branch {
  id: string;
  name: string;
  is_active: boolean;
  is_default: boolean;
}

interface PermissionRow {
  branch_id: string;
  role: string;
  is_allowed: boolean;
  updated_at?: string;
  permission_key?: string;
  action?: string;
}

interface PermissionRows {
  modules: PermissionRow[];
  webOrders: PermissionRow[];
  inventory: PermissionRow[];
}

interface ModuleAccess {
  view: boolean;
  manage: boolean;
}

interface PermissionDraft {
  modules: Record<BranchModuleId, Record<PermissionRole, ModuleAccess>>;
  actions: Record<BranchActionId, Record<PermissionRole, boolean>>;
  webOrders: Record<WebOrderActionId, Record<PermissionRole, boolean>>;
  inventory: Record<InventoryActionId, boolean>;
}

type PermissionPanel = "modules" | "webOrders" | "inventory";
type PanelFeedback = { busy: boolean; error: string | null; success: string | null };
type FeedbackState = Record<PermissionPanel, PanelFeedback>;

const EMPTY_FEEDBACK: FeedbackState = {
  modules: { busy: false, error: null, success: null },
  webOrders: { busy: false, error: null, success: null },
  inventory: { busy: false, error: null, success: null },
};

function buildDraft(branchId: string, rows: PermissionRows): PermissionDraft {
  const moduleRows = rows.modules.filter((row) => row.branch_id === branchId);
  const latest = (matching: PermissionRow[]) => matching.sort(
    (a, b) => (a.updated_at || "").localeCompare(b.updated_at || ""),
  )[matching.length - 1];
  const moduleAccess = {} as PermissionDraft["modules"];
  for (const module of BRANCH_MODULES) {
    moduleAccess[module.id] = {} as Record<PermissionRole, ModuleAccess>;
    for (const role of PERMISSION_ROLES) {
      const readOverride = latest(moduleRows.filter((row) =>
        row.role === role && row.permission_key === `module:${module.id}:view`));
      const manageOverride = latest(moduleRows.filter((row) =>
        row.role === role && row.permission_key === `module:${module.id}:manage`));
      const view = readOverride?.is_allowed ?? defaultModuleAccess(module.id, role, "view");
      moduleAccess[module.id][role] = {
        view,
        manage: view && (manageOverride?.is_allowed ?? defaultModuleAccess(module.id, role, "manage")),
      };
    }
  }

  const actionRows = moduleRows;
  const actionAccess = {} as PermissionDraft["actions"];
  for (const action of BRANCH_ACTIONS) {
    actionAccess[action.id] = {} as Record<PermissionRole, boolean>;
    for (const role of PERMISSION_ROLES) {
      const override = latest(actionRows.filter((row) =>
        row.role === role && row.permission_key === `action:${action.id}`));
      actionAccess[action.id][role] = moduleAccess[action.moduleId][role].view && (
        override?.is_allowed ?? (moduleAccess[action.moduleId][role].manage || defaultActionAccess(action.id, role))
      );
    }
  }

  const orderRows = rows.webOrders.filter((row) => row.branch_id === branchId);
  const webOrders = {} as PermissionDraft["webOrders"];
  for (const action of WEB_ORDER_ACTIONS) {
    webOrders[action.id] = {} as Record<PermissionRole, boolean>;
    for (const role of PERMISSION_ROLES) {
      const override = latest(orderRows.filter((row) => row.role === role && row.action === action.id));
      webOrders[action.id][role] = override?.is_allowed ?? true;
    }
  }

  const inventoryRows = rows.inventory.filter((row) => row.branch_id === branchId);
  const inventory = {} as PermissionDraft["inventory"];
  for (const action of INVENTORY_ACTIONS) {
    const override = latest(inventoryRows.filter((row) => row.role === "manager" && row.action === action.id));
    inventory[action.id] = override?.is_allowed ?? false;
  }

  return { modules: moduleAccess, actions: actionAccess, webOrders, inventory };
}

function PermissionCheckbox({
  checked,
  label,
  displayLabel,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  displayLabel?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-permission-checkbox">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{displayLabel || (checked ? "Allowed" : "Blocked")}</span>
    </label>
  );
}

export function PermissionsWorkspace({
  branches,
  permissions,
  onSaved,
}: {
  branches: Branch[];
  permissions: PermissionRows;
  onSaved: () => void;
}) {
  const availableBranches = useMemo(() => branches.filter((branch) => branch.is_active), [branches]);
  const [branchId, setBranchId] = useState("");
  const [draft, setDraft] = useState<PermissionDraft | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>(EMPTY_FEEDBACK);

  useEffect(() => {
    const initialBranch = availableBranches.find((branch) => branch.is_default) || availableBranches[0];
    setBranchId((current) => availableBranches.some((branch) => branch.id === current)
      ? current
      : initialBranch?.id || "");
  }, [availableBranches]);

  useEffect(() => {
    setDraft(branchId ? buildDraft(branchId, permissions) : null);
  }, [branchId, permissions]);

  const updateModuleAccess = (
    moduleId: BranchModuleId,
    role: PermissionRole,
    mode: "view" | "manage",
    allowed: boolean,
  ) => {
    setDraft((current) => {
      if (!current) return current;
      const currentAccess = current.modules[moduleId][role];
      const nextView = mode === "view" ? allowed : currentAccess.view || allowed;
      const nextManage = mode === "manage" ? allowed && nextView : currentAccess.manage && nextView;
      const actions = { ...current.actions };
      if (!nextView) {
        for (const action of BRANCH_ACTIONS) {
          if (action.moduleId === moduleId) {
            actions[action.id] = { ...actions[action.id], [role]: false };
          }
        }
      }
      return {
        ...current,
        modules: {
          ...current.modules,
          [moduleId]: {
            ...current.modules[moduleId],
            [role]: { view: nextView, manage: nextManage },
          },
        },
        actions,
      };
    });
  };

  const save = async (panel: PermissionPanel, value: unknown) => {
    if (!branchId) return;
    setFeedback((current) => ({
      ...current,
      [panel]: { busy: true, error: null, success: null },
    }));
    try {
      const response = await fetch("/api/workspace/settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_permissions", panel, branchId, permissions: value }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Permissions could not be saved.");
      setFeedback((current) => ({
        ...current,
        [panel]: { busy: false, error: null, success: "Permissions saved." },
      }));
      onSaved();
    } catch (saveError) {
      setFeedback((current) => ({
        ...current,
        [panel]: {
          busy: false,
          error: saveError instanceof Error ? saveError.message : "Permissions could not be saved.",
          success: null,
        },
      }));
    }
  };

  const panelStatus = (panel: PermissionPanel) => (
    <>
      {feedback[panel].error && <p className="error-banner" role="alert">{feedback[panel].error}</p>}
      {feedback[panel].success && <p className="notice info" role="status">{feedback[panel].success}</p>}
    </>
  );

  if (!availableBranches.length) {
    return (
      <section className="card settings-workspace-panel settings-permission-panel">
        <h2>Permissions</h2>
        <p>No active branches are available for permission management.</p>
      </section>
    );
  }

  return (
    <>
      <section className="card settings-workspace-panel settings-permission-panel">
        <h2>Permission branch</h2>
        <p>Changes apply only to the selected branch. Administrators retain full access.</p>
        <label className="settings-permission-branch">
          <span>Branch</span>
          <select value={branchId} onChange={(event) => {
            setBranchId(event.target.value);
            setFeedback(EMPTY_FEEDBACK);
          }}>
            {availableBranches.map((branch) => (
              <option key={branch.id} value={branch.id}>{branch.name}{branch.is_default ? " (default)" : ""}</option>
            ))}
          </select>
        </label>
      </section>

      {draft && <>
        <section className="card settings-workspace-panel settings-permission-panel">
          <h2>Online order permissions</h2>
          <p>Choose which cashier and manager actions are allowed. Missing overrides follow the Windows app defaults.</p>
          {panelStatus("webOrders")}
          <div className="table-wrap">
            <table className="workspace-table settings-permission-table">
              <thead><tr><th>Order action</th><th>Cashier</th><th>Manager</th></tr></thead>
              <tbody>
                {WEB_ORDER_ACTIONS.map((action) => (
                  <tr key={action.id}>
                    <th scope="row">{action.label}</th>
                    {PERMISSION_ROLES.map((role) => (
                      <td key={role}>
                        <PermissionCheckbox
                          checked={draft.webOrders[action.id][role]}
                          label={`${role} access to ${action.label.toLowerCase()}`}
                          onChange={(allowed) => setDraft((current) => current && ({
                            ...current,
                            webOrders: {
                              ...current.webOrders,
                              [action.id]: { ...current.webOrders[action.id], [role]: allowed },
                            },
                          }))}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="heading-actions">
            <button type="button" className="primary-button" disabled={feedback.webOrders.busy} onClick={() => void save("webOrders", draft.webOrders)}>
              <Save size={13} /> {feedback.webOrders.busy ? "Saving…" : "Save order permissions"}
            </button>
          </div>
        </section>

        <section className="card settings-workspace-panel settings-permission-panel">
          <h2>Branch module permissions</h2>
          <p>Control module visibility, management access, and separate actions for cashier and manager roles.</p>
          {panelStatus("modules")}
          <div className="table-wrap">
            <table className="workspace-table settings-permission-table">
              <thead>
                <tr>
                  <th scope="col" rowSpan={2}>Module</th>
                  {PERMISSION_ROLES.map((role) => <th scope="colgroup" colSpan={2} key={role}>{role === "cashier" ? "Cashier" : "Manager"}</th>)}
                </tr>
                <tr>
                  {PERMISSION_ROLES.flatMap((role) => [
                    <th scope="col" key={`${role}-view`}>View</th>,
                    <th scope="col" key={`${role}-manage`}>Manage</th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {BRANCH_MODULES.map((module) => (
                  <tr key={module.id}>
                    <th scope="row">{module.label}</th>
                    {PERMISSION_ROLES.flatMap((role) => (["view", "manage"] as const).map((mode) => (
                      <td key={`${role}-${mode}`}>
                        <PermissionCheckbox
                          checked={draft.modules[module.id][role][mode]}
                          label={`${role} ${mode} access to ${module.label}`}
                          disabled={mode === "manage" && !draft.modules[module.id][role].view}
                          onChange={(allowed) => updateModuleAccess(module.id, role, mode, allowed)}
                        />
                      </td>
                    )))}
                  </tr>
                ))}
                <tr><th scope="row" colSpan={5}>Separate actions</th></tr>
                {BRANCH_ACTIONS.map((action) => (
                  <tr key={action.id}>
                    <th scope="row">{action.label}</th>
                    {PERMISSION_ROLES.map((role) => (
                      <td key={role} colSpan={2}>
                        <PermissionCheckbox
                          checked={draft.actions[action.id][role]}
                          label={`${role} access to ${action.label.toLowerCase()}`}
                          disabled={!draft.modules[action.moduleId][role].view}
                          onChange={(allowed) => setDraft((current) => current && ({
                            ...current,
                            actions: {
                              ...current.actions,
                              [action.id]: { ...current.actions[action.id], [role]: allowed },
                            },
                          }))}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="heading-actions">
            <button type="button" className="primary-button" disabled={feedback.modules.busy} onClick={() => void save("modules", { modules: draft.modules, actions: draft.actions })}>
              <Save size={13} /> {feedback.modules.busy ? "Saving…" : "Save module permissions"}
            </button>
          </div>
        </section>

        <section className="card settings-workspace-panel settings-permission-panel">
          <h2>Manager inventory permissions</h2>
          <p>These controls apply to manager inventory operations for the selected branch.</p>
          {panelStatus("inventory")}
          <div className="settings-permission-inventory">
            {INVENTORY_ACTIONS.map((action) => (
              <PermissionCheckbox
                key={action.id}
                checked={draft.inventory[action.id]}
                label={action.label}
                displayLabel={action.label}
                onChange={(allowed) => setDraft((current) => current && ({
                  ...current,
                  inventory: { ...current.inventory, [action.id]: allowed },
                }))}
              />
            ))}
          </div>
          <div className="heading-actions">
            <button type="button" className="primary-button" disabled={feedback.inventory.busy} onClick={() => void save("inventory", draft.inventory)}>
              <Save size={13} /> {feedback.inventory.busy ? "Saving…" : "Save inventory permissions"}
            </button>
          </div>
        </section>
      </>}
    </>
  );
}
