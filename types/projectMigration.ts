import { z } from "zod";
import { GitAuthorSchema } from "./browserGitRepository";
import { ProjectRevisionSchema } from "./projectRevision";

export const BrowserGitMigrationDefaults = {
  Branch: "main",
  CommitMessage: "Import existing Web Cursor project",
} as const;

export const GitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const BrowserGitMigrationFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
}).strict();

export const PrepareBrowserGitMigrationInputSchema = z.object({
  sourceRevision: ProjectRevisionSchema,
  files: z.array(BrowserGitMigrationFileSchema),
  defaultBranch: z.string().min(1),
  message: z.string().min(1).refine((message) => message.trim().length > 0),
  author: GitAuthorSchema,
}).strict();

export const PreparedBrowserGitMigrationSchema = z.object({
  sourceRevision: ProjectRevisionSchema,
  localRevision: ProjectRevisionSchema,
  branch: z.string().min(1),
  importCommitOid: GitObjectIdSchema,
  fileCount: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.localRevision !== value.sourceRevision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["localRevision"],
      message: "localRevision must equal sourceRevision",
    });
  }
});

export const ActivateBrowserGitMigrationBodySchema = z.object({
  sourceRevision: ProjectRevisionSchema,
  localRevision: ProjectRevisionSchema,
  importCommitOid: GitObjectIdSchema,
}).strict().superRefine((value, ctx) => {
  if (value.localRevision !== value.sourceRevision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["localRevision"],
      message: "localRevision must equal sourceRevision",
    });
  }
});

export type PrepareBrowserGitMigrationInput = z.infer<typeof PrepareBrowserGitMigrationInputSchema>;
export type PreparedBrowserGitMigration = z.infer<typeof PreparedBrowserGitMigrationSchema>;
export type ActivateBrowserGitMigrationBody = z.infer<typeof ActivateBrowserGitMigrationBodySchema>;
