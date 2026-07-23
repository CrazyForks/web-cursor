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
  ProjectRepositoryErrorCodeSchema,
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

const ClientToolErrorCodeSchema = z.union([
  z.literal(ClientToolErrorCode.BadArgs),
  ProjectRepositoryErrorCodeSchema,
]);

type ClientRepositoryToolName = ClientFileToolName | ClientGitToolName;

function errorResultSchema<TTool extends ClientRepositoryToolName>(tool: TTool) {
  return z.object({
    status: z.literal("error"),
    tool: z.literal(tool),
    code: ClientToolErrorCodeSchema,
    message: z.string().min(1),
  }).strict();
}

const ListFilesResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.ListFiles),
    revision: ProjectRevisionSchema,
    files: z.array(ProjectFileSummarySchema),
  }).strict(),
  errorResultSchema(ToolName.ListFiles),
]);

const SearchTextResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.SearchText),
    revision: ProjectRevisionSchema,
    query: z.string(),
    matches: z.array(ProjectTextSearchMatchSchema),
    truncated: z.boolean(),
  }).strict(),
  errorResultSchema(ToolName.SearchText),
]);

const ReadFileResultSchema = z.union([
  ProjectFileContentSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.ReadFile),
    revision: ProjectRevisionSchema,
  }).strict(),
  errorResultSchema(ToolName.ReadFile),
]);

const WriteFileResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.WriteFile),
    revision: ProjectRevisionSchema,
    path: z.string().min(1),
    updatedAt: z.string().datetime(),
  }).strict(),
  errorResultSchema(ToolName.WriteFile),
]);

const DeleteFileResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.DeleteFile),
    revision: ProjectRevisionSchema,
    path: z.string().min(1),
  }).strict(),
  errorResultSchema(ToolName.DeleteFile),
]);

const RenameFileResultSchema = z.union([
  z.object({
    status: z.literal("ok"),
    tool: z.literal(ToolName.RenameFile),
    revision: ProjectRevisionSchema,
    oldPath: z.string().min(1),
    newPath: z.string().min(1),
    updatedAt: z.string().datetime(),
  }).strict(),
  errorResultSchema(ToolName.RenameFile),
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

const GitStatusToolResultSchema = z.union([
  GitStatusResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitStatus),
  }).strict(),
  errorResultSchema(ToolName.GitStatus),
]);

const GitStageResultSchema = z.union([
  GitStatusResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitStage),
  }).strict(),
  errorResultSchema(ToolName.GitStage),
]);

const GitUnstageResultSchema = z.union([
  GitStatusResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitUnstage),
  }).strict(),
  errorResultSchema(ToolName.GitUnstage),
]);

const GitCommitToolResultSchema = z.union([
  GitCommitResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitCommit),
  }).strict(),
  errorResultSchema(ToolName.GitCommit),
]);

const GitLogToolResultSchema = z.union([
  GitLogResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitLog),
  }).strict(),
  errorResultSchema(ToolName.GitLog),
]);

const GitCurrentBranchToolResultSchema = z.union([
  GitCurrentBranchResultSchema.extend({
    status: z.literal("ok"),
    tool: z.literal(ToolName.GitCurrentBranch),
  }).strict(),
  errorResultSchema(ToolName.GitCurrentBranch),
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
