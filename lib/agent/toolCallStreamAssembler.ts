/**
 * [INPUT]: OpenAI Chat Completions 流中的单个 tool_calls delta
 * [OUTPUT]: 不补默认值的累积快照，以及完成校验后的 ToolCallMeta[]
 * [POS]: A 域 provider 流协议边界 —— 严格组装被拆分的工具调用
 * [PROTOCOL]: index 必须有效且最终连续；id/name 不得冲突；arguments 必须明确出现
 */
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { z } from "zod";
import type { ToolCallMeta } from "@/types/tool";

export const ToolCallStreamErrorCode = {
  InvalidDelta: "TOOL_CALL_STREAM_INVALID_DELTA",
  InvalidIndex: "TOOL_CALL_STREAM_INVALID_INDEX",
  InvalidType: "TOOL_CALL_STREAM_INVALID_TYPE",
  ConflictingId: "TOOL_CALL_STREAM_CONFLICTING_ID",
  ConflictingName: "TOOL_CALL_STREAM_CONFLICTING_NAME",
  DuplicateId: "TOOL_CALL_STREAM_DUPLICATE_ID",
  IndexGap: "TOOL_CALL_STREAM_INDEX_GAP",
  MissingId: "TOOL_CALL_STREAM_MISSING_ID",
  MissingName: "TOOL_CALL_STREAM_MISSING_NAME",
  MissingType: "TOOL_CALL_STREAM_MISSING_TYPE",
  MissingArguments: "TOOL_CALL_STREAM_MISSING_ARGUMENTS",
  MissingFinishReason: "TOOL_CALL_STREAM_MISSING_FINISH_REASON",
  InvalidFinishReason: "TOOL_CALL_STREAM_INVALID_FINISH_REASON",
  ConflictingFinishReason: "TOOL_CALL_STREAM_CONFLICTING_FINISH_REASON",
} as const;

export type ToolCallStreamErrorCode =
  typeof ToolCallStreamErrorCode[keyof typeof ToolCallStreamErrorCode];

export class ToolCallStreamProtocolError extends Error {
  constructor(
    readonly code: ToolCallStreamErrorCode,
    readonly index: number | undefined,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ToolCallStreamProtocolError";
  }
}

type ToolCallDelta = ChatCompletionChunk.Choice.Delta.ToolCall;
type FinishReason = ChatCompletionChunk.Choice["finish_reason"];
type TerminalFinishReason = Exclude<FinishReason, null>;

const ToolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().min(1).refine((value) => value.trim().length > 0).optional(),
  type: z.literal("function").optional(),
  function: z.object({
    name: z.string().min(1).refine((value) => value.trim().length > 0).optional(),
    arguments: z.string().optional(),
  }).strict().optional(),
}).strict();

const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "function_call",
]);

type CallState = {
  index: number;
  id?: string;
  name?: string;
  typeSeen: boolean;
  arguments?: string;
};

export type ToolCallStreamSnapshot = {
  index: number;
  id?: string;
  name?: string;
  type?: "function";
  arguments?: string;
};

function fail(
  code: ToolCallStreamErrorCode,
  message: string,
  index?: number,
): never {
  throw new ToolCallStreamProtocolError(code, index, message);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseDelta(input: ToolCallDelta): z.infer<typeof ToolCallDeltaSchema> {
  const raw = input as unknown;
  if (
    typeof raw !== "object"
    || raw === null
    || !hasOwn(raw, "index")
    || typeof (raw as { index?: unknown }).index !== "number"
    || !Number.isInteger((raw as { index: number }).index)
    || (raw as { index: number }).index < 0
  ) {
    return fail(
      ToolCallStreamErrorCode.InvalidIndex,
      "Tool-call delta index must be a non-negative integer.",
    );
  }

  const index = (raw as { index: number }).index;
  if (hasOwn(raw, "type") && (raw as { type?: unknown }).type !== "function") {
    return fail(
      ToolCallStreamErrorCode.InvalidType,
      "Tool-call delta type must be function when present.",
      index,
    );
  }

  const parsed = ToolCallDeltaSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      ToolCallStreamErrorCode.InvalidDelta,
      "Tool-call delta does not match the OpenAI streaming contract.",
      index,
    );
  }
  return parsed.data;
}

function mergeIdentity(
  current: string | undefined,
  incoming: string | undefined,
  code: typeof ToolCallStreamErrorCode.ConflictingId
    | typeof ToolCallStreamErrorCode.ConflictingName,
  field: "id" | "name",
  index: number,
): string | undefined {
  if (incoming === undefined) return current;
  if (current && current !== incoming) {
    return fail(code, `Tool-call ${field} conflicts with an earlier chunk.`, index);
  }
  return incoming;
}

