import { AdminReportsWorkspace } from "@/components/workspace/AdminReportsWorkspace";

export default function AdminReportsPage() {
  return (
    <AdminReportsWorkspace
      item={{
        section: "Admin",
        title: "Admin reports",
        description: "Review sales, returns, payment mix, and tax performance for the selected branch and period.",
      }}
    />
  );
}
