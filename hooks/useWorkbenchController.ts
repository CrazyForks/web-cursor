/**
 * [INPUT]: Workbench UI actions and project/conversation restore requests
 * [OUTPUT]: Workbench-facing state/actions composed from chat, files, and preview hooks
 * [POS]: B 域工作台组合层 —— 连接聊天 agent、文件编辑、预览执行
 * [PROTOCOL]: 子 hook 各守职责；这里只编排跨职责流程，如“保存后预览”。
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import {
  useProjectRuntime,
  useProjectRuntimeStoreApi,
} from "@/components/project/ProjectRuntimeProvider";
import { useTranslations } from "next-intl";
import { useChat } from "@/hooks/useChat";
import { usePreview } from "@/hooks/usePreview";
import { type PersistedFileChange, useProjectFiles } from "@/hooks/useProjectFiles";
import { req } from "@/lib/api";
import { ProjectDetailSchema, type RepositoryProjectRef, type StoredMessage } from "@/lib/projectTypes";
import {
  ProjectRuntimeProjectStatus,
  type ProjectRuntimeStoreApi,
} from "@/lib/projectRuntimeStore";
import { ChatEventType, type ChatEvent } from "@/types/chat";
import { ProjectStorageKind } from "@/types/projectStorage";
import {
  type ProjectRepositoryDescriptor,
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
} from "@/types/projectRepository";

const APP_ENTRY_PATH = "src/App.tsx";
const PREVIEW_ENTRY_FILES = ["index.html", "package.json"] as const;
const PREVIEW_SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".css"] as const;

function pathAffectsPreview(path: string) {
  return PREVIEW_ENTRY_FILES.includes(path as (typeof PREVIEW_ENTRY_FILES)[number])
    || PREVIEW_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function persistedChangeAffectsPreview(change: PersistedFileChange) {
  return pathAffectsPreview(change.path) || (change.oldPath ? pathAffectsPreview(change.oldPath) : false);
}

async function hydrateInitializedProjectRuntime(
  runtimeStore: ProjectRuntimeStoreApi,
  descriptor: ProjectRepositoryDescriptor,
) {
  runtimeStore.getState().loadProject(descriptor.projectId);
  try {
    const detail = ProjectDetailSchema.parse(
      await req<unknown>("GET", `/api/projects/${descriptor.projectId}`),
    );
    if (detail.id !== descriptor.projectId || detail.storageKind !== descriptor.storageKind) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.ProtocolViolation,
        "Initialized project detail does not match its repository descriptor.",
      );
    }
    runtimeStore.getState().setProjectReady(detail);
    runtimeStore.getState().setWorkspaceLoading(detail.id);
    runtimeStore.getState().setWorkspaceReady(descriptor);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    console.error("Failed to hydrate initialized project runtime", error);
    runtimeStore.getState().setProjectError(descriptor.projectId, message);
  }
}

export function useWorkbenchController(options: {
  onProjectInitialized?: (project: { projectId: string; conversationId: string }) => void;
} = {}) {
  const tPreview = useTranslations("Preview");
  const tCommon = useTranslations("Common");
  const projectRuntimeState = useProjectRuntime((state) => state.project);
  const projectRuntimeStore = useProjectRuntimeStoreApi();
  const onProjectInitialized = options.onProjectInitialized;
  const files = useProjectFiles();
  const preview = usePreview(files.readProjectFiles);
  const [projName, setProjName] = useState(tCommon("untitledProject"));

  const handlePersistedFileChange = useCallback(
    async (change: PersistedFileChange | null, source: "ai" | "user") => {
      if (!change) return null;
      const shouldRunPreview = persistedChangeAffectsPreview(change);
      if (!shouldRunPreview) {
        preview.setStatus({
          kind: "",
          text: source === "user" ? tPreview("fileSavedNoPreview") : tPreview("fileUpdatedNoPreview"),
        });
      }
      return { projectId: change.projectId, shouldRunPreview };
    },
    [preview.setStatus]
  );

  const handleUserPersistedFileChange = useCallback(
    async (change: PersistedFileChange | null) => {
      try {
        await change?.sync;
      } catch (error) {
        preview.setOverlay({
          show: true,
          title: "Save Error",
          message: String(error instanceof Error ? error.message : error),
          stack: error instanceof Error ? error.stack ?? "" : "",
          showStack: false,
        });
        preview.setStatus({ kind: "err", text: tPreview("saveFailed") });
        return;
      }

      const handled = await handlePersistedFileChange(change, "user");
      if (handled?.shouldRunPreview) {
        await preview.runPreview(handled.projectId);
      } else if (change) {
        preview.setStatus({ kind: "", text: tPreview("fileSavedNoPreview") });
      }
    },
    [handlePersistedFileChange, preview.runPreview, preview.setOverlay, preview.setStatus, tPreview]
  );

  const chatDeps = useMemo(() => ({
    loadFiles: files.loadFiles,
    executeClientFileTool: files.executeClientFileTool,
    executeClientGitTool: files.executeClientGitTool,
    handlePersistedFileChange: async (ev: Extract<ChatEvent, { type: typeof ChatEventType.FilesChanged }>) => {
      const change = await files.syncFileChange(ev);
      return handlePersistedFileChange(change, "ai");
    },
    runPreview: preview.runPreview,
    setPreviewStatus: preview.setStatus,
    onError: (error: unknown) => {
      preview.setOverlay({
        show: true,
        title: "Agent Error",
        message: String(error instanceof Error ? error.message : error),
        stack: error instanceof Error ? error.stack ?? "" : "",
        showStack: false,
      });
    },
    onProjectInitialized: (project: {
      repository: ProjectRepositoryDescriptor;
      conversationId: string;
    }) => {
      files.setProjectRepository(project.repository, []);
      void hydrateInitializedProjectRuntime(projectRuntimeStore, project.repository);
      onProjectInitialized?.({
        projectId: project.repository.projectId,
        conversationId: project.conversationId,
      });
    },
    onTitleUpdate: (update: { conversationId: string; title: string; projectTitle?: string }) => {
      if (update.projectTitle) setProjName(update.projectTitle);
    },
  }), [
    files.loadFiles,
    files.executeClientFileTool,
    files.executeClientGitTool,
    files.setProjectRepository,
    files.setProjectFiles,
    files.syncFileChange,
    handlePersistedFileChange,
    onProjectInitialized,
    projectRuntimeStore,
    preview.runPreview,
    preview.setOverlay,
    preview.setStatus,
  ]);

  const chat = useChat(chatDeps);
  const storageKind = projectRuntimeState.status === ProjectRuntimeProjectStatus.Ready
    ? projectRuntimeState.detail.storageKind
    : undefined;

  const openProject = useCallback((project: RepositoryProjectRef) => {
    setProjName(project.title || tCommon("untitledProject"));
    const descriptor = files.setProjectFiles(project);
    chat.openProjectChat({ id: project.id, title: project.title });
    preview.resetPreview(
      files.hasCompleteReactProject(
        project.storageKind === ProjectStorageKind.Database ? project.files ?? [] : [],
      )
        ? tPreview("selectConversation")
        : tPreview("completeProjectFirst")
    );
    return descriptor;
  }, [
    chat.openProjectChat,
    files.hasCompleteReactProject,
    files.setProjectFiles,
    preview.resetPreview,
    tCommon,
    tPreview,
  ]);

  const openConversation = useCallback(
    async (project: RepositoryProjectRef, conversationId: string, rows: StoredMessage[]) => {
      setProjName(project.title || tCommon("untitledProject"));
      await chat.openConversation({ id: project.id, title: project.title }, conversationId, rows);
      const loadedFiles = await files.loadFiles(project.id, APP_ENTRY_PATH);
      if (files.hasCompleteReactProject(loadedFiles)) {
        await preview.runPreview(project.id);
      } else {
        preview.resetPreview(tPreview("completeProjectFirst"));
      }
    },
    [
      chat.openConversation,
      files.hasCompleteReactProject,
      files.loadFiles,
      preview.resetPreview,
      preview.runPreview,
      tCommon,
      tPreview,
    ]
  );

  const saveActiveFile = useCallback(async () => {
    await handleUserPersistedFileChange(await files.saveActiveFile());
  }, [files.saveActiveFile, handleUserPersistedFileChange]);

  const newFile = useCallback(async (path: string) => {
    await handleUserPersistedFileChange(await files.newFile(path));
  }, [files.newFile, handleUserPersistedFileChange]);

  const renameActiveFile = useCallback(async (path: string) => {
    await handleUserPersistedFileChange(await files.renameActiveFile(path));
  }, [files.renameActiveFile, handleUserPersistedFileChange]);

  const deleteActiveFile = useCallback(async () => {
    await handleUserPersistedFileChange(await files.deleteActiveFile());
  }, [files.deleteActiveFile, handleUserPersistedFileChange]);

  return {
    iframeRef: preview.iframeRef,
    curAiId: chat.curAiId,
    messages: chat.messages,
    files: files.files,
    activePath: files.activePath,
    code: files.activeFileDraftContent,
    hasActiveFileDraft: files.hasActiveFileDraft,
    writing: chat.writing,
    activeFileSyncing: files.activeFileSyncing,
    storageKind,
    repositoryRevision: files.repositoryRevision,
    gitOperationRevision: files.gitOperationRevision,
    projName,
    status: preview.status,
    overlay: preview.overlay,
    setOverlay: preview.setOverlay,
    previewRunPhase: preview.previewRunPhase,
    previewUrl: preview.previewUrl,
    runLogs: preview.runLogs,
    busy: chat.busy,
    hasResult: preview.hasResult,
    previewActive: preview.previewActive,
    currentProjectId: chat.currentProjectId,
    currentConversationId: chat.currentConversationId,
    lastTitleUpdate: chat.lastTitleUpdate,
    openProject,
    openConversation,
    loadFiles: files.loadFiles,
    runPreview: preview.runPreview,
    openFile: files.openFile,
    updateCode: files.updateActiveFileDraft,
    saveActiveFile,
    newFile,
    renameActiveFile,
    deleteActiveFile,
    migrateToBrowserGit: files.migrateToBrowserGit,
    gitStatus: files.gitStatus,
    gitCurrentBranch: files.gitCurrentBranch,
    gitLog: files.gitLog,
    stageFile: files.stageFile,
    unstageFile: files.unstageFile,
    commit: files.commit,
    readProjectFiles: files.readProjectFiles,
    send: chat.send,
    resume: chat.resume,
    stop: chat.stop,
    rerun: chat.rerun,
  };
}
