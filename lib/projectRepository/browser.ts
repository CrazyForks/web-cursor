/**
 * [INPUT]: browser_git_v1 descriptor + BrowserGitWorkerClient
 * [OUTPUT]: strict ProjectRepository backed only by the browser Repository Worker
 * [POS]: B 域 Browser Git repository adapter —— Editor/Preview 与 Worker 的唯一文件端口
 * [PROTOCOL]: open before use; responses strict parsed; revisions never regress; mutations are exact CAS +1
 */
import {
  BrowserDeleteResultSchema,
  BrowserRenameResultSchema,
  BrowserRepositoryCommandType,
  BrowserRepositoryResultSchema,
  type BrowserRepositoryCommand,
  BrowserWriteResultSchema,
  OpenBrowserRepositoryResultSchema,
} from "../../types/browserRepositoryProtocol";
import {
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
  type ProjectRepository,
  type ProjectRepositoryDescriptor,
} from "../../types/projectRepository";
import { ProjectRevisionSchema } from "../../types/projectRevision";
import { ProjectStorageKind } from "../../types/projectStorage";
import type { BrowserGitWorkerClient } from "./browserGitWorkerClient";
import {
  GitCommitInputSchema,
  GitCommitResultSchema,
  GitCurrentBranchResultSchema,
  GitInitInputSchema,
  GitInitResultSchema,
  GitLogInputSchema,
  GitLogResultSchema,
  GitStatusResultSchema,
  GitAuthorSchema,
  type BrowserGitProjectRepository,
} from "../../types/browserGitRepository";

type BrowserGitDescriptor = Extract<
  ProjectRepositoryDescriptor,
  { storageKind: typeof ProjectStorageKind.BrowserGit }
>;

type CreateBrowserGitProjectRepositoryInput = {
  descriptor: BrowserGitDescriptor;
  client: BrowserGitWorkerClient;
};

