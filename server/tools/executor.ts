/**
 * [INPUT]: LLM tool_call metadata + ToolExecutionContext
 * [OUTPUT]: structured tool execution result for role=tool messages
 * [POS]: A 域工具执行层 —— 把 LLM 工具调用分发到 server/files.ts
 * [PROTOCOL]: LLM 不传 projectId/ownerId；当前项目由 ToolExecutionContext 绑定
 */
import "server-only";
import { z } from "zod";
import { inspectAttachment, AttachmentError, AttachmentErrorCode } from "@/server/attachments";
import { inspectFigmaDesign } from "@/server/figma/inspect";
import { FigmaErrorCode, FigmaInspectError, type FigmaDesignContext } from "@/server/figma/types";
import { createPendingImageRun, pendingImageRunResult } from "@/server/image/jobs";
import {
  deleteProjectFile,
  FileOperationError,
  FileOperationErrorCode,
  listProjectFilesSnapshot,
  readProjectFile,
  renameProjectFile,
  searchProjectFiles,
  type ProjectTextSearchResult,
  writeProjectFile,
} from "@/server/files";
import {
  DeleteFileArgsSchema,
  GenerateImageArgsSchema,
  GitCommitArgsSchema,
  GitCurrentBranchArgsSchema,
  GitLogArgsSchema,
  GitStageArgsSchema,
  GitStatusArgsSchema,
  GitUnstageArgsSchema,
  InspectAttachmentArgsSchema,
  InspectFigmaDesignArgsSchema,
  ListFilesArgsSchema,
  ReadFileArgsSchema,
  RenameFileArgsSchema,
  RunPreviewArgsSchema,
  SearchTextArgsSchema,
  WriteFileArgsSchema,
} from "@/types/toolSchema";
import { ToolName, type ToolCallMeta, type ToolName as ToolNameType } from "@/types/tool";

export type ToolExecutionContext = {
  ownerId: string;
  projectId: string;
  conversationId: string;
};

export const ToolExecutionErrorCode = {
  BadArgs: "BAD_ARGS",
  BadPath: FileOperationErrorCode.BadPath,
  BadRevision: FileOperationErrorCode.BadRevision,
  BadSearchQuery: FileOperationErrorCode.BadSearchQuery,
  NotFound: FileOperationErrorCode.NotFound,
  Conflict: FileOperationErrorCode.Conflict,
  RevisionConflict: FileOperationErrorCode.RevisionConflict,
  StorageMismatch: FileOperationErrorCode.StorageMismatch,
  Unsupported: AttachmentErrorCode.Unsupported,
  InternalError: FileOperationErrorCode.InternalError,
  FigmaNotConnected: FigmaErrorCode.NotConnected,
  FigmaInvalidUrl: FigmaErrorCode.InvalidUrl,
  FigmaNodeRequired: FigmaErrorCode.NodeRequired,
  FigmaUnauthorized: FigmaErrorCode.Unauthorized,
  FigmaForbidden: FigmaErrorCode.Forbidden,
  FigmaNotFound: FigmaErrorCode.NotFound,
  FigmaUnsupportedNode: FigmaErrorCode.UnsupportedNode,
  FigmaProviderUnavailable: FigmaErrorCode.ProviderUnavailable,
  FigmaRateLimited: FigmaErrorCode.RateLimited,
  FigmaAssetExportFailed: FigmaErrorCode.AssetExportFailed,
} as const;

export type ToolExecutionErrorCode =
  typeof ToolExecutionErrorCode[keyof typeof ToolExecutionErrorCode];

export type ToolExecutionResult =
  | { status: "ok"; tool: typeof ToolName.ListFiles; revision: number; files: { path: string; updatedAt?: string }[] }
  | ({ status: "ok"; tool: typeof ToolName.SearchText; query: string } & ProjectTextSearchResult)
  | { status: "ok"; tool: typeof ToolName.ReadFile; revision: number; path: string; content: string; updatedAt?: string }
  | { status: "ok"; tool: typeof ToolName.WriteFile; revision: number; path: string; updatedAt?: string }
  | { status: "ok"; tool: typeof ToolName.DeleteFile; revision: number; path: string }
  | { status: "ok"; tool: typeof ToolName.RenameFile; revision: number; oldPath: string; newPath: string; updatedAt?: string }
  | {
      status: "ok";
      tool: typeof ToolName.InspectAttachment;
      attachmentId: string;
      attachmentType: "image";
      mimeType: string;
      observations: string;
    }
  | FigmaDesignContext
  | ReturnType<typeof pendingImageRunResult>
  | {
      status: "error";
      tool: string;
      message: string;
      code: ToolExecutionErrorCode;
    };

function parseArgs(raw: string | undefined): unknown {
  if (!raw?.trim()) return {};
  return JSON.parse(raw);
}

function isKnownTool(name: string): name is ToolNameType {
  return Object.values(ToolName).includes(name as ToolNameType);
}

function errorResult(tool: string, code: Extract<ToolExecutionResult, { status: "error" }>["code"], message: string): ToolExecutionResult {
  return { status: "error", tool, code, message };
}

