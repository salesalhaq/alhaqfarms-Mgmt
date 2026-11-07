import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import { insertAuditEvent } from "@/lib/server/audit";
import {
  assertHqAdmin,
  assertSameOrigin,
  readBoolean,
  readInteger,
  readJsonBody,
  readOptionalText,
  readOptionalUuid,
  readText,
  writeFailure,
  WriteError,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

const CATEGORY_COLUMNS = "id,name,description,sort_order,is_active";

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    const { data, error } = await authentication.client
      .from("categories")
      .select(CATEGORY_COLUMNS)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
      .limit(500);
    if (error) throw error;
    return authenticationResponse(request, authentication, { categories: data || [] });
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    assertHqAdmin(authentication.identity);

    const body = await readJsonBody(request);
    const id = readOptionalUuid(body.id, "Category");
    const name = readText(body.name, "Category name", 120);
    const description = readOptionalText(body.description, "Description", 1000);
    const sortOrder = body.sortOrder === undefined
      ? 0
      : readInteger(body.sortOrder, "Sort order", { minimum: -100000, maximum: 100000 });
    const isActive = body.isActive === undefined ? true : readBoolean(body.isActive, "Active");
    const now = new Date().toISOString();

    if (id) {
      const { data, error } = await authentication.client
        .from("categories")
        .update({
          name,
          description,
          sort_order: sortOrder,
          is_active: isActive,
          updated_at: now,
        })
        .eq("id", id)
        .is("deleted_at", null)
        .select(CATEGORY_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new WriteError("That category no longer exists.", 404);

      await insertAuditEvent(authentication.client, authentication.identity, {
        action: "category.updated",
        entityType: "category",
        entityId: id,
        details: { name },
      });
      return authenticationResponse(request, authentication, { category: data });
    }

    const categoryId = crypto.randomUUID();
    const { data, error } = await authentication.client
      .from("categories")
      .insert({
        id: categoryId,
        name,
        description,
        sort_order: sortOrder,
        is_active: isActive,
        created_at: now,
        updated_at: now,
      })
      .select(CATEGORY_COLUMNS)
      .single();
    if (error) throw error;

    await insertAuditEvent(authentication.client, authentication.identity, {
      action: "category.created",
      entityType: "category",
      entityId: categoryId,
      details: { name },
    });
    return authenticationResponse(request, authentication, { category: data }, 201);
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
