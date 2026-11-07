"use client";

import {
  AlertCircle,
  Banknote,
  BriefcaseBusiness,
  Building2,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  Plus,
  Printer,
  Receipt,
  RefreshCcw,
  ShieldCheck,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { formatDateTime, formatMoney, labelize, statusTone } from "@/lib/format";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { printCurrentPage } from "@/lib/print/print-window";

type PayrollRow = {
  id: string;
  staffId: string;
  staffName: string;
  branchName: string;
  departmentId: string | null;
  departmentName: string;
  role: string;
  isActive: boolean;
  monthlyPaisa: number;
  advancePaisa: number;
  presentDays: number;
  absentDays: number;
  halfDays: number;
  leaveDays: number;
  recordedDays: number;
  grossPaisa: number;
  deductionsPaisa: number;
  netPaisa: number;
};

type PayrollDocument = {
  id: string;
  name: string;
  kind: "attendance" | "payroll" | "export";
  disabled?: boolean;
};

type Department = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  staffCount: number;
};

type DepartmentCostRow = {
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
};

type PayrollItem = {
  id: string;
  staffId: string;
  staffName: string;
  role: string;
  departmentName: string;
  baseSalaryPaisa: number;
  allowancesPaisa: number;
  workingDays: number;
  presentDays: number;
  absentDays: number;
  halfDays: number;
  leaveDays: number;
  attendanceDeductionPaisa: number;
  advanceDeductionPaisa: number;
  taxWithheldPaisa: number;
  grossPaisa: number;
  netPaisa: number;
  notes: string | null;
};

type PayrollRun = {
  id: string;
  branchName: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  workingDays: number;
  staffCount: number;
  grossPaisa: number;
  attendanceDeductionPaisa: number;
  advanceDeductionPaisa: number;
  netPaisa: number;
  notes: string | null;
  createdAt: string;
  paidAt: string | null;
  voidedAt: string | null;
  items: PayrollItem[];
  recoveries: Array<{ id: string; staffId: string; advanceId: string; amountPaisa: number }>;
};

type TaxReport = {
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  rows: Array<{
    staffId: string;
    staffName: string;
    departmentName: string;
    paidRuns: number;
    taxWithheldPaisa: number;
  }>;
  totalWithheldPaisa: number;
};

type PayrollSummaryResponse = {
  period: {
    start: string;
    end: string;
    label: string;
  };
  branchId: string | null;
  branchName: string | null;
  attendance: {
    totalStaff: number;
    presentCount: number;
    absentCount: number;
    halfCount: number;
    leaveCount: number;
    recordedCount: number;
    overtimeHours?: number;
    attendanceRatePct: number;
  };
  payroll: {
    grossPaisa: number;
    deductionsPaisa: number;
    netPaisa: number;
    overtimePaisa: number;
    finalPayoutPaisa: number;
  };
  advancesOutstandingPaisa?: number;
  rows: PayrollRow[];
  staffOptions?: Array<{ id: string; name: string }>;
  departments?: Department[];
  departmentCost?: {
    monthLabel: string;
    departments: DepartmentCostRow[];
    totals: Omit<DepartmentCostRow, "departmentId" | "departmentName">;
  };
  payrollRuns?: PayrollRun[];
  taxReport?: TaxReport;
  documents: PayrollDocument[];
  readOnly?: boolean;
  warning?: string;
  limitations?: string[];
  error?: string;
};

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultRange(): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return [formatDateInput(from), formatDateInput(to)];
}

function currentTaxYear(): number {
  const now = new Date();
  return now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium" }).format(parsed);
}

