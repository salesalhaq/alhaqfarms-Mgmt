import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = "web-data-backups";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const RETENTION_DAYS = 90;

interface BackupPreference {
  owner_id: string;
  branch_ids: string[];
  frequency: "daily" | "weekly";
  schedule_day: number | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}

function pakistanDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateOffset(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : "The scheduled backup failed.";
}

async function pruneExpiredBackups(
  client: ReturnType<typeof createClient>,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
  const { data: expired, error } = await client.from("web_data_backups")
    .select("id,object_path")
    .lt("created_at", cutoff)
    .limit(500);
  if (error) throw new Error(`Expired cloud backups could not be listed: ${error.message}`);
  if (!expired?.length) return;
  const { error: removeError } = await client.storage.from(BUCKET).remove(expired.map((backup) => backup.object_path));
  if (removeError) throw new Error(`Expired cloud backup files could not be removed: ${removeError.message}`);
  const { error: deleteError } = await client.from("web_data_backups").delete().in("id", expired.map((backup) => backup.id));
  if (deleteError) throw new Error(`Expired cloud backup records could not be removed: ${deleteError.message}`);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const appBaseUrl = Deno.env.get("APP_BASE_URL")?.replace(/\/+$/, "");
  const cronSecret = Deno.env.get("CLOUD_BACKUP_CRON_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !appBaseUrl || !cronSecret) {
    console.error("Cloud data backup function is missing required configuration.");
    return jsonResponse({ error: "Scheduled cloud backups are not configured." }, 503);
  }
  if (request.headers.get("x-cron-secret") !== cronSecret) {
    return jsonResponse({ error: "Scheduled backup authorization failed." }, 401);
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const now = new Date();
  const today = pakistanDate(now);
  try {
    await pruneExpiredBackups(client, now);
  } catch (error) {
    console.error("Could not enforce cloud backup retention:", errorText(error));
    return jsonResponse({ error: "Cloud backup retention cleanup failed." }, 503);
  }
  const { data: duePreferences, error: claimError } = await client.rpc(
    "claim_due_web_data_backup_preferences",
    { p_now: now.toISOString() },
  );
  if (claimError) {
    console.error("Could not claim scheduled cloud backup jobs:", claimError.message);
    return jsonResponse({ error: "Scheduled cloud backups could not be checked." }, 503);
  }

  const results: { ownerId: string; success: boolean; error?: string }[] = [];
  for (const rawPreference of duePreferences || []) {
    const preference = rawPreference as BackupPreference;
    let objectPath: string | null = null;
    let metadataSaved = false;
    try {
      const from = dateOffset(today, -(RETENTION_DAYS - 1));
      const parameters = new URLSearchParams({
        from,
        to: today,
        ownerId: preference.owner_id,
        branchIds: preference.branch_ids.join(","),
      });
      const exportResponse = await fetch(`${appBaseUrl}/api/workspace/data-export?${parameters.toString()}`, {
        headers: { "x-cloud-backup-secret": cronSecret },
        cache: "no-store",
      });
      const archive = await exportResponse.json();
      if (!exportResponse.ok) {
        const message = archive && typeof archive.error === "string" ? archive.error : "The scheduled export could not be created.";
        throw new Error(message);
      }

      const bytes = new TextEncoder().encode(JSON.stringify(archive));
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
        throw new Error("The scheduled backup exceeds the 25 MB storage limit.");
      }
      const backupId = crypto.randomUUID();
      objectPath = `${preference.owner_id}/${backupId}.json`;
      const { error: uploadError } = await client.storage.from(BUCKET).upload(objectPath, bytes, {
        contentType: "application/json",
        upsert: false,
      });
      if (uploadError) throw new Error(`The cloud backup file could not be uploaded: ${uploadError.message}`);

      const { error: metadataError } = await client.from("web_data_backups").insert({
        id: backupId,
        owner_id: preference.owner_id,
        branch_ids: preference.branch_ids,
        object_path: objectPath,
        file_name: `alhaq-operational-export-${from}-${today}.json`,
        size_bytes: bytes.byteLength,
        date_from: from,
        date_to: today,
        trigger_type: "scheduled",
      });
      if (metadataError) throw new Error(`Cloud backup metadata could not be saved: ${metadataError.message}`);
      metadataSaved = true;

      const { error: updateError } = await client.from("web_data_backup_preferences")
        .update({ last_run_date: today, last_run_at: now.toISOString() })
        .eq("owner_id", preference.owner_id);
      if (updateError) throw new Error(`Cloud backup schedule status could not be updated: ${updateError.message}`);

      results.push({ ownerId: preference.owner_id, success: true });
    } catch (error) {
      if (objectPath && !metadataSaved) {
        const { error: cleanupError } = await client.storage.from(BUCKET).remove([objectPath]);
        if (cleanupError) console.error("Failed to clean up an incomplete scheduled backup:", cleanupError.message);
      }
      const message = errorText(error);
      console.error(`Scheduled cloud backup failed for ${preference.owner_id}:`, message);
      if (metadataSaved) {
        console.error(`The scheduled backup file is available, but post-upload maintenance failed for ${preference.owner_id}.`);
        continue;
      }
      results.push({ ownerId: preference.owner_id, success: false, error: message });
    }
  }

  return jsonResponse({
    checkedAt: now.toISOString(),
    claimed: (duePreferences || []).length,
    succeeded: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
  });
});
