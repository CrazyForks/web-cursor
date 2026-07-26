/**
 * [INPUT]: conversationId，以及待闭合的精确 server tool call/result 批次
 * [OUTPUT]: 模型输入 readiness，以及只在精确 pending 时落库的 server tool results
 * [POS]: A 域 transcript 写入围栏 —— 串行闭合中断调用并拒绝旧执行器的迟到结果
 * [PROTOCOL]: 所有闭合写入共用 conversation advisory lock；异步图片运行中绝不伪造结果
 */
import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { imageRuns, messages } from "@/server/db/schema";
import { appendMessage } from "./messages";
import { ToolName, ToolResultType, type ToolCallMeta } from "@/types/tool";
import { findNextPendingToolCall } from "@/lib/pendingToolCall";
import { ImageRunStatus } from "@/types/image";
import type { StoredTranscriptRow } from "@/lib/agent/fullContextAssembler";

type ToolCallTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const TailToolCallReadiness = {
  Ready: "ready",
  WaitingAsync: "waiting_async",
} as const;

export type TailToolCallReadiness =
  typeof TailToolCallReadiness[keyof typeof TailToolCallReadiness];

export const PendingToolResultAppendStatus = {
  Appended: "appended",
  Stale: "stale",
} as const;

export type PendingToolResultAppendStatus =
  typeof PendingToolResultAppendStatus[keyof typeof PendingToolResultAppendStatus];

export type PendingToolResultWrite = Readonly<{
  toolCall: Pick<ToolCallMeta, "id" | "name">;
  content: string;
}>;

export type PendingToolResultAppendOutcome =
  | Readonly<{
      status: typeof PendingToolResultAppendStatus.Appended;
      count: number;
    }>
  | Readonly<{
      status: typeof PendingToolResultAppendStatus.Stale;
      rejectedIndex: number;
      expected: Pick<ToolCallMeta, "id" | "name"> | null;
      received: Pick<ToolCallMeta, "id" | "name">;
    }>;

export const TailToolCallErrorCode = {
  TerminalImageResultMissing: "TERMINAL_IMAGE_RESULT_MISSING",
  UnknownImageRunStatus: "UNKNOWN_IMAGE_RUN_STATUS",
} as const;

export type TailToolCallErrorCode =
  typeof TailToolCallErrorCode[keyof typeof TailToolCallErrorCode];

export class TailToolCallError extends Error {
  constructor(
    readonly code: TailToolCallErrorCode,
    readonly toolCallId: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "TailToolCallError";
  }
}

export function findUnclosedToolCall(
  rows: readonly StoredTranscriptRow[],
): ToolCallMeta | null {
  return findNextPendingToolCall(rows);
}

function sameToolCall(
  left: Pick<ToolCallMeta, "id" | "name">,
  right: Pick<ToolCallMeta, "id" | "name">,
): boolean {
  return left.id === right.id && left.name === right.name;
}

/**
 * Server tools execute outside the DB transaction. Before their result is
 * persisted, re-check the exact pending call under the same conversation lock
 * used by interruption cleanup and browser/image result writers.
 *
 * The whole batch is simulated through the strict transcript parser before
 * any INSERT, so a stale/mismatched batch cannot partially close a round.
 */
export async function appendPendingToolResults(
  conversationId: string,
  writes: readonly PendingToolResultWrite[],
): Promise<PendingToolResultAppendOutcome> {
  if (writes.length === 0) {
    return {
      status: PendingToolResultAppendStatus.Appended,
      count: 0,
    };
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`);

    const rows: StoredTranscriptRow[] = await tx
      .select()
      .from(messages)
      .where(and(
        eq(messages.conversationId, conversationId),
        isNull(messages.deletedAt),
      ))
      .orderBy(asc(messages.seq));
    const simulatedRows = [...rows];

    for (const [index, write] of writes.entries()) {
      const pending = findNextPendingToolCall(simulatedRows);
      if (!pending || !sameToolCall(pending, write.toolCall)) {
        return {
          status: PendingToolResultAppendStatus.Stale,
          rejectedIndex: index,
          expected: pending ? { id: pending.id, name: pending.name } : null,
          received: {
            id: write.toolCall.id,
            name: write.toolCall.name,
          },
        };
      }

      simulatedRows.push({
        role: "tool",
        content: write.content,
        meta: { toolCallId: write.toolCall.id },
      });
      // Validate the newly closed pair now, including the final item.
      findNextPendingToolCall(simulatedRows);
    }

    for (const write of writes) {
      await appendMessage(conversationId, {
        role: "tool",
        content: write.content,
        meta: { toolCallId: write.toolCall.id },
      }, tx);
    }

    return {
      status: PendingToolResultAppendStatus.Appended,
      count: writes.length,
    };
  });
}

async function imageToolReadiness(
  conversationId: string,
  toolCallId: string,
  tx: ToolCallTransaction,
): Promise<TailToolCallReadiness | null> {
  const [run] = await tx
    .select({ status: imageRuns.status })
    .from(imageRuns)
    .where(and(
      eq(imageRuns.conversationId, conversationId),
      eq(imageRuns.toolCallId, toolCallId),
      isNull(imageRuns.deletedAt),
    ))
    .limit(1);
  if (!run) return null;

  switch (run.status) {
    case ImageRunStatus.Pending:
    case ImageRunStatus.Running:
      return TailToolCallReadiness.WaitingAsync;
    case ImageRunStatus.Succeeded:
    case ImageRunStatus.Failed:
    case ImageRunStatus.Cancelled:
      throw new TailToolCallError(
        TailToolCallErrorCode.TerminalImageResultMissing,
        toolCallId,
        `Image run is ${run.status}, but tool call ${toolCallId} has no transcript result.`,
      );
    default:
      throw new TailToolCallError(
        TailToolCallErrorCode.UnknownImageRunStatus,
        toolCallId,
        `Unsupported image run status for tool call ${toolCallId}: ${String(run.status)}`,
      );
  }
}

export async function prepareTranscriptForModelInput(
  conversationId: string,
): Promise<TailToolCallReadiness> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`);

    while (true) {
      const rows = await tx
        .select()
        .from(messages)
        .where(and(
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
        ))
        .orderBy(asc(messages.seq));
      const missing = findUnclosedToolCall(rows);
      if (!missing) return TailToolCallReadiness.Ready;

      if (missing.name === ToolName.GenerateImage) {
        const readiness = await imageToolReadiness(
          conversationId,
          missing.id,
          tx,
        );
        if (readiness) return readiness;
      }

      await appendMessage(conversationId, {
        role: "tool",
        content: JSON.stringify({
          status: "error",
          type: ToolResultType.ToolInterrupted,
          message: "Client did not return a tool result.",
        }),
        meta: { toolCallId: missing.id },
      }, tx);
    }
  });
}
