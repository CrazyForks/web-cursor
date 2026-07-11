import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { listPublishedShowcaseCases } from "@/server/showcase";

export const revalidate = 300;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const cases = await listPublishedShowcaseCases();

  return [
    {
      url: SITE_URL,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/about`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/ai-react-playground`,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/showcase`,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...cases.map((item) => ({
      url: `${SITE_URL}/showcase/${encodeURIComponent(item.slug)}`,
      lastModified: new Date(item.publishedAt),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
