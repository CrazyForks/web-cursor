import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import ShowcaseWorkbench from "@/components/showcase/ShowcaseWorkbench";
import { getPublishedShowcaseCase, listPublishedShowcaseCases } from "@/server/showcase";

export const revalidate = 300;
export const dynamicParams = true;

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  const cases = await listPublishedShowcaseCases();
  return cases.map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const [detail, detailT, casesT] = await Promise.all([
    getPublishedShowcaseCase(slug),
    getTranslations("ShowcaseDetail"),
    getTranslations("ShowcaseCases"),
  ]);
  if (!detail) {
    return {
      title: detailT("notFoundTitle"),
      robots: { index: false, follow: false },
    };
  }
  let title = detail.title;
  let description = detail.description;
  try {
    title = casesT(`${detail.slug}.title`);
    description = casesT(`${detail.slug}.description`);
  } catch {
    // Historical showcase rows keep title/description in DB until every slug has message keys.
  }

  return {
    title: `${title} · ${detailT("metadataTitleSuffix")}`,
    description: description ?? detailT("metadataDescription", { title }),
    alternates: {
      canonical: `/showcase/${detail.slug}`,
    },
    openGraph: {
      title,
      description: description ?? detailT("openGraphDescription"),
      url: `/showcase/${detail.slug}`,
    },
  };
}

export default async function ShowcaseCasePage({ params }: PageProps) {
  const { slug } = await params;
  const detail = await getPublishedShowcaseCase(slug);
  if (!detail) notFound();

  return <ShowcaseWorkbench detail={detail} />;
}
