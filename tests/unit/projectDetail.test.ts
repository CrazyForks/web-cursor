import { describe, expect, it } from "vitest";
import { ProjectDetailSchema } from "../../lib/projectTypes";
import { ProjectStorageKind } from "../../types/projectStorage";

const common = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "demo",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  conversations: [],
};

describe("ProjectDetailSchema", () => {
  it("requires Database detail to expose code revision and files", () => {
    expect(ProjectDetailSchema.parse({
      ...common,
      storageKind: ProjectStorageKind.Database,
      codeRevision: 3,
      files: [],
    })).toMatchObject({
      storageKind: ProjectStorageKind.Database,
      codeRevision: 3,
      files: [],
    });
  });

  it("does not disguise Browser Git as an empty Database file list", () => {
    expect(ProjectDetailSchema.safeParse({
      ...common,
      storageKind: ProjectStorageKind.BrowserGit,
      codeRevision: 0,
      files: [],
    }).success).toBe(false);

    expect(ProjectDetailSchema.parse({
      ...common,
      storageKind: ProjectStorageKind.BrowserGit,
    })).toMatchObject({
      storageKind: ProjectStorageKind.BrowserGit,
    });
  });

  it("rejects unknown storage kinds instead of falling back to Database", () => {
    expect(ProjectDetailSchema.safeParse({
      ...common,
      storageKind: "unknown_v1",
      codeRevision: 0,
      files: [],
    }).success).toBe(false);
  });
});
