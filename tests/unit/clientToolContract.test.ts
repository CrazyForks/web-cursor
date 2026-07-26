import { describe, expect, it } from "vitest";
import {
  TranscriptProtocolError,
  TranscriptProtocolErrorCode,
} from "../../lib/agent/fullContextAssembler";
import {
  ClientGitToolResultSchema,
  ClientToolResultSubmissionSchema,
  clientToolRunsInBrowser,
} from "../../types/clientTool";
import { findNextPendingToolCall } from "../../lib/pendingToolCall";
import { ProjectStorageKind } from "../../types/projectStorage";
import { ToolName, ToolResultType } from "../../types/tool";

const projectId = "166837f7-3342-4644-a372-8ca180dbad0a";
const submissionIdentity = {
  invocationId: "858ba9f0-16d1-4972-bd3e-f200cbf8f910",
  agentRunId: "192d9dad-a5db-4c47-b4e2-d9ca04027404",
  attempt: 2,
};

describe("client tool execution domain", () => {
  it("keeps Database file tools on the server and Browser Git file tools in the browser", () => {
    expect(clientToolRunsInBrowser(ToolName.ListFiles, ProjectStorageKind.Database)).toBe(false);
    expect(clientToolRunsInBrowser(ToolName.ListFiles, ProjectStorageKind.BrowserGit)).toBe(true);
    expect(clientToolRunsInBrowser(ToolName.RunPreview, ProjectStorageKind.Database)).toBe(true);
    expect(clientToolRunsInBrowser(ToolName.RunPreview, ProjectStorageKind.BrowserGit)).toBe(true);
    expect(clientToolRunsInBrowser(ToolName.InspectAttachment, ProjectStorageKind.BrowserGit)).toBe(false);
    expect(clientToolRunsInBrowser(ToolName.GitStatus, ProjectStorageKind.Database)).toBe(false);
    expect(clientToolRunsInBrowser(ToolName.GitStatus, ProjectStorageKind.BrowserGit)).toBe(true);
    expect(clientToolRunsInBrowser(ToolName.GitCommit, ProjectStorageKind.BrowserGit)).toBe(true);
  });
});

describe("ClientToolResultSubmissionSchema", () => {
  it("binds project, tool call, declared tool, and exact result schema", () => {
    expect(ClientToolResultSubmissionSchema.parse({
      ...submissionIdentity,
      projectId,
      toolCallId: "call-list",
      tool: ToolName.ListFiles,
      result: {
        status: "ok",
        tool: ToolName.ListFiles,
        revision: 0,
        files: [],
      },
    })).toMatchObject({ projectId, toolCallId: "call-list", tool: ToolName.ListFiles });

    expect(ClientToolResultSubmissionSchema.parse({
      ...submissionIdentity,
      projectId,
      toolCallId: "call-preview",
      tool: ToolName.RunPreview,
      result: {
        status: "ok",
        type: ToolResultType.ServerReady,
        port: 5173,
        url: "https://preview.example.test",
      },
    })).toMatchObject({ projectId, toolCallId: "call-preview", tool: ToolName.RunPreview });
  });

  it("rejects a result whose tool does not match the submitted tool", () => {
    expect(() => ClientToolResultSubmissionSchema.parse({
      ...submissionIdentity,
      projectId,
      toolCallId: "call-write",
      tool: ToolName.WriteFile,
      result: {
        status: "ok",
        tool: ToolName.DeleteFile,
        revision: 1,
        path: "src/App.tsx",
      },
    })).toThrow();
  });

  it("accepts strict Browser Git results and rejects mismatched Git tools", () => {
    expect(ClientGitToolResultSchema.parse({
      status: "ok",
      tool: ToolName.GitStatus,
      files: [{ path: "src/App.tsx", head: 1, workdir: 2, stage: 1 }],
    })).toMatchObject({ tool: ToolName.GitStatus });

    expect(() => ClientToolResultSubmissionSchema.parse({
      ...submissionIdentity,
      projectId,
      toolCallId: "call-stage",
      tool: ToolName.GitStage,
      result: {
        status: "ok",
        tool: ToolName.GitUnstage,
        files: [],
      },
    })).toThrow();
  });

  it("rejects undeclared fields instead of guessing compatibility", () => {
    expect(() => ClientToolResultSubmissionSchema.parse({
      ...submissionIdentity,
      projectId,
      toolCallId: "call-list",
      tool: ToolName.ListFiles,
      result: {
        status: "ok",
        tool: ToolName.ListFiles,
        revision: 0,
        files: [],
        guessedRevision: 1,
      },
    })).toThrow();
  });

  it.each([
    {
      tool: ToolName.SearchText,
      code: "BAD_SEARCH_QUERY",
    },
    {
      tool: ToolName.GitCommit,
      code: "GIT_AUTHOR_REQUIRED",
    },
  ])("rejects $code when the browser $tool writer cannot emit it", ({
    tool,
    code,
  }) => {
    expect(() => ClientToolResultSubmissionSchema.parse({
      ...submissionIdentity,
      projectId,
      toolCallId: `call-${tool}`,
      tool,
      result: {
        status: "error",
        tool,
        code,
        message: "invalid result contract",
      },
    })).toThrow();
  });
});

describe("findNextPendingToolCall", () => {
  const calls = [
    { id: "call-a", name: ToolName.ListFiles, arguments: "{}" },
    { id: "call-b", name: ToolName.ReadFile, arguments: '{"path":"src/App.tsx"}' },
  ];

  it("requires tool results in assistant call order", () => {
    const assistant = {
      role: "assistant",
      content: "",
      meta: { toolCalls: calls },
    };
    expect(findNextPendingToolCall([assistant]))?.toMatchObject({ id: "call-a" });
    expect(findNextPendingToolCall([
      assistant,
      {
        role: "tool",
        content: JSON.stringify({
          status: "ok",
          tool: ToolName.ListFiles,
          revision: 0,
          files: [],
        }),
        meta: { toolCallId: "call-a" },
      },
    ]))?.toMatchObject({ id: "call-b" });

    try {
      findNextPendingToolCall([
        assistant,
        { role: "tool", content: "{}", meta: { toolCallId: "call-b" } },
      ]);
      throw new Error("expected a mismatched tool-result protocol error");
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptProtocolError);
      expect((error as TranscriptProtocolError).code).toBe(
        TranscriptProtocolErrorCode.MismatchedToolResult,
      );
    }
  });

  it("returns null after all calls close so duplicate or late results are rejected", () => {
    expect(findNextPendingToolCall([
      { role: "assistant", content: "", meta: { toolCalls: calls } },
      {
        role: "tool",
        content: JSON.stringify({
          status: "ok",
          tool: ToolName.ListFiles,
          revision: 0,
          files: [],
        }),
        meta: { toolCallId: "call-a" },
      },
      {
        role: "tool",
        content: JSON.stringify({
          status: "ok",
          tool: ToolName.ReadFile,
          revision: 0,
          path: "src/App.tsx",
          content: "export default null",
          updatedAt: "2026-07-24T08:00:00.000Z",
        }),
        meta: { toolCallId: "call-b" },
      },
    ])).toBeNull();
  });

  it("validates earlier rounds instead of hiding malformed history behind the latest assistant", () => {
    expect(() => findNextPendingToolCall([
      { role: "assistant", content: "", meta: { toolCalls: calls } },
      { role: "assistant", content: "later reply", meta: { kind: "reply" } },
    ])).toThrowError(
      expect.objectContaining({
        code: TranscriptProtocolErrorCode.MissingToolResult,
      }),
    );
  });
});
