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

    const [itemResult, eventResult] = await Promise.all([
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
    ]);
    if (itemResult.error || eventResult.error) throw new Error("Order history could not be loaded.");

    let proofUrl: string | null = null;
    if (order.payment_proof_path) {
      const { data, error } = await authentication.client.storage
        .from("web-order-payment-proofs")
        .createSignedUrl(order.payment_proof_path, 300);
      if (error) throw new Error("Payment evidence is unavailable to this staff account.");
      proofUrl = data.signedUrl;
    }

    return authenticationResponse(request, authentication, {
      order,
      items: itemResult.data || [],
      events: eventResult.data || [],
      proofUrl,
    });
  } catch {
    return authenticationResponse(
      request,
      authentication,
      { error: "Order details could not be loaded. Please try again." },
      503,
    );
  }
}
