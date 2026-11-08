import { StoreOrdersWorkspace } from "@/components/workspace/StoreOrdersWorkspace";
import { getWorkspaceModule } from "@/lib/workspace-modules";

export default function OrdersPage() {
  const item = getWorkspaceModule("online-orders");
  return item ? <StoreOrdersWorkspace item={item} /> : null;
}
