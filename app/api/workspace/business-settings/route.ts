import { authenticateStaff, authenticationResponse } from "@/lib/server/staff-auth";
import {
  assertSameOrigin,
  readJsonBody,
  WriteError,
  writeFailure,
} from "@/lib/server/write";
import { parseBusinessSettings } from "@/lib/business-settings";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    const { data, error } = await authentication.client
      .from("web_business_settings")
      .select("settings")
      .eq("id", "shop")
      .maybeSingle();
    if (error) throw error;

    return authenticationResponse(request, authentication, {
      settings: data ? parseBusinessSettings(data.settings) : parseBusinessSettings({}),
    });
  } catch (error) {
    console.error("Could not load web business settings.", error);
    return authenticationResponse(
      request,
      authentication,
      { error: "Business settings could not be loaded. Please try again." },
      503,
    );
  }
}

export async function POST(request: Request) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }

  try {
    assertSameOrigin(request);
    if (authentication.identity.staff.role !== "admin") {
      throw new WriteError("Only an administrator can change shop branding.", 403);
    }
    const body = await readJsonBody(request, 3 * 1024 * 1024);
    const settings = parseBusinessSettings(body.settings);
    const { error } = await authentication.client
      .from("web_business_settings")
      .upsert({
        id: "shop",
        settings: { ...settings },
        updated_at: new Date().toISOString(),
        updated_by: authentication.identity.staff.user_id,
      }, { onConflict: "id" });
    if (error) throw error;

    return authenticationResponse(request, authentication, { settings });
  } catch (error) {
    return writeFailure(request, authentication, error);
  }
}
