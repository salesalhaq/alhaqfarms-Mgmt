import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertHqAdmin,
  assertSameOrigin,
  readJsonBody,
  readUuid,
  writeFailure,
} from "@/lib/server/write";
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
          .select("branch_id,role,permission_key,is_allowed")
          .is("deleted_at", null)
          .in("branch_id", branchIds)
          .order("permission_key", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      isAdmin && branchIds.length
        ? settingsClient
          .from("web_order_permissions")
          .select("branch_id,role,action,is_allowed")
          .is("deleted_at", null)
          .in("branch_id", branchIds)
          .order("action", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      isAdmin && branchIds.length
        ? settingsClient
          .from("inventory_permissions")
          .select("branch_id,role,action,is_allowed")
          .is("deleted_at", null)
          .in("branch_id", branchIds)
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
    assertHqAdmin(authentication.identity);
    const body = await readJsonBody(request);
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
