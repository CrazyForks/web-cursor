/**
 * [INPUT]: active ProjectRepository + validated browser file tool call
 * [OUTPUT]: strict ClientFileToolResult，包含 repository 返回的真实 revision/change
 * [POS]: B 域 Agent 文件工具适配器 —— 只把 tool args 映射到当前 repository，不直接访问存储
 * [PROTOCOL]: 参数不合法返回 BAD_ARGS；repository error 原样暴露 code；未知异常返回 INTERNAL_ERROR。
 */
import { z } from "zod";
import type { ClientFileToolCall, ClientFileToolResult } from "../../types/clientTool";
import { ClientToolErrorCode } from "../../types/clientTool";
import {
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
  type ProjectRepository,
} from "../../types/projectRepository";
import { ToolName } from "../../types/tool";
import {
  DeleteFileArgsSchema,
  ListFilesArgsSchema,
  ReadFileArgsSchema,
  RenameFileArgsSchema,
  SearchTextArgsSchema,
  WriteFileArgsSchema,
} from "../../types/toolSchema";

function parseArgs(raw: string): unknown {
  return raw.trim() ? JSON.parse(raw) : {};
}

function errorResult(
  tool: ClientFileToolCall["name"],
  code: typeof ClientToolErrorCode.BadArgs | ProjectRepositoryErrorCode,
  message: string,
): ClientFileToolResult {
  return { status: "error", tool, code, message } as ClientFileToolResult;
}

export async function executeClientFileTool(
  repository: ProjectRepository,
  call: ClientFileToolCall,
): Promise<ClientFileToolResult> {
  try {
    switch (call.name) {
      case ToolName.ListFiles: {
        ListFilesArgsSchema.parse(parseArgs(call.arguments));
        const snapshot = await repository.listFiles();
        return { status: "ok", tool: call.name, ...snapshot };
      }
      case ToolName.SearchText: {
        const args = SearchTextArgsSchema.parse(parseArgs(call.arguments));
        const result = await repository.searchText(args.query);
        return { status: "ok", tool: call.name, query: args.query, ...result };
      }
      case ToolName.ReadFile: {
        const args = ReadFileArgsSchema.parse(parseArgs(call.arguments));
        const result = await repository.readFile(args.path);
        return { status: "ok", tool: call.name, ...result };
      }
      case ToolName.WriteFile: {
        const args = WriteFileArgsSchema.parse(parseArgs(call.arguments));
        const result = await repository.writeFile(args);
        return {
          status: "ok",
          tool: call.name,
          revision: result.revision,
          path: result.path,
          updatedAt: result.file.updatedAt,
        };
      }
      case ToolName.DeleteFile: {
        const args = DeleteFileArgsSchema.parse(parseArgs(call.arguments));
        const result = await repository.deleteFile(args);
        return { status: "ok", tool: call.name, revision: result.revision, path: result.path };
      }
      case ToolName.RenameFile: {
        const args = RenameFileArgsSchema.parse(parseArgs(call.arguments));
        const result = await repository.renameFile(args);
        return {
          status: "ok",
          tool: call.name,
          revision: result.revision,
          oldPath: result.oldPath,
          newPath: result.path,
          updatedAt: result.file.updatedAt,
        };
      }
    }
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return errorResult(call.name, ClientToolErrorCode.BadArgs, error.message);
    }
    if (error instanceof ProjectRepositoryError) {
      return errorResult(call.name, error.code, error.message);
    }
    return errorResult(
      call.name,
      ProjectRepositoryErrorCode.InternalError,
      error instanceof Error ? error.message : String(error),
    );
  }
}
