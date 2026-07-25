import { z } from "zod";

export const IntegrationCardKind = {
  IntegrationCard: "integration_card",
} as const;

export const IntegrationProvider = {
  Figma: "figma",
} as const;

export const IntegrationAction = {
  Connect: "connect",
} as const;

export const IntegrationReason = {
  FigmaNotConnected: "FIGMA_NOT_CONNECTED",
} as const;

export const IntegrationCardMetaSchema = z.object({
  kind: z.literal(IntegrationCardKind.IntegrationCard),
  provider: z.literal(IntegrationProvider.Figma),
  action: z.literal(IntegrationAction.Connect),
  reason: z.literal(IntegrationReason.FigmaNotConnected),
  resume: z.object({
    type: z.literal("conversation"),
  }).strict(),
}).strict();

export type IntegrationCardMeta = z.infer<typeof IntegrationCardMetaSchema>;

export function isIntegrationCardMeta(value: unknown): value is IntegrationCardMeta {
  return IntegrationCardMetaSchema.safeParse(value).success;
}
