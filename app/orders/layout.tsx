import { ManagementShell } from "@/components/ManagementShell";

export default function OrdersLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <ManagementShell>{children}</ManagementShell>;
}
