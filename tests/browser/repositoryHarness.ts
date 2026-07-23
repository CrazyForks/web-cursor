import { createBrowserGitProjectRepository } from "../../lib/projectRepository/browser";
import { createBrowserGitWorkerClient } from "../../lib/projectRepository/browserGitWorkerClient";
import { provisionBrowserGitProjectRepository } from "../../lib/projectRepository/provision";
import { executeClientFileTool } from "../../lib/projectRepository/clientFileToolExecutor";
import { executeClientGitTool } from "../../lib/projectRepository/clientGitToolExecutor";
import { ProjectStorageKind } from "../../types/projectStorage";
import { ToolName } from "../../types/tool";
import {
  BrowserGitMigrationDefaults,
  PreparedBrowserGitMigrationSchema,
} from "../../types/projectMigration";
import {
  BrowserRepositoryCommandType,
  BrowserRepositoryResultSchema,
} from "../../types/browserRepositoryProtocol";
import { runPortableProjectRepositoryContract } from "../contracts/projectRepositoryContractRunner";

type ContractResult = {
  initialRevision: number;
  finalRevision: number;
  files: { path: string; content: string }[];
  staleRejected: boolean;
  gitPathRejected: boolean;
  nodeModulesPathRejected: boolean;
  allGitPathOperationsRejected: boolean;
};

async function createProvisionedRepository(
  client: ReturnType<typeof createBrowserGitWorkerClient>,
  projectId: string,
) {
  return provisionBrowserGitProjectRepository({
    client,
    projectId,
    defaultBranch: "main",
  });
}

async function runContract(projectId: string): Promise<ContractResult> {
  const client = createBrowserGitWorkerClient();
  const repository = await createProvisionedRepository(client, projectId);

  try {
    const initialRevision = repository.getRevision();
    await repository.writeFile({ path: "a.txt", content: "alpha", expectedRevision: 0 });

    let staleRejected = false;
    try {
      await repository.writeFile({ path: "a.txt", content: "stale", expectedRevision: 0 });
    } catch (error) {
      staleRejected = String(error).includes("REVISION_CONFLICT");
    }

    let gitPathRejected = false;
    try {
      await repository.writeFile({ path: ".git/config", content: "forbidden", expectedRevision: 1 });
    } catch (error) {
      gitPathRejected = String(error).includes("RESERVED_PATH");
    }

    let nodeModulesPathRejected = false;
    try {
      await repository.writeFile({
        path: "node_modules/runtime.js",
        content: "forbidden",
        expectedRevision: 1,
      });
    } catch (error) {
      nodeModulesPathRejected = String(error).includes("RESERVED_PATH");
    }

    const reservedPathOperations = [
      () => repository.readFile(".git/config"),
      () => repository.deleteFile({ path: ".git/config", expectedRevision: 1 }),
      () => repository.renameFile({ oldPath: ".git/config", newPath: "config", expectedRevision: 1 }),
      () => repository.renameFile({ oldPath: "a.txt", newPath: ".git/config", expectedRevision: 1 }),
    ];
    const reservedResults: boolean[] = [];
    for (const operation of reservedPathOperations) {
      try {
        await operation();
        reservedResults.push(false);
      } catch (error) {
        reservedResults.push(String(error).includes("RESERVED_PATH"));
      }
    }

    await repository.renameFile({ oldPath: "a.txt", newPath: "b.txt", expectedRevision: 1 });
    const snapshot = await repository.exportPreviewFiles();
    return {
      initialRevision,
      finalRevision: snapshot.revision,
      files: snapshot.files,
      staleRejected,
      gitPathRejected,
      nodeModulesPathRejected,
      allGitPathOperationsRejected: reservedResults.every(Boolean),
    };
  } finally {
    client.dispose();
  }
}

async function runPersistence(projectId: string) {
  const firstClient = createBrowserGitWorkerClient();
  const firstRepository = await createProvisionedRepository(firstClient, projectId);
  await firstRepository.writeFile({ path: "persisted.txt", content: "still here", expectedRevision: 0 });
  firstClient.dispose();

  const secondClient = createBrowserGitWorkerClient();
  const secondRepository = createBrowserGitProjectRepository({
    descriptor: {
      projectId,
      storageKind: ProjectStorageKind.BrowserGit,
      revision: 0,
    },
    client: secondClient,
  });
  try {
    return await secondRepository.readWorkspace();
  } finally {
    secondClient.dispose();
  }
}

