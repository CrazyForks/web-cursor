/**
 * [INPUT]: owner-scoped image run id
 * [OUTPUT]: updated image_jobs/image_runs/project_assets and a durably closed AgentRun invocation
 * [POS]: A 域生图 runner —— 前端只负责唤醒，服务端独立轮询指定 run 直到终态
 * [PROTOCOL]: runner 只处理 owner/runId 精确命中的 active run；provider 返回 URL/data URL 必须下载并写入 project_assets 后才暴露
 *   并发铁律：submit 和 poll 都必须先原子认领（条件 UPDATE ... RETURNING）再调 provider；
 *   每次 provider/asset 副作用先经过 AgentRun fence；归属 AgentRun 的 run 终态、tool result 与 waiting_resume 原子提交。
 */
import "server-only";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { imageJobs, imageRuns } from "@/server/db/schema";
import {
  AgentRunServiceError,
  AgentRunServiceErrorCode,
  recordAsyncToolResult,
  startAsyncToolEffect,
  withAsyncToolEffectFence,
} from "@/server/agentRuns";
import { exactPendingGenerateImageCall } from "@/server/image/jobs";
import { appendMessage } from "@/server/messages";
import { pollImageProviderJob, providerError, submitImageProviderJob } from "@/server/image/provider";
import { resolveProviderInputImages, saveGeneratedProjectAsset } from "@/server/image/storage";
import {
  AgentToolResultKind,
} from "@/types/agentRun";
import {
  ImageAssetSource,
  ImageJobErrorCode,
  ImageJobStatus,
  ImageRunLifecycleErrorCode,
  ImageRunStatus,
  type GenerateImageRunResult,
  type ImageJobError,
  type ImageRunLifecycleError,
} from "@/types/image";
import { ToolName } from "@/types/tool";
import { GenerateImageTerminalResultSchema } from "@/types/toolResult";

const MAX_JOBS_PER_TICK = 4;
const POLL_INTERVAL_MS = 5_000;
const PROVIDER_TIMEOUT_MS = 5 * 60_000;

type ImageJobRow = typeof imageJobs.$inferSelect;
type ImageRunRow = typeof imageRuns.$inferSelect;

type RunnerJob = {
  job: ImageJobRow;
  run: ImageRunRow;
};

export type ImageRunWorkerState = {
  found: boolean;
  terminal: boolean;
};

const activeWorkers = new Map<string, Promise<void>>();

function nowMinus(ms: number) {
  return new Date(Date.now() - ms);
}

function errorOf(code: ImageJobErrorCode, message: string): ImageJobError {
  return { code, message };
}

