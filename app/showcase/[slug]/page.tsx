import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import ShowcaseWorkbench from "@/components/showcase/ShowcaseWorkbench";
import { SITE_OPEN_GRAPH_IMAGE, SITE_TWITTER_IMAGE } from "@/lib/site";
import { getPublishedShowcaseCase } from "@/server/showcase";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const [detail, detailT, casesT, locale] = await Promise.all([
    getPublishedShowcaseCase(slug),
    getTranslations("ShowcaseDetail"),
    getTranslations("ShowcaseCases"),
    getLocale(),
  ]);
  if (!detail) {
    return {
      title: detailT("notFoundTitle"),
      robots: { index: false, follow: false },
    };
  }
  let title = detail.title;
  try {
    title = casesT(`${detail.slug}.title`);
  } catch {
    // Historical showcase rows keep titles in the database until every slug has message keys.
  }
  const description = detailT("metadataDescription", { title });
  const openGraphImages = detail.coverImageUrl
    ? [{ url: detail.coverImageUrl, alt: detail.coverImageAlt ?? title }]
    : [SITE_OPEN_GRAPH_IMAGE];
  const twitterImages = detail.coverImageUrl
    ? [detail.coverImageUrl]
    : [SITE_TWITTER_IMAGE];

  return {
    title: `${title} · ${detailT("metadataTitleSuffix")}`,
    description,
    alternates: {
      canonical: `/showcase/${detail.slug}`,
    },
    openGraph: {
      type: "website",
      siteName: "Web Cursor",
      locale: locale === "en" ? "en_US" : "zh_CN",
      title,
      description,
      url: `/showcase/${detail.slug}`,
      images: openGraphImages,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: twitterImages,
    },
  };
}

export default async function ShowcaseCasePage({ params }: PageProps) {
  const { slug } = await params;
  const detail = await getPublishedShowcaseCase(slug);
  if (!detail) notFound();

  return <ShowcaseWorkbench detail={detail} />;
}
