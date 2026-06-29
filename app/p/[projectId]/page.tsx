import type { Metadata } from "next";
import Workbench from "@/components/Workbench";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export const metadata: Metadata = {
  title: "项目工作台",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function ProjectPage({ params }: PageProps) {
  const { projectId } = await params;
  return <Workbench projectId={projectId} />;
}
