/**
 * [INPUT]: 按 seq 排序的持久 transcript rows
 * [OUTPUT]: 严格领域消息、pending tool 状态，以及行为等价的完整 provider context
 * [POS]: P0 上下文协议核心 —— 原始 transcript 到模型输入的纯函数边界
 * [PROTOCOL]: 不补字段、不伪造 tool result、不丢弃孤儿消息；非法历史必须带稳定错误码失败
 */
import type OpenAI from "openai";
import type { AttachmentSummary } from "@/types/attachment";
import { IntegrationCardMetaSchema } from "@/types/integration";
import type { ToolCallMeta } from "@/types/tool";
import { validatePersistedToolResult } from "@/types/toolResult";
import {
  AssistantReplyMetaSchema,
  AssistantToolRoundMetaSchema,
  LegacyAssistantCodeMetaSchema,
  LegacyAssistantToolRoundMetaSchema,
  StoredMessageRole,
  ToolResultMetaSchema,
  TranscriptMessageKind,
  UserAttachmentsMetaSchema,
  UserPreviewFeedbackMetaSchema,
} from "@/types/transcript";

export const TranscriptProtocolErrorCode = {
  InvalidRow: "TRANSCRIPT_INVALID_ROW",
  UnsupportedRole: "TRANSCRIPT_UNSUPPORTED_ROLE",
  InvalidMeta: "TRANSCRIPT_INVALID_META",
  DuplicateToolCallId: "TRANSCRIPT_DUPLICATE_TOOL_CALL_ID",
  MissingToolResult: "TRANSCRIPT_MISSING_TOOL_RESULT",
  MismatchedToolResult: "TRANSCRIPT_MISMATCHED_TOOL_RESULT",
  InvalidToolResult: "TRANSCRIPT_INVALID_TOOL_RESULT",
  OrphanToolResult: "TRANSCRIPT_ORPHAN_TOOL_RESULT",
  PendingToolRound: "TRANSCRIPT_PENDING_TOOL_ROUND",
} as const;

export type TranscriptProtocolErrorCode =
  typeof TranscriptProtocolErrorCode[keyof typeof TranscriptProtocolErrorCode];

export type StoredTranscriptRow = {
  id?: unknown;
  seq?: unknown;
  role: unknown;
  content: unknown;
  meta?: unknown;
};

type HumanRequestMessage = {
  kind: typeof TranscriptMessageKind.HumanRequest;
  content: string;
  attachments: readonly AttachmentSummary[];
};

type RuntimeFeedbackMessage = {
  kind: typeof TranscriptMessageKind.RuntimeFeedback;
  content: string;
};

type AssistantReplyMessage = {
  kind:
    | typeof TranscriptMessageKind.AssistantReply
    | typeof TranscriptMessageKind.AssistantIntegration;
  content: string;
};

type AssistantToolRoundMessage = {
  kind: typeof TranscriptMessageKind.AssistantToolRound;
  toolCalls: readonly ToolCallMeta[];
};

type ToolResultMessage = {
  kind: typeof TranscriptMessageKind.ToolResult;
  toolCallId: string;
  content: string;
  parsedContent: unknown;
};

export type TranscriptMessage =
  | HumanRequestMessage
  | RuntimeFeedbackMessage
  | AssistantReplyMessage
  | AssistantToolRoundMessage
  | ToolResultMessage;

export type ParsedTranscript =
  | {
      state: "closed";
      messages: readonly TranscriptMessage[];
    }
  | {
      state: "pending";
      messages: readonly TranscriptMessage[];
      pending: {
        assistantMessageIndex: number;
        nextCall: ToolCallMeta;
      };
    };

type LLMMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function rowReference(row: StoredTranscriptRow, index: number): string {
  if (typeof row.seq === "number" && Number.isSafeInteger(row.seq)) {
    return `seq=${row.seq}`;
  }
  if (typeof row.id === "string" && row.id) {
    return `id=${row.id}`;
  }
  return `index=${index}`;
}

export class TranscriptProtocolError extends Error {
  constructor(
    readonly code: TranscriptProtocolErrorCode,
    readonly rowIndex: number,
    readonly rowReference: string,
    detail: string,
  ) {
    super(`${code} at ${rowReference}: ${detail}`);
    this.name = "TranscriptProtocolError";
  }
}

function protocolError(
  code: TranscriptProtocolErrorCode,
  row: StoredTranscriptRow,
  index: number,
  detail: string,
): never {
  const reference = rowReference(row, index);
  throw new TranscriptProtocolError(
    code,
    index,
    reference,
    detail,
  );
}

