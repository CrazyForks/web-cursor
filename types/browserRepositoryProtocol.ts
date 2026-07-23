import { z } from "zod";
import { ProjectFileOperation } from "./projectFileMutation";
import {
  ProjectFilesSnapshotSchema,
  ProjectRepositoryErrorCode,
  ProjectTextSearchResultSchema,
  ProjectWorkspaceSnapshotSchema,
  RevisionedProjectFileContentSchema,
  RevisionedProjectFileSummarySchema,
} from "./projectRepository";
import { ProjectRevisionSchema } from "./projectRevision";
import {
  GitCommitInputSchema,
  GitCommitResultSchema,
  GitCurrentBranchResultSchema,
  GitInitInputSchema,
  GitInitResultSchema,
  GitLogInputSchema,
  GitLogResultSchema,
  GitStatusResultSchema,
} from "./browserGitRepository";
import {
  PrepareBrowserGitMigrationInputSchema,
  PreparedBrowserGitMigrationSchema,
} from "./projectMigration";

export const BrowserRepositoryCommandType = {
  Provision: "provision_repository",
  Open: "open_repository",
  PrepareMigration: "prepare_database_migration",
  ListFiles: "list_files",
  ReadWorkspace: "read_workspace",
  ReadFile: "read_file",
  SearchText: "search_text",
  WriteFile: "write_file",
  DeleteFile: "delete_file",
  RenameFile: "rename_file",
  GitInit: "git_init",
  GitStatus: "git_status",
  GitStage: "git_stage",
  GitUnstage: "git_unstage",
  GitCommit: "git_commit",
  GitLog: "git_log",
  GitCurrentBranch: "git_current_branch",
} as const;

const ProjectCommandBaseSchema = z.object({
  projectId: z.string().uuid(),
});

export const BrowserRepositoryCommandSchema = z.discriminatedUnion("type", [
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.Provision),
    initialRevision: z.literal(0),
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.Open),
    initialRevision: ProjectRevisionSchema,
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.PrepareMigration),
    ...PrepareBrowserGitMigrationInputSchema.shape,
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.ListFiles),
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.ReadWorkspace),
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.ReadFile),
    path: z.string().min(1),
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.SearchText),
    query: z.string(),
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.WriteFile),
    path: z.string().min(1),
    content: z.string(),
    expectedRevision: ProjectRevisionSchema,
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.DeleteFile),
    path: z.string().min(1),
    expectedRevision: ProjectRevisionSchema,
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.RenameFile),
    oldPath: z.string().min(1),
    newPath: z.string().min(1),
    expectedRevision: ProjectRevisionSchema,
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.GitInit),
    ...GitInitInputSchema.shape,
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.GitStatus),
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.GitStage),
    path: z.string().min(1),
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.GitUnstage),
    path: z.string().min(1),
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.GitCommit),
    ...GitCommitInputSchema.shape,
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.GitLog),
    ...GitLogInputSchema.shape,
  }).strict(),
  ProjectCommandBaseSchema.extend({
    type: z.literal(BrowserRepositoryCommandType.GitCurrentBranch),
  }).strict(),
]);

export type BrowserRepositoryCommand = z.infer<typeof BrowserRepositoryCommandSchema>;

export const BrowserRepositoryRequestSchema = z.object({
  id: z.string().uuid(),
  command: BrowserRepositoryCommandSchema,
}).strict();

export type BrowserRepositoryRequest = z.infer<typeof BrowserRepositoryRequestSchema>;

const RepositoryErrorCodeSchema = z.enum([
  ProjectRepositoryErrorCode.BadPath,
  ProjectRepositoryErrorCode.BadSearchQuery,
  ProjectRepositoryErrorCode.BadGitRef,
  ProjectRepositoryErrorCode.GitAuthorRequired,
  ProjectRepositoryErrorCode.BadCommitMessage,
  ProjectRepositoryErrorCode.RepositoryNotInitialized,
  ProjectRepositoryErrorCode.NothingToCommit,
  ProjectRepositoryErrorCode.LocalRepositoryMissing,
  ProjectRepositoryErrorCode.ReservedPath,
  ProjectRepositoryErrorCode.NotFound,
  ProjectRepositoryErrorCode.Conflict,
  ProjectRepositoryErrorCode.RevisionConflict,
  ProjectRepositoryErrorCode.StaleSnapshot,
  ProjectRepositoryErrorCode.ProtocolViolation,
  ProjectRepositoryErrorCode.UnsupportedStorage,
  ProjectRepositoryErrorCode.WorkerDisposed,
  ProjectRepositoryErrorCode.InternalError,
]);

export const BrowserRepositoryResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string().uuid(),
    ok: z.literal(true),
    result: z.unknown(),
  }).strict(),
  z.object({
    id: z.string().uuid(),
    ok: z.literal(false),
    error: z.object({
      code: RepositoryErrorCodeSchema,
      message: z.string().min(1),
    }).strict(),
  }).strict(),
]);

export type BrowserRepositoryResponse = z.infer<typeof BrowserRepositoryResponseSchema>;

export const OpenBrowserRepositoryResultSchema = z.object({
  revision: ProjectRevisionSchema,
}).strict();

export const BrowserWriteResultSchema = z.object({
  operation: z.literal(ProjectFileOperation.Write),
  path: z.string().min(1),
  revision: ProjectRevisionSchema,
  file: RevisionedProjectFileContentSchema.omit({ revision: true }),
}).strict();

export const BrowserDeleteResultSchema = z.object({
  operation: z.literal(ProjectFileOperation.Delete),
  path: z.string().min(1),
  revision: ProjectRevisionSchema,
}).strict();

export const BrowserRenameResultSchema = z.object({
  operation: z.literal(ProjectFileOperation.Rename),
  oldPath: z.string().min(1),
  path: z.string().min(1),
  revision: ProjectRevisionSchema,
  file: RevisionedProjectFileSummarySchema.omit({ revision: true }),
}).strict();

export const BrowserRepositoryResultSchema = {
  [BrowserRepositoryCommandType.Provision]: OpenBrowserRepositoryResultSchema,
  [BrowserRepositoryCommandType.Open]: OpenBrowserRepositoryResultSchema,
  [BrowserRepositoryCommandType.PrepareMigration]: PreparedBrowserGitMigrationSchema,
  [BrowserRepositoryCommandType.ListFiles]: ProjectFilesSnapshotSchema,
  [BrowserRepositoryCommandType.ReadWorkspace]: ProjectWorkspaceSnapshotSchema,
  [BrowserRepositoryCommandType.ReadFile]: RevisionedProjectFileContentSchema,
  [BrowserRepositoryCommandType.SearchText]: ProjectTextSearchResultSchema,
  [BrowserRepositoryCommandType.WriteFile]: BrowserWriteResultSchema,
  [BrowserRepositoryCommandType.DeleteFile]: BrowserDeleteResultSchema,
  [BrowserRepositoryCommandType.RenameFile]: BrowserRenameResultSchema,
  [BrowserRepositoryCommandType.GitInit]: GitInitResultSchema,
  [BrowserRepositoryCommandType.GitStatus]: GitStatusResultSchema,
  [BrowserRepositoryCommandType.GitStage]: GitStatusResultSchema,
  [BrowserRepositoryCommandType.GitUnstage]: GitStatusResultSchema,
  [BrowserRepositoryCommandType.GitCommit]: GitCommitResultSchema,
  [BrowserRepositoryCommandType.GitLog]: GitLogResultSchema,
  [BrowserRepositoryCommandType.GitCurrentBranch]: GitCurrentBranchResultSchema,
} as const;
