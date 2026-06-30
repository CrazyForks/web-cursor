/**
 * [INPUT]: ownerId + inspect_figma_design arguments
 * [OUTPUT]: FigmaDesignContext from a validated URL and current owner connection
 * [POS]: A 域 Figma inspect 编排层 —— executor 调用的唯一 Figma 设计读取入口
 * [PROTOCOL]: 先解析 URL，再校验连接和 token；失败返回明确 FigmaInspectError
 */
import "server-only";
import { getFigmaAccessToken } from "./tokens";
import { inspectWithProvider } from "./provider";
import { sanitizeFigmaNode } from "./sanitize";
import { parseFigmaTarget } from "./url";
import type { FigmaDesignContext, InspectFigmaOptions } from "./types";

export async function inspectFigmaDesign({
  ownerId,
  figmaUrl,
  maxDepth,
  includeAssets,
}: {
  ownerId: string;
  figmaUrl: string;
  maxDepth?: number;
  includeAssets: boolean;
}): Promise<FigmaDesignContext> {
  const target = parseFigmaTarget(figmaUrl);
  const accessToken = await getFigmaAccessToken(ownerId);
  const options: InspectFigmaOptions = { maxDepth, includeAssets };
  const providerResult = await inspectWithProvider(target, accessToken, options);
  const { tree, warnings } = sanitizeFigmaNode(providerResult.document.node, maxDepth);

  return {
    status: "ok",
    tool: "inspect_figma_design",
    source: {
      fileKey: target.fileKey,
      nodeId: target.nodeId,
      fileName: providerResult.document.fileName,
      nodeName: tree.name,
    },
    figmaTree: tree,
    assets: providerResult.assets,
    warnings,
  };
}
