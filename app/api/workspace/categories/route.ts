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

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CATEGORY_BODY_BYTES = 3 * 1024 * 1024;
const CATEGORY_COLUMNS = "id,name,description,image_path,sort_order,is_active";

function readCategoryImage(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_IMAGE_BYTES * 1.4) {
    throw new WriteError("Category images must be 2 MB or smaller.");
  }
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new WriteError("Choose a PNG, JPEG, WebP or GIF category image.");
  const encoded = match[2];
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (Math.floor(encoded.length * 3 / 4) - padding > MAX_IMAGE_BYTES) {
    throw new WriteError("Category images must be 2 MB or smaller.");
  }
  return value;
}

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

    const body = await readJsonBody(request, MAX_CATEGORY_BODY_BYTES);
    if (body.action === "delete") {
      const categoryId = readOptionalUuid(body.id, "Category");
      if (!categoryId) throw new WriteError("Choose a category to delete.");
      const { data: category, error: categoryError } = await authentication.client
        .from("categories")
        .select("id,name")
        .eq("id", categoryId)
        .is("deleted_at", null)
        .maybeSingle();
      if (categoryError) throw categoryError;
      if (!category) throw new WriteError("That category no longer exists.", 404);
      const { count, error: productCountError } = await authentication.client
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("category_id", categoryId)
        .is("deleted_at", null);
      if (productCountError) throw productCountError;
      if (count) {
        throw new WriteError(
          `This category is used by ${count} active product${count === 1 ? "" : "s"}. Move or delete those products before deleting the category.`,
          409,
        );
      }
      const now = new Date().toISOString();
      const { data, error } = await authentication.client.from("categories")
        .update({ deleted_at: now, updated_at: now })
        .eq("id", categoryId)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new WriteError("That category was already deleted.", 409);
      await insertAuditEvent(authentication.client, authentication.identity, {
        action: "category.deleted",
        entityType: "category",
        entityId: categoryId,
        details: { name: category.name },
      });
      return authenticationResponse(request, authentication, { success: true });
    }

    const id = readOptionalUuid(body.id, "Category");
    const name = readText(body.name, "Category name", 120);
    const description = readOptionalText(body.description, "Description", 1000);
    const imagePath = readCategoryImage(body.imagePath);
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
          image_path: imagePath,
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
        image_path: imagePath,
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