async function runSharedContract(projectId: string) {
  const client = createBrowserGitWorkerClient();
  const repository = await createProvisionedRepository(client, projectId);
  try {
    await repository.writeFile({ path: "a.txt", content: "alpha", expectedRevision: 0 });
    return await runPortableProjectRepositoryContract(repository, 1);
  } finally {
    client.dispose();
  }
}

async function runIsolationAndConcurrency(firstProjectId: string, secondProjectId: string) {
  const client = createBrowserGitWorkerClient();
  const first = await createProvisionedRepository(client, firstProjectId);
  const second = await createProvisionedRepository(client, secondProjectId);
  try {
    const results = await Promise.allSettled([
      first.writeFile({ path: "first.txt", content: "one", expectedRevision: 0 }),
      first.writeFile({ path: "racing.txt", content: "two", expectedRevision: 0 }),
      second.writeFile({ path: "second.txt", content: "separate", expectedRevision: 0 }),
    ]);
    return {
      fulfilled: results.filter((result) => result.status === "fulfilled").length,
      revisionConflicts: results.filter(
        (result) => result.status === "rejected" && String(result.reason).includes("REVISION_CONFLICT"),
      ).length,
      first: await first.exportPreviewFiles(),
      second: await second.exportPreviewFiles(),
    };
  } finally {
    client.dispose();
  }
}

async function runGitMvp(projectId: string) {
  const firstClient = createBrowserGitWorkerClient();
  const first = await createProvisionedRepository(firstClient, projectId);
  await first.writeFile({ path: "a.txt", content: "alpha", expectedRevision: 0 });
  let badBranchRejected = false;
  try {
    await first.initGit({ defaultBranch: "bad branch" });
  } catch (error) {
    badBranchRejected = String(error).includes("BAD_GIT_REF");
  }
  const initialized = await first.initGit({ defaultBranch: "main" });
  let gitMetadataStageRejected = false;
  try {
    await first.stageFile(".git/config");
  } catch (error) {
    gitMetadataStageRejected = String(error).includes("RESERVED_PATH");
  }
  const untracked = await first.gitStatus();
  const staged = await first.stageFile("a.txt");
  const unstaged = await first.unstageFile("a.txt");
  await first.stageFile("a.txt");

  let missingAuthorRejected = false;
  try {
    await Reflect.apply(first.commit, first, [{ message: "missing author" }]);
  } catch (error) {
    missingAuthorRejected = String(error).includes("GIT_AUTHOR_REQUIRED");
  }

  const firstCommit = await first.commit({
    message: "initial commit",
    author: { name: "Browser User", email: "browser@example.com" },
  });

  let emptyCommitRejected = false;
  try {
    await first.commit({
      message: "empty commit",
      author: { name: "Browser User", email: "browser@example.com" },
    });
  } catch (error) {
    emptyCommitRejected = String(error).includes("NOTHING_TO_COMMIT");
  }

  await first.writeFile({ path: "a.txt", content: "beta", expectedRevision: 1 });
  const modifiedStaged = await first.stageFile("a.txt");
  const modifiedUnstaged = await first.unstageFile("a.txt");
  await first.stageFile("a.txt");
  const secondCommit = await first.commit({
    message: "update a",
    author: { name: "Browser User", email: "browser@example.com" },
  });
  firstClient.dispose();

  const secondClient = createBrowserGitWorkerClient();
  const reopened = createBrowserGitProjectRepository({
    descriptor: { projectId, storageKind: ProjectStorageKind.BrowserGit, revision: 0 },
    client: secondClient,
  });
  try {
    return {
      initialized,
      badBranchRejected,
      gitMetadataStageRejected,
      untracked,
      staged,
      unstaged,
      missingAuthorRejected,
      emptyCommitRejected,
      modifiedStaged,
      modifiedUnstaged,
      firstCommit,
      secondCommit,
      branch: await reopened.currentBranch(),
      statusAfterRestart: await reopened.gitStatus(),
      logAfterRestart: await reopened.gitLog({ depth: 10 }),
      revisionAfterRestart: (await reopened.readWorkspace()).revision,
    };
  } finally {
    secondClient.dispose();
  }
}

