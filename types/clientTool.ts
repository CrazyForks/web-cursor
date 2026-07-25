import { z } from "zod";
import {
  GitCommitResultSchema,
  GitCurrentBranchResultSchema,
  GitLogResultSchema,
  GitStatusResultSchema,
} from "./browserGitRepository";
import {
  ProjectFileContentSchema,
  ProjectFileSummarySchema,
  ProjectRepositoryErrorCode,
  ProjectTextSearchMatchSchema,
} from "./projectRepository";
import { ProjectRevisionSchema } from "./projectRevision";
import { ProjectStorageKind, type ProjectStorageKind as ProjectStorageKindValue } from "./projectStorage";
import { ToolName } from "./tool";
import { ToolResultSchema } from "./toolSchema";

export const ClientFileToolName = {
  ListFiles: ToolName.ListFiles,
  SearchText: ToolName.SearchText,
  ReadFile: ToolName.ReadFile,
  WriteFile: ToolName.WriteFile,
  DeleteFile: ToolName.DeleteFile,
  RenameFile: ToolName.RenameFile,
} as const;

export type ClientFileToolName =
  typeof ClientFileToolName[keyof typeof ClientFileToolName];

export const ClientGitToolName = {
  GitStatus: ToolName.GitStatus,
  GitStage: ToolName.GitStage,
  GitUnstage: ToolName.GitUnstage,
  GitCommit: ToolName.GitCommit,
  GitLog: ToolName.GitLog,
  GitCurrentBranch: ToolName.GitCurrentBranch,
} as const;

export type ClientGitToolName =
  typeof ClientGitToolName[keyof typeof ClientGitToolName];

export const ClientFileToolNameSchema = z.enum(ClientFileToolName);
export const ClientGitToolNameSchema = z.enum(ClientGitToolName);
export const ClientToolNameSchema = z.union([
  ClientFileToolNameSchema,
  ClientGitToolNameSchema,
  z.literal(ToolName.RunPreview),
]);

export const ClientToolCallSchema = z.object({
  id: z.string().min(1),
  name: ClientToolNameSchema,
  arguments: z.string(),
}).strict();

export type ClientToolCall = z.infer<typeof ClientToolCallSchema>;

export const ClientFileToolCallSchema = z.object({
  id: z.string().min(1),
  name: ClientFileToolNameSchema,
  arguments: z.string(),
}).strict();

export type ClientFileToolCall = z.infer<typeof ClientFileToolCallSchema>;

export const ClientGitToolCallSchema = z.object({
  id: z.string().min(1),
  name: ClientGitToolNameSchema,
  arguments: z.string(),
}).strict();

export type ClientGitToolCall = z.infer<typeof ClientGitToolCallSchema>;

export const ClientToolErrorCode = {
  BadArgs: "BAD_ARGS",
} as const;

export const ClientToolErrorCodeSchema = z.literal(
  ClientToolErrorCode.BadArgs,
);

type ClientRepositoryToolName = ClientFileToolName | ClientGitToolName;

const BrowserRepositoryCommonErrorCode = {
  BadArgs: ClientToolErrorCode.BadArgs,
  LocalRepositoryMissing: ProjectRepositoryErrorCode.LocalRepositoryMissing,
  StaleSnapshot: ProjectRepositoryErrorCode.StaleSnapshot,
  ProtocolViolation: ProjectRepositoryErrorCode.ProtocolViolation,
  WorkerDisposed: ProjectRepositoryErrorCode.WorkerDisposed,
  InternalError: ProjectRepositoryErrorCode.InternalError,
} as const;

const BrowserFilePathErrorCode = {
  BadPath: ProjectRepositoryErrorCode.BadPath,
  ReservedPath: ProjectRepositoryErrorCode.ReservedPath,
} as const;

export const ClientListFilesErrorCode = {
  ...BrowserRepositoryCommonErrorCode,
} as const;

export const ClientSearchTextErrorCode = {
  ...BrowserRepositoryCommonErrorCode,
} as const;

export const ClientReadFileErrorCode = {
  ...BrowserRepositoryCommonErrorCode,
  ...BrowserFilePathErrorCode,
  NotFound: ProjectRepositoryErrorCode.NotFound,
} as const;

