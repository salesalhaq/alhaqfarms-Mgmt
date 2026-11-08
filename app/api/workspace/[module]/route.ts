import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import { cashierCanViewReturn, cashierReturnVisibilityFilter, isHqAdmin } from "@/lib/server/staff-workflow-scope";
import { DEFAULT_BRANCH_POS_SETTINGS, parseBranchPosSettings } from "@/lib/branch-pos-settings";
import type { StaffDailyReportPayload } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ module: string }>; }

function escapedSearch(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function pakistanDateBoundary(value: string, nextDay = false): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+05:00`).toISOString();
}

function quotedFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function GET(request: Request, context: RouteContext) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const { module } = await context.params;
  const parameters = new URL(request.url).searchParams;
  const search = (parameters.get("search") || "").trim().slice(0, 80);

  try {
    if (module === "point-of-sale") {
      const requestedBranch = parameters.get("branchId") || "";
      const branchId = authentication.identity.staff.branch_id || requestedBranch;
      if (!branchId || !isUuid(branchId)) {
        return authenticationResponse(request, authentication, { error: "Choose a branch before opening the register." }, 400);
      }
      if (!authentication.identity.branches.some((branch) => branch.id === branchId)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }

      const categoryId = parameters.get("categoryId") || "";
      if (categoryId && !isUuid(categoryId)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid product category." }, 400);
      }

      const offsetValue = parameters.get("offset") || "0";
      const offset = Number(offsetValue);
      if (!/^(0|[1-9]\d*)$/.test(offsetValue) || !Number.isSafeInteger(offset) || offset > 1_000_000_000) {
        return authenticationResponse(request, authentication, { error: "Choose a valid catalog page." }, 400);
      }

      const [staffResult, productsResult, categoriesResult, posSettingsResult] = await Promise.all([
        authentication.client
          .from("cloud_staff")
          .select("local_staff_id")
          .eq("user_id", authentication.identity.staff.user_id)
          .maybeSingle(),
        authentication.client.rpc("get_staff_pos_catalog", {
          p_branch_id: branchId,
          p_search: search,
          p_category_id: categoryId || null,
          p_limit: 60,
          p_offset: offset,
        }),
        authentication.client
          .from("categories")
          .select("id,name,image_path")
          .is("deleted_at", null)
          .order("sort_order", { ascending: true })
          .order("name", { ascending: true })
          .limit(200),
        authentication.client
          .from("branch_pos_settings")
          .select("*")
          .eq("branch_id", branchId)
          .maybeSingle(),
      ]);
      if (staffResult.error || productsResult.error || categoriesResult.error || posSettingsResult.error) {
        throw new Error(staffResult.error?.message || productsResult.error?.message || categoriesResult.error?.message || posSettingsResult.error?.message);
      }
      if (!staffResult.data) throw new Error("Could not verify the linked staff profile for this register.");

      const { data: shift, error: shiftError } = await authentication.client
        .from("pos_shifts")
        .select("id,opened_at")
        .eq("branch_id", branchId)
        .eq("cashier_id", staffResult.data.local_staff_id)
        .eq("status", "open")
        .is("deleted_at", null)
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (shiftError) throw new Error(shiftError.message);

      const catalogProducts = productsResult.data || [];
      const { data: taxRates, error: taxRatesError } = catalogProducts.length
        ? await authentication.client.rpc("get_staff_pos_tax_rates", {
            p_branch_id: branchId,
            p_product_ids: catalogProducts.map((product) => product.id),
          })
        : { data: [], error: null };
      if (taxRatesError?.code === "PGRST202") {
        return authenticationResponse(request, authentication, {
          error: "POS tax-rate lookup is not configured in Supabase. Apply migration 012_pos_held_sales.sql.",
        }, 503);
      }
      if (taxRatesError) throw new Error(taxRatesError.message);
      const taxRateByProductId = new Map((taxRates || []).map((row) => [row.product_id, row.tax_rate_bps]));
      const products = catalogProducts.map((product) => ({
        ...product,
        tax_rate_bps: taxRateByProductId.get(product.id) || 0,
      }));
      return authenticationResponse(request, authentication, {
        products,
        hasMore: products.length > 0 && products[0].total_count > offset + products.length,
        categories: categoriesResult.data || [],
        shift: shift ? { openedAt: shift.opened_at } : null,
        posSettings: posSettingsResult.data
          ? parseBranchPosSettings(posSettingsResult.data)
          : { ...DEFAULT_BRANCH_POS_SETTINGS },
      });
    }

    if (module === "daily-report") {
      const requestedBranch = parameters.get("branchId") || "";
      if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
      }

      const role = authentication.identity.staff.role;
      const hqAdmin = isHqAdmin(authentication.identity.staff);
      const branchId = hqAdmin
        ? requestedBranch && requestedBranch !== "all" ? requestedBranch : null
        : authentication.identity.staff.branch_id;
      if (requestedBranch && requestedBranch !== "all" && branchId !== requestedBranch) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }
      if (branchId && !authentication.identity.branches.some((branch) => branch.id === branchId)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }
      if (!branchId && !hqAdmin) {
        return authenticationResponse(request, authentication, { error: "Choose a branch before viewing the daily report." }, 400);
      }

      const date = parameters.get("date") || "";
      if (!isCalendarDate(date)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid business date." }, 400);
      }
      const cashierId = role === "cashier" ? authentication.identity.staff.local_staff_id : null;
      if (role === "cashier" && !cashierId) {
        return authenticationResponse(request, authentication, { error: "This account is not linked to a staff profile." }, 403);
      }
      if (cashierId && !branchId) {
        return authenticationResponse(request, authentication, { error: "Choose a branch before viewing the daily report." }, 400);
      }

      const { data: report, error: reportError } = cashierId && branchId
        ? await authentication.client.rpc("get_staff_cashier_daily_report", {
            p_business_date: date,
            p_branch_id: branchId,
            p_cashier_id: cashierId,
          })
        : await authentication.client.rpc("get_staff_daily_report", {
            p_business_date: date,
            p_branch_id: branchId,
          });
      if (reportError?.code === "PGRST202") {
        return authenticationResponse(request, authentication, {
          error: "The daily report is not configured in Supabase. Apply the daily-report Supabase migrations.",
        }, 503);
      }
      if (reportError) throw new Error(reportError.message);
      if (!report) throw new Error("The daily report returned no data.");

      const typedReport: StaffDailyReportPayload = report;
      const actorIds = [...new Set([
        ...typedReport.shifts.map((shift) => shift.cashier_id),
        ...typedReport.dayCloses.map((close) => close.closed_by),
        ...(typedReport.dayClose ? [typedReport.dayClose.closed_by] : []),
      ])];
      let staffNames = new Map<string, string>();
      if ((role === "admin" || role === "manager") && actorIds.length) {
        const { data: profiles, error: profilesError } = await authentication.client
          .from("staff_profiles")
          .select("id,full_name")
          .in("id", actorIds)
          .is("deleted_at", null);
        if (profilesError) throw new Error(profilesError.message);
        staffNames = new Map((profiles || []).map((profile) => [profile.id, profile.full_name]));
      } else if (role === "cashier") {
        staffNames.set(authentication.identity.staff.local_staff_id, authentication.identity.staff.full_name);
      }

      const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
      const namedCloses = typedReport.dayCloses.map((close) => ({
        ...close,
        branch_name: branchNames.get(close.branch_id) || "Branch",
        closed_by_name: staffNames.get(close.closed_by) || "Staff member",
      }));
      const dayClose = typedReport.dayClose
        ? {
          ...typedReport.dayClose,
          branch_name: branchNames.get(typedReport.dayClose.branch_id) || "Branch",
          closed_by_name: staffNames.get(typedReport.dayClose.closed_by) || "Staff member",
        }
        : null;

      return authenticationResponse(request, authentication, {
        ...typedReport,
        shifts: typedReport.shifts
          .filter((shift) => role !== "cashier" || shift.cashier_id === authentication.identity.staff.local_staff_id)
          .map((shift) => ({
          ...shift,
          branch_name: branchNames.get(shift.branch_id) || "Branch",
          cashier_name: staffNames.get(shift.cashier_id) || "Staff member",
          })),
        dayClose,
        dayCloses: namedCloses,
      });
    }

    if (module === "products") {
      const categoryId = parameters.get("categoryId") || "";
      const availability = parameters.get("availability") || "all";
      const requestedBranch = parameters.get("branchId") || "";
      if (categoryId && !isUuid(categoryId)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid product category." }, 400);
      }
      if (!["all", "active", "inactive", "on_sale"].includes(availability)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid product filter." }, 400);
      }
      if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
      }

      const role = authentication.identity.staff.role;
      const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
      if (requestedBranch && requestedBranch !== "all" && !branchNames.has(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }

      let selectedBranchIds: string[];
      if (isHqAdmin(authentication.identity.staff)) {
        selectedBranchIds = requestedBranch && requestedBranch !== "all"
          ? [requestedBranch]
          : authentication.identity.branches.map((branch) => branch.id);
      } else {
        const staffBranchId = authentication.identity.staff.branch_id;
        if (!staffBranchId) {
          return authenticationResponse(request, authentication, { error: "This account is not assigned to a branch." }, 403);
        }
        selectedBranchIds = [staffBranchId];
      }

      let productsQuery = authentication.client
        .from("products")
        .select("id,name,sku,barcode,category_id,unit_code,price_paisa,cost_price_paisa,tax_rate_bps,min_stock_milli,reorder_point_milli,max_stock_milli,on_sale,discounted_price_paisa,is_active,image_path,metadata_json")
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .limit(500);
      if (search) {
        const pattern = quotedFilterValue(`%${search}%`);
        productsQuery = productsQuery.or(`name.ilike.${pattern},sku.ilike.${pattern},barcode.ilike.${pattern}`);
      }
      if (categoryId) productsQuery = productsQuery.eq("category_id", categoryId);
      if (availability === "active") productsQuery = productsQuery.eq("is_active", true);
      if (availability === "inactive") productsQuery = productsQuery.eq("is_active", false);
      if (availability === "on_sale") productsQuery = productsQuery.eq("on_sale", true);

      const [productsResult, categoriesResult] = await Promise.all([
        productsQuery,
        authentication.client
          .from("categories")
          .select("id,name")
          .is("deleted_at", null)
          .order("sort_order", { ascending: true })
          .limit(200),
      ]);
      if (productsResult.error || categoriesResult.error) {
        throw new Error(productsResult.error?.message || categoriesResult.error?.message);
      }

      const stockByProduct = new Map<string, number>();
      const MAX_CATALOG_BRANCHES = 8;
      const MAX_CATALOG_ROWS = 300;
      for (const branchId of selectedBranchIds.slice(0, MAX_CATALOG_BRANCHES)) {
        let offset = 0;
        while (offset < MAX_CATALOG_ROWS) {
          const page = await authentication.client.rpc("get_staff_pos_catalog", {
            p_branch_id: branchId,
            p_search: search,
            p_category_id: categoryId || null,
            p_limit: 60,
            p_offset: offset,
          });
          if (page.error) break;
          const pageRows = page.data || [];
          for (const product of pageRows) {
            stockByProduct.set(product.id, (stockByProduct.get(product.id) || 0) + Number(product.stock_milli || 0));
          }
          offset += pageRows.length;
          if (pageRows.length < 60) break;
        }
      }

      const categories = categoriesResult.data || [];
      const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
      return authenticationResponse(request, authentication, {
        branchId: selectedBranchIds.length === 1 ? selectedBranchIds[0] : "all",
        branchName: selectedBranchIds.length === 1
          ? branchNames.get(selectedBranchIds[0]) || "Your branch"
          : "All accessible branches",
        branches: authentication.identity.branches.map((branch) => ({ id: branch.id, name: branch.name })),
        columns: ["Product", "Category", "FBR PCT", "SKU / barcode", "Unit", "Price", "Branch stock", "Status"],
        products: (productsResult.data || []).map((product) => {
          const metadata = (product.metadata_json || {}) as Record<string, unknown>;
          const readMetadata = (key: string) => typeof metadata[key] === "string" ? String(metadata[key]) : "";
          return {
            id: product.id,
            category_id: product.category_id,
            name: product.name,
            image_path: product.image_path,
            cost_price_paisa: Number(product.cost_price_paisa || 0),
            category_name: (product.category_id && categoryNames.get(product.category_id)) || "Uncategorized",
            fbr_pct_code: readMetadata("fbrPctCode"),
            fbr_pct_category_name: readMetadata("fbrPctCategoryName"),
            sku: product.sku,
            barcode: product.barcode,
            unit_code: product.unit_code,
            price_paisa: Number(product.price_paisa || 0),
            on_sale: Boolean(product.on_sale),
            discounted_price_paisa: product.discounted_price_paisa == null ? null : Number(product.discounted_price_paisa),
            tax_rate_bps: Number(product.tax_rate_bps || 0),
            min_stock_milli: Number(product.min_stock_milli || 0),
            reorder_point_milli: Number(product.reorder_point_milli || 0),
            max_stock_milli: Number(product.max_stock_milli || 0),
            stock_milli: stockByProduct.get(product.id) || 0,
            is_active: Boolean(product.is_active),
          };
        }),
        categories,
      });
    }

    if (module === "barcode-labels") {
      const categoryId = parameters.get("categoryId") || "";
      if (categoryId && !isUuid(categoryId)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid product category." }, 400);
      }

      const pageValue = parameters.get("page") || "1";
      const page = Number(pageValue);
      const pageSize = 60;
      if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(page) || page > 1_000_000) {
        return authenticationResponse(request, authentication, { error: "Choose a valid catalog page." }, 400);
      }

      let productsQuery = authentication.client
        .from("products")
        .select("id,name,sku,barcode,category_id,unit_code,price_paisa,on_sale,discounted_price_paisa,is_active,metadata_json", { count: "exact" })
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .order("id", { ascending: true });
      if (categoryId) productsQuery = productsQuery.eq("category_id", categoryId);
      if (search) {
        const pattern = quotedFilterValue(`%${search}%`);
        productsQuery = productsQuery.or(`name.ilike.${pattern},sku.ilike.${pattern},barcode.ilike.${pattern}`);
      }

      const start = (page - 1) * pageSize;
      const [productsResult, categoriesResult] = await Promise.all([
        productsQuery.range(start, start + pageSize - 1),
        authentication.client
          .from("categories")
          .select("id,name")
          .is("deleted_at", null)
          .order("sort_order", { ascending: true })
          .order("name", { ascending: true })
          .limit(200),
      ]);
      if (productsResult.error || categoriesResult.error) {
        throw new Error(productsResult.error?.message || categoriesResult.error?.message);
      }

      return authenticationResponse(request, authentication, {
        products: productsResult.data || [],
        total: productsResult.count || 0,
        hasMore: (productsResult.count || 0) > start + (productsResult.data || []).length,
        categories: categoriesResult.data || [],
      });
    }

    if (module === "sales") {
      const detailId = parameters.get("detailId") || "";
      const role = authentication.identity.staff.role;
      const canViewCashierNames = role === "admin" || role === "manager";

      if (detailId) {
        if (!isUuid(detailId)) {
          return authenticationResponse(request, authentication, { error: "Choose a valid sale receipt." }, 400);
        }

        const { data: sale, error: saleError } = await authentication.client
          .from("pos_sales")
          .select("id,receipt_number,branch_id,cashier_id,customer_name,customer_phone,source_type,status,tax_mode,subtotal_paisa,item_discount_paisa,bill_discount_paisa,discount_paisa,tax_paisa,rounding_paisa,total_paisa,paid_paisa,due_paisa,change_paisa,loyalty_earned,loyalty_redeemed,loyalty_discount_paisa,completed_at")
          .eq("id", detailId)
          .is("deleted_at", null)
          .maybeSingle();
        if (saleError) throw new Error(saleError.message);
        if (!sale) return authenticationResponse(request, authentication, { error: "Sale not found at your branch." }, 404);
        if (!authentication.identity.branches.some((branch) => branch.id === sale.branch_id)
          || (role === "cashier" && sale.cashier_id !== authentication.identity.staff.local_staff_id)) {
          return authenticationResponse(request, authentication, { error: "Sale not found at your branch." }, 404);
        }

        const [itemsResult, paymentsResult, returnsResult] = await Promise.all([
          authentication.client
            .from("pos_sale_items")
            .select("id,line_number,product_name,sku,unit_code,quantity_milli,unit_price_paisa,discount_paisa,tax_rate_bps,tax_paisa,line_total_paisa")
            .eq("sale_id", detailId)
            .is("deleted_at", null)
            .order("line_number", { ascending: true }),
          authentication.client
            .from("pos_sale_payments")
            .select("id,sequence_number,method,amount_paisa,tendered_paisa,reference")
            .eq("sale_id", detailId)
            .is("deleted_at", null)
            .order("sequence_number", { ascending: true }),
          authentication.client
            .from("returns")
            .select("id,return_number,status,reason,refund_total_paisa,created_at")
            .eq("sale_id", detailId)
            .is("deleted_at", null)
            .order("created_at", { ascending: false }),
        ]);
        if (itemsResult.error || paymentsResult.error || returnsResult.error) {
          throw new Error(itemsResult.error?.message || paymentsResult.error?.message || returnsResult.error?.message);
        }

        let cashierName = "Staff member";
        if (canViewCashierNames) {
          const { data: cashier, error: cashierError } = await authentication.client
            .from("staff_profiles")
            .select("full_name")
            .eq("id", sale.cashier_id)
            .is("deleted_at", null)
            .maybeSingle();
          if (cashierError) throw new Error(cashierError.message);
          cashierName = cashier?.full_name || cashierName;
        } else {
          cashierName = authentication.identity.staff.full_name;
        }

        return authenticationResponse(request, authentication, {
          sale: {
            ...sale,
            branch_name: authentication.identity.branches.find((branch) => branch.id === sale.branch_id)?.name || "Branch",
            cashier_name: cashierName,
          },
          items: itemsResult.data || [],
          payments: paymentsResult.data || [],
          returns: returnsResult.data || [],
        });
      }

      const requestedBranch = parameters.get("branchId") || "";
      if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
      }
      const hqAdmin = isHqAdmin(authentication.identity.staff);
      const branchId = hqAdmin
        ? requestedBranch && requestedBranch !== "all" ? requestedBranch : null
        : authentication.identity.staff.branch_id;
      if (branchId && !authentication.identity.branches.some((branch) => branch.id === branchId)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }
      if (!branchId && !hqAdmin) {
        return authenticationResponse(request, authentication, { error: "Choose a branch before viewing sales." }, 400);
      }

      const from = parameters.get("from") || "";
      const to = parameters.get("to") || "";
      if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to))) {
        return authenticationResponse(request, authentication, { error: "Choose valid calendar dates." }, 400);
      }
      if (from && to && from > to) {
        return authenticationResponse(request, authentication, { error: "The start date must be on or before the end date." }, 400);
      }

      const status = parameters.get("status") || "all";
      if (!["all", "completed", "void", "refunded", "partially_refunded"].includes(status)) {
        return authenticationResponse(request, authentication, { error: "Choose a supported sales status filter." }, 400);
      }

      const pageValue = parameters.get("page") || "1";
      const pageSizeValue = parameters.get("pageSize") || "25";
      const page = Number(pageValue);
      const pageSize = Number(pageSizeValue);
      if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(page) || page > 1_000_000
        || !/^[1-9]\d*$/.test(pageSizeValue) || !Number.isSafeInteger(pageSize) || pageSize > 100) {
        return authenticationResponse(request, authentication, { error: "Choose a valid sales page." }, 400);
      }

      const cashierId = parameters.get("cashierId") || "";
      if (cashierId === "self" && role !== "cashier") {
        return authenticationResponse(request, authentication, { error: "That cashier filter is not available." }, 403);
      }
      if (cashierId && (role === "cashier" ? cashierId !== "self" : !isUuid(cashierId))) {
        return authenticationResponse(request, authentication, { error: "Choose a valid cashier filter." }, 400);
      }

      const linkedStaffId = role === "cashier" ? authentication.identity.staff.local_staff_id : null;
      if (role === "cashier" && !linkedStaffId) {
        return authenticationResponse(request, authentication, { error: "This account is not linked to a staff profile." }, 403);
      }

      let query = authentication.client
        .from("pos_sales")
        .select("id,receipt_number,branch_id,cashier_id,customer_name,customer_phone,source_type,status,tax_mode,subtotal_paisa,item_discount_paisa,bill_discount_paisa,discount_paisa,tax_paisa,rounding_paisa,total_paisa,paid_paisa,due_paisa,change_paisa,loyalty_earned,loyalty_redeemed,loyalty_discount_paisa,completed_at", { count: "exact" })
        .is("deleted_at", null)
        .order("completed_at", { ascending: false })
        .order("id", { ascending: false });
      if (branchId) query = query.eq("branch_id", branchId);
      if (search) {
        const pattern = quotedFilterValue(`%${search}%`);
        query = query.or(`receipt_number.ilike.${pattern},customer_phone.ilike.${pattern}`);
      }
      const customer = (parameters.get("customer") || "").trim().slice(0, 80);
      if (customer) query = query.ilike("customer_name", `%${escapedSearch(customer)}%`);
      if (status !== "all") query = query.eq("status", status);
      if (role === "cashier" && linkedStaffId) query = query.eq("cashier_id", linkedStaffId);
      else if (cashierId) query = query.eq("cashier_id", cashierId);
      if (from) query = query.gte("completed_at", pakistanDateBoundary(from));
      if (to) query = query.lt("completed_at", pakistanDateBoundary(to, true));

      const { data, count, error } = await query.range((page - 1) * pageSize, page * pageSize - 1);
      if (error) throw new Error(error.message);
      const sales = data || [];
      const saleIds = sales.map((sale) => sale.id);
      let unitCounts = new Map<string, number>();
      let paymentMethods = new Map<string, Set<string>>();
      if (saleIds.length) {
        const [itemsResult, paymentsResult] = await Promise.all([
          authentication.client
            .from("pos_sale_items")
            .select("sale_id,quantity_milli")
            .in("sale_id", saleIds)
            .is("deleted_at", null),
          authentication.client
            .from("pos_sale_payments")
            .select("sale_id,method")
            .in("sale_id", saleIds)
            .is("deleted_at", null),
        ]);
        if (itemsResult.error || paymentsResult.error) {
          throw new Error(itemsResult.error?.message || paymentsResult.error?.message);
        }
        unitCounts = new Map();
        for (const line of itemsResult.data || []) {
          unitCounts.set(line.sale_id, (unitCounts.get(line.sale_id) || 0) + line.quantity_milli);
        }
        paymentMethods = new Map();
        for (const payment of paymentsResult.data || []) {
          const methods = paymentMethods.get(payment.sale_id) || new Set<string>();
          methods.add(payment.method);
          paymentMethods.set(payment.sale_id, methods);
        }
      }

      let staffProfiles: Array<{ id: string; full_name: string }> = [];
      if (canViewCashierNames) {
        let staffQuery = authentication.client
          .from("staff_profiles")
          .select("id,full_name")
          .eq("is_active", true)
          .is("deleted_at", null)
          .order("full_name", { ascending: true })
          .limit(500);
        if (branchId) staffQuery = staffQuery.eq("branch_id", branchId);
        else if (authentication.identity.branches.length) {
          staffQuery = staffQuery.in("branch_id", authentication.identity.branches.map((branch) => branch.id));
        }
        const { data: staffData, error: staffError } = await staffQuery;
        if (staffError) throw new Error(staffError.message);
        staffProfiles = staffData || [];
      }
      const staffNames = new Map(staffProfiles.map((profile) => [profile.id, profile.full_name]));
      const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));

      return authenticationResponse(request, authentication, {
        rows: sales.map((sale) => ({
          ...sale,
          branch_name: branchNames.get(sale.branch_id) || "Branch",
          cashier_name: canViewCashierNames
            ? staffNames.get(sale.cashier_id) || "Staff member"
            : sale.cashier_id === linkedStaffId ? authentication.identity.staff.full_name : "Staff member",
          unit_count_milli: unitCounts.get(sale.id) || 0,
          payment_methods: [...(paymentMethods.get(sale.id) || [])],
        })),
        total: count || 0,
        cashiers: canViewCashierNames
          ? staffProfiles.map((profile) => ({ id: profile.id, name: profile.full_name }))
          : [{ id: "self", name: "My sales" }],
      });
    }

    if (module === "returns") {
      const detailId = parameters.get("detailId") || "";
      const role = authentication.identity.staff.role;

      if (detailId) {
        if (!isUuid(detailId)) {
          return authenticationResponse(request, authentication, { error: "Choose a valid return." }, 400);
        }

        const { data: returnRecord, error: returnError } = await authentication.client
          .from("returns")
          .select("id,return_number,branch_id,sale_id,shift_id,status,reason,notes,refund_total_paisa,restock_total_milli,created_by,approved_by,approved_at,rejected_by,rejected_at,rejection_reason,completed_by,completed_at,created_at")
          .eq("id", detailId)
          .is("deleted_at", null)
          .maybeSingle();
        if (returnError) throw new Error(returnError.message);
        if (!returnRecord) return authenticationResponse(request, authentication, { error: "Return not found at your branch." }, 404);
        if (!authentication.identity.branches.some((branch) => branch.id === returnRecord.branch_id)
          || (role === "cashier"
            && (!authentication.identity.staff.local_staff_id
              || !cashierCanViewReturn(returnRecord, authentication.identity.staff.local_staff_id)))) {
          return authenticationResponse(request, authentication, { error: "Return not found at your branch." }, 404);
        }

        const [saleResult, itemsResult, refundsResult] = await Promise.all([
          authentication.client
            .from("pos_sales")
            .select("id,receipt_number,customer_name,total_paisa")
            .eq("id", returnRecord.sale_id)
            .is("deleted_at", null)
            .maybeSingle(),
          authentication.client
            .from("return_items")
            .select("id,product_name,unit_code,quantity_milli,unit_price_paisa,line_refund_paisa,condition,restock")
            .eq("return_id", detailId)
            .is("deleted_at", null)
            .order("created_at", { ascending: true }),
          authentication.client
            .from("return_refunds")
            .select("id,method,amount_paisa,credited_paisa,status,reference,processed_at")
            .eq("return_id", detailId)
            .is("deleted_at", null)
            .order("created_at", { ascending: true }),
        ]);
        if (saleResult.error || itemsResult.error || refundsResult.error) {
          throw new Error(saleResult.error?.message || itemsResult.error?.message || refundsResult.error?.message);
        }
        if (!saleResult.data) throw new Error("The linked sale receipt could not be loaded.");

        const { data: actorRows, error: actorError } = await authentication.client
          .rpc("get_return_actor_names", { p_return_id: detailId });
        if (actorError) throw new Error(actorError.message);
        const staffNames = new Map((actorRows || []).map((actor) => [actor.actor_id, actor.full_name]));

        return authenticationResponse(request, authentication, {
          ...returnRecord,
          receipt_number: saleResult.data.receipt_number,
          customer_name: saleResult.data.customer_name,
          sale_total_paisa: saleResult.data.total_paisa,
          branch_name: authentication.identity.branches.find((branch) => branch.id === returnRecord.branch_id)?.name || "Branch",
          created_by_name: staffNames.get(returnRecord.created_by) || "Staff member",
          created_by_is_current: returnRecord.created_by === authentication.identity.staff.local_staff_id,
          approved_by_name: returnRecord.approved_by ? staffNames.get(returnRecord.approved_by) || "Staff member" : null,
          rejected_by_name: returnRecord.rejected_by ? staffNames.get(returnRecord.rejected_by) || "Staff member" : null,
          completed_by_name: returnRecord.completed_by ? staffNames.get(returnRecord.completed_by) || "Staff member" : null,
          items: itemsResult.data || [],
          refunds: (refundsResult.data || []).map((refund) => ({
            ...refund,
            paid_out_paisa: refund.amount_paisa - refund.credited_paisa,
          })),
        });
      }

      const requestedBranch = parameters.get("branchId") || "";
      if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
      }
      const hqAdmin = isHqAdmin(authentication.identity.staff);
      const branchId = hqAdmin
        ? requestedBranch && requestedBranch !== "all" ? requestedBranch : null
        : authentication.identity.staff.branch_id;
      if (branchId && !authentication.identity.branches.some((branch) => branch.id === branchId)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }
      if (!branchId && !hqAdmin) {
        return authenticationResponse(request, authentication, { error: "Choose a branch before viewing returns." }, 400);
      }

      const from = parameters.get("from") || "";
      const to = parameters.get("to") || "";
      if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to))) {
        return authenticationResponse(request, authentication, { error: "Choose valid calendar dates." }, 400);
      }
      if (from && to && from > to) {
        return authenticationResponse(request, authentication, { error: "The start date must be on or before the end date." }, 400);
      }

      const status = parameters.get("status") || "all";
      if (!["all", "pending", "approved", "rejected", "completed", "cancelled"].includes(status)) {
        return authenticationResponse(request, authentication, { error: "Choose a valid return status." }, 400);
      }

      let query = authentication.client
        .from("returns")
        .select("id,return_number,branch_id,sale_id,status,reason,refund_total_paisa,restock_total_milli,created_by,created_at,completed_at", { count: "exact" })
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      if (branchId) query = query.eq("branch_id", branchId);
      if (role === "cashier") {
        const staffId = authentication.identity.staff.local_staff_id;
        if (!staffId) {
          return authenticationResponse(request, authentication, { error: "This account is not linked to a staff profile." }, 403);
        }
        query = query.or(cashierReturnVisibilityFilter(staffId));
      }
      if (status !== "all") query = query.eq("status", status);
      if (from) query = query.gte("created_at", pakistanDateBoundary(from));
      if (to) query = query.lt("created_at", pakistanDateBoundary(to, true));

      const { data, count, error } = await query.range(0, 499);
      if (error) throw new Error(error.message);
      const returnRows = data || [];
      const saleIds = [...new Set(returnRows.map((returnRecord) => returnRecord.sale_id))];
      let saleDetails = new Map<string, { receipt_number: string; customer_name: string }>();
      if (saleIds.length) {
        const { data: sales, error: salesError } = await authentication.client
          .from("pos_sales")
          .select("id,receipt_number,customer_name")
          .in("id", saleIds)
          .is("deleted_at", null);
        if (salesError) throw new Error(salesError.message);
        saleDetails = new Map((sales || []).map((sale) => [sale.id, {
          receipt_number: sale.receipt_number,
          customer_name: sale.customer_name,
        }]));
      }
      const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
      const mappedRows = returnRows.map((returnRecord) => {
        const sale = saleDetails.get(returnRecord.sale_id);
        return {
          ...returnRecord,
          branch_name: branchNames.get(returnRecord.branch_id) || "Branch",
          receipt_number: sale?.receipt_number || "—",
          customer_name: sale?.customer_name || "Walk-in Customer",
        };
      });
      const normalizedSearch = search.toLocaleLowerCase();
      const filteredRows = normalizedSearch
        ? mappedRows.filter((returnRecord) => [
          returnRecord.return_number,
          returnRecord.receipt_number,
          returnRecord.customer_name,
        ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch)))
        : mappedRows;
      const pageValue = parameters.get("page") || "1";
      const page = Number(pageValue);
      const pageSize = 25;
      if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(page) || page > 1_000_000) {
        return authenticationResponse(request, authentication, { error: "Choose a valid returns page." }, 400);
      }
      const start = (page - 1) * pageSize;

      return authenticationResponse(request, authentication, {
        rows: filteredRows.slice(start, start + pageSize),
        total: filteredRows.length,
        capped: (count || 0) > returnRows.length,
      });
    }

    return authenticationResponse(request, authentication, { error: "This workspace page has no live data endpoint yet." }, 404);
  } catch (error) {
    console.error(`Could not load workspace data for ${module}.`, error);
    return authenticationResponse(
      request,
      authentication,
      { error: `The ${module} list could not be loaded. Please try again.` },
      503,
    );
  }
}
