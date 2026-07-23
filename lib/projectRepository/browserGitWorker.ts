/**
 * [INPUT]: strict BrowserRepositoryRequest messages from the B-domain repository adapter
 * [OUTPUT]: strict success/error messages containing revisioned workspace operations
 * [POS]: Browser Repository Worker —— browser_git_v1 filesystem and IndexedDB 的唯一 owner
 * [PROTOCOL]: commands are serialized; normal file APIs reject .git/**; mutations require exact CAS
 */
import "./browserWorkerGlobals";
import LightningFS from "@isomorphic-git/lightning-fs";
import * as git from "isomorphic-git";
import {
  BrowserRepositoryCommandSchema,
  BrowserRepositoryCommandType,
  BrowserRepositoryRequestSchema,
  type BrowserRepositoryCommand,
  type BrowserRepositoryResponse,
} from "../../types/browserRepositoryProtocol";
import { ProjectFileOperation } from "../../types/projectFileMutation";
import {
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
  type ProjectFileContent,
  type ProjectTextSearchMatch,
} from "../../types/projectRepository";
import { ProjectRevisionSchema } from "../../types/projectRevision";
import { PreparedBrowserGitMigrationSchema } from "../../types/projectMigration";
import {
  containsUnicodeLineTerminator,
  countUnicodeCodePoints,
  SearchTextLimits,
} from "../../types/tool";

const WORKSPACE_DIR = "/workspace";
const METADATA_DIR = "/metadata";
const REVISION_FILE = `${METADATA_DIR}/revision`;
const NAMESPACE_PREFIX = "web-cursor-browser-git-v1-";
// Mirrors isomorphic-git 1.38.7's internal isValidRef(..., true) rule used by branch APIs.
// eslint-disable-next-line no-control-regex
const INVALID_GIT_BRANCH = /(^|[/.])([/.]|$)|^@$|@{|[\x00-\x20\x7f~^:?*[\\]|\.lock(\/|$)/;

type BrowserFs = InstanceType<typeof LightningFS>["promises"];
type RepositoryContext = {
  fs: BrowserFs;
  gitFs: InstanceType<typeof LightningFS>;
  revision: number;
};
type FsError = Error & { code: string };

const contexts = new Map<string, Promise<RepositoryContext>>();

function isFsError(error: unknown, code: string): error is FsError {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && error.code === code;
}

function repositoryError(code: ProjectRepositoryErrorCode, message: string): never {
  throw new ProjectRepositoryError(code, message);
}

async function mkdirIfMissing(fs: BrowserFs, path: string): Promise<void> {
  try {
    await fs.mkdir(path);
  } catch (error) {
    if (!isFsError(error, "EEXIST")) throw error;
  }
}

async function pathExists(fs: BrowserFs, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (isFsError(error, "ENOENT")) return false;
    throw error;
  }
}

function parsePersistedRevision(raw: string, projectId: string): number {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return repositoryError(
      ProjectRepositoryErrorCode.ProtocolViolation,
      `project ${projectId} has invalid revision metadata JSON`,
    );
  }
  const parsed = ProjectRevisionSchema.safeParse(value);
  if (!parsed.success) {
    return repositoryError(
      ProjectRepositoryErrorCode.ProtocolViolation,
      `project ${projectId} has invalid revision metadata`,
    );
  }
  return parsed.data;
}

async function openRepository(projectId: string, initialRevision: number): Promise<RepositoryContext> {
  const gitFs = new LightningFS(`${NAMESPACE_PREFIX}${projectId}`);
  const fs = gitFs.promises;
  if (!await pathExists(fs, REVISION_FILE)) {
    repositoryError(
      ProjectRepositoryErrorCode.LocalRepositoryMissing,
      `project ${projectId} has no local Browser Git repository`,
    );
  }
  const revision = parsePersistedRevision(await fs.readFile(REVISION_FILE, "utf8"), projectId);

  if (revision < initialRevision) {
    repositoryError(
      ProjectRepositoryErrorCode.StaleSnapshot,
      `local revision ${revision} is behind descriptor revision ${initialRevision}`,
    );
  }
  return { fs, gitFs, revision };
}

