/**
 * [INPUT]: image run id
 * [OUTPUT]: one-shot server worker trigger and typed image run status from local backend
 * [POS]: B 域生图任务客户端 —— 只启动 A 域 worker 并读取状态，不直接推进 provider job
 * [PROTOCOL]: start 请求必须快速返回；后续 GET 只读取数据库中的 run/job 状态
 */
"use client";

import { req } from "@/lib/api";
import type { ImageRunView } from "@/lib/types";
import { ImageRunStatus } from "@/types/image";

export function imageRunTerminal(status: ImageRunView["status"]) {
  return status === ImageRunStatus.Succeeded || status === ImageRunStatus.Failed;
}

export function fetchImageRun(runId: string): Promise<ImageRunView> {
  return req<ImageRunView>("GET", `/api/image-runs/${runId}`);
}

export function startImageRunWorker(runId: string): Promise<void> {
  return req<void>("POST", `/api/image-runs/${runId}/start`);
}
