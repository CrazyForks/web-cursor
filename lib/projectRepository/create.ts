import { createDatabaseProjectRepository } from "./database";
import { createBrowserGitProjectRepository } from "./browser";
import type { BrowserGitWorkerClient } from "./browserGitWorkerClient";
import {
  type DatabaseProjectRepositoryTransport,
  type ProjectRepository,
  type ProjectRepositoryDescriptor,
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
} from "../../types/projectRepository";
import { ProjectStorageKind } from "../../types/projectStorage";

type CreateProjectRepositoryInput = {
  descriptor: ProjectRepositoryDescriptor;
  databaseTransport: DatabaseProjectRepositoryTransport;
  browserClient?: BrowserGitWorkerClient;
};

function assertNever(value: never): never {
  throw new ProjectRepositoryError(
    ProjectRepositoryErrorCode.ProtocolViolation,
    `unhandled repository descriptor: ${JSON.stringify(value)}`,
  );
}

export function createProjectRepository({
  descriptor,
  databaseTransport,
  browserClient,
}: CreateProjectRepositoryInput): ProjectRepository {
  switch (descriptor.storageKind) {
    case ProjectStorageKind.Database:
      return createDatabaseProjectRepository({
        projectId: descriptor.projectId,
        initialRevision: descriptor.revision,
        transport: databaseTransport,
      });
    case ProjectStorageKind.BrowserGit:
      if (!browserClient) {
        throw new ProjectRepositoryError(
          ProjectRepositoryErrorCode.UnsupportedStorage,
          `${ProjectStorageKind.BrowserGit} requires a Browser Repository Worker client`,
        );
      }
      return createBrowserGitProjectRepository({ descriptor, client: browserClient });
    default:
      return assertNever(descriptor);
  }
}
