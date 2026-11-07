import { notFound } from "next/navigation";
import { WorkspacePage } from "@/components/workspace/WorkspacePage";
import { getWorkspaceModule } from "@/lib/workspace-modules";

export default async function WorkspaceModulePage({
  params,
}: {
  params: Promise<{ module: string }>;
}) {
  const { module } = await params;
  if (!getWorkspaceModule(module)) notFound();
  return <WorkspacePage moduleSlug={module} />;
}
