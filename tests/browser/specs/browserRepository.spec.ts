import { expect, test } from "@playwright/test";

test("Browser Repository Worker enforces CAS and reserved paths", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const result = await page.evaluate(async () => {
    return window.repositoryHarness.runContract(crypto.randomUUID());
  });

  expect(result).toEqual({
    initialRevision: 0,
    finalRevision: 2,
    files: [{ path: "b.txt", content: "alpha" }],
    staleRejected: true,
    gitPathRejected: true,
    nodeModulesPathRejected: true,
    allGitPathOperationsRejected: true,
  });
});

test("Browser Repository survives Worker restart through IndexedDB", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const snapshot = await page.evaluate(async () => {
    return window.repositoryHarness.runPersistence(crypto.randomUUID());
  });

  expect(snapshot).toMatchObject({
    revision: 1,
    files: [{ path: "persisted.txt", content: "still here" }],
  });
});

test("Browser adapter passes the shared ProjectRepository contract", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const result = await page.evaluate(async () => {
    return window.repositoryHarness.runSharedContract(crypto.randomUUID());
  });

  expect(result).toMatchObject({
    initialRevision: 1,
    searchMatched: true,
    previewMatched: true,
    staleRejected: true,
    renameConflictRejected: true,
    finalRevision: 3,
    finalFiles: [{ path: "b.txt", content: "beta" }],
  });
});

test("Browser Worker serializes CAS mutations and isolates project namespaces", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const result = await page.evaluate(async () => {
    return window.repositoryHarness.runIsolationAndConcurrency(
      crypto.randomUUID(),
      crypto.randomUUID(),
    );
  });

  expect(result).toMatchObject({
    fulfilled: 2,
    revisionConflicts: 1,
    first: { revision: 1 },
    second: {
      revision: 1,
      files: [{ path: "second.txt", content: "separate" }],
    },
  });
  expect((result as { first: { files: unknown[] } }).first.files).toHaveLength(1);
});

test("isomorphic-git MVP persists stage, commits, HEAD and log across Worker restart", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const result = await page.evaluate(async () => {
    return window.repositoryHarness.runGitMvp(crypto.randomUUID());
  });

  expect(result).toMatchObject({
    initialized: { initialized: true, branch: "main" },
    badBranchRejected: true,
    gitMetadataStageRejected: true,
    untracked: { files: [{ path: "a.txt", head: 0, workdir: 2, stage: 0 }] },
    staged: { files: [{ path: "a.txt", head: 0, workdir: 2, stage: 2 }] },
    unstaged: { files: [{ path: "a.txt", head: 0, workdir: 2, stage: 0 }] },
    missingAuthorRejected: true,
    emptyCommitRejected: true,
    modifiedStaged: { files: [{ path: "a.txt", head: 1, workdir: 2, stage: 2 }] },
    modifiedUnstaged: { files: [{ path: "a.txt", head: 1, workdir: 2, stage: 1 }] },
    branch: { branch: "main" },
    statusAfterRestart: { files: [{ path: "a.txt", head: 1, workdir: 1, stage: 1 }] },
    logAfterRestart: {
      commits: [
        { message: "update a\n", author: { name: "Browser User", email: "browser@example.com" } },
        { message: "initial commit\n", author: { name: "Browser User", email: "browser@example.com" } },
      ],
    },
    revisionAfterRestart: 2,
  });
  const commits = result as { firstCommit: { oid: string }; secondCommit: { oid: string } };
  expect(commits.firstCommit.oid).toMatch(/^[0-9a-f]{40}$/);
  expect(commits.secondCommit.oid).toMatch(/^[0-9a-f]{40}$/);
  expect(commits.firstCommit.oid).not.toBe(commits.secondCommit.oid);
});

test("Browser Git provisioning is explicit, idempotent, and missing repositories stay missing", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const result = await page.evaluate(async () => {
    return window.repositoryHarness.runProvisioning(
      crypto.randomUUID(),
      crypto.randomUUID(),
    );
  });

  expect(result).toEqual({
    missingRejected: true,
    firstRevision: 0,
    secondRevision: 0,
    branch: { branch: "main" },
    workspace: { revision: 0, files: [] },
  });
});

