/**
 * [INPUT]: 当前 locale 与首页导航文案
 * [OUTPUT]: 首页顶部导航和可切换的语言菜单
 * [POS]: B 域首页 Header —— 独立拥有语言菜单开关状态
 * [PROTOCOL]: locale 切换只写 NEXT_LOCALE cookie 并刷新当前页面。
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Check, ChevronDown, ExternalLink, Menu } from "lucide-react";
import { isAppLocale, locales, type AppLocale } from "@/i18n/locales";

const LOCALE_LABELS: Record<AppLocale, string> = {
  en: "EN",
  zh: "中",
};

const LOCALE_MESSAGE_KEYS: Record<AppLocale, "english" | "chinese"> = {
  en: "english",
  zh: "chinese",
};

export default function HomeHeader() {
  const common = useTranslations("Common");
  const home = useTranslations("Home");
  const locale = useLocale();
  const [localeOpen, setLocaleOpen] = useState(false);
  if (!isAppLocale(locale)) throw new Error(`Unsupported application locale: ${locale}`);

  const currentLocaleLabel = LOCALE_LABELS[locale];
  const languageOptions = [...locales]
    .reverse()
    .map((value) => ({ value, label: common(LOCALE_MESSAGE_KEYS[value]) }));

  function switchLocale(nextLocale: AppLocale) {
    setLocaleOpen(false);
    if (nextLocale === locale) return;
    document.cookie = `NEXT_LOCALE=${nextLocale}; path=/; max-age=31536000; SameSite=Lax`;
    window.location.reload();
  }

  return (
    <header className="flex h-14 flex-none items-center justify-between gap-4 border-b border-[#24231f] bg-[#050505] px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-lg border border-[#24231f] bg-[#0b0b0a] text-[#b8b2a6] md:hidden"
          aria-label={home("openRecentProjects")}
        >
          <Menu size={16} />
        </button>
      </div>
      <nav className="flex flex-none items-center gap-1.5" aria-label={home("mainNav")}>
        <Link className="rounded-lg px-3 py-2 text-[13px] text-[#b8b2a6] transition hover:bg-[#11110f] hover:text-[#f54e00]" href="/showcase">
          {home("showcase")}
        </Link>
        <a
          className="hidden items-center gap-1 rounded-lg px-3 py-2 text-[13px] text-[#b8b2a6] transition hover:bg-[#11110f] hover:text-[#f54e00] sm:inline-flex"
          href="https://github.com/siuming-qiu/web-cursor"
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={14} /> GitHub
        </a>
        <Link className="hidden rounded-lg px-3 py-2 text-[13px] text-[#b8b2a6] transition hover:bg-[#11110f] hover:text-[#f54e00] sm:inline-flex" href="/about">
          {home("docs")}
        </Link>
        <div
          className="relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLocaleOpen(false);
          }}
        >
          <button
            type="button"
            className="inline-flex h-8 min-w-[58px] items-center justify-center gap-1 rounded-lg px-2 text-[13px] font-semibold text-[#b8b2a6] transition hover:bg-[#11110f] hover:text-[#f54e00] focus:bg-[#11110f] focus:outline-none"
            aria-haspopup="menu"
            aria-expanded={localeOpen}
            title={common("language")}
            onClick={() => setLocaleOpen((open) => !open)}
          >
            {currentLocaleLabel}
            <ChevronDown size={14} strokeWidth={2} className={"transition " + (localeOpen ? "rotate-180" : "")} />
          </button>

          {localeOpen && (
            <div
              className="absolute right-0 top-[calc(100%+8px)] z-30 w-[148px] overflow-hidden rounded-xl border border-[#24231f] bg-[#0b0b0a] p-1.5 shadow-[0_18px_42px_rgba(0,0,0,0.5)]"
              role="menu"
            >
              {languageOptions.map((option) => {
                const active = option.value === locale;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={
                      "flex h-9 w-full items-center justify-between rounded-lg px-3 text-left text-[13px] transition "
                      + (active ? "bg-[#11110f] text-[#f7f7f4]" : "text-[#8c877d] hover:bg-[#11110f] hover:text-[#f7f7f4]")
                    }
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => switchLocale(option.value)}
                  >
                    <span>{option.label}</span>
                    {active && <Check size={15} strokeWidth={2} className="text-[#f54e00]" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </nav>
    </header>
  );
}
