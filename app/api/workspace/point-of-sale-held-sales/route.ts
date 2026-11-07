import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertBranchAccess,
  assertSameOrigin,
  readEnum,
  readInteger,
  readJsonBody,
  readOptionalText,
  readUuid,
  writeFailure,
} from "@/lib/server/write";
import type { Json } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

const ACTIONS = ["list", "save", "resume", "delete"] as const;
const PAYMENT_METHODS = ["cash", "card", "jazzcash", "easypaisa", "other", "credit"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const action = readEnum(body.action, "Held sale action", ACTIONS);
    const branchId = readUuid(body.branchId, "Branch");
    assertBranchAccess(authentication.identity, branchId);
    const payload: { [key: string]: Json | undefined } = { branchId };

    if (action === "save") {
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 200) {
        throw new Error("A held sale must contain between 1 and 200 product lines.");
      }
      if (!Array.isArray(body.payments) || body.payments.length < 1 || body.payments.length > 10) {
        throw new Error("A held sale must contain between 1 and 10 payment methods.");
      }
      payload.items = body.items.map((entry) => {
        if (!isRecord(entry)) throw new Error("A held sale product is invalid.");
        return {
          productId: readUuid(entry.productId, "Product"),
          quantityMilli: readInteger(entry.quantityMilli, "Quantity", { minimum: 1, maximum: 99_999 }),
        };
      });
      payload.payments = body.payments.map((entry) => {
        if (!isRecord(entry)) throw new Error("A held sale payment is invalid.");
        return {
          method: readEnum(entry.method, "Payment method", PAYMENT_METHODS),
          amount: readOptionalText(entry.amount, "Payment amount", 15) || "",
          tendered: readOptionalText(entry.tendered, "Cash received", 15) || "",
          reference: readOptionalText(entry.reference, "Payment reference", 100) || "",
        };
      });
      payload.billDiscountPaisa = readInteger(body.billDiscountPaisa ?? 0, "Bill discount", { minimum: 0 });
      payload.taxMode = readEnum(body.taxMode ?? "inclusive", "Tax mode", ["inclusive", "exclusive"] as const);
      if (body.customerAccountId !== undefined && body.customerAccountId !== null) {
        payload.customerAccountId = readUuid(body.customerAccountId, "Customer account");
      }
      payload.loyaltyPointsRedeemed = readInteger(body.loyaltyPointsRedeemed ?? 0, "Loyalty points", { minimum: 0, maximum: 999_999_999 });
      if (body.id !== undefined) payload.id = readUuid(body.id, "Held sale");
    } else if (action === "resume" || action === "delete") {
      payload.id = readUuid(body.id, "Held sale");
    }

    const { data, error } = await authentication.client.rpc("staff_manage_pos_held_sale", {
      p_action: action,
      p_payload: payload,
    });
    if (error?.code === "PGRST202") {
      return authenticationResponse(request, authentication, {
        error: "Held sales are not configured in Supabase. Apply migration 012_pos_held_sales.sql.",
      }, 503);
    }
    if (error) throw error;

    return authenticationResponse(request, authentication, data);
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
