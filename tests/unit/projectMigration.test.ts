import { describe, expect, it } from "vitest";
import {
  ActivateBrowserGitMigrationBodySchema,
} from "../../types/projectMigration";
import {
  executeProjectStorageMigration,
  ProjectStorageMigrationError,
  ProjectStorageMigrationErrorCode,
} from "../../server/projectStorageMigrationTransaction";
import { ProjectStorageKind } from "../../types/projectStorage";

const oid = "0123456789abcdef0123456789abcdef01234567";

describe("ActivateBrowserGitMigrationBodySchema", () => {
  it("accepts only the explicit Database source revision continuation", () => {
    expect(ActivateBrowserGitMigrationBodySchema.parse({
      sourceRevision: 7,
      localRevision: 7,
      importCommitOid: oid,
    })).toEqual({
      sourceRevision: 7,
      localRevision: 7,
      importCommitOid: oid,
    });
  });

  it.each([
    { action: "activate_browser_git_v1", sourceRevision: 7, localRevision: 7, importCommitOid: oid },
    { sourceRevision: 7, localRevision: 8, importCommitOid: oid },
    { sourceRevision: 7, localRevision: 7, importCommitOid: "not-an-oid" },
    { sourceRevision: 7, localRevision: 7, importCommitOid: oid, force: true },
  ])("rejects an invalid or guessed migration contract", (body) => {
    expect(ActivateBrowserGitMigrationBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("executeProjectStorageMigration", () => {
  it("returns the CAS-activated project without inspecting a fallback state", async () => {
    let inspected = false;
    const result = await executeProjectStorageMigration({
      sourceRevision: 4,
      transaction: async (operation) => operation({}),
      activate: async () => ({ id: "project", storageKind: ProjectStorageKind.BrowserGit }),
      inspectCurrent: async () => {
        inspected = true;
        return null;
      },
    });

    expect(result).toEqual({ id: "project", storageKind: ProjectStorageKind.BrowserGit });
    expect(inspected).toBe(false);
  });

  it.each([
    [null, ProjectStorageMigrationErrorCode.NotFound],
    [{ storageKind: ProjectStorageKind.BrowserGit, revision: 4 }, ProjectStorageMigrationErrorCode.StorageConflict],
    [{ storageKind: ProjectStorageKind.Database, revision: 5 }, ProjectStorageMigrationErrorCode.RevisionConflict],
    [{ storageKind: ProjectStorageKind.Database, revision: 4 }, ProjectStorageMigrationErrorCode.ActivationFailed],
  ] as const)("exposes the exact failed CAS reason", async (current, code) => {
    const error = await executeProjectStorageMigration({
      sourceRevision: 4,
      transaction: async (operation) => operation({}),
      activate: async () => null,
      inspectCurrent: async () => current,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ProjectStorageMigrationError);
    expect(error.code).toBe(code);
  });
});
