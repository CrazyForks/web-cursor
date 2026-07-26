import { z } from "zod";

export const ImageRunStatus = {
  Pending: "pending",
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;

export type ImageRunStatus = typeof ImageRunStatus[keyof typeof ImageRunStatus];

export const ImageRunLifecycleErrorCode = {
  ToolCallNotPending: "IMAGE_TOOL_CALL_NOT_PENDING",
  ToolCallClosed: "IMAGE_TOOL_CALL_CLOSED",
  AttributionIncomplete: "IMAGE_ATTRIBUTION_INCOMPLETE",
  AttributionConflict: "IMAGE_ATTRIBUTION_CONFLICT",
} as const;

export type ImageRunLifecycleErrorCode =
  typeof ImageRunLifecycleErrorCode[keyof typeof ImageRunLifecycleErrorCode];

export type ImageRunLifecycleError = {
  code: ImageRunLifecycleErrorCode;
  message: string;
};

export const ImageRunLifecycleErrorSchema = z.object({
  code: z.enum(ImageRunLifecycleErrorCode),
  message: z.string(),
}).strict();

export const ImageJobStatus = {
  Pending: "pending",
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;

export type ImageJobStatus = typeof ImageJobStatus[keyof typeof ImageJobStatus];

export const ImageAssetSource = {
  GeneratedImage: "generated_image",
  FigmaExport: "figma_export",
  Upload: "upload",
} as const;

export type ImageAssetSource = typeof ImageAssetSource[keyof typeof ImageAssetSource];

export const ImageAssetSourceSchema = z.enum(ImageAssetSource);

export const GeneratedImageMimeType = {
  Png: "image/png",
  Jpeg: "image/jpeg",
  Webp: "image/webp",
} as const;

export type GeneratedImageMimeType = typeof GeneratedImageMimeType[keyof typeof GeneratedImageMimeType];

export const GeneratedImageMimeTypeSchema = z.enum(GeneratedImageMimeType);

export const ImageAspectRatio = {
  Square: "1:1",
  FourThree: "4:3",
  ThreeTwo: "3:2",
  SixteenNine: "16:9",
  TwentyOneNine: "21:9",
  NineSixteen: "9:16",
} as const;

export type ImageAspectRatio = typeof ImageAspectRatio[keyof typeof ImageAspectRatio];

export const ImageProvider = {
  Yunwu: "yunwu",
} as const;

export type ImageProvider = typeof ImageProvider[keyof typeof ImageProvider];

export const ImageProviderModel = {
  YunwuGemini31FlashImagePreview: "gemini-3.1-flash-image-preview",
  YunwuFalNanoBanana: "fal-ai/nano-banana",
} as const;

export type ImageProviderModel = typeof ImageProviderModel[keyof typeof ImageProviderModel];

export const GenerateImageInputImageSource = {
  Attachment: "attachment",
  ProjectAsset: "project_asset",
} as const;

export type GenerateImageInputImageSource =
  typeof GenerateImageInputImageSource[keyof typeof GenerateImageInputImageSource];

export const ImageJobErrorCode = {
  BadArgs: "IMAGE_BAD_ARGS",
  ProviderUnavailable: "IMAGE_PROVIDER_UNAVAILABLE",
  ProviderFailed: "IMAGE_PROVIDER_FAILED",
  TimedOut: "IMAGE_TIMED_OUT",
  UnsafeRequest: "IMAGE_UNSAFE_REQUEST",
  StorageFailed: "IMAGE_STORAGE_FAILED",
  AssetWriteFailed: "IMAGE_ASSET_WRITE_FAILED",
  AgentRunCancelled: "IMAGE_AGENT_RUN_CANCELLED",
} as const;

export type ImageJobErrorCode = typeof ImageJobErrorCode[keyof typeof ImageJobErrorCode];

export const ImageJobErrorCodeSchema = z.enum(ImageJobErrorCode);

export type GenerateImageItemInput = {
  label?: string;
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  inputImages?: GenerateImageInputImage[];
};

export type GenerateImageInput = {
  images: GenerateImageItemInput[];
};

export type GenerateImageInputImage =
  | {
      source: typeof GenerateImageInputImageSource.Attachment;
      attachmentId: string;
    }
  | {
      source: typeof GenerateImageInputImageSource.ProjectAsset;
      assetId: string;
    };

export type PendingImageJob = {
  jobId: string;
  label?: string;
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  inputImages?: GenerateImageInputImage[];
};

export type ImageJobError = {
  code: ImageJobErrorCode;
  message: string;
};

export const ImageJobErrorSchema = z.object({
  code: ImageJobErrorCodeSchema,
  message: z.string(),
}).strict();

export type GenerateImageJobResult = {
  assetId: string;
  url: string;
  mimeType: GeneratedImageMimeType;
  width: number;
  height: number;
};

export const GenerateImageJobResultSchema = z.object({
  assetId: z.string().uuid(),
  url: z.string().url(),
  mimeType: GeneratedImageMimeTypeSchema,
  width: z.number().int(),
  height: z.number().int(),
}).strict();

export type GenerateImageRunResult = {
  assets: ProjectAssetRef[];
  errors?: ImageJobError[];
  lifecycleError?: ImageRunLifecycleError;
};

export type ProjectAssetRef = {
  assetId: string;
  imageJobId?: string;
  label?: string;
  url: string;
  mimeType: GeneratedImageMimeType;
  width: number;
  height: number;
  source: typeof ImageAssetSource.GeneratedImage;
};

export const ProjectAssetRefSchema = z.object({
  assetId: z.string().uuid(),
  imageJobId: z.string().uuid().optional(),
  label: z.string().min(1).max(80).optional(),
  url: z.string().url(),
  mimeType: GeneratedImageMimeTypeSchema,
  width: z.number().int(),
  height: z.number().int(),
  source: z.literal(ImageAssetSource.GeneratedImage),
}).strict();

export const GenerateImageSucceededRunResultSchema = z.object({
  assets: z.array(ProjectAssetRefSchema).min(1),
}).strict();

export const GenerateImageFailedRunResultSchema = z.object({
  assets: z.array(ProjectAssetRefSchema),
  errors: z.array(ImageJobErrorSchema).min(1),
}).strict();

export const GenerateImageRunResultSchema = z.union([
  GenerateImageSucceededRunResultSchema,
  GenerateImageFailedRunResultSchema,
]);