function imageRunTerminal(status: ImageRunRow["status"]): boolean {
  return status === ImageRunStatus.Succeeded
    || status === ImageRunStatus.Failed
    || status === ImageRunStatus.Cancelled;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findOwnedRun(runId: string, ownerId: string): Promise<ImageRunRow | null> {
  const [run] = await db
    .select()
    .from(imageRuns)
    .where(and(
      eq(imageRuns.id, runId),
      eq(imageRuns.ownerId, ownerId),
      isNull(imageRuns.deletedAt),
    ))
    .limit(1);
  return run ?? null;
}

async function pendingCandidates(runId: string, ownerId: string, limit: number): Promise<RunnerJob[]> {
  return db
    .select({ job: imageJobs, run: imageRuns })
    .from(imageJobs)
    .innerJoin(imageRuns, eq(imageJobs.runId, imageRuns.id))
    .where(and(
      eq(imageRuns.id, runId),
      eq(imageRuns.ownerId, ownerId),
      inArray(imageRuns.status, [ImageRunStatus.Pending, ImageRunStatus.Running]),
      eq(imageJobs.status, ImageJobStatus.Pending),
      isNull(imageJobs.deletedAt),
      isNull(imageRuns.deletedAt),
    ))
    .orderBy(asc(imageJobs.createdAt))
    .limit(limit);
}

async function pollCandidates(runId: string, ownerId: string, limit: number): Promise<RunnerJob[]> {
  return db
    .select({ job: imageJobs, run: imageRuns })
    .from(imageJobs)
    .innerJoin(imageRuns, eq(imageJobs.runId, imageRuns.id))
    .where(and(
      eq(imageRuns.id, runId),
      eq(imageRuns.ownerId, ownerId),
      inArray(imageRuns.status, [ImageRunStatus.Pending, ImageRunStatus.Running]),
      eq(imageJobs.status, ImageJobStatus.Running),
      isNull(imageJobs.deletedAt),
      isNull(imageRuns.deletedAt),
      or(
        isNull(imageJobs.lastPolledAt),
        lt(imageJobs.lastPolledAt, nowMinus(POLL_INTERVAL_MS)),
      ),
    ))
    .orderBy(asc(imageJobs.createdAt))
    .limit(limit);
}

async function claimCandidates(
  candidates: RunnerJob[],
  claim: (job: ImageJobRow) => Promise<ImageJobRow | null>,
): Promise<RunnerJob[]> {
  const claimed = await Promise.all(candidates.map(async (candidate) => {
    const job = await claim(candidate.job);
    return job ? { ...candidate, job } : null;
  }));
  return claimed.filter((candidate): candidate is RunnerJob => candidate !== null);
}

async function claimPending(job: ImageJobRow): Promise<ImageJobRow | null> {
  const now = new Date();
  const [claimed] = await db
    .update(imageJobs)
    .set({
      status: ImageJobStatus.Running,
      startedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(imageJobs.id, job.id),
      eq(imageJobs.status, ImageJobStatus.Pending),
      isNull(imageJobs.deletedAt),
    ))
    .returning();

  if (!claimed) return null;

  await db
    .update(imageRuns)
    .set({
      status: ImageRunStatus.Running,
      startedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(imageRuns.id, claimed.runId),
      inArray(imageRuns.status, [ImageRunStatus.Pending, ImageRunStatus.Running]),
      isNull(imageRuns.deletedAt),
    ));

  return claimed;
}

/**
 * 原子认领一个待轮询 job：以观察到的 lastPolledAt 作为 CAS 前提，
 * 重叠 tick 里只有一个能把它推进，避免同一 job 被并发 poll → 重复写 blob / project_assets。
 */
async function claimPolling(job: ImageJobRow): Promise<ImageJobRow | null> {
  const now = new Date();
  const [claimed] = await db
    .update(imageJobs)
    .set({ lastPolledAt: now, updatedAt: now })
    .where(and(
      eq(imageJobs.id, job.id),
      eq(imageJobs.status, ImageJobStatus.Running),
      isNull(imageJobs.deletedAt),
      job.lastPolledAt === null
        ? isNull(imageJobs.lastPolledAt)
        : eq(imageJobs.lastPolledAt, job.lastPolledAt),
    ))
    .returning();

  return claimed ?? null;
}

/** 终态只能从 running 跃迁：已经闭合的 job 不会被后到的 tick 覆盖成另一个结果。 */
async function failJob(jobId: string, error: ImageJobError) {
  const now = new Date();
  await db
    .update(imageJobs)
    .set({
      status: ImageJobStatus.Failed,
      error,
      updatedAt: now,
      completedAt: now,
    })
    .where(and(
      eq(imageJobs.id, jobId),
      eq(imageJobs.status, ImageJobStatus.Running),
      isNull(imageJobs.deletedAt),
    ));
}

async function succeedJob(ctx: {
  run: ImageRunRow;
  job: ImageJobRow;
  bytes: Buffer;
  mimeType: Parameters<typeof saveGeneratedProjectAsset>[0]["mimeType"];
  publicBaseUrl?: string;
}) {
  const result = await saveGeneratedProjectAsset({
    ownerId: ctx.run.ownerId,
    projectId: ctx.run.projectId,
    imageJobId: ctx.job.id,
    bytes: ctx.bytes,
    mimeType: ctx.mimeType,
    publicBaseUrl: ctx.publicBaseUrl,
  });
  const now = new Date();
  await db
    .update(imageJobs)
    .set({
      status: ImageJobStatus.Succeeded,
      result,
      error: null,
      updatedAt: now,
      completedAt: now,
    })
    .where(and(
      eq(imageJobs.id, ctx.job.id),
      eq(imageJobs.status, ImageJobStatus.Running),
      isNull(imageJobs.deletedAt),
    ));
}

async function withImageRunEffectFence<T>(
  run: ImageRunRow,
  operation: () => Promise<T>,
): Promise<T> {
  if (run.agentRunId === null && run.toolInvocationId === null) {
    return operation();
  }
  if (run.agentRunId === null || run.toolInvocationId === null) {
    throw new Error(`Image run ${run.id} has incomplete AgentRun attribution.`);
  }
  return withAsyncToolEffectFence({
    ownerId: run.ownerId,
    runId: run.agentRunId,
    invocationId: run.toolInvocationId,
    operation,
  });
}

async function startImageRunProviderEffect<T>(
  run: ImageRunRow,
  start: () => Promise<T>,
): Promise<T> {
  if (run.agentRunId === null && run.toolInvocationId === null) {
    return start();
  }
  if (run.agentRunId === null || run.toolInvocationId === null) {
    throw new Error(`Image run ${run.id} has incomplete AgentRun attribution.`);
  }
  const started = await startAsyncToolEffect({
    ownerId: run.ownerId,
    runId: run.agentRunId,
    invocationId: run.toolInvocationId,
    start,
  });
  return started.result;
}

async function succeedAuthorizedJob(
  run: ImageRunRow,
  operation: () => Promise<void>,
): Promise<void> {
  await withImageRunEffectFence(run, operation);
}

async function submitJob(run: ImageRunRow, job: ImageJobRow, options: { publicBaseUrl?: string }) {
  try {
    const inputImages = await resolveProviderInputImages({
      ownerId: run.ownerId,
      projectId: run.projectId,
      conversationId: run.conversationId,
      inputImages: job.input.inputImages,
    });
    const submitted = await startImageRunProviderEffect(
      run,
      () => submitImageProviderJob({
        model: job.providerModel,
        input: job.input,
        inputImages,
      }),
    );

    if (submitted.status === "completed") {
      await succeedAuthorizedJob(
        run,
        () => succeedJob({ run, job, bytes: submitted.bytes, mimeType: submitted.mimeType, publicBaseUrl: options.publicBaseUrl }),
      );
      return;
    }

    const now = new Date();
    await db
      .update(imageJobs)
      .set({
        providerJobId: submitted.providerJobId,
        lastPolledAt: now,
        updatedAt: now,
      })
      .where(and(eq(imageJobs.id, job.id), eq(imageJobs.status, ImageJobStatus.Running), isNull(imageJobs.deletedAt)));
  } catch (error) {
    if (
      error instanceof AgentRunServiceError
      && error.code === AgentRunServiceErrorCode.LateResult
    ) return;
    await failJob(job.id, providerError(error));
  }
}

async function pollJob(run: ImageRunRow, job: ImageJobRow, options: { publicBaseUrl?: string }) {
  try {
    const startedAt = job.startedAt?.getTime() ?? job.createdAt.getTime();
    if (Date.now() - startedAt > PROVIDER_TIMEOUT_MS) {
      await failJob(job.id, errorOf(ImageJobErrorCode.TimedOut, "Image provider timed out."));
      return;
    }
    const providerJobId = job.providerJobId;
    if (!providerJobId) return;

    const result = await startImageRunProviderEffect(
      run,
      () => pollImageProviderJob({
        model: job.providerModel,
        providerJobId,
      }),
    );
    const now = new Date();

    if (result.status === "running") {
      await db
        .update(imageJobs)
        .set({ lastPolledAt: now, updatedAt: now })
        .where(and(eq(imageJobs.id, job.id), eq(imageJobs.status, ImageJobStatus.Running), isNull(imageJobs.deletedAt)));
      return;
    }

    if (result.status === "failed") {
      await failJob(job.id, result.error);
      return;
    }

    await succeedAuthorizedJob(
      run,
      () => succeedJob({ run, job, bytes: result.bytes, mimeType: result.mimeType, publicBaseUrl: options.publicBaseUrl }),
    );
  } catch (error) {
    if (
      error instanceof AgentRunServiceError
      && error.code === AgentRunServiceErrorCode.LateResult
    ) return;
    throw error;
  }
}

/**
 * 把 run 推向终态，并在同一事务里闭合 generate_image 的 tool result。
 * 状态 CAS（只从 pending/running 跃迁）保证并发 tick 里只有一个赢家；
 * 同事务保证"标记完成"和"写 tool 消息"要么都提交、要么都不提交。
 */
async function closeRun(run: ImageRunRow, result: GenerateImageRunResult, errors: ImageJobError[]) {
  const status = errors.length ? ImageRunStatus.Failed : ImageRunStatus.Succeeded;
  const now = new Date();
  const terminalResult = GenerateImageTerminalResultSchema.parse({
    status: errors.length ? "error" : "ok",
    tool: ToolName.GenerateImage,
    runId: run.id,
    result,
  });

  if (run.agentRunId !== null || run.toolInvocationId !== null) {
    if (run.agentRunId === null || run.toolInvocationId === null) {
      throw new Error(
        `Image run ${run.id} has incomplete AgentRun attribution.`,
      );
    }
    try {
      await recordAsyncToolResult({
        ownerId: run.ownerId,
        runId: run.agentRunId,
        invocationId: run.toolInvocationId,
        providerCallId: run.toolCallId,
        toolName: ToolName.GenerateImage,
        kind: errors.length
          ? AgentToolResultKind.Error
          : AgentToolResultKind.Success,
        content: JSON.stringify(terminalResult),
        beforeReceipt: async (tx) => {
          const [closed] = await tx
            .update(imageRuns)
            .set({
              status,
              result,
              error: errors[0] ?? null,
              updatedAt: now,
              completedAt: now,
            })
            .where(and(
              eq(imageRuns.id, run.id),
              inArray(imageRuns.status, [
                ImageRunStatus.Pending,
                ImageRunStatus.Running,
              ]),
              isNull(imageRuns.deletedAt),
            ))
            .returning({ id: imageRuns.id });
          return Boolean(closed);
        },
      });
    } catch (error) {
      if (
        error instanceof AgentRunServiceError
        && error.code === AgentRunServiceErrorCode.LateResult
      ) {
        console.warn(error.message);
        return;
      }
      throw error;
    }
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${run.conversationId}))`,
    );
    const callIsPending = await exactPendingGenerateImageCall(
      run.conversationId,
      run.toolCallId,
      tx,
    );
    if (!callIsPending) {
      const lifecycleError: ImageRunLifecycleError = {
        code: ImageRunLifecycleErrorCode.ToolCallClosed,
        message: `Tool call ${run.toolCallId} is no longer pending.`,
      };
      const [stale] = await tx
        .update(imageRuns)
        .set({
          status: ImageRunStatus.Failed,
          result: { ...result, lifecycleError },
          error: null,
          updatedAt: now,
          completedAt: now,
        })
        .where(and(
          eq(imageRuns.id, run.id),
          inArray(imageRuns.status, [
            ImageRunStatus.Pending,
            ImageRunStatus.Running,
          ]),
          isNull(imageRuns.deletedAt),
        ))
        .returning({ id: imageRuns.id });

      if (stale) {
        console.warn(
          `${lifecycleError.code}: image run ${run.id} ${lifecycleError.message}`,
        );
      }
      return;
    }

    const [closed] = await tx
      .update(imageRuns)
      .set({
        status,
        result,
        error: errors[0] ?? null,
        updatedAt: now,
        completedAt: now,
      })
      .where(and(
        eq(imageRuns.id, run.id),
        inArray(imageRuns.status, [ImageRunStatus.Pending, ImageRunStatus.Running]),
        isNull(imageRuns.deletedAt),
      ))
      .returning({ id: imageRuns.id });

    if (!closed) return;   // 另一个 tick 已经闭合了这个 run

    await appendMessage(run.conversationId, {
      role: "tool",
      content: JSON.stringify(terminalResult),
      meta: { toolCallId: run.toolCallId },
    }, tx);
  });
}

async function refreshRunStatus(runId: string) {
  const [run] = await db
    .select()
    .from(imageRuns)
    .where(and(eq(imageRuns.id, runId), isNull(imageRuns.deletedAt)))
    .limit(1);
  if (!run) return;

  const jobs = await db
    .select()
    .from(imageJobs)
    .where(and(eq(imageJobs.runId, runId), isNull(imageJobs.deletedAt)))
    .orderBy(asc(imageJobs.createdAt));
  if (jobs.length === 0) return;

  const open = jobs.filter((job) => job.status === ImageJobStatus.Pending || job.status === ImageJobStatus.Running);
  if (open.length > 0) {
    const nextStatus = jobs.some((job) => job.status === ImageJobStatus.Running)
      ? ImageRunStatus.Running
      : ImageRunStatus.Pending;
    // 只在 run 仍未闭合时推进：并发 tick 已把它写成终态时不要倒退回 running。
    await db
      .update(imageRuns)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(and(
        eq(imageRuns.id, runId),
        inArray(imageRuns.status, [ImageRunStatus.Pending, ImageRunStatus.Running]),
        isNull(imageRuns.deletedAt),
      ));
    return;
  }
  if (jobs.some((job) => job.status === ImageJobStatus.Cancelled)) return;

  const assets = jobs
    .filter((job) => job.status === ImageJobStatus.Succeeded && job.result)
    .map((job) => ({
      assetId: job.result!.assetId,
      imageJobId: job.id,
      label: job.input.label,
      url: job.result!.url,
      mimeType: job.result!.mimeType,
      width: job.result!.width,
      height: job.result!.height,
      source: ImageAssetSource.GeneratedImage,
    }));
  const errors = jobs
    .filter((job) => job.status === ImageJobStatus.Failed && job.error)
    .map((job) => job.error!);
  const result: GenerateImageRunResult = {
    assets,
    ...(errors.length ? { errors } : {}),
  };

  await closeRun(run, result, errors);
}

async function getImageRunWorkerState(
  runId: string,
  ownerId: string,
): Promise<ImageRunWorkerState> {
  const run = await findOwnedRun(runId, ownerId);
  return {
    found: Boolean(run),
    terminal: run ? imageRunTerminal(run.status) : false,
  };
}

async function runImageRunTick(
  runId: string,
  ownerId: string,
  options: { publicBaseUrl?: string } = {},
): Promise<ImageRunWorkerState> {
  const run = await findOwnedRun(runId, ownerId);
  if (!run) return { found: false, terminal: false };
  if (imageRunTerminal(run.status)) {
    return { found: true, terminal: true };
  }

  const pending = await claimCandidates(
    await pendingCandidates(runId, ownerId, MAX_JOBS_PER_TICK),
    claimPending,
  );
  await Promise.all(pending.map((item) => submitJob(item.run, item.job, options)));

  const polling = await claimCandidates(
    await pollCandidates(runId, ownerId, Math.max(0, MAX_JOBS_PER_TICK - pending.length)),
    claimPolling,
  );
  await Promise.all(polling.map((item) => pollJob(item.run, item.job, options)));

  const processed = pending.length + polling.length;
  if (processed > 0) await refreshRunStatus(runId);
  return getImageRunWorkerState(runId, ownerId);
}

async function runImageRunToTerminal(
  runId: string,
  ownerId: string,
  options: { publicBaseUrl?: string },
): Promise<void> {
  while (true) {
    const tick = await runImageRunTick(runId, ownerId, options);
    if (!tick.found || tick.terminal) return;
    await wait(POLL_INTERVAL_MS);
  }
}

export function runImageRunWorker(
  runId: string,
  ownerId: string,
  options: { publicBaseUrl?: string } = {},
): Promise<void> {
  const key = `${ownerId}:${runId}`;
  const running = activeWorkers.get(key);
  if (running) return running;

  const worker = runImageRunToTerminal(runId, ownerId, options)
    .finally(() => {
      if (activeWorkers.get(key) === worker) activeWorkers.delete(key);
    });
  activeWorkers.set(key, worker);
  return worker;
}
