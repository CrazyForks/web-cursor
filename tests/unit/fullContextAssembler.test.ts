import { describe, expect, it } from "vitest";
import {
  FullContextAssembler,
  parseStoredTranscript,
  TranscriptProtocolError,
  TranscriptProtocolErrorCode,
  type StoredTranscriptRow,
  type TranscriptProtocolErrorCode as TranscriptProtocolErrorCodeValue,
} from "../../lib/agent/fullContextAssembler";
import {
  IntegrationAction,
  IntegrationCardKind,
  IntegrationProvider,
  IntegrationReason,
} from "../../types/integration";
import { ImageAssetSource } from "../../types/image";
import { ToolName, ToolResultType } from "../../types/tool";

function expectProtocolError(
  action: () => unknown,
  code: TranscriptProtocolErrorCodeValue,
  rowIndex: number,
) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptProtocolError);
    expect(error).toMatchObject({ code, rowIndex });
    return;
  }
  throw new Error(`Expected ${code}`);
}

function closedToolRound(
  name: string,
  result: unknown,
): StoredTranscriptRow[] {
  return [
    {
      role: "assistant",
      content: "",
      meta: {
        toolCalls: [{
          id: "call-result",
          name,
          arguments: "{}",
        }],
      },
    },
    {
      role: "tool",
      content: JSON.stringify(result),
      meta: { toolCallId: "call-result" },
    },
  ];
}

