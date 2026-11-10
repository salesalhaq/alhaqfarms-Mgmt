import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertBranchAccess,
  assertSameOrigin,
  readEnum,
  readInteger,
  readJsonBody,
  readUuid,
  WriteError,
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
    const role = authentication.identity.staff.role;
    if (action === "request" && !["cashier", "manager", "admin"].includes(role)) {
      throw new WriteError("Your role cannot request a POS discount approval.", 403);
    }
    if ((action === "approve" || action === "decline") && !["manager", "admin"].includes(role)) {
      throw new WriteError("Only a manager or administrator can review discount requests.", 403);
    }
    const allBranches = action === "list" && body.branchId === "all";
    if (allBranches && (
      authentication.identity.staff.role !== "admin"
      || authentication.identity.staff.branch_id !== null
    )) {
      throw new WriteError("Only the HQ administrator can view all branch discount requests.", 403);
    }

    const branchId = allBranches ? null : readUuid(body.branchId, "Branch");
    if (branchId) assertBranchAccess(authentication.identity, branchId);
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

    if (allBranches) {
      const results = await Promise.all(authentication.identity.branches.map(async (branch) => {
        const { data, error } = await authentication.client.rpc("staff_manage_pos_discount", {
          p_action: "list",
          p_payload: { branchId: branch.id },
        });
        if (error?.code === "PGRST202") {
          throw new WriteError("POS discount approvals are not configured in Supabase. Apply migration 012_pos_held_sales.sql.", 503);
        }
        if (error) throw error;
        const result = data as { requests?: Array<Record<string, unknown>> } | null;
        return (result?.requests || []).map((discountRequest) => ({
          ...discountRequest,
          branchId: branch.id,
          branchName: branch.name,
        }));
      }));
      return authenticationResponse(request, authentication, { requests: results.flat() });
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

    if (action === "list") {
      const branchName = authentication.identity.branches.find((branch) => branch.id === branchId)?.name || "";
      const result = data as { requests?: Array<Record<string, unknown>> } | null;
      return authenticationResponse(request, authentication, {
        ...result,
        requests: (result?.requests || []).map((discountRequest) => ({
          ...discountRequest,
          branchId,
          branchName,
        })),
      });
    }
    return authenticationResponse(request, authentication, data);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P0001"
        && "message" in error && typeof error.message === "string") {
      return authenticationResponse(request, authentication, { error: error.message }, 400);
    }
    return writeFailure(request, authentication, error);
  }
}
