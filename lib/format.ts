export function formatMoney(paisa: number): string {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(paisa / 100);
}

export function formatMoneyPrecise(paisa: number): string {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paisa / 100);
}

export function formatQuantity(milli: number): string {
  return new Intl.NumberFormat("en-PK", { maximumFractionDigits: 3 }).format(milli / 1000);
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function labelize(value: string | null | undefined): string {
  if (!value) return "Not set";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function statusTone(value: string | null | undefined): string {
  if (
    value === "paid" || value === "verified" || value === "delivered" ||
    value === "completed" || value === "approved" || value === "active" ||
    value === "received" || value === "sent" || value === "resolved"
  ) return "green";
  if (
    value === "pending_verification" || value === "awaiting_review" || value === "pending" ||
    value === "accepted" || value === "processing" || value === "sending" || value === "in_transit"
  ) return "amber";
  if (
    value === "rejected" || value === "cancelled" || value === "refunded" ||
    value === "failed" || value === "dead" || value === "revoked" || value === "inactive"
  ) return "red";
  if (value === "packed" || value === "dispatched" || value === "shipped" || value === "out_for_delivery") return "blue";
  return "";
}
