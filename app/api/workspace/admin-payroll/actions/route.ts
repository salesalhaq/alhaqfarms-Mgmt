import { authenticateStaff, authenticationResponse, isSameOriginRequest, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

type ActionBody = Record<string, unknown> & { action?: string };

class ActionValidationError extends Error {}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new ActionValidationError(`${label} must be a whole number greater than or equal to ${minimum}.`);
  return parsed;
}

function text(value: unknown, label: string, maximum: number, required = false): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (required && !normalized) throw new ActionValidationError(`${label} is required.`);
  if (normalized.length > maximum) throw new ActionValidationError(`${label} must be ${maximum} characters or fewer.`);
  return normalized || null;
}

function todayInPakistan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (!isSameOriginRequest(request)) {
    return authenticationResponse(request, authentication, { error: "This request must come from the signed-in workspace." }, 403);
  }
  if (authentication.identity.staff.role === "cashier") {
    return authenticationResponse(request, authentication, { error: "HR and payroll actions are restricted to managers and administrators." }, 403);
  }
  if (authentication.identity.staff.role !== "admin" && !authentication.identity.moduleAccess["hr-payroll"]) {
    return authenticationResponse(request, authentication, { error: "HR and payroll access is disabled for this account." }, 403);
  }

  let body: ActionBody;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as ActionBody;
  } catch {
    return authenticationResponse(request, authentication, { error: "Send a valid HR or payroll action." }, 400);
  }

  const action = body.action || "";
  const identity = authentication.identity;
  const actorId = identity.staff.local_staff_id;
  const now = new Date().toISOString();
  const rawClient = authentication.client as unknown as {
    from(table: string): any;
    rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
  };
  const allowedBranch = (branchId: unknown): string => {
    if (typeof branchId !== "string" || !isUuid(branchId)) throw new ActionValidationError("Choose a valid branch.");
    if (!identity.branches.some((branch) => branch.id === branchId)) throw new ActionValidationError("You cannot access that branch.");
    return branchId;
  };
  const finishAction = async (
    responseBody: Record<string, unknown>,
    branchId: string | null,
    auditAction: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
  ) => {
    let warning: string | null = null;
    try {
      const { error } = await rawClient.from("audit_log").insert({
        id: crypto.randomUUID(),
        actor_id: actorId,
        branch_id: branchId,
        action: auditAction,
        entity_type: entityType,
        entity_id: entityId,
        details_json: details,
        occurred_at: now,
        deleted_at: null,
        server_updated_at: now,
      });
      if (error) warning = `The change was saved, but its audit entry could not be recorded: ${error.message}`;
    } catch (auditError) {
      warning = `The change was saved, but its audit entry could not be recorded: ${auditError instanceof Error ? auditError.message : "unknown error"}`;
    }
    if (warning) console.error(warning);
    return authenticationResponse(request, authentication, { ...responseBody, ...(warning ? { warning } : {}) });
  };

  try {
    if (action === "generatePayrollRun" || action === "markPayrollRunPaid" || action === "voidPayrollRun") {
      const rpcAction = action === "generatePayrollRun" ? "generate"
        : action === "markPayrollRunPaid" ? "mark-paid" : "void";
      let payload: Record<string, unknown>;
      if (action === "generatePayrollRun") {
        if (!isCalendarDate(body.periodStart) || !isCalendarDate(body.periodEnd)) {
          return authenticationResponse(request, authentication, { error: "Choose a valid payroll period." }, 400);
        }
        payload = {
          branchId: allowedBranch(body.branchId),
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          notes: text(body.notes, "Notes", 500),
        };
      } else {
        const runId = typeof body.runId === "string" ? body.runId : "";
        if (!isUuid(runId)) return authenticationResponse(request, authentication, { error: "Choose a valid payroll run." }, 400);
        payload = { runId };
      }
      const { data, error } = await rawClient.rpc("manage_web_payroll_run", {
        p_action: rpcAction,
        p_payload: payload,
      });
      if (error) {
        if (error.code === "PGRST202" || /could not find the function|schema cache/i.test(error.message)) {
          return authenticationResponse(request, authentication, {
            error: "Web payroll actions are not installed yet. Apply supabase/migrations/033_hr_payroll_web_actions.sql and retry.",
          }, 503);
        }
        throw new Error(error.message);
      }
      return authenticationResponse(request, authentication, { result: data });
    }

    if (action === "saveEmployee") {
      if (!actorId) throw new ActionValidationError("Your staff profile is not linked for HR actions.");
      const employeeId = typeof body.employeeId === "string" ? body.employeeId : "";
      const fullName = text(body.fullName, "Employee name", 200, true);
      const jobTitle = text(body.jobTitle, "Job title", 100, true);
      const email = text(body.email, "Email", 254);
      const phone = text(body.phone, "Phone", 50);
      const departmentId = typeof body.departmentId === "string" && body.departmentId ? body.departmentId : null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ActionValidationError("Enter a valid employee email.");

      let branchId: string;
      if (employeeId) {
        if (!isUuid(employeeId)) throw new ActionValidationError("Choose a valid employee.");
        const { data: employee, error } = await rawClient.from("hr_employees")
          .select("id,branch_id").eq("id", employeeId).is("deleted_at", null).maybeSingle();
        if (error) throw new Error(error.message);
        if (!employee || !identity.branches.some((branch) => branch.id === employee.branch_id)) throw new ActionValidationError("Employee not found in your branch scope.");
        branchId = employee.branch_id;
      } else {
        branchId = allowedBranch(body.branchId);
      }
      if (departmentId) {
        if (!isUuid(departmentId)) throw new ActionValidationError("Choose a valid department.");
        const { data: department, error } = await rawClient.from("hr_departments")
          .select("id").eq("id", departmentId).eq("branch_id", branchId).eq("is_active", true).is("deleted_at", null).maybeSingle();
        if (error) throw new Error(error.message);
        if (!department) throw new ActionValidationError("Choose an active department at the employee's branch.");
      }

      const values = {
        full_name: fullName,
        job_title: jobTitle,
        email,
        phone,
        department_id: departmentId,
        updated_at: now,
        server_updated_at: now,
      };
      const result = employeeId
        ? await rawClient.from("hr_employees").update(values).eq("id", employeeId).select("id").single()
        : await rawClient.from("hr_employees").insert({
            id: crypto.randomUUID(),
            branch_id: branchId,
            ...values,
            is_active: true,
            created_at: now,
            deleted_at: null,
          }).select("id").single();
      if (result.error) throw new Error(result.error.message);
      return finishAction(
        { id: result.data.id },
        branchId,
        employeeId ? "hr.employee_updated" : "hr.employee_created",
        "hr_employee",
        result.data.id,
        { fullName, jobTitle, departmentId },
      );
    }

    if (action === "setEmployeeActive") {
      const employeeId = typeof body.employeeId === "string" ? body.employeeId : "";
      if (!isUuid(employeeId) || typeof body.active !== "boolean") throw new ActionValidationError("Choose an employee and active status.");
      const { data, error } = await rawClient.from("hr_employees")
        .select("id,branch_id")
        .eq("id", employeeId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data || !identity.branches.some((branch) => branch.id === data.branch_id)) {
        throw new ActionValidationError("Employee not found in your branch scope.");
      }
      const { error: updateError } = await rawClient.from("hr_employees")
        .update({ is_active: body.active, updated_at: now, server_updated_at: now })
        .eq("id", employeeId).is("deleted_at", null);
      if (updateError) throw new Error(updateError.message);
      return finishAction(
        { id: data.id },
        data.branch_id,
        body.active ? "hr.employee_activated" : "hr.employee_deactivated",
        "hr_employee",
        employeeId,
        {},
      );
    }

    if (action === "saveCompensation" || action === "recordAttendance" || action === "recordAdvance") {
      if (!actorId) throw new ActionValidationError("Your staff profile is not linked for HR actions.");
      const employeeId = typeof body.employeeId === "string" ? body.employeeId : "";
      if (!isUuid(employeeId)) throw new ActionValidationError("Choose a valid employee.");
      const { data: employee, error: employeeError } = await rawClient.from("hr_employees")
        .select("id,branch_id").eq("id", employeeId).is("deleted_at", null).maybeSingle();
      if (employeeError) throw new Error(employeeError.message);
      if (!employee || !identity.branches.some((branch) => branch.id === employee.branch_id)) throw new ActionValidationError("Employee not found in your branch scope.");

      if (action === "saveCompensation") {
        if (!isCalendarDate(body.effectiveFrom)) throw new ActionValidationError("Choose a valid effective date.");
        const baseSalary = integer(body.baseSalaryPaisa, "Base salary");
        const allowances = integer(body.allowancesPaisa, "Allowances");
        const { data, error } = await rawClient.from("staff_compensation").insert({
          id: crypto.randomUUID(),
          staff_id: employeeId,
          branch_id: employee.branch_id,
          base_salary_paisa: baseSalary,
          allowances_paisa: allowances,
          effective_from: body.effectiveFrom,
          notes: text(body.notes, "Notes", 500),
          created_by: actorId,
          created_at: now,
          deleted_at: null,
          server_updated_at: now,
        }).select("id").single();
        if (error) throw new Error(error.message);
        return finishAction(
          { id: data.id },
          employee.branch_id,
          "compensation.saved",
          "staff_compensation",
          data.id,
          { employeeId, baseSalaryPaisa: baseSalary, allowancesPaisa: allowances, effectiveFrom: body.effectiveFrom },
        );
      }

      if (action === "recordAttendance") {
        if (!isCalendarDate(body.attendanceDate) || body.attendanceDate > todayInPakistan()) {
          throw new ActionValidationError("Attendance must be recorded for a valid date that is not in the future.");
        }
        const statuses = new Set(["present", "absent", "half_day", "leave", "holiday"]);
        if (typeof body.status !== "string" || !statuses.has(body.status)) throw new ActionValidationError("Choose a supported attendance status.");
        const { data: existing, error: existingError } = await rawClient.from("staff_attendance")
          .select("id,created_at").eq("staff_id", employeeId).eq("attendance_date", body.attendanceDate).maybeSingle();
        if (existingError) throw new Error(existingError.message);
        const values = {
          staff_id: employeeId,
          branch_id: employee.branch_id,
          attendance_date: body.attendanceDate,
          status: body.status,
          notes: text(body.notes, "Notes", 300),
          recorded_by: actorId,
          updated_at: now,
          deleted_at: null,
          server_updated_at: now,
        };
        const result = existing
          ? await rawClient.from("staff_attendance").update(values).eq("id", existing.id).select("id").single()
          : await rawClient.from("staff_attendance").insert({
              id: crypto.randomUUID(), ...values, created_at: now,
            }).select("id").single();
        if (result.error) throw new Error(result.error.message);
        return finishAction(
          { id: result.data.id },
          employee.branch_id,
          "attendance.recorded",
          "staff_attendance",
          `${employeeId}:${body.attendanceDate}`,
          { employeeId, attendanceDate: body.attendanceDate, status: body.status },
        );
      }

      if (!isCalendarDate(body.advanceDate)) throw new ActionValidationError("Choose a valid advance date.");
      const amountPaisa = integer(body.amountPaisa, "Advance amount", 1);
      const { data, error } = await rawClient.from("staff_advances").insert({
        id: crypto.randomUUID(),
        staff_id: employeeId,
        branch_id: employee.branch_id,
        advance_date: body.advanceDate,
        amount_paisa: amountPaisa,
        notes: text(body.notes, "Notes", 500),
        recorded_by: actorId,
        created_at: now,
        deleted_at: null,
        server_updated_at: now,
      }).select("id").single();
      if (error) throw new Error(error.message);
      return finishAction(
        { id: data.id },
        employee.branch_id,
        "advance.recorded",
        "staff_advance",
        data.id,
        { employeeId, amountPaisa },
      );
    }

    if (action === "saveDepartment" || action === "setDepartmentActive") {
      if (identity.staff.role !== "admin" || identity.staff.branch_id !== null) {
        return authenticationResponse(request, authentication, { error: "Only the HQ administrator can manage shared departments." }, 403);
      }
      if (action === "saveDepartment") {
        if (!actorId) throw new ActionValidationError("Your staff profile is not linked for department management.");
        const branchId = allowedBranch(body.branchId);
        const name = text(body.name, "Department name", 100, true);
        const description = text(body.description, "Description", 300);
        const { data, error } = await rawClient.from("hr_departments").insert({
          id: crypto.randomUUID(),
          branch_id: branchId,
          name,
          description,
          is_active: true,
          created_by: actorId,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          server_updated_at: now,
        }).select("id").single();
        if (error) throw new Error(error.message);
        return finishAction(
          { id: data.id },
          branchId,
          "hr.department_created",
          "hr_department",
          data.id,
          { name },
        );
      }
      const departmentId = typeof body.departmentId === "string" ? body.departmentId : "";
      if (!isUuid(departmentId) || typeof body.active !== "boolean") throw new ActionValidationError("Choose a department and active status.");
      const { data, error } = await rawClient.from("hr_departments")
        .update({ is_active: body.active, updated_at: now, server_updated_at: now })
        .eq("id", departmentId).is("deleted_at", null).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new ActionValidationError("Department not found.");
      const { data: department, error: departmentError } = await rawClient.from("hr_departments")
        .select("branch_id")
        .eq("id", departmentId)
        .is("deleted_at", null)
        .maybeSingle();
      if (departmentError) throw new Error(departmentError.message);
      if (!department) throw new ActionValidationError("Department not found.");
      return finishAction(
        { id: departmentId },
        department.branch_id,
        body.active ? "hr.department_activated" : "hr.department_deactivated",
        "hr_department",
        departmentId,
        {},
      );
    }

    if (action === "setPayrollTaxSettings" || action === "setPayrollItemTax") {
      let payload: Record<string, unknown>;
      if (action === "setPayrollTaxSettings") {
        if (identity.staff.role !== "admin") {
          return authenticationResponse(request, authentication, { error: "Only an administrator can change payroll tax settings." }, 403);
        }
        if (typeof body.enabled !== "boolean") throw new ActionValidationError("Choose whether manual payroll withholding is enabled.");
        payload = { enabled: body.enabled };
      } else {
        const itemId = typeof body.itemId === "string" ? body.itemId : "";
        if (!isUuid(itemId)) throw new ActionValidationError("Choose a valid payslip.");
        payload = {
          itemId,
          taxWithheldPaisa: integer(body.taxWithheldPaisa, "Withholding amount"),
        };
      }
      const { data, error } = await rawClient.rpc("staff_manage_payroll_tax", {
        p_action: action === "setPayrollTaxSettings" ? "set-settings" : "set-withholding",
        p_payload: payload,
      });
      if (error) {
        if (error.code === "PGRST202" || /could not find the function|schema cache/i.test(error.message)) {
          return authenticationResponse(request, authentication, {
            error: "Payroll tax settings are not installed yet. Apply supabase/migrations/042_payroll_tax_settings.sql and retry.",
          }, 503);
        }
        throw new Error(error.message);
      }
      return authenticationResponse(request, authentication, { result: data });
    }

    return authenticationResponse(request, authentication, { error: "Choose a supported HR or payroll action." }, 400);
  } catch (error) {
    console.error("Could not save HR or payroll action.", error);
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Could not save the HR or payroll action.",
    }, error instanceof ActionValidationError ? 400 : 500);
  }
}
