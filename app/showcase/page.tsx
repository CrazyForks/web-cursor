import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { SITE_OPEN_GRAPH_IMAGE, SITE_TWITTER_IMAGE } from "@/lib/site";
import { listPublishedShowcaseCases } from "@/server/showcase";

export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([
    getTranslations("ShowcaseIndex"),
    getLocale(),
  ]);
  const title = t("metadataTitle");
  const description = t("metadataDescription");
  return {
    title,
    description,
    alternates: {
      canonical: "/showcase",
    },
    openGraph: {
      type: "website",
      siteName: "Web Cursor",
      locale: locale === "en" ? "en_US" : "zh_CN",
      title,
      description,
      url: "/showcase",
      images: [SITE_OPEN_GRAPH_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [SITE_TWITTER_IMAGE],
    },
  };
}

export default async function ShowcaseIndexPage() {
  const [cases, t, casesT, locale] = await Promise.all([
    listPublishedShowcaseCases(),
    getTranslations("ShowcaseIndex"),
    getTranslations("ShowcaseCases"),
    getLocale(),
  ]);

  function showcaseText(slug: string, field: "title" | "description" | "coverAlt", fallback?: string) {
    try {
      return casesT(`${slug}.${field}`);
    } catch {
      return fallback ?? "";
    }
  }

  return (
    <main className="h-screen overflow-y-auto bg-[#080807] text-[#f7f4ec]">
      <section className="border-b border-[#29241d] px-5 py-5 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-6xl">
          <nav className="flex h-12 items-center justify-between gap-4">
            <Link href="/" className="font-mono text-[13px] font-semibold text-[#f25516]">
              Web Cursor
            </Link>
            <Link href="/" className="rounded-md border border-[#3b3328] px-3 py-2 text-sm text-[#f7f4ec] transition hover:border-[#f25516]">
              {t("openWorkbench")}
            </Link>
          </nav>

          <div className="py-16">
            <p className="font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[#9d927f]">{t("eyebrow")}</p>
            <h1 className="mt-5 max-w-4xl text-4xl font-normal leading-[1.06] sm:text-6xl">
              {t("title")}
            </h1>
            <p className="mt-6 max-w-2xl text-sm leading-7 text-[#b7aa96]">
              {t("description")}
            </p>
          </div>
        </div>
      </section>

      <section className="px-5 py-12 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-6xl">
          {cases.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#29241d] bg-[#12100d] p-8 text-sm leading-7 text-[#b7aa96]">
              {t("empty")}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {cases.map((item) => {
                const title = showcaseText(item.slug, "title", item.title);
                const description = showcaseText(item.slug, "description", item.description || item.conversationTitle || t("fallbackDescription"));
                return (
                <Link
                  key={item.slug}
                  href={`/showcase/${item.slug}`}
                  className="group relative flex min-h-[210px] flex-col overflow-hidden rounded-xl border border-[#29241d] bg-[#12100d] p-5 transition hover:-translate-y-0.5 hover:border-[#f25516] hover:bg-[#17130f]"
                >
                  {item.coverImageUrl ? (
                    <img
                      src={item.coverImageUrl}
                      alt={showcaseText(item.slug, "coverAlt", item.coverImageAlt || title)}
                      className="absolute inset-0 h-full w-full object-cover opacity-35 transition duration-500 group-hover:scale-105 group-hover:opacity-45"
                    />
                  ) : null}
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,8,7,0.18),rgba(8,8,7,0.96))]" />
                  <span className="absolute right-5 top-5 z-[1] text-[11px] text-[#756b5d]">
                    {new Date(item.publishedAt).toLocaleDateString(locale === "en" ? "en-US" : "zh-CN")}
                  </span>
                  <div className="relative flex flex-1 flex-col justify-between gap-4">
                    <h2 className="text-xl font-semibold leading-snug text-[#f7f4ec] group-hover:text-[#ff6b2c]">
                      {title}
                    </h2>
                    <p className="line-clamp-3 min-h-[56px] text-sm leading-7 text-[#b7aa96]">
                      {description}
                    </p>
                  </div>
                </Link>
              )})}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
