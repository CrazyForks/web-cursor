import { describe, expect, it } from "vitest";
import { projectRepositoryContract } from "../contracts/projectRepositoryContract";
import { createDatabaseProjectRepository } from "../../lib/projectRepository/database";
import { createProjectRepository } from "../../lib/projectRepository/create";
import { ProjectStorageKind } from "../../types/projectStorage";
import type { DatabaseProjectRepositoryTransport } from "../../types/projectRepository";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const INITIAL_UPDATED_AT = "2026-01-01T00:00:00.000Z";

function createMemoryDatabaseTransport(): DatabaseProjectRepositoryTransport {
  let revision = 0;
  const files = new Map([["a.txt", { content: "alpha", updatedAt: INITIAL_UPDATED_AT }]]);

  function summaries(includeContent: boolean) {
    return [...files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, file]) => includeContent
        ? { path, content: file.content, updatedAt: file.updatedAt }
        : { path, updatedAt: file.updatedAt });
  }

  function requireRevision(value: unknown) {
    if (value !== revision) throw new Error(`REVISION_CONFLICT: current=${revision}, expected=${String(value)}`);
  }

  return async (method, path, body) => {
    if (method === "GET" && path === `/api/projects/${PROJECT_ID}/files`) {
      return { revision, files: summaries(false) };
    }
    if (method === "GET" && path === `/api/projects/${PROJECT_ID}/files?includeContent=1`) {
      return { revision, files: summaries(true) };
    }
    if (method === "GET" && path.startsWith(`/api/projects/${PROJECT_ID}/files/content?path=`)) {
      const filePath = new URL(path, "https://repository.test").searchParams.get("path") ?? "";
      const file = files.get(filePath);
      if (!file) throw new Error(`NOT_FOUND: ${filePath}`);
      return { path: filePath, ...file, revision };
    }
    if (method === "GET" && path.startsWith(`/api/projects/${PROJECT_ID}/files/search?query=`)) {
      const query = new URL(path, "https://repository.test").searchParams.get("query") ?? "";
      const matches = [...files.entries()].flatMap(([filePath, file]) => {
        const column = file.content.indexOf(query);
        return column === -1
          ? []
          : [{ path: filePath, line: 1, column: column + 1, snippet: file.content }];
      });
      return { revision, matches, truncated: false };
    }

    const input = body as Record<string, unknown>;
    requireRevision(input.expectedRevision);

    if (method === "POST" && path === `/api/projects/${PROJECT_ID}/files/content`) {
      const filePath = String(input.path);
      if (input.action === "write") {
        revision += 1;
        const file = { content: String(input.content), updatedAt: INITIAL_UPDATED_AT };
        files.set(filePath, file);
        return { path: filePath, ...file, revision };
      }
      if (input.action === "delete") {
        if (!files.has(filePath)) throw new Error(`NOT_FOUND: ${filePath}`);
        revision += 1;
        files.delete(filePath);
        return { ok: true, path: filePath, revision };
      }
    }

    if (method === "POST" && path === `/api/projects/${PROJECT_ID}/files/rename`) {
      const oldPath = String(input.oldPath);
      const newPath = String(input.newPath);
      if (files.has(newPath)) throw new Error(`CONFLICT: ${newPath}`);
      const file = files.get(oldPath);
      if (!file) throw new Error(`NOT_FOUND: ${oldPath}`);
      revision += 1;
      files.delete(oldPath);
      files.set(newPath, file);
      return { path: newPath, updatedAt: file.updatedAt, revision };
    }

    throw new Error(`Unexpected repository request: ${method} ${path}`);
  };
}

projectRepositoryContract("Database", {
  createRepository: () => createDatabaseProjectRepository({
    projectId: PROJECT_ID,
    initialRevision: 0,
    transport: createMemoryDatabaseTransport(),
  }),
});

describe("DatabaseProjectRepository response contract", () => {
  it("rejects an undeclared response shape instead of guessing fields", async () => {
    const repository = createDatabaseProjectRepository({
      projectId: PROJECT_ID,
      initialRevision: 0,
      transport: async () => ({ revision: 0, entries: [] }),
    });

    await expect(repository.listFiles()).rejects.toThrow();
  });

  it("rejects a late snapshot older than its accepted revision", async () => {
    let returnOldSnapshot = false;
    const currentTransport = createMemoryDatabaseTransport();
    const repository = createDatabaseProjectRepository({
      projectId: PROJECT_ID,
      initialRevision: 0,
      transport: async (method, path, body) => returnOldSnapshot
        ? { revision: 0, files: [] }
        : currentTransport(method, path, body),
    });

    await repository.writeFile({ path: "b.txt", content: "beta", expectedRevision: 0 });
    returnOldSnapshot = true;

    await expect(repository.listFiles()).rejects.toThrow("STALE_SNAPSHOT");
    expect(repository.getRevision()).toBe(1);
  });

  it("rejects a mutation response that changes the requested path", async () => {
    const repository = createDatabaseProjectRepository({
      projectId: PROJECT_ID,
      initialRevision: 0,
      transport: async () => ({
        path: "unexpected.txt",
        content: "beta",
        updatedAt: INITIAL_UPDATED_AT,
        revision: 1,
      }),
    });

    await expect(repository.writeFile({
      path: "b.txt",
      content: "beta",
      expectedRevision: 0,
    })).rejects.toThrow("PROTOCOL_VIOLATION");
    expect(repository.getRevision()).toBe(0);
  });

  it("rejects a mutation response that skips the exact next revision", async () => {
    const repository = createDatabaseProjectRepository({
      projectId: PROJECT_ID,
      initialRevision: 0,
      transport: async () => ({
        path: "b.txt",
        content: "beta",
        updatedAt: INITIAL_UPDATED_AT,
        revision: 2,
      }),
    });

    await expect(repository.writeFile({
      path: "b.txt",
      content: "beta",
      expectedRevision: 0,
    })).rejects.toThrow("PROTOCOL_VIOLATION");
    expect(repository.getRevision()).toBe(0);
  });

  it("declares its storage kind explicitly", () => {
    const repository = createDatabaseProjectRepository({
      projectId: PROJECT_ID,
      initialRevision: 0,
      transport: createMemoryDatabaseTransport(),
    });

    expect(repository.storageKind).toBe(ProjectStorageKind.Database);
  });
});

describe("createProjectRepository", () => {
  it("dispatches Database explicitly", () => {
    const repository = createProjectRepository({
      descriptor: {
        projectId: PROJECT_ID,
        storageKind: ProjectStorageKind.Database,
        revision: 0,
      },
      databaseTransport: createMemoryDatabaseTransport(),
    });

    expect(repository.storageKind).toBe(ProjectStorageKind.Database);
  });

  it("fails explicitly while the Browser Git adapter is unavailable", () => {
    expect(() => createProjectRepository({
      descriptor: {
        projectId: PROJECT_ID,
        storageKind: ProjectStorageKind.BrowserGit,
        revision: 0,
      },
      databaseTransport: createMemoryDatabaseTransport(),
    })).toThrow("UNSUPPORTED_STORAGE");
  });
});
