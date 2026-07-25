import { describe, expect, it } from "vitest";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import {
  ToolCallStreamAssembler,
  ToolCallStreamErrorCode,
  ToolCallStreamProtocolError,
  type ToolCallStreamErrorCode as ToolCallStreamErrorCodeValue,
} from "../../lib/agent/toolCallStreamAssembler";

type ToolCallDelta = ChatCompletionChunk.Choice.Delta.ToolCall;

function malformedDelta(value: unknown): ToolCallDelta {
  return value as ToolCallDelta;
}

function expectProtocolError(
  action: () => unknown,
  code: ToolCallStreamErrorCodeValue,
) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolCallStreamProtocolError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("ToolCallStreamAssembler", () => {
  it("preserves fragmented arguments and parallel call order without guessing names", () => {
    const assembler = new ToolCallStreamAssembler();

    const first = assembler.append({
      index: 0,
      id: "call-a",
      type: "function",
      function: { name: "provider_unknown_tool", arguments: "" },
    });
    expect(first).toEqual({
      index: 0,
      id: "call-a",
      name: "provider_unknown_tool",
      type: "function",
      arguments: "",
    });

    assembler.append({
      index: 1,
      id: "call-b",
      type: "function",
      function: { name: "read_file", arguments: "{\"path\":" },
    });
    assembler.append({ index: 0, function: { arguments: "{\"query\":" } });
    assembler.append({ index: 1, function: { arguments: "\"src/App.tsx\"}" } });
    assembler.append({
      index: 0,
      id: "call-a",
      function: { name: "provider_unknown_tool", arguments: "\"button\"}" },
    });
    assembler.observeFinishReason("tool_calls");

    expect(assembler.snapshots()).toEqual([
      {
        index: 0,
        id: "call-a",
        name: "provider_unknown_tool",
        type: "function",
        arguments: "{\"query\":\"button\"}",
      },
      {
        index: 1,
        id: "call-b",
        name: "read_file",
        type: "function",
        arguments: "{\"path\":\"src/App.tsx\"}",
      },
    ]);
    expect(assembler.finish()).toEqual([
      {
        id: "call-a",
        name: "provider_unknown_tool",
        arguments: "{\"query\":\"button\"}",
      },
      {
        id: "call-b",
        name: "read_file",
        arguments: "{\"path\":\"src/App.tsx\"}",
      },
    ]);
  });

  it.each([
    ["missing", { id: "call-a" }],
    ["negative", { index: -1, id: "call-a" }],
    ["fractional", { index: 0.5, id: "call-a" }],
  ])("rejects a %s index", (_label, value) => {
    const assembler = new ToolCallStreamAssembler();
    expectProtocolError(
      () => assembler.append(malformedDelta(value)),
      ToolCallStreamErrorCode.InvalidIndex,
    );
  });

  it("rejects an index hole when the stream finishes", () => {
    const assembler = new ToolCallStreamAssembler();
    assembler.append({
      index: 1,
      id: "call-b",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    });
    assembler.observeFinishReason("tool_calls");
    expectProtocolError(
      () => assembler.finish(),
      ToolCallStreamErrorCode.IndexGap,
    );
  });

  it.each([
    [
      "id",
      { index: 0, id: "call-b" },
      ToolCallStreamErrorCode.ConflictingId,
    ],
    [
      "name",
      { index: 0, function: { name: "write_file" } },
      ToolCallStreamErrorCode.ConflictingName,
    ],
  ])("rejects conflicting %s chunks", (_field, conflicting, code) => {
    const assembler = new ToolCallStreamAssembler();
    assembler.append({
      index: 0,
      id: "call-a",
      function: { name: "read_file", arguments: "{}" },
    });
    expectProtocolError(
      () => assembler.append(malformedDelta(conflicting)),
      code,
    );
  });

  it("rejects a non-function tool type", () => {
    const assembler = new ToolCallStreamAssembler();
    expectProtocolError(
      () => assembler.append(malformedDelta({
        index: 0,
        id: "call-a",
        type: "custom",
      })),
      ToolCallStreamErrorCode.InvalidType,
    );
  });

  it.each([
    ["blank id", { index: 0, id: " ", function: { name: "read_file", arguments: "{}" } }],
    ["blank name", { index: 0, id: "call-a", function: { name: " ", arguments: "{}" } }],
  ])("rejects a %s instead of silently treating it as omitted", (_label, value) => {
    const assembler = new ToolCallStreamAssembler();
    expectProtocolError(
      () => assembler.append(malformedDelta(value)),
      ToolCallStreamErrorCode.InvalidDelta,
    );
  });

  it("rejects one provider id reused by different tool-call indices", () => {
    const assembler = new ToolCallStreamAssembler();
    assembler.append({
      index: 0,
      id: "call-a",
      type: "function",
      function: { name: "list_files", arguments: "{}" },
    });
    assembler.append({
      index: 1,
      id: "call-a",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    });
    assembler.observeFinishReason("tool_calls");
    expectProtocolError(
      () => assembler.finish(),
      ToolCallStreamErrorCode.DuplicateId,
    );
  });

  it.each([
    [
      "id",
      { index: 0, type: "function", function: { name: "read_file", arguments: "{}" } },
      ToolCallStreamErrorCode.MissingId,
    ],
    [
      "name",
      { index: 0, id: "call-a", type: "function", function: { arguments: "{}" } },
      ToolCallStreamErrorCode.MissingName,
    ],
    [
      "type",
      { index: 0, id: "call-a", function: { name: "read_file", arguments: "{}" } },
      ToolCallStreamErrorCode.MissingType,
    ],
    [
      "arguments",
      { index: 0, id: "call-a", type: "function", function: { name: "read_file" } },
      ToolCallStreamErrorCode.MissingArguments,
    ],
  ])("rejects a finished call missing %s", (_field, value, code) => {
    const assembler = new ToolCallStreamAssembler();
    assembler.append(malformedDelta(value));
    assembler.observeFinishReason("tool_calls");
    expectProtocolError(() => assembler.finish(), code);
  });

  it("requires one finish reason that matches the assembled turn", () => {
    const missing = new ToolCallStreamAssembler();
    missing.append({
      index: 0,
      id: "call-a",
      type: "function",
      function: { name: "list_files", arguments: "{}" },
    });
    expectProtocolError(
      () => missing.finish(),
      ToolCallStreamErrorCode.MissingFinishReason,
    );

    const wrong = new ToolCallStreamAssembler();
    wrong.append({
      index: 0,
      id: "call-a",
      type: "function",
      function: { name: "list_files", arguments: "{}" },
    });
    wrong.observeFinishReason("stop");
    expectProtocolError(
      () => wrong.finish(),
      ToolCallStreamErrorCode.InvalidFinishReason,
    );

    const textOnly = new ToolCallStreamAssembler();
    textOnly.observeFinishReason("stop");
    expect(textOnly.finish()).toEqual([]);
  });

  it("rejects unknown or conflicting provider finish reasons", () => {
    const unknown = new ToolCallStreamAssembler();
    expectProtocolError(
      () => unknown.observeFinishReason("provider_specific"),
      ToolCallStreamErrorCode.InvalidFinishReason,
    );

    const conflicting = new ToolCallStreamAssembler();
    conflicting.observeFinishReason("tool_calls");
    expectProtocolError(
      () => conflicting.observeFinishReason("stop"),
      ToolCallStreamErrorCode.ConflictingFinishReason,
    );
  });
});
