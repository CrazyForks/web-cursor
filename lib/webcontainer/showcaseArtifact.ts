/**
 * [INPUT]: showcase slug and project files
 * [OUTPUT]: uploaded static showcase artifact metadata
 * [POS]: B 域案例 artifact 生成编排 —— 浏览器 WebContainer build 后上传完整 dist 产物
 * [PROTOCOL]: 构建在浏览器执行；上传字段由服务端 schema 校验；文件 hash 由确定性 path/content 序列计算。
 */
"use client";

import { buildWebContainerStaticArtifact } from "@/lib/webcontainer/runtime";
import type { WebContainerProjectFile, WebContainerRunEvent } from "@/lib/webcontainer/types";

export type SaveShowcaseArtifactResponse = {
  id: string;
  filesHash: string;
  sizeBytes: number;
  entryUrl: string;
  createdAt: string;
};

function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashProjectFiles(files: WebContainerProjectFile[]) {
  const stable = files
    .toSorted((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}\0${file.content}`)
    .join("\0\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
  return bytesToHex(digest);
}

export async function generateAndUploadShowcaseArtifact(input: {
  slug: string;
  files: WebContainerProjectFile[];
  onEvent: (event: WebContainerRunEvent) => void;
}) {
  const filesHash = await hashProjectFiles(input.files);
  const built = await buildWebContainerStaticArtifact({
    files: input.files,
    onEvent: input.onEvent,
  });

  const body = new FormData();
  body.set("slug", input.slug);
  body.set("filesHash", filesHash);
  body.set("buildLog", built.rawLog);
  for (const file of built.files) {
    body.append(`artifactFile:${encodeURIComponent(file.path)}`, new Blob([file.bytes]));
  }

  const response = await fetch("/api/showcase-artifacts", {
    method: "POST",
    body,
  });
  const payload = await response.json().catch(() => null) as SaveShowcaseArtifactResponse | { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload && "error" in payload && payload.error ? payload.error : `保存静态预览失败：${response.status}`);
  }
  if (!payload || !("id" in payload)) throw new Error("保存静态预览响应格式错误");
  return payload;
}