async function provisionRepository(projectId: string): Promise<RepositoryContext> {
  const existing = contexts.get(projectId);
  if (existing) return existing;

  const created = (async () => {
    const gitFs = new LightningFS(`${NAMESPACE_PREFIX}${projectId}`);
    const fs = gitFs.promises;
    const hasRevision = await pathExists(fs, REVISION_FILE);
    if (!hasRevision) {
      await mkdirIfMissing(fs, WORKSPACE_DIR);
      await mkdirIfMissing(fs, METADATA_DIR);
      await fs.writeFile(REVISION_FILE, "0", "utf8");
      await fs.flush();
      return { fs, gitFs, revision: 0 };
    }
    const revision = parsePersistedRevision(await fs.readFile(REVISION_FILE, "utf8"), projectId);
    return { fs, gitFs, revision };
  })();
  contexts.set(projectId, created);
  created.catch(() => contexts.delete(projectId));
  return created;
}

async function resetRepository(projectId: string, revision: number): Promise<RepositoryContext> {
  const namespace = `${NAMESPACE_PREFIX}${projectId}`;
  const reset = (async () => {
    const existing = contexts.get(projectId);
    const gitFs = existing ? (await existing).gitFs : new LightningFS(namespace);
    await gitFs.promises.init(namespace, { wipe: true });
    const fs = gitFs.promises;
    await mkdirIfMissing(fs, WORKSPACE_DIR);
    await mkdirIfMissing(fs, METADATA_DIR);
    await fs.writeFile(REVISION_FILE, JSON.stringify(revision), "utf8");
    await fs.flush();
    return { fs, gitFs, revision };
  })();
  contexts.set(projectId, reset);
  reset.catch(() => contexts.delete(projectId));
  return reset;
}

function getContext(projectId: string, initialRevision?: number): Promise<RepositoryContext> {
  const existing = contexts.get(projectId);
  if (existing) {
    return existing.then((context) => {
      if (initialRevision !== undefined && context.revision < initialRevision) {
        repositoryError(
          ProjectRepositoryErrorCode.StaleSnapshot,
          `open context revision ${context.revision} is behind descriptor revision ${initialRevision}`,
        );
      }
      return context;
    });
  }
  if (initialRevision === undefined) {
    return Promise.reject(new ProjectRepositoryError(
      ProjectRepositoryErrorCode.ProtocolViolation,
      `project ${projectId} must be opened before file commands`,
    ));
  }
  const created = openRepository(projectId, initialRevision);
  contexts.set(projectId, created);
  created.catch(() => contexts.delete(projectId));
  return created;
}

function validateWorkspacePath(path: string): void {
  if (
    path.length === 0
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("//")
    || path.includes("\0")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    repositoryError(ProjectRepositoryErrorCode.BadPath, `invalid workspace path: ${path}`);
  }
  if (
    path === ".git"
    || path.startsWith(".git/")
    || path === "node_modules"
    || path.startsWith("node_modules/")
  ) {
    repositoryError(ProjectRepositoryErrorCode.ReservedPath, `reserved workspace path: ${path}`);
  }
}

function workspacePath(path: string): string {
  validateWorkspacePath(path);
  return `${WORKSPACE_DIR}/${path}`;
}

function parentDirectories(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => `${WORKSPACE_DIR}/${parts.slice(0, index + 1).join("/")}`);
}

async function ensureParentDirectories(fs: BrowserFs, path: string): Promise<void> {
  for (const directory of parentDirectories(path)) await mkdirIfMissing(fs, directory);
}

async function pruneEmptyParentDirectories(fs: BrowserFs, path: string): Promise<void> {
  const directories = parentDirectories(path).reverse();
  for (const directory of directories) {
    try {
      await fs.rmdir(directory);
    } catch (error) {
      if (isFsError(error, "ENOTEMPTY")) return;
      if (!isFsError(error, "ENOENT")) throw error;
    }
  }
}

function updatedAtFromMtime(mtimeMs: unknown, path: string): string {
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) {
    return repositoryError(
      ProjectRepositoryErrorCode.ProtocolViolation,
      `filesystem returned invalid mtime for ${path}`,
    );
  }
  return new Date(mtimeMs).toISOString();
}

