import { z } from "zod";

export const ProjectRevisionSchema = z.number().int().nonnegative().safe();

export type ProjectRevision = z.infer<typeof ProjectRevisionSchema>;
