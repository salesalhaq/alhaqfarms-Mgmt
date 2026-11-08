import { DEFAULT_BRANCH_FBR_SETTINGS, DEFAULT_BRANCH_POS_SETTINGS, parseBranchPosSettings } from "@/lib/branch-pos-settings";
import {
  decryptFbrCredentials,
  encryptFbrCredentials,
  type FbrCredentials,
} from "@/lib/server/fbr-credentials";
import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import {
  assertBranchAccess,
  assertSameOrigin,
  readBoolean,
  readEnum,
  readInteger,
  readJsonBody,
  readText,
  writeFailure,
  WriteError,
} from "@/lib/server/write";
import { getServerEnvironment } from "@/lib/supabase/server-environment";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canManageBranchSettings(request: Request, authentication: Awaited<ReturnType<typeof authenticateStaff>>) {
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (authentication.identity.staff.role !== "admin") {
    return authenticationResponse(request, authentication, { error: "Only an administrator can manage branch tax settings." }, 403);
  }
  return null;
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  const branchId = new URL(request.url).searchParams.get("branchId") || "";
  if (!isUuid(branchId)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }
  if (!authentication.identity.branches.some((branch) => branch.id === branchId)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  try {
    const [{ data: posRow, error: posError }, canManage] = await Promise.all([
      authentication.client.from("branch_pos_settings").select("*").eq("branch_id", branchId).maybeSingle(),
      Promise.resolve(authentication.identity.staff.role === "admin"),
    ]);
    if (posError) throw posError;

    let fbrSettings: typeof DEFAULT_BRANCH_FBR_SETTINGS | null = null;
    let encryptionConfigured = false;
    if (canManage) {
      const { data: fbrRow, error: fbrError } = await authentication.client
        .from("branch_fbr_settings")
        .select("*")
        .eq("branch_id", branchId)
        .maybeSingle();
      if (fbrError) throw fbrError;
      const encrypted = fbrRow?.credentials_encrypted;
      const credentials = await decryptFbrCredentials(encrypted);
      const environment = await getServerEnvironment();
      encryptionConfigured = /^[0-9a-f]{64}$/i.test(environment.FBR_CONFIG_ENCRYPTION_KEY?.trim() || "");
      fbrSettings = fbrRow ? {
        environment: fbrRow.environment as typeof DEFAULT_BRANCH_FBR_SETTINGS.environment,
        baseUrl: fbrRow.base_url,
        registrationNumber: fbrRow.registration_number,
        posId: fbrRow.pos_id,
        paymentMode: fbrRow.payment_mode,
        clientId: fbrRow.client_id,
        enabled: fbrRow.enabled,
        hasUsername: Boolean(credentials.username),
        hasPassword: Boolean(credentials.password),
        hasApiKey: Boolean(credentials.apiKey),
      } : { ...DEFAULT_BRANCH_FBR_SETTINGS };
    }

    return authenticationResponse(request, authentication, {
      posSettings: posRow ? parseBranchPosSettings(posRow) : { ...DEFAULT_BRANCH_POS_SETTINGS },
      fbrSettings,
      encryptionConfigured,
    });
  } catch (error) {
    console.error("Could not load branch tax settings.", error);
    return authenticationResponse(
      request,
      authentication,
      { error: error instanceof Error ? error.message : "Branch tax settings could not be loaded." },
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
    const denied = canManageBranchSettings(request, authentication);
    if (denied) return denied;

    const body = await readJsonBody(request);
    const branchId = typeof body.branchId === "string" ? body.branchId : "";
    if (!isUuid(branchId)) throw new WriteError("Choose a valid branch.");
    assertBranchAccess(authentication.identity, branchId);
    const branch = authentication.identity.branches.find((item) => item.id === branchId && item.is_active);
    if (!branch) throw new WriteError("Choose an active branch.");

    if (body.action === "save_pos") {
      if (!isRecord(body.settings)) throw new WriteError("Provide the branch tax settings to save.");
      const settings = parseBranchPosSettings({
        tax_mode: body.settings.taxMode,
        tax_rate_bps: readInteger(body.settings.taxRateBps, "Tax rate", { minimum: 0, maximum: 10_000 }),
        tax_rounding_scope: body.settings.taxRoundingScope,
        tax_rounding_method: body.settings.taxRoundingMethod,
        tax_rounding_increment_paisa: readInteger(body.settings.taxRoundingIncrementPaisa, "Tax rounding increment", { minimum: 1, maximum: 100 }),
        tax_display: body.settings.taxDisplay,
        max_item_discount_bps: readInteger(body.settings.maxItemDiscountBps, "Maximum item discount", { minimum: 0, maximum: 10_000 }),
        max_bill_discount_bps: readInteger(body.settings.maxBillDiscountBps, "Maximum bill discount", { minimum: 0, maximum: 10_000 }),
        loyalty_points_per_100: readInteger(body.settings.loyaltyPointsPer100, "Loyalty points per PKR 100", { minimum: 0, maximum: 10_000 }),
        loyalty_point_value_paisa: readInteger(body.settings.loyaltyPointValuePaisa, "Loyalty point value", { minimum: 1, maximum: 1_000_000 }),
        low_stock_threshold: readInteger(body.settings.lowStockThreshold, "Low stock threshold", { minimum: 0, maximum: 1_000_000 }),
        allow_negative_stock: readBoolean(body.settings.allowNegativeStock, "Negative stock"),
      });
      if (settings.taxRoundingIncrementPaisa !== body.settings.taxRoundingIncrementPaisa) {
        throw new WriteError("Choose a supported tax rounding increment.");
      }

      const { data, error } = await authentication.client.from("branch_pos_settings").upsert({
        branch_id: branchId,
        tax_mode: settings.taxMode,
        tax_rate_bps: settings.taxRateBps,
        tax_rounding_scope: settings.taxRoundingScope,
        tax_rounding_method: settings.taxRoundingMethod,
        tax_rounding_increment_paisa: settings.taxRoundingIncrementPaisa,
        tax_display: settings.taxDisplay,
        max_item_discount_bps: settings.maxItemDiscountBps,
        max_bill_discount_bps: settings.maxBillDiscountBps,
        loyalty_points_per_100: settings.loyaltyPointsPer100,
        loyalty_point_value_paisa: settings.loyaltyPointValuePaisa,
        low_stock_threshold: settings.lowStockThreshold,
        allow_negative_stock: settings.allowNegativeStock,
        updated_at: new Date().toISOString(),
        updated_by: authentication.identity.staff.user_id,
      }, { onConflict: "branch_id" }).select("*").single();
      if (error) throw error;
      return authenticationResponse(request, authentication, { posSettings: parseBranchPosSettings(data) });
    }

    if (body.action === "save_fbr") {
      if (!isRecord(body.settings) || !isRecord(body.credentials)) {
        throw new WriteError("Provide FBR configuration and credentials.");
      }
      const environment = readEnum(body.settings.environment, "FBR environment", ["sandbox", "production"] as const);
      const baseUrl = typeof body.settings.baseUrl === "string" ? body.settings.baseUrl.trim() : "";
      if (baseUrl) {
        try {
          if (new URL(baseUrl).protocol !== "https:") throw new Error();
        } catch {
          throw new WriteError("FBR API base URL must be a valid HTTPS address.");
        }
      }
      const registrationNumber = typeof body.settings.registrationNumber === "string"
        ? body.settings.registrationNumber.trim() : "";
      const posId = typeof body.settings.posId === "string" ? body.settings.posId.trim() : "";
      const clientId = typeof body.settings.clientId === "string" ? body.settings.clientId.trim() : "";
      if (registrationNumber.length > 100 || posId.length > 100 || clientId.length > 200) {
        throw new WriteError("FBR configuration contains a value that is too long.");
      }
      const paymentMode = readInteger(body.settings.paymentMode, "Payment mode code", { minimum: 0, maximum: 2_147_483_647 });
      const enabled = readBoolean(body.settings.enabled, "FBR enabled status");
      const username = optionalCredential(body.credentials.username, "API username");
      const password = optionalCredential(body.credentials.password, "API password");
      const apiKey = optionalCredential(body.credentials.apiKey, "API key");
      const clearPassword = readBoolean(body.credentials.clearPassword, "Clear password");
      const clearApiKey = readBoolean(body.credentials.clearApiKey, "Clear API key");

      const { data: existing, error: existingError } = await authentication.client
        .from("branch_fbr_settings")
        .select("credentials_encrypted")
        .eq("branch_id", branchId)
        .maybeSingle();
      if (existingError) throw existingError;
      const previous = await decryptFbrCredentials(existing?.credentials_encrypted);
      const credentials: FbrCredentials = {
        username: username || previous.username,
        password: clearPassword ? "" : password || previous.password,
        apiKey: clearApiKey ? "" : apiKey || previous.apiKey,
      };
      const credentialsEncrypted = await encryptFbrCredentials(credentials);

      const { error } = await authentication.client.from("branch_fbr_settings").upsert({
        branch_id: branchId,
        environment,
        base_url: baseUrl,
        registration_number: registrationNumber,
        pos_id: posId,
        payment_mode: paymentMode,
        client_id: clientId,
        enabled,
        credentials_encrypted: credentialsEncrypted,
        updated_at: new Date().toISOString(),
        updated_by: authentication.identity.staff.user_id,
      }, { onConflict: "branch_id" });
      if (error) throw error;
      return authenticationResponse(request, authentication, {
        success: true,
        fbrSettings: {
          environment,
          baseUrl,
          registrationNumber,
          posId,
          paymentMode,
          clientId,
          enabled,
          hasUsername: Boolean(credentials.username),
          hasPassword: Boolean(credentials.password),
          hasApiKey: Boolean(credentials.apiKey),
        },
      });
    }

    throw new WriteError("Choose a supported tax-settings action.");
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}

function optionalCredential(value: unknown, label: string): string {
  if (value === undefined || value === null || value === "") return "";
  return readText(value, label, 2_000);
}
