import { StoreOrdersWorkspace } from "@/components/workspace/StoreOrdersWorkspace";
import { getWorkspaceModule } from "@/lib/workspace-modules";

export default async function OrderDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = getWorkspaceModule("online-orders");
  return item ? <StoreOrdersWorkspace item={item} initialOrderId={id} /> : null;
}