export const ClientWriteFileErrorCode = {
  ...BrowserRepositoryCommonErrorCode,
  ...BrowserFilePathErrorCode,
  Conflict: ProjectRepositoryErrorCode.Conflict,
  RevisionConflict: ProjectRepositoryErrorCode.RevisionConflict,
} as const;

export const ClientDeleteFileErrorCode = {
  ...BrowserRepositoryCommonErrorCode,
  ...BrowserFilePathErrorCode,
  NotFound: ProjectRepositoryErrorCode.NotFound,
  RevisionConflict: ProjectRepositoryErrorCode.RevisionConflict,
} as const;

export const ClientRenameFileErrorCode = {
  ...BrowserRepositoryCommonErrorCode,
  ...BrowserFilePathErrorCode,
  NotFound: ProjectRepositoryErrorCode.NotFound,
  Conflict: ProjectRepositoryErrorCode.Conflict,
  RevisionConflict: ProjectRepositoryErrorCode.RevisionConflict,
} as const;

const BrowserGitCommonErrorCode = {
  ...BrowserRepositoryCommonErrorCode,
  RepositoryNotInitialized:
    ProjectRepositoryErrorCode.RepositoryNotInitialized,
} as const;

export const ClientGitStatusErrorCode = {
  ...BrowserGitCommonErrorCode,
} as const;

export const ClientGitStageErrorCode = {
  ...BrowserGitCommonErrorCode,
  ...BrowserFilePathErrorCode,
  NotFound: ProjectRepositoryErrorCode.NotFound,
} as const;

export const ClientGitUnstageErrorCode = {
  ...ClientGitStageErrorCode,
} as const;

export const ClientGitCommitErrorCode = {
  ...BrowserGitCommonErrorCode,
  NothingToCommit: ProjectRepositoryErrorCode.NothingToCommit,
} as const;

export const ClientGitLogErrorCode = {
  ...BrowserGitCommonErrorCode,
} as const;

export const ClientGitCurrentBranchErrorCode = {
  ...BrowserGitCommonErrorCode,
} as const;

function errorResultSchema<TTool extends ClientRepositoryToolName>(
  tool: TTool,
  codeSchema: z.ZodType,
) {
  return z.object({
    status: z.literal("error"),
    tool: z.literal(tool),
    code: codeSchema,
    message: z.string().min(1),
  }).strict();
}

export const ListFilesResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.ListFiles),
    revision: ProjectRevisionSchema,
    files: z.array(ProjectFileSummarySchema),
  }).strict(),
  errorResultSchema(
    ToolName.ListFiles,
    z.enum(ClientListFilesErrorCode),
  ),
]);

export const SearchTextResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.SearchText),
    revision: ProjectRevisionSchema,
    query: z.string(),
    matches: z.array(ProjectTextSearchMatchSchema),
    truncated: z.boolean(),
  }).strict(),
  errorResultSchema(
    ToolName.SearchText,
    z.enum(ClientSearchTextErrorCode),
  ),
]);

export const ReadFileResultSchema = z.union([
  ProjectFileContentSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.ReadFile),
    revision: ProjectRevisionSchema,
  }).strict(),
  errorResultSchema(
    ToolName.ReadFile,
    z.enum(ClientReadFileErrorCode),
  ),
]);

export const WriteFileResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.WriteFile),
    revision: ProjectRevisionSchema,
    path: z.string().min(1),
    updatedAt: z.string().datetime(),
  }).strict(),
  errorResultSchema(
    ToolName.WriteFile,
    z.enum(ClientWriteFileErrorCode),
  ),
]);

export const DeleteFileResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.DeleteFile),
    revision: ProjectRevisionSchema,
    path: z.string().min(1),
  }).strict(),
  errorResultSchema(
    ToolName.DeleteFile,
    z.enum(ClientDeleteFileErrorCode),
  ),
]);

export const RenameFileResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.RenameFile),
    revision: ProjectRevisionSchema,
    oldPath: z.string().min(1),
    newPath: z.string().min(1),
    updatedAt: z.string().datetime(),
  }).strict(),
  errorResultSchema(
    ToolName.RenameFile,
    z.enum(ClientRenameFileErrorCode),
  ),
]);

export const ClientFileToolResultSchema = z.union([
  ListFilesResultSchema,
  SearchTextResultSchema,
  ReadFileResultSchema,
  WriteFileResultSchema,
  DeleteFileResultSchema,
  RenameFileResultSchema,
]);

