import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import { insertAuditEvent } from "@/lib/server/audit";
import {
  assertHqAdmin,
  assertSameOrigin,
  readJsonBody,
  readText,
  writeFailure,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    assertHqAdmin(authentication.identity);

    const body = await readJsonBody(request);
    const name = readText(body.name, "Expense category", 100);
    const id = crypto.randomUUID();
    const { data, error } = await authentication.client
      .from("expense_categories")
      .insert({
        id,
        name,
        is_active: true,
        created_by: authentication.identity.staff.local_staff_id,
      })
      .select("id,name,is_active")
      .single();
    if (error) throw error;

    await insertAuditEvent(authentication.client, authentication.identity, {
      action: "expense_category.created",
      entityType: "expense_category",
      entityId: id,
      details: { name },
    });

    return authenticationResponse(request, authentication, { category: data }, 201);
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
