import { z } from "zod";
import { ToolResultType } from "./tool";

export const ToolResultSchema = z.discriminatedUnion("type", [
  z.object({
    status: z.literal("ok"),
    type: z.literal(ToolResultType.RenderOk),
    durationMs: z.number().optional(),
  }),
  z.object({
    status: z.literal("error"),
    type: z.literal(ToolResultType.CompileError),
    message: z.string(),
  }),
  z.object({
    status: z.literal("error"),
    type: z.literal(ToolResultType.RuntimeError),
    message: z.string(),
    stack: z.string().optional(),
  }),
  z.object({
    status: z.literal("error"),
    type: z.literal(ToolResultType.ToolInterrupted),
    message: z.string(),
  }),
]);