async function runProvisioning(missingProjectId: string, projectId: string) {
  const missingClient = createBrowserGitWorkerClient();
  const missing = createBrowserGitProjectRepository({
    descriptor: {
      projectId: missingProjectId,
      storageKind: ProjectStorageKind.BrowserGit,
      revision: 0,
    },
    client: missingClient,
  });
  let missingRejected = false;
  try {
    await missing.readWorkspace();
  } catch (error) {
    missingRejected = String(error).includes("LOCAL_REPOSITORY_MISSING");
  } finally {
    missingClient.dispose();
  }

  const client = createBrowserGitWorkerClient();
  try {
    const first = await createProvisionedRepository(client, projectId);
    const second = await createProvisionedRepository(client, projectId);
    return {
      missingRejected,
      firstRevision: first.getRevision(),
      secondRevision: second.getRevision(),
      branch: await second.currentBranch(),
      workspace: await second.readWorkspace(),
    };
  } finally {
    client.dispose();
  }
}

async function runClientFileTools(projectId: string) {
  const client = createBrowserGitWorkerClient();
  const repository = await createProvisionedRepository(client, projectId);
  try {
    const list = await executeClientFileTool(repository, {
      id: "list",
      name: ToolName.ListFiles,
      arguments: "{}",
    });
    const write = await executeClientFileTool(repository, {
      id: "write",
      name: ToolName.WriteFile,
      arguments: JSON.stringify({ path: "a.txt", content: "alpha", expectedRevision: 0 }),
    });
    const read = await executeClientFileTool(repository, {
      id: "read",
      name: ToolName.ReadFile,
      arguments: JSON.stringify({ path: "a.txt" }),
    });
    const search = await executeClientFileTool(repository, {
      id: "search",
      name: ToolName.SearchText,
      arguments: JSON.stringify({ query: "alpha" }),
    });
    const rename = await executeClientFileTool(repository, {
      id: "rename",
      name: ToolName.RenameFile,
      arguments: JSON.stringify({ oldPath: "a.txt", newPath: "b.txt", expectedRevision: 1 }),
    });
    const remove = await executeClientFileTool(repository, {
      id: "delete",
      name: ToolName.DeleteFile,
      arguments: JSON.stringify({ path: "b.txt", expectedRevision: 2 }),
    });
    return { list, write, read, search, rename, remove, workspace: await repository.readWorkspace() };
  } finally {
    client.dispose();
  }
}

async function runClientGitTools(projectId: string) {
  const client = createBrowserGitWorkerClient();
  const repository = await createProvisionedRepository(client, projectId);
  try {
    await repository.writeFile({
      path: "agent.txt",
      content: "agent change",
      expectedRevision: 0,
    });
    const status = await executeClientGitTool(repository, {
      id: "git-status",
      name: ToolName.GitStatus,
      arguments: "{}",
    });
    const stage = await executeClientGitTool(repository, {
      id: "git-stage",
      name: ToolName.GitStage,
      arguments: JSON.stringify({ path: "agent.txt" }),
    });
    const missingAuthor = await executeClientGitTool(repository, {
      id: "git-commit-missing-author",
      name: ToolName.GitCommit,
      arguments: JSON.stringify({ message: "Agent commit" }),
    });
    const unstage = await executeClientGitTool(repository, {
      id: "git-unstage",
      name: ToolName.GitUnstage,
      arguments: JSON.stringify({ path: "agent.txt" }),
    });
    await executeClientGitTool(repository, {
      id: "git-stage-again",
      name: ToolName.GitStage,
      arguments: JSON.stringify({ path: "agent.txt" }),
    });
    const commit = await executeClientGitTool(repository, {
      id: "git-commit",
      name: ToolName.GitCommit,
      arguments: JSON.stringify({
        message: "Agent commit",
        author: { name: "Explicit User", email: "user@example.com" },
      }),
    });
    const log = await executeClientGitTool(repository, {
      id: "git-log",
      name: ToolName.GitLog,
      arguments: JSON.stringify({ depth: 10 }),
    });
    const branch = await executeClientGitTool(repository, {
      id: "git-current-branch",
      name: ToolName.GitCurrentBranch,
      arguments: "{}",
    });
    const finalStatus = await executeClientGitTool(repository, {
      id: "git-status-final",
      name: ToolName.GitStatus,
      arguments: "{}",
    });
    return {
      status,
      stage,
      missingAuthor,
      unstage,
      commit,
      log,
      branch,
      finalStatus,
    };
  } finally {
    client.dispose();
  }
}

