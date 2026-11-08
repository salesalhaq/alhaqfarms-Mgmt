import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";
import {
  assertSameOrigin,
  readInteger,
  readJsonBody,
  writeFailure,
  WriteError,
} from "@/lib/server/write";
import type { Database } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

const BUCKET = "web-data-backups";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const RETENTION_DAYS = 90;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertCanBackUp(role: string): void {
  if (role !== "admin" && role !== "manager") {
    throw new WriteError("Only administrators and managers can manage cloud backups.", 403);
  }
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  try {
    assertCanBackUp(authentication.identity.staff.role);
    const parameters = new URL(request.url).searchParams;
    const id = parameters.get("id") || "";
    if (id) {
      if (!isUuid(id)) throw new WriteError("Choose a valid cloud backup.");
      const { data: backup, error } = await authentication.client
        .from("web_data_backups")
        .select("id,object_path,file_name")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!backup) throw new WriteError("Cloud backup not found.", 404);
      const { data: file, error: downloadError } = await authentication.client.storage.from(BUCKET).download(backup.object_path);
      if (downloadError || !file) throw new Error(downloadError?.message || "The cloud backup file could not be downloaded.");
      const authorized = authenticationResponse(request, authentication, { success: true });
      const headers = new Headers(authorized.headers);
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("Content-Disposition", `attachment; filename="${backup.file_name.replace(/["\\\r\n]/g, "_")}"`);
      headers.set("Cache-Control", "private, no-store");
      return new Response(await file.arrayBuffer(), { headers });
    }

    const [backupResult, preferenceResult] = await Promise.all([
      authentication.client.from("web_data_backups")
        .select("id,branch_ids,file_name,size_bytes,date_from,date_to,trigger_type,created_at")
        .order("created_at", { ascending: false })
        .limit(100),
      authentication.client.from("web_data_backup_preferences")
        .select("branch_ids,frequency,schedule_day,schedule_time,retention_days,last_run_at")
        .maybeSingle(),
    ]);
    if (backupResult.error || preferenceResult.error) throw backupResult.error || preferenceResult.error;
    return authenticationResponse(request, authentication, {
      backups: backupResult.data || [],
      preferences: preferenceResult.data || {
        branch_ids: authentication.identity.branches.map((branch) => branch.id),
        frequency: "manual",
        schedule_day: null,
        schedule_time: "02:00:00",
        retention_days: RETENTION_DAYS,
        last_run_at: null,
      },
    });
  } catch (error) {
    console.error("Could not load cloud backups.", error);
    return authenticationResponse(request, authentication, {
      error: error instanceof Error ? error.message : "Cloud backups could not be loaded.",
    }, error instanceof WriteError ? error.status : 503);
  }
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  try {
    assertSameOrigin(request);
    assertCanBackUp(authentication.identity.staff.role);
    const body = await readJsonBody(request, MAX_FILE_BYTES);
    if (body.action === "save_schedule") {
      const frequency = body.frequency;
      if (frequency !== "manual" && frequency !== "daily" && frequency !== "weekly") {
        throw new WriteError("Choose a supported cloud backup schedule.");
      }
      const scheduleTime = typeof body.scheduleTime === "string" ? body.scheduleTime : "";
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) {
        throw new WriteError("Choose a valid backup time.");
      }
      const scheduleDay = frequency === "weekly"
        ? readInteger(body.scheduleDay, "Backup day", { minimum: 0, maximum: 6 })
        : null;
      if (!Array.isArray(body.branchIds)) throw new WriteError("Select the branches to include in backups.");
      const branchIds = [...new Set(body.branchIds.map((id) => {
        if (typeof id !== "string" || !isUuid(id)
          || !authentication.identity.branches.some((branch) => branch.id === id)) {
          throw new WriteError("A selected branch is not accessible to your account.", 403);
        }
        return id;
      }))];
      if (!branchIds.length) throw new WriteError("Select at least one branch for cloud backups.");
      const { data, error } = await authentication.client.from("web_data_backup_preferences")
        .upsert({
          owner_id: authentication.identity.staff.user_id,
          branch_ids: branchIds,
          frequency,
          schedule_day: scheduleDay,
          schedule_time: `${scheduleTime}:00`,
          retention_days: RETENTION_DAYS,
          updated_at: new Date().toISOString(),
          updated_by: authentication.identity.staff.user_id,
        }, { onConflict: "owner_id" })
        .select("branch_ids,frequency,schedule_day,schedule_time,retention_days,last_run_at")
        .single();
      if (error) throw error;
      return authenticationResponse(request, authentication, { preferences: data });
    }

    if (body.action !== "upload" || !isRecord(body.archive)) {
      throw new WriteError("Choose a valid backup action and data file.");
    }
    const archive = body.archive;
    if (archive.format !== "alhaqfarms-operational-export" || archive.version !== 1 || !isRecord(archive.dateRange)
      || !validDate(archive.dateRange.from) || !validDate(archive.dateRange.to)
      || archive.dateRange.from > archive.dateRange.to
      || (Date.parse(`${archive.dateRange.to}T00:00:00Z`) - Date.parse(`${archive.dateRange.from}T00:00:00Z`)) / 86_400_000 > 365
      || !Array.isArray(archive.branches)) {
      throw new WriteError("This file is not a supported Al Haq Farms operational export.");
    }
    const branchIds = [...new Set(archive.branches.map((branch) => {
      if (!isRecord(branch) || typeof branch.id !== "string" || !isUuid(branch.id)
        || !authentication.identity.branches.some((allowed) => allowed.id === branch.id)) {
        throw new WriteError("The export contains a branch not accessible to your account.", 403);
      }
      return branch.id;
    }))];
    if (!branchIds.length) throw new WriteError("The export does not contain any accessible branches.");
    const json = JSON.stringify(archive);
    const bytes = new TextEncoder().encode(json);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new WriteError("This cloud backup exceeds the 25 MB limit. Choose a shorter date range.", 413);
    }
    const id = crypto.randomUUID();
    const fileName = `alhaq-operational-export-${archive.dateRange.from}-${archive.dateRange.to}.json`;
    const objectPath = `${authentication.identity.staff.user_id}/${id}.json`;
    const { error: uploadError } = await authentication.client.storage.from(BUCKET).upload(objectPath, bytes, {
      contentType: "application/json",
      upsert: false,
    });
    if (uploadError) throw new Error(`The private cloud backup could not be uploaded: ${uploadError.message}`);

    const { error: metadataError } = await authentication.client.from("web_data_backups").insert({
      id,
      owner_id: authentication.identity.staff.user_id,
      branch_ids: branchIds,
      object_path: objectPath,
      file_name: fileName,
      size_bytes: bytes.byteLength,
      date_from: archive.dateRange.from,
      date_to: archive.dateRange.to,
      trigger_type: "manual",
    });
    if (metadataError) {
      const { error: cleanupError } = await authentication.client.storage.from(BUCKET).remove([objectPath]);
      if (cleanupError) console.error("Orphan cloud backup cleanup failed.", cleanupError);
      throw metadataError;
    }
    let warning: string | undefined;
    try {
      await pruneExpiredBackups(authentication.client, authentication.identity.staff.user_id);
    } catch (pruneError) {
      console.error("Cloud backup saved, but expired backups could not be pruned.", pruneError);
      warning = "The backup was saved, but an older backup could not be removed. Contact your administrator if this continues.";
    }
    return authenticationResponse(request, authentication, { success: true, backupId: id, warning });
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}

