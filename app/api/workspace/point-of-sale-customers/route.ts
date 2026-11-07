import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertBranchAccess,
  assertSameOrigin,
  readEnum,
  readJsonBody,
  readOptionalText,
  readText,
  readUuid,
  writeFailure,
} from "@/lib/server/write";
import type { Json } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

const ACTIONS = ["list", "create"] as const;

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const action = readEnum(body.action, "Customer action", ACTIONS);
    const branchId = readUuid(body.branchId, "Branch");
    assertBranchAccess(authentication.identity, branchId);
    const payload: { [key: string]: Json | undefined } = { branchId };

    if (action === "list") {
      payload.search = readOptionalText(body.search, "Customer search", 80) || "";
      if (body.customerAccountId !== undefined) {
        payload.customerAccountId = readUuid(body.customerAccountId, "Customer account");
      }
    } else {
      payload.name = readText(body.name, "Customer name", 200);
      payload.phone = readOptionalText(body.phone, "Customer phone", 50) || "";
    }

    const { data, error } = await authentication.client.rpc("staff_manage_pos_customer", {
      p_action: action,
      p_payload: payload,
    });
    if (error?.code === "PGRST202") {
      return authenticationResponse(request, authentication, {
        error: "POS customer workflows are not configured in Supabase. Apply migration 012_pos_held_sales.sql.",
      }, 503);
    }
    if (error) throw error;

    return authenticationResponse(request, authentication, data);
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
