import { describe, expect, it } from "vitest";
import {
  gitChangeCode,
  hasStagedChange,
  hasWorkingTreeChange,
  type GitStatusFile,
} from "../../lib/projectRepository/gitStatus";

function file(head: GitStatusFile["head"], workdir: GitStatusFile["workdir"], stage: GitStatusFile["stage"]): GitStatusFile {
  return { path: "src/App.tsx", head, workdir, stage };
}

describe("Git status matrix UI classification", () => {
  it.each([
    { matrix: file(1, 1, 1), staged: false, working: false, code: "M" },
    { matrix: file(1, 2, 1), staged: false, working: true, code: "M" },
    { matrix: file(1, 2, 2), staged: true, working: false, code: "M" },
    { matrix: file(1, 2, 3), staged: true, working: true, code: "M" },
    { matrix: file(0, 2, 0), staged: false, working: true, code: "U" },
    { matrix: file(0, 2, 2), staged: true, working: false, code: "U" },
    { matrix: file(1, 0, 1), staged: false, working: true, code: "D" },
    { matrix: file(1, 0, 0), staged: true, working: false, code: "D" },
  ])("classifies $matrix as staged=$staged working=$working", ({ matrix, staged, working, code }) => {
    expect(hasStagedChange(matrix)).toBe(staged);
    expect(hasWorkingTreeChange(matrix)).toBe(working);
    expect(gitChangeCode(matrix)).toBe(code);
  });
});
