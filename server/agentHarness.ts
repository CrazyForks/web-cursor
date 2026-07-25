/**
 * [INPUT]: AppLocale、ProjectStorageKind，以及 versioned registry、server/llm、tools、models 的权威配置
 * [OUTPUT]: 同源生成的 identity、system prompt、tools 与完整模型请求配置
 * [POS]: A 域 Agent 静态前缀装配器 —— 把真实请求配置冻结成可审计的版本化身份
 * [PROTOCOL]: exact profile/version 与 expected digest 任一不匹配立即失败；API key 永不进入 identity
 */
import "server-only";
import type { AppLocale } from "@/i18n/locales";
import { resolveAgentHarnessIdentity } from "@/lib/agent/harnessIdentity";
import {
  repositoryCapabilityPromptForStorageKind,
  systemPromptForLocale,
} from "@/server/llm";
import { AGENT_MODEL_REQUEST_CONFIG } from "@/server/models";
import { toolsForStorageKind } from "@/server/tools/definitions";
import type { ProjectStorageKind } from "@/types/projectStorage";

export function agentHarnessFor(locale: AppLocale, storageKind: ProjectStorageKind) {
  const systemPrompt = systemPromptForLocale(locale, storageKind);
  const repositoryCapability = repositoryCapabilityPromptForStorageKind(storageKind);
  const tools = toolsForStorageKind(storageKind);
  const request = AGENT_MODEL_REQUEST_CONFIG;
  const identity = resolveAgentHarnessIdentity({
    locale,
    storageKind,
    systemPrompt,
    repositoryCapability,
    tools,
    request,
  });

  return {
    identity,
    systemPrompt,
    tools,
    model: request.model,
    stream: request.stream,
    thinking: request.thinking,
    toolChoice: request.toolChoice,
  };
}
