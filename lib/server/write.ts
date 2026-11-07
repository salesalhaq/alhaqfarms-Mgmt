import "server-only";

import { NextResponse } from "next/server";
import {
  authenticationResponse,
  isSameOriginRequest,
  isUuid,
  type StaffAuthentication,
  type StaffIdentity,
} from "@/lib/server/staff-auth";

export const MAX_WRITE_BODY_BYTES = 256 * 1024;

/**
 * A validation or authorization failure that is safe to show to the signed-in
 * staff member. Anything else is treated as an unexpected server error.
 */
export class WriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WriteError";
    this.status = status;
  }
}

export function assertSameOrigin(request: Request): void {
  if (!isSameOriginRequest(request)) {
    throw new WriteError("This change must be submitted from the management app.", 403);
  }
}

export function assertHqAdmin(identity: StaffIdentity): void {
  if (identity.staff.role !== "admin" || identity.staff.branch_id) {
    throw new WriteError("Only an HQ administrator can make this change.", 403);
  }
}

export function assertManagerOrAdmin(identity: StaffIdentity): void {
  if (identity.staff.role !== "manager" && identity.staff.role !== "admin") {
    throw new WriteError("Your role does not allow this change.", 403);
  }
}

export function assertBranchAccess(identity: StaffIdentity, branchId: string): void {
  if (!identity.branches.some((branch) => branch.id === branchId)) {
    throw new WriteError("You cannot change records for that branch.", 403);
  }
}

export async function readJsonBody(
  request: Request,
  maxBytes = MAX_WRITE_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new WriteError("Send this change as JSON.", 415);
  }

  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new WriteError("This change is too large to save.", 413);
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new WriteError("The change could not be read. Please try again.", 400);
  }
  if (text.length > maxBytes) {
    throw new WriteError("This change is too large to save.", 413);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WriteError("Send valid JSON.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WriteError("Send a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

export function readText(
  value: unknown,
  label: string,
  maxLength = 200,
): string {
  if (typeof value !== "string") throw new WriteError(`Enter ${label.toLowerCase()}.`);
  const text = value.trim();
  if (!text) throw new WriteError(`Enter ${label.toLowerCase()}.`);
  if (text.length > maxLength) {
    throw new WriteError(`${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

export function readOptionalText(
  value: unknown,
  label: string,
  maxLength = 500,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new WriteError(`${label} must be text.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new WriteError(`${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

export function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new WriteError(`${label} must be true or false.`);
  return value;
}

export function readInteger(
  value: unknown,
  label: string,
  options: { minimum?: number; maximum?: number } = {},
): number {
  const { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER } = options;
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw new WriteError(`${label} must be a whole number.`);
  }
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WriteError(`${label} is outside the allowed range.`);
  }
  return parsed;
}

export function readNumber(
  value: unknown,
  label: string,
  options: { minimum?: number; maximum?: number } = {},
): number {
  const { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER } = options;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new WriteError(`${label} is outside the allowed range.`);
  }
  return parsed;
}

export function readUuid(value: unknown, label: string): string {
  const text = readText(value, label, 64);
  if (!isUuid(text)) throw new WriteError(`Choose a valid ${label.toLowerCase()}.`);
  return text;
}

export function readOptionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return readUuid(value, label);
}

export function readEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  const text = readText(value, label, 80);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new WriteError(`Choose a valid ${label.toLowerCase()}.`);
  }
  return text as T;
}

interface PostgrestLikeError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
}

function asPostgrestError(error: unknown): PostgrestLikeError | null {
  if (!error || typeof error !== "object") return null;
  if (!("code" in error) && !("message" in error)) return null;
  return error as PostgrestLikeError;
}

/**
 * Converts any failure from a write handler into a safe response. PostgREST
 * codes are mapped to staff-facing messages so database internals are not
 * leaked to the browser.
 */
export function writeFailure(
  request: Request,
  authentication: StaffAuthentication,
  error: unknown,
): NextResponse {
  if (error instanceof WriteError) {
    return authenticationResponse(request, authentication, { error: error.message }, error.status);
  }

  const databaseError = asPostgrestError(error);
  if (databaseError) {
    const code = typeof databaseError.code === "string" ? databaseError.code : "";
    if (code === "23505") {
      return authenticationResponse(request, authentication, { error: "A record with these details already exists." }, 409);
    }
    if (code === "23503") {
      return authenticationResponse(request, authentication, { error: "A linked record is missing or no longer available." }, 409);
    }
    if (code === "23514") {
      return authenticationResponse(request, authentication, { error: "Some of the entered values are not valid." }, 400);
    }
    if (code === "42501" || code === "PGRST301") {
      return authenticationResponse(request, authentication, { error: "Your role does not allow this change." }, 403);
    }
    if (code === "PGRST202") {
      return authenticationResponse(request, authentication, { error: "This action is not configured in Supabase yet. Apply the matching migration." }, 503);
    }
  }

  console.error("Workspace write failed.", error);
  return authenticationResponse(
    request,
    authentication,
    { error: "The change could not be saved. Please try again." },
    503,
  );
}
