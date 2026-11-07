import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { StaffIdentity } from "@/lib/server/staff-auth";

export interface AuditEventInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Json;
  /**
   * Defaults to the staff member's assigned branch. HQ administrators have no
   * assigned branch, so they may pass the branch a record belongs to.
   */
  branchId?: string | null;
}

/**
 * Records a staff action in the append-only audit log.
 *
 * This is best-effort for single-table writes: the row change has already
 * succeeded, so an audit failure must not turn a successful save into an error
 * for the user. Transactional RPCs write their audit row inside the database
 * transaction instead, where it is guaranteed.
 */
export async function insertAuditEvent(
  client: SupabaseClient<Database>,
  identity: StaffIdentity,
  event: AuditEventInput,
): Promise<boolean> {
  try {
    const { error } = await client.from("audit_log").insert({
      id: crypto.randomUUID(),
      actor_id: identity.staff.local_staff_id,
      branch_id: event.branchId !== undefined ? event.branchId : identity.staff.branch_id,
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId ?? null,
      details_json: event.details ?? {},
    });
    if (error) throw new Error(error.message);
    return true;
  } catch (error) {
    console.error("Could not record the audit event.", error);
    return false;
  }
}
