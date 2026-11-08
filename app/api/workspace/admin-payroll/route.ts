import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

interface EmployeeRow {
  id: string;
  branch_id: string | null;
  full_name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  department_id: string | null;
  is_active: boolean;
}

interface DepartmentRow {
  id: string;
  branch_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

interface CompensationRow {
  id: string;
  staff_id: string;
  base_salary_paisa: number;
  allowances_paisa: number;
  effective_from: string;
}

interface AttendanceRow {
  staff_id: string;
  branch_id: string;
  attendance_date: string;
  status: string;
}

interface PayrollRunRow {
  id: string;
  branch_id: string;
  period_start: string;
  period_end: string;
  status: string;
  working_days: number;
  staff_count: number;
  gross_paisa: number;
  attendance_deduction_paisa: number;
  advance_deduction_paisa: number;
  net_paisa: number;
  notes: string | null;
  created_at: string;
  paid_at: string | null;
  voided_at: string | null;
}

interface PayrollItemRow {
  id: string;
  run_id: string;
  staff_id: string;
  staff_name: string;
  role: string;
  base_salary_paisa: number;
  allowances_paisa: number;
  working_days: number;
  present_days: number;
  absent_days: number;
  half_days: number;
  leave_days: number;
  attendance_deduction_paisa: number;
  advance_deduction_paisa: number;
  gross_paisa: number;
  net_paisa: number;
  notes: string | null;
  department_id: string | null;
  department_name: string | null;
  tax_withheld_paisa: number;
}

interface RecoveryRow {
  id: string;
  run_id: string;
  staff_id: string;
  advance_id: string;
  amount_paisa: number;
}

interface AdvanceRow {
  id: string;
  staff_id: string;
  advance_date: string;
  amount_paisa: number;
}

interface AttendanceTotals {
  present: number;
  absent: number;
  half: number;
  leave: number;
  recorded: number;
}

interface PayrollTotals {
  grossPaisa: number;
  deductionsPaisa: number;
  netPaisa: number;
  presentDays: number;
  absentDays: number;
  halfDays: number;
  leaveDays: number;
  workingDays: number;
  items: number;
  role: string;
}

function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toTitleCase(value: string | null | undefined): string {
  if (!value) return "Staff";
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function emptyAttendance(): AttendanceTotals {
  return { present: 0, absent: 0, half: 0, leave: 0, recorded: 0 };
}

function emptyPayroll(): PayrollTotals {
  return {
    grossPaisa: 0,
    deductionsPaisa: 0,
    netPaisa: 0,
    presentDays: 0,
    absentDays: 0,
    halfDays: 0,
    leaveDays: 0,
    workingDays: 0,
    items: 0,
    role: "",
  };
}

async function fetchAllRows(
  build: (from: number, to: number) => any,
): Promise<any[]> {
  const pageSize = 1000;
  const rows: any[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await build(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const chunk = (data || []) as any[];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  const role = authentication.identity.staff.role;
  if (role === "cashier") {
    return authenticationResponse(
      request,
      authentication,
      { error: "HR and payroll are available to managers and administrators only." },
      403,
    );
  }
  if (role !== "admin" && !authentication.identity.moduleAccess["hr-payroll"]) {
    return authenticationResponse(request, authentication, { error: "HR and payroll access is disabled for this account." }, 403);
  }

  const parameters = new URL(request.url).searchParams;
  const fromValue = (parameters.get("from") || "").trim();
  const toValue = (parameters.get("to") || "").trim();
  const requestedBranch = (parameters.get("branchId") || "").trim();
  const requestedStaff = (parameters.get("staffId") || "").trim();
  const requestedTaxYear = Number(parameters.get("taxYear"));

  if (!isCalendarDate(fromValue) || !isCalendarDate(toValue)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid date range." }, 400);
  }
  if (fromValue > toValue) {
    return authenticationResponse(request, authentication, { error: "The end date must be after the start date." }, 400);
  }

  const allowedBranches = authentication.identity.branches.map((branch) => branch.id);
  const ownBranch = authentication.identity.staff.branch_id;

  if (requestedBranch && requestedBranch !== "all" && !isUuid(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid branch." }, 400);
  }
  if (requestedBranch && requestedBranch !== "all" && !allowedBranches.includes(requestedBranch)) {
    return authenticationResponse(request, authentication, { error: "You cannot access that branch." }, 403);
  }
  if (requestedStaff && requestedStaff !== "all" && !isUuid(requestedStaff)) {
    return authenticationResponse(request, authentication, { error: "Choose a valid staff member." }, 400);
  }

  const activeBranchList = role === "admin"
    ? (requestedBranch && requestedBranch !== "all" ? [requestedBranch] : allowedBranches)
    : (ownBranch ? [ownBranch] : []);

  if (!activeBranchList.length) {
    return authenticationResponse(
      request,
      authentication,
      { error: "This account is not assigned to a branch." },
      403,
    );
  }

  const branchNames = new Map(authentication.identity.branches.map((branch) => [branch.id, branch.name]));
  const rawClient = authentication.client as unknown as { from(table: string): any };

  let employees: EmployeeRow[] = [];
  let departments: DepartmentRow[] = [];
  let compensationRows: CompensationRow[] = [];
  let attendanceRows: AttendanceRow[] = [];
  let payrollRuns: PayrollRunRow[] = [];
  let payrollItems: PayrollItemRow[] = [];
  let recoveries: RecoveryRow[] = [];
  let advances: AdvanceRow[] = [];
  const dataWarnings: string[] = [];

  try {
    const employeesResult = await rawClient
      .from("hr_employees")
      .select("id,branch_id,full_name,job_title,email,phone,department_id,is_active")
      .in("branch_id", activeBranchList)
      .is("deleted_at", null)
      .order("full_name", { ascending: true });
    if (employeesResult.error) throw new Error(employeesResult.error.message);
    employees = (employeesResult.data || []) as EmployeeRow[];
  } catch (error) {
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not load HR employees.",
    }, 500);
  }

  try {
    const departmentsResult = await rawClient
      .from("hr_departments")
      .select("id,branch_id,name,description,is_active")
      .in("branch_id", activeBranchList)
      .is("deleted_at", null)
      .order("is_active", { ascending: false })
      .order("name", { ascending: true });
    if (!departmentsResult.error) {
      departments = (departmentsResult.data || []) as DepartmentRow[];
    } else {
      dataWarnings.push(`Departments: ${departmentsResult.error.message}`);
    }
  } catch (error) {
    dataWarnings.push(error instanceof Error ? `Departments: ${error.message}` : "Departments could not be loaded.");
  }

  try {
    const compensationResult = await rawClient
      .from("staff_compensation")
      .select("id,staff_id,base_salary_paisa,allowances_paisa,effective_from")
      .in("branch_id", activeBranchList)
      .is("deleted_at", null)
      .lte("effective_from", toValue)
      .order("effective_from", { ascending: false });
    if (!compensationResult.error) {
      compensationRows = (compensationResult.data || []) as CompensationRow[];
    } else {
      dataWarnings.push(`Compensation: ${compensationResult.error.message}`);
    }
  } catch (error) {
    dataWarnings.push(error instanceof Error ? `Compensation: ${error.message}` : "Compensation could not be loaded.");
  }

  try {
    // The cloud attendance ledger records a plain status per day. Late-arrival
    // and overtime columns do not exist in the synchronized schema, so the web
    // page reports present, absent, half-day, and leave counts instead.
    const attendanceResult = await rawClient
      .from("staff_attendance")
      .select("staff_id,branch_id,attendance_date,status")
      .in("branch_id", activeBranchList)
      .is("deleted_at", null)
      .gte("attendance_date", fromValue)
      .lte("attendance_date", toValue)
      .order("attendance_date", { ascending: false });
    if (!attendanceResult.error) {
      attendanceRows = (attendanceResult.data || []) as AttendanceRow[];
    } else {
      dataWarnings.push(`Attendance: ${attendanceResult.error.message}`);
    }
  } catch (error) {
    dataWarnings.push(error instanceof Error ? `Attendance: ${error.message}` : "Attendance could not be loaded.");
  }

  try {
    const runsResult = await rawClient
      .from("payroll_runs")
      .select(
        "id,branch_id,period_start,period_end,status,working_days,staff_count,gross_paisa,"
        + "attendance_deduction_paisa,advance_deduction_paisa,net_paisa,notes,created_at,paid_at,voided_at",
      )
      .in("branch_id", activeBranchList)
      .is("deleted_at", null)
      .lte("period_start", toValue)
      .gte("period_end", fromValue)
      .neq("status", "void")
      .order("period_end", { ascending: false })
      .limit(100);
    if (!runsResult.error) {
      payrollRuns = (runsResult.data || []) as PayrollRunRow[];
      const runIds = payrollRuns.map((run) => run.id);
      if (runIds.length) {
        const itemsResult = await rawClient
          .from("payroll_items")
          .select(
            "id,run_id,staff_id,staff_name,role,base_salary_paisa,allowances_paisa,working_days,"
            + "present_days,absent_days,half_days,leave_days,attendance_deduction_paisa,"
            + "advance_deduction_paisa,gross_paisa,net_paisa,notes,department_id,department_name,tax_withheld_paisa",
          )
          .in("run_id", runIds)
          .is("deleted_at", null)
          .order("staff_name", { ascending: true });
        if (!itemsResult.error) {
          payrollItems = (itemsResult.data || []) as PayrollItemRow[];
        } else {
          dataWarnings.push(`Payroll items: ${itemsResult.error.message}`);
        }
        const recoveryResult = await rawClient
          .from("payroll_advance_recoveries")
          .select("id,run_id,staff_id,advance_id,amount_paisa")
          .in("run_id", runIds)
          .is("deleted_at", null);
        if (!recoveryResult.error) {
          recoveries = (recoveryResult.data || []) as RecoveryRow[];
        } else {
          dataWarnings.push(`Advance recoveries: ${recoveryResult.error.message}`);
        }
      }
    } else {
      dataWarnings.push(`Payroll runs: ${runsResult.error.message}`);
    }
  } catch (error) {
    payrollRuns = [];
    payrollItems = [];
    recoveries = [];
    dataWarnings.push(error instanceof Error ? `Payroll data: ${error.message}` : "Payroll data could not be loaded.");
  }

  try {
    advances = (await fetchAllRows((from, to) => rawClient
      .from("staff_advances")
      .select("id,staff_id,advance_date,amount_paisa")
      .in("branch_id", activeBranchList)
      .is("deleted_at", null)
      .order("advance_date", { ascending: false })
      .range(from, to))) as AdvanceRow[];
  } catch (error) {
    advances = [];
    dataWarnings.push(error instanceof Error ? `Advances: ${error.message}` : "Staff advances could not be loaded.");
  }

  const attendanceByStaff = new Map<string, AttendanceTotals>();
  for (const row of attendanceRows) {
    const bucket = attendanceByStaff.get(row.staff_id) || emptyAttendance();
    const status = String(row.status || "").toLowerCase();
    if (status === "present") bucket.present += 1;
    else if (status === "absent") bucket.absent += 1;
    else if (status === "half_day") bucket.half += 1;
    else if (status === "leave" || status === "holiday") bucket.leave += 1;
    else continue;
    bucket.recorded += 1;
    attendanceByStaff.set(row.staff_id, bucket);
  }

  const payrollByStaff = new Map<string, PayrollTotals>();
  for (const item of payrollItems) {
    const bucket = payrollByStaff.get(item.staff_id) || emptyPayroll();
    const deductions = asNumber(item.attendance_deduction_paisa) + asNumber(item.advance_deduction_paisa);
    bucket.grossPaisa += asNumber(item.gross_paisa);
    bucket.deductionsPaisa += deductions;
    bucket.netPaisa += asNumber(item.net_paisa, asNumber(item.gross_paisa) - deductions);
    bucket.presentDays += asNumber(item.present_days);
    bucket.absentDays += asNumber(item.absent_days);
    bucket.halfDays += asNumber(item.half_days);
    bucket.leaveDays += asNumber(item.leave_days);
    bucket.workingDays += asNumber(item.working_days);
    bucket.items += 1;
    if (!bucket.role) bucket.role = asString(item.role, "");
    payrollByStaff.set(item.staff_id, bucket);
  }

  const departmentNames = new Map(departments.map((department) => [department.id, department.name]));
  const latestCompensation = new Map<string, CompensationRow>();
  for (const compensation of compensationRows) {
    if (!latestCompensation.has(compensation.staff_id)) latestCompensation.set(compensation.staff_id, compensation);
  }
  const recoveredByAdvance = new Map<string, number>();
  for (const recovery of recoveries) {
    recoveredByAdvance.set(recovery.advance_id, (recoveredByAdvance.get(recovery.advance_id) || 0) + asNumber(recovery.amount_paisa));
  }
  const advanceOutstandingByStaff = new Map<string, number>();
  for (const advance of advances) {
    const remaining = asNumber(advance.amount_paisa) - (recoveredByAdvance.get(advance.id) || 0);
    if (remaining <= 0) continue;
    advanceOutstandingByStaff.set(advance.staff_id, (advanceOutstandingByStaff.get(advance.staff_id) || 0) + remaining);
  }

  const allRows = employees.map((employee, index) => {
    const attendance = attendanceByStaff.get(employee.id) || emptyAttendance();
    const payroll = payrollByStaff.get(employee.id);
    const usesAttendance = attendance.recorded > 0;
    const presentDays = usesAttendance ? attendance.present : payroll?.presentDays ?? 0;
    const absentDays = usesAttendance ? attendance.absent : payroll?.absentDays ?? 0;
    const halfDays = usesAttendance ? attendance.half : payroll?.halfDays ?? 0;
    const leaveDays = usesAttendance ? attendance.leave : payroll?.leaveDays ?? 0;
    const recordedDays = usesAttendance ? attendance.recorded : payroll?.workingDays ?? 0;
    const compensation = latestCompensation.get(employee.id);

    return {
      id: employee.id || `employee-${index}`,
      staffId: employee.id,
      branchId: employee.branch_id,
      staffName: asString(employee.full_name, `Employee ${index + 1}`),
      branchName: employee.branch_id ? branchNames.get(employee.branch_id) ?? "Branch unavailable" : "Unassigned",
      email: employee.email,
      phone: employee.phone,
      departmentId: employee.department_id,
      departmentName: employee.department_id ? departmentNames.get(employee.department_id) ?? "Unassigned" : "Unassigned",
      role: toTitleCase(employee.job_title || payroll?.role || "staff"),
      isActive: Boolean(employee.is_active),
      monthlyPaisa: compensation
        ? asNumber(compensation.base_salary_paisa) + asNumber(compensation.allowances_paisa)
        : 0,
      baseSalaryPaisa: compensation ? asNumber(compensation.base_salary_paisa) : 0,
      allowancesPaisa: compensation ? asNumber(compensation.allowances_paisa) : 0,
      advancePaisa: advanceOutstandingByStaff.get(employee.id) || 0,
      presentDays,
      absentDays,
      halfDays,
      leaveDays,
      recordedDays,
      grossPaisa: payroll?.grossPaisa ?? 0,
      deductionsPaisa: payroll?.deductionsPaisa ?? 0,
      netPaisa: payroll?.netPaisa ?? 0,
    };
  });

  const filteredRows = requestedStaff && requestedStaff !== "all"
    ? allRows.filter((row) => row.staffId === requestedStaff)
    : allRows;

  const presentCount = filteredRows.reduce((sum, row) => sum + row.presentDays, 0);
  const absentCount = filteredRows.reduce((sum, row) => sum + row.absentDays, 0);
  const halfCount = filteredRows.reduce((sum, row) => sum + row.halfDays, 0);
  const leaveCount = filteredRows.reduce((sum, row) => sum + row.leaveDays, 0);
  const recordedCount = filteredRows.reduce((sum, row) => sum + row.recordedDays, 0);
  const attendedDays = presentCount + halfCount * 0.5;
  const attendanceRatePct = recordedCount > 0
    ? Number(((attendedDays / recordedCount) * 100).toFixed(1))
    : 0;

  const grossPaisa = filteredRows.reduce((sum, row) => sum + row.grossPaisa, 0);
  const deductionsPaisa = filteredRows.reduce((sum, row) => sum + row.deductionsPaisa, 0);
  const netPaisa = filteredRows.reduce((sum, row) => sum + row.netPaisa, 0);
  const advancesOutstandingPaisa = filteredRows.reduce((sum, row) => sum + row.advancePaisa, 0);

  const departmentStaffCount = new Map<string, number>();
  for (const employee of employees) {
    const key = employee.department_id || "unassigned";
    if (employee.is_active) departmentStaffCount.set(key, (departmentStaffCount.get(key) || 0) + 1);
  }

  const departmentCostMap = new Map<string, {
    departmentId: string | null;
    departmentName: string;
    staffCount: number;
    monthlySalaryPaisa: number;
    paidRunCount: number;
    paidStaffCount: number;
    grossPaisa: number;
    attendanceDeductionPaisa: number;
    advanceDeductionPaisa: number;
    taxWithheldPaisa: number;
    netPaisa: number;
  }>();

  const ensureDepartmentCost = (key: string, departmentId: string | null, departmentName: string) => {
    let row = departmentCostMap.get(key);
    if (!row) {
      row = {
        departmentId,
        departmentName: departmentName || "Unassigned",
        staffCount: 0,
        monthlySalaryPaisa: 0,
        paidRunCount: 0,
        paidStaffCount: 0,
        grossPaisa: 0,
        attendanceDeductionPaisa: 0,
        advanceDeductionPaisa: 0,
        taxWithheldPaisa: 0,
        netPaisa: 0,
      };
      departmentCostMap.set(key, row);
    }
    return row;
  };

  for (const department of departments) {
    const row = ensureDepartmentCost(department.id, department.id, department.name);
    row.staffCount = departmentStaffCount.get(department.id) || 0;
  }
  for (const staffRow of allRows) {
    const key = staffRow.departmentId || "unassigned";
    const row = ensureDepartmentCost(key, staffRow.departmentId, staffRow.departmentName);
    if (staffRow.isActive) row.monthlySalaryPaisa += staffRow.monthlyPaisa;
  }

  const runById = new Map(payrollRuns.map((run) => [run.id, run]));
  const departmentPaidStaff = new Map<string, Set<string>>();
  for (const item of payrollItems) {
    const run = runById.get(item.run_id);
    if (!run || run.status !== "paid") continue;
    const key = item.department_id || "unassigned";
    const row = ensureDepartmentCost(key, item.department_id, item.department_name || "Unassigned");
    row.paidRunCount += 1;
    const paidStaff = departmentPaidStaff.get(key) || new Set<string>();
    paidStaff.add(item.staff_id);
    departmentPaidStaff.set(key, paidStaff);
    row.grossPaisa += asNumber(item.gross_paisa);
    row.attendanceDeductionPaisa += asNumber(item.attendance_deduction_paisa);
    row.advanceDeductionPaisa += asNumber(item.advance_deduction_paisa);
    row.taxWithheldPaisa += asNumber(item.tax_withheld_paisa);
    row.netPaisa += asNumber(item.net_paisa);
  }
  for (const [key, staffSet] of departmentPaidStaff) {
    const row = departmentCostMap.get(key);
    if (row) row.paidStaffCount = staffSet.size;
  }

  const departmentCost = [...departmentCostMap.values()]
    .sort((left, right) => left.departmentName.localeCompare(right.departmentName));

  const departmentCostTotals = departmentCost.reduce((sum, row) => ({
    staffCount: sum.staffCount + row.staffCount,
    monthlySalaryPaisa: sum.monthlySalaryPaisa + row.monthlySalaryPaisa,
    paidRunCount: sum.paidRunCount + row.paidRunCount,
    paidStaffCount: sum.paidStaffCount + row.paidStaffCount,
    grossPaisa: sum.grossPaisa + row.grossPaisa,
    attendanceDeductionPaisa: sum.attendanceDeductionPaisa + row.attendanceDeductionPaisa,
    advanceDeductionPaisa: sum.advanceDeductionPaisa + row.advanceDeductionPaisa,
    taxWithheldPaisa: sum.taxWithheldPaisa + row.taxWithheldPaisa,
    netPaisa: sum.netPaisa + row.netPaisa,
  }), {
    staffCount: 0,
    monthlySalaryPaisa: 0,
    paidRunCount: 0,
    paidStaffCount: 0,
    grossPaisa: 0,
    attendanceDeductionPaisa: 0,
    advanceDeductionPaisa: 0,
    taxWithheldPaisa: 0,
    netPaisa: 0,
  });

  const itemsByRun = new Map<string, PayrollItemRow[]>();
  for (const item of payrollItems) {
    const list = itemsByRun.get(item.run_id) || [];
    list.push(item);
    itemsByRun.set(item.run_id, list);
  }
  const recoveriesByRun = new Map<string, RecoveryRow[]>();
  for (const recovery of recoveries) {
    const list = recoveriesByRun.get(recovery.run_id) || [];
    list.push(recovery);
    recoveriesByRun.set(recovery.run_id, list);
  }

  const payrollRunPayload = payrollRuns.map((run) => ({
    id: run.id,
    branchName: branchNames.get(run.branch_id) ?? "Branch unavailable",
    periodStart: run.period_start,
    periodEnd: run.period_end,
    status: run.status,
    workingDays: asNumber(run.working_days),
    staffCount: asNumber(run.staff_count),
    grossPaisa: asNumber(run.gross_paisa),
    attendanceDeductionPaisa: asNumber(run.attendance_deduction_paisa),
    advanceDeductionPaisa: asNumber(run.advance_deduction_paisa),
    netPaisa: asNumber(run.net_paisa),
    notes: run.notes,
    createdAt: run.created_at,
    paidAt: run.paid_at,
    voidedAt: run.voided_at,
    items: (itemsByRun.get(run.id) || []).map((item) => ({
      id: item.id,
      staffId: item.staff_id,
      staffName: item.staff_name,
      role: toTitleCase(item.role),
      departmentName: item.department_name || "Unassigned",
      baseSalaryPaisa: asNumber(item.base_salary_paisa),
      allowancesPaisa: asNumber(item.allowances_paisa),
      workingDays: asNumber(item.working_days),
      presentDays: asNumber(item.present_days),
      absentDays: asNumber(item.absent_days),
      halfDays: asNumber(item.half_days),
      leaveDays: asNumber(item.leave_days),
      attendanceDeductionPaisa: asNumber(item.attendance_deduction_paisa),
      advanceDeductionPaisa: asNumber(item.advance_deduction_paisa),
      taxWithheldPaisa: asNumber(item.tax_withheld_paisa),
      grossPaisa: asNumber(item.gross_paisa),
      netPaisa: asNumber(item.net_paisa),
      notes: item.notes,
    })),
    recoveries: (recoveriesByRun.get(run.id) || []).map((recovery) => ({
      id: recovery.id,
      staffId: recovery.staff_id,
      advanceId: recovery.advance_id,
      amountPaisa: asNumber(recovery.amount_paisa),
    })),
  }));

  const currentTaxYear = requestedTaxYear >= 2000 && requestedTaxYear <= 2100
    ? requestedTaxYear
    : Number(toValue.slice(0, 4)) - (Number(toValue.slice(5, 7)) >= 7 ? 0 : 1);
  const taxPeriodStart = `${currentTaxYear}-07-01`;
  const taxPeriodEnd = `${currentTaxYear + 1}-06-30`;

  let taxRows: Array<{ staffId: string; staffName: string; departmentName: string; paidRuns: number; taxWithheldPaisa: number }> = [];
  try {
    const taxRunsResult = await rawClient
      .from("payroll_runs")
      .select("id")
      .in("branch_id", activeBranchList)
      .is("deleted_at", null)
      .eq("status", "paid")
      .gte("period_end", taxPeriodStart)
      .lte("period_end", taxPeriodEnd)
      .limit(1000);
    if (taxRunsResult.error) throw new Error(taxRunsResult.error.message);
    const taxRunIds = ((taxRunsResult.data || []) as Array<{ id: string }>).map((run) => run.id);
    if (taxRunIds.length) {
      const taxItemsResult = await rawClient
        .from("payroll_items")
        .select("run_id,staff_id,staff_name,department_name,tax_withheld_paisa")
        .in("run_id", taxRunIds)
        .is("deleted_at", null)
        .gt("tax_withheld_paisa", 0);
      if (taxItemsResult.error) throw new Error(taxItemsResult.error.message);
      const grouped = new Map<string, { staffId: string; staffName: string; departmentName: string; runs: Set<string>; taxWithheldPaisa: number }>();
      for (const item of (taxItemsResult.data || []) as Array<{ run_id: string; staff_id: string; staff_name: string; department_name: string | null; tax_withheld_paisa: number }>) {
        const key = item.staff_id;
        let row = grouped.get(key);
        if (!row) {
          row = {
            staffId: item.staff_id,
            staffName: item.staff_name,
            departmentName: item.department_name || "Unassigned",
            runs: new Set<string>(),
            taxWithheldPaisa: 0,
          };
          grouped.set(key, row);
        }
        row.runs.add(item.run_id);
        row.taxWithheldPaisa += asNumber(item.tax_withheld_paisa);
      }
      taxRows = [...grouped.values()]
        .map((row) => ({
          staffId: row.staffId,
          staffName: row.staffName,
          departmentName: row.departmentName,
          paidRuns: row.runs.size,
          taxWithheldPaisa: row.taxWithheldPaisa,
        }))
        .sort((left, right) => left.staffName.localeCompare(right.staffName));
    }
  } catch (error) {
    taxRows = [];
    dataWarnings.push(error instanceof Error ? `Tax report: ${error.message}` : "The tax report could not be loaded.");
  }

  const payload = {
    period: {
      start: fromValue,
      end: toValue,
      label: `${fromValue} to ${toValue}`,
    },
    branchId: requestedBranch && requestedBranch !== "all"
      ? requestedBranch
      : (role === "admin" ? null : ownBranch ?? null),
    branchName: requestedBranch && requestedBranch !== "all"
      ? branchNames.get(requestedBranch) ?? null
      : (role === "admin"
        ? "All accessible branches"
        : branchNames.get(ownBranch ?? "") ?? null),
    attendance: {
      totalStaff: filteredRows.length,
      presentCount,
      absentCount,
      halfCount,
      leaveCount,
      recordedCount,
      overtimeHours: 0,
      attendanceRatePct,
    },
    payroll: {
      grossPaisa,
      deductionsPaisa,
      netPaisa,
      overtimePaisa: 0,
      finalPayoutPaisa: netPaisa,
    },
    advancesOutstandingPaisa,
    rows: filteredRows,
    staffOptions: allRows.map((row) => ({ id: row.staffId, name: row.staffName })),
    departments: departments.map((department) => ({
      id: department.id,
      name: department.name,
      description: department.description,
      isActive: department.is_active,
      staffCount: departmentStaffCount.get(department.id) || 0,
    })),
    departmentCost: {
      monthLabel: fromValue.slice(0, 7),
      departments: departmentCost,
      totals: departmentCostTotals,
    },
    payrollRuns: payrollRunPayload,
    taxReport: {
      taxYear: currentTaxYear,
      periodStart: taxPeriodStart,
      periodEnd: taxPeriodEnd,
      rows: taxRows,
      totalWithheldPaisa: taxRows.reduce((sum, row) => sum + row.taxWithheldPaisa, 0),
    },
    readOnly: false,
    warning: dataWarnings.length ? `Some HR and payroll data could not be loaded: ${dataWarnings.join("; ")}` : undefined,
    limitations: [
      "Attendance is aggregated from synchronized daily attendance records for the selected dates.",
      "Payroll totals come from payroll runs whose period overlaps the selected dates.",
      "Manual tax withholding and payroll tax settings are still managed in the Windows desktop app.",
    ],
  };

  return authenticationResponse(request, authentication, payload, 200);
}
