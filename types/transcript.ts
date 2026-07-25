import { z } from "zod";
import { AttachmentSummarySchema } from "./attachment";
import { IntegrationCardMetaSchema } from "./integration";
import { ToolCallIdSchema, ToolCallMetaSchema } from "./tool";
import { ToolResultSchema } from "./toolSchema";

export const StoredMessageRole = {
  User: "user",
  Assistant: "assistant",
  Tool: "tool",
} as const;

export type StoredMessageRole =
  typeof StoredMessageRole[keyof typeof StoredMessageRole];

export const TranscriptMessageKind = {
  HumanRequest: "human_request",
  RuntimeFeedback: "runtime_feedback",
  AssistantReply: "assistant_reply",
  AssistantIntegration: "assistant_integration",
  AssistantToolRound: "assistant_tool_round",
  ToolResult: "tool_result",
} as const;

export const LegacyAssistantMessageKind = {
  Code: "code",
  Reply: "reply",
} as const;

export const LegacyPreviewResultType = {
  RenderOk: "RENDER_OK",
  CompileError: "COMPILE_ERROR",
  RuntimeError: "RUNTIME_ERROR",
  ToolInterrupted: "TOOL_INTERRUPTED",
} as const;

export const UserAttachmentsMetaSchema = z.object({
  attachments: z.array(AttachmentSummarySchema).min(1).max(4),
}).strict();

export const LegacyPreviewResultSchema = z.discriminatedUnion("type", [
  z.object({
    status: z.literal("ok"),
    type: z.literal(LegacyPreviewResultType.RenderOk),
    durationMs: z.number().optional(),
  }).strict(),
  z.object({
    status: z.literal("error"),
    type: z.literal(LegacyPreviewResultType.CompileError),
    message: z.string(),
  }).strict(),
  z.object({
    status: z.literal("error"),
    type: z.literal(LegacyPreviewResultType.RuntimeError),
    message: z.string(),
    stack: z.string().optional(),
  }).strict(),
  z.object({
    status: z.literal("error"),
    type: z.literal(LegacyPreviewResultType.ToolInterrupted),
    message: z.string(),
  }).strict(),
]);

/**
 * Explicit compatibility rule for preview feedback written by the
 * 1c9d177/18c977a writers before WebContainer result types were introduced.
 * Remove only after those stored rows have been migrated or retired.
 */
export const UserPreviewFeedbackMetaSchema = z.object({
  previewResult: z.union([ToolResultSchema, LegacyPreviewResultSchema]),
}).strict();

export const AssistantReplyMetaSchema = z.object({
  kind: z.literal(LegacyAssistantMessageKind.Reply),
}).strict();

export const AssistantToolRoundMetaSchema = z.object({
  toolCalls: z.array(ToolCallMetaSchema).min(1),
}).strict();

/**
 * Explicit compatibility rule for assistant metadata written by 243437f.
 * The extra kind field is accepted only alongside the exact current tool-call
 * shape. Remove after pre-c924091 transcripts have been migrated or retired.
 */
export const LegacyAssistantToolRoundMetaSchema = z.object({
  kind: z.enum([
    LegacyAssistantMessageKind.Code,
    LegacyAssistantMessageKind.Reply,
  ]),
  toolCalls: z.array(ToolCallMetaSchema).min(1),
}).strict();

export const LegacyAssistantCodeMetaSchema = z.object({
  kind: z.literal(LegacyAssistantMessageKind.Code),
}).strict();

export const ToolResultMetaSchema = z.object({
  toolCallId: ToolCallIdSchema,
}).strict();

export const JsonTextSchema = z.string().refine((value) => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}, { message: "tool result content must be valid JSON" });

const UserMessageInputSchema = z.object({
  role: z.literal(StoredMessageRole.User),
  content: z.string().min(1),
  meta: z.union([
    UserAttachmentsMetaSchema,
    // New writes use only the current result contract. Legacy parsing remains
    // isolated in UserPreviewFeedbackMetaSchema above.
    z.object({ previewResult: ToolResultSchema }).strict(),
  ]).optional(),
}).strict();

const AssistantReplyInputSchema = z.object({
  role: z.literal(StoredMessageRole.Assistant),
  content: z.string().min(1),
  model: z.string().min(1),
  meta: z.union([
    AssistantReplyMetaSchema,
    IntegrationCardMetaSchema,
  ]),
}).strict();

const AssistantToolRoundInputSchema = z.object({
  role: z.literal(StoredMessageRole.Assistant),
  content: z.string(),
  model: z.string().min(1),
  meta: AssistantToolRoundMetaSchema,
}).strict();

const ToolResultInputSchema = z.object({
  role: z.literal(StoredMessageRole.Tool),
  content: JsonTextSchema,
  meta: ToolResultMetaSchema,
}).strict();

export const StoredMessageInputSchema = z.union([
  UserMessageInputSchema,
  AssistantReplyInputSchema,
  AssistantToolRoundInputSchema,
  ToolResultInputSchema,
]);

export type StoredMessageInput = z.infer<typeof StoredMessageInputSchema>;
