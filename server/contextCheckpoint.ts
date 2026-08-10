/**
 * [INPUT]: 已通过归属校验的 conversation transcript、当前 AgentRun、DeepSeek token 基准与 AbortSignal
 * [OUTPUT]: 可直接发送给主模型的 System + Checkpoint Summary + raw tail
 * [POS]: A 域 ContextCheckpoint 服务 —— 选择安全旧前缀、生成摘要、CAS 保存并重新装配
 * [PROTOCOL]: 原始 transcript 永不修改；当前 Run 与未闭合 tool pair 永不压缩；失败不得伪装成功
 */
import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import type OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { FullContextAssembler } from "@/lib/agent/fullContextAssembler";
import {
  CONTEXT_COMPACTION_TRIGGER_TOKENS,
  CODE_COMPLETION_MODEL,
} from "@/server/models";
import { db } from "@/server/db";
import { conversations, messages } from "@/server/db/schema";
import llmClient from "@/server/llm";
import {
  estimateContextTokens,
  estimateProviderPayloadTokens,
  estimateTokensFromUtf8Bytes,
  type ContextTokenBaseline,
} from "@/server/contextTokenEstimate";

type DbMessage = typeof messages.$inferSelect;
type LLMMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type LLMTool = OpenAI.Chat.Completions.ChatCompletionTool;

export const ContextCompactionErrorCode = {
  ConversationNotFound: "CONTEXT_COMPACTION_CONVERSATION_NOT_FOUND",
  InvalidCheckpoint: "CONTEXT_COMPACTION_INVALID_CHECKPOINT",
  NoSafePrefix: "CONTEXT_COMPACTION_NO_SAFE_PREFIX",
  EmptySummary: "CONTEXT_COMPACTION_EMPTY_SUMMARY",
  InsufficientReduction: "CONTEXT_COMPACTION_INSUFFICIENT_REDUCTION",
  WriteConflict: "CONTEXT_COMPACTION_WRITE_CONFLICT",
  BudgetUnmet: "CONTEXT_COMPACTION_BUDGET_UNMET",
  ProviderUsageMissing: "DEEPSEEK_USAGE_MISSING",
  ProviderUsageInvalid: "DEEPSEEK_USAGE_INVALID",
} as const;

export type ContextCompactionErrorCode =
  typeof ContextCompactionErrorCode[keyof typeof ContextCompactionErrorCode];

export class ContextCompactionError extends Error {
  constructor(
    readonly code: ContextCompactionErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ContextCompactionError";
  }
}

export type StoredContextCheckpoint = Readonly<{
  summary: string;
  coveredThroughSeq: number;
}>;

export type PreparedAgentContext = Readonly<{
  messages: LLMMessage[];
  estimatedTokens: number;
  compacted: boolean;
}>;

const CONTEXT_COMPACTION_MAX_REDUCTION_RATIO = 0.8;
const CONTEXT_COMPACTION_SUMMARY_MAX_TOKENS = 8_192;

type DeepSeekCompactionParams = ChatCompletionCreateParamsNonStreaming & {
  thinking: { type: "disabled" };
};

function checkpointFromRow(row: {
  contextSummary: string | null;
  contextSummaryThroughSeq: number | null;
}): StoredContextCheckpoint | null {
  if (row.contextSummary === null && row.contextSummaryThroughSeq === null) {
    return null;
  }
  if (
    row.contextSummary === null
    || row.contextSummaryThroughSeq === null
    || row.contextSummary.length === 0
    || !Number.isSafeInteger(row.contextSummaryThroughSeq)
    || row.contextSummaryThroughSeq <= 0
  ) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.InvalidCheckpoint,
      "Stored checkpoint fields are incomplete or invalid.",
    );
  }
  return {
    summary: row.contextSummary,
    coveredThroughSeq: row.contextSummaryThroughSeq,
  };
}

export async function getContextCheckpoint(
  conversationId: string,
): Promise<StoredContextCheckpoint | null> {
  const [row] = await db
    .select({
      contextSummary: conversations.contextSummary,
      contextSummaryThroughSeq: conversations.contextSummaryThroughSeq,
    })
    .from(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      isNull(conversations.deletedAt),
    ))
    .limit(1);
  if (!row) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.ConversationNotFound,
      `Conversation ${conversationId} does not exist.`,
    );
  }
  return checkpointFromRow(row);
}

