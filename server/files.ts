/**
 * [INPUT]: projectId + project-local file path/content/expectedRevision，或受限的单行字面量 search query
 * [OUTPUT]: 带 project revision 的 file snapshot/mutation result，或带 1-based 行列的受限文本搜索结果
 * [POS]: A 域项目文件业务层 —— project_files 的唯一读写入口
 * [PROTOCOL]: 文件 path/search/revision 只在这里做业务规则校验；Database mutation 必须 CAS + transaction
 */
import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { projectFiles, projects } from "@/server/db/schema";
import { executeRevisionedMutation } from "@/server/projectRevisionTransaction";
import { ProjectRevisionSchema } from "@/types/projectRevision";
import type {
  ProjectFileContent,
  ProjectFileSummary,
  ProjectFilesSnapshot,
  ProjectTextSearchMatch,
  ProjectTextSearchResult,
  ProjectWorkspaceSnapshot,
  RevisionedProjectFileContent,
  RevisionedProjectFileSummary,
} from "@/types/projectRepository";
import { ProjectStorageKind } from "@/types/projectStorage";
import { containsUnicodeLineTerminator, countUnicodeCodePoints, SearchTextLimits } from "@/types/tool";

export type {
  ProjectFileContent,
  ProjectFileSummary,
  ProjectTextSearchResult,
} from "@/types/projectRepository";

export const FileOperationErrorCode = {
  BadPath: "BAD_PATH",
  BadRevision: "BAD_REVISION",
  BadSearchQuery: "BAD_SEARCH_QUERY",
  NotFound: "NOT_FOUND",
  Conflict: "CONFLICT",
  RevisionConflict: "REVISION_CONFLICT",
  StorageMismatch: "STORAGE_MISMATCH",
  InternalError: "INTERNAL_ERROR",
} as const;

export type FileOperationErrorCode =
  typeof FileOperationErrorCode[keyof typeof FileOperationErrorCode];

export class FileOperationError extends Error {
  code: FileOperationErrorCode;

  constructor(code: FileOperationErrorCode, message: string) {
    super(message);
    this.name = "FileOperationError";
    this.code = code;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSummary(row: { path: string; updatedAt: Date | string }): ProjectFileSummary {
  return { path: row.path, updatedAt: toIso(row.updatedAt) };
}

function toContent(row: { path: string; content: string; updatedAt: Date | string }): ProjectFileContent {
  return { ...toSummary(row), content: row.content };
}

export function validateProjectFilePath(path: string): void {
  if (!path.trim()) throw new FileOperationError(FileOperationErrorCode.BadPath, "File path is required.");
  if (path.startsWith("/")) {
    throw new FileOperationError(FileOperationErrorCode.BadPath, "File path must not start with '/'.");
  }
  if (path.endsWith("/")) {
    throw new FileOperationError(FileOperationErrorCode.BadPath, "File path must not end with '/'.");
  }
  if (path.includes("//")) {
    throw new FileOperationError(FileOperationErrorCode.BadPath, "File path must not contain '//'.");
  }

  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new FileOperationError(FileOperationErrorCode.BadPath, "File path contains invalid segment.");
  }
}

function validateExpectedRevision(expectedRevision: number): void {
  if (!ProjectRevisionSchema.safeParse(expectedRevision).success) {
    throw new FileOperationError(
      FileOperationErrorCode.BadRevision,
      "expectedRevision must be a safe non-negative integer.",
    );
  }
}

function validateProjectTextSearchQuery(query: string): void {
  const invalid = query.length === 0
    || countUnicodeCodePoints(query) > SearchTextLimits.QueryCodePoints
    || query.trim().length === 0
    || containsUnicodeLineTerminator(query)
    || query.includes("\0");

  if (invalid) {
    throw new FileOperationError(
      FileOperationErrorCode.BadSearchQuery,
      "Search query must be non-empty, single-line text within the configured limit.",
    );
  }
}

async function getDatabaseProjectRevision(projectId: string): Promise<number> {
  const [project] = await db
    .select({ storageKind: projects.storageKind, revision: projects.codeRevision })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);

  if (!project) {
    throw new FileOperationError(FileOperationErrorCode.NotFound, `Project not found: ${projectId}`);
  }
  if (project.storageKind !== ProjectStorageKind.Database) {
    throw new FileOperationError(
      FileOperationErrorCode.StorageMismatch,
      `Project ${projectId} does not use ${ProjectStorageKind.Database} storage.`,
    );
  }
  return project.revision;
}

export async function listProjectFiles(projectId: string): Promise<ProjectFileSummary[]> {
  return (await listProjectFilesSnapshot(projectId)).files;
}

export async function listProjectFilesSnapshot(
  projectId: string,
): Promise<ProjectFilesSnapshot> {
  // Read revision before files. A concurrent mutation can only make this snapshot stale,
  // so a later CAS write fails instead of pairing old revision with older file contents.
  const revision = await getDatabaseProjectRevision(projectId);
  const rows = await db
    .select({ path: projectFiles.path, updatedAt: projectFiles.updatedAt })
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, projectId), isNull(projectFiles.deletedAt)))
    .orderBy(asc(projectFiles.path));

  return { revision, files: rows.map(toSummary) };
}

