import z from "zod";

export const ShowcaseArtifactStatus = {
  Ready: "ready",
} as const;

export type ShowcaseArtifactStatus = typeof ShowcaseArtifactStatus[keyof typeof ShowcaseArtifactStatus];

export const SaveShowcaseArtifactSchema = z.object({
  slug: z.string().min(1),
  filesHash: z.string().regex(/^[a-f0-9]{64}$/),
  buildLog: z.string(),
}).strict();

export type SaveShowcaseArtifactInput = z.infer<typeof SaveShowcaseArtifactSchema>;
