/**
 * [INPUT]: DB transcript rows for one conversation
 * [OUTPUT]: unclosed tool_call metadata, or a synthetic TOOL_INTERRUPTED tool message
 * [POS]: A 域 transcript 协议修复 —— 检测/闭合未返回结果的 tool_call
 * [PROTOCOL]: 只用于兜底中断，不代表真实执行结果；正常结果必须由 tool-results 写入。
 */
import "server-only";
import { appendMessage, listMessages } from "./messages";

type DbMessage = Awaited<ReturnType<typeof listMessages>>[number];
type ToolCallMeta = { id: string; name: string; arguments?: string };

export function findUnclosedToolCall(rows: DbMessage[]): ToolCallMeta | null {
  const closed = new Set<string>();
  for (const row of rows) {
    const meta = (row.meta ?? {}) as { toolCallId?: string };
    if (row.role === "tool" && meta.toolCallId) closed.add(meta.toolCallId);
  }

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const meta = (row.meta ?? {}) as { toolCalls?: ToolCallMeta[] };
    if (row.role === "assistant" && meta.toolCalls?.length) {
      return meta.toolCalls.find((t) => !closed.has(t.id)) ?? null;
    }
  }

  return null;
}

export async function closeInterruptedToolCall(conversationId: string, rows: DbMessage[]) {
  const missing = findUnclosedToolCall(rows);
  if (!missing) return false;

  await appendMessage(conversationId, {
    role: "tool",
    content: JSON.stringify({
      status: "error",
      type: "TOOL_INTERRUPTED",
      message: "Client did not return a tool result.",
    }),
    meta: { toolCallId: missing.id },
  });
  return true;
}