const emptySummary: PayrollSummaryResponse = {
  period: { start: "", end: "", label: "Selected period" },
  branchId: null,
  branchName: null,
  attendance: {
    totalStaff: 0,
    presentCount: 0,
    absentCount: 0,
    halfCount: 0,
    leaveCount: 0,
    recordedCount: 0,
    overtimeHours: 0,
    attendanceRatePct: 0,
  },
  payroll: {
    grossPaisa: 0,
    deductionsPaisa: 0,
    netPaisa: 0,
    overtimePaisa: 0,
    finalPayoutPaisa: 0,
  },
  advancesOutstandingPaisa: 0,
  rows: [],
  departments: [],
  departmentCost: {
    monthLabel: "",
    departments: [],
    totals: {
      staffCount: 0,
      monthlySalaryPaisa: 0,
      paidRunCount: 0,
      paidStaffCount: 0,
      grossPaisa: 0,
      attendanceDeductionPaisa: 0,
      advanceDeductionPaisa: 0,
      taxWithheldPaisa: 0,
      netPaisa: 0,
    },
  },
  payrollRuns: [],
  taxReport: {
    taxYear: currentTaxYear(),
    periodStart: "",
    periodEnd: "",
    rows: [],
    totalWithheldPaisa: 0,
  },
  documents: [
    { id: "attendance-register", name: "Attendance register", kind: "attendance", disabled: true },
    { id: "payroll-register", name: "Payroll register", kind: "payroll", disabled: true },
    { id: "payroll-export", name: "Payslip export", kind: "export", disabled: true },
  ],
  readOnly: true,
  warning: "This workspace is intentionally read-only until the payroll export flow is verified.",
  limitations: [],
};

