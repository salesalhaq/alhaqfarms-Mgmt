import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

const VALID_REPORTS = new Set(["sales", "returns", "payments", "tax"]);

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function endOfDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+05:00`).toISOString();
}

function startOfDay(value: string): string {
  return new Date(`${value}T00:00:00+05:00`).toISOString();
}

function toCurrencyGroup(rows: Array<{ method: string; amount_paisa: number }>) {
  return Object.entries(
    rows.reduce<Record<string, number>>((accumulator, row) => {
      accumulator[row.method] = (accumulator[row.method] || 0) + Number(row.amount_paisa || 0);
      return accumulator;
    }, {}),
  ).map(([method, total]) => ({ method, total }));
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const parameters = new URL(request.url).searchParams;
  const reportType = (parameters.get("report") || "sales").toLowerCase();
  if (!VALID_REPORTS.has(reportType)) {
    return authenticationResponse(request, authentication, { error: "Choose a supported report type." }, 400);
  }

  const fromDate = parameters.get("from") || "";
  const toDate = parameters.get("to") || "";
  if (!isValidDate(fromDate) || !isValidDate(toDate)) {
    return authenticationResponse(request, authentication, { error: "Choose valid dates for the report window." }, 400);
  }
  if (new Date(`${toDate}T00:00:00.000Z`).getTime() < new Date(`${fromDate}T00:00:00.000Z`).getTime()) {
    return authenticationResponse(request, authentication, { error: "The report end date must be on or after the start date." }, 400);
  }

  const requestedBranch = parameters.get("branchId") || "";
  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }

  const accessibleBranchIds = authentication.identity.branches.map((branch) => branch.id);
  const allBranchesLabel = "All accessible branches";

  let selectedBranchIds: string[] = accessibleBranchIds;
  if (authentication.identity.staff.role === "admin") {
    if (requestedBranch && requestedBranch !== "all") {
      if (!accessibleBranchIds.includes(requestedBranch)) {
        return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
      }
      selectedBranchIds = [requestedBranch];
    }
  } else {
    if (requestedBranch && requestedBranch !== "all" && requestedBranch !== authentication.identity.staff.branch_id) {
      return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
    }
    if (!authentication.identity.staff.branch_id) {
      return authenticationResponse(request, authentication, { error: "Choose a branch before viewing reports." }, 400);
    }
    selectedBranchIds = [authentication.identity.staff.branch_id];
  }

  const displayBranchName = selectedBranchIds.length === 1
    ? authentication.identity.branches.find((branch) => branch.id === selectedBranchIds[0])?.name || "Your branch"
    : allBranchesLabel;

  const fromIso = startOfDay(fromDate);
  const toIso = endOfDay(toDate);

  const saleQuery = authentication.client
    .from("pos_sales")
    .select("id, branch_id, total_paisa, discount_paisa, tax_paisa, paid_paisa, completed_at")
    .is("deleted_at", null)
    .neq("status", "void")
    .gte("completed_at", fromIso)
    .lt("completed_at", toIso)
    .in("branch_id", selectedBranchIds);

  const returnQuery = authentication.client
    .from("returns")
    .select("id, branch_id, refund_total_paisa, created_at")
    .is("deleted_at", null)
    .eq("status", "completed")
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .in("branch_id", selectedBranchIds);

  const saleIdsPromise = authentication.client
    .from("pos_sales")
    .select("id")
    .is("deleted_at", null)
    .neq("status", "void")
    .gte("completed_at", fromIso)
    .lt("completed_at", toIso)
    .in("branch_id", selectedBranchIds)
    .then(({ data, error }) => {
      if (error) throw new Error(error.message);
      return (data || []).map((row) => row.id);
    });

  const [saleResult, returnResult, saleIds] = await Promise.all([
    saleQuery,
    returnQuery,
    saleIdsPromise,
  ]);

  if (saleResult.error) throw new Error(saleResult.error.message);
  if (returnResult.error) throw new Error(returnResult.error.message);

  const sales = saleResult.data || [];
  const returns = returnResult.data || [];
  const paymentResult = saleIds.length
    ? await authentication.client
      .from("pos_sale_payments")
      .select("sale_id, method, amount_paisa")
      .in("sale_id", saleIds)
      .is("deleted_at", null)
    : { data: [] as Array<{ sale_id: string; method: string; amount_paisa: number }>, error: null };

  if (paymentResult.error) throw new Error(paymentResult.error.message);

  const paymentRows = paymentResult.data || [];
  const paymentByMethod = toCurrencyGroup(paymentRows as Array<{ method: string; amount_paisa: number }>);

  const summary = {
    grossSalesPaisa: sales.reduce((total, sale) => total + Number(sale.total_paisa || 0), 0),
    refundsPaisa: returns.reduce((total, row) => total + Number(row.refund_total_paisa || 0), 0),
    netSalesPaisa: 0,
    receiptCount: sales.length,
    averageTicketPaisa: sales.length ? Math.round(
      sales.reduce((total, sale) => total + Number(sale.total_paisa || 0), 0) / sales.length,
    ) : 0,
    discountPaisa: sales.reduce((total, sale) => total + Number(sale.discount_paisa || 0), 0),
    taxPaisa: sales.reduce((total, sale) => total + Number(sale.tax_paisa || 0), 0),
  };
  summary.netSalesPaisa = summary.grossSalesPaisa - summary.refundsPaisa;

  const rows = (() => {
    if (reportType === "sales") {
      return [
        {
          label: "Gross sales",
          branch: displayBranchName,
          valuePaisa: summary.grossSalesPaisa,
          secondary: `${summary.receiptCount} receipts`,
          tone: "green",
        },
        {
          label: "Refunds",
          branch: displayBranchName,
          valuePaisa: summary.refundsPaisa,
          secondary: `${summary.grossSalesPaisa ? Math.round((summary.refundsPaisa / summary.grossSalesPaisa) * 100 || 0) : 0}% of sales`,
          tone: "amber",
        },
        {
          label: "Net sales",
          branch: displayBranchName,
          valuePaisa: summary.netSalesPaisa,
          secondary: `${summary.grossSalesPaisa ? Math.round((summary.discountPaisa / summary.grossSalesPaisa) * 100 || 0) : 0}% discounts`,
          tone: "blue",
        },
      ];
    }

    if (reportType === "returns") {
      return [
        {
          label: "Returned value",
          branch: displayBranchName,
          valuePaisa: summary.refundsPaisa,
          secondary: `${returns.length} completed returns`,
          tone: "amber",
        },
        {
          label: "Gross sales",
          branch: displayBranchName,
          valuePaisa: summary.grossSalesPaisa,
          secondary: `${summary.receiptCount} receipts`,
          tone: "green",
        },
        {
          label: "Tax collected",
          branch: displayBranchName,
          valuePaisa: summary.taxPaisa,
          secondary: `${summary.grossSalesPaisa ? Math.round((summary.taxPaisa / summary.grossSalesPaisa) * 100 || 0) : 0}% of sales`,
          tone: "purple",
        },
      ];
    }

    if (reportType === "payments") {
      return paymentByMethod.length
        ? paymentByMethod.map((entry) => ({
            label: entry.method,
            branch: displayBranchName,
            valuePaisa: entry.total,
            secondary: `${summary.grossSalesPaisa ? Math.round((entry.total / summary.grossSalesPaisa) * 100 || 0) : 0}% of sales`,
            tone: "blue",
          }))
        : [{
            label: "No payment data",
            branch: displayBranchName,
            valuePaisa: 0,
            secondary: "No completed payments in this window",
            tone: "amber",
          }];
    }

    return [
      {
        label: "Tax collected",
        branch: displayBranchName,
        valuePaisa: summary.taxPaisa,
        secondary: `${summary.receiptCount} receipts`,
        tone: "purple",
      },
      {
        label: "Gross sales",
        branch: displayBranchName,
        valuePaisa: summary.grossSalesPaisa,
        secondary: `${summary.averageTicketPaisa} avg ticket`,
        tone: "green",
      },
      {
        label: "Discounts",
        branch: displayBranchName,
        valuePaisa: summary.discountPaisa,
        secondary: `${summary.grossSalesPaisa ? Math.round((summary.discountPaisa / summary.grossSalesPaisa) * 100 || 0) : 0}% discount rate`,
        tone: "amber",
      },
    ];
  })();

  return authenticationResponse(request, authentication, {
    branchId: selectedBranchIds.length === 1 ? selectedBranchIds[0] : null,
    branchName: displayBranchName,
    report: reportType,
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  });
}
