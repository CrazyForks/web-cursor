import { describe, expect, it } from "vitest";
import {
  ClientGitToolResultSchema,
  ClientToolResultSubmissionSchema,
  clientToolRunsInBrowser,
} from "../../types/clientTool";
import { findNextPendingToolCall } from "../../lib/pendingToolCall";
import { ProjectStorageKind } from "../../types/projectStorage";
import { ToolName, ToolResultType } from "../../types/tool";

const projectId = "166837f7-3342-4644-a372-8ca180dbad0a";

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
});

describe("findNextPendingToolCall", () => {
  const calls = [
    { id: "call-a", name: ToolName.ListFiles, arguments: "{}" },
    { id: "call-b", name: ToolName.ReadFile, arguments: '{"path":"src/App.tsx"}' },
  ];

  it("requires tool results in assistant call order", () => {
    const assistant = { role: "assistant", meta: { toolCalls: calls } };
    expect(findNextPendingToolCall([assistant]))?.toMatchObject({ id: "call-a" });
    expect(findNextPendingToolCall([
      assistant,
      { role: "tool", meta: { toolCallId: "call-a" } },
    ]))?.toMatchObject({ id: "call-b" });
    expect(findNextPendingToolCall([
      assistant,
      { role: "tool", meta: { toolCallId: "call-b" } },
    ]))?.toMatchObject({ id: "call-a" });
  });

  it("returns null after all calls close so duplicate or late results are rejected", () => {
    expect(findNextPendingToolCall([
      { role: "assistant", meta: { toolCalls: calls } },
      { role: "tool", meta: { toolCallId: "call-a" } },
      { role: "tool", meta: { toolCallId: "call-b" } },
    ])).toBeNull();
  });
});
