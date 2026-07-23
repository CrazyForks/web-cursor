/**
 * [INPUT]: optional projectId plus Workbench controller actions for project/chat/files/preview
 * [OUTPUT]: route-scoped project/workspace 状态、conversation list 与项目会话 actions
 * [POS]: B 域项目会话协调层 —— 先确认后端项目事实，再独立装载 workspace
 * [PROTOCOL]: 项目存在性/storage 以后端详情为准；Browser Git 本地缺失只进入 workspace.local_repository_missing。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useProjectRuntime,
  useProjectRuntimeStoreApi,
} from "@/components/project/ProjectRuntimeProvider";
import { req } from "@/lib/api";
import {
  ProjectDetailSchema,
  type ProjectDetail,
  type ProjectFileSummary,
  type RepositoryProjectRef,
  type StoredMessage,
} from "@/lib/projectTypes";
import type { ImageRunView } from "@/lib/types";
import { hasCompleteReactProject } from "@/lib/projectContract";
import { ProjectRuntimeProjectStatus } from "@/lib/projectRuntimeStore";
import { ToolName } from "@/types/tool";
import { ProjectStorageKind } from "@/types/projectStorage";
import {
  type ProjectRepositoryDescriptor,
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
} from "@/types/projectRepository";

type TitleUpdate = {
  conversationId: string;
  title: string;
  projectTitle?: string;
};

type UseProjectSessionParams = {
  projectId?: string;
  currentConversationId?: string;
  lastTitleUpdate: TitleUpdate | null;
  openProject: (project: RepositoryProjectRef) => ProjectRepositoryDescriptor;
  restoreConversation: (project: RepositoryProjectRef, conversationId: string, rows: StoredMessage[]) => Promise<void>;
  loadFiles: (projectId: string, preferredPath?: string) => Promise<ProjectFileSummary[]>;
  runPreview: (projectId: string) => Promise<unknown>;
  onToast: (message: string) => void;
};

function assistantToolCallIds(meta: unknown): string[] {
  const toolCalls = (meta as { toolCalls?: { id?: unknown; name?: unknown }[] } | null)?.toolCalls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((toolCall) => toolCall.name === ToolName.GenerateImage && typeof toolCall.id === "string")
    .map((toolCall) => toolCall.id as string);
}

function attachImageRuns(rows: StoredMessage[], imageRuns: ImageRunView[]): StoredMessage[] {
  const byToolCallId = new Map<string, ImageRunView[]>();
  for (const run of imageRuns) {
    byToolCallId.set(run.toolCallId, [...(byToolCallId.get(run.toolCallId) ?? []), run]);
  }

  return rows.map((row) => {
    if (row.role !== "assistant") return row;
    const runs = assistantToolCallIds(row.meta).flatMap((toolCallId) => byToolCallId.get(toolCallId) ?? []);
    return runs.length ? { ...row, imageRuns: runs } : row;
  });
}

export function useProjectSession({
  projectId,
  currentConversationId,
  lastTitleUpdate,
  openProject,
  restoreConversation,
  loadFiles,
  runPreview,
  onToast,
}: UseProjectSessionParams) {
  const projectState = useProjectRuntime((state) => state.project);
  const workspaceState = useProjectRuntime((state) => state.workspace);
  const runtimeStore = useProjectRuntimeStoreApi();
  const projectDetail = projectState.status === ProjectRuntimeProjectStatus.Ready
    ? projectState.detail
    : null;
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);

  const openConversationForProject = useCallback(
    async (detail: ProjectDetail, conversationId: string) => {
      setLoadingConversationId(conversationId);
      try {
        const [rows, imageRuns] = await Promise.all([
          req<StoredMessage[]>("GET", `/api/conversations/${conversationId}/messages`),
          req<ImageRunView[]>("GET", `/api/conversations/${conversationId}/image-runs`),
        ]);
        await restoreConversation(
          detail,
          conversationId,
          attachImageRuns(rows, imageRuns),
        );
      } catch (e) {
        onToast(String(e instanceof Error ? e.message : e));
      } finally {
        setLoadingConversationId(null);
      }
    },
    [onToast, restoreConversation]
  );

  const loadProject = useCallback(async () => {
    if (!projectId) return;

    runtimeStore.getState().loadProject(projectId);
    let detail: ProjectDetail;
    try {
      detail = ProjectDetailSchema.parse(
        await req<unknown>("GET", `/api/projects/${projectId}`),
      );
      runtimeStore.getState().setProjectReady(detail);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      runtimeStore.getState().setProjectError(projectId, message);
      onToast(message);
      return;
    }

    runtimeStore.getState().setWorkspaceLoading(detail.id);
    let descriptor: ProjectRepositoryDescriptor;
    try {
      descriptor = openProject(detail);
      await loadFiles(detail.id);
      runtimeStore.getState().setWorkspaceReady(descriptor);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (
        error instanceof ProjectRepositoryError
        && error.code === ProjectRepositoryErrorCode.LocalRepositoryMissing
      ) {
        runtimeStore.getState().setWorkspaceLocalRepositoryMissing(detail.id, message);
      } else {
        runtimeStore.getState().setWorkspaceError(detail.id, message);
      }
      onToast(message);
      return;
    }

    const initialConversationId = detail.conversations[0]?.id;
    if (initialConversationId) {
      await openConversationForProject(detail, initialConversationId);
    } else if (
      detail.storageKind === ProjectStorageKind.Database
      && hasCompleteReactProject(detail.files)
    ) {
      void runPreview(detail.id);
    }
  }, [loadFiles, onToast, openConversationForProject, openProject, projectId, runPreview, runtimeStore]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  const openConversation = useCallback(
    async (conversationId: string) => {
      if (!projectDetail) return;
      await openConversationForProject(projectDetail, conversationId);
    },
    [openConversationForProject, projectDetail]
  );

  const newConversation = useCallback(() => {
    if (!projectDetail) return;
    openProject(projectDetail);
  }, [openProject, projectDetail]);

  useEffect(() => {
    if (!lastTitleUpdate) return;
    const currentProject = runtimeStore.getState().project;
    if (currentProject.status !== ProjectRuntimeProjectStatus.Ready) return;
    const detail = currentProject.detail;
    runtimeStore.getState().setProjectReady({
      ...detail,
      title: lastTitleUpdate.projectTitle ?? detail.title,
      conversations: detail.conversations.map((conversation) =>
        conversation.id === lastTitleUpdate.conversationId
          ? { ...conversation, title: lastTitleUpdate.title }
          : conversation
      ),
    });
  }, [lastTitleUpdate, runtimeStore]);

  useEffect(() => {
    if (!projectDetail || !currentConversationId) return;
    if (projectDetail.conversations.some((conversation) => conversation.id === currentConversationId)) return;

    req<unknown>("GET", `/api/projects/${projectDetail.id}`)
      .then((value) => runtimeStore.getState().setProjectReady(ProjectDetailSchema.parse(value)))
      .catch((e) => onToast(String(e instanceof Error ? e.message : e)));
  }, [currentConversationId, onToast, projectDetail, runtimeStore]);

  return {
    projectState,
    workspaceState,
    projectDetail,
    conversations: projectDetail?.conversations ?? [],
    loadingConversationId,
    retryProject: loadProject,
    openConversation,
    newConversation,
  };
}
