import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import { insertAuditEvent } from "@/lib/server/audit";
import {
  assertBranchAccess,
  assertManagerOrAdmin,
  assertSameOrigin,
  readEnum,
  readInteger,
  readJsonBody,
  readOptionalText,
  readUuid,
  readText,
  writeFailure,
  WriteError,
} from "@/lib/server/write";

export const dynamic = "force-dynamic";

const PAYMENT_METHODS = ["cash", "bank_transfer", "card", "jazzcash", "easypaisa", "other"] as const;

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
    const categoryId = readUuid(body.categoryId, "Expense category");
    const description = readText(body.description, "Description", 200);
    const amountPaisa = readInteger(body.amountPaisa, "Expense amount", { minimum: 1 });
    const paymentMethod = readEnum(body.paymentMethod, "Payment method", PAYMENT_METHODS);
    const reference = readOptionalText(body.reference, "Reference", 100);
    const notes = readOptionalText(body.notes, "Notes", 500);
    assertBranchAccess(authentication.identity, branchId);

    const { data: category, error: categoryError } = await authentication.client
      .from("expense_categories")
      .select("id,name,is_active")
      .eq("id", categoryId)
      .is("deleted_at", null)
      .maybeSingle();
    if (categoryError) throw categoryError;
    if (!category || !category.is_active) throw new WriteError("Choose an active expense category.");

    const id = crypto.randomUUID();
    const spentAt = new Date().toISOString();
    const { error } = await authentication.client
      .from("expenses")
      .insert({
        id,
        branch_id: branchId,
        category_id: categoryId,
        description,
        amount_paisa: amountPaisa,
        payment_method: paymentMethod,
        reference,
        notes,
        spent_at: spentAt,
        recorded_by: authentication.identity.staff.local_staff_id,
        created_at: spentAt,
      });
    if (error) throw error;

    await insertAuditEvent(authentication.client, authentication.identity, {
      action: "expense.recorded",
      entityType: "expense",
      entityId: id,
      branchId,
      details: { categoryId, categoryName: category.name, description, amountPaisa, paymentMethod, reference },
    });

    return authenticationResponse(request, authentication, {
      expense: { id, branch_id: branchId, category_id: categoryId, amount_paisa: amountPaisa, spent_at: spentAt },
    }, 201);
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
