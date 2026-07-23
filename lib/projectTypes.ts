import { z } from "zod";
import type { ImageRunView } from "@/lib/types";
import type { AttachmentSummary } from "@/types/attachment";
import {
  ProjectFileSummarySchema,
  type ProjectFileContent,
  type ProjectFileSummary,
} from "@/types/projectRepository";
import { ProjectRevisionSchema } from "@/types/projectRevision";
import { ProjectStorageKind } from "@/types/projectStorage";
export { FileContentAction } from "@/types/projectFileMutation";
export type { ProjectFileContent, ProjectFileSummary } from "@/types/projectRepository";

const ProjectBaseShape = {
  id: z.string().uuid(),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};

export const DatabaseProjectSchema = z.object({
  ...ProjectBaseShape,
  storageKind: z.literal(ProjectStorageKind.Database),
  codeRevision: ProjectRevisionSchema,
}).strict();

export const BrowserGitProjectSchema = z.object({
  ...ProjectBaseShape,
  storageKind: z.literal(ProjectStorageKind.BrowserGit),
}).strict();

export const ProjectSchema = z.discriminatedUnion("storageKind", [
  DatabaseProjectSchema,
  BrowserGitProjectSchema,
]);

export type DatabaseProject = z.infer<typeof DatabaseProjectSchema>;
export type BrowserGitProject = z.infer<typeof BrowserGitProjectSchema>;
export type Project = z.infer<typeof ProjectSchema>;

export const ConversationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().nullable(),
  createdAt: z.string().datetime(),
}).strict();

export type Conversation = z.infer<typeof ConversationSchema>;

export const DatabaseProjectDetailSchema = DatabaseProjectSchema.extend({
  conversations: z.array(ConversationSchema),
  files: z.array(ProjectFileSummarySchema),
}).strict();

export const BrowserGitProjectDetailSchema = BrowserGitProjectSchema.extend({
  conversations: z.array(ConversationSchema),
}).strict();

export const ProjectDetailSchema = z.discriminatedUnion("storageKind", [
  DatabaseProjectDetailSchema,
  BrowserGitProjectDetailSchema,
]);

export const ProjectListSchema = z.array(ProjectSchema);
export const CreatedProjectResponseSchema = z.union([
  ProjectSchema,
  z.array(ProjectSchema).min(1),
]);

export type DatabaseProjectDetail = z.infer<typeof DatabaseProjectDetailSchema>;
export type BrowserGitProjectDetail = z.infer<typeof BrowserGitProjectDetailSchema>;
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

export type RepositoryProjectRef =
  | {
      id: string;
      title: string;
      storageKind: typeof ProjectStorageKind.Database;
      codeRevision: number;
      files?: ProjectFileSummary[];
    }
  | {
      id: string;
      title: string;
      storageKind: typeof ProjectStorageKind.BrowserGit;
    };

export type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  meta?: {
    attachments?: AttachmentSummary[];
    [key: string]: unknown;
  };
  imageRuns?: ImageRunView[];
};

export function formatTime(value?: string, locale = "zh") {
  if (!value) return locale === "en" ? "Unknown time" : "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return locale === "en" ? "Unknown time" : "未知时间";
  return date.toLocaleString(locale === "en" ? "en-US" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function normalizeCreatedProject(value: unknown): Project {
  const parsed = CreatedProjectResponseSchema.parse(value);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}
