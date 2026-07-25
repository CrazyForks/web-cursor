/**
 * [INPUT]: Figma REST/MCP provider outputs and inspect tool arguments
 * [OUTPUT]: Internal Figma inspection contract shared by providers, sanitizer, and tools
 * [POS]: A 域 Figma 协议契约 —— agent 只看这些内部类型，不直接感知 REST/MCP
 * [PROTOCOL]: 新增字段必须来自 Figma 文档或明确产品契约；未知字段不做语义猜测
 */
import "server-only";
import type { FigmaErrorCode as FigmaErrorCodeValue } from "@/types/figma";
export {
  FigmaAssetMimeType,
  FigmaAssetRefSchema,
  FigmaAssetSource,
  FigmaBoxSchema,
  FigmaDesignContextSchema,
  FigmaErrorCode,
  FigmaErrorCodeSchema,
  SimplifiedFigmaEffectSchema,
  SimplifiedFigmaNodeSchema,
  SimplifiedFigmaPaintSchema,
} from "@/types/figma";
export type {
  FigmaAssetRef,
  FigmaBox,
  FigmaDesignContext,
  SimplifiedFigmaEffect,
  SimplifiedFigmaNode,
  SimplifiedFigmaPaint,
} from "@/types/figma";

export class FigmaInspectError extends Error {
  constructor(
    readonly code: FigmaErrorCodeValue,
    message: string,
  ) {
    super(message);
  }
}

export type FigmaTarget = {
  figmaUrl: string;
  fileKey: string;
  nodeId: string;
};

export type InspectFigmaOptions = {
  maxDepth?: number;
  includeAssets: boolean;
};

export type RawFigmaNode = Record<string, unknown>;

export type RawFigmaDocument = {
  fileName: string;
  node: RawFigmaNode;
};