function invalidMeta(
  row: StoredTranscriptRow,
  index: number,
  expected: string,
): never {
  return protocolError(
    TranscriptProtocolErrorCode.InvalidMeta,
    row,
    index,
    `expected ${expected}`,
  );
}

function hasNoMeta(meta: unknown): meta is null | undefined {
  return meta === null || meta === undefined;
}

function requireContent(
  row: StoredTranscriptRow,
  index: number,
  content: string,
  messageType: string,
): void {
  if (content.length === 0) {
    protocolError(
      TranscriptProtocolErrorCode.InvalidRow,
      row,
      index,
      `${messageType} content must not be empty`,
    );
  }
}

function parseUserMessage(
  row: StoredTranscriptRow,
  index: number,
  content: string,
): HumanRequestMessage | RuntimeFeedbackMessage {
  requireContent(row, index, content, "user");

  if (hasNoMeta(row.meta)) {
    return {
      kind: TranscriptMessageKind.HumanRequest,
      content,
      attachments: [],
    };
  }

  const attachments = UserAttachmentsMetaSchema.safeParse(row.meta);
  if (attachments.success) {
    return {
      kind: TranscriptMessageKind.HumanRequest,
      content,
      attachments: attachments.data.attachments,
    };
  }

  if (UserPreviewFeedbackMetaSchema.safeParse(row.meta).success) {
    return {
      kind: TranscriptMessageKind.RuntimeFeedback,
      content,
    };
  }

  return invalidMeta(row, index, "empty, attachments, or previewResult user metadata");
}

function parseAssistantMessage(
  row: StoredTranscriptRow,
  index: number,
  content: string,
): AssistantReplyMessage | AssistantToolRoundMessage {
  if (AssistantReplyMetaSchema.safeParse(row.meta).success) {
    requireContent(row, index, content, "assistant reply");
    return {
      kind: TranscriptMessageKind.AssistantReply,
      content,
    };
  }

  if (IntegrationCardMetaSchema.safeParse(row.meta).success) {
    requireContent(row, index, content, "assistant integration");
    return {
      kind: TranscriptMessageKind.AssistantIntegration,
      content,
    };
  }

  const toolRound = AssistantToolRoundMetaSchema.safeParse(row.meta);
  if (toolRound.success) {
    return {
      kind: TranscriptMessageKind.AssistantToolRound,
      toolCalls: toolRound.data.toolCalls,
    };
  }

  const legacyToolRound = LegacyAssistantToolRoundMetaSchema.safeParse(row.meta);
  if (legacyToolRound.success) {
    return {
      kind: TranscriptMessageKind.AssistantToolRound,
      toolCalls: legacyToolRound.data.toolCalls,
    };
  }

  if (LegacyAssistantCodeMetaSchema.safeParse(row.meta).success) {
    requireContent(row, index, content, "legacy assistant code");
    return {
      kind: TranscriptMessageKind.AssistantReply,
      content,
    };
  }

  return invalidMeta(
    row,
    index,
    "reply, integration card, or strict toolCalls assistant metadata",
  );
}

function parseToolResultMessage(
  row: StoredTranscriptRow,
  index: number,
  content: string,
): ToolResultMessage {
  const meta = ToolResultMetaSchema.safeParse(row.meta);
  if (!meta.success) {
    return invalidMeta(row, index, "strict toolCallId tool metadata");
  }
  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(content);
  } catch {
    return protocolError(
      TranscriptProtocolErrorCode.InvalidToolResult,
      row,
      index,
      "tool result content must be valid JSON",
    );
  }
  return {
    kind: TranscriptMessageKind.ToolResult,
    toolCallId: meta.data.toolCallId,
    content,
    parsedContent,
  };
}

function toolResultIssueSummary(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  return issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  }).join("; ");
}

function parseRow(row: StoredTranscriptRow, index: number): TranscriptMessage {
  if (typeof row.content !== "string") {
    return protocolError(
      TranscriptProtocolErrorCode.InvalidRow,
      row,
      index,
      "content must be a string",
    );
  }

  switch (row.role) {
    case StoredMessageRole.User:
      return parseUserMessage(row, index, row.content);
    case StoredMessageRole.Assistant:
      return parseAssistantMessage(row, index, row.content);
    case StoredMessageRole.Tool:
      return parseToolResultMessage(row, index, row.content);
    default:
      return protocolError(
        TranscriptProtocolErrorCode.UnsupportedRole,
        row,
        index,
        `unsupported stored role ${JSON.stringify(row.role)}`,
      );
  }
}

