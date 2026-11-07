import { ManagementShell } from "@/components/ManagementShell";

export default function WorkspaceLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <ManagementShell>{children}</ManagementShell>;
}
