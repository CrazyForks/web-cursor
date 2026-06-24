import { z } from "zod";
import type { ToolName } from "./tool";

export const ChatTurnSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    message: z.string().min(1),
    projectId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.literal("resume"),
    conversationId: z.string().uuid(),
  }),
]);

export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export type ChatEvent =
  | { type: "init"; conversationId: string; projectId: string }
  | { type: "code"; delta: string }
  | { type: "chat"; delta: string }
  | { type: "tools_call"; index: number; name: ToolName | string; id: string }
  | {
      type: "title";
      conversationId: string;
      title: string;
      projectTitle?: string;
      conversationTitle?: string;
    }
  | { type: "done" }
  | { type: "error"; message: string };
