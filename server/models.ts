import "server-only";
import {
  AgentHarnessProvider,
  AgentHarnessThinkingType,
  AgentHarnessToolChoice,
  type AgentHarnessModelRequestConfig,
} from "@/types/agentHarness";

export const AGENT_MODEL = "deepseek-v4-pro";
export const TITLE_MODEL = "deepseek-v4-flash";
export const CODE_COMPLETION_MODEL = "deepseek-v4-flash";
export const VISION_MODEL = "gemini-3.1-flash-lite";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** DeepSeek V4 官方额定上下文长度；当前 Agent 只支持该模型，不做动态 Model Profile。 */
export const DEEPSEEK_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** 上下文达到额定窗口的 85% 时开始压缩，为下一轮输出和协议开销保留空间。 */
export const CONTEXT_COMPACTION_TRIGGER_TOKENS = 850_000;

/**
 * Chat Route 的非秘密生成配置权威来源。messages/tools 是每轮动态输入，不属于该 profile。
 * API key 只由 server/llm.ts 从环境变量读取，绝不能加入 identity。
 */
export const AGENT_MODEL_REQUEST_CONFIG = Object.freeze({
  provider: AgentHarnessProvider.DeepSeek,
  baseURL: DEEPSEEK_BASE_URL,
  model: AGENT_MODEL,
  stream: true,
  toolChoice: AgentHarnessToolChoice.Auto,
  thinking: Object.freeze({ type: AgentHarnessThinkingType.Disabled }),
  extraGenerationParameters: Object.freeze({}),
} as const satisfies AgentHarnessModelRequestConfig);
