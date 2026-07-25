/**
 * [INPUT]: 从 DB 读出的、按 seq 排序的 messages 行
 * [OUTPUT]: DeepSeek 能直接消费的完整合法 transcript 投影
 * [POS]: A 域 ContextAssembler 门面 —— server-only 边界内调用 P0 纯协议核心
 * [PROTOCOL]: 不修复 transcript；tool call/result 必须严格配对，非法历史 fail closed
 */
import "server-only";
import type { messages } from "./db/schema";
import {
  FullContextAssembler,
  TranscriptProtocolError,
  TranscriptProtocolErrorCode,
} from "@/lib/agent/fullContextAssembler";

type DbMessage = typeof messages.$inferSelect;

export { FullContextAssembler, TranscriptProtocolError, TranscriptProtocolErrorCode };

/** DB transcript → provider messages，保留完整合法历史。 */
export function toLLMMessages(rows: readonly DbMessage[]) {
  return FullContextAssembler.assemble(rows);
}
