import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

type PurchasingClient = { from(table: string): any };
type PurchaseKind = "order" | "receipt";

function escapedSearch(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function quotedFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function schemaUnavailable(error: { code?: string; message?: string }): boolean {
  return error.code === "42P01"
    || error.code === "42703"
    || error.code === "PGRST200"
    || error.code === "PGRST204"
    || error.code === "PGRST205";
}

function purchasingError(error: { code?: string; message?: string }): string {
  if (schemaUnavailable(error)) {
    return "Purchasing data is not available in Supabase yet. Apply the purchasing schema migrations and reload the Supabase API schema cache.";
  }
  return error.message || "Purchasing records could not be loaded.";
}

function allowedBranch(
  branchId: string,
  branches: { id: string }[],
): boolean {
  return branches.some((branch) => branch.id === branchId);
}

function addSearch(query: any, columns: string[], search: string, supplierIds: string[]) {
  const pattern = quotedFilterValue(`%${escapedSearch(search)}%`);
  const filters = columns.map((column) => `${column}.ilike.${pattern}`);
  if (supplierIds.length) filters.push(`supplier_id.in.(${supplierIds.join(",")})`);
  return query.or(filters.join(","));
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  if (!["admin", "manager"].includes(authentication.identity.staff.role)) {
    return authenticationResponse(
      request,
      authentication,
      { error: "Purchasing records are available to managers and admins only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const requestedBranch = parameters.get("branchId") || "";
  const isHqAdmin = authentication.identity.staff.role === "admin" && !authentication.identity.staff.branch_id;
  const branchId = requestedBranch || (isHqAdmin ? "all" : authentication.identity.staff.branch_id || "");
  if (branchId !== "all" && !isUuid(branchId)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }
  if (branchId === "all" && !isHqAdmin) {
    return authenticationResponse(request, authentication, { error: "You cannot access all branches." }, 403);
  }
  if (branchId !== "all" && !allowedBranch(branchId, authentication.identity.branches)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  const search = (parameters.get("search") || "").trim().slice(0, 80);
  const kind = parameters.get("kind") as PurchaseKind | null;
  const detailId = parameters.get("detailId") || "";
  if (detailId && (!isUuid(detailId) || (kind !== "order" && kind !== "receipt"))) {
    return authenticationResponse(request, authentication, { error: "Choose a valid purchase record." }, 400);
  }

  const client = authentication.client as unknown as PurchasingClient;
  const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));

  try {
    if (detailId) {
      const table = kind === "order" ? "purchase_orders" : "purchase_receipts";
      const itemTable = kind === "order" ? "purchase_order_items" : "purchase_receipt_items";
      const foreignKey = kind === "order" ? "order_id" : "receipt_id";
      const projection = kind === "order"
        ? "id,branch_id,supplier_id,order_number,status,expected_at,notes,ordered_total_paisa,ordered_at"
        : "id,branch_id,supplier_id,supplier_invoice_number,purchase_order_id,subtotal_paisa,notes,received_at";

      const { data: record, error: recordError } = await client
        .from(table)
        .select(projection)
        .eq("id", detailId)
        .is("deleted_at", null)
        .maybeSingle();
      if (recordError) throw recordError;
      if (!record || !allowedBranch(record.branch_id, authentication.identity.branches)) {
        return authenticationResponse(request, authentication, { error: "That purchase record is not available to your account." }, 404);
      }
      if (branchId !== "all" && record.branch_id !== branchId) {
        return authenticationResponse(request, authentication, { error: "That purchase record is outside the selected branch." }, 404);
      }

      const itemProjection = kind === "order"
        ? "id,product_name,unit_code,ordered_quantity_milli,received_quantity_milli,unit_cost_paisa,line_total_paisa"
        : "id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa,replacement_quantity_milli";
      const { data: items, error: itemsError } = await client
        .from(itemTable)
        .select(itemProjection)
        .eq(foreignKey, detailId)
        .is("deleted_at", null)
        .order("product_name", { ascending: true });
      if (itemsError) throw itemsError;

      const { data: supplier } = await client
        .from("suppliers")
        .select("id,name")
        .eq("id", record.supplier_id)
        .is("deleted_at", null)
        .maybeSingle();
      const result = {
        kind,
        record: {
          ...record,
          branch_name: branchNames.get(record.branch_id) || "Branch",
          supplier_name: supplier?.name || "Supplier details unavailable",
        },
        items: items || [],
      };

      if (kind === "order") {
        const { data: receipts, error: receiptsError } = await client
          .from("purchase_receipts")
          .select("id,supplier_invoice_number,subtotal_paisa,received_at")
          .eq("purchase_order_id", detailId)
          .is("deleted_at", null)
          .order("received_at", { ascending: false });
        if (receiptsError) throw receiptsError;
        return authenticationResponse(request, authentication, { ...result, linkedReceipts: receipts || [] });
      }

      const { data: payments, error: paymentsError } = await client
        .from("supplier_payments")
        .select("id,method,amount_paisa,reference,notes,paid_by,paid_at")
        .eq("receipt_id", detailId)
        .is("deleted_at", null)
        .order("paid_at", { ascending: true });
      if (paymentsError && !schemaUnavailable(paymentsError)) throw paymentsError;
      const paymentRows = (payments || []) as Array<{ id: string; paid_by: string | null }>;
      const paidByIds = [...new Set(paymentRows.map((payment) => payment.paid_by).filter(Boolean))] as string[];
      const paidByNames = new Map<string, string>();
      if (paidByIds.length) {
        const { data: staffRows } = await client
          .from("staff_profiles")
          .select("id,full_name")
          .in("id", paidByIds)
          .is("deleted_at", null);
        for (const member of (staffRows || []) as Array<{ id: string; full_name: string }>) {
          paidByNames.set(member.id, member.full_name);
        }
      }
      return authenticationResponse(request, authentication, {
        ...result,
        payments: paymentRows.map((payment) => ({
          ...payment,
          paid_by_name: payment.paid_by ? paidByNames.get(payment.paid_by) || "Staff member" : null,
        })),
      });
    }

    let supplierIds: string[] = [];
    if (search) {
      const { data: matchingSuppliers } = await client
        .from("suppliers")
        .select("id")
        .is("deleted_at", null)
        .ilike("name", `%${escapedSearch(search)}%`)
        .limit(100);
      supplierIds = (matchingSuppliers || []).map((supplier: { id: string }) => supplier.id);
    }

    let ordersQuery = client
      .from("purchase_orders")
      .select("id,branch_id,supplier_id,order_number,status,expected_at,notes,ordered_total_paisa,ordered_at")
      .is("deleted_at", null)
      .order("ordered_at", { ascending: false })
      .limit(100);
    let receiptsQuery = client
      .from("purchase_receipts")
      .select("id,branch_id,supplier_id,supplier_invoice_number,purchase_order_id,subtotal_paisa,notes,received_by,received_at")
      .is("deleted_at", null)
      .order("received_at", { ascending: false })
      .limit(100);

    if (branchId !== "all") {
      ordersQuery = ordersQuery.eq("branch_id", branchId);
      receiptsQuery = receiptsQuery.eq("branch_id", branchId);
    }
    if (search) {
      ordersQuery = addSearch(ordersQuery, ["order_number", "notes"], search, supplierIds);
      receiptsQuery = addSearch(receiptsQuery, ["supplier_invoice_number", "notes"], search, supplierIds);
    }

    const [ordersResult, receiptsResult, suppliersResult] = await Promise.all([
      ordersQuery,
      receiptsQuery,
      client
        .from("suppliers")
        .select("id,name,contact_name,phone,email,is_active")
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .limit(200),
    ]);
    if (ordersResult.error) throw ordersResult.error;
    if (receiptsResult.error) throw receiptsResult.error;
    if (suppliersResult.error && schemaUnavailable(suppliersResult.error)) throw suppliersResult.error;

    const rows = [...(ordersResult.data || []), ...(receiptsResult.data || [])];
    const supplierIdsToLoad = [...new Set(rows.map((row: { supplier_id: string }) => row.supplier_id))];
    const { data: suppliers, error: suppliersError } = supplierIdsToLoad.length
      ? await client.from("suppliers").select("id,name").in("id", supplierIdsToLoad).is("deleted_at", null)
      : { data: [], error: null };
    if (suppliersError && schemaUnavailable(suppliersError)) throw suppliersError;
    const supplierNames = new Map((suppliers || []).map((supplier: { id: string; name: string }) => [supplier.id, supplier.name]));

    const orderIds = (ordersResult.data || []).map((order: { id: string }) => order.id);
    const receiptIds = (receiptsResult.data || []).map((receipt: { id: string }) => receipt.id);
    const orderStats = new Map<string, { products: number; receivedMilli: number }>();
    const receiptStats = new Map<string, { products: number; paidPaisa: number }>();

    const [orderItemsResult, receiptItemsResult, paymentsResult] = await Promise.all([
      orderIds.length
        ? client
          .from("purchase_order_items")
          .select("order_id,received_quantity_milli")
          .in("order_id", orderIds)
          .is("deleted_at", null)
        : Promise.resolve({ data: [], error: null }),
      receiptIds.length
        ? client
          .from("purchase_receipt_items")
          .select("receipt_id")
          .in("receipt_id", receiptIds)
          .is("deleted_at", null)
        : Promise.resolve({ data: [], error: null }),
      receiptIds.length
        ? client
          .from("supplier_payments")
          .select("receipt_id,amount_paisa")
          .in("receipt_id", receiptIds)
          .is("deleted_at", null)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (orderItemsResult.error && schemaUnavailable(orderItemsResult.error)) throw orderItemsResult.error;
    if (receiptItemsResult.error && schemaUnavailable(receiptItemsResult.error)) throw receiptItemsResult.error;
    if (paymentsResult.error && schemaUnavailable(paymentsResult.error)) throw paymentsResult.error;

    for (const item of (orderItemsResult.data || []) as Array<{ order_id: string; received_quantity_milli: number }>) {
      const bucket = orderStats.get(item.order_id) || { products: 0, receivedMilli: 0 };
      bucket.products += 1;
      bucket.receivedMilli += Number(item.received_quantity_milli || 0);
      orderStats.set(item.order_id, bucket);
    }
    for (const item of (receiptItemsResult.data || []) as Array<{ receipt_id: string }>) {
      const bucket = receiptStats.get(item.receipt_id) || { products: 0, paidPaisa: 0 };
      bucket.products += 1;
      receiptStats.set(item.receipt_id, bucket);
    }
    for (const payment of (paymentsResult.data || []) as Array<{ receipt_id: string; amount_paisa: number }>) {
      const bucket = receiptStats.get(payment.receipt_id) || { products: 0, paidPaisa: 0 };
      bucket.paidPaisa += Number(payment.amount_paisa || 0);
      receiptStats.set(payment.receipt_id, bucket);
    }

    const receivedByIds = [...new Set((receiptsResult.data || [])
      .map((receipt: { received_by?: string | null }) => receipt.received_by)
      .filter(Boolean))] as string[];
    const receivedByNames = new Map<string, string>();
    if (receivedByIds.length) {
      const { data: staffRows } = await client
        .from("staff_profiles")
        .select("id,full_name")
        .in("id", receivedByIds)
        .is("deleted_at", null);
      for (const member of (staffRows || []) as Array<{ id: string; full_name: string }>) {
        receivedByNames.set(member.id, member.full_name);
      }
    }

    const decorate = (row: any) => ({
      ...row,
      branch_name: branchNames.get(row.branch_id) || "Branch",
      supplier_name: supplierNames.get(row.supplier_id) || "Supplier details unavailable",
    });

    return authenticationResponse(request, authentication, {
      branches: authentication.identity.branches.map(({ id, name }) => ({ id, name })),
      branchId,
      orders: (ordersResult.data || []).map((order: { id: string }) => {
        const stats = orderStats.get(order.id);
        return {
          ...decorate(order),
          product_count: stats?.products || 0,
          received_quantity_milli: stats?.receivedMilli || 0,
        };
      }),
      receipts: (receiptsResult.data || []).map((receipt: { id: string; subtotal_paisa: number; received_by?: string | null }) => {
        const stats = receiptStats.get(receipt.id);
        return {
          ...decorate(receipt),
          product_count: stats?.products || 0,
          paid_paisa: stats?.paidPaisa || 0,
          due_paisa: Math.max(0, Number(receipt.subtotal_paisa || 0) - (stats?.paidPaisa || 0)),
          received_by_name: receipt.received_by ? receivedByNames.get(receipt.received_by) || "Staff member" : null,
        };
      }),
      suppliers: (suppliersResult.data || []).map((supplier: Record<string, unknown>) => ({
        ...supplier,
        branch_name: branchId === "all" ? "All branches" : branchNames.get(branchId) || "Branch",
      })),
      limit: 100,
    });
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return authenticationResponse(
      request,
      authentication,
      { error: purchasingError(failure) },
      schemaUnavailable(failure) ? 503 : 500,
    );
  }
}
