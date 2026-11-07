import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1_000;
const SALE_LIMIT = 20_000;
const RETURN_LIMIT = 10_000;
const ITEM_LIMIT = 20_000;
const ID_CHUNK = 200;
const PRODUCT_LIMIT = 25;

type SaleRow = {
  id: string;
  branch_id: string;
  total_paisa: number;
  tax_paisa: number;
  discount_paisa: number;
  cost_total_paisa: number;
  status: string;
  completed_at: string;
};

type ReturnRow = {
  id: string;
  branch_id: string;
  completed_at: string | null;
  created_at: string;
};

type SaleItemRow = {
  id: string;
  sale_id: string;
  product_name: string;
  sku: string | null;
  quantity_milli: number;
  unit_cost_paisa: number;
  tax_rate_bps: number;
  tax_paisa: number;
  line_total_paisa: number;
};

type ReturnItemRow = {
  return_id: string;
  sale_item_id: string;
  product_name: string;
  quantity_milli: number;
  line_refund_paisa: number;
  restock: boolean;
};

type SaleItemInfo = {
  product_name: string;
  sku: string | null;
  unit_cost_paisa: number;
  tax_rate_bps: number;
};

type DayTotals = {
  day: string;
  receipts: number;
  revenue: number;
  tax: number;
  cost: number;
  refund: number;
  refundTax: number;
  refundCostNumerator: number;
};

