/**
 * [INPUT]: active Database ProjectRepository、显式 Git author、Browser Worker 与项目 API transport
 * [OUTPUT]: 已通过服务端 CAS 激活并重新打开的 Browser Git repository
 * [POS]: B 域 Database→Browser Git 迁移编排器 —— 本地导入成功后才请求切换唯一写源
 * [PROTOCOL]: 不双写；POST 结果不确定时只接受 GET 明确显示 Browser Git；失败保留 Database active
 */
import {
  BrowserGitProjectSchema,
  ProjectDetailSchema,
  ProjectSchema,
  type BrowserGitProject,
} from "../projectTypes";
import {
  BrowserRepositoryCommandType,
  BrowserRepositoryResultSchema,
} from "../../types/browserRepositoryProtocol";
import type { GitAuthorSchema } from "../../types/browserGitRepository";
import {
  BrowserGitMigrationDefaults,
  type PreparedBrowserGitMigration,
} from "../../types/projectMigration";
import {
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
  type ProjectRepository,
} from "../../types/projectRepository";
import { ProjectStorageKind } from "../../types/projectStorage";
import type { z } from "zod";
import { createBrowserGitProjectRepository } from "./browser";
import type { BrowserGitWorkerClient } from "./browserGitWorkerClient";

type GitAuthor = z.infer<typeof GitAuthorSchema>;

export type ProjectMigrationTransport = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<unknown>;

type MigrateDatabaseProjectInput = {
  repository: ProjectRepository;
  author: GitAuthor;
  client: BrowserGitWorkerClient;
  transport: ProjectMigrationTransport;
};

export type MigratedBrowserGitProject = {
  project: BrowserGitProject;
  repository: ProjectRepository;
  prepared: PreparedBrowserGitMigration;
};

function sameWorkspace(
  left: { path: string; content: string }[],
  right: { path: string; content: string }[],
): boolean {
  const sort = (files: { path: string; content: string }[]) => files
    .map(({ path, content }) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
}

function requireActivatedProject(value: unknown, projectId: string): BrowserGitProject {
  const project = ProjectSchema.parse(value);
  if (project.id !== projectId || project.storageKind !== ProjectStorageKind.BrowserGit) {
    throw new ProjectRepositoryError(
      ProjectRepositoryErrorCode.ProtocolViolation,
      `migration activation returned project ${project.id} with storage ${project.storageKind}`,
    );
  }
  return BrowserGitProjectSchema.parse(project);
}

async function activateProject(
  transport: ProjectMigrationTransport,
  projectId: string,
  prepared: PreparedBrowserGitMigration,
): Promise<BrowserGitProject> {
  try {
    return requireActivatedProject(await transport("POST", `/api/projects/${projectId}/migrate-browser-git`, {
      sourceRevision: prepared.sourceRevision,
      localRevision: prepared.localRevision,
      importCommitOid: prepared.importCommitOid,
    }), projectId);
  } catch (activationError) {
    const detail = ProjectDetailSchema.parse(await transport("GET", `/api/projects/${projectId}`));
    if (detail.id === projectId && detail.storageKind === ProjectStorageKind.BrowserGit) {
      return BrowserGitProjectSchema.parse(detail);
    }
    throw activationError;
  }
}

export async function migrateDatabaseProjectToBrowserGit({
  repository,
  author,
  client,
  transport,
}: MigrateDatabaseProjectInput): Promise<MigratedBrowserGitProject> {
  if (repository.storageKind !== ProjectStorageKind.Database) {
    throw new ProjectRepositoryError(
      ProjectRepositoryErrorCode.UnsupportedStorage,
      `cannot migrate project from ${repository.storageKind}`,
    );
  }

  const source = await repository.readWorkspace();
  const prepared = BrowserRepositoryResultSchema.prepare_database_migration.parse(
    await client.execute({
      type: BrowserRepositoryCommandType.PrepareMigration,
      projectId: repository.projectId,
      sourceRevision: source.revision,
      files: source.files.map(({ path, content }) => ({ path, content })),
      defaultBranch: BrowserGitMigrationDefaults.Branch,
      message: BrowserGitMigrationDefaults.CommitMessage,
      author,
    }),
  );

  const browserRepository = createBrowserGitProjectRepository({
    descriptor: {
      projectId: repository.projectId,
      storageKind: ProjectStorageKind.BrowserGit,
      revision: prepared.localRevision,
    },
    client,
  });
  const activatedWorkspace = await browserRepository.readWorkspace();
  if (
    activatedWorkspace.revision !== source.revision
    || !sameWorkspace(activatedWorkspace.files, source.files)
  ) {
    throw new ProjectRepositoryError(
      ProjectRepositoryErrorCode.ProtocolViolation,
      "activated Browser Git workspace does not match the Database source snapshot",
    );
  }

  const project = await activateProject(transport, repository.projectId, prepared);

  return { project, repository: browserRepository, prepared };
}
