import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertBranchAccess,
  assertSameOrigin,
  readEnum,
  readInteger,
  readJsonBody,
  readUuid,
  writeFailure,
} from "@/lib/server/write";
import type { Json } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

const ACTIONS = ["request", "list", "approve", "decline", "status"] as const;

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const action = readEnum(body.action, "Discount approval action", ACTIONS);
    const branchId = readUuid(body.branchId, "Branch");
    assertBranchAccess(authentication.identity, branchId);
    const payload: { [key: string]: Json | undefined } = { branchId };

    if (action === "request") {
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 200) {
        throw new Error("The discount request basket is invalid.");
      }
      payload.items = body.items.map((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          throw new Error("A discount request product is invalid.");
        }
        const line = entry as Record<string, unknown>;
        return {
          productId: readUuid(line.productId, "Product"),
          quantityMilli: readInteger(line.quantityMilli, "Quantity", { minimum: 1, maximum: 99_999 }),
        };
      });
      payload.billDiscountPaisa = readInteger(body.billDiscountPaisa, "Bill discount", { minimum: 1 });
    } else if (action === "approve" || action === "decline" || action === "status") {
      payload.requestId = readUuid(body.requestId, "Discount request");
    }

    const { data, error } = await authentication.client.rpc("staff_manage_pos_discount", {
      p_action: action,
      p_payload: payload,
    });
    if (error?.code === "PGRST202") {
      return authenticationResponse(request, authentication, {
        error: "POS discount approvals are not configured in Supabase. Apply migration 012_pos_held_sales.sql.",
      }, 503);
    }
    if (error) throw error;

    return authenticationResponse(request, authentication, data);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P0001"
        && "message" in error && typeof error.message === "string") {
      return authenticationResponse(request, authentication, { error: error.message }, 400);
    }
    return writeFailure(request, authentication, error);
  }
}
