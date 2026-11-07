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

const REGISTER_ACTIONS = ["open_shift", "close_shift", "cash_in", "cash_out"] as const;

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const action = readEnum(body.action, "Register action", REGISTER_ACTIONS);
    const branchId = readUuid(body.branchId, "Branch");
    assertBranchAccess(authentication.identity, branchId);

    const payload: Record<string, string | number> = { branchId };
    if (action === "open_shift") {
      payload.openingCashPaisa = readInteger(body.openingCashPaisa, "Opening cash", { minimum: 0 });
      const notes = readOptionalText(body.notes, "Notes", 500);
      if (notes) payload.notes = notes;
    } else if (action === "close_shift") {
      payload.countedCashPaisa = readInteger(body.countedCashPaisa, "Counted cash", { minimum: 0 });
      const notes = readOptionalText(body.notes, "Notes", 500);
      if (notes) payload.notes = notes;
    } else {
      payload.amountPaisa = readInteger(body.amountPaisa, "Amount", { minimum: 1 });
      payload.reason = readText(body.reason, "Reason", 200);
    }

    const { data, error } = await authentication.client.rpc("staff_pos_register_action", {
      p_action: action,
      p_payload: payload,
    });
    if (error?.code === "PGRST202") {
      return authenticationResponse(request, authentication, {
        error: "Register actions are not configured in Supabase. Apply migration 010_pos_register_actions.sql.",
      }, 503);
    }
    if (error) throw error;

    return authenticationResponse(request, authentication, data);
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