export function createBrowserGitProjectRepository({
  descriptor,
  client,
}: CreateBrowserGitProjectRepositoryInput): BrowserGitProjectRepository {
  ProjectRevisionSchema.parse(descriptor.revision);
  let revision = descriptor.revision;
  const ready = client.execute({
    type: BrowserRepositoryCommandType.Open,
    projectId: descriptor.projectId,
    initialRevision: descriptor.revision,
  }).then((result) => {
    const opened = OpenBrowserRepositoryResultSchema.parse(result);
    if (opened.revision < revision) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.StaleSnapshot,
        `Worker opened revision ${opened.revision} after descriptor revision ${revision}`,
      );
    }
    revision = opened.revision;
  });

  function acceptReadRevision(nextRevision: number): void {
    if (nextRevision < revision) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.StaleSnapshot,
        `received revision ${nextRevision} after revision ${revision}`,
      );
    }
    revision = nextRevision;
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

  function acceptMutationRevision(nextRevision: number, expectedRevision: number): void {
    if (nextRevision !== expectedRevision + 1) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.ProtocolViolation,
        `mutation returned revision ${nextRevision}; expected ${expectedRevision + 1}`,
      );
    }
    revision = nextRevision;
  }

  function requirePath(actual: string, expected: string, operation: string): void {
    if (actual !== expected) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.ProtocolViolation,
        `${operation} returned path ${actual}; expected ${expected}`,
      );
    }
  }

  async function execute(command: BrowserRepositoryCommand) {
    await ready;
    return client.execute(command);
  }

  async function readWorkspace() {
    const snapshot = BrowserRepositoryResultSchema.read_workspace.parse(
      await execute({
        type: BrowserRepositoryCommandType.ReadWorkspace,
        projectId: descriptor.projectId,
      }),
    );
    acceptReadRevision(snapshot.revision);
    return snapshot;
  }

  return {
    projectId: descriptor.projectId,
    storageKind: ProjectStorageKind.BrowserGit,
    getRevision: () => revision,

    async listFiles() {
      const snapshot = BrowserRepositoryResultSchema.list_files.parse(
        await execute({
          type: BrowserRepositoryCommandType.ListFiles,
          projectId: descriptor.projectId,
        }),
      );
      acceptReadRevision(snapshot.revision);
      return snapshot;
    },

    readWorkspace,

    async readFile(path) {
      const file = BrowserRepositoryResultSchema.read_file.parse(
        await execute({
          type: BrowserRepositoryCommandType.ReadFile,
          projectId: descriptor.projectId,
          path,
        }),
      );
      requirePath(file.path, path, "readFile");
      acceptReadRevision(file.revision);
      return file;
    },

    async searchText(query) {
      const result = BrowserRepositoryResultSchema.search_text.parse(
        await execute({
          type: BrowserRepositoryCommandType.SearchText,
          projectId: descriptor.projectId,
          query,
        }),
      );
      acceptReadRevision(result.revision);
      return result;
    },

    async writeFile(input) {
      await ready;
      requireCurrentRevision(input.expectedRevision);
      const result = BrowserWriteResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.WriteFile,
        projectId: descriptor.projectId,
        ...input,
      }));
      requirePath(result.path, input.path, "writeFile");
      acceptMutationRevision(result.revision, input.expectedRevision);
      return result;
    },

    async deleteFile(input) {
      await ready;
      requireCurrentRevision(input.expectedRevision);
      const result = BrowserDeleteResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.DeleteFile,
        projectId: descriptor.projectId,
        ...input,
      }));
      requirePath(result.path, input.path, "deleteFile");
      acceptMutationRevision(result.revision, input.expectedRevision);
      return result;
    },

    async renameFile(input) {
      await ready;
      requireCurrentRevision(input.expectedRevision);
      const result = BrowserRenameResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.RenameFile,
        projectId: descriptor.projectId,
        ...input,
      }));
      requirePath(result.oldPath, input.oldPath, "renameFile oldPath");
      requirePath(result.path, input.newPath, "renameFile newPath");
      acceptMutationRevision(result.revision, input.expectedRevision);
      return result;
    },

    async exportPreviewFiles() {
      const snapshot = await readWorkspace();
      return {
        revision: snapshot.revision,
        files: snapshot.files.map(({ path, content }) => ({ path, content })),
      };
    },

    async initGit(input) {
      const parsed = GitInitInputSchema.parse(input);
      return GitInitResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.GitInit,
        projectId: descriptor.projectId,
        ...parsed,
      }));
    },

    async gitStatus() {
      return GitStatusResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.GitStatus,
        projectId: descriptor.projectId,
      }));
    },

    async stageFile(path) {
      return GitStatusResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.GitStage,
        projectId: descriptor.projectId,
        path,
      }));
    },

    async unstageFile(path) {
      return GitStatusResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.GitUnstage,
        projectId: descriptor.projectId,
        path,
      }));
    },

    async commit(input) {
      const parsed = GitCommitInputSchema.safeParse(input);
      if (!parsed.success) {
        const author = typeof input === "object" && input !== null && "author" in input
          ? Reflect.get(input, "author")
          : undefined;
        const invalidAuthor = !GitAuthorSchema.safeParse(author).success;
        throw new ProjectRepositoryError(
          invalidAuthor
            ? ProjectRepositoryErrorCode.GitAuthorRequired
            : ProjectRepositoryErrorCode.BadCommitMessage,
          parsed.error.message,
        );
      }
      return GitCommitResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.GitCommit,
        projectId: descriptor.projectId,
        ...parsed.data,
      }));
    },

    async gitLog(input) {
      const parsed = GitLogInputSchema.parse(input);
      return GitLogResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.GitLog,
        projectId: descriptor.projectId,
        ...parsed,
      }));
    },

    async currentBranch() {
      return GitCurrentBranchResultSchema.parse(await execute({
        type: BrowserRepositoryCommandType.GitCurrentBranch,
        projectId: descriptor.projectId,
      }));
    },
  };
}
