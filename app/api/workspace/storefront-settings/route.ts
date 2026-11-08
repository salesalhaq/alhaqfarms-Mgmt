import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertHqAdmin,
  assertSameOrigin,
  readBoolean,
  readInteger,
  readJsonBody,
  readOptionalText,
  readText,
  readUuid,
  WriteError,
  writeFailure,
} from "@/lib/server/write";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const PAYMENT_METHODS = ["easypaisa", "jazzcash"] as const;
const MAX_QR_DATA_URL_LENGTH = 2_900_000;

function assertBranchAccess(authentication: Extract<Awaited<ReturnType<typeof authenticateStaff>>, { ok: true }>, branchId: string) {
  if (!authentication.identity.branches.some((branch) => branch.id === branchId)) {
    throw new WriteError("You cannot change storefront settings for that branch.", 403);
  }
}

function readPaisa(value: unknown, label: string, optional = false): number | null {
  if (optional && (value === null || value === "" || value === undefined)) return null;
  return readInteger(value, label, { minimum: 0, maximum: 9_000_000_000_000 });
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertHqAdmin(authentication.identity);
    const branchIds = authentication.identity.branches.map(({ id }) => id);
    if (!branchIds.length) {
      return authenticationResponse(request, authentication, {
        deliveryAreas: [],
        codSettings: [],
        codAreas: [],
        paymentAccounts: [],
      });
    }

    const client = authentication.client as unknown as SupabaseClient;
    const [deliveryAreas, codSettings, codAreas, paymentAccounts] = await Promise.all([
      client.from("storefront_delivery_areas")
        .select("id,branch_id,area_name,delivery_charge_paisa,free_delivery_threshold_paisa,sort_order,is_active")
        .in("branch_id", branchIds).is("deleted_at", null).order("sort_order").order("area_name"),
      client.from("storefront_cod_settings")
        .select("id,branch_id,is_active,max_order_amount_paisa,notes")
        .in("branch_id", branchIds).is("deleted_at", null),
      client.from("storefront_cod_areas")
        .select("id,branch_id,cod_setting_id,delivery_area_id,is_active")
        .in("branch_id", branchIds).is("deleted_at", null),
      client.from("storefront_payment_accounts")
        .select("id,payment_method,account_title,account_number,instructions,qr_code_data_url,is_active")
        .is("deleted_at", null),
    ]);
    const queryError = deliveryAreas.error || codSettings.error || codAreas.error || paymentAccounts.error;
    if (queryError) throw queryError;

    return authenticationResponse(request, authentication, {
      deliveryAreas: deliveryAreas.data || [],
      codSettings: codSettings.data || [],
      codAreas: codAreas.data || [],
      paymentAccounts: paymentAccounts.data || [],
    });
  } catch (error) {
    console.error("Could not load storefront checkout settings.", error);
    return authenticationResponse(
      request,
      authentication,
      { error: "Storefront checkout settings could not be loaded. Please try again." },
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
    const body = await readJsonBody(request, 4 * 1024 * 1024);
    const client = authentication.client as unknown as SupabaseClient;
    const now = new Date().toISOString();
    const action = readText(body.action, "Action", 40);

    if (action === "save_delivery_area") {
      const branchId = readUuid(body.branchId, "Branch");
      assertBranchAccess(authentication, branchId);
      const areaName = readText(body.areaName, "Area name", 120);
      const deliveryCharge = readPaisa(body.deliveryChargePaisa, "Delivery charge");
      const freeThreshold = readPaisa(body.freeDeliveryThresholdPaisa, "Free-delivery threshold");
      const sortOrder = readInteger(body.sortOrder, "Display order", { minimum: 0, maximum: 100_000 });
      const isActive = readBoolean(body.isActive, "Area status");
      const id = body.id ? readUuid(body.id, "Delivery area") : crypto.randomUUID();
      const query = body.id
        ? client.from("storefront_delivery_areas").update({
          area_name: areaName,
          delivery_charge_paisa: deliveryCharge,
          free_delivery_threshold_paisa: freeThreshold,
          sort_order: sortOrder,
          is_active: isActive,
          updated_at: now,
        }).eq("id", id).eq("branch_id", branchId).is("deleted_at", null)
        : client.from("storefront_delivery_areas").insert({
          id,
          branch_id: branchId,
          area_name: areaName,
          delivery_charge_paisa: deliveryCharge,
          free_delivery_threshold_paisa: freeThreshold,
          sort_order: sortOrder,
          is_active: isActive,
        });
      const { error } = await query;
      if (error) throw error;
    } else if (action === "delete_delivery_area" || action === "set_delivery_area_active") {
      const id = readUuid(body.id, "Delivery area");
      const branchId = readUuid(body.branchId, "Branch");
      assertBranchAccess(authentication, branchId);
      const changes = action === "delete_delivery_area"
        ? { deleted_at: now, updated_at: now }
        : { is_active: readBoolean(body.isActive, "Area status"), updated_at: now };
      const { error } = await client.from("storefront_delivery_areas").update(changes)
        .eq("id", id).eq("branch_id", branchId).is("deleted_at", null);
      if (error) throw error;
    } else if (action === "save_cod_settings") {
      const branchId = readUuid(body.branchId, "Branch");
      assertBranchAccess(authentication, branchId);
      const changes = {
        is_active: readBoolean(body.isActive, "COD status"),
        max_order_amount_paisa: readPaisa(body.maxOrderAmountPaisa, "COD order limit", true),
        notes: readOptionalText(body.notes, "Notes", 500),
        updated_at: now,
      };
      const id = body.id ? readUuid(body.id, "COD setting") : null;
      const query = id
        ? client.from("storefront_cod_settings").update(changes)
          .eq("id", id).eq("branch_id", branchId).is("deleted_at", null)
        : client.from("storefront_cod_settings").insert({
          id: crypto.randomUUID(),
          branch_id: branchId,
          ...changes,
        });
      const { error } = await query;
      if (error) throw error;
    } else if (action === "delete_cod_settings") {
      const id = readUuid(body.id, "COD setting");
      const branchId = readUuid(body.branchId, "Branch");
      assertBranchAccess(authentication, branchId);
      const { error } = await client.from("storefront_cod_settings")
        .update({ deleted_at: now, updated_at: now })
        .eq("id", id).eq("branch_id", branchId).is("deleted_at", null);
      if (error) throw error;
      const { error: areaError } = await client.from("storefront_cod_areas")
        .update({ deleted_at: now, updated_at: now })
        .eq("cod_setting_id", id).eq("branch_id", branchId).is("deleted_at", null);
      if (areaError) throw areaError;
    } else if (action === "set_cod_area") {
      const branchId = readUuid(body.branchId, "Branch");
      assertBranchAccess(authentication, branchId);
      const deliveryAreaId = readUuid(body.deliveryAreaId, "Delivery area");
      const { data: area, error: areaError } = await client.from("storefront_delivery_areas")
        .select("id").eq("id", deliveryAreaId).eq("branch_id", branchId)
        .is("deleted_at", null).maybeSingle();
      if (areaError) throw areaError;
      if (!area) throw new WriteError("Choose a delivery area for the selected branch.");
      const { data: codSetting, error: codError } = await client.from("storefront_cod_settings")
        .select("id").eq("branch_id", branchId).is("deleted_at", null).maybeSingle();
      if (codError) throw codError;
      if (!codSetting) throw new WriteError("Save COD settings before choosing eligible delivery areas.");
      const isActive = readBoolean(body.isActive, "COD eligibility");
      const { data: existing, error: existingError } = await client.from("storefront_cod_areas")
        .select("id").eq("cod_setting_id", codSetting.id).eq("delivery_area_id", deliveryAreaId)
        .is("deleted_at", null).maybeSingle();
      if (existingError) throw existingError;
      if (existing) {
        const { error } = await client.from("storefront_cod_areas").update({
          is_active: isActive,
          updated_at: now,
        }).eq("id", existing.id);
        if (error) throw error;
      } else if (isActive) {
        const { error } = await client.from("storefront_cod_areas").insert({
          id: crypto.randomUUID(),
          branch_id: branchId,
          cod_setting_id: codSetting.id,
          delivery_area_id: deliveryAreaId,
          is_active: true,
        });
        if (error) throw error;
      }
    } else if (action === "remove_cod_area") {
      const id = readUuid(body.id, "COD delivery area");
      const branchId = readUuid(body.branchId, "Branch");
      assertBranchAccess(authentication, branchId);
      const { error } = await client.from("storefront_cod_areas")
        .update({ deleted_at: now, updated_at: now })
        .eq("id", id).eq("branch_id", branchId).is("deleted_at", null);
      if (error) throw error;
    } else if (action === "save_payment_account") {
      const paymentMethod = readText(body.paymentMethod, "Payment method", 20);
      if (!PAYMENT_METHODS.includes(paymentMethod as (typeof PAYMENT_METHODS)[number])) {
        throw new WriteError("Choose EasyPaisa or JazzCash.");
      }
      const accountTitle = readText(body.accountTitle, "Account title", 160);
      const accountNumber = readText(body.accountNumber, "Account number", 80);
      const instructions = readOptionalText(body.instructions, "Checkout instructions", 500);
      const qrCodeDataUrl = readOptionalText(body.qrCodeDataUrl, "QR image", MAX_QR_DATA_URL_LENGTH);
      if (qrCodeDataUrl && !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(qrCodeDataUrl)) {
        throw new WriteError("Choose a supported image for the payment QR code.");
      }
      const changes = {
        payment_method: paymentMethod,
        account_title: accountTitle,
        account_number: accountNumber,
        instructions,
        qr_code_data_url: qrCodeDataUrl,
        is_active: readBoolean(body.isActive, "Payment account status"),
        updated_at: now,
      };
      const id = body.id ? readUuid(body.id, "Payment account") : null;
      const query = id
        ? client.from("storefront_payment_accounts").update(changes)
          .eq("id", id).is("deleted_at", null)
        : client.from("storefront_payment_accounts").insert({ id: crypto.randomUUID(), ...changes });
      const { error } = await query;
      if (error) throw error;
    } else if (action === "delete_payment_account") {
      const id = readUuid(body.id, "Payment account");
      const { error } = await client.from("storefront_payment_accounts")
        .update({ deleted_at: now, updated_at: now })
        .eq("id", id).is("deleted_at", null);
      if (error) throw error;
    } else {
      throw new WriteError("Choose a valid storefront settings action.");
    }

    return authenticationResponse(request, authentication, { success: true });
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
