import { z } from "zod";
import type { ProjectRepository } from "./projectRepository";

export const GitStatusHeadSchema = z.union([z.literal(0), z.literal(1)]);
export const GitStatusWorkdirSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export const GitStatusStageSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const GitStatusFileSchema = z.object({
  path: z.string().min(1),
  head: GitStatusHeadSchema,
  workdir: GitStatusWorkdirSchema,
  stage: GitStatusStageSchema,
}).strict();

export const GitStatusResultSchema = z.object({
  files: z.array(GitStatusFileSchema),
}).strict();

export const GitAuthorSchema = z.object({
  name: z.string().min(1).refine((name) => name.trim().length > 0),
  email: z.string().email(),
}).strict();

export const GitCommitInputSchema = z.object({
  message: z.string().min(1).refine((message) => message.trim().length > 0),
  author: GitAuthorSchema,
}).strict();

export const GitInitInputSchema = z.object({
  defaultBranch: z.string().min(1),
}).strict();

export const GitLogInputSchema = z.object({
  depth: z.number().int().positive().max(100),
}).strict();

export const GitInitResultSchema = z.object({
  initialized: z.literal(true),
  branch: z.string().min(1),
}).strict();

export const GitCommitResultSchema = z.object({
  oid: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();

export const GitCurrentBranchResultSchema = z.object({
  branch: z.string().min(1).nullable(),
}).strict();

export const GitLogCommitSchema = z.object({
  oid: z.string().regex(/^[0-9a-f]{40}$/),
  message: z.string(),
  parent: z.array(z.string().regex(/^[0-9a-f]{40}$/)),
  author: z.object({
    name: z.string(),
    email: z.string(),
    timestamp: z.number().int(),
    timezoneOffset: z.number().int(),
  }).strict(),
}).strict();

export const GitLogResultSchema = z.object({
  commits: z.array(GitLogCommitSchema),
}).strict();

export type GitCommitInput = z.infer<typeof GitCommitInputSchema>;
export type GitInitInput = z.infer<typeof GitInitInputSchema>;
export type GitLogInput = z.infer<typeof GitLogInputSchema>;
export type GitStatusResult = z.infer<typeof GitStatusResultSchema>;
export type GitInitResult = z.infer<typeof GitInitResultSchema>;
export type GitCommitResult = z.infer<typeof GitCommitResultSchema>;
export type GitCurrentBranchResult = z.infer<typeof GitCurrentBranchResultSchema>;
export type GitLogResult = z.infer<typeof GitLogResultSchema>;

export interface BrowserGitProjectRepository extends ProjectRepository {
  initGit(input: GitInitInput): Promise<GitInitResult>;
  gitStatus(): Promise<GitStatusResult>;
  stageFile(path: string): Promise<GitStatusResult>;
  unstageFile(path: string): Promise<GitStatusResult>;
  commit(input: GitCommitInput): Promise<GitCommitResult>;
  gitLog(input: GitLogInput): Promise<GitLogResult>;
  currentBranch(): Promise<GitCurrentBranchResult>;
}
