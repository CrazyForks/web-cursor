/**
 * [INPUT]: 当前 Monaco 光标上下文 + AbortSignal
 * [OUTPUT]: inline completion response
 * [POS]: B 域 → A 域轻量代码补全 API 门面
 * [PROTOCOL]: 只请求插入文本；不写文件、不进 chat transcript、不触发预览。
 */
"use client";

import { getOwnerId } from "./owner";
import type {
  CodeCompletionRequest,
  CodeCompletionResponse,
} from "@/types/codeCompletion";

export async function requestCodeCompletion(
  body: CodeCompletionRequest,
  signal?: AbortSignal
): Promise<CodeCompletionResponse> {
  const res = await fetch("/api/code-completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-owner-id": getOwnerId(),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/api/code-completions ${res.status} ${detail}`.trim());
  }

  return await res.json() as CodeCompletionResponse;
}
