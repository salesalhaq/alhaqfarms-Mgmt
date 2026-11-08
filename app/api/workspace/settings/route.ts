import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertHqAdmin,
  assertBranchAccess,
  assertSameOrigin,
  readBoolean,
  readJsonBody,
  readOptionalText,
  readText,
  readUuid,
  WriteError,
  writeFailure,
} from "@/lib/server/write";
import {
  BRANCH_ACTIONS,
  BRANCH_MODULES,
  INVENTORY_ACTIONS,
  PERMISSION_ROLES,
  WEB_ORDER_ACTIONS,
  defaultActionAccess,
  defaultModuleAccess,
  type BranchModuleId,
  type InventoryActionId,
  type PermissionRole,
  type WebOrderActionId,
} from "@/lib/branch-permissions";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

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

interface ModulePermission {
  branch_id: string;
  role: string;
  permission_key: string;
  is_allowed: boolean;
}

interface ActionPermission {
  branch_id: string;
  role: string;
  action: string;
  is_allowed: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readPermission(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new WriteError(`Choose whether ${label} is allowed.`);
  return value;
}

function readRolePermissions(value: unknown, label: string): Record<PermissionRole, boolean> {
  if (!isRecord(value)) throw new WriteError(`Choose cashier and manager access for ${label}.`);
  return {
    cashier: readPermission(value.cashier, `cashiers can ${label}`),
    manager: readPermission(value.manager, `managers can ${label}`),
  };
}

function latestPermissionRow<T extends { updated_at: string }>(rows: T[]): T | undefined {
  const sorted = [...rows].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return sorted[sorted.length - 1];
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const branchIds = authentication.identity.branches.map((branch) => branch.id);
  const isAdmin = authentication.identity.staff.role === "admin";
  const isHqAdmin = isAdmin && authentication.identity.staff.branch_id === null;
  const settingsClient = authentication.client as unknown as SupabaseClient;

  try {
    const [
      branchResult,
      modulePermissionResult,
      orderPermissionResult,
      inventoryPermissionResult,
      checkoutResult,
      deliveryAreaResult,
    ] = await Promise.all([
      branchIds.length
        ? settingsClient
          .from("branches")
          .select("id,code,name,address,phone,email,timezone,receipt_prefix,is_default,is_active")
          .in("id", branchIds)
          .is("deleted_at", null)
          .order("name", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      isAdmin && branchIds.length
        ? authentication.client
          .from("branch_module_permissions")
          .select("branch_id,role,permission_key,is_allowed,updated_at")
          .is("deleted_at", null)
          .in("branch_id", branchIds)
          .order("updated_at", { ascending: true })
          .order("permission_key", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      isAdmin && branchIds.length
        ? settingsClient
          .from("web_order_permissions")
          .select("branch_id,role,action,is_allowed,updated_at")
          .is("deleted_at", null)
          .in("branch_id", branchIds)
          .order("updated_at", { ascending: true })
          .order("action", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      isAdmin && branchIds.length
        ? settingsClient
          .from("inventory_permissions")
          .select("branch_id,role,action,is_allowed,updated_at")
          .is("deleted_at", null)
          .in("branch_id", branchIds)
          .order("updated_at", { ascending: true })
          .order("action", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      isHqAdmin && branchIds.length
        ? settingsClient
          .from("storefront_cod_settings")
          .select("branch_id,is_active,max_order_amount_paisa")
          .is("deleted_at", null)
          .in("branch_id", branchIds)
          .order("branch_id", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      isHqAdmin && branchIds.length
        ? settingsClient
          .from("storefront_delivery_areas")
          .select("branch_id,area_name,delivery_charge_paisa,free_delivery_threshold_paisa,is_active")
          .is("deleted_at", null)
          .in("branch_id", branchIds)
          .order("branch_id", { ascending: true })
          .order("sort_order", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);

    const queryError = branchResult.error
      || modulePermissionResult.error
      || orderPermissionResult.error
      || inventoryPermissionResult.error
      || checkoutResult.error
      || deliveryAreaResult.error;
    if (queryError) throw new Error(queryError.message);

    return authenticationResponse(request, authentication, {
      profile: {
        email: authentication.identity.staff.email,
        fullName: authentication.identity.staff.full_name,
        role: authentication.identity.staff.role,
        branchId: authentication.identity.staff.branch_id,
      },
      branches: (branchResult.data || []) as BranchSetting[],
      permissions: {
        modules: (modulePermissionResult.data || []) as ModulePermission[],
        webOrders: (orderPermissionResult.data || []) as ActionPermission[],
        inventory: (inventoryPermissionResult.data || []) as ActionPermission[],
      },
      storefront: isHqAdmin ? {
        cashOnDelivery: (checkoutResult.data || []) as CheckoutSetting[],
        deliveryAreas: (deliveryAreaResult.data || []) as DeliveryAreaSetting[],
      } : null,
    });
  } catch (error) {
    console.error("Could not load read-only workspace settings.", error);
    return authenticationResponse(
      request,
      authentication,
      { error: "Settings could not be loaded. Please try again." },
      503,
    );
  }
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    if (body.action === "save_permissions") {
      if (authentication.identity.staff.role !== "admin") {
        throw new WriteError("Only an administrator can manage permissions.", 403);
      }
      const branchId = readUuid(body.branchId, "Branch");
      assertBranchAccess(authentication.identity, branchId);
      if (!isRecord(body.permissions)) throw new WriteError("Provide the permission settings to save.");

      const settingsClient = authentication.client as unknown as SupabaseClient;
      const now = new Date().toISOString();
      const panel = body.panel;

      if (panel === "modules") {
        const matrix = body.permissions;
        if (!isRecord(matrix.modules) || !isRecord(matrix.actions)) {
          throw new WriteError("Provide module and separate-action access for this branch.");
        }
        const modules = matrix.modules;
        const actions = matrix.actions;
        const desired = new Map<string, { role: PermissionRole; key: string; allowed: boolean; defaultAllowed: boolean }>();
        const moduleValues = new Map<BranchModuleId, Record<PermissionRole, { view: boolean; manage: boolean }>>();

        for (const module of BRANCH_MODULES) {
          const roleValues = modules[module.id];
          if (!isRecord(roleValues)) throw new WriteError(`Choose view and manage access for ${module.label}.`);
          const values = {} as Record<PermissionRole, { view: boolean; manage: boolean }>;
          for (const role of PERMISSION_ROLES) {
            const access = roleValues[role];
            if (!isRecord(access)) throw new WriteError(`Choose ${role} access for ${module.label}.`);
            const view = readPermission(access.view, `${role} can view ${module.label}`);
            const manage = readPermission(access.manage, `${role} can manage ${module.label}`);
            if (manage && !view) throw new WriteError(`${role} manage access for ${module.label} also requires view access.`);
            values[role] = { view, manage };
            for (const mode of ["view", "manage"] as const) {
              const allowed = values[role][mode];
              desired.set(`${role}:module:${module.id}:${mode}`, {
                role,
                key: `module:${module.id}:${mode}`,
                allowed,
                defaultAllowed: defaultModuleAccess(module.id, role, mode),
              });
            }
          }
          moduleValues.set(module.id, values);
        }

        for (const action of BRANCH_ACTIONS) {
          const roleValues = actions[action.id];
          const values = readRolePermissions(roleValues, action.label);
          for (const role of PERMISSION_ROLES) {
            if (values[role] && !moduleValues.get(action.moduleId)?.[role].view) {
              const module = BRANCH_MODULES.find((item) => item.id === action.moduleId);
              throw new WriteError(`${role} must have view access to ${module?.label || "the module"} before this action is allowed.`);
            }
            desired.set(`${role}:action:${action.id}`, {
              role,
              key: `action:${action.id}`,
              allowed: values[role],
              defaultAllowed: moduleValues.get(action.moduleId)![role].manage || defaultActionAccess(action.id, role),
            });
          }
        }

        const { data: existing, error: existingError } = await settingsClient
          .from("branch_module_permissions")
          .select("id,role,permission_key,is_allowed,created_at,deleted_at,updated_at")
          .eq("branch_id", branchId);
        if (existingError) throw existingError;
        const tombstoneIds: string[] = [];
        const upserts: Record<string, unknown>[] = [];
        for (const entry of desired.values()) {
          const matching = (existing || []).filter((row) =>
            row.role === entry.role && row.permission_key === entry.key);
          const active = matching.filter((row) => row.deleted_at === null);
          const canonical = latestPermissionRow(active.length ? active : matching);
          if (entry.allowed === entry.defaultAllowed) {
            tombstoneIds.push(...active.map((row) => row.id));
          } else {
            tombstoneIds.push(...active.filter((row) => row.id !== canonical?.id).map((row) => row.id));
            upserts.push({
              id: canonical?.id || crypto.randomUUID(),
              branch_id: branchId,
              role: entry.role,
              permission_key: entry.key,
              is_allowed: entry.allowed,
              created_at: canonical?.created_at || now,
              updated_at: now,
              deleted_at: null,
              server_updated_at: now,
            });
          }
        }
        if (tombstoneIds.length) {
          const { error } = await settingsClient
            .from("branch_module_permissions")
            .update({ deleted_at: now, updated_at: now, server_updated_at: now })
            .in("id", [...new Set(tombstoneIds)]);
          if (error) throw error;
        }
        if (upserts.length) {
          const { error } = await settingsClient
            .from("branch_module_permissions")
            .upsert(upserts, { onConflict: "id" });
          if (error) throw error;
        }
      } else if (panel === "webOrders") {
        const desired = new Map<string, { role: PermissionRole; action: WebOrderActionId; allowed: boolean }>();
        for (const action of WEB_ORDER_ACTIONS) {
          const values = readRolePermissions(body.permissions[action.id], action.label);
          for (const role of PERMISSION_ROLES) {
            desired.set(`${role}:${action.id}`, { role, action: action.id, allowed: values[role] });
          }
        }
        const { data: existing, error: existingError } = await settingsClient
          .from("web_order_permissions")
          .select("id,role,action,is_allowed,deleted_at,updated_at,created_at")
          .eq("branch_id", branchId);
        if (existingError) throw existingError;
        const tombstoneIds: string[] = [];
        const upserts: Record<string, unknown>[] = [];
        for (const entry of desired.values()) {
          const matching = (existing || []).filter((row) =>
            row.role === entry.role && row.action === entry.action);
          const active = matching.filter((row) => row.deleted_at === null);
          const canonical = latestPermissionRow(active.length ? active : matching);
          tombstoneIds.push(...active.filter((row) => row.id !== canonical?.id).map((row) => row.id));
          upserts.push({
            id: canonical?.id || crypto.randomUUID(),
            branch_id: branchId,
            role: entry.role,
            action: entry.action,
            is_allowed: entry.allowed,
            created_at: canonical?.created_at || now,
            updated_at: now,
            deleted_at: null,
            server_updated_at: now,
          });
        }
        if (tombstoneIds.length) {
          const { error } = await settingsClient
            .from("web_order_permissions")
            .update({ deleted_at: now, updated_at: now, server_updated_at: now })
            .in("id", [...new Set(tombstoneIds)]);
          if (error) throw error;
        }
        const { error } = await settingsClient.from("web_order_permissions").upsert(upserts, { onConflict: "id" });
        if (error) throw error;
      } else if (panel === "inventory") {
        const desired = new Map<InventoryActionId, boolean>();
        for (const action of INVENTORY_ACTIONS) {
          desired.set(action.id, readPermission(body.permissions[action.id], `managers can ${action.label.toLowerCase()}`));
        }
        const { data: existing, error: existingError } = await settingsClient
          .from("inventory_permissions")
          .select("id,role,action,is_allowed,deleted_at,updated_at,created_at")
          .eq("branch_id", branchId)
          .eq("role", "manager");
        if (existingError) throw existingError;
        const tombstoneIds: string[] = [];
        const upserts: Record<string, unknown>[] = [];
        for (const [action, allowed] of desired) {
          const matching = (existing || []).filter((row) => row.action === action);
          const active = matching.filter((row) => row.deleted_at === null);
          const canonical = latestPermissionRow(active.length ? active : matching);
          if (!allowed) {
            tombstoneIds.push(...active.map((row) => row.id));
          } else {
            tombstoneIds.push(...active.filter((row) => row.id !== canonical?.id).map((row) => row.id));
            upserts.push({
              id: canonical?.id || crypto.randomUUID(),
              branch_id: branchId,
              role: "manager",
              action,
              is_allowed: true,
              created_at: canonical?.created_at || now,
              updated_at: now,
              deleted_at: null,
              server_updated_at: now,
            });
          }
        }
        if (tombstoneIds.length) {
          const { error } = await settingsClient
            .from("inventory_permissions")
            .update({ deleted_at: now, updated_at: now, server_updated_at: now })
            .in("id", [...new Set(tombstoneIds)]);
          if (error) throw error;
        }
        if (upserts.length) {
          const { error } = await settingsClient
            .from("inventory_permissions")
            .upsert(upserts, { onConflict: "id" });
          if (error) throw error;
        }
      } else {
        throw new WriteError("Choose a valid permission section.");
      }

      return authenticationResponse(request, authentication, { saved: true });
    }

    assertHqAdmin(authentication.identity);

    if (body.action === "save_branch") {
      const mode = readText(body.mode, "Branch action", 10);
      if (mode !== "create" && mode !== "update") throw new WriteError("Choose add or edit for the branch.");
      const branchId = mode === "create"
        ? crypto.randomUUID()
        : readUuid(body.branchId, "Branch");
      if (!body.branch || typeof body.branch !== "object" || Array.isArray(body.branch)) {
        throw new WriteError("Enter the branch details.");
      }
      const input = body.branch as Record<string, unknown>;
      const code = readText(input.code, "Branch code", 20).toUpperCase();
      const name = readText(input.name, "Branch name", 200);
      const address = readOptionalText(input.address, "Address", 300);
      const phone = readOptionalText(input.phone, "Phone", 40);
      const email = readOptionalText(input.email, "Email", 254);
      const timezone = readText(input.timezone, "Timezone", 100);
      const receiptPrefix = readText(input.receiptPrefix, "Receipt prefix", 12).toUpperCase();
      const isActive = readBoolean(input.isActive, "Branch status");
      if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) {
        throw new WriteError("Branch code may contain only letters, numbers, underscores, and hyphens.");
      }
      if (!/^[A-Z0-9_-]+$/.test(receiptPrefix)) {
        throw new WriteError("Receipt prefix may contain only letters, numbers, underscores, and hyphens.");
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new WriteError("Enter a valid branch email address.");
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        throw new WriteError("Enter a valid timezone, such as Asia/Karachi.");
      }

      const branch = {
        code,
        name,
        address,
        phone,
        email,
        timezone,
        receiptPrefix,
        isActive,
      };
      const { data, error } = await authentication.client.rpc("staff_manage_branch", {
        p_action: mode,
        p_branch_id: branchId,
        p_payload: branch,
      });
      if (error) throw error;
      return authenticationResponse(request, authentication, { branch: data });
    }

    if (body.action !== "set_default_branch") {
      return authenticationResponse(request, authentication, { error: "Choose a valid settings action." }, 400);
    }

    const branchId = readUuid(body.branchId, "Branch");
    const { data, error } = await authentication.client.rpc("staff_set_default_branch", {
      p_branch_id: branchId,
    });
    if (error) throw error;

    return authenticationResponse(request, authentication, { branch: data });
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