test("Agent client file tools execute all six operations against Browser Git", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const result = await page.evaluate(async () => {
    return window.repositoryHarness.runClientFileTools(crypto.randomUUID());
  });

  expect(result).toMatchObject({
    list: { status: "ok", tool: "list_files", revision: 0, files: [] },
    write: { status: "ok", tool: "write_file", revision: 1, path: "a.txt" },
    read: { status: "ok", tool: "read_file", revision: 1, path: "a.txt", content: "alpha" },
    search: {
      status: "ok",
      tool: "search_text",
      revision: 1,
      query: "alpha",
      matches: [{ path: "a.txt", line: 1, column: 1 }],
      truncated: false,
    },
    rename: {
      status: "ok",
      tool: "rename_file",
      revision: 2,
      oldPath: "a.txt",
      newPath: "b.txt",
    },
    remove: { status: "ok", tool: "delete_file", revision: 3, path: "b.txt" },
    workspace: { revision: 3, files: [] },
  });
});

test("Agent client Git tools execute against the canonical Browser Git repository", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const result = await page.evaluate(async () => {
    return window.repositoryHarness.runClientGitTools(crypto.randomUUID());
  });

  expect(result).toMatchObject({
    status: {
      status: "ok",
      tool: "git_status",
      files: [{ path: "agent.txt", head: 0, workdir: 2, stage: 0 }],
    },
    stage: {
      status: "ok",
      tool: "git_stage",
      files: [{ path: "agent.txt", head: 0, workdir: 2, stage: 2 }],
    },
    missingAuthor: {
      status: "error",
      tool: "git_commit",
      code: "BAD_ARGS",
    },
    unstage: {
      status: "ok",
      tool: "git_unstage",
      files: [{ path: "agent.txt", head: 0, workdir: 2, stage: 0 }],
    },
    commit: {
      status: "ok",
      tool: "git_commit",
    },
    log: {
      status: "ok",
      tool: "git_log",
      commits: [{
        message: "Agent commit\n",
        author: { name: "Explicit User", email: "user@example.com" },
      }],
    },
    branch: {
      status: "ok",
      tool: "git_current_branch",
      branch: "main",
    },
    finalStatus: {
      status: "ok",
      tool: "git_status",
      files: [],
    },
  });
  expect((result as { commit: { oid: string } }).commit.oid).toMatch(/^[0-9a-f]{40}$/);
});

test("Database migration imports exact files, commits cleanly, wipes retry residue, and persists", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const result = await page.evaluate(async () => {
    return window.repositoryHarness.runDatabaseMigration(crypto.randomUUID(), crypto.randomUUID());
  });

  expect(result).toMatchObject({
    firstPrepared: {
      sourceRevision: 7,
      localRevision: 7,
      branch: "main",
      fileCount: 2,
    },
    retryPrepared: {
      sourceRevision: 7,
      localRevision: 7,
      branch: "main",
      fileCount: 1,
    },
    retryWorkspace: {
      revision: 7,
      files: [{ path: "README.md", content: "# retry import\n" }],
    },
    retryStatus: { files: [{ path: "README.md", head: 1, workdir: 1, stage: 1 }] },
    retryLog: {
      commits: [{ message: "Import existing Web Cursor project\n" }],
    },
    reopenedWorkspace: {
      revision: 7,
      files: [{ path: "README.md", content: "# retry import\n" }],
    },
    emptyPrepared: {
      sourceRevision: 0,
      localRevision: 0,
      branch: "main",
      fileCount: 0,
    },
    emptyLog: { commits: [{ message: "Import existing Web Cursor project\n" }] },
  });
  expect((result as { retryPrepared: { importCommitOid: string } }).retryPrepared.importCommitOid)
    .toMatch(/^[0-9a-f]{40}$/);
});
