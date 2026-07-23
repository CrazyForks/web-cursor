import { describe, expect, it } from "vitest";
import type { ProjectRepository } from "../../types/projectRepository";
import { runPortableProjectRepositoryContract } from "./projectRepositoryContractRunner";

export type ProjectRepositoryContractHarness = {
  createRepository(): ProjectRepository;
};

export function projectRepositoryContract(
  name: string,
  harness: ProjectRepositoryContractHarness,
) {
  describe(`${name} ProjectRepository contract`, () => {
    it("passes the portable Database/Browser adapter scenario", async () => {
      await expect(runPortableProjectRepositoryContract(
        harness.createRepository(),
        0,
      )).resolves.toMatchObject({
        initialRevision: 0,
        finalRevision: 2,
        finalFiles: [{ path: "b.txt", content: "beta" }],
      });
    });

    it("exposes one revisioned workspace snapshot", async () => {
      const repository = harness.createRepository();

      expect(repository.getRevision()).toBe(0);
      await expect(repository.readWorkspace()).resolves.toEqual({
        revision: 0,
        files: [{
          path: "a.txt",
          content: "alpha",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
      });
    });

    it("increments revision after write and reads the exact saved content", async () => {
      const repository = harness.createRepository();

      await expect(repository.writeFile({
        path: "b.txt",
        content: "beta",
        expectedRevision: 0,
      })).resolves.toMatchObject({
        operation: "write",
        path: "b.txt",
        revision: 1,
      });

      expect(repository.getRevision()).toBe(1);
      await expect(repository.readFile("b.txt")).resolves.toMatchObject({
        path: "b.txt",
        content: "beta",
        revision: 1,
      });
    });

    it("rejects a stale write without changing revision or content", async () => {
      const repository = harness.createRepository();

      await repository.writeFile({
        path: "a.txt",
        content: "first",
        expectedRevision: 0,
      });

      await expect(repository.writeFile({
        path: "a.txt",
        content: "stale overwrite",
        expectedRevision: 0,
      })).rejects.toThrow("REVISION_CONFLICT");

      expect(repository.getRevision()).toBe(1);
      await expect(repository.readFile("a.txt")).resolves.toMatchObject({
        content: "first",
        revision: 1,
      });
    });

    it("rolls back revision when rename conflicts", async () => {
      const repository = harness.createRepository();
      await repository.writeFile({ path: "b.txt", content: "beta", expectedRevision: 0 });

      await expect(repository.renameFile({
        oldPath: "a.txt",
        newPath: "b.txt",
        expectedRevision: 1,
      })).rejects.toThrow("CONFLICT");

      expect(repository.getRevision()).toBe(1);
      await expect(repository.listFiles()).resolves.toMatchObject({
        revision: 1,
        files: [{ path: "a.txt" }, { path: "b.txt" }],
      });
    });

    it("deletes a file with the same CAS rule", async () => {
      const repository = harness.createRepository();

      await expect(repository.deleteFile({
        path: "a.txt",
        expectedRevision: 0,
      })).resolves.toEqual({
        operation: "delete",
        path: "a.txt",
        revision: 1,
      });

      await expect(repository.listFiles()).resolves.toEqual({ revision: 1, files: [] });
    });

    it("searches and exports preview files from the same revisioned source", async () => {
      const repository = harness.createRepository();

      await expect(repository.searchText("alpha")).resolves.toMatchObject({
        revision: 0,
        matches: [{ path: "a.txt", line: 1, column: 1 }],
      });
      await expect(repository.exportPreviewFiles()).resolves.toEqual({
        revision: 0,
        files: [{ path: "a.txt", content: "alpha" }],
      });
    });
  });
}