export async function replaceContextCheckpoint(input: {
  conversationId: string;
  expectedCoveredThroughSeq: number | null;
  next: StoredContextCheckpoint;
}): Promise<"updated" | "conflict"> {
  if (
    input.next.summary.length === 0
    || !Number.isSafeInteger(input.next.coveredThroughSeq)
    || input.next.coveredThroughSeq <= 0
    || (
      input.expectedCoveredThroughSeq !== null
      && input.next.coveredThroughSeq <= input.expectedCoveredThroughSeq
    )
  ) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.InvalidCheckpoint,
      "Next checkpoint must contain a non-empty summary and advance coverage.",
    );
  }

  const expected = input.expectedCoveredThroughSeq === null
    ? isNull(conversations.contextSummaryThroughSeq)
    : eq(
      conversations.contextSummaryThroughSeq,
      input.expectedCoveredThroughSeq,
    );
  const rows = await db
    .update(conversations)
    .set({
      contextSummary: input.next.summary,
      contextSummaryThroughSeq: input.next.coveredThroughSeq,
    })
    .where(and(
      eq(conversations.id, input.conversationId),
      isNull(conversations.deletedAt),
      expected,
    ))
    .returning({ id: conversations.id });
  return rows.length === 1 ? "updated" : "conflict";
}

function requireMessageSeq(row: DbMessage): number {
  if (!Number.isSafeInteger(row.seq) || row.seq <= 0) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.InvalidCheckpoint,
      `Transcript message ${row.id} has invalid seq.`,
    );
  }
  return row.seq;
}

export function selectCheckpointPrefix(input: {
  rows: readonly DbMessage[];
  currentRunId: string;
  coveredThroughSeq: number | null;
}): DbMessage[] {
  FullContextAssembler.assemble(input.rows);
  const currentRunRows = input.rows.filter(
    (row) => row.agentRunId === input.currentRunId,
  );
  if (currentRunRows.length === 0) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.NoSafePrefix,
      `Current run ${input.currentRunId} has no transcript messages.`,
    );
  }
  const currentRunStartSeq = Math.min(...currentRunRows.map(requireMessageSeq));
  const prefix = input.rows.filter((row) => {
    const seq = requireMessageSeq(row);
    return seq > (input.coveredThroughSeq ?? 0) && seq < currentRunStartSeq;
  });
  if (prefix.length > 0) {
    FullContextAssembler.assemble(prefix);
  }
  return prefix;
}

function checkpointMessage(checkpoint: StoredContextCheckpoint): LLMMessage {
  return {
    role: "assistant",
    content: [
      "<context_checkpoint>",
      checkpoint.summary,
      "</context_checkpoint>",
    ].join("\n"),
  };
}

export function assembleCheckpointedMessages(input: {
  rows: readonly DbMessage[];
  checkpoint: StoredContextCheckpoint | null;
}): LLMMessage[] {
  FullContextAssembler.assemble(input.rows);
  if (!input.checkpoint) {
    return FullContextAssembler.assemble(input.rows);
  }
  const boundaryExists = input.rows.some(
    (row) => requireMessageSeq(row) === input.checkpoint!.coveredThroughSeq,
  );
  if (!boundaryExists) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.InvalidCheckpoint,
      `Checkpoint boundary seq=${input.checkpoint.coveredThroughSeq} does not exist.`,
    );
  }
  const tail = input.rows.filter(
    (row) => requireMessageSeq(row) > input.checkpoint!.coveredThroughSeq,
  );
  return [
    checkpointMessage(input.checkpoint),
    ...FullContextAssembler.assemble(tail),
  ];
}

async function summarizeCheckpoint(input: {
  previousSummary: string | null;
  sourceMessages: readonly LLMMessage[];
  signal: AbortSignal;
}): Promise<string> {
  const params: DeepSeekCompactionParams = {
    model: CODE_COMPLETION_MODEL,
    stream: false,
    thinking: { type: "disabled" },
    temperature: 0.1,
    max_tokens: CONTEXT_COMPACTION_SUMMARY_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content: [
          "你是编码 Agent 的上下文压缩器。",
          "把旧对话压缩成一份可继续执行任务的技术摘要。",
          "只保留输入中明确存在的事实：用户目标与约束、已完成修改、关键文件和符号、工具结果、错误、验证结果、未完成事项。",
          "不得编造文件、字段、运行结果或当前代码状态；不得输出工具调用；直接输出摘要正文。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          previousSummary: input.previousSummary,
          newClosedHistory: input.sourceMessages,
        }),
      },
    ],
  };
  const response = await llmClient.chat.completions.create(params, {
    signal: input.signal,
  });
  const content = response.choices[0]?.message.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.EmptySummary,
      "DeepSeek returned an empty checkpoint summary.",
    );
  }
  return content.trim();
}

function requestMessages(
  systemPrompt: string,
  dynamicMessages: readonly LLMMessage[],
): LLMMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...dynamicMessages,
  ];
}

