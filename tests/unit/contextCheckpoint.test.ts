import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../server/llm", () => ({ default: {} }));

import {
  assembleCheckpointedMessages,
  selectCheckpointPrefix,
} from "../../server/contextCheckpoint";
import {
  TranscriptProtocolError,
  TranscriptProtocolErrorCode,
} from "../../lib/agent/fullContextAssembler";
import type { messages } from "../../server/db/schema";

type DbMessage = typeof messages.$inferSelect;

const conversationId = "00000000-0000-4000-8000-000000000001";
const previousRunId = "00000000-0000-4000-8000-000000000002";
const currentRunId = "00000000-0000-4000-8000-000000000003";

function message(input: Pick<DbMessage, "seq" | "role" | "content" | "meta">
  & Partial<Pick<DbMessage, "agentRunId" | "model">>): DbMessage {
  return {
    id: `00000000-0000-4000-8000-${String(input.seq).padStart(12, "0")}`,
    conversationId,
    agentRunId: input.agentRunId ?? previousRunId,
    seq: input.seq,
    role: input.role,
    content: input.content,
    model: input.model ?? null,
    meta: input.meta,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    deletedAt: null,
  };
}

function closedConversation(): DbMessage[] {
  return [
    message({
      seq: 1,
      role: "user",
      content: "读取项目",
      meta: null,
    }),
    message({
      seq: 2,
      role: "assistant",
      content: "",
      model: "deepseek-v4-pro",
      meta: {
        toolCalls: [{
          id: "call-list",
          name: "list_files",
          arguments: "{}",
        }],
      },
    }),
    message({
      seq: 3,
      role: "tool",
      content: JSON.stringify({
        status: "ok",
        tool: "list_files",
        revision: 1,
        files: [],
      }),
      meta: { toolCallId: "call-list" },
    }),
    message({
      seq: 4,
      role: "assistant",
      content: "项目已读取",
      model: "deepseek-v4-pro",
      meta: { kind: "reply" },
    }),
    message({
      seq: 5,
      role: "user",
      content: "继续修改",
      meta: null,
      agentRunId: currentRunId,
    }),
  ];
}

describe("ContextCheckpoint protocol", () => {
  it("selects only complete prior-run history and keeps tool pairs together", () => {
    const prefix = selectCheckpointPrefix({
      rows: closedConversation(),
      currentRunId,
      coveredThroughSeq: null,
    });

    expect(prefix.map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
  });

  it("advances from an existing checkpoint without re-selecting covered rows", () => {
    const rows = [
      ...closedConversation().slice(0, 4),
      message({
        seq: 5,
        role: "user",
        content: "第二个旧请求",
        meta: null,
      }),
      message({
        seq: 6,
        role: "assistant",
        content: "第二个旧回复",
        model: "deepseek-v4-pro",
        meta: { kind: "reply" },
      }),
      message({
        seq: 7,
        role: "user",
        content: "当前请求",
        meta: null,
        agentRunId: currentRunId,
      }),
    ];

    const prefix = selectCheckpointPrefix({
      rows,
      currentRunId,
      coveredThroughSeq: 4,
    });
    expect(prefix.map(({ seq }) => seq)).toEqual([5, 6]);
  });

  it("assembles summary plus only the raw tail", () => {
    const messages = assembleCheckpointedMessages({
      rows: closedConversation(),
      checkpoint: {
        summary: "已经读取过项目。",
        coveredThroughSeq: 4,
      },
    });

    expect(messages).toEqual([
      {
        role: "assistant",
        content: "<context_checkpoint>\n已经读取过项目。\n</context_checkpoint>",
      },
      { role: "user", content: "继续修改" },
    ]);
  });

  it("rejects a run boundary that would split a tool call from its result", () => {
    const rows = closedConversation();
    rows[2] = {
      ...rows[2],
      agentRunId: currentRunId,
    };

    expect(() => selectCheckpointPrefix({
      rows,
      currentRunId,
      coveredThroughSeq: null,
    })).toThrowError(expect.objectContaining({
      constructor: TranscriptProtocolError,
      code: TranscriptProtocolErrorCode.PendingToolRound,
    }));
  });
});
