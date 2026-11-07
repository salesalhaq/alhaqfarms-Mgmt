import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import type { Json } from "@/lib/supabase/database.types";
import {
  assertBranchAccess,
  assertSameOrigin,
  readEnum,
  readInteger,
  readJsonBody,
  readOptionalText,
  readOptionalUuid,
  readText,
  readUuid,
  WriteError,
  writeFailure,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

const RETURN_ACTIONS = ["lookup", "create", "approve", "reject", "cancel", "complete"] as const;
const RETURN_CONDITIONS = ["new", "used", "damaged", "expired"] as const;
const REFUND_METHODS = ["cash", "card", "jazzcash", "easypaisa", "bank_transfer", "store_credit", "replacement"] as const;

function isReturnRuleError(error: unknown): error is { code: string; message: string } {
  return Boolean(error && typeof error === "object"
    && "code" in error && error.code === "P0001"
    && "message" in error && typeof error.message === "string");
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const action = readEnum(body.action, "Return action", RETURN_ACTIONS);
    const branchId = readOptionalUuid(body.branchId, "Branch");
    if (branchId) assertBranchAccess(authentication.identity, branchId);
    const payload: Record<string, Json> = {
      ...(branchId ? { branchId } : {}),
    };

    if (action === "lookup") {
      payload.receiptNumber = readText(body.receiptNumber, "Receipt number", 60);
    } else if (action === "create") {
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
        throw new WriteError("Select between 1 and 100 sale lines to return.");
      }
      payload.clientReturnId = readText(body.clientReturnId, "Return id", 100);
      payload.saleId = readUuid(body.saleId, "Sale");
      payload.reason = readText(body.reason, "Return reason", 300);
      const notes = readOptionalText(body.notes, "Notes", 1000);
      if (notes) payload.notes = notes;
      payload.items = body.items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new WriteError("A return line is invalid.");
        }
        const line = item as Record<string, unknown>;
        return {
          saleItemId: readUuid(line.saleItemId, "Sale item"),
          quantityMilli: readInteger(line.quantityMilli, "Return quantity", {
            minimum: 1,
            maximum: 999_999_999_999_999,
          }),
          condition: readEnum(line.condition ?? "new", "Item condition", RETURN_CONDITIONS),
        };
      });
    } else {
      payload.returnId = readUuid(body.returnId, "Return");
      if (action === "reject") {
        payload.reason = readText(body.reason, "Rejection reason", 300);
      } else if (action === "complete") {
        payload.refundMethod = readEnum(body.refundMethod ?? "cash", "Refund method", REFUND_METHODS);
        const reference = readOptionalText(body.reference, "Reference", 100);
        if (reference) payload.reference = reference;
      }
    }

    const { data, error } = await authentication.client.rpc("staff_manage_return", {
      p_action: action,
      p_payload: payload,
    });
    if (error?.code === "PGRST202") {
      return authenticationResponse(request, authentication, {
        error: "Return actions are not configured in Supabase. Apply migration 013_returns_workflow.sql.",
      }, 503);
    }
    if (error) throw error;

    return authenticationResponse(request, authentication, data, action === "create" ? 201 : 200);
  } catch (error) {
    if (isReturnRuleError(error)) {
      return authenticationResponse(request, authentication, { error: error.message }, 400);
    }
    return writeFailure(request, authentication, error);
  }
}