export async function DELETE(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  try {
    assertSameOrigin(request);
    assertCanBackUp(authentication.identity.staff.role);
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!isUuid(id)) throw new WriteError("Choose a valid cloud backup.");
    const { data: backup, error } = await authentication.client.from("web_data_backups")
      .select("id,object_path")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!backup) throw new WriteError("Cloud backup not found.", 404);
    const { error: removeError } = await authentication.client.storage.from(BUCKET).remove([backup.object_path]);
    if (removeError) throw new Error(`The cloud backup file could not be removed: ${removeError.message}`);
    const { error: deleteError } = await authentication.client.from("web_data_backups").delete().eq("id", id);
    if (deleteError) throw deleteError;
    return authenticationResponse(request, authentication, { success: true });
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}

async function pruneExpiredBackups(client: SupabaseClient<Database>, ownerId: string) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const { data: expired, error } = await client.from("web_data_backups")
    .select("id,object_path")
    .eq("owner_id", ownerId)
    .lt("created_at", cutoff);
  if (error) throw error;
  if (!expired?.length) return;
  const { error: removeError } = await client.storage.from(BUCKET).remove(expired.map((row) => row.object_path));
  if (removeError) throw new Error(`Expired cloud backups could not be removed: ${removeError.message}`);
  const { error: deleteError } = await client.from("web_data_backups").delete().in("id", expired.map((row) => row.id));
  if (deleteError) throw deleteError;
}
