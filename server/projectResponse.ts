/**
 * [INPUT]: projects/conversations database rows
 * [OUTPUT]: strict storage-discriminated API response 与 repository descriptor
 * [POS]: A 域持久层到共享契约的唯一映射边界
 * [PROTOCOL]: storage kind 必须显式穷举；未知值直接失败，不补默认值。
 */
import "server-only";
import type { BrowserGitProject, Conversation, DatabaseProject, Project } from "@/lib/projectTypes";
import { conversations, projects } from "@/server/db/schema";
import type { ProjectRepositoryDescriptor } from "@/types/projectRepository";
import { ProjectStorageKind } from "@/types/projectStorage";

type ProjectRow = typeof projects.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

function invalidStorageKind(value: never): never {
  throw new Error(`Unknown project storage kind from database: ${String(value)}`);
}

export function toProjectResponse(row: ProjectRow): Project {
  const common = {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };

  switch (row.storageKind) {
    case ProjectStorageKind.Database:
      return {
        ...common,
        storageKind: ProjectStorageKind.Database,
        codeRevision: row.codeRevision,
      } satisfies DatabaseProject;
    case ProjectStorageKind.BrowserGit:
      return {
        ...common,
        storageKind: ProjectStorageKind.BrowserGit,
      } satisfies BrowserGitProject;
    default:
      return invalidStorageKind(row.storageKind);
  }
}

export function toConversationResponse(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toProjectRepositoryDescriptor(row: ProjectRow): ProjectRepositoryDescriptor {
  switch (row.storageKind) {
    case ProjectStorageKind.Database:
      return {
        projectId: row.id,
        storageKind: ProjectStorageKind.Database,
        revision: row.codeRevision,
      };
    case ProjectStorageKind.BrowserGit:
      return {
        projectId: row.id,
        storageKind: ProjectStorageKind.BrowserGit,
        revision: row.codeRevision,
      };
    default:
      return invalidStorageKind(row.storageKind);
  }
}