async function listWorkspaceFiles(fs: BrowserFs): Promise<ProjectFileContent[]> {
  const files: ProjectFileContent[] = [];

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = (await fs.readdir(directory)).sort();
    for (const entry of entries) {
      if (relativeDirectory === "" && entry === ".git") continue;
      const absolutePath = `${directory}/${entry}`;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const stat = await fs.stat(absolutePath);
      if (stat.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        files.push({
          path: relativePath,
          content: await fs.readFile(absolutePath, "utf8"),
          updatedAt: updatedAtFromMtime(stat.mtimeMs, relativePath),
        });
      } else {
        repositoryError(
          ProjectRepositoryErrorCode.ProtocolViolation,
          `unsupported filesystem entry type at ${relativePath}`,
        );
      }
    }
  }

  await visit(WORKSPACE_DIR, "");
  return files;
}

async function requireFile(fs: BrowserFs, path: string): Promise<{ content: string; updatedAt: string }> {
  const absolutePath = workspacePath(path);
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      repositoryError(ProjectRepositoryErrorCode.NotFound, `file not found: ${path}`);
    }
    return {
      content: await fs.readFile(absolutePath, "utf8"),
      updatedAt: updatedAtFromMtime(stat.mtimeMs, path),
    };
  } catch (error) {
    if (isFsError(error, "ENOENT")) {
      repositoryError(ProjectRepositoryErrorCode.NotFound, `file not found: ${path}`);
    }
    throw error;
  }
}

function requireExpectedRevision(context: RepositoryContext, expectedRevision: number): void {
  if (context.revision !== expectedRevision) {
    repositoryError(
      ProjectRepositoryErrorCode.RevisionConflict,
      `repository is at revision ${context.revision}; expected ${expectedRevision}`,
    );
  }
}

async function persistNextRevision(context: RepositoryContext, expectedRevision: number): Promise<number> {
  const revision = expectedRevision + 1;
  ProjectRevisionSchema.parse(revision);
  await context.fs.writeFile(REVISION_FILE, JSON.stringify(revision), "utf8");
  await context.fs.flush();
  context.revision = revision;
  return revision;
}

function validateSearchQuery(query: string): void {
  if (
    query.length === 0
    || query.trim().length === 0
    || query.includes("\0")
    || containsUnicodeLineTerminator(query)
    || countUnicodeCodePoints(query) > SearchTextLimits.QueryCodePoints
  ) {
    repositoryError(
      ProjectRepositoryErrorCode.BadSearchQuery,
      "search query must be non-empty, single-line text within the configured limit",
    );
  }
}

function textSearchSnippet(line: string, matchIndex: number, query: string): string {
  const width = SearchTextLimits.SnippetCodePoints;
  const lineCodePoints = Array.from(line);
  if (lineCodePoints.length <= width) return line;
  const matchCodePointIndex = countUnicodeCodePoints(line.slice(0, matchIndex));
  const queryCodePoints = countUnicodeCodePoints(query);
  const before = Math.floor((width - queryCodePoints) / 2);
  const start = Math.max(0, Math.min(matchCodePointIndex - before, lineCodePoints.length - width));
  const end = start + width;
  return `${start > 0 ? "…" : ""}${lineCodePoints.slice(start, end).join("")}${end < lineCodePoints.length ? "…" : ""}`;
}