function snapshotOf(state: CallState): ToolCallStreamSnapshot {
  return {
    index: state.index,
    ...(state.id ? { id: state.id } : {}),
    ...(state.name ? { name: state.name } : {}),
    ...(state.typeSeen ? { type: "function" as const } : {}),
    ...(state.arguments !== undefined ? { arguments: state.arguments } : {}),
  };
}

export class ToolCallStreamAssembler {
  private readonly calls = new Map<number, CallState>();
  private finishReason: TerminalFinishReason | undefined;

  observeFinishReason(reason: unknown): void {
    if (reason === null || reason === undefined) return;
    const parsed = FinishReasonSchema.safeParse(reason);
    if (!parsed.success) {
      return fail(
        ToolCallStreamErrorCode.InvalidFinishReason,
        `Unknown provider finish reason: ${String(reason)}.`,
      );
    }
    if (this.finishReason && this.finishReason !== parsed.data) {
      return fail(
        ToolCallStreamErrorCode.ConflictingFinishReason,
        `Provider finish reason changed from ${this.finishReason} to ${parsed.data}.`,
      );
    }
    this.finishReason = parsed.data;
  }

  append(delta: ToolCallDelta): ToolCallStreamSnapshot {
    const parsed = parseDelta(delta);
    const current = this.calls.get(parsed.index);
    const argumentFragment = parsed.function && hasOwn(parsed.function, "arguments")
      ? parsed.function.arguments
      : undefined;
    const next: CallState = {
      index: parsed.index,
      id: mergeIdentity(
        current?.id,
        parsed.id,
        ToolCallStreamErrorCode.ConflictingId,
        "id",
        parsed.index,
      ),
      name: mergeIdentity(
        current?.name,
        parsed.function?.name,
        ToolCallStreamErrorCode.ConflictingName,
        "name",
        parsed.index,
      ),
      typeSeen: current?.typeSeen === true || parsed.type === "function",
      arguments: argumentFragment === undefined
        ? current?.arguments
        : `${current?.arguments ?? ""}${argumentFragment}`,
    };
    this.calls.set(parsed.index, next);
    return snapshotOf(next);
  }

  snapshots(): ToolCallStreamSnapshot[] {
    return this.sortedStates().map(snapshotOf);
  }

  finish(): ToolCallMeta[] {
    const states = this.sortedStates();
    this.requireFinishReason(states.length > 0);
    const ids = new Set<string>();
    states.forEach((state, expectedIndex) => {
      if (state.index !== expectedIndex) {
        return fail(
          ToolCallStreamErrorCode.IndexGap,
          `Tool-call indices must be continuous from 0; expected ${expectedIndex}.`,
          state.index,
        );
      }
      if (state.id && ids.has(state.id)) {
        return fail(
          ToolCallStreamErrorCode.DuplicateId,
          `Tool-call id ${state.id} is duplicated across indices.`,
          state.index,
        );
      }
      if (state.id) ids.add(state.id);
    });
    return states.map((state) => this.completeCall(state));
  }

  private sortedStates(): CallState[] {
    return [...this.calls.values()].sort((left, right) => left.index - right.index);
  }

  private completeCall(state: CallState): ToolCallMeta {
    if (!state.id) {
      return fail(ToolCallStreamErrorCode.MissingId, "Tool call is missing a non-empty id.", state.index);
    }
    if (!state.name) {
      return fail(ToolCallStreamErrorCode.MissingName, "Tool call is missing a non-empty name.", state.index);
    }
    if (!state.typeSeen) {
      return fail(
        ToolCallStreamErrorCode.MissingType,
        "Tool call never supplied type=function.",
        state.index,
      );
    }
    if (state.arguments === undefined) {
      return fail(
        ToolCallStreamErrorCode.MissingArguments,
        "Tool call never supplied an arguments field.",
        state.index,
      );
    }
    return { id: state.id, name: state.name, arguments: state.arguments };
  }

  private requireFinishReason(hasToolCalls: boolean): void {
    if (!this.finishReason) {
      return fail(
        ToolCallStreamErrorCode.MissingFinishReason,
        "Provider stream ended without a terminal finish reason.",
      );
    }
    const expected = hasToolCalls ? "tool_calls" : "stop";
    if (this.finishReason !== expected) {
      return fail(
        ToolCallStreamErrorCode.InvalidFinishReason,
        `Expected finish_reason=${expected}, received ${this.finishReason}.`,
      );
    }
  }
}
