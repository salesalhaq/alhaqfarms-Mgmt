import { NextResponse } from "next/server";
import { authenticateStaff, authenticationResponse, isUuid } from "@/lib/server/staff-auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authentication = await authenticateStaff(request);
  if (!authentication.ok) {
    return authenticationResponse(request, authentication, { error: authentication.error }, authentication.status);
  }
  if (!authentication.identity.canViewOrders) {
    return authenticationResponse(request, authentication, { error: "Your role does not have access to online orders." }, 403);
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return authenticationResponse(request, authentication, { error: "Order not found." }, 404);
  }

  try {
    const { data: order, error: orderError } = await authentication.client
      .from("web_orders")
      .select("id,order_number,branch_id,status,fulfillment_type,customer_name,customer_phone,delivery_address,payment_method,payment_status,payment_reference,payment_verified_at,subtotal_paisa,tax_paisa,total_paisa,notes,created_at,deleted_at,payment_proof_path,payment_review_status,payment_rejection_reason")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (orderError) throw new Error(orderError.message);
    if (!order) {
      return authenticationResponse(request, authentication, { error: "Order not found or branch access is denied." }, 404);
    }

    const allowedActions = ["accept", "pack", "dispatch", "deliver", "verify_payment", "cancel"];
    if (authentication.identity.staff.role !== "admin") {
      const { data: permissions, error: permissionError } = await authentication.client
        .from("web_order_permissions")
        .select("action,is_allowed")
        .eq("branch_id", order.branch_id)
        .eq("role", authentication.identity.staff.role)
        .is("deleted_at", null);
      if (permissionError) throw new Error(permissionError.message);
      for (const permission of permissions || []) {
        if (!permission.is_allowed) {
          const index = allowedActions.indexOf(permission.action);
          if (index >= 0) allowedActions.splice(index, 1);
        }
      }
    }
    if (allowedActions.includes("verify_payment")) allowedActions.push("reject_payment");

    const [itemResult, eventResult, branchResult] = await Promise.all([
      authentication.client
        .from("web_order_items")
        .select("id,order_id,line_number,product_id,product_name,sku,unit_code,quantity_milli,unit_price_paisa,tax_paisa,line_total_paisa")
        .eq("order_id", id)
        .is("deleted_at", null)
        .order("line_number", { ascending: true }),
      authentication.client
        .from("web_order_events")
        .select("id,order_id,branch_id,actor_id,event_type,previous_status,next_status,payment_reference,notes,occurred_at")
        .eq("order_id", id)
        .is("deleted_at", null)
        .order("occurred_at", { ascending: true }),
      authentication.client
        .from("branches")
        .select("id,name")
        .eq("id", order.branch_id)
        .maybeSingle(),
    ]);
    if (itemResult.error || eventResult.error || branchResult.error) throw new Error("Order history could not be loaded.");
    const actorIds = [...new Set((eventResult.data || [])
      .map((event) => event.actor_id)
      .filter((actorId): actorId is string => Boolean(actorId)))];
    const staffNames = new Map<string, string>();
    if (actorIds.length && ["admin", "manager"].includes(authentication.identity.staff.role)) {
      const { data: profiles, error: profilesError } = await authentication.client
        .from("staff_profiles")
        .select("id,full_name")
        .in("id", actorIds)
        .is("deleted_at", null);
      if (profilesError) throw new Error(profilesError.message);
      for (const profile of profiles || []) staffNames.set(profile.id, profile.full_name);
    } else if (authentication.identity.staff.local_staff_id) {
      staffNames.set(authentication.identity.staff.local_staff_id, authentication.identity.staff.full_name);
    }

    let proofUrl: string | null = null;
    const paymentProofAvailable = Boolean(order.payment_proof_path);
    if (order.payment_proof_path && allowedActions.includes("verify_payment")) {
      const { data, error } = await authentication.client.storage
        .from("web-order-payment-proofs")
        .createSignedUrl(order.payment_proof_path, 300);
      if (error) throw new Error("Payment evidence is unavailable to this staff account.");
      proofUrl = data.signedUrl;
    }
    const { payment_proof_path: _paymentProofPath, ...safeOrder } = order;

    return authenticationResponse(request, authentication, {
      order: { ...safeOrder, branch_name: branchResult.data?.name || "Your branch" },
      items: itemResult.data || [],
      events: (eventResult.data || []).map((event) => ({
        ...event,
        actor_name: event.actor_id
          ? staffNames.get(event.actor_id) || "Staff member"
          : "System",
      })),
      allowedActions,
      paymentProofAvailable,
      proofUrl,
    });
  } catch (error) {
    console.error("Could not load online order details.", error);
    return authenticationResponse(
      request,
      authentication,
      { error: "Order details could not be loaded. Please try again." },
      503,
    );
  }
}