function searchFiles(files: ProjectFileContent[], query: string) {
  const matches: ProjectTextSearchMatch[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r\n|[\n\r\u2028\u2029]/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      let from = 0;
      while (from < lines[lineIndex].length) {
        const matchIndex = lines[lineIndex].indexOf(query, from);
        if (matchIndex === -1) break;
        matches.push({
          path: file.path,
          line: lineIndex + 1,
          column: matchIndex + 1,
          snippet: textSearchSnippet(lines[lineIndex], matchIndex, query),
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

async function requireGitRepository(context: RepositoryContext): Promise<void> {
  if (!await pathExists(context.fs, `${WORKSPACE_DIR}/.git/HEAD`)) {
    repositoryError(
      ProjectRepositoryErrorCode.RepositoryNotInitialized,
      "Git repository has not been initialized",
    );
  }
}

async function readGitStatus(context: RepositoryContext) {
  await requireGitRepository(context);
  const matrix = await git.statusMatrix({
    fs: context.gitFs,
    dir: WORKSPACE_DIR,
  });
  await context.fs.flush();
  return {
    files: matrix.map(([path, head, workdir, stage]) => ({ path, head, workdir, stage })),
  };
}

async function findGitStatusFile(context: RepositoryContext, path: string) {
  validateWorkspacePath(path);
  const status = await readGitStatus(context);
  const file = status.files.find((candidate) => candidate.path === path);
  if (!file) repositoryError(ProjectRepositoryErrorCode.NotFound, `Git status path not found: ${path}`);
  return file;
}

async function prepareDatabaseMigration(
  command: Extract<BrowserRepositoryCommand, { type: typeof BrowserRepositoryCommandType.PrepareMigration }>,
) {
  if (INVALID_GIT_BRANCH.test(command.defaultBranch)) {
    repositoryError(
      ProjectRepositoryErrorCode.BadGitRef,
      `invalid Git branch name: ${command.defaultBranch}`,
    );
  }

  const paths = new Set<string>();
  for (const file of command.files) {
    validateWorkspacePath(file.path);
    if (paths.has(file.path)) {
      repositoryError(ProjectRepositoryErrorCode.Conflict, `duplicate migration path: ${file.path}`);
    }
    paths.add(file.path);
  }

  const context = await resetRepository(command.projectId, command.sourceRevision);
  for (const file of command.files) {
    await ensureParentDirectories(context.fs, file.path);
    await context.fs.writeFile(workspacePath(file.path), file.content, "utf8");
  }

  await git.init({
    fs: context.gitFs,
    dir: WORKSPACE_DIR,
    defaultBranch: command.defaultBranch,
  });
  for (const file of command.files) {
    await git.add({ fs: context.gitFs, dir: WORKSPACE_DIR, filepath: file.path });
  }
  const importCommitOid = await git.commit({
    fs: context.gitFs,
    dir: WORKSPACE_DIR,
    message: command.message,
    author: command.author,
  });
  await context.fs.flush();

  const actualFiles = (await listWorkspaceFiles(context.fs))
    .map(({ path, content }) => ({ path, content }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expectedFiles = command.files
    .map(({ path, content }) => ({ path, content }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    repositoryError(ProjectRepositoryErrorCode.ProtocolViolation, "migration workspace verification failed");
  }

  const status = await readGitStatus(context);
  if (status.files.some((file) => file.head !== 1 || file.workdir !== 1 || file.stage !== 1)) {
    repositoryError(ProjectRepositoryErrorCode.ProtocolViolation, "migration Git index is not clean");
  }
  const branch = await git.currentBranch({ fs: context.gitFs, dir: WORKSPACE_DIR });
  if (branch !== command.defaultBranch) {
    repositoryError(
      ProjectRepositoryErrorCode.ProtocolViolation,
      `migration branch is ${String(branch)}; expected ${command.defaultBranch}`,
    );
  }
  const [head] = await git.log({ fs: context.gitFs, dir: WORKSPACE_DIR, depth: 1 });
  if (!head || head.oid !== importCommitOid) {
    repositoryError(ProjectRepositoryErrorCode.ProtocolViolation, "migration HEAD verification failed");
  }

  return PreparedBrowserGitMigrationSchema.parse({
    sourceRevision: command.sourceRevision,
    localRevision: context.revision,
    branch,
    importCommitOid,
    fileCount: actualFiles.length,
  });
}

function isGitError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && error.code === code;
}

async function execute(command: BrowserRepositoryCommand): Promise<unknown> {
  if (command.type === BrowserRepositoryCommandType.Provision) {
    const context = await provisionRepository(command.projectId);
    return { revision: context.revision };
  }
  if (command.type === BrowserRepositoryCommandType.Open) {
    const context = await getContext(command.projectId, command.initialRevision);
    return { revision: context.revision };
  }
  if (command.type === BrowserRepositoryCommandType.PrepareMigration) {
    return prepareDatabaseMigration(command);
  }

  const context = await getContext(command.projectId);
  switch (command.type) {
    case BrowserRepositoryCommandType.ListFiles: {
      const files = await listWorkspaceFiles(context.fs);
      return {
        revision: context.revision,
        files: files.map(({ path, updatedAt }) => ({ path, updatedAt })),
      };
    }
    case BrowserRepositoryCommandType.ReadWorkspace:
      return { revision: context.revision, files: await listWorkspaceFiles(context.fs) };
    case BrowserRepositoryCommandType.ReadFile: {
      const file = await requireFile(context.fs, command.path);
      return { ...file, path: command.path, revision: context.revision };
    }
    case BrowserRepositoryCommandType.SearchText: {
      validateSearchQuery(command.query);
      const result = searchFiles(await listWorkspaceFiles(context.fs), command.query);
      return { revision: context.revision, ...result };
    }
    case BrowserRepositoryCommandType.WriteFile: {
      requireExpectedRevision(context, command.expectedRevision);
      const absolutePath = workspacePath(command.path);
      if (await pathExists(context.fs, absolutePath)) {
        const existing = await context.fs.stat(absolutePath);
        if (!existing.isFile()) {
          repositoryError(ProjectRepositoryErrorCode.Conflict, `directory already exists: ${command.path}`);
        }
      }
      await ensureParentDirectories(context.fs, command.path);
      await context.fs.writeFile(absolutePath, command.content, "utf8");
      const revision = await persistNextRevision(context, command.expectedRevision);
      const file = await requireFile(context.fs, command.path);
      return {
        operation: ProjectFileOperation.Write,
        path: command.path,
        revision,
        file: { path: command.path, ...file },
      };
    }
    case BrowserRepositoryCommandType.DeleteFile: {
      requireExpectedRevision(context, command.expectedRevision);
      const absolutePath = workspacePath(command.path);
      if (!await pathExists(context.fs, absolutePath)) {
        repositoryError(ProjectRepositoryErrorCode.NotFound, `file not found: ${command.path}`);
      }
      const stat = await context.fs.stat(absolutePath);
      if (!stat.isFile()) repositoryError(ProjectRepositoryErrorCode.NotFound, `file not found: ${command.path}`);
      await context.fs.unlink(absolutePath);
      await pruneEmptyParentDirectories(context.fs, command.path);
      const revision = await persistNextRevision(context, command.expectedRevision);
      return { operation: ProjectFileOperation.Delete, path: command.path, revision };
    }
    case BrowserRepositoryCommandType.RenameFile: {
      requireExpectedRevision(context, command.expectedRevision);
      const oldPath = workspacePath(command.oldPath);
      const newPath = workspacePath(command.newPath);
      if (!await pathExists(context.fs, oldPath)) {
        repositoryError(ProjectRepositoryErrorCode.NotFound, `file not found: ${command.oldPath}`);
      }
      const source = await context.fs.stat(oldPath);
      if (!source.isFile()) {
        repositoryError(ProjectRepositoryErrorCode.NotFound, `file not found: ${command.oldPath}`);
      }
      if (await pathExists(context.fs, newPath)) {
        repositoryError(ProjectRepositoryErrorCode.Conflict, `file already exists: ${command.newPath}`);
      }
      await ensureParentDirectories(context.fs, command.newPath);
      await context.fs.rename(oldPath, newPath);
      await pruneEmptyParentDirectories(context.fs, command.oldPath);
      const revision = await persistNextRevision(context, command.expectedRevision);
      const file = await requireFile(context.fs, command.newPath);
      return {
        operation: ProjectFileOperation.Rename,
        oldPath: command.oldPath,
        path: command.newPath,
        revision,
        file: { path: command.newPath, updatedAt: file.updatedAt },
      };
    }
    case BrowserRepositoryCommandType.GitInit: {
      if (INVALID_GIT_BRANCH.test(command.defaultBranch)) {
        repositoryError(
          ProjectRepositoryErrorCode.BadGitRef,
          `invalid Git branch name: ${command.defaultBranch}`,
        );
      }
      const headPath = `${WORKSPACE_DIR}/.git/HEAD`;
      if (await pathExists(context.fs, headPath)) {
        const branch = await git.currentBranch({ fs: context.gitFs, dir: WORKSPACE_DIR });
        if (branch !== command.defaultBranch) {
          repositoryError(
            ProjectRepositoryErrorCode.Conflict,
            `repository is already initialized on ${String(branch)}; requested ${command.defaultBranch}`,
          );
        }
        return { initialized: true, branch };
      }
      try {
        await git.init({
          fs: context.gitFs,
          dir: WORKSPACE_DIR,
          defaultBranch: command.defaultBranch,
        });
      } catch (error) {
        if (isGitError(error, "InvalidRefNameError")) {
          repositoryError(ProjectRepositoryErrorCode.BadGitRef, error instanceof Error ? error.message : "invalid Git ref");
        }
        throw error;
      }
      await context.fs.flush();
      const branch = await git.currentBranch({ fs: context.gitFs, dir: WORKSPACE_DIR });
      if (!branch) {
        repositoryError(ProjectRepositoryErrorCode.ProtocolViolation, "git init did not create a current branch");
      }
      return { initialized: true, branch };
    }
    case BrowserRepositoryCommandType.GitStatus:
      return readGitStatus(context);
    case BrowserRepositoryCommandType.GitStage: {
      const file = await findGitStatusFile(context, command.path);
      if (file.workdir === 0) {
        await git.remove({ fs: context.gitFs, dir: WORKSPACE_DIR, filepath: command.path });
      } else {
        await git.add({ fs: context.gitFs, dir: WORKSPACE_DIR, filepath: command.path });
      }
      await context.fs.flush();
      return readGitStatus(context);
    }
    case BrowserRepositoryCommandType.GitUnstage: {
      const file = await findGitStatusFile(context, command.path);
      if (file.head === 0) {
        await git.remove({ fs: context.gitFs, dir: WORKSPACE_DIR, filepath: command.path });
      } else {
        await git.resetIndex({ fs: context.gitFs, dir: WORKSPACE_DIR, filepath: command.path });
      }
      await context.fs.flush();
      return readGitStatus(context);
    }
    case BrowserRepositoryCommandType.GitCommit: {
      await requireGitRepository(context);
      const status = await readGitStatus(context);
      if (!status.files.some((file) => file.head !== file.stage)) {
        repositoryError(ProjectRepositoryErrorCode.NothingToCommit, "Git index has no staged changes");
      }
      const oid = await git.commit({
        fs: context.gitFs,
        dir: WORKSPACE_DIR,
        message: command.message,
        author: command.author,
      });
      await context.fs.flush();
      return { oid };
    }
    case BrowserRepositoryCommandType.GitLog: {
      await requireGitRepository(context);
      const branch = await git.currentBranch({
        fs: context.gitFs,
        dir: WORKSPACE_DIR,
        test: true,
      });
      if (!branch) return { commits: [] };
      const entries = await git.log({
        fs: context.gitFs,
        dir: WORKSPACE_DIR,
        depth: command.depth,
      });
      return {
        commits: entries.map(({ oid, commit }) => ({
          oid,
          message: commit.message,
          parent: commit.parent,
          author: commit.author,
        })),
      };
    }
    case BrowserRepositoryCommandType.GitCurrentBranch: {
      await requireGitRepository(context);
      const branch = await git.currentBranch({ fs: context.gitFs, dir: WORKSPACE_DIR });
      return { branch: branch ?? null };
    }
    default:
      return command satisfies never;
  }
}

function errorResponse(id: string, error: unknown): BrowserRepositoryResponse {
  if (error instanceof ProjectRepositoryError) {
    return { id, ok: false, error: { code: error.code, message: error.message } };
  }
  return {
    id,
    ok: false,
    error: {
      code: ProjectRepositoryErrorCode.InternalError,
      message: error instanceof Error ? error.message : "unknown worker failure",
    },
  };
}

let commandQueue = Promise.resolve();

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const parsed = BrowserRepositoryRequestSchema.safeParse(event.data);
  if (!parsed.success) {
    console.error("PROTOCOL_VIOLATION: invalid Browser Repository request", parsed.error);
    return;
  }
  const { id, command } = parsed.data;
  const run = async () => {
    let response: BrowserRepositoryResponse;
    try {
      BrowserRepositoryCommandSchema.parse(command);
      response = { id, ok: true, result: await execute(command) };
    } catch (error) {
      response = errorResponse(id, error);
    }
    self.postMessage(response);
  };
  commandQueue = commandQueue.then(run, run);
});
