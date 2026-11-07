import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertBranchAccess,
  assertSameOrigin,
  readEnum,
  readInteger,
  readJsonBody,
  readOptionalText,
  readText,
  readUuid,
  writeFailure,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

const PAYMENT_METHODS = ["cash", "card", "jazzcash", "easypaisa", "other", "credit"] as const;

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const branchId = readUuid(body.branchId, "Branch");
    assertBranchAccess(authentication.identity, branchId);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 200) {
      throw new Error("The basket must contain between 1 and 200 product lines.");
    }
    if (!Array.isArray(body.payments) || body.payments.length < 1 || body.payments.length > 10) {
      throw new Error("Add between 1 and 10 payments.");
    }

    const items = body.items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("A sale line is invalid.");
      }
      const line = item as Record<string, unknown>;
      return {
        productId: readUuid(line.productId, "Product"),
        quantityMilli: readInteger(line.quantityMilli, "Quantity", { minimum: 1, maximum: 99_999 }),
      };
    });
    const payments = body.payments.map((payment) => {
      if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
        throw new Error("A payment is invalid.");
      }
      const line = payment as Record<string, unknown>;
      const method = readEnum(line.method, "Payment method", PAYMENT_METHODS);
      const amountPaisa = readInteger(line.amountPaisa, "Payment amount", { minimum: 1 });
      const reference = readOptionalText(line.reference, "Payment reference", 100);
      const tenderedPaisa = method === "cash"
        ? readInteger(line.tenderedPaisa ?? amountPaisa, "Cash received", { minimum: amountPaisa })
        : method === "credit" ? null : amountPaisa;
      return { method, amountPaisa, tenderedPaisa, reference: reference || "" };
    });
    const payload = {
      branchId,
      clientSaleId: readText(body.clientSaleId, "Sale id", 100),
      items,
      payments,
      billDiscountPaisa: readInteger(body.billDiscountPaisa ?? 0, "Bill discount", { minimum: 0 }),
      taxMode: readEnum(body.taxMode ?? "inclusive", "Tax mode", ["inclusive", "exclusive"] as const),
      ...(body.customerAccountId !== undefined && body.customerAccountId !== null
        ? { customerAccountId: readUuid(body.customerAccountId, "Customer account") }
        : {}),
      loyaltyPointsRedeemed: readInteger(body.loyaltyPointsRedeemed ?? 0, "Loyalty points", { minimum: 0, maximum: 999_999_999 }),
      ...(body.discountApprovalId !== undefined
        ? { discountApprovalId: readUuid(body.discountApprovalId, "Discount approval") }
        : {}),
      ...(body.heldSaleId !== undefined ? { heldSaleId: readUuid(body.heldSaleId, "Held sale") } : {}),
    };

    const { data, error } = await authentication.client.rpc("staff_complete_pos_sale", {
      p_payload: payload,
    });
    if (error?.code === "PGRST202") {
      return authenticationResponse(request, authentication, {
        error: "POS checkout is not configured in Supabase. Apply migration 011_pos_checkout.sql.",
      }, 503);
    }
    if (error) throw error;

    return authenticationResponse(request, authentication, { sale: data }, 201);
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