export function AdminPayrollWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches, loading: authLoading } = useStaffAuth();
  const [range] = useState<[string, string]>(defaultRange);
  const [fromDate, setFromDate] = useState(range[0]);
  const [toDate, setToDate] = useState(range[1]);
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [staffId, setStaffId] = useState("all");
  const [taxYear, setTaxYear] = useState(currentTaxYear());
  const [summary, setSummary] = useState<PayrollSummaryResponse | null>(null);
  const [expandedRunId, setExpandedRunId] = useState("");
  const [selectedPayslip, setSelectedPayslip] = useState<{ item: PayrollItem; run: PayrollRun } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!staff) return;
    if (staff.role === "admin" && !branchId) setBranchId("all");
    else if (staff.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff]);

  useEffect(() => {
    if (!staff) return;

    let active = true;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ from: fromDate, to: toDate, taxYear: String(taxYear) });
    if (branchId && branchId !== "all") params.set("branchId", branchId);
    if (staffId && staffId !== "all") params.set("staffId", staffId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/admin-payroll?${params.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = (await response.json()) as PayrollSummaryResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load the payroll summary.");
        setSummary(result);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the payroll summary.");
        setSummary({ ...emptySummary, period: { start: fromDate, end: toDate, label: `${fromDate} to ${toDate}` } });
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [branchId, fromDate, reloadKey, staff, staffId, taxYear, toDate]);

  const branchOptions = useMemo(() => {
    if (!staff) return [];
    if (staff.role === "admin") {
      return [{ id: "all", name: "All accessible branches" }, ...branches.map((branch) => ({ id: branch.id, name: branch.name }))];
    }
    return branches.map((branch) => ({ id: branch.id, name: branch.name }));
  }, [branches, staff]);

  const staffOptions = useMemo(() => {
    const options = summary?.staffOptions ?? (summary?.rows ?? []).map((row) => ({ id: row.staffId, name: row.staffName }));
    if (!options.length) return [];
    return [{ id: "all", name: "All staff" }, ...options];
  }, [summary]);

  const selectedBranchName = useMemo(() => {
    if (!staff) return "Current branch";
    if (branchId === "all") return "All accessible branches";
    return branches.find((branch) => branch.id === branchId)?.name || "Current branch";
  }, [branchId, branches, staff]);

  const taxYearOptions = useMemo(() => {
    const year = currentTaxYear();
    return [year + 1, year, year - 1, year - 2, year - 3];
  }, []);

  const monthlySalaryBill = useMemo(
    () => (summary?.rows ?? []).filter((row) => row.isActive).reduce((sum, row) => sum + row.monthlyPaisa, 0),
    [summary],
  );

  const metrics = [
    {
      label: "Active employees",
      value: summary ? String(summary.rows.filter((row) => row.isActive).length) : "—",
      note: `${summary?.rows.length ?? 0} employee records in scope`,
      icon: Users,
    },
    {
      label: "Monthly salary bill",
      value: summary ? formatMoney(monthlySalaryBill) : "—",
      note: "Base salary plus allowances",
      icon: Wallet,
    },
    {
      label: "Attendance entries",
      value: summary ? String(summary.attendance.recordedCount) : "—",
      note: `Recorded for ${summary?.period.label || "selected period"}`,
      icon: CalendarRange,
    },
    {
      label: "Advances outstanding",
      value: summary ? formatMoney(summary.advancesOutstandingPaisa ?? 0) : "—",
      note: "Recovered from future payroll",
      icon: Banknote,
    },
    {
      label: "Gross payroll",
      value: summary ? formatMoney(summary.payroll.grossPaisa) : "—",
      note: "Before deductions",
      icon: BriefcaseBusiness,
    },
    {
      label: "Net payout",
      value: summary ? formatMoney(summary.payroll.netPaisa) : "—",
      note: "After deductions",
      icon: CheckCircle2,
    },
  ];

  const isLocked = !authLoading && !staff;

  if (isLocked) {
    return (
      <div className="card notice warning" role="alert">
        <ShieldCheck size={16} />
        <div>
          <strong>Payroll workspace is locked.</strong>
          <p>Sign in with an authenticated staff account to view the read-only payroll and attendance summary for your branch scope.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} This workspace is read-only and only shows data available to the signed-in staff profile.</p>
        </div>
        <div className="dashboard-controls">
          {staff?.role === "admin" && (
            <label className="toolbar-control">
              <span>Branch</span>
              <select className="toolbar-select" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                {branchOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="toolbar-control">
            <span>From</span>
            <input className="toolbar-input" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
          </label>
          <label className="toolbar-control">
            <span>To</span>
            <input className="toolbar-input" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
          </label>
          {staffOptions.length > 0 && (
            <label className="toolbar-control">
              <span>Staff</span>
              <select className="toolbar-select" value={staffId} onChange={(event) => setStaffId(event.target.value)}>
                {staffOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </label>
          )}
          <button className="button secondary" onClick={() => setReloadKey((value) => value + 1)} disabled={loading} type="button">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="heading-actions" aria-label="Desktop payroll actions">
        <button className="primary-button" type="button" disabled title="Adding employees is a Windows desktop workflow.">
          <Plus size={14} /> Add employee
        </button>
        <button className="primary-button" type="button" disabled title="Generating payroll runs is a Windows desktop workflow.">
          <Plus size={14} /> New payroll run
        </button>
        <button className="secondary-button" type="button" disabled title="Adding departments is a Windows desktop workflow.">
          <Plus size={14} /> Add department
        </button>
        <button className="secondary-button" type="button" disabled title="Payroll tax settings are stored on the Windows desktop device.">
          <ShieldCheck size={14} /> Tax settings
        </button>
      </div>

      {error ? (
        <div className="notice" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="card loading">Loading payroll and attendance…</div>
      ) : null}

      {!loading && summary && (
        <>
          <section className="dashboard-stats" aria-label="Payroll summary metrics">
            {metrics.map(({ icon: Icon, label, value, note }) => (
              <article className="dashboard-stat card" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{note}</small>
                <Icon size={16} aria-hidden="true" />
              </article>
            ))}
          </section>

          {(summary.limitations?.length || summary.warning) && (
            <div className="notice warning" role="note">
              <AlertCircle size={15} />
              <div>
                {summary.warning ? <p>{summary.warning}</p> : null}
                {summary.limitations?.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            </div>
          )}

          <div className="hr-report-grid">
            <section className="card" style={{ padding: "1.25rem" }}>
              <div className="hr-panel-heading">
                <h2 className="section-title"><Building2 size={11} /> Departments</h2>
                <button className="secondary-button" type="button" disabled title="Adding departments is a Windows desktop workflow.">
                  <Plus size={12} /> Add
                </button>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th>Assigned staff</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(summary.departments ?? []).length ? (
                      (summary.departments ?? []).map((department) => (
                        <tr key={department.id}>
                          <td>
                            <strong>{department.name}</strong>
                            {department.description && <small className="row-note">{department.description}</small>}
                          </td>
                          <td>{department.staffCount}</td>
                          <td><span className={`status ${department.isActive ? "green" : "red"}`}>{department.isActive ? "Active" : "Inactive"}</span></td>
                          <td>
                            <button className="secondary-button" type="button" disabled title="Changing departments is a Windows desktop workflow.">
                              {department.isActive ? "Deactivate" : "Activate"}
                            </button>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4}>No departments have been synchronized for this branch.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card" style={{ padding: "1.25rem" }}>
              <h2 className="section-title"><Wallet size={11} /> Payroll cost by department · {summary.departmentCost?.monthLabel || summary.period.label}</h2>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th>Staff</th>
                      <th>Monthly pay</th>
                      <th>Paid gross</th>
                      <th>Deductions</th>
                      <th>Tax withheld</th>
                      <th>Paid net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(summary.departmentCost?.departments ?? []).length ? (
                      (summary.departmentCost?.departments ?? []).map((row) => (
                        <tr key={row.departmentId || "unassigned"}>
                          <td>{row.departmentName}</td>
                          <td>{row.staffCount}</td>
                          <td>{formatMoney(row.monthlySalaryPaisa)}</td>
                          <td>{formatMoney(row.grossPaisa)}</td>
                          <td>{formatMoney(row.attendanceDeductionPaisa + row.advanceDeductionPaisa)}</td>
                          <td>{formatMoney(row.taxWithheldPaisa)}</td>
                          <td>{formatMoney(row.netPaisa)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={7}>No compensation or paid payroll costs for this period.</td>
                      </tr>
                    )}
                  </tbody>
                  {(summary.departmentCost?.departments ?? []).length ? (
                    <tfoot>
                      <tr>
                        <th>Total</th>
                        <th>{summary.departmentCost?.totals.staffCount ?? 0}</th>
                        <th>{formatMoney(summary.departmentCost?.totals.monthlySalaryPaisa ?? 0)}</th>
                        <th>{formatMoney(summary.departmentCost?.totals.grossPaisa ?? 0)}</th>
                        <th>{formatMoney((summary.departmentCost?.totals.attendanceDeductionPaisa ?? 0) + (summary.departmentCost?.totals.advanceDeductionPaisa ?? 0))}</th>
                        <th>{formatMoney(summary.departmentCost?.totals.taxWithheldPaisa ?? 0)}</th>
                        <th>{formatMoney(summary.departmentCost?.totals.netPaisa ?? 0)}</th>
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
              </div>
            </section>
          </div>

          <section className="card" style={{ padding: "1.25rem" }}>
            <div className="hr-panel-heading">
              <h2 className="section-title">Pakistan tax-year withholding summary</h2>
              <label className="toolbar-control">
                <span>Tax year</span>
                <select className="toolbar-select" value={taxYear} onChange={(event) => setTaxYear(Number(event.target.value))}>
                  {taxYearOptions.map((year) => (
                    <option key={year} value={year}>1 Jul {year} – 30 Jun {year + 1}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="summary-grid" style={{ margin: "0.75rem 0" }}>
              <div className="summary-tile">
                <span><ShieldCheck size={14} /> Withheld in paid payroll</span>
                <strong>{formatMoney(summary.taxReport?.totalWithheldPaisa ?? 0)}</strong>
                <small>1 July {summary.taxReport?.taxYear ?? taxYear} to 30 June {(summary.taxReport?.taxYear ?? taxYear) + 1}</small>
              </div>
              <div className="summary-tile">
                <span><Receipt size={14} /> Employees with withholding</span>
                <strong>{summary.taxReport?.rows.length ?? 0}</strong>
                <small>Paid runs in this tax year</small>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th>Department</th>
                    <th>Paid runs</th>
                    <th>Manual withholding</th>
                  </tr>
                </thead>
                <tbody>
                  {(summary.taxReport?.rows ?? []).length ? (
                    (summary.taxReport?.rows ?? []).map((row) => (
                      <tr key={row.staffId}>
                        <td>{row.staffName}</td>
                        <td>{row.departmentName}</td>
                        <td>{row.paidRuns}</td>
                        <td>{formatMoney(row.taxWithheldPaisa)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4}>No manual withholding has been recorded for this tax year.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="page-note">Manual withholding and the payroll tax toggle are managed in the Windows desktop app. This view mirrors the synchronized payroll items.</p>
          </section>

          <section className="card" style={{ padding: "1.25rem" }}>
            <div className="hr-panel-heading">
              <h2 className="section-title"><Users size={11} /> Employees</h2>
              <button className="primary-button" type="button" disabled title="Adding employees is a Windows desktop workflow.">
                <Plus size={14} /> Add employee
              </button>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Job title</th>
                    <th>Department</th>
                    <th>Monthly pay</th>
                    <th>Attendance</th>
                    <th>Advance</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {summary.rows.length ? (
                    summary.rows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.staffName}</td>
                        <td>{row.role}</td>
                        <td>{row.departmentName}</td>
                        <td>{formatMoney(row.monthlyPaisa)}</td>
                        <td>{row.presentDays}P / {row.absentDays}A / {row.halfDays}H / {row.leaveDays}L</td>
                        <td>{formatMoney(row.advancePaisa)}</td>
                        <td><span className={`status ${row.isActive ? "green" : "red"}`}>{row.isActive ? "Active" : "Inactive"}</span></td>
                        <td>
                          <div className="row-actions">
                            <button className="secondary-button" type="button" disabled title="Editing employees is a Windows desktop workflow.">Edit</button>
                            <button className="secondary-button" type="button" disabled title="Saving compensation is a Windows desktop workflow.">Pay</button>
                            <button className="secondary-button" type="button" disabled title="Recording attendance is a Windows desktop workflow.">Attendance</button>
                            <button className="secondary-button" type="button" disabled title="Recording advances is a Windows desktop workflow.">Advance</button>
                            <button className="secondary-button" type="button" disabled title="Changing employee status is a Windows desktop workflow.">{row.isActive ? "Deactivate" : "Activate"}</button>
                            <button className="secondary-button" type="button" disabled title="Restoring employees is a Windows desktop workflow.">Restore</button>
                            <button className="secondary-button" type="button" disabled title="Archiving employees is a Windows desktop workflow.">Archive</button>
                            <button className="secondary-button" type="button" disabled title="Deleting employees is a Windows desktop workflow.">Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8}>No payroll rows returned for this branch and date range.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" style={{ padding: "1.25rem" }}>
            <div className="hr-panel-heading">
              <h2 className="section-title"><Wallet size={11} /> Payroll runs</h2>
              <button className="primary-button" type="button" disabled title="Generating payroll runs is a Windows desktop workflow.">
                <Plus size={14} /> New payroll run
              </button>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Branch</th>
                    <th>Working days</th>
                    <th>Staff</th>
                    <th>Gross</th>
                    <th>Attendance</th>
                    <th>Advance</th>
                    <th>Net</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(summary.payrollRuns ?? []).length ? (
                    (summary.payrollRuns ?? []).map((run) => (
                      <tr key={run.id}>
                        <td>{formatDate(run.periodStart)} → {formatDate(run.periodEnd)}</td>
                        <td>{run.branchName}</td>
                        <td>{run.workingDays}</td>
                        <td>{run.staffCount}</td>
                        <td>{formatMoney(run.grossPaisa)}</td>
                        <td>{formatMoney(run.attendanceDeductionPaisa)}</td>
                        <td>{formatMoney(run.advanceDeductionPaisa)}</td>
                        <td>{formatMoney(run.netPaisa)}</td>
                        <td><span className={`status ${statusTone(run.status)}`}>{labelize(run.status)}</span></td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={() => setExpandedRunId((current) => current === run.id ? "" : run.id)}
                            >
                              {expandedRunId === run.id ? "Hide" : "Details"}
                            </button>
                            {run.status === "draft" && (
                              <>
                                <button className="primary-button" type="button" disabled title="Marking a payroll run paid is a Windows desktop workflow.">
                                  <CheckCircle2 size={12} /> Mark paid
                                </button>
                                <button className="secondary-button" type="button" disabled title="Voiding a payroll run is a Windows desktop workflow.">
                                  Void
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={10}>No payroll runs overlap the selected dates.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {(summary.payrollRuns ?? []).filter((run) => run.id === expandedRunId).map((run) => (
              <div key={run.id} style={{ marginTop: "1rem" }}>
                <h3 className="section-title"><Receipt size={11} /> Payroll {formatDate(run.periodStart)} → {formatDate(run.periodEnd)}</h3>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Department</th>
                        <th>Base</th>
                        <th>Allowances</th>
                        <th>Days</th>
                        <th>Attendance cut</th>
                        <th>Advance cut</th>
                        <th>Withholding</th>
                        <th>Net</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {run.items.length ? (
                        run.items.map((payslip) => (
                          <tr key={payslip.id}>
                            <td>{payslip.staffName}</td>
                            <td>{payslip.departmentName}</td>
                            <td>{formatMoney(payslip.baseSalaryPaisa)}</td>
                            <td>{formatMoney(payslip.allowancesPaisa)}</td>
                            <td>{payslip.presentDays}P / {payslip.absentDays}A / {payslip.halfDays}H / {payslip.leaveDays}L</td>
                            <td>{formatMoney(payslip.attendanceDeductionPaisa)}</td>
                            <td>{formatMoney(payslip.advanceDeductionPaisa)}</td>
                            <td>{formatMoney(payslip.taxWithheldPaisa)}</td>
                            <td>{formatMoney(payslip.netPaisa)}</td>
                            <td>
                              <button
                                className="secondary-button"
                                type="button"
                                onClick={() => setSelectedPayslip({ item: payslip, run })}
                              >
                                <Printer size={12} /> Print
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={10}>No payslips in this run.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {run.recoveries.length ? (
                  <>
                    <h3 className="section-title" style={{ marginTop: "0.85rem" }}>Advance recoveries</h3>
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Staff</th>
                            <th>Advance</th>
                            <th>Recovered</th>
                          </tr>
                        </thead>
                        <tbody>
                          {run.recoveries.map((recovery) => (
                            <tr key={recovery.id}>
                              <td>{run.items.find((payslip) => payslip.staffId === recovery.staffId)?.staffName || recovery.staffId}</td>
                              <td>{recovery.advanceId}</td>
                              <td>{formatMoney(recovery.amountPaisa)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
              </div>
            ))}
          </section>

          <section className="card" style={{ padding: "1.25rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: 0 }}>Attendance & payroll overview</h2>
                <p style={{ margin: "0.35rem 0 0", color: "var(--muted)" }}>
                  {summary.period.label || "Selected period"} · {selectedBranchName}
                </p>
              </div>
              <div className="badge-row">
                <span className="status-chip neutral">Read-only</span>
              </div>
            </div>

            <div className="summary-grid" style={{ marginTop: "1rem" }}>
              <div className="summary-tile">
                <span>
                  <Users size={14} /> Employees
                </span>
                <strong>{summary.attendance.totalStaff}</strong>
              </div>
              <div className="summary-tile">
                <span>
                  <CheckCircle2 size={14} /> Present days
                </span>
                <strong>{summary.attendance.presentCount}</strong>
              </div>
              <div className="summary-tile">
                <span>
                  <AlertCircle size={14} /> Absent days
                </span>
                <strong>{summary.attendance.absentCount}</strong>
              </div>
              <div className="summary-tile">
                <span>
                  <Clock3 size={14} /> Half / leave
                </span>
                <strong>{summary.attendance.halfCount} / {summary.attendance.leaveCount}</strong>
              </div>
            </div>
          </section>

          <section className="card" style={{ padding: "1.25rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h2 style={{ margin: 0 }}>Payroll ledger</h2>
              <div className="flex gap-2">
                {summary.documents.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    className="button secondary"
                    disabled={document.disabled}
                    title={document.disabled ? "Generation is disabled until the document workflow is verified." : "Read-only document view"}
                    style={{ opacity: document.disabled ? 0.6 : 1 }}
                  >
                    {document.kind === "attendance" ? <FileText size={14} /> : document.kind === "export" ? <Download size={14} /> : <Wallet size={14} />}
                    {document.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th>Role</th>
                    <th>Branch</th>
                    <th>Present</th>
                    <th>Absent</th>
                    <th>Half</th>
                    <th>Leave</th>
                    <th>Gross</th>
                    <th>Deductions</th>
                    <th>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.rows.length ? (
                    summary.rows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.staffName}</td>
                        <td>{row.role}</td>
                        <td>{row.branchName}</td>
                        <td>{row.presentDays}</td>
                        <td>{row.absentDays}</td>
                        <td>{row.halfDays}</td>
                        <td>{row.leaveDays}</td>
                        <td>{formatMoney(row.grossPaisa)}</td>
                        <td>{formatMoney(row.deductionsPaisa)}</td>
                        <td>{formatMoney(row.netPaisa)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={10}>No payroll rows returned for this branch and date range.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {selectedPayslip && (
        <div
          className="sales-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedPayslip(null);
          }}
        >
          <section
            aria-label={`Payslip · ${selectedPayslip.item.staffName}`}
            aria-modal="true"
            className="sales-dialog card"
            role="dialog"
          >
            <header className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Payslip</p>
                <h2>{selectedPayslip.item.staffName}</h2>
              </div>
              <button
                aria-label="Close payslip"
                className="button secondary"
                onClick={() => setSelectedPayslip(null)}
                type="button"
              >
                <X size={16} />
              </button>
            </header>

            <div className="sales-dialog-actions" style={{ marginBottom: 14 }}>
              <button className="primary-button" onClick={printCurrentPage} type="button">
                <Printer size={14} /> Print payslip
              </button>
            </div>

            <style>{"@page payslip { size: A4 portrait; margin: 14mm; }"}</style>
            <article className="payslip-print">
              <header className="payslip-header">
                <div>
                  <small>{selectedPayslip.run.branchName} · Employee payslip</small>
                  <h1>Employee payslip</h1>
                </div>
                <span className={`status ${statusTone(selectedPayslip.run.status)}`}>
                  {labelize(selectedPayslip.run.status)}
                </span>
              </header>
              <div className="payslip-facts">
                <div><span>Employee</span><strong>{selectedPayslip.item.staffName}</strong></div>
                <div><span>Job title</span><strong>{labelize(selectedPayslip.item.role)}</strong></div>
                <div><span>Department</span><strong>{selectedPayslip.item.departmentName || "Unassigned"}</strong></div>
                <div>
                  <span>Pay period</span>
                  <strong>{formatDate(selectedPayslip.run.periodStart)} — {formatDate(selectedPayslip.run.periodEnd)}</strong>
                </div>
                <div><span>Working days</span><strong>{selectedPayslip.item.workingDays}</strong></div>
                <div>
                  <span>Attendance</span>
                  <strong>
                    {selectedPayslip.item.presentDays} present · {selectedPayslip.item.absentDays} absent · {selectedPayslip.item.halfDays} half
                  </strong>
                </div>
              </div>
              <table className="data-table payslip-breakdown">
                <thead>
                  <tr><th>Earnings and deductions</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  <tr><td>Base salary</td><td>{formatMoney(selectedPayslip.item.baseSalaryPaisa)}</td></tr>
                  <tr><td>Allowances</td><td>{formatMoney(selectedPayslip.item.allowancesPaisa)}</td></tr>
                  <tr><td>Gross after attendance</td><td>{formatMoney(selectedPayslip.item.grossPaisa)}</td></tr>
                  <tr><td>Attendance deduction</td><td>−{formatMoney(selectedPayslip.item.attendanceDeductionPaisa)}</td></tr>
                  <tr><td>Advance recovery</td><td>−{formatMoney(selectedPayslip.item.advanceDeductionPaisa)}</td></tr>
                  {selectedPayslip.item.taxWithheldPaisa > 0 && (
                    <tr><td>Manual withholding</td><td>−{formatMoney(selectedPayslip.item.taxWithheldPaisa)}</td></tr>
                  )}
                </tbody>
              </table>
              <div className="payslip-net">
                <span>Net pay</span>
                <strong>{formatMoney(selectedPayslip.item.netPaisa)}</strong>
              </div>
              <footer>
                Generated {formatDateTime(new Date().toISOString())}. Keep this document for your records.
              </footer>
            </article>
          </section>
        </div>
      )}
    </>
  );
}
