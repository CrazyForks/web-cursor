/**
 * [INPUT]: FIGMA_PROVIDER env, target, token, inspect options
 * [OUTPUT]: Provider result from the selected implementation
 * [POS]: A 域 Figma provider 选择层 —— 保持 agent 工具契约不随 REST/MCP 改变
 * [PROTOCOL]: 第一阶段只支持 rest；未知 provider 返回 FIGMA_PROVIDER_UNAVAILABLE
 */
import "server-only";
import { inspectWithRestProvider, type RestProviderResult } from "./providers/restProvider";
import { FigmaErrorCode, FigmaInspectError, type FigmaTarget, type InspectFigmaOptions } from "./types";

export async function inspectWithProvider(
  target: FigmaTarget,
  accessToken: string,
  options: InspectFigmaOptions,
): Promise<RestProviderResult> {
  const provider = process.env.FIGMA_PROVIDER?.trim() || "rest";
  if (provider === "rest") {
    return inspectWithRestProvider(target, accessToken, options);
  }
  throw new FigmaInspectError(FigmaErrorCode.ProviderUnavailable, `Unsupported Figma provider: ${provider}`);
}
