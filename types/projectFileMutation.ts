import { z } from "zod";
import { ProjectRevisionSchema } from "./projectRevision";

export const ProjectFileOperation = {
  Write: "write",
  Delete: "delete",
  Rename: "rename",
} as const;

export type ProjectFileOperation =
  typeof ProjectFileOperation[keyof typeof ProjectFileOperation];

export const FileContentAction = {
  Write: ProjectFileOperation.Write,
  Delete: ProjectFileOperation.Delete,
} as const;

export type FileContentAction = typeof FileContentAction[keyof typeof FileContentAction];

export const FileContentPostBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal(FileContentAction.Write),
    path: z.string().min(1),
    content: z.string(),
    expectedRevision: ProjectRevisionSchema,
  }).strict(),
  z.object({
    action: z.literal(FileContentAction.Delete),
    path: z.string().min(1),
    expectedRevision: ProjectRevisionSchema,
  }).strict(),
]);

export const RenameProjectFileBodySchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
  expectedRevision: ProjectRevisionSchema,
}).strict();

export type FileContentPostBody = z.infer<typeof FileContentPostBodySchema>;
export type RenameProjectFileBody = z.infer<typeof RenameProjectFileBodySchema>;
