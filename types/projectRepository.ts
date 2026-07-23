import { z } from "zod";
import { ProjectFileOperation } from "./projectFileMutation";
import { ProjectRevisionSchema } from "./projectRevision";
import { ProjectStorageKind, type ProjectStorageKind as ProjectStorageKindValue } from "./projectStorage";

export const ProjectFileSummarySchema = z.object({
  path: z.string().min(1),
  updatedAt: z.string().datetime(),
}).strict();

export const ProjectFileContentSchema = ProjectFileSummarySchema.extend({
  content: z.string(),
}).strict();

export const ProjectTextSearchMatchSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  snippet: z.string(),
}).strict();

export const ProjectFilesSnapshotSchema = z.object({
  revision: ProjectRevisionSchema,
  files: z.array(ProjectFileSummarySchema),
}).strict();

export const ProjectWorkspaceSnapshotSchema = z.object({
  revision: ProjectRevisionSchema,
  files: z.array(ProjectFileContentSchema),
}).strict();

export const RevisionedProjectFileContentSchema = ProjectFileContentSchema.extend({
  revision: ProjectRevisionSchema,
}).strict();

export const RevisionedProjectFileSummarySchema = ProjectFileSummarySchema.extend({
  revision: ProjectRevisionSchema,
}).strict();

export const ProjectTextSearchResultSchema = z.object({
  revision: ProjectRevisionSchema,
  matches: z.array(ProjectTextSearchMatchSchema),
  truncated: z.boolean(),
}).strict();

export const DeleteProjectFileResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string().min(1),
  revision: ProjectRevisionSchema,
}).strict();

export type ProjectFileSummary = z.infer<typeof ProjectFileSummarySchema>;
export type ProjectFileContent = z.infer<typeof ProjectFileContentSchema>;
export type ProjectTextSearchMatch = z.infer<typeof ProjectTextSearchMatchSchema>;
export type ProjectTextSearchResult = z.infer<typeof ProjectTextSearchResultSchema>;
export type ProjectFilesSnapshot = z.infer<typeof ProjectFilesSnapshotSchema>;
export type ProjectWorkspaceSnapshot = z.infer<typeof ProjectWorkspaceSnapshotSchema>;
export type RevisionedProjectFileContent = z.infer<typeof RevisionedProjectFileContentSchema>;
export type RevisionedProjectFileSummary = z.infer<typeof RevisionedProjectFileSummarySchema>;

export type WriteProjectFileInput = {
  path: string;
  content: string;
  expectedRevision: number;
};

export type DeleteProjectFileInput = {
  path: string;
  expectedRevision: number;
};

export type RenameProjectFileInput = {
  oldPath: string;
  newPath: string;
  expectedRevision: number;
};

export type RepositoryWriteChange = {
  operation: typeof ProjectFileOperation.Write;
  path: string;
  revision: number;
  file: ProjectFileContent;
};

export type RepositoryDeleteChange = {
  operation: typeof ProjectFileOperation.Delete;
  path: string;
  revision: number;
};

export type RepositoryRenameChange = {
  operation: typeof ProjectFileOperation.Rename;
  oldPath: string;
  path: string;
  revision: number;
  file: ProjectFileSummary;
};

export type RepositoryChange =
  | RepositoryWriteChange
  | RepositoryDeleteChange
  | RepositoryRenameChange;

export type PreviewWorkspaceSnapshot = {
  revision: number;
  files: { path: string; content: string }[];
};

export interface ProjectRepository {
  readonly projectId: string;
  readonly storageKind: ProjectStorageKindValue;

  getRevision(): number;
  listFiles(): Promise<ProjectFilesSnapshot>;
  readWorkspace(): Promise<ProjectWorkspaceSnapshot>;
  readFile(path: string): Promise<RevisionedProjectFileContent>;
  searchText(query: string): Promise<ProjectTextSearchResult>;
  writeFile(input: WriteProjectFileInput): Promise<RepositoryWriteChange>;
  deleteFile(input: DeleteProjectFileInput): Promise<RepositoryDeleteChange>;
  renameFile(input: RenameProjectFileInput): Promise<RepositoryRenameChange>;
  exportPreviewFiles(): Promise<PreviewWorkspaceSnapshot>;
}

export const ProjectRepositoryDescriptorSchema = z.discriminatedUnion("storageKind", [
  z.object({
    projectId: z.string().uuid(),
    storageKind: z.literal(ProjectStorageKind.Database),
    revision: ProjectRevisionSchema,
  }).strict(),
  z.object({
    projectId: z.string().uuid(),
    storageKind: z.literal(ProjectStorageKind.BrowserGit),
    revision: ProjectRevisionSchema,
  }).strict(),
]);

export type ProjectRepositoryDescriptor = z.infer<typeof ProjectRepositoryDescriptorSchema>;

export type DatabaseProjectRepositoryTransport = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export const ProjectRepositoryErrorCode = {
  BadPath: "BAD_PATH",
  BadSearchQuery: "BAD_SEARCH_QUERY",
  BadGitRef: "BAD_GIT_REF",
  GitAuthorRequired: "GIT_AUTHOR_REQUIRED",
  BadCommitMessage: "BAD_COMMIT_MESSAGE",
  RepositoryNotInitialized: "REPOSITORY_NOT_INITIALIZED",
  NothingToCommit: "NOTHING_TO_COMMIT",
  LocalRepositoryMissing: "LOCAL_REPOSITORY_MISSING",
  ReservedPath: "RESERVED_PATH",
  NotFound: "NOT_FOUND",
  Conflict: "CONFLICT",
  RevisionConflict: "REVISION_CONFLICT",
  StaleSnapshot: "STALE_SNAPSHOT",
  ProtocolViolation: "PROTOCOL_VIOLATION",
  UnsupportedStorage: "UNSUPPORTED_STORAGE",
  WorkerDisposed: "WORKER_DISPOSED",
  InternalError: "INTERNAL_ERROR",
} as const;

export const ProjectRepositoryErrorCodeSchema = z.enum(ProjectRepositoryErrorCode);

export type ProjectRepositoryErrorCode =
  typeof ProjectRepositoryErrorCode[keyof typeof ProjectRepositoryErrorCode];

export class ProjectRepositoryError extends Error {
  readonly code: ProjectRepositoryErrorCode;

  constructor(code: ProjectRepositoryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProjectRepositoryError";
    this.code = code;
  }
}
