/**
 * [INPUT]: User supplied Figma URL string
 * [OUTPUT]: Validated FigmaTarget with fileKey and API nodeId
 * [POS]: A 域 Figma URL 解析器 —— 只解析明确 design/file + node-id，不猜默认节点
 * [PROTOCOL]: 缺 node-id 返回 FIGMA_NODE_REQUIRED；不支持的 URL 返回 FIGMA_INVALID_URL
 */
import "server-only";
import { FigmaErrorCode, FigmaInspectError, type FigmaTarget } from "./types";

const SUPPORTED_KINDS = new Set(["design", "file"]);

function isFigmaHost(hostname: string): boolean {
  return hostname === "figma.com" || hostname === "www.figma.com";
}

function nodeIdFromParam(value: string | null): string {
  const raw = value?.trim();
  if (!raw) {
    throw new FigmaInspectError(FigmaErrorCode.NodeRequired, "Figma URL must include a node-id parameter.");
  }
  return raw.replaceAll("-", ":");
}

export function parseFigmaTarget(figmaUrl: string): FigmaTarget {
  let url: URL;
  try {
    url = new URL(figmaUrl);
  } catch {
    throw new FigmaInspectError(FigmaErrorCode.InvalidUrl, "Figma URL is not a valid URL.");
  }

  const [, kind, fileKey] = url.pathname.split("/");
  if (url.protocol !== "https:" || !isFigmaHost(url.hostname) || !SUPPORTED_KINDS.has(kind) || !fileKey) {
    throw new FigmaInspectError(FigmaErrorCode.InvalidUrl, "Only Figma design/file URLs are supported.");
  }

  return {
    figmaUrl,
    fileKey,
    nodeId: nodeIdFromParam(url.searchParams.get("node-id")),
  };
}