export async function listProjectFileContents(projectId: string): Promise<ProjectFileContent[]> {
  return (await listProjectFileContentsSnapshot(projectId)).files;
}

export async function listProjectFileContentsSnapshot(
  projectId: string,
): Promise<ProjectWorkspaceSnapshot> {
  const revision = await getDatabaseProjectRevision(projectId);
  const rows = await db
    .select({
      path: projectFiles.path,
      content: projectFiles.content,
      updatedAt: projectFiles.updatedAt,
    })
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, projectId), isNull(projectFiles.deletedAt)))
    .orderBy(asc(projectFiles.path));

  return { revision, files: rows.map(toContent) };
}

function textSearchSnippet(line: string, matchIndex: number, query: string): string {
  const width = SearchTextLimits.SnippetCodePoints;
  const lineCodePoints = Array.from(line);
  if (lineCodePoints.length <= width) return line;

  const matchCodePointIndex = countUnicodeCodePoints(line.slice(0, matchIndex));
  const queryCodePoints = countUnicodeCodePoints(query);
  const contextBefore = Math.floor((width - queryCodePoints) / 2);
  const start = Math.max(0, Math.min(matchCodePointIndex - contextBefore, lineCodePoints.length - width));
  const end = start + width;
  return `${start > 0 ? "…" : ""}${lineCodePoints.slice(start, end).join("")}${end < lineCodePoints.length ? "…" : ""}`;
}

function collectTextSearchMatches(
  rows: { path: string; content: string }[],
  query: string,
): Omit<ProjectTextSearchResult, "revision"> {
  const matches: ProjectTextSearchMatch[] = [];

  for (const row of rows) {
    const lines = row.content.split(/\r\n|[\n\r\u2028\u2029]/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      let from = 0;

      while (from < line.length) {
        const matchIndex = line.indexOf(query, from);
        if (matchIndex === -1) break;

        matches.push({
          path: row.path,
          line: lineIndex + 1,
          column: matchIndex + 1,
          snippet: textSearchSnippet(line, matchIndex, query),
        });
        if (matches.length > SearchTextLimits.Matches) {
          return { matches: matches.slice(0, SearchTextLimits.Matches), truncated: true };
        }
        from = matchIndex + query.length;
      }
    }
  }

  return { matches, truncated: false };
}

export async function searchProjectFiles(projectId: string, query: string): Promise<ProjectTextSearchResult> {
  validateProjectTextSearchQuery(query);
  const revision = await getDatabaseProjectRevision(projectId);

  const rows = await db
    .select({ path: projectFiles.path, content: projectFiles.content })
    .from(projectFiles)
    .where(and(
      eq(projectFiles.projectId, projectId),
      isNull(projectFiles.deletedAt),
      sql`strpos(${projectFiles.content}, ${query}) > 0`,
    ))
    .orderBy(asc(projectFiles.path))
    .limit(SearchTextLimits.Matches + 1);

  return { revision, ...collectTextSearchMatches(rows, query) };
}

export async function readProjectFile(projectId: string, path: string): Promise<RevisionedProjectFileContent> {
  validateProjectFilePath(path);
  const revision = await getDatabaseProjectRevision(projectId);

  const [row] = await db
    .select({
      path: projectFiles.path,
      content: projectFiles.content,
      updatedAt: projectFiles.updatedAt,
    })
    .from(projectFiles)
    .where(and(
      eq(projectFiles.projectId, projectId),
      eq(projectFiles.path, path),
      isNull(projectFiles.deletedAt),
    ))
    .limit(1);

  if (!row) throw new FileOperationError(FileOperationErrorCode.NotFound, `File not found: ${path}`);
  return { ...toContent(row), revision };
}

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function claimProjectRevision(
  tx: DatabaseTransaction,
  projectId: string,
  expectedRevision: number,
  now: Date,
): Promise<number | null> {
  const [claimed] = await tx
    .update(projects)
    .set({
      codeRevision: sql`${projects.codeRevision} + 1`,
      updatedAt: now,
    })
    .where(and(
      eq(projects.id, projectId),
      eq(projects.storageKind, ProjectStorageKind.Database),
      eq(projects.codeRevision, expectedRevision),
      isNull(projects.deletedAt),
    ))
    .returning({ revision: projects.codeRevision });

  if (claimed) return claimed.revision;

  const [project] = await tx
    .select({ storageKind: projects.storageKind, revision: projects.codeRevision })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);

  if (!project) {
    throw new FileOperationError(FileOperationErrorCode.NotFound, `Project not found: ${projectId}`);
  }
  if (project.storageKind !== ProjectStorageKind.Database) {
    throw new FileOperationError(
      FileOperationErrorCode.StorageMismatch,
      `Project ${projectId} does not use ${ProjectStorageKind.Database} storage.`,
    );
  }
  throw new FileOperationError(
    FileOperationErrorCode.RevisionConflict,
    `Project ${projectId} has revision ${project.revision}; expected ${expectedRevision}.`,
  );
}