export function parseStoredTranscript(
  rows: readonly StoredTranscriptRow[],
): ParsedTranscript {
  const messages = rows.map(parseRow);

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.kind === TranscriptMessageKind.ToolResult) {
      return protocolError(
        TranscriptProtocolErrorCode.OrphanToolResult,
        rows[index],
        index,
        `tool result ${message.toolCallId} is not owned by the preceding assistant round`,
      );
    }
    if (message.kind !== TranscriptMessageKind.AssistantToolRound) continue;

    const roundToolCallIds = new Set<string>();
    for (const toolCall of message.toolCalls) {
      if (roundToolCallIds.has(toolCall.id)) {
        return protocolError(
          TranscriptProtocolErrorCode.DuplicateToolCallId,
          rows[index],
          index,
          `duplicate tool call id ${toolCall.id} within one assistant round`,
        );
      }
      roundToolCallIds.add(toolCall.id);
    }

    for (let callIndex = 0; callIndex < message.toolCalls.length; callIndex++) {
      const toolCall = message.toolCalls[callIndex];
      const resultIndex = index + callIndex + 1;
      const result = messages[resultIndex];

      if (!result) {
        return {
          state: "pending",
          messages,
          pending: {
            assistantMessageIndex: index,
            nextCall: toolCall,
          },
        };
      }
      if (result.kind !== TranscriptMessageKind.ToolResult) {
        return protocolError(
          TranscriptProtocolErrorCode.MissingToolResult,
          rows[resultIndex],
          resultIndex,
          `expected tool result for ${toolCall.id} before the next transcript message`,
        );
      }
      if (result.toolCallId !== toolCall.id) {
        return protocolError(
          TranscriptProtocolErrorCode.MismatchedToolResult,
          rows[resultIndex],
          resultIndex,
          `expected toolCallId=${toolCall.id}, received toolCallId=${result.toolCallId}`,
        );
      }

      const validatedResult = validatePersistedToolResult(
        toolCall.name,
        result.parsedContent,
      );
      if (!validatedResult.success) {
        return protocolError(
          TranscriptProtocolErrorCode.InvalidToolResult,
          rows[resultIndex],
          resultIndex,
          `result for tool ${toolCall.name} does not match its contract: ${
            toolResultIssueSummary(validatedResult.error.issues)
          }`,
        );
      }
    }

    index += message.toolCalls.length;
  }

  return { state: "closed", messages };
}

function userContent(
  content: string,
  attachments: readonly AttachmentSummary[],
): string {
  if (attachments.length === 0) return content;

  const lines = attachments.map((attachment) =>
    `- attachmentId=${attachment.id}; type=${attachment.type}; mimeType=${attachment.mimeType}; sizeBytes=${attachment.sizeBytes}`
  );
  return [
    content,
    "",
    "用户本轮附带了以下附件。需要读取附件内容时，必须调用 inspect_attachment，并只能使用这里列出的 attachmentId：",
    ...lines,
  ].join("\n");
}

function projectClosedTranscript(messages: readonly TranscriptMessage[]): LLMMessage[] {
  return messages.map((message): LLMMessage => {
    switch (message.kind) {
      case TranscriptMessageKind.HumanRequest:
        return {
          role: "user",
          content: userContent(message.content, message.attachments),
        };
      case TranscriptMessageKind.RuntimeFeedback:
        return { role: "user", content: message.content };
      case TranscriptMessageKind.AssistantReply:
      case TranscriptMessageKind.AssistantIntegration:
        return { role: "assistant", content: message.content };
      case TranscriptMessageKind.AssistantToolRound:
        return {
          role: "assistant",
          content: "",
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function" as const,
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          })),
        };
      case TranscriptMessageKind.ToolResult:
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
    }
  });
}

export const FullContextAssembler = {
  assemble(rows: readonly StoredTranscriptRow[]): LLMMessage[] {
    const transcript = parseStoredTranscript(rows);
    if (transcript.state === "pending") {
      const row = rows[transcript.pending.assistantMessageIndex];
      return protocolError(
        TranscriptProtocolErrorCode.PendingToolRound,
        row,
        transcript.pending.assistantMessageIndex,
        `tool call ${transcript.pending.nextCall.id} has no persisted result`,
      );
    }
    return projectClosedTranscript(transcript.messages);
  },
} as const;
