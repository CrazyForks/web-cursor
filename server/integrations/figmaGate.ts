/**
 * [INPUT]: ownerId + conversationId + raw user message
 * [OUTPUT]: integration_card assistant payload when Figma OAuth is required
 * [POS]: A 域 Figma 授权 gate —— 用户提 Figma 链接但未连接时短路 LLM
 * [PROTOCOL]: 这里只检测并返回 payload；AgentRun owner 负责把 assistant message 与等待状态原子落库
 */
import "server-only";
import type { AppLocale } from "@/i18n/locales";
import { getFigmaConnectionStatus } from "@/server/figma/oauth";
import {
  IntegrationAction,
  IntegrationCardKind,
  IntegrationProvider,
  IntegrationReason,
  type IntegrationCardMeta,
} from "@/types/integration";

const FIGMA_DESIGN_URL_RE = /https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/[A-Za-z0-9_-]+/i;

export function containsFigmaDesignUrl(message: string): boolean {
  FIGMA_DESIGN_URL_RE.lastIndex = 0;
  return FIGMA_DESIGN_URL_RE.test(message);
}

export async function maybeAppendFigmaConnectionGate({
  ownerId,
  conversationId,
  message,
  locale,
}: {
  ownerId: string;
  conversationId: string;
  message: string;
  locale: AppLocale;
}): Promise<{ content: string; meta: IntegrationCardMeta } | null> {
  if (!containsFigmaDesignUrl(message)) return null;

  const status = await getFigmaConnectionStatus(ownerId);
  if (status.status === "connected") return null;

  const content = locale === "en"
    ? "Connect Figma before I can read this design link."
    : "需要连接 Figma 才能读取这个设计链接。";
  const meta: IntegrationCardMeta = {
    kind: IntegrationCardKind.IntegrationCard,
    provider: IntegrationProvider.Figma,
    action: IntegrationAction.Connect,
    reason: IntegrationReason.FigmaNotConnected,
    resume: { type: "conversation" },
  };

  return { content, meta };
}