export async function executeToolCall(
  toolCall: ToolCallMeta,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const tool = toolCall.name;
  if (!isKnownTool(tool)) return errorResult(tool, ToolExecutionErrorCode.BadArgs, `Unknown tool: ${tool}`);

  try {
    switch (tool) {
      case ToolName.ListFiles: {
        ListFilesArgsSchema.parse(parseArgs(toolCall.arguments));
        const snapshot = await listProjectFilesSnapshot(ctx.projectId);
        return { status: "ok", tool, ...snapshot };
      }
      case ToolName.SearchText: {
        const args = SearchTextArgsSchema.parse(parseArgs(toolCall.arguments));
        const result = await searchProjectFiles(ctx.projectId, args.query);
        return { status: "ok", tool, query: args.query, ...result };
      }
      case ToolName.ReadFile: {
        const args = ReadFileArgsSchema.parse(parseArgs(toolCall.arguments));
        const file = await readProjectFile(ctx.projectId, args.path);
        return { status: "ok", tool, ...file };
      }
      case ToolName.WriteFile: {
        const args = WriteFileArgsSchema.parse(parseArgs(toolCall.arguments));
        const file = await writeProjectFile(
          ctx.projectId,
          args.path,
          args.content,
          args.expectedRevision,
        );
        return { status: "ok", tool, path: file.path, updatedAt: file.updatedAt, revision: file.revision };
      }
      case ToolName.DeleteFile: {
        const args = DeleteFileArgsSchema.parse(parseArgs(toolCall.arguments));
        const result = await deleteProjectFile(ctx.projectId, args.path, args.expectedRevision);
        return { status: "ok", tool, path: args.path, revision: result.revision };
      }
      case ToolName.RenameFile: {
        const args = RenameFileArgsSchema.parse(parseArgs(toolCall.arguments));
        const file = await renameProjectFile(
          ctx.projectId,
          args.oldPath,
          args.newPath,
          args.expectedRevision,
        );
        return {
          status: "ok",
          tool,
          oldPath: args.oldPath,
          newPath: file.path,
          updatedAt: file.updatedAt,
          revision: file.revision,
        };
      }
      case ToolName.GitStatus: {
        GitStatusArgsSchema.parse(parseArgs(toolCall.arguments));
        return errorResult(tool, ToolExecutionErrorCode.Unsupported, "git_status must be executed by a Browser Git client.");
      }
      case ToolName.GitStage: {
        GitStageArgsSchema.parse(parseArgs(toolCall.arguments));
        return errorResult(tool, ToolExecutionErrorCode.Unsupported, "git_stage must be executed by a Browser Git client.");
      }
      case ToolName.GitUnstage: {
        GitUnstageArgsSchema.parse(parseArgs(toolCall.arguments));
        return errorResult(tool, ToolExecutionErrorCode.Unsupported, "git_unstage must be executed by a Browser Git client.");
      }
      case ToolName.GitCommit: {
        GitCommitArgsSchema.parse(parseArgs(toolCall.arguments));
        return errorResult(tool, ToolExecutionErrorCode.Unsupported, "git_commit must be executed by a Browser Git client.");
      }
      case ToolName.GitLog: {
        GitLogArgsSchema.parse(parseArgs(toolCall.arguments));
        return errorResult(tool, ToolExecutionErrorCode.Unsupported, "git_log must be executed by a Browser Git client.");
      }
      case ToolName.GitCurrentBranch: {
        GitCurrentBranchArgsSchema.parse(parseArgs(toolCall.arguments));
        return errorResult(tool, ToolExecutionErrorCode.Unsupported, "git_current_branch must be executed by a Browser Git client.");
      }
      case ToolName.RunPreview: {
        RunPreviewArgsSchema.parse(parseArgs(toolCall.arguments));
        return errorResult(tool, ToolExecutionErrorCode.Unsupported, "run_preview must be executed by the browser client.");
      }
      case ToolName.InspectAttachment: {
        const args = InspectAttachmentArgsSchema.parse(parseArgs(toolCall.arguments));
        const result = await inspectAttachment({
          ownerId: ctx.ownerId,
          conversationId: ctx.conversationId,
          attachmentId: args.attachmentId,
        });
        return { status: "ok", tool, ...result };
      }
      case ToolName.InspectFigmaDesign: {
        const args = InspectFigmaDesignArgsSchema.parse(parseArgs(toolCall.arguments));
        return inspectFigmaDesign({
          ownerId: ctx.ownerId,
          figmaUrl: args.figmaUrl,
          maxDepth: args.maxDepth,
          includeAssets: args.includeAssets,
        });
      }
      case ToolName.GenerateImage: {
        const args = GenerateImageArgsSchema.parse(parseArgs(toolCall.arguments));
        const run = await createPendingImageRun({
          ownerId: ctx.ownerId,
          projectId: ctx.projectId,
          conversationId: ctx.conversationId,
          toolCallId: toolCall.id,
          input: args,
        });
        return pendingImageRunResult(run);
      }
    }
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return errorResult(tool, ToolExecutionErrorCode.BadArgs, error instanceof Error ? error.message : String(error));
    }
    if (error instanceof FileOperationError) {
      return errorResult(tool, error.code, error.message);
    }
    if (error instanceof AttachmentError) {
      return errorResult(
        tool,
        error.code === AttachmentErrorCode.Unsupported ? ToolExecutionErrorCode.Unsupported : ToolExecutionErrorCode.InternalError,
        error.message,
      );
    }
    if (error instanceof FigmaInspectError) {
      return errorResult(tool, error.code, error.message);
    }
    return errorResult(tool, ToolExecutionErrorCode.InternalError, error instanceof Error ? error.message : String(error));
  }
}
