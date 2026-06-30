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

export type IntegrationCardMeta = {
  kind: typeof IntegrationCardKind.IntegrationCard;
  provider: typeof IntegrationProvider.Figma;
  action: typeof IntegrationAction.Connect;
  reason: typeof IntegrationReason.FigmaNotConnected;
  resume: { type: "conversation" };
};

export function isIntegrationCardMeta(value: unknown): value is IntegrationCardMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<IntegrationCardMeta>;
  return (
    meta.kind === IntegrationCardKind.IntegrationCard
    && meta.provider === IntegrationProvider.Figma
    && meta.action === IntegrationAction.Connect
    && meta.reason === IntegrationReason.FigmaNotConnected
    && typeof meta.resume === "object"
    && meta.resume?.type === "conversation"
  );
}
