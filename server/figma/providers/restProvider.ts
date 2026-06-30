/**
 * [INPUT]: FigmaTarget, access token, and inspect options
 * [OUTPUT]: Raw Figma document node plus optional temporary export URLs
 * [POS]: A 域 Figma REST provider —— 封装 REST files/nodes/images，不暴露给 agent
 * [PROTOCOL]: 非 2xx 映射为明确 FigmaErrorCode；响应结构不符合契约时直接报错
 */
import "server-only";
import { z } from "zod";
import {
  FigmaErrorCode,
  FigmaInspectError,
  type FigmaAssetRef,
  type FigmaTarget,
  type InspectFigmaOptions,
  type RawFigmaDocument,
} from "../types";

const FIGMA_API_BASE = "https://api.figma.com/v1";
const ASSET_TTL_WARNING = "Figma export URL may expire; do not treat it as permanent storage.";

const FigmaNodeResponseSchema = z.object({
  name: z.string().min(1),
  nodes: z.record(z.string(), z.object({
    document: z.record(z.string(), z.unknown()),
  }).passthrough().nullable()),
}).passthrough();

const FigmaImagesResponseSchema = z.object({
  images: z.record(z.string(), z.string().url().nullable()),
}).passthrough();

export type RestProviderResult = {
  document: RawFigmaDocument;
  assets: FigmaAssetRef[];
};

function providerError(status: number, fallback: string): FigmaInspectError {
  if (status === 401) return new FigmaInspectError(FigmaErrorCode.Unauthorized, "Figma access token is unauthorized.");
  if (status === 403) return new FigmaInspectError(FigmaErrorCode.Forbidden, "Current Figma user cannot access this file or node.");
  if (status === 404) return new FigmaInspectError(FigmaErrorCode.NotFound, "Figma file or node was not found.");
  if (status === 429) return new FigmaInspectError(FigmaErrorCode.RateLimited, "Figma API rate limit exceeded.");
  return new FigmaInspectError(FigmaErrorCode.ProviderUnavailable, fallback);
}

async function fetchFigmaJson(url: URL, accessToken: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw providerError(response.status, `Figma API failed with status ${response.status}.`);
  }
  return payload;
}

async function fetchNode(target: FigmaTarget, accessToken: string): Promise<RawFigmaDocument> {
  const url = new URL(`${FIGMA_API_BASE}/files/${encodeURIComponent(target.fileKey)}/nodes`);
  url.searchParams.set("ids", target.nodeId);

  const payload = await fetchFigmaJson(url, accessToken);
  const parsed = FigmaNodeResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new FigmaInspectError(FigmaErrorCode.ProviderUnavailable, parsed.error.message);
  }

  const node = parsed.data.nodes[target.nodeId];
  if (!node?.document) {
    throw new FigmaInspectError(FigmaErrorCode.NotFound, "Requested Figma node was not returned by Figma.");
  }

  return {
    fileName: parsed.data.name,
    node: node.document,
  };
}

async function fetchTargetAsset(
  target: FigmaTarget,
  accessToken: string,
  node: Record<string, unknown>,
): Promise<FigmaAssetRef> {
  const url = new URL(`${FIGMA_API_BASE}/images/${encodeURIComponent(target.fileKey)}`);
  url.searchParams.set("ids", target.nodeId);
  url.searchParams.set("format", "png");

  const payload = await fetchFigmaJson(url, accessToken);
  const parsed = FigmaImagesResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new FigmaInspectError(FigmaErrorCode.AssetExportFailed, parsed.error.message);
  }

  const exportUrl = parsed.data.images[target.nodeId];
  if (!exportUrl) {
    throw new FigmaInspectError(FigmaErrorCode.AssetExportFailed, "Figma did not return an export URL for the requested node.");
  }

  const box = typeof node.absoluteBoundingBox === "object" && node.absoluteBoundingBox
    ? node.absoluteBoundingBox as Record<string, unknown>
    : {};

  return {
    source: "figma_export",
    sourceFileKey: target.fileKey,
    sourceNodeId: target.nodeId,
    url: exportUrl,
    mimeType: "image/png",
    width: typeof box.width === "number" ? box.width : undefined,
    height: typeof box.height === "number" ? box.height : undefined,
    ttlWarning: ASSET_TTL_WARNING,
  };
}

export async function inspectWithRestProvider(
  target: FigmaTarget,
  accessToken: string,
  options: InspectFigmaOptions,
): Promise<RestProviderResult> {
  const document = await fetchNode(target, accessToken);
  const assets = options.includeAssets
    ? [await fetchTargetAsset(target, accessToken, document.node)]
    : [];

  return { document, assets };
}
