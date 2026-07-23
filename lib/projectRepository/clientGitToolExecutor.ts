/**
 * [INPUT]: active BrowserGitProjectRepository + validated browser Git tool call
 * [OUTPUT]: strict ClientGitToolResult from the canonical Browser Git repository
 * [POS]: B 域 Agent Git 工具适配器 —— 不经过 Terminal，不直接访问 Worker/IndexedDB
 * [PROTOCOL]: 参数必须通过权威 schema；author 缺失直接报错，不推断身份；repository error 原样暴露。
 */
import { z } from "zod";
import type {
  ClientGitToolCall,
  ClientGitToolResult,
} from "../../types/clientTool";
import { ClientToolErrorCode } from "../../types/clientTool";
import {
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
} from "../../types/projectRepository";
import type {
  BrowserGitProjectRepository,
  GitStatusResult,
} from "../../types/browserGitRepository";
import { ToolName } from "../../types/tool";
import {
  GitCommitArgsSchema,
  GitCurrentBranchArgsSchema,
  GitLogArgsSchema,
  GitStageArgsSchema,
  GitStatusArgsSchema,
  GitUnstageArgsSchema,
} from "../../types/toolSchema";

function parseArgs(raw: string): unknown {
  return raw.trim() ? JSON.parse(raw) : {};
}

function errorResult(
  tool: ClientGitToolCall["name"],
  code: typeof ClientToolErrorCode.BadArgs | ProjectRepositoryErrorCode,
  message: string,
): ClientGitToolResult {
  return { status: "error", tool, code, message } as ClientGitToolResult;
}

function changedFiles(status: GitStatusResult): GitStatusResult {
  return {
    files: status.files.filter((file) =>
      file.head !== file.stage || file.workdir !== file.stage
    ),
  };
}

export async function executeClientGitTool(
  repository: BrowserGitProjectRepository,
  call: ClientGitToolCall,
): Promise<ClientGitToolResult> {
  try {
    switch (call.name) {
      case ToolName.GitStatus: {
        GitStatusArgsSchema.parse(parseArgs(call.arguments));
        return {
          status: "ok",
          tool: call.name,
          ...changedFiles(await repository.gitStatus()),
        };
      }
      case ToolName.GitStage: {
        const args = GitStageArgsSchema.parse(parseArgs(call.arguments));
        return {
          status: "ok",
          tool: call.name,
          ...changedFiles(await repository.stageFile(args.path)),
        };
      }
      case ToolName.GitUnstage: {
        const args = GitUnstageArgsSchema.parse(parseArgs(call.arguments));
        return {
          status: "ok",
          tool: call.name,
          ...changedFiles(await repository.unstageFile(args.path)),
        };
      }
      case ToolName.GitCommit: {
        const args = GitCommitArgsSchema.parse(parseArgs(call.arguments));
        return { status: "ok", tool: call.name, ...await repository.commit(args) };
      }
      case ToolName.GitLog: {
        const args = GitLogArgsSchema.parse(parseArgs(call.arguments));
        return { status: "ok", tool: call.name, ...await repository.gitLog(args) };
      }
      case ToolName.GitCurrentBranch: {
        GitCurrentBranchArgsSchema.parse(parseArgs(call.arguments));
        return { status: "ok", tool: call.name, ...await repository.currentBranch() };
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
