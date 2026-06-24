import Workbench from "@/components/Workbench";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectPage({ params }: PageProps) {
  const { projectId } = await params;
  return <Workbench projectId={projectId} />;
}
