import type { ProjectRepository } from "../../types/projectRepository";

export type PortableRepositoryContractResult = {
  initialRevision: number;
  searchMatched: boolean;
  previewMatched: boolean;
  staleRejected: boolean;
  renameConflictRejected: boolean;
  finalRevision: number;
  finalFiles: { path: string; content: string }[];
};

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`ProjectRepository contract failed: ${message}`);
}

export async function runPortableProjectRepositoryContract(
  repository: ProjectRepository,
  initialRevision: number,
): Promise<PortableRepositoryContractResult> {
  const initial = await repository.readWorkspace();
  invariant(initial.revision === initialRevision, "initial revision mismatch");
  invariant(
    initial.files.some((file) => file.path === "a.txt" && file.content === "alpha"),
    "initial a.txt content mismatch",
  );

  const search = await repository.searchText("alpha");
  const searchMatched = search.revision === initialRevision
    && search.matches.some((match) => match.path === "a.txt" && match.line === 1 && match.column === 1);
  invariant(searchMatched, "search did not use the initial revisioned workspace");

  const preview = await repository.exportPreviewFiles();
  const previewMatched = preview.revision === initialRevision
    && preview.files.some((file) => file.path === "a.txt" && file.content === "alpha");
  invariant(previewMatched, "preview did not use the initial revisioned workspace");

  await repository.writeFile({
    path: "b.txt",
    content: "beta",
    expectedRevision: initialRevision,
  });
  const written = await repository.readFile("b.txt");
  invariant(written.content === "beta", "write/read content mismatch");
  invariant(written.revision === initialRevision + 1, "write revision mismatch");

  let staleRejected = false;
  try {
    await repository.writeFile({
      path: "b.txt",
      content: "stale",
      expectedRevision: initialRevision,
    });
  } catch (error) {
    staleRejected = String(error).includes("REVISION_CONFLICT");
  }
  invariant(staleRejected, "stale write was not rejected");

  let renameConflictRejected = false;
  try {
    await repository.renameFile({
      oldPath: "a.txt",
      newPath: "b.txt",
      expectedRevision: initialRevision + 1,
    });
  } catch (error) {
    renameConflictRejected = String(error).includes("CONFLICT");
  }
  invariant(renameConflictRejected, "rename conflict was not rejected");
  invariant(repository.getRevision() === initialRevision + 1, "rename conflict changed revision");

  await repository.deleteFile({
    path: "a.txt",
    expectedRevision: initialRevision + 1,
  });
  const final = await repository.readWorkspace();
  invariant(final.revision === initialRevision + 2, "delete revision mismatch");
  invariant(final.files.length === 1, "final file count mismatch");
  invariant(final.files[0].path === "b.txt" && final.files[0].content === "beta", "final workspace mismatch");

  return {
    initialRevision,
    searchMatched,
    previewMatched,
    staleRejected,
    renameConflictRejected,
    finalRevision: final.revision,
    finalFiles: final.files.map(({ path, content }) => ({ path, content })),
  };
}
