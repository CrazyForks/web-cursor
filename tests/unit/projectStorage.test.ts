import { describe, expect, it } from "vitest";
import {
  CreateProjectBodySchema,
  ProjectStorageKind,
  ProjectStorageKindSchema,
} from "../../types/projectStorage";

describe("ProjectStorageKindSchema", () => {
  it.each([
    ProjectStorageKind.Database,
    ProjectStorageKind.BrowserGit,
  ])("accepts the declared storage kind %s", (storageKind) => {
    expect(ProjectStorageKindSchema.parse(storageKind)).toBe(storageKind);
  });

  it.each([undefined, null, "", "git", "database", "unknown_v1"])(
    "rejects an undeclared storage kind: %s",
    (storageKind) => {
      expect(() => ProjectStorageKindSchema.parse(storageKind)).toThrow();
    },
  );
});

describe("CreateProjectBodySchema", () => {
  it("requires the caller to select a storage kind explicitly", () => {
    expect(() => CreateProjectBodySchema.parse({ title: "demo" })).toThrow();
  });

  it("accepts a strict project creation contract", () => {
    expect(CreateProjectBodySchema.parse({
      title: "demo",
      storageKind: ProjectStorageKind.Database,
    })).toEqual({
      title: "demo",
      storageKind: ProjectStorageKind.Database,
    });
  });

  it("requires a client-generated project id for Browser Git creation", () => {
    expect(CreateProjectBodySchema.parse({
      id: "166837f7-3342-4644-a372-8ca180dbad0a",
      title: "demo",
      storageKind: ProjectStorageKind.BrowserGit,
    })).toEqual({
      id: "166837f7-3342-4644-a372-8ca180dbad0a",
      title: "demo",
      storageKind: ProjectStorageKind.BrowserGit,
    });

    expect(() => CreateProjectBodySchema.parse({
      title: "demo",
      storageKind: ProjectStorageKind.BrowserGit,
    })).toThrow();
  });

  it("rejects a client-generated id for Database creation", () => {
    expect(() => CreateProjectBodySchema.parse({
      id: "166837f7-3342-4644-a372-8ca180dbad0a",
      title: "demo",
      storageKind: ProjectStorageKind.Database,
    })).toThrow();
  });

  it("rejects unknown fields instead of guessing their meaning", () => {
    expect(() => CreateProjectBodySchema.parse({
      title: "demo",
      storageKind: ProjectStorageKind.Database,
      gitEnabled: false,
    })).toThrow();
  });
});
