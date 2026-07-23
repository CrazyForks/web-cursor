/**
 * [INPUT]: validated ProjectRepositoryDescriptor + browser owner session
 * [OUTPUT]: storage-dispatched ProjectRepository for UI hooks
 * [POS]: B 域 repository composition root —— 唯一注入 REST transport 的位置
 * [PROTOCOL]: storage dispatch 由 createProjectRepository exhaustive 处理；UI hook 不直接 fetch
 */
"use client";

import { req } from "@/lib/api";
import { createProjectRepository } from "@/lib/projectRepository/create";
import { createBrowserGitWorkerClient } from "@/lib/projectRepository/browserGitWorkerClient";
import { provisionBrowserGitProjectRepository } from "@/lib/projectRepository/provision";
import { migrateDatabaseProjectToBrowserGit } from "@/lib/projectRepository/migrate";
import type { ProjectRepositoryDescriptor } from "@/types/projectRepository";
import type { ProjectRepository } from "@/types/projectRepository";
import type { GitCommitInput } from "@/types/browserGitRepository";
import { ProjectStorageKind } from "@/types/projectStorage";

let browserClient: ReturnType<typeof createBrowserGitWorkerClient> | undefined;

function getBrowserClient() {
  browserClient ??= createBrowserGitWorkerClient();
  return browserClient;
}

export function createClientProjectRepository(descriptor: ProjectRepositoryDescriptor) {
  return createProjectRepository({
    descriptor,
    databaseTransport: (method, path, body) => req(method, path, body),
    browserClient: descriptor.storageKind === ProjectStorageKind.BrowserGit
      ? getBrowserClient()
      : undefined,
  });
}

export function provisionClientBrowserGitProjectRepository(projectId: string, defaultBranch: string) {
  return provisionBrowserGitProjectRepository({
    client: getBrowserClient(),
    projectId,
    defaultBranch,
  });
}

export function migrateClientDatabaseProjectToBrowserGit(
  repository: ProjectRepository,
  author: GitCommitInput["author"],
) {
  return migrateDatabaseProjectToBrowserGit({
    repository,
    author,
    client: getBrowserClient(),
    transport: (method, path, body) => req(method, path, body),
  });
}
