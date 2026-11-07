import { StoreReportsWorkspace } from "@/components/workspace/StoreReportsWorkspace";

export default function StoreReportsPage() {
  return (
    <StoreReportsWorkspace
      item={{
        section: "Store portal",
        title: "Store reports",
        description: "Review branch sales, refunds, payment mix, and top product performance for the selected period.",
      }}
    />
  );
}
