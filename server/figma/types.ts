/**
 * [INPUT]: Figma REST/MCP provider outputs and inspect tool arguments
 * [OUTPUT]: Internal Figma inspection contract shared by providers, sanitizer, and tools
 * [POS]: A 域 Figma 协议契约 —— agent 只看这些内部类型，不直接感知 REST/MCP
 * [PROTOCOL]: 新增字段必须来自 Figma 文档或明确产品契约；未知字段不做语义猜测
 */
import "server-only";

export const FigmaErrorCode = {
  NotConnected: "FIGMA_NOT_CONNECTED",
  InvalidUrl: "FIGMA_INVALID_URL",
  NodeRequired: "FIGMA_NODE_REQUIRED",
  Unauthorized: "FIGMA_UNAUTHORIZED",
  Forbidden: "FIGMA_FORBIDDEN",
  NotFound: "FIGMA_NOT_FOUND",
  UnsupportedNode: "FIGMA_UNSUPPORTED_NODE",
  ProviderUnavailable: "FIGMA_PROVIDER_UNAVAILABLE",
  RateLimited: "FIGMA_RATE_LIMITED",
  AssetExportFailed: "FIGMA_ASSET_EXPORT_FAILED",
} as const;

export type FigmaErrorCode = typeof FigmaErrorCode[keyof typeof FigmaErrorCode];

export class FigmaInspectError extends Error {
  constructor(
    readonly code: FigmaErrorCode,
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

export type FigmaBox = {
  x?: number;
  y?: number;
  w: number;
  h: number;
};

export type SimplifiedFigmaNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  box?: FigmaBox;
  layout?: {
    mode?: string;
    primaryAxisSizingMode?: string;
    counterAxisSizingMode?: string;
    gap?: number;
    padding?: [number, number, number, number];
  };
  fills?: SimplifiedFigmaPaint[];
  strokes?: SimplifiedFigmaPaint[];
  effects?: SimplifiedFigmaEffect[];
  opacity?: number;
  text?: {
    characters: string;
    style?: Record<string, unknown>;
  };
  children?: SimplifiedFigmaNode[];
};

export type SimplifiedFigmaPaint = {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: string;
  imageRef?: string;
};

export type SimplifiedFigmaEffect = {
  type: string;
  visible?: boolean;
  radius?: number;
  color?: string;
  offset?: { x?: number; y?: number };
};

export type FigmaAssetRef = {
  source: "figma_export";
  sourceFileKey: string;
  sourceNodeId: string;
  url: string;
  mimeType: "image/png" | "image/jpeg" | "image/svg+xml";
  width?: number;
  height?: number;
  ttlWarning: string;
};

export type FigmaDesignContext = {
  status: "ok";
  tool: "inspect_figma_design";
  source: {
    fileKey: string;
    nodeId: string;
    fileName: string;
    nodeName: string;
  };
  figmaTree: SimplifiedFigmaNode;
  assets: FigmaAssetRef[];
  warnings: string[];
};

export type RawFigmaNode = Record<string, unknown>;

export type RawFigmaDocument = {
  fileName: string;
  node: RawFigmaNode;
};
