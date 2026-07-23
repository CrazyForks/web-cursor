/**
 * [INPUT]: Database project id/revision + strict GET/POST transport
 * [OUTPUT]: ProjectRepository backed only by the Database project file REST contract
 * [POS]: B 域 Database repository adapter —— Editor/Preview 与 project_files API 的唯一接缝
 * [PROTOCOL]: 所有响应必须通过共享 schema；revision 不得回退，mutation 必须 exact CAS +1
 */
import { FileContentAction, ProjectFileOperation } from "../../types/projectFileMutation";
import {
  DeleteProjectFileResponseSchema,
  type DatabaseProjectRepositoryTransport,
  ProjectFilesSnapshotSchema,
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
  type ProjectRepository,
  ProjectTextSearchResultSchema,
  ProjectWorkspaceSnapshotSchema,
  RevisionedProjectFileContentSchema,
  RevisionedProjectFileSummarySchema,
} from "../../types/projectRepository";
import { ProjectRevisionSchema } from "../../types/projectRevision";
import { ProjectStorageKind } from "../../types/projectStorage";

type CreateDatabaseProjectRepositoryInput = {
  projectId: string;
  initialRevision: number;
  transport: DatabaseProjectRepositoryTransport;
};

export function createDatabaseProjectRepository({
  projectId,
  initialRevision,
  transport,
}: CreateDatabaseProjectRepositoryInput): ProjectRepository {
  ProjectRevisionSchema.parse(initialRevision);
  let revision = initialRevision;
  const basePath = `/api/projects/${projectId}/files`;

  function acceptReadRevision(nextRevision: number): number {
    if (nextRevision < revision) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.StaleSnapshot,
        `received revision ${nextRevision} after revision ${revision}`,
      );
    }
    revision = nextRevision;
    return revision;
  }

  function requireCurrentRevision(expectedRevision: number): void {
    ProjectRevisionSchema.parse(expectedRevision);
    if (expectedRevision !== revision) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.RevisionConflict,
        `repository is at revision ${revision}; expected ${expectedRevision}`,
      );
    }
  }

  function acceptMutationRevision(nextRevision: number, expectedRevision: number): number {
    if (nextRevision !== expectedRevision + 1) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.ProtocolViolation,
        `mutation returned revision ${nextRevision}; expected ${expectedRevision + 1}`,
      );
    }
    revision = nextRevision;
    return revision;
  }

  function requireResponsePath(actualPath: string, expectedPath: string, operation: string): void {
    if (actualPath !== expectedPath) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.ProtocolViolation,
        `${operation} returned path ${actualPath}; expected ${expectedPath}`,
      );
    }
  }

  async function readWorkspace() {
    const snapshot = ProjectWorkspaceSnapshotSchema.parse(
      await transport("GET", `${basePath}?includeContent=1`),
    );
    acceptReadRevision(snapshot.revision);
    return snapshot;
  }

  return {
    projectId,
    storageKind: ProjectStorageKind.Database,

    getRevision: () => revision,

    async listFiles() {
      const snapshot = ProjectFilesSnapshotSchema.parse(await transport("GET", basePath));
      acceptReadRevision(snapshot.revision);
      return snapshot;
    },

    readWorkspace,

    async readFile(path) {
      const query = new URLSearchParams({ path });
      const file = RevisionedProjectFileContentSchema.parse(
        await transport("GET", `${basePath}/content?${query}`),
      );
      requireResponsePath(file.path, path, "readFile");
      acceptReadRevision(file.revision);
      return file;
    },

    async searchText(queryText) {
      const query = new URLSearchParams({ query: queryText });
      const result = ProjectTextSearchResultSchema.parse(
        await transport("GET", `${basePath}/search?${query}`),
      );
      acceptReadRevision(result.revision);
      return result;
    },

    async writeFile(input) {
      requireCurrentRevision(input.expectedRevision);
      const file = RevisionedProjectFileContentSchema.parse(
        await transport("POST", `${basePath}/content`, {
          action: FileContentAction.Write,
          path: input.path,
          content: input.content,
          expectedRevision: input.expectedRevision,
        }),
      );
      requireResponsePath(file.path, input.path, "writeFile");
      acceptMutationRevision(file.revision, input.expectedRevision);
      return {
        operation: ProjectFileOperation.Write,
        path: file.path,
        revision: file.revision,
        file: { path: file.path, content: file.content, updatedAt: file.updatedAt },
      };
    },

    async deleteFile(input) {
      requireCurrentRevision(input.expectedRevision);
      const result = DeleteProjectFileResponseSchema.parse(
        await transport("POST", `${basePath}/content`, {
          action: FileContentAction.Delete,
          path: input.path,
          expectedRevision: input.expectedRevision,
        }),
      );
      requireResponsePath(result.path, input.path, "deleteFile");
      acceptMutationRevision(result.revision, input.expectedRevision);
      return {
        operation: ProjectFileOperation.Delete,
        path: result.path,
        revision: result.revision,
      };
    },

    async renameFile(input) {
      requireCurrentRevision(input.expectedRevision);
      const file = RevisionedProjectFileSummarySchema.parse(
        await transport("POST", `${basePath}/rename`, input),
      );
      requireResponsePath(file.path, input.newPath, "renameFile");
      acceptMutationRevision(file.revision, input.expectedRevision);
      return {
        operation: ProjectFileOperation.Rename,
        oldPath: input.oldPath,
        path: file.path,
        revision: file.revision,
        file: { path: file.path, updatedAt: file.updatedAt },
      };
    },

    async exportPreviewFiles() {
      const snapshot = await readWorkspace();
      return {
        revision: snapshot.revision,
        files: snapshot.files.map(({ path, content }) => ({ path, content })),
      };
    },
  };
}
