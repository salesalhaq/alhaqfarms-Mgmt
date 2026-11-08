import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

interface ServerEnvironment {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  STAFF_PIN_LOGIN_SECRET?: string;
  FBR_CONFIG_ENCRYPTION_KEY?: string;
}

function readValue(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = Reflect.get(source, key);
  return typeof value === "string" ? value : undefined;
}

export async function getServerEnvironment(): Promise<ServerEnvironment> {
  const source = process.env.NODE_ENV === "development"
    ? process.env
    : (await getCloudflareContext({ async: true })).env;

  return {
    NEXT_PUBLIC_SUPABASE_URL: readValue(source, "NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: readValue(source, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    STAFF_PIN_LOGIN_SECRET: readValue(source, "STAFF_PIN_LOGIN_SECRET"),
    FBR_CONFIG_ENCRYPTION_KEY: readValue(source, "FBR_CONFIG_ENCRYPTION_KEY"),
  };
}
