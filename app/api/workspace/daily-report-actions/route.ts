import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import type { Json } from "@/lib/supabase/database.types";
import {
  assertBranchAccess,
  assertManagerOrAdmin,
  assertSameOrigin,
  readInteger,
  readJsonBody,
  readOptionalText,
  readUuid,
  WriteError,
  writeFailure,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

function isDayCloseRuleError(error: unknown): error is { code: string; message: string } {
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
    assertManagerOrAdmin(authentication.identity);
    const body = await readJsonBody(request);
    const branchId = readUuid(body.branchId, "Branch");
    assertBranchAccess(authentication.identity, branchId);
    const businessDate = typeof body.businessDate === "string" ? body.businessDate.trim() : "";
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(businessDate)
      ? new Date(`${businessDate}T00:00:00.000Z`)
      : null;
    if (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== businessDate) {
      throw new WriteError("Choose a valid business date.");
    }

    const payload: Record<string, Json> = {
      branchId,
      businessDate,
      countedCashPaisa: readInteger(body.countedCashPaisa, "Counted cash", {
        minimum: 0,
        maximum: 999_999_999_999_999,
      }),
    };
    const notes = readOptionalText(body.notes, "Notes", 500);
    if (notes) payload.notes = notes;

    const { data, error } = await authentication.client.rpc("staff_close_day", {
      p_payload: payload,
    });
    if (error?.code === "PGRST202") {
      return authenticationResponse(request, authentication, {
        error: "Day close is not configured in Supabase. Apply migration 014_daily_report_close.sql.",
      }, 503);
    }
    if (error) throw error;

    return authenticationResponse(request, authentication, data, 201);
  } catch (error) {
    if (isDayCloseRuleError(error)) {
      return authenticationResponse(request, authentication, { error: error.message }, 400);
    }
    return writeFailure(request, authentication, error);
  }
}