export type ClientFileToolResult = z.infer<typeof ClientFileToolResultSchema>;

export const GitStatusToolResultSchema = z.union([
  GitStatusResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitStatus),
  }).strict(),
  errorResultSchema(
    ToolName.GitStatus,
    z.enum(ClientGitStatusErrorCode),
  ),
]);

export const GitStageResultSchema = z.union([
  GitStatusResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitStage),
  }).strict(),
  errorResultSchema(
    ToolName.GitStage,
    z.enum(ClientGitStageErrorCode),
  ),
]);

export const GitUnstageResultSchema = z.union([
  GitStatusResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitUnstage),
  }).strict(),
  errorResultSchema(
    ToolName.GitUnstage,
    z.enum(ClientGitUnstageErrorCode),
  ),
]);

export const GitCommitToolResultSchema = z.union([
  GitCommitResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitCommit),
  }).strict(),
  errorResultSchema(
    ToolName.GitCommit,
    z.enum(ClientGitCommitErrorCode),
  ),
]);

export const GitLogToolResultSchema = z.union([
  GitLogResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitLog),
  }).strict(),
  errorResultSchema(
    ToolName.GitLog,
    z.enum(ClientGitLogErrorCode),
  ),
]);

export const GitCurrentBranchToolResultSchema = z.union([
  GitCurrentBranchResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitCurrentBranch),
  }).strict(),
  errorResultSchema(
    ToolName.GitCurrentBranch,
    z.enum(ClientGitCurrentBranchErrorCode),
  ),
]);

export const ClientGitToolResultSchema = z.union([
  GitStatusToolResultSchema,
  GitStageResultSchema,
  GitUnstageResultSchema,
  GitCommitToolResultSchema,
  GitLogToolResultSchema,
  GitCurrentBranchToolResultSchema,
]);

export type ClientGitToolResult = z.infer<typeof ClientGitToolResultSchema>;

const SubmissionBaseShape = {
  projectId: z.string().uuid(),
  toolCallId: z.string().min(1),
};

function submissionSchema<TTool extends ClientRepositoryToolName>(
  tool: TTool,
  result: z.ZodType,
) {
  return z.object({
    ...SubmissionBaseShape,
    tool: z.literal(tool),
    result,
  }).strict();
}

export const ClientToolResultSubmissionSchema = z.union([
  submissionSchema(ToolName.ListFiles, ListFilesResultSchema),
  submissionSchema(ToolName.SearchText, SearchTextResultSchema),
  submissionSchema(ToolName.ReadFile, ReadFileResultSchema),
  submissionSchema(ToolName.WriteFile, WriteFileResultSchema),
  submissionSchema(ToolName.DeleteFile, DeleteFileResultSchema),
  submissionSchema(ToolName.RenameFile, RenameFileResultSchema),
  submissionSchema(ToolName.GitStatus, GitStatusToolResultSchema),
  submissionSchema(ToolName.GitStage, GitStageResultSchema),
  submissionSchema(ToolName.GitUnstage, GitUnstageResultSchema),
  submissionSchema(ToolName.GitCommit, GitCommitToolResultSchema),
  submissionSchema(ToolName.GitLog, GitLogToolResultSchema),
  submissionSchema(ToolName.GitCurrentBranch, GitCurrentBranchToolResultSchema),
  z.object({
    ...SubmissionBaseShape,
    tool: z.literal(ToolName.RunPreview),
    result: ToolResultSchema,
  }).strict(),
]);

export type ClientToolResultSubmission = z.infer<typeof ClientToolResultSubmissionSchema>;

export function isClientFileToolName(name: string): name is ClientFileToolName {
  return ClientFileToolNameSchema.safeParse(name).success;
}

export function isClientGitToolName(name: string): name is ClientGitToolName {
  return ClientGitToolNameSchema.safeParse(name).success;
}

export function clientToolRunsInBrowser(name: string, storageKind: ProjectStorageKindValue): boolean {
  if (name === ToolName.RunPreview) return true;
  if (!isClientFileToolName(name) && !isClientGitToolName(name)) return false;
  return storageKind === ProjectStorageKind.BrowserGit;
}
