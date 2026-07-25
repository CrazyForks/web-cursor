/**
 * [INPUT]: 按 seq 排序的 conversation transcript rows
 * [OUTPUT]: 唯一尾部 pending tool round 中下一个必须闭合的 tool call
 * [POS]: A 域 tool result 配对的纯逻辑核心 —— endpoint 与 interrupted cleanup 共享
 * [PROTOCOL]: 完整 transcript 必须通过严格解析；非法历史抛稳定协议错误，不做兼容猜测。
 */
import {
  parseStoredTranscript,
  type StoredTranscriptRow,
} from "./agent/fullContextAssembler";
import type { ToolCallMeta } from "../types/tool";

export function findNextPendingToolCall(
  rows: readonly StoredTranscriptRow[],
): ToolCallMeta | null {
  const transcript = parseStoredTranscript(rows);
  return transcript.state === "pending"
    ? transcript.pending.nextCall
    : null;
}
