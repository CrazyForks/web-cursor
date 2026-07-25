import { z } from "zod";
import { ToolName } from "./tool";

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

export type FigmaErrorCode =
  typeof FigmaErrorCode[keyof typeof FigmaErrorCode];

export const FigmaErrorCodeSchema = z.enum(FigmaErrorCode);

export const FigmaAssetSource = {
  Export: "figma_export",
} as const;

export const FigmaAssetMimeType = {
  Png: "image/png",
  Jpeg: "image/jpeg",
  Svg: "image/svg+xml",
} as const;

export type FigmaBox = {
  x?: number;
  y?: number;
  w: number;
  h: number;
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
    style?: Record<string, string | number | boolean>;
  };
  children?: SimplifiedFigmaNode[];
};

export type FigmaAssetRef = {
  source: typeof FigmaAssetSource.Export;
  sourceFileKey: string;
  sourceNodeId: string;
  url: string;
  mimeType: typeof FigmaAssetMimeType[keyof typeof FigmaAssetMimeType];
  width?: number;
  height?: number;
  ttlWarning: string;
};

export type FigmaDesignContext = {
  status: "ok";
  tool: typeof ToolName.InspectFigmaDesign;
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

export const FigmaBoxSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number(),
  h: z.number(),
}).strict();

export const SimplifiedFigmaPaintSchema = z.object({
  type: z.string().min(1),
  visible: z.boolean().optional(),
  opacity: z.number().optional(),
  color: z.string().optional(),
  imageRef: z.string().optional(),
}).strict();

export const SimplifiedFigmaEffectSchema = z.object({
  type: z.string().min(1),
  visible: z.boolean().optional(),
  radius: z.number().optional(),
  color: z.string().optional(),
  offset: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
  }).strict().optional(),
}).strict();

const FigmaTextStyleValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

export const SimplifiedFigmaNodeSchema: z.ZodType<SimplifiedFigmaNode> =
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.string().min(1),
    visible: z.boolean().optional(),
    box: FigmaBoxSchema.optional(),
    layout: z.object({
      mode: z.string().optional(),
      primaryAxisSizingMode: z.string().optional(),
      counterAxisSizingMode: z.string().optional(),
      gap: z.number().optional(),
      padding: z.tuple([
        z.number(),
        z.number(),
        z.number(),
        z.number(),
      ]).optional(),
    }).strict().optional(),
    fills: z.array(SimplifiedFigmaPaintSchema).optional(),
    strokes: z.array(SimplifiedFigmaPaintSchema).optional(),
    effects: z.array(SimplifiedFigmaEffectSchema).optional(),
    opacity: z.number().optional(),
    text: z.object({
      characters: z.string(),
      style: z.record(z.string(), FigmaTextStyleValueSchema).optional(),
    }).strict().optional(),
    children: z.array(z.lazy(() => SimplifiedFigmaNodeSchema)).optional(),
  }).strict();

export const FigmaAssetRefSchema = z.object({
  source: z.literal(FigmaAssetSource.Export),
  sourceFileKey: z.string().min(1),
  sourceNodeId: z.string().min(1),
  url: z.string().url(),
  mimeType: z.enum(FigmaAssetMimeType),
  width: z.number().optional(),
  height: z.number().optional(),
  ttlWarning: z.string(),
}).strict();

export const FigmaDesignContextSchema = z.object({
  status: z.literal("ok"),
  tool: z.literal(ToolName.InspectFigmaDesign),
  source: z.object({
    fileKey: z.string().min(1),
    nodeId: z.string().min(1),
    fileName: z.string().min(1),
    nodeName: z.string().min(1),
  }).strict(),
  figmaTree: SimplifiedFigmaNodeSchema,
  assets: z.array(FigmaAssetRefSchema),
  warnings: z.array(z.string()),
}).strict();
