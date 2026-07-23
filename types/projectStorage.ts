import { z } from "zod";

export const ProjectStorageKind = {
  Database: "database_v1",
  BrowserGit: "browser_git_v1",
} as const;

export type ProjectStorageKind =
  typeof ProjectStorageKind[keyof typeof ProjectStorageKind];

export const ProjectStorageKindSchema = z.union([
  z.literal(ProjectStorageKind.Database),
  z.literal(ProjectStorageKind.BrowserGit),
]);

const CreateProjectBaseShape = {
  title: z.string().min(1),
};

export const CreateProjectBodySchema = z.discriminatedUnion("storageKind", [
  z.object({
    ...CreateProjectBaseShape,
    storageKind: z.literal(ProjectStorageKind.Database),
  }).strict(),
  z.object({
    ...CreateProjectBaseShape,
    id: z.string().uuid(),
    storageKind: z.literal(ProjectStorageKind.BrowserGit),
  }).strict(),
]);

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;
