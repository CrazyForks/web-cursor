/**
 * [INPUT]: Optional returnTo + resume/log callbacks
 * [OUTPUT]: A reusable integration card that owns Figma OAuth status/connect/disconnect flow
 * [POS]: B 域 Figma 授权卡片 —— 展示当前连接状态，不持有 token
 * [PROTOCOL]: 连接事实只来自 /api/integrations/figma/status；页面不应自己复制 status/OAuth 流程
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, CheckCircle2, Link2, Loader2, RefreshCw, Unplug, Wand2, XCircle } from "lucide-react";
import { req } from "@/lib/api";
import { getOwnerId } from "@/lib/owner";

export type FigmaConnectionStatus =
  | { status: "loading" }
  | { status: "disconnected" }
  | { status: "connected"; figmaUserId: string; scopes: string[]; expiresAt: string | null }
  | { status: "error"; message: string };

type ServerFigmaStatus =
  | { status: "connected"; figmaUserId: string; scopes: string[]; expiresAt: string | null }
  | { status: "disconnected" };

type Props = {
  returnTo?: string;
  onResume?: () => void;
  showDisconnect?: boolean;
  onLog?: (message: string) => void;
};

const buttonBase =
  "inline-flex h-8 items-center justify-center gap-2 rounded-md border px-3 text-[12.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = `${buttonBase} border-[#f24e1e] bg-[#f24e1e] text-white hover:bg-[#d94419]`;
const quietButton = `${buttonBase} border-[#34312b] bg-[#151412] text-[#f7f3ea] hover:border-[#5d554a]`;
const dangerButton = `${buttonBase} border-[#4a2a25] bg-[#211412] text-[#ffb8aa] hover:border-[#8d4336]`;

function formatExpiry(value: string | null) {
  if (!value) return "未返回过期时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "过期时间格式异常";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusCopy(status: FigmaConnectionStatus) {
  if (status.status === "loading") {
    return {
      icon: <Loader2 className="h-4 w-4 animate-spin" />,
      label: "正在检查",
      title: "正在检查 Figma 连接",
      detail: "读取当前 owner 的 Figma 授权状态。",
    };
  }
  if (status.status === "connected") {
    return {
      icon: <CheckCircle2 className="h-4 w-4" />,
      label: "已连接",
      title: "Figma 已连接",
      detail: `Figma user: ${status.figmaUserId}`,
    };
  }
  if (status.status === "error") {
    return {
      icon: <XCircle className="h-4 w-4" />,
      label: "检查失败",
      title: "检查 Figma 连接失败",
      detail: status.message,
    };
  }
  return {
    icon: <Link2 className="h-4 w-4" />,
    label: "未连接",
    title: "需要连接 Figma",
    detail: "连接后 agent 才能读取你提供的 Figma frame 链接。",
  };
}

function toCardStatus(status: ServerFigmaStatus): FigmaConnectionStatus {
  return status.status === "connected" ? status : { status: "disconnected" };
}

function currentReturnTo() {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}${window.location.hash}` || "/";
}

export default function FigmaIntegrationCard({
  returnTo,
  onResume,
  showDisconnect = true,
  onLog,
}: Props) {
  const [status, setStatus] = useState<FigmaConnectionStatus>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const copy = statusCopy(status);
  const connected = status.status === "connected";
  const [popupBusy, setPopupBusy] = useState(false);
  const [popupError, setPopupError] = useState("");
  const popupRef = useRef<Window | null>(null);
  const effectiveBusy = busy || popupBusy;

  const log = useCallback((message: string) => {
    onLog?.(message);
  }, [onLog]);

  const refreshStatus = useCallback(async () => {
    setStatus({ status: "loading" });
    try {
      const next = await req<ServerFigmaStatus>("GET", "/api/integrations/figma/status");
      setStatus(toCardStatus(next));
      log(`status -> ${next.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ status: "error", message });
      log(`status error -> ${message}`);
    }
  }, [log]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const connectUrl = useCallback(() => {
    const params = new URLSearchParams({
      ownerId: getOwnerId(),
      returnTo: returnTo ?? currentReturnTo(),
    });
    return `/api/integrations/figma/oauth/start?${params.toString()}`;
  }, [returnTo]);

  const openConnectPopup = useCallback(() => {
    setPopupError("");
    log("popup -> Figma OAuth start");
    const popup = window.open(connectUrl(), "web-cursor-figma-oauth", "popup=yes,width=720,height=760");
    popupRef.current = popup;
    if (!popup) {
      setPopupBusy(false);
      setPopupError("浏览器拦截了 Figma 授权弹窗，请允许弹窗后重试。");
      log("popup blocked");
      return;
    }
    setPopupBusy(true);
    popup.focus();
  }, [connectUrl, log]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await req("POST", "/api/integrations/figma/status", { action: "disconnect" });
      log("disconnect -> ok");
      await refreshStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ status: "error", message });
      log(`disconnect error -> ${message}`);
    } finally {
      setBusy(false);
    }
  }, [log, refreshStatus]);

  useEffect(() => {
    if (!popupBusy) return;
    const timer = window.setInterval(() => {
      const popup = popupRef.current;
      if (popup?.closed) {
        popupRef.current = null;
        setPopupBusy(false);
        log("popup closed -> refresh status");
        refreshStatus();
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [log, popupBusy, refreshStatus]);

  useEffect(() => {
    const onFocus = () => {
      if (popupRef.current) {
        log("window focus -> refresh status");
        refreshStatus();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [log, refreshStatus]);

  return (
    <section className="w-full max-w-[620px] overflow-hidden rounded-xl border border-[#3b342c] bg-[#11100e] text-[#f7f3ea]">
      <div className="flex items-start gap-3 border-b border-[#2b261f] bg-[#15130f] px-4 py-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-[#3b342c] bg-[#0a0908] text-[#f24e1e]">
          <Boxes className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2 leading-none">
            <h2 className="m-0 text-[15px] font-semibold leading-5">{copy.title}</h2>
            <span className="inline-flex h-5 items-center gap-1.5 rounded-full border border-[#3b362f] bg-[#1b1814] px-2 text-[10.5px] text-[#c7bfb2]">
              {copy.icon}
              {copy.label}
            </span>
          </div>
          <p className="m-0 max-w-[48ch] break-words text-[12.5px] leading-5 text-[#aaa195]">{copy.detail}</p>
        </div>
      </div>

      {connected && (
        <div className="grid gap-3 border-b border-[#2b261f] px-4 py-3 sm:grid-cols-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#81786c]">Scopes</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {status.scopes.map((scope) => (
                <span key={scope} className="rounded border border-[#34312b] bg-[#151412] px-2 py-1 font-mono text-[11px] text-[#e9dfd0]">
                  {scope}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#81786c]">Access Token</div>
            <div className="mt-2 rounded border border-[#34312b] bg-[#151412] px-3 py-2 text-[12px] text-[#e9dfd0]">
              过期时间：{formatExpiry(status.expiresAt)}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {(status.status === "disconnected" || popupError) && (
          <button className={primaryButton} type="button" disabled={effectiveBusy} onClick={openConnectPopup}>
            {effectiveBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            连接 Figma
          </button>
        )}
        {connected && (
          <>
            {onResume && (
              <button className={primaryButton} type="button" disabled={effectiveBusy} onClick={onResume}>
                <Wand2 className="h-4 w-4" />
                继续生成
              </button>
            )}
            {showDisconnect && (
              <button className={dangerButton} type="button" disabled={effectiveBusy} onClick={disconnect}>
                {effectiveBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
                断开连接
              </button>
            )}
          </>
        )}
        {(status.status === "error" || status.status === "connected") && (
          <button className={quietButton} type="button" disabled={effectiveBusy} onClick={refreshStatus}>
            <RefreshCw className="h-4 w-4" />
            刷新状态
          </button>
        )}
      </div>
      {popupError && (
        <div className="border-t border-[#2b261f] px-4 pb-3 text-[12px] leading-5 text-[#ffb8aa]">
          {popupError}
        </div>
      )}
    </section>
  );
}
