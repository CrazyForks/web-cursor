/**
 * [INPUT]: owner/project/conversation/toolCallId context + generate_image args
 * [OUTPUT]: persisted image run with one image job per requested image
 * [POS]: A 域异步生图任务创建层 —— 只创建 pending run/jobs，不调用 provider
 * [PROTOCOL]: conversation lock 内确认 exact pending generate_image 后才能创建 run/jobs
 */
import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { findNextPendingToolCall } from "@/lib/pendingToolCall";
import { db } from "@/server/db";
import { imageJobs, imageRuns, messages } from "@/server/db/schema";
import {
  ImageJobStatus,
  ImageProvider,
  ImageProviderModel,
  ImageRunLifecycleErrorCode,
  ImageRunStatus,
  type ImageProviderModel as ImageProviderModelValue,
  type GenerateImageInput,
  type PendingImageJob,
} from "@/types/image";
import { ToolName } from "@/types/tool";

type ImageRunTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class ImageRunLifecycleError extends Error {
  constructor(
    readonly code: typeof ImageRunLifecycleErrorCode[
      keyof typeof ImageRunLifecycleErrorCode
    ],
    readonly toolCallId: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ImageRunLifecycleError";
  }
}

export type CreateImageRunInput = {
  ownerId: string;
  projectId: string;
  conversationId: string;
  toolCallId: string;
  input: GenerateImageInput;
};

export type PendingImageRun = {
  runId: string;
  jobs: PendingImageJob[];
};

export function configuredImageProviderModel(): ImageProviderModelValue {
  const model = process.env.YUNWU_IMAGE_MODEL ?? ImageProviderModel.YunwuGemini31FlashImagePreview;
  if (!Object.values(ImageProviderModel).includes(model as ImageProviderModelValue)) {
    throw new Error(`Unsupported YUNWU_IMAGE_MODEL: ${model}`);
  }
  return model as ImageProviderModelValue;
}

export async function exactPendingGenerateImageCall(
  conversationId: string,
  toolCallId: string,
  tx: ImageRunTransaction,
): Promise<boolean> {
  const rows = await tx
    .select()
    .from(messages)
    .where(and(
      eq(messages.conversationId, conversationId),
      isNull(messages.deletedAt),
    ))
    .orderBy(asc(messages.seq));
  const pending = findNextPendingToolCall(rows);
  return pending?.id === toolCallId
    && pending.name === ToolName.GenerateImage;
}

export async function createPendingImageRun(input: CreateImageRunInput): Promise<PendingImageRun> {
  const providerModel = configuredImageProviderModel();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.conversationId}))`,
    );
    if (!await exactPendingGenerateImageCall(
      input.conversationId,
      input.toolCallId,
      tx,
    )) {
      throw new ImageRunLifecycleError(
        ImageRunLifecycleErrorCode.ToolCallNotPending,
        input.toolCallId,
        `Tool call ${input.toolCallId} is not the next pending generate_image call.`,
      );
    }

    const [run] = await tx.insert(imageRuns).values({
      ownerId: input.ownerId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      toolCallId: input.toolCallId,
      status: ImageRunStatus.Pending,
    }).returning({ id: imageRuns.id });

    const rows = await tx.insert(imageJobs).values(input.input.images.map((image) => ({
      runId: run.id,
      status: ImageJobStatus.Pending,
      input: image,
      provider: ImageProvider.Yunwu,
      providerModel,
    }))).returning({
      id: imageJobs.id,
      input: imageJobs.input,
    });

    return {
      runId: run.id,
      jobs: rows.map((row) => ({
        jobId: row.id,
        label: row.input.label,
        prompt: row.input.prompt,
        aspectRatio: row.input.aspectRatio,
        inputImages: row.input.inputImages,
      })),
    };
  });
}

export function pendingImageRunResult(run: PendingImageRun) {
  return {
    status: "pending" as const,
    tool: ToolName.GenerateImage,
    runId: run.runId,
    jobs: run.jobs,
    message: "Image generation started.",
  };
}
