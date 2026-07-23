/**
 * [INPUT]: 服务端预取的公开案例摘要；首页子区域回传的新项目首轮输入
 * [OUTPUT]: 首页稳定布局，或携首轮输入切换到 Workbench
 * [POS]: B 域首页装配层 —— 只拥有页面模式和少量跨区域新对话协调
 * [PROTOCOL]: Database 无 projectId 直接进入 Workbench；Browser Git 由 ProjectStarter 创建成功后再进入。
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import Workbench from "@/components/Workbench";
import HomeHeader from "@/components/project/home/HomeHeader";
import ProjectStarter, { type ProjectStartPayload } from "@/components/project/home/ProjectStarter";
import RecentProjectsSidebar from "@/components/project/home/RecentProjectsSidebar";
import type { ShowcaseListItem } from "@/lib/showcaseTypes";

type HomePageProps = {
  showcases: ShowcaseListItem[];
};

export default function HomePage({ showcases }: HomePageProps) {
  const home = useTranslations("Home");
  const showcaseCases = useTranslations("ShowcaseCases");
  const [composerResetSignal, setComposerResetSignal] = useState(0);
  const [startedTurn, setStartedTurn] = useState<ProjectStartPayload | null>(null);

  const showcaseText = useCallback((slug: string, field: "title" | "description" | "coverAlt", fallback?: string) => {
    try {
      return showcaseCases(`${slug}.${field}`);
    } catch {
      return fallback ?? "";
    }
  }, [showcaseCases]);

  const suggestions = useMemo(
    () => showcases.slice(0, 3).map((item) => {
      const title = showcaseText(item.slug, "title", item.title);
      const description = showcaseText(item.slug, "description", item.description);
      return {
        label: title,
        slug: item.slug,
        description,
        coverImageUrl: item.coverImageUrl,
        coverImageAlt: showcaseText(item.slug, "coverAlt", item.coverImageAlt || title),
      };
    }),
    [showcaseText, showcases],
  );

  if (startedTurn) {
    return (
      <Workbench
        projectId={startedTurn.projectId}
        initialPrompt={startedTurn.prompt}
        initialAttachments={startedTurn.attachments}
      />
    );
  }

  return (
    <div className="flex h-screen min-h-0 bg-[#050505] text-[#f7f7f4]">
      <RecentProjectsSidebar onNewConversation={() => setComposerResetSignal((value) => value + 1)} />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <HomeHeader />

        <section className="min-h-0 flex-1 overflow-y-auto px-4 md:px-8">
          <div className="mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-[780px] flex-col pt-[18vh]">
            <div className="mb-5 text-center">
              <h1 className="text-[30px] font-semibold leading-tight tracking-normal text-[#f7f7f4] md:text-[38px]">{home("heroTitle")}</h1>
            </div>

            <ProjectStarter resetSignal={composerResetSignal} onStart={setStartedTurn} />

            {suggestions.length > 0 && (
              <section className="mt-5">
                <h2 className="mb-2 px-1 text-left text-[13px] font-semibold text-[#8c877d]">{home("featuredShowcases")}</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                  {suggestions.map((item) => (
                    <Link
                      key={item.slug}
                      href={`/showcase/${item.slug}`}
                      className="group relative min-h-[132px] overflow-hidden rounded-xl border border-[#24231f] bg-[#0b0b0a] text-left shadow-[0_16px_42px_rgba(0,0,0,0.24)] transition hover:-translate-y-0.5 hover:border-[#5a3a28]"
                      title={item.label}
                    >
                      {item.coverImageUrl ? (
                        <img
                          src={item.coverImageUrl}
                          alt={item.coverImageAlt}
                          className="absolute inset-0 h-full w-full object-cover opacity-72 transition duration-500 group-hover:scale-[1.035] group-hover:opacity-82"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-[linear-gradient(135deg,#171511,#080807_58%,#241006)]" />
                      )}
                      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,5,5,0.82),rgba(5,5,5,0.36)_52%,rgba(5,5,5,0.1))]" />
                      <div className="relative flex min-h-[132px] flex-col justify-between p-4">
                        <h3 className="line-clamp-2 text-[17px] font-semibold leading-snug text-[#f7f7f4] drop-shadow-[0_1px_12px_rgba(0,0,0,0.65)]">
                          {item.label}
                        </h3>
                        {item.description ? (
                          <p className="line-clamp-2 min-h-10 text-[12px] leading-5 text-[#d7d0c5] drop-shadow-[0_1px_10px_rgba(0,0,0,0.65)]">
                            {item.description}
                          </p>
                        ) : null}
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