function currentEstimate(input: {
  rows: readonly DbMessage[];
  dynamicMessages: readonly LLMMessage[];
  systemPrompt: string;
  tools: readonly LLMTool[];
  baseline: ContextTokenBaseline | null;
}): { messages: LLMMessage[]; estimatedTokens: number } {
  const nextMessages = requestMessages(input.systemPrompt, input.dynamicMessages);
  return {
    messages: nextMessages,
    estimatedTokens: estimateContextTokens({
      messages: nextMessages,
      tools: input.tools,
      transcriptRows: input.rows,
      baseline: input.baseline,
    }),
  };
}

export async function prepareAgentContext(input: {
  conversationId: string;
  currentRunId: string;
  rows: readonly DbMessage[];
  systemPrompt: string;
  tools: readonly LLMTool[];
  baseline: ContextTokenBaseline | null;
  signal: AbortSignal;
  onCompactionStarted: () => void;
}): Promise<PreparedAgentContext> {
  input.signal.throwIfAborted();
  const checkpoint = await getContextCheckpoint(input.conversationId);
  const initial = currentEstimate({
    rows: input.rows,
    dynamicMessages: assembleCheckpointedMessages({
      rows: input.rows,
      checkpoint,
    }),
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    baseline: input.baseline,
  });
  if (initial.estimatedTokens < CONTEXT_COMPACTION_TRIGGER_TOKENS) {
    return { ...initial, compacted: false };
  }
  console.info("Context compaction triggered", {
    conversationId: input.conversationId,
    currentRunId: input.currentRunId,
    estimatedTokens: initial.estimatedTokens,
    triggerTokens: CONTEXT_COMPACTION_TRIGGER_TOKENS,
  });
  input.onCompactionStarted();

  const prefix = selectCheckpointPrefix({
    rows: input.rows,
    currentRunId: input.currentRunId,
    coveredThroughSeq: checkpoint?.coveredThroughSeq ?? null,
  });
  if (prefix.length === 0) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.NoSafePrefix,
      "Context is over budget but no completed prior-run history is available.",
    );
  }
  const sourceMessages = FullContextAssembler.assemble(prefix);
  const summary = await summarizeCheckpoint({
    previousSummary: checkpoint?.summary ?? null,
    sourceMessages,
    signal: input.signal,
  });
  input.signal.throwIfAborted();

  const sourceTokens = estimateProviderPayloadTokens({
    messages: checkpoint
      ? [checkpointMessage(checkpoint), ...sourceMessages]
      : sourceMessages,
    tools: [],
  });
  const summaryTokens = estimateTokensFromUtf8Bytes(summary);
  if (summaryTokens > sourceTokens * CONTEXT_COMPACTION_MAX_REDUCTION_RATIO) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.InsufficientReduction,
      `Summary estimate ${summaryTokens} did not sufficiently reduce ${sourceTokens} tokens.`,
    );
  }

  const nextCheckpoint: StoredContextCheckpoint = {
    summary,
    coveredThroughSeq: requireMessageSeq(prefix[prefix.length - 1]),
  };
  const outcome = await replaceContextCheckpoint({
    conversationId: input.conversationId,
    expectedCoveredThroughSeq: checkpoint?.coveredThroughSeq ?? null,
    next: nextCheckpoint,
  });
  if (outcome === "conflict") {
    const concurrent = await getContextCheckpoint(input.conversationId);
    const concurrentEstimate = currentEstimate({
      rows: input.rows,
      dynamicMessages: assembleCheckpointedMessages({
        rows: input.rows,
        checkpoint: concurrent,
      }),
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      baseline: null,
    });
    if (concurrentEstimate.estimatedTokens < CONTEXT_COMPACTION_TRIGGER_TOKENS) {
      return { ...concurrentEstimate, compacted: true };
    }
    throw new ContextCompactionError(
      ContextCompactionErrorCode.WriteConflict,
      "A concurrent checkpoint update did not bring context under budget.",
    );
  }

  const compacted = currentEstimate({
    rows: input.rows,
    dynamicMessages: assembleCheckpointedMessages({
      rows: input.rows,
      checkpoint: nextCheckpoint,
    }),
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    baseline: null,
  });
  if (compacted.estimatedTokens >= CONTEXT_COMPACTION_TRIGGER_TOKENS) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.BudgetUnmet,
      `Compacted context still estimates ${compacted.estimatedTokens} tokens.`,
    );
  }
  console.info("Context compaction completed", {
    conversationId: input.conversationId,
    coveredThroughSeq: nextCheckpoint.coveredThroughSeq,
    sourceTokens,
    summaryTokens,
    estimatedTokensAfter: compacted.estimatedTokens,
  });
  return { ...compacted, compacted: true };
}