function revisionConflict(projectId: string, expectedRevision: number): FileOperationError {
  return new FileOperationError(
    FileOperationErrorCode.RevisionConflict,
    `Project ${projectId} no longer has expected revision ${expectedRevision}.`,
  );
}

export async function writeProjectFile(
  projectId: string,
  path: string,
  content: string,
  expectedRevision: number,
): Promise<RevisionedProjectFileContent> {
  validateProjectFilePath(path);
  validateExpectedRevision(expectedRevision);
  const now = new Date();

  const result = await executeRevisionedMutation<DatabaseTransaction, ProjectFileContent>({
    transaction: (operation) => db.transaction(operation),
    claimRevision: (tx) => claimProjectRevision(tx, projectId, expectedRevision, now),
    mutate: async (tx) => {
      const [existing] = await tx
        .select({ id: projectFiles.id })
        .from(projectFiles)
        .where(and(
          eq(projectFiles.projectId, projectId),
          eq(projectFiles.path, path),
          isNull(projectFiles.deletedAt),
        ))
        .limit(1);

      const [row] = existing
        ? await tx
            .update(projectFiles)
            .set({ content, updatedAt: now })
            .where(eq(projectFiles.id, existing.id))
            .returning({
              path: projectFiles.path,
              content: projectFiles.content,
              updatedAt: projectFiles.updatedAt,
            })
        : await tx
            .insert(projectFiles)
            .values({ projectId, path, content, updatedAt: now })
            .returning({
              path: projectFiles.path,
              content: projectFiles.content,
              updatedAt: projectFiles.updatedAt,
            });

      return toContent(row);
    },
    revisionConflict: () => revisionConflict(projectId, expectedRevision),
  });

  return { ...result.value, revision: result.revision };
}

export async function deleteProjectFile(
  projectId: string,
  path: string,
  expectedRevision: number,
): Promise<{ revision: number }> {
  validateProjectFilePath(path);
  validateExpectedRevision(expectedRevision);
  const now = new Date();

  const result = await executeRevisionedMutation<DatabaseTransaction, void>({
    transaction: (operation) => db.transaction(operation),
    claimRevision: (tx) => claimProjectRevision(tx, projectId, expectedRevision, now),
    mutate: async (tx) => {
      const [row] = await tx
        .update(projectFiles)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(
          eq(projectFiles.projectId, projectId),
          eq(projectFiles.path, path),
          isNull(projectFiles.deletedAt),
        ))
        .returning({ id: projectFiles.id });

      if (!row) throw new FileOperationError(FileOperationErrorCode.NotFound, `File not found: ${path}`);
      return undefined;
    },
    revisionConflict: () => revisionConflict(projectId, expectedRevision),
  });

  return { revision: result.revision };
}

export async function renameProjectFile(
  projectId: string,
  oldPath: string,
  newPath: string,
  expectedRevision: number,
): Promise<RevisionedProjectFileSummary> {
  validateProjectFilePath(oldPath);
  validateProjectFilePath(newPath);
  validateExpectedRevision(expectedRevision);
  if (oldPath === newPath) {
    const file = await readProjectFile(projectId, oldPath);
    if (file.revision !== expectedRevision) throw revisionConflict(projectId, expectedRevision);
    return { path: file.path, updatedAt: file.updatedAt, revision: file.revision };
  }

  const now = new Date();
  const result = await executeRevisionedMutation<DatabaseTransaction, ProjectFileSummary>({
    transaction: (operation) => db.transaction(operation),
    claimRevision: (tx) => claimProjectRevision(tx, projectId, expectedRevision, now),
    mutate: async (tx) => {
      const [target] = await tx
        .select({ id: projectFiles.id })
        .from(projectFiles)
        .where(and(
          eq(projectFiles.projectId, projectId),
          eq(projectFiles.path, newPath),
          isNull(projectFiles.deletedAt),
        ))
        .limit(1);

      if (target) throw new FileOperationError(FileOperationErrorCode.Conflict, `File already exists: ${newPath}`);

      const [row] = await tx
        .update(projectFiles)
        .set({ path: newPath, updatedAt: now })
        .where(and(
          eq(projectFiles.projectId, projectId),
          eq(projectFiles.path, oldPath),
          isNull(projectFiles.deletedAt),
        ))
        .returning({ path: projectFiles.path, updatedAt: projectFiles.updatedAt });

      if (!row) throw new FileOperationError(FileOperationErrorCode.NotFound, `File not found: ${oldPath}`);
      return toSummary(row);
    },
    revisionConflict: () => revisionConflict(projectId, expectedRevision),
  });

  return { ...result.value, revision: result.revision };
}
