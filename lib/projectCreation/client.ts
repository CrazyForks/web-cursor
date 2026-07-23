/**
 * [INPUT]: 客户端生成的 project UUID 与标题
 * [OUTPUT]: 已完成本地 Browser Git provision 且服务端记录严格匹配的 Project
 * [POS]: B 域 Browser Git 项目创建协调器 —— HomePage 与 ProjectHome 的唯一创建协议实现
 * [PROTOCOL]: 必须先 local provision/init，再以同 UUID POST /api/projects；响应不匹配时明确失败。
 */
"use client";

import { req } from "@/lib/api";
import { normalizeCreatedProject, type BrowserGitProject } from "@/lib/projectTypes";
import { provisionClientBrowserGitProjectRepository } from "@/lib/projectRepository/client";
import { ProjectRepositoryError, ProjectRepositoryErrorCode } from "@/types/projectRepository";
import { ProjectStorageKind } from "@/types/projectStorage";

const DEFAULT_BROWSER_GIT_BRANCH = "main";

export async function createBrowserGitProject(projectId: string, title: string): Promise<BrowserGitProject> {
  await provisionClientBrowserGitProjectRepository(projectId, DEFAULT_BROWSER_GIT_BRANCH);
  const project = normalizeCreatedProject(await req<unknown>("POST", "/api/projects", {
    id: projectId,
    title,
    storageKind: ProjectStorageKind.BrowserGit,
  }));

  if (
    project.id !== projectId
    || project.title !== title
    || project.storageKind !== ProjectStorageKind.BrowserGit
  ) {
    throw new ProjectRepositoryError(
      ProjectRepositoryErrorCode.ProtocolViolation,
      "Browser Git create response does not match the provisioned repository.",
    );
  }

  return project;
}
