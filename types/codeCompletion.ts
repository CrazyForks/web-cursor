import { z } from "zod";

export const CodeCompletionLanguage = {
  TypeScript: "typescript",
  JavaScript: "javascript",
  Css: "css",
  Html: "html",
  Json: "json",
} as const;

export type CodeCompletionLanguage =
  typeof CodeCompletionLanguage[keyof typeof CodeCompletionLanguage];

export const CodeCompletionTrigger = {
  Automatic: "automatic",
  Explicit: "explicit",
} as const;

export type CodeCompletionTrigger =
  typeof CodeCompletionTrigger[keyof typeof CodeCompletionTrigger];

export const CodeCompletionRequestSchema = z.object({
  projectId: z.string().uuid(),
  path: z.string().min(1).max(240),
  language: z.enum([
    CodeCompletionLanguage.TypeScript,
    CodeCompletionLanguage.JavaScript,
    CodeCompletionLanguage.Css,
    CodeCompletionLanguage.Html,
    CodeCompletionLanguage.Json,
  ]),
  prefix: z.string().max(12000),
  suffix: z.string().max(6000),
  trigger: z.enum([
    CodeCompletionTrigger.Automatic,
    CodeCompletionTrigger.Explicit,
  ]),
}).strict();

export type CodeCompletionRequest = z.infer<typeof CodeCompletionRequestSchema>;

export const CodeCompletionResponseSchema = z.object({
  insertText: z.string().max(4000),
  reason: z.string().max(240).optional(),
}).strict();

export type CodeCompletionResponse = z.infer<typeof CodeCompletionResponseSchema>;

export const CodeCompletionModelResponseSchema = z.object({
  insertText: z.string().max(4000),
}).strict();
