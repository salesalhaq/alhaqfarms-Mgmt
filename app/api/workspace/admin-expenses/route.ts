import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pakistanStartOfDay(value: string): string {
  return new Date(`${value}T00:00:00+05:00`).toISOString();
}

function pakistanNextDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+05:00`).toISOString();
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  const categoryId = parameters.get("categoryId") || "";
  const fromDate = parameters.get("from") || "";
  const toDate = parameters.get("to") || "";
  const search = (parameters.get("search") || "").trim();

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  if (requestedBranch && requestedBranch !== "all" && !authentication.identity.branches.some((branch) => branch.id === requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  if (categoryId && categoryId !== "all" && !isUuid(categoryId)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid category." }, 400);
  }

  const fromParsed = parseDate(fromDate);
  const toParsed = parseDate(toDate);
  if (!fromParsed || !toParsed) {
    return authenticationResponse(request, authentication, { error: "Choose a valid date range." }, 400);
  }
  if (toParsed.getTime() < fromParsed.getTime()) {
    return authenticationResponse(request, authentication, { error: "The end date must be after the start date." }, 400);
  }

  const isAdmin = authentication.identity.staff.role === "admin";
  const branchScope = isAdmin
    ? requestedBranch && requestedBranch !== "all" ? requestedBranch : "all"
    : authentication.identity.staff.branch_id;

  if (!branchScope && !isAdmin) {
    return authenticationResponse(request, authentication, { error: "Choose a branch before reviewing expenses." }, 400);
  }

  const branchName = branchScope === "all"
    ? "All accessible branches"
    : authentication.identity.branches.find((branch) => branch.id === branchScope)?.name || "Selected branch";

  try {
    let query = authentication.client
      .from("expenses")
      .select("id,branch_id,category_id,description,amount_paisa,payment_method,reference,notes,spent_at,created_at")
      .is("deleted_at", null)
      .gte("spent_at", pakistanStartOfDay(fromDate))
      .lt("spent_at", pakistanNextDay(toDate))
      .order("spent_at", { ascending: false })
      .limit(500);

    if (branchScope && branchScope !== "all") query = query.eq("branch_id", branchScope);
    if (categoryId && categoryId !== "all") query = query.eq("category_id", categoryId);
    if (search) {
      const escaped = search.replace(/[%_]/g, "\\$&");
      query = query.or(`description.ilike.%${escaped}%,reference.ilike.%${escaped}%,notes.ilike.%${escaped}%`);
    }

    const [expensesResult, categoriesResult] = await Promise.all([
      query,
      authentication.client
        .from("expense_categories")
        .select("id,name")
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .limit(500),
    ]);

    if (expensesResult.error) throw new Error(expensesResult.error.message);
    if (categoriesResult.error) throw new Error(categoriesResult.error.message);

    const categoryRows = (categoriesResult.data || []) as Array<{ id: string; name: string }>;
    const categoryMap = new Map<string, string>(categoryRows.map((category) => [category.id, category.name]));
    const rows = ((expensesResult.data || []) as Array<{
      id: string;
      branch_id: string;
      category_id: string | null;
      description: string | null;
      amount_paisa: number;
      payment_method: string | null;
      reference: string | null;
      notes: string | null;
      spent_at: string;
      created_at: string;
    }>).map((expense) => ({
      ...expense,
      branch_name: authentication.identity.branches.find((branch) => branch.id === expense.branch_id)?.name || "Branch",
      category_name: expense.category_id ? categoryMap.get(expense.category_id) || "Uncategorized" : "Uncategorized",
    }));

    const totalPaisa = rows.reduce((sum, row) => sum + Number(row.amount_paisa || 0), 0);

    return authenticationResponse(request, authentication, {
      branchId: branchScope === "all" ? null : branchScope,
      branchName,
      from: fromDate,
      to: toDate,
      rows,
      categories: categoryRows,
      totalPaisa,
      count: rows.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load store expenses.",
    }, 500);
  }
}
