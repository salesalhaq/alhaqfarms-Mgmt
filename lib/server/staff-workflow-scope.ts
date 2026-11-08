export function isHqAdmin(staff: { role: string; branch_id: string | null }): boolean {
  return staff.role === "admin" && staff.branch_id === null;
}

export function cashierOrderVisibilityFilter(staffId: string): string {
  return [
    "and(status.eq.accepted,payment_review_status.neq.awaiting_review)",
    `packed_by.eq.${staffId}`,
    `dispatched_by.eq.${staffId}`,
    `delivered_by.eq.${staffId}`,
    `cancelled_by.eq.${staffId}`,
    `payment_verified_by.eq.${staffId}`,
    `payment_rejected_by.eq.${staffId}`,
  ].join(",");
}

export function cashierCanViewOrder(
  order: {
    status: string;
    payment_review_status: string;
    packed_by: string | null;
    dispatched_by: string | null;
    delivered_by: string | null;
    cancelled_by: string | null;
    payment_verified_by: string | null;
    payment_rejected_by: string | null;
  },
  staffId: string,
): boolean {
  return (order.status === "accepted" && order.payment_review_status !== "awaiting_review")
    || order.packed_by === staffId
    || order.dispatched_by === staffId
    || order.delivered_by === staffId
    || order.cancelled_by === staffId
    || order.payment_verified_by === staffId
    || order.payment_rejected_by === staffId;
}

export function cashierReturnVisibilityFilter(staffId: string): string {
  return [
    `created_by.eq.${staffId}`,
    `approved_by.eq.${staffId}`,
    `rejected_by.eq.${staffId}`,
    `completed_by.eq.${staffId}`,
  ].join(",");
}

export function cashierCanViewReturn(
  returnRecord: {
    created_by: string | null;
    approved_by: string | null;
    rejected_by: string | null;
    completed_by: string | null;
  },
  staffId: string,
): boolean {
  return returnRecord.created_by === staffId
    || returnRecord.approved_by === staffId
    || returnRecord.rejected_by === staffId
    || returnRecord.completed_by === staffId;
}