async function runDatabaseMigration(projectId: string, emptyProjectId: string) {
  const client = createBrowserGitWorkerClient();
  const stale = await createProvisionedRepository(client, projectId);
  await stale.writeFile({ path: "stale.txt", content: "remove me", expectedRevision: 0 });

  const firstPrepared = PreparedBrowserGitMigrationSchema.parse(await client.execute({
    type: BrowserRepositoryCommandType.PrepareMigration,
    projectId,
    sourceRevision: 7,
    files: [
      { path: "README.md", content: "# imported\n" },
      { path: "src/App.tsx", content: "export default function App() { return <main>migrated</main>; }" },
    ],
    defaultBranch: BrowserGitMigrationDefaults.Branch,
    message: BrowserGitMigrationDefaults.CommitMessage,
    author: { name: "Migration User", email: "migration@example.com" },
  }));

  const imported = createBrowserGitProjectRepository({
    descriptor: { projectId, storageKind: ProjectStorageKind.BrowserGit, revision: 7 },
    client,
  });
  await imported.writeFile({ path: "retry-residue.txt", content: "remove on retry", expectedRevision: 7 });

  const retryPrepared = PreparedBrowserGitMigrationSchema.parse(await client.execute({
    type: BrowserRepositoryCommandType.PrepareMigration,
    projectId,
    sourceRevision: 7,
    files: [{ path: "README.md", content: "# retry import\n" }],
    defaultBranch: BrowserGitMigrationDefaults.Branch,
    message: BrowserGitMigrationDefaults.CommitMessage,
    author: { name: "Migration User", email: "migration@example.com" },
  }));
  const retryRepository = createBrowserGitProjectRepository({
    descriptor: { projectId, storageKind: ProjectStorageKind.BrowserGit, revision: 7 },
    client,
  });
  const retryWorkspace = await retryRepository.readWorkspace();
  const retryStatus = await retryRepository.gitStatus();
  const retryLog = await retryRepository.gitLog({ depth: 10 });
  client.dispose();

  const reopenedClient = createBrowserGitWorkerClient();
  const reopened = createBrowserGitProjectRepository({
    descriptor: { projectId, storageKind: ProjectStorageKind.BrowserGit, revision: 7 },
    client: reopenedClient,
  });
  const reopenedWorkspace = await reopened.readWorkspace();
  reopenedClient.dispose();

  const emptyClient = createBrowserGitWorkerClient();
  const emptyPrepared = BrowserRepositoryResultSchema.prepare_database_migration.parse(
    await emptyClient.execute({
      type: BrowserRepositoryCommandType.PrepareMigration,
      projectId: emptyProjectId,
      sourceRevision: 0,
      files: [],
      defaultBranch: BrowserGitMigrationDefaults.Branch,
      message: BrowserGitMigrationDefaults.CommitMessage,
      author: { name: "Migration User", email: "migration@example.com" },
    }),
  );
  const emptyRepository = createBrowserGitProjectRepository({
    descriptor: { projectId: emptyProjectId, storageKind: ProjectStorageKind.BrowserGit, revision: 0 },
    client: emptyClient,
  });
  const emptyLog = await emptyRepository.gitLog({ depth: 1 });
  emptyClient.dispose();

  return {
    firstPrepared,
    retryPrepared,
    retryWorkspace,
    retryStatus,
    retryLog,
    reopenedWorkspace,
    emptyPrepared,
    emptyLog,
  };
}

declare global {
  interface Window {
    repositoryHarness: {
      runContract(projectId: string): Promise<ContractResult>;
      runPersistence(projectId: string): Promise<unknown>;
      runSharedContract(projectId: string): Promise<unknown>;
      runIsolationAndConcurrency(firstProjectId: string, secondProjectId: string): Promise<unknown>;
      runGitMvp(projectId: string): Promise<unknown>;
      runProvisioning(missingProjectId: string, projectId: string): Promise<unknown>;
      runClientFileTools(projectId: string): Promise<unknown>;
      runClientGitTools(projectId: string): Promise<unknown>;
      runDatabaseMigration(projectId: string, emptyProjectId: string): Promise<unknown>;
    };
  }
}

window.repositoryHarness = {
  runContract,
  runPersistence,
  runSharedContract,
  runIsolationAndConcurrency,
  runGitMvp,
  runProvisioning,
  runClientFileTools,
  runClientGitTools,
  runDatabaseMigration,
};
document.querySelector("#status")!.textContent = "ready";
