/**
 * [INPUT]: 按 seq 排序的 conversation transcript rows
 * [OUTPUT]: 最新 assistant tool round 中下一个必须闭合的 tool call
 * [POS]: A 域 tool result 配对的纯逻辑核心 —— endpoint 与 interrupted cleanup 共享
 * [PROTOCOL]: 只接受紧随 assistant 且与声明顺序一致的 tool messages；乱序不做兼容猜测。
 */
import type { ToolCallMeta } from "../types/tool";

type TranscriptRow = {
  role: string;
  meta?: unknown;
};

function declaredToolCalls(meta: unknown): ToolCallMeta[] {
  if (!meta || typeof meta !== "object" || !("toolCalls" in meta)) return [];
  const toolCalls = (meta as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) {
    throw new Error("Invalid assistant toolCalls metadata: expected an array.");
  }
  return toolCalls.map((call) => {
    if (
      !call
      || typeof call !== "object"
      || typeof (call as { id?: unknown }).id !== "string"
      || !(call as { id: string }).id
      || typeof (call as { name?: unknown }).name !== "string"
      || !(call as { name: string }).name
      || (
        (call as { arguments?: unknown }).arguments !== undefined
        && typeof (call as { arguments?: unknown }).arguments !== "string"
      )
    ) {
      throw new Error("Invalid assistant toolCalls metadata: malformed tool call.");
    }
    return call as ToolCallMeta;
  });
}

function resultToolCallId(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || !("toolCallId" in meta)) return null;
  const id = (meta as { toolCallId?: unknown }).toolCallId;
  if (typeof id !== "string" || !id) {
    throw new Error("Invalid tool result metadata: toolCallId must be a non-empty string.");
  }
  return id;
}

export function findNextPendingToolCall(rows: TranscriptRow[]): ToolCallMeta | null {
  for (let assistantIndex = rows.length - 1; assistantIndex >= 0; assistantIndex--) {
    if (rows[assistantIndex].role !== "assistant") continue;
    const toolCalls = declaredToolCalls(rows[assistantIndex].meta);
    if (toolCalls.length === 0) return null;

    let resultIndex = assistantIndex + 1;
    for (const toolCall of toolCalls) {
      const row = rows[resultIndex];
      if (row?.role !== "tool" || resultToolCallId(row.meta) !== toolCall.id) {
        return toolCall;
      }
      resultIndex += 1;
    }
    return null;
  }
  return null;
}