function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function normalizeDate(day: string, nextDay = false): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error("Choose a valid date.");
  if (nextDay) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+05:00`).toISOString();
}

function pakistanDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

// Refunds are recorded tax-inclusive, exactly like sale lines. Split the
// embedded tax back out so it is never subtracted twice from net sales.
function refundTaxPaisa(lineRefundPaisa: number, rateBps: number): number {
  if (!rateBps) return 0;
  return Math.round((lineRefundPaisa * rateBps) / (10_000 + rateBps));
}

function costNumerator(quantityMilli: number, unitCostPaisa: number): number {
  return quantityMilli * unitCostPaisa;
}

function numeratorToPaisa(numerator: number): number {
  return Math.round(numerator / 1_000);
}

function marginBps(profitPaisa: number, netSalesPaisa: number): number {
  return netSalesPaisa > 0 ? Math.round((profitPaisa * 10_000) / netSalesPaisa) : 0;
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const role = authentication.identity.staff.role;
  if (role !== "admin") {
    return authenticationResponse(
      request,
      authentication,
      { error: "Profit and tax reporting is available to administrators only." },
      403,
    );
  }

  const parameters = new URL(request.url).searchParams;
  const fromValue = (parameters.get("from") || "").trim();
  const toValue = (parameters.get("to") || "").trim();
  const requestedBranch = (parameters.get("branchId") || "").trim();

  if (!isCalendarDate(fromValue) || !isCalendarDate(toValue)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid date range." }, 400);
  }

  if (fromValue > toValue) {
    return authenticationResponse(request, authentication, { error: "The start date must be on or before the end date." }, 400);
  }

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  const allowedBranches = authentication.identity.branches.map((branch) => branch.id);
  if (requestedBranch && requestedBranch !== "all" && !allowedBranches.includes(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }

  const branchScope = requestedBranch && requestedBranch !== "all" ? requestedBranch : null;
  const branchIdList = branchScope ? [branchScope] : allowedBranches;
  const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
  const branchName = branchScope ? branchNames.get(branchScope) ?? "Selected branch" : "All accessible branches";

  if (!branchIdList.length) {
    return authenticationResponse(request, authentication, {
      from: fromValue,
      to: toValue,
      branchId: branchScope,
      branchName: "No accessible branch",
      summary: {
        receipts: 0, revenuePaisa: 0, taxPaisa: 0, discountPaisa: 0, refundPaisa: 0,
        refundTaxPaisa: 0, refunds: 0, netSalesPaisa: 0, costPaisa: 0, profitPaisa: 0, marginBps: 0,
      },
      byDay: [],
      byProduct: [],
      byTaxRate: [],
      truncated: false,
    });
  }

  const startDate = normalizeDate(fromValue, false);
  const endDate = normalizeDate(toValue, true);

  try {
    const sales: SaleRow[] = [];
    for (let offset = 0; offset < SALE_LIMIT; offset += PAGE_SIZE) {
      const { data, error } = await authentication.client
        .from("pos_sales")
        .select("id,branch_id,total_paisa,tax_paisa,discount_paisa,cost_total_paisa,status,completed_at")
        .is("deleted_at", null)
        .neq("status", "void")
        .gte("completed_at", startDate)
        .lt("completed_at", endDate)
        .in("branch_id", branchIdList)
        .order("completed_at", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      const page = (data || []) as SaleRow[];
      sales.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const returns: ReturnRow[] = [];
    for (let offset = 0; offset < RETURN_LIMIT; offset += PAGE_SIZE) {
      const { data, error } = await authentication.client
        .from("returns")
        .select("id,branch_id,completed_at,created_at")
        .is("deleted_at", null)
        .eq("status", "completed")
        .gte("completed_at", startDate)
        .lt("completed_at", endDate)
        .in("branch_id", branchIdList)
        .order("completed_at", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      const page = (data || []) as ReturnRow[];
      returns.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    let itemsTruncated = false;

    const saleItems: SaleItemRow[] = [];
    for (const ids of chunk(sales.map((sale) => sale.id), ID_CHUNK)) {
      for (let offset = 0; offset < ITEM_LIMIT; offset += PAGE_SIZE) {
        const { data, error } = await authentication.client
          .from("pos_sale_items")
          .select("id,sale_id,product_name,sku,quantity_milli,unit_cost_paisa,tax_rate_bps,tax_paisa,line_total_paisa")
          .in("sale_id", ids)
          .is("deleted_at", null)
          .order("created_at", { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw new Error(error.message);
        const page = (data || []) as SaleItemRow[];
        saleItems.push(...page);
        if (page.length < PAGE_SIZE) break;
        if (offset + PAGE_SIZE >= ITEM_LIMIT) itemsTruncated = true;
      }
    }

    const returnItems: ReturnItemRow[] = [];
    for (const ids of chunk(returns.map((entry) => entry.id), ID_CHUNK)) {
      for (let offset = 0; offset < ITEM_LIMIT; offset += PAGE_SIZE) {
        const { data, error } = await authentication.client
          .from("return_items")
          .select("return_id,sale_item_id,product_name,quantity_milli,line_refund_paisa,restock")
          .in("return_id", ids)
          .is("deleted_at", null)
          .order("created_at", { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw new Error(error.message);
        const page = (data || []) as ReturnItemRow[];
        returnItems.push(...page);
        if (page.length < PAGE_SIZE) break;
        if (offset + PAGE_SIZE >= ITEM_LIMIT) itemsTruncated = true;
      }
    }

    // Refunded lines point at the original sale item, which may belong to a
    // sale outside the reporting range. Resolve any item not already loaded.
    const itemInfo = new Map<string, SaleItemInfo>();
    for (const item of saleItems) {
      itemInfo.set(item.id, {
        product_name: item.product_name,
        sku: item.sku,
        unit_cost_paisa: asNumber(item.unit_cost_paisa),
        tax_rate_bps: asNumber(item.tax_rate_bps),
      });
    }

    const missingItemIds = [...new Set(returnItems.map((item) => item.sale_item_id))]
      .filter((id) => id && !itemInfo.has(id));
    for (const ids of chunk(missingItemIds, ID_CHUNK)) {
      const { data, error } = await authentication.client
        .from("pos_sale_items")
        .select("id,product_name,sku,unit_cost_paisa,tax_rate_bps")
        .in("id", ids)
        .is("deleted_at", null)
        .limit(PAGE_SIZE);
      if (error) throw new Error(error.message);
      for (const item of (data || []) as Array<{
        id: string; product_name: string; sku: string | null; unit_cost_paisa: number; tax_rate_bps: number;
      }>) {
        itemInfo.set(item.id, {
          product_name: item.product_name,
          sku: item.sku,
          unit_cost_paisa: asNumber(item.unit_cost_paisa),
          tax_rate_bps: asNumber(item.tax_rate_bps),
        });
      }
    }

    const returnDay = new Map<string, string>();
    for (const entry of returns) {
      returnDay.set(entry.id, pakistanDayKey(entry.completed_at || entry.created_at));
    }

    const days = new Map<string, DayTotals>();
    const dayRow = (day: string): DayTotals => {
      const existing = days.get(day);
      if (existing) return existing;
      const created: DayTotals = {
        day, receipts: 0, revenue: 0, tax: 0, cost: 0, refund: 0, refundTax: 0, refundCostNumerator: 0,
      };
      days.set(day, created);
      return created;
    };

    let refundTotal = 0;
    let refundTaxTotal = 0;
    let refundedCostNumerator = 0;

    for (const sale of sales) {
      const entry = dayRow(pakistanDayKey(sale.completed_at));
      entry.receipts += 1;
      entry.revenue += asNumber(sale.total_paisa);
      entry.tax += asNumber(sale.tax_paisa);
      entry.cost += asNumber(sale.cost_total_paisa);
    }

    type ProductTotals = {
      product_name: string;
      sku: string | null;
      quantity: number;
      netSales: number;
      tax: number;
      costNumerator: number;
    };
    const productRows = new Map<string, ProductTotals>();
    const productKey = (name: string, sku: string | null) => `${name}\u0000${sku || ""}`;
    const productRow = (name: string, sku: string | null): ProductTotals => {
      const key = productKey(name, sku);
      const existing = productRows.get(key);
      if (existing) return existing;
      const created: ProductTotals = { product_name: name, sku, quantity: 0, netSales: 0, tax: 0, costNumerator: 0 };
      productRows.set(key, created);
      return created;
    };

    type RateTotals = { rate_bps: number; lines: number; netSales: number; tax: number };
    const rateRows = new Map<number, RateTotals>();
    const rateRow = (rateBps: number): RateTotals => {
      const existing = rateRows.get(rateBps);
      if (existing) return existing;
      const created: RateTotals = { rate_bps: rateBps, lines: 0, netSales: 0, tax: 0 };
      rateRows.set(rateBps, created);
      return created;
    };

    for (const item of saleItems) {
      const quantity = asNumber(item.quantity_milli);
      const gross = asNumber(item.line_total_paisa);
      const tax = asNumber(item.tax_paisa);
      const numerator = costNumerator(quantity, asNumber(item.unit_cost_paisa));
      const rate = asNumber(item.tax_rate_bps);

      const product = productRow(item.product_name, item.sku);
      product.quantity += quantity;
      product.netSales += gross - tax;
      product.tax += tax;
      product.costNumerator += numerator;

      const rateEntry = rateRow(rate);
      rateEntry.lines += 1;
      rateEntry.netSales += gross - tax;
      rateEntry.tax += tax;
    }

    for (const item of returnItems) {
      const info = itemInfo.get(item.sale_item_id);
      const lineRefund = asNumber(item.line_refund_paisa);
      const rate = info?.tax_rate_bps || 0;
      const tax = refundTaxPaisa(lineRefund, rate);
      const restockedNumerator = item.restock && info
        ? costNumerator(asNumber(item.quantity_milli), info.unit_cost_paisa)
        : 0;

      refundTotal += lineRefund;
      refundTaxTotal += tax;
      refundedCostNumerator += restockedNumerator;

      const day = returnDay.get(item.return_id);
      if (day) {
        const entry = dayRow(day);
        entry.refund += lineRefund;
        entry.refundTax += tax;
        entry.refundCostNumerator += restockedNumerator;
      }

      const name = info?.product_name || item.product_name;
      const sku = info?.sku ?? null;
      const product = productRow(name, sku);
      product.quantity -= asNumber(item.quantity_milli);
      product.netSales -= lineRefund - tax;
      product.tax -= tax;
      product.costNumerator -= restockedNumerator;

      const rateEntry = rateRow(rate);
      rateEntry.netSales -= lineRefund - tax;
      rateEntry.tax -= tax;
    }

    const byDay = [...days.values()]
      .sort((left, right) => (left.day < right.day ? 1 : -1))
      .map((row) => {
        const netSalesPaisa = row.revenue - row.tax - (row.refund - row.refundTax);
        const netCostPaisa = row.cost - numeratorToPaisa(row.refundCostNumerator);
        const profitPaisa = netSalesPaisa - netCostPaisa;
        return {
          day: row.day,
          receipts: row.receipts,
          refundPaisa: row.refund,
          netSalesPaisa,
          taxPaisa: row.tax - row.refundTax,
          costPaisa: netCostPaisa,
          profitPaisa,
          marginBps: marginBps(profitPaisa, netSalesPaisa),
        };
      });

    const byProduct = [...productRows.values()]
      .map((row) => {
        const costPaisa = numeratorToPaisa(row.costNumerator);
        const profitPaisa = row.netSales - costPaisa;
        return {
          product_name: row.product_name,
          sku: row.sku,
          quantity: row.quantity,
          netSalesPaisa: row.netSales,
          taxPaisa: row.tax,
          costPaisa,
          profitPaisa,
          marginBps: marginBps(profitPaisa, row.netSales),
        };
      })
      .sort((left, right) => right.profitPaisa - left.profitPaisa)
      .slice(0, PRODUCT_LIMIT);

    const byTaxRate = [...rateRows.values()].sort((left, right) => left.rate_bps - right.rate_bps);

    const revenuePaisa = sales.reduce((total, sale) => total + asNumber(sale.total_paisa), 0);
    const salesTaxPaisa = sales.reduce((total, sale) => total + asNumber(sale.tax_paisa), 0);
    const discountPaisa = sales.reduce((total, sale) => total + asNumber(sale.discount_paisa), 0);
    const salesCostPaisa = sales.reduce((total, sale) => total + asNumber(sale.cost_total_paisa), 0);

    const netSalesPaisa = revenuePaisa - salesTaxPaisa - (refundTotal - refundTaxTotal);
    const costPaisa = salesCostPaisa - numeratorToPaisa(refundedCostNumerator);
    const profitPaisa = netSalesPaisa - costPaisa;

    const truncated =
      sales.length >= SALE_LIMIT
      || returns.length >= RETURN_LIMIT
      || itemsTruncated;

    return authenticationResponse(request, authentication, {
      from: fromValue,
      to: toValue,
      branchId: branchScope,
      branchName,
      summary: {
        receipts: sales.length,
        revenuePaisa,
        taxPaisa: salesTaxPaisa - refundTaxTotal,
        discountPaisa,
        refundPaisa: refundTotal,
        refundTaxPaisa: refundTaxTotal,
        refunds: returns.length,
        netSalesPaisa,
        costPaisa,
        profitPaisa,
        marginBps: marginBps(profitPaisa, netSalesPaisa),
      },
      byDay,
      byProduct,
      byTaxRate,
      truncated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the profit and tax report.";
    return authenticationResponse(request, authentication, { error: message }, 500);
  }
}
