import type { GitStatusResult } from "@/types/browserGitRepository";

export type GitStatusFile = GitStatusResult["files"][number];

export function hasStagedChange(file: GitStatusFile) {
  return file.stage !== file.head;
}

export function hasWorkingTreeChange(file: GitStatusFile) {
  return file.workdir !== file.stage;
}

export function gitChangeCode(file: GitStatusFile) {
  if (file.head === 0) return "U" as const;
  if (file.workdir === 0 || file.stage === 0) return "D" as const;
  return "M" as const;
}