describe("FullContextAssembler", () => {
  it("projects every legal domain message without changing provider-visible content", () => {
    const rows: StoredTranscriptRow[] = [
      {
        seq: 1,
        role: "user",
        content: "请按截图修改",
        meta: {
          attachments: [{
            id: "00000000-0000-4000-8000-000000000001",
            type: "image",
            mimeType: "image/png",
            sizeBytes: 128,
            name: "reference.png",
            previewUrl: "/api/attachments/1",
          }],
        },
      },
      {
        seq: 2,
        role: "assistant",
        content: "读取项目",
        meta: {
          toolCalls: [
            {
              id: "call-list",
              name: "list_files",
              arguments: "{}",
            },
            {
              id: "call-read",
              name: "read_file",
              arguments: "{\"path\":\"src/App.tsx\"}",
            },
          ],
        },
      },
      {
        seq: 3,
        role: "tool",
        content: "{\"status\":\"ok\",\"tool\":\"list_files\",\"revision\":7,\"files\":[]}",
        meta: { toolCallId: "call-list" },
      },
      {
        seq: 4,
        role: "tool",
        content: "{\"status\":\"ok\",\"tool\":\"read_file\",\"revision\":7,\"path\":\"src/App.tsx\",\"content\":\"export default 1\",\"updatedAt\":\"2026-07-24T08:00:00.000Z\"}",
        meta: { toolCallId: "call-read" },
      },
      {
        seq: 5,
        role: "user",
        content: "浏览器预览结果：SERVER_READY。",
        meta: {
          previewResult: {
            status: "ok",
            type: ToolResultType.ServerReady,
            port: 3000,
            url: "https://preview.example.test",
          },
        },
      },
      {
        seq: 6,
        role: "assistant",
        content: "已完成",
        meta: { kind: "reply" },
      },
      {
        seq: 7,
        role: "user",
        content: "参考这个 Figma 链接",
      },
      {
        seq: 8,
        role: "assistant",
        content: "请先连接 Figma。",
        meta: {
          kind: IntegrationCardKind.IntegrationCard,
          provider: IntegrationProvider.Figma,
          action: IntegrationAction.Connect,
          reason: IntegrationReason.FigmaNotConnected,
          resume: { type: "conversation" },
        },
      },
    ];

    expect(FullContextAssembler.assemble(rows)).toEqual([
      {
        role: "user",
        content: [
          "请按截图修改",
          "",
          "用户本轮附带了以下附件。需要读取附件内容时，必须调用 inspect_attachment，并只能使用这里列出的 attachmentId：",
          "- attachmentId=00000000-0000-4000-8000-000000000001; type=image; mimeType=image/png; sizeBytes=128",
        ].join("\n"),
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-list",
            type: "function",
            function: { name: "list_files", arguments: "{}" },
          },
          {
            id: "call-read",
            type: "function",
            function: {
              name: "read_file",
              arguments: "{\"path\":\"src/App.tsx\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-list",
        content: "{\"status\":\"ok\",\"tool\":\"list_files\",\"revision\":7,\"files\":[]}",
      },
      {
        role: "tool",
        tool_call_id: "call-read",
        content: "{\"status\":\"ok\",\"tool\":\"read_file\",\"revision\":7,\"path\":\"src/App.tsx\",\"content\":\"export default 1\",\"updatedAt\":\"2026-07-24T08:00:00.000Z\"}",
      },
      {
        role: "user",
        content: "浏览器预览结果：SERVER_READY。",
      },
      {
        role: "assistant",
        content: "已完成",
      },
      {
        role: "user",
        content: "参考这个 Figma 链接",
      },
      {
        role: "assistant",
        content: "请先连接 Figma。",
      },
    ]);
  });

  it("accepts only the explicitly documented legacy message shapes", () => {
    const rows: StoredTranscriptRow[] = [
      {
        role: "user",
        content: "旧预览成功",
        meta: {
          previewResult: {
            status: "ok",
            type: "RENDER_OK",
            durationMs: 12,
          },
        },
      },
      {
        role: "assistant",
        content: "旧代码回复",
        meta: { kind: "code" },
      },
      {
        role: "assistant",
        content: "旧工具轮文本不会投影",
        meta: {
          kind: "reply",
          toolCalls: [{
            id: "legacy-call",
            name: "write_app",
            arguments: "{not-json",
          }],
        },
      },
      {
        role: "tool",
        content: "{\"status\":\"error\",\"type\":\"COMPILE_ERROR\",\"message\":\"legacy compile failed\"}",
        meta: { toolCallId: "legacy-call" },
      },
    ];

    expect(FullContextAssembler.assemble(rows)).toEqual([
      { role: "user", content: "旧预览成功" },
      { role: "assistant", content: "旧代码回复" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "legacy-call",
          type: "function",
          function: {
            name: "write_app",
            arguments: "{not-json",
          },
        }],
      },
      {
        role: "tool",
        tool_call_id: "legacy-call",
        content: "{\"status\":\"error\",\"type\":\"COMPILE_ERROR\",\"message\":\"legacy compile failed\"}",
      },
    ]);
  });

  it.each([
    {
      label: "list_files",
      name: ToolName.ListFiles,
      result: {
        status: "ok",
        tool: ToolName.ListFiles,
        revision: 3,
        files: [{
          path: "src/App.tsx",
          updatedAt: "2026-07-24T08:00:00.000Z",
        }],
      },
    },
    {
      label: "search_text",
      name: ToolName.SearchText,
      result: {
        status: "ok",
        tool: ToolName.SearchText,
        revision: 3,
        query: "Button",
        matches: [{
          path: "src/App.tsx",
          line: 1,
          column: 8,
          snippet: "export Button",
        }],
        truncated: false,
      },
    },
    {
      label: "read_file",
      name: ToolName.ReadFile,
      result: {
        status: "ok",
        tool: ToolName.ReadFile,
        revision: 3,
        path: "src/App.tsx",
        content: "export default null",
        updatedAt: "2026-07-24T08:00:00.000Z",
      },
    },
    {
      label: "write_file",
      name: ToolName.WriteFile,
      result: {
        status: "ok",
        tool: ToolName.WriteFile,
        revision: 4,
        path: "src/App.tsx",
        updatedAt: "2026-07-24T08:00:00.000Z",
      },
    },
    {
      label: "delete_file",
      name: ToolName.DeleteFile,
      result: {
        status: "ok",
        tool: ToolName.DeleteFile,
        revision: 4,
        path: "src/App.tsx",
      },
    },
    {
      label: "rename_file",
      name: ToolName.RenameFile,
      result: {
        status: "ok",
        tool: ToolName.RenameFile,
        revision: 4,
        oldPath: "src/App.tsx",
        newPath: "src/Main.tsx",
        updatedAt: "2026-07-24T08:00:00.000Z",
      },
    },
    {
      label: "git_status",
      name: ToolName.GitStatus,
      result: {
        status: "ok",
        tool: ToolName.GitStatus,
        files: [{ path: "src/App.tsx", head: 1, workdir: 2, stage: 1 }],
      },
    },
    {
      label: "git_stage",
      name: ToolName.GitStage,
      result: {
        status: "ok",
        tool: ToolName.GitStage,
        files: [],
      },
    },
    {
      label: "git_unstage",
      name: ToolName.GitUnstage,
      result: {
        status: "ok",
        tool: ToolName.GitUnstage,
        files: [],
      },
    },
    {
      label: "git_commit",
      name: ToolName.GitCommit,
      result: {
        status: "ok",
        tool: ToolName.GitCommit,
        oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
    {
      label: "git_log",
      name: ToolName.GitLog,
      result: {
        status: "ok",
        tool: ToolName.GitLog,
        commits: [{
          oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          message: "initial",
          parent: [],
          author: {
            name: "Codex",
            email: "codex@example.test",
            timestamp: 1,
            timezoneOffset: 0,
          },
        }],
      },
    },
    {
      label: "git_current_branch",
      name: ToolName.GitCurrentBranch,
      result: {
        status: "ok",
        tool: ToolName.GitCurrentBranch,
        branch: "main",
      },
    },
    {
      label: "run_preview",
      name: ToolName.RunPreview,
      result: {
        status: "ok",
        type: ToolResultType.ServerReady,
        port: 5173,
        url: "https://preview.example.test",
      },
    },
    {
      label: "inspect_attachment",
      name: ToolName.InspectAttachment,
      result: {
        status: "ok",
        tool: ToolName.InspectAttachment,
        attachmentId: "00000000-0000-4000-8000-000000000011",
        attachmentType: "image",
        mimeType: "image/png",
        observations: "A blue button.",
      },
    },
    {
      label: "inspect_figma_design",
      name: ToolName.InspectFigmaDesign,
      result: {
        status: "ok",
        tool: ToolName.InspectFigmaDesign,
        source: {
          fileKey: "file-key",
          nodeId: "1:2",
          fileName: "Web Cursor",
          nodeName: "Hero",
        },
        figmaTree: {
          id: "1:2",
          name: "Hero",
          type: "FRAME",
          children: [{
            id: "1:3",
            name: "Title",
            type: "TEXT",
            text: {
              characters: "Hello",
              style: { fontSize: 32, italic: false },
            },
          }],
        },
        assets: [],
        warnings: [],
      },
    },
    {
      label: "generate_image",
      name: ToolName.GenerateImage,
      result: {
        status: "ok",
        tool: ToolName.GenerateImage,
        runId: "00000000-0000-4000-8000-000000000012",
        result: {
          assets: [{
            assetId: "00000000-0000-4000-8000-000000000013",
            imageJobId: "00000000-0000-4000-8000-000000000014",
            label: "hero",
            url: "https://assets.example.test/hero.png",
            mimeType: "image/png",
            width: 1280,
            height: 720,
            source: ImageAssetSource.GeneratedImage,
          }],
        },
      },
    },
  ])("accepts the current $label result contract", ({ name, result }) => {
    expect(parseStoredTranscript(closedToolRound(name, result))).toMatchObject({
      state: "closed",
    });
  });

  it.each([
    {
      label: "list_files before revisions",
      name: ToolName.ListFiles,
      result: {
        status: "ok",
        tool: ToolName.ListFiles,
        files: [{
          path: "src/App.tsx",
          updatedAt: "2026-07-24T08:00:00.000Z",
        }],
      },
    },
    {
      label: "search_text before revisions",
      name: ToolName.SearchText,
      result: {
        status: "ok",
        tool: ToolName.SearchText,
        query: "Button",
        matches: [],
        truncated: false,
      },
    },
    {
      label: "read_file before revisions",
      name: ToolName.ReadFile,
      result: {
        status: "ok",
        tool: ToolName.ReadFile,
        path: "src/App.tsx",
        content: "export default null",
        updatedAt: "2026-07-24T08:00:00.000Z",
      },
    },
    {
      label: "write_file before revisions",
      name: ToolName.WriteFile,
      result: {
        status: "ok",
        tool: ToolName.WriteFile,
        path: "src/App.tsx",
        updatedAt: "2026-07-24T08:00:00.000Z",
      },
    },
    {
      label: "delete_file before revisions",
      name: ToolName.DeleteFile,
      result: {
        status: "ok",
        tool: ToolName.DeleteFile,
        path: "src/App.tsx",
      },
    },
    {
      label: "rename_file before revisions",
      name: ToolName.RenameFile,
      result: {
        status: "ok",
        tool: ToolName.RenameFile,
        oldPath: "src/App.tsx",
        newPath: "src/Main.tsx",
        updatedAt: "2026-07-24T08:00:00.000Z",
      },
    },
    {
      label: "reply success",
      name: "reply",
      result: {
        status: "ok",
        tool: "reply",
        message: "Need more details.",
      },
    },
    {
      label: "old generic error",
      name: ToolName.ReadFile,
      result: {
        status: "error",
        tool: ToolName.ReadFile,
        code: "BAD_PATH",
        message: "Invalid path.",
      },
    },
    {
      label: "write_app render success",
      name: "write_app",
      result: { status: "ok", type: "RENDER_OK", durationMs: 12 },
    },
    {
      label: "write_app compile error",
      name: "write_app",
      result: {
        status: "error",
        type: "COMPILE_ERROR",
        message: "compile failed",
      },
    },
    {
      label: "write_app runtime error",
      name: "write_app",
      result: {
        status: "error",
        type: "RUNTIME_ERROR",
        message: "runtime failed",
        stack: "stack",
      },
    },
    {
      label: "write_app interruption",
      name: "write_app",
      result: {
        status: "error",
        type: "TOOL_INTERRUPTED",
        message: "interrupted",
      },
    },
  ])("accepts only the verified legacy $label result", ({ name, result }) => {
    expect(parseStoredTranscript(closedToolRound(name, result))).toMatchObject({
      state: "closed",
    });
  });

  it.each([
    {
      label: "unknown tool BAD_ARGS result",
      name: "future_tool",
      result: {
        status: "error",
        tool: "future_tool",
        code: "BAD_ARGS",
        message: "Unknown tool.",
      },
    },
    {
      label: "known tool interruption",
      name: ToolName.ReadFile,
      result: {
        status: "error",
        type: ToolResultType.ToolInterrupted,
        message: "Interrupted before execution.",
      },
    },
    {
      label: "unknown tool interruption",
      name: "future_tool",
      result: {
        status: "error",
        type: ToolResultType.ToolInterrupted,
        message: "Interrupted before execution.",
      },
    },
  ])("accepts the explicit cross-tool $label", ({ name, result }) => {
    expect(parseStoredTranscript(closedToolRound(name, result))).toMatchObject({
      state: "closed",
    });
  });

  it("reports a legal tail tool round as pending, while model assembly rejects it", () => {
    const rows: StoredTranscriptRow[] = [{
      seq: 9,
      role: "assistant",
      content: "",
      meta: {
        toolCalls: [{
          id: "pending-call",
          name: "read_file",
          arguments: "{\"path\":\"src/App.tsx\"}",
        }],
      },
    }];

    expect(parseStoredTranscript(rows)).toMatchObject({
      state: "pending",
      pending: {
        assistantMessageIndex: 0,
        nextCall: { id: "pending-call" },
      },
    });
    expectProtocolError(
      () => FullContextAssembler.assemble(rows),
      TranscriptProtocolErrorCode.PendingToolRound,
      0,
    );
  });

  it("allows a provider id to be reused by a later closed assistant round", () => {
    const round = (name: string) => ({
      role: "assistant",
      content: "",
      meta: {
        toolCalls: [{
          id: "provider-reused-id",
          name,
          arguments: "{}",
        }],
      },
    });
    const result = (content: unknown) => ({
      role: "tool",
      content: JSON.stringify(content),
      meta: { toolCallId: "provider-reused-id" },
    });

    expect(parseStoredTranscript([
      round("list_files"),
      result({
        status: "ok",
        tool: ToolName.ListFiles,
        revision: 0,
        files: [],
      }),
      round("git_status"),
      result({
        status: "ok",
        tool: ToolName.GitStatus,
        files: [],
      }),
    ])).toMatchObject({ state: "closed" });
  });

  it.each([
    {
      label: "unknown stored role",
      rows: [{ role: "system", content: "hidden", meta: null }],
      code: TranscriptProtocolErrorCode.UnsupportedRole,
      rowIndex: 0,
    },
    {
      label: "assistant metadata is absent",
      rows: [{ role: "assistant", content: "ambiguous", meta: null }],
      code: TranscriptProtocolErrorCode.InvalidMeta,
      rowIndex: 0,
    },
    {
      label: "a reply has empty content",
      rows: [{ role: "assistant", content: "", meta: { kind: "reply" } }],
      code: TranscriptProtocolErrorCode.InvalidRow,
      rowIndex: 0,
    },
    {
      label: "attachment metadata has no attachment",
      rows: [{ role: "user", content: "hello", meta: { attachments: [] } }],
      code: TranscriptProtocolErrorCode.InvalidMeta,
      rowIndex: 0,
    },
    {
      label: "tool arguments are missing",
      rows: [{
        role: "assistant",
        content: "",
        meta: {
          toolCalls: [{ id: "call-a", name: "read_file" }],
        },
      }],
      code: TranscriptProtocolErrorCode.InvalidMeta,
      rowIndex: 0,
    },
    {
      label: "tool result is not JSON",
      rows: [{
        role: "tool",
        content: "not-json",
        meta: { toolCallId: "call-a" },
      }],
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 0,
    },
    {
      label: "result tool does not equal call name",
      rows: closedToolRound(ToolName.ListFiles, {
        status: "ok",
        tool: ToolName.ReadFile,
        revision: 0,
        path: "src/App.tsx",
        content: "",
        updatedAt: "2026-07-24T08:00:00.000Z",
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "a strict current result has an extra field",
      rows: closedToolRound(ToolName.ListFiles, {
        status: "ok",
        tool: ToolName.ListFiles,
        revision: 0,
        files: [],
        guessedRevision: 1,
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "an unknown tool reports invented success",
      rows: closedToolRound("future_tool", {
        status: "ok",
        tool: "future_tool",
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "an unknown tool reports a non-BAD_ARGS error",
      rows: closedToolRound("future_tool", {
        status: "error",
        tool: "future_tool",
        code: "INTERNAL_ERROR",
        message: "failed",
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "a generic error omits the paired tool",
      rows: closedToolRound(ToolName.ReadFile, {
        status: "error",
        code: "BAD_ARGS",
        message: "bad input",
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "generate_image reports a Figma-only error",
      rows: closedToolRound(ToolName.GenerateImage, {
        status: "error",
        tool: ToolName.GenerateImage,
        code: "FIGMA_UNAUTHORIZED",
        message: "wrong tool error",
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "inspect_attachment reports a Git-only error",
      rows: closedToolRound(ToolName.InspectAttachment, {
        status: "error",
        tool: ToolName.InspectAttachment,
        code: "NOTHING_TO_COMMIT",
        message: "wrong tool error",
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "run_preview reports a file revision error",
      rows: closedToolRound(ToolName.RunPreview, {
        status: "error",
        tool: ToolName.RunPreview,
        code: "REVISION_CONFLICT",
        message: "wrong tool error",
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "search_text reports its unreachable old validation error",
      rows: closedToolRound(ToolName.SearchText, {
        status: "error",
        tool: ToolName.SearchText,
        code: "BAD_SEARCH_QUERY",
        message: "query validation is handled by BAD_ARGS",
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "legacy reply reports a file-only historical error",
      rows: closedToolRound("reply", {
        status: "error",
        tool: "reply",
        code: "BAD_PATH",
        message: "wrong legacy tool error",
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "a successful image result contains errors",
      rows: closedToolRound(ToolName.GenerateImage, {
        status: "ok",
        tool: ToolName.GenerateImage,
        runId: "00000000-0000-4000-8000-000000000012",
        result: {
          assets: [],
          errors: [{
            code: "IMAGE_PROVIDER_FAILED",
            message: "failed",
          }],
        },
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "legacy preview result contains passthrough fields",
      rows: closedToolRound("write_app", {
        status: "ok",
        type: "RENDER_OK",
        durationMs: 12,
        guessed: true,
      }),
      code: TranscriptProtocolErrorCode.InvalidToolResult,
      rowIndex: 1,
    },
    {
      label: "tool result is orphaned",
      rows: [{
        role: "tool",
        content: "{}",
        meta: { toolCallId: "call-a" },
      }],
      code: TranscriptProtocolErrorCode.OrphanToolResult,
      rowIndex: 0,
    },
    {
      label: "tool result id is mismatched",
      rows: [
        {
          role: "assistant",
          content: "",
          meta: {
            toolCalls: [{
              id: "call-a",
              name: "read_file",
              arguments: "{}",
            }],
          },
        },
        {
          role: "tool",
          content: "{}",
          meta: { toolCallId: "call-b" },
        },
      ],
      code: TranscriptProtocolErrorCode.MismatchedToolResult,
      rowIndex: 1,
    },
    {
      label: "a new message interrupts a tool round",
      rows: [
        {
          role: "assistant",
          content: "",
          meta: {
            toolCalls: [{
              id: "call-a",
              name: "read_file",
              arguments: "{}",
            }],
          },
        },
        {
          role: "user",
          content: "new request",
        },
      ],
      code: TranscriptProtocolErrorCode.MissingToolResult,
      rowIndex: 1,
    },
    {
      label: "one round reuses a tool call id",
      rows: [{
        role: "assistant",
        content: "",
        meta: {
          toolCalls: [
            {
              id: "call-a",
              name: "list_files",
              arguments: "{}",
            },
            {
              id: "call-a",
              name: "read_file",
              arguments: "{}",
            },
          ],
        },
      }],
      code: TranscriptProtocolErrorCode.DuplicateToolCallId,
      rowIndex: 0,
    },
  ])("fails closed when $label", ({ rows, code, rowIndex }) => {
    expectProtocolError(
      () => parseStoredTranscript(rows),
      code,
      rowIndex,
    );
  });
});
