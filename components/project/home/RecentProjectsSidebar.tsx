/**
 * [INPUT]: 新对话 action；当前 owner 的项目列表接口与 locale
 * [OUTPUT]: 可折叠的最近项目导航，项目点击后进入对应工作台
 * [POS]: B 域首页最近项目状态 owner —— 独立拥有请求、loading、error 与折叠状态
 * [PROTOCOL]: 项目响应必须通过 ProjectListSchema；非法响应明确展示错误，不做字段兜底。
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  FileText,
  PanelsTopLeft,
  Plus,
} from "lucide-react";
import { isAppLocale } from "@/i18n/locales";
import { req } from "@/lib/api";
import { formatTime, ProjectListSchema, type Project } from "@/lib/projectTypes";

type RecentProjectsSidebarProps = {
  onNewConversation: () => void;
};

export default function RecentProjectsSidebar({ onNewConversation }: RecentProjectsSidebarProps) {
  const router = useRouter();
  const home = useTranslations("Home");
  const locale = useLocale();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const visibleProjects = projects.slice(0, 10);

  useEffect(() => {
    let alive = true;
    req<unknown>("GET", "/api/projects")
      .then((value) => {
        if (alive) setProjects(ProjectListSchema.parse(value));
      })
      .catch((requestError) => {
        console.error("Failed to load strict project list contract", requestError);
        if (!alive) return;
        setProjects([]);
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!isAppLocale(locale)) throw new Error(`Unsupported application locale: ${locale}`);

  return (
    <aside
      className={
        "hidden min-w-0 flex-none flex-col border-r border-[#24231f] bg-[#070706] md:flex "
        + (collapsed ? "w-16" : "w-[260px]")
      }
    >
      <div className={"flex h-14 items-center gap-3 border-b border-[#24231f] " + (collapsed ? "justify-center px-3" : "justify-between px-4")}>
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 text-left"
          onClick={() => router.push("/")}
          aria-label={home("homeAria")}
        >
          <span className="grid h-8 w-8 flex-none place-items-center rounded-lg border border-[#2d2b25] bg-[#0d0d0b]">
            <img src="/icon.png" alt="" className="h-5 w-5 rounded-[4px]" />
          </span>
          {!collapsed && <span className="truncate text-sm font-semibold">Web Cursor</span>}
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-lg border border-[#24231f] bg-transparent text-[#8c877d] transition hover:text-[#f7f7f4]"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? home("expandRecentProjects") : home("collapseRecentProjects")}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <button
          type="button"
          className={
            "mb-3 flex h-9 items-center rounded-lg text-sm font-medium text-[#d8d3c8] transition hover:bg-[#11110f] hover:text-[#f54e00] "
            + (collapsed ? "mx-auto w-9 justify-center" : "w-full gap-2 px-2")
          }
          onClick={onNewConversation}
          aria-label={home("newConversation")}
        >
          <Plus size={16} />
          {!collapsed && <span>{home("newConversation")}</span>}
        </button>

        {!collapsed && <div className="px-2 pb-1 text-[11px] font-medium text-[#6f6a60]">{home("recentProjects")}</div>}
        <div className="grid gap-1">
          {loading ? (
            [0, 1, 2, 3].map((index) => (
              <div
                key={index}
                className={(collapsed ? "mx-auto h-9 w-9" : "h-[52px] w-full") + " animate-pulse rounded-lg bg-[#11110f]"}
              />
            ))
          ) : error ? (
            !collapsed && <div className="break-words px-2 py-3 text-[12px] text-red-400">{error}</div>
          ) : visibleProjects.length ? (
            visibleProjects.map((project, index) => (
              <button
                key={project.id}
                type="button"
                className={
                  "grid rounded-lg text-left text-[#f7f7f4] transition hover:bg-[#11110f] "
                  + (collapsed ? "mx-auto h-9 w-9 place-items-center p-0" : "w-full grid-cols-[28px_minmax(0,1fr)] gap-2 px-2 py-2")
                }
                onClick={() => router.push(`/p/${project.id}`)}
                title={project.title}
              >
                <span className="grid h-7 w-7 place-items-center rounded-md border border-[#24231f] bg-[#0b0b0a] text-[#f54e00]">
                  {index % 3 === 0 ? <PanelsTopLeft size={14} /> : index % 3 === 1 ? <FileText size={14} /> : <Code2 size={14} />}
                </span>
                {!collapsed && (
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{project.title}</span>
                    <span className="mt-0.5 block text-[12px] text-[#807a70]">{formatTime(project.updatedAt ?? project.createdAt, locale)}</span>
                  </span>
                )}
              </button>
            ))
          ) : (
            !collapsed && <div className="px-2 py-3 text-[12px] text-[#807a70]">{home("emptyProjects")}</div>
          )}
        </div>
      </div>
    </aside>
  );
}
