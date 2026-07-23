/**
 * [INPUT]: 后端确认的 repository descriptor + 对应 storage adapter
 * [OUTPUT]: revision-safe 文件列表、当前文件草稿、新建/保存/重命名/删除/readProjectFiles
 * [POS]: B 域 repository/文件编辑状态 —— 不判断项目是否存在，不处理 chat/messages
 * [PROTOCOL]: activeFileDraftContent 是前端临时草稿；mutation 必须携带当前 revision，低 revision snapshot 不得覆盖新状态。
 */
"use client";

import { useCallback, useRef, useState } from "react";
import type { ProjectFileSummary, RepositoryProjectRef } from "@/lib/projectTypes";
import { APP_ENTRY_PATH, hasCompleteReactProject } from "@/lib/projectContract";
import { createClientProjectRepository } from "@/lib/projectRepository/client";
import { migrateClientDatabaseProjectToBrowserGit } from "@/lib/projectRepository/client";
import { executeClientFileTool as executeRepositoryFileTool } from "@/lib/projectRepository/clientFileToolExecutor";
import { executeClientGitTool as executeRepositoryGitTool } from "@/lib/projectRepository/clientGitToolExecutor";
import type { WebContainerProjectFile } from "@/lib/webcontainer/types";
import { ChatEventType, type ChatEvent } from "@/types/chat";
import {
  type ProjectRepository,
  type ProjectRepositoryDescriptor,
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
} from "@/types/projectRepository";
import { ProjectStorageKind } from "@/types/projectStorage";
import type { ClientFileToolCall, ClientGitToolCall } from "@/types/clientTool";
import type {
  BrowserGitProjectRepository,
  GitCommitInput,
  GitLogInput,
} from "@/types/browserGitRepository";
import { ToolName } from "@/types/tool";

export type PersistedFileChange = {
  projectId: string;
  operation: "write" | "delete" | "rename";
  path: string;
  oldPath?: string;
  sync?: Promise<void>;
};

function chooseFile(files: ProjectFileSummary[], preferredPath?: string) {
  if (preferredPath && files.some((file) => file.path === preferredPath)) return preferredPath;
  if (files.some((file) => file.path === APP_ENTRY_PATH)) return APP_ENTRY_PATH;
  return files[0]?.path;
}

export function useProjectFiles() {
  const projectIdRef = useRef<string | undefined>(undefined);
  const repositoryRef = useRef<ProjectRepository | undefined>(undefined);
  const activePathRef = useRef<string | undefined>(undefined);
  const hasActiveFileDraftRef = useRef(false);
  const filesRef = useRef<ProjectFileSummary[]>([]);
  const fileContentsRef = useRef(new Map<string, string>());

  const [files, setFiles] = useState<ProjectFileSummary[]>([]);
  const [activePath, setActivePath] = useState<string | undefined>(undefined);
  const [activeFileDraftContent, setActiveFileDraftContent] = useState("");
  const [hasActiveFileDraft, setHasActiveFileDraft] = useState(false);
  const [activeFileSyncing, setActiveFileSyncing] = useState(false);
  const [repositoryRevision, setRepositoryRevision] = useState(0);
  const [gitOperationRevision, setGitOperationRevision] = useState(0);

  const markActiveFileSaved = useCallback(() => {
    hasActiveFileDraftRef.current = false;
    setHasActiveFileDraft(false);
  }, []);

  const confirmDiscardActiveFileDraft = useCallback(() => {
    return !hasActiveFileDraftRef.current || window.confirm("当前文件有未保存草稿，继续操作会丢弃这些改动。");
  }, []);

  const requireRepository = useCallback((projectId?: string) => {
    const repository = repositoryRef.current;
    if (!repository || (projectId && repository.projectId !== projectId)) {
      throw new Error(`ProjectRepository is not initialized for project ${projectId ?? "unknown"}.`);
    }
    return repository;
  }, []);

  const loadProjectFileContents = useCallback(async (projectId: string) => {
    const repository = requireRepository(projectId);
    let snapshot;
    try {
      snapshot = await repository.readWorkspace();
    } catch (error) {
      if (
        error instanceof ProjectRepositoryError
        && error.code === ProjectRepositoryErrorCode.StaleSnapshot
      ) {
        return filesRef.current;
      }
      throw error;
    }
    if (projectIdRef.current !== projectId) return filesRef.current;
    setRepositoryRevision(snapshot.revision);
    fileContentsRef.current = new Map(snapshot.files.map((file) => [file.path, file.content]));
    const summaries = snapshot.files.map(({ content: _content, ...summary }) => summary);
    filesRef.current = summaries;
    setFiles(summaries);
    return summaries;
  }, [requireRepository]);

  const refreshFileSummaries = useCallback(async (projectId: string) => {
    const repository = requireRepository(projectId);
    let snapshot;
    try {
      snapshot = await repository.readWorkspace();
    } catch (error) {
      if (
        error instanceof ProjectRepositoryError
        && error.code === ProjectRepositoryErrorCode.StaleSnapshot
      ) {
        return filesRef.current;
      }
      throw error;
    }
    if (projectIdRef.current !== projectId) return filesRef.current;
    setRepositoryRevision(snapshot.revision);
    for (const file of snapshot.files) {
      if (!hasActiveFileDraftRef.current || file.path !== activePathRef.current) {
        fileContentsRef.current.set(file.path, file.content);
      }
    }
    const summaries = snapshot.files.map(({ content: _content, ...summary }) => summary);
    filesRef.current = summaries;
    setFiles(summaries);
    return summaries;
  }, [requireRepository]);

  const openFile = useCallback(
    (path: string) => {
      if (path !== activePathRef.current && !confirmDiscardActiveFileDraft()) return;
      if (!fileContentsRef.current.has(path)) return;

      activePathRef.current = path;
      setActivePath(path);
      setActiveFileDraftContent(fileContentsRef.current.get(path) ?? "");
      markActiveFileSaved();
    },
    [confirmDiscardActiveFileDraft, markActiveFileSaved]
  );

  const loadFiles = useCallback(
    async (projectId = projectIdRef.current, preferredPath?: string) => {
      if (!projectId) return [];
      const nextFiles = await loadProjectFileContents(projectId);
      const nextPath = chooseFile(nextFiles, preferredPath ?? activePathRef.current);

      if (nextPath) {
        openFile(nextPath);
      } else {
        activePathRef.current = undefined;
        setActivePath(undefined);
        setActiveFileDraftContent("");
        markActiveFileSaved();
      }

      return nextFiles;
    },
    [loadProjectFileContents, markActiveFileSaved, openFile]
  );

  const readProjectFiles = useCallback(
    async (projectId: string): Promise<WebContainerProjectFile[]> => {
      const repository = requireRepository(projectId);
      const snapshot = await repository.exportPreviewFiles();
      setRepositoryRevision(repository.getRevision());
      return snapshot.files;
    },
    [requireRepository]
  );

  const executeClientFileTool = useCallback(
    async (projectId: string, call: ClientFileToolCall) => {
      return executeRepositoryFileTool(requireRepository(projectId), call);
    },
    [requireRepository],
  );

  const syncFileChange = useCallback(
    async (ev: Extract<ChatEvent, { type: typeof ChatEventType.FilesChanged }>): Promise<PersistedFileChange | null> => {
      const projectId = projectIdRef.current;
      if (!projectId || !ev.path || !ev.operation) return null;

      const nextFiles = await loadProjectFileContents(projectId);
      if (ev.operation === "delete") {
        const nextPath = chooseFile(nextFiles, APP_ENTRY_PATH);
        if (nextPath) openFile(nextPath);
        else {
          activePathRef.current = undefined;
          setActivePath(undefined);
          setActiveFileDraftContent("");
          markActiveFileSaved();
        }
        return { projectId, operation: "delete", path: ev.path };
      }

      openFile(ev.path);
      return {
        projectId,
        operation: ev.operation,
        path: ev.path,
        oldPath: ev.oldPath,
      };
    },
    [loadProjectFileContents, markActiveFileSaved, openFile]
  );

  const setProjectRepository = useCallback((
    descriptor: ProjectRepositoryDescriptor,
    initialFiles: ProjectFileSummary[] = [],
  ) => {
    repositoryRef.current = createClientProjectRepository(descriptor);
    projectIdRef.current = descriptor.projectId;
    setRepositoryRevision(descriptor.revision);
    setGitOperationRevision(0);
    activePathRef.current = undefined;
    filesRef.current = initialFiles;
    fileContentsRef.current = new Map();
    setFiles(filesRef.current);
    setActivePath(undefined);
    setActiveFileDraftContent("");
    markActiveFileSaved();
  }, [markActiveFileSaved]);

  const setProjectFiles = useCallback((project: RepositoryProjectRef): ProjectRepositoryDescriptor => {
    switch (project.storageKind) {
      case ProjectStorageKind.Database: {
        const descriptor: ProjectRepositoryDescriptor = {
          projectId: project.id,
          storageKind: ProjectStorageKind.Database,
          revision: project.codeRevision,
        };
        setProjectRepository(descriptor, project.files ?? []);
        return descriptor;
      }
      case ProjectStorageKind.BrowserGit: {
        const descriptor: ProjectRepositoryDescriptor = {
          projectId: project.id,
          storageKind: ProjectStorageKind.BrowserGit,
          revision: 0,
        };
        setProjectRepository(descriptor);
        return descriptor;
      }
      default:
        throw new ProjectRepositoryError(
          ProjectRepositoryErrorCode.ProtocolViolation,
          `unknown project storage kind: ${String(project)}`,
        );
    }
  }, [setProjectRepository]);

  const migrateToBrowserGit = useCallback(async (author: GitCommitInput["author"]) => {
    const projectId = projectIdRef.current;
    if (!projectId) throw new Error("ProjectRepository is not initialized.");
    if (!confirmDiscardActiveFileDraft()) return false;

    const preferredPath = activePathRef.current;
    setActiveFileSyncing(true);
    try {
      const result = await migrateClientDatabaseProjectToBrowserGit(
        requireRepository(projectId),
        author,
      );
      repositoryRef.current = result.repository;
      setRepositoryRevision(result.repository.getRevision());
      fileContentsRef.current = new Map();
      filesRef.current = [];
      setFiles([]);
      await loadFiles(projectId, preferredPath);
      return true;
    } finally {
      setActiveFileSyncing(false);
    }
  }, [confirmDiscardActiveFileDraft, loadFiles, requireRepository]);

  const requireBrowserGitRepository = useCallback((): BrowserGitProjectRepository => {
    const repository = requireRepository();
    if (repository.storageKind !== ProjectStorageKind.BrowserGit) {
      throw new ProjectRepositoryError(
        ProjectRepositoryErrorCode.UnsupportedStorage,
        `Git operations require ${ProjectStorageKind.BrowserGit}; current storage is ${repository.storageKind}`,
      );
    }
    return repository as BrowserGitProjectRepository;
  }, [requireRepository]);

  const executeClientGitTool = useCallback(
    async (projectId: string, call: ClientGitToolCall) => {
      const repository = requireRepository(projectId);
      if (repository.storageKind !== ProjectStorageKind.BrowserGit) {
        throw new ProjectRepositoryError(
          ProjectRepositoryErrorCode.UnsupportedStorage,
          `Git operations require ${ProjectStorageKind.BrowserGit}; current storage is ${repository.storageKind}`,
        );
      }
      const result = await executeRepositoryGitTool(
        repository as BrowserGitProjectRepository,
        call,
      );
      if (
        result.status === "ok"
        && (
          result.tool === ToolName.GitStage
          || result.tool === ToolName.GitUnstage
          || result.tool === ToolName.GitCommit
        )
      ) {
        setGitOperationRevision((revision) => revision + 1);
      }
      return result;
    },
    [requireRepository],
  );

  const gitStatus = useCallback(
    () => requireBrowserGitRepository().gitStatus(),
    [requireBrowserGitRepository],
  );

  const gitCurrentBranch = useCallback(
    () => requireBrowserGitRepository().currentBranch(),
    [requireBrowserGitRepository],
  );

  const gitLog = useCallback(
    (input: GitLogInput) => requireBrowserGitRepository().gitLog(input),
    [requireBrowserGitRepository],
  );

  const stageFile = useCallback(
    (path: string) => requireBrowserGitRepository().stageFile(path),
    [requireBrowserGitRepository],
  );

  const unstageFile = useCallback(
    (path: string) => requireBrowserGitRepository().unstageFile(path),
    [requireBrowserGitRepository],
  );

  const commit = useCallback(
    (input: GitCommitInput) => requireBrowserGitRepository().commit(input),
    [requireBrowserGitRepository],
  );

  const updateActiveFileDraft = useCallback((value: string) => {
    setActiveFileDraftContent(value);
    hasActiveFileDraftRef.current = true;
    setHasActiveFileDraft(true);
  }, []);

  const saveActiveFile = useCallback(async () => {
    const projectId = projectIdRef.current;
    const path = activePathRef.current;
    if (!projectId || !path || !hasActiveFileDraftRef.current) return null;

    const previousSavedContent = fileContentsRef.current.get(path) ?? "";
    const repository = requireRepository(projectId);
    const expectedRevision = repository.getRevision();
    const optimisticContent = activeFileDraftContent;
    fileContentsRef.current.set(path, optimisticContent);
    markActiveFileSaved();
    setActiveFileSyncing(true);

    const sync = repository.writeFile({
      path,
      content: optimisticContent,
      expectedRevision,
    })
      .then(async () => {
        await refreshFileSummaries(projectId);
      })
      .catch(async (error) => {
        fileContentsRef.current.set(path, previousSavedContent);
        if (activePathRef.current === path) {
          setActiveFileDraftContent(optimisticContent);
          hasActiveFileDraftRef.current = true;
          setHasActiveFileDraft(true);
        }
        await refreshFileSummaries(projectId).catch(() => undefined);
        throw error;
      })
      .finally(() => {
        setActiveFileSyncing(false);
      });

    return { projectId, operation: "write", path, sync } satisfies PersistedFileChange;
  }, [activeFileDraftContent, markActiveFileSaved, refreshFileSummaries, requireRepository]);

  const newFile = useCallback(async (path: string) => {
    const projectId = projectIdRef.current;
    if (!projectId) throw new Error("请先发送一次需求创建项目，再新建文件。");
    if (!confirmDiscardActiveFileDraft()) return null;
    const repository = requireRepository(projectId);
    const expectedRevision = repository.getRevision();

    setActiveFileSyncing(true);
    try {
      await repository.writeFile({
        path,
        content: "",
        expectedRevision,
      });
      markActiveFileSaved();
      await loadFiles(projectId, path);
      return { projectId, operation: "write", path } satisfies PersistedFileChange;
    } catch (error) {
      await refreshFileSummaries(projectId).catch(() => undefined);
      throw error;
    } finally {
      setActiveFileSyncing(false);
    }
  }, [confirmDiscardActiveFileDraft, loadFiles, markActiveFileSaved, refreshFileSummaries, requireRepository]);

  const renameActiveFile = useCallback(async (newPath: string) => {
    const projectId = projectIdRef.current;
    const oldPath = activePathRef.current;
    if (!projectId || !oldPath || !newPath || newPath === oldPath) return null;
    if (!confirmDiscardActiveFileDraft()) return null;
    const repository = requireRepository(projectId);
    const expectedRevision = repository.getRevision();

    setActiveFileSyncing(true);
    try {
      await repository.renameFile({ oldPath, newPath, expectedRevision });
      markActiveFileSaved();
      await loadFiles(projectId, newPath);
      return { projectId, operation: "rename", path: newPath, oldPath } satisfies PersistedFileChange;
    } catch (error) {
      await refreshFileSummaries(projectId).catch(() => undefined);
      throw error;
    } finally {
      setActiveFileSyncing(false);
    }
  }, [confirmDiscardActiveFileDraft, loadFiles, markActiveFileSaved, refreshFileSummaries, requireRepository]);

  const deleteActiveFile = useCallback(async () => {
    const projectId = projectIdRef.current;
    const path = activePathRef.current;
    if (!projectId || !path) return null;
    if (!confirmDiscardActiveFileDraft()) return null;
    const repository = requireRepository(projectId);
    const expectedRevision = repository.getRevision();

    setActiveFileSyncing(true);
    try {
      await repository.deleteFile({ path, expectedRevision });
      markActiveFileSaved();
      await loadFiles(projectId, APP_ENTRY_PATH);
      return { projectId, operation: "delete", path } satisfies PersistedFileChange;
    } catch (error) {
      await refreshFileSummaries(projectId).catch(() => undefined);
      throw error;
    } finally {
      setActiveFileSyncing(false);
    }
  }, [confirmDiscardActiveFileDraft, loadFiles, markActiveFileSaved, refreshFileSummaries, requireRepository]);

  return {
    files,
    activePath,
    activeFileDraftContent,
    hasActiveFileDraft,
    activeFileSyncing,
    repositoryRevision,
    gitOperationRevision,
    hasCompleteReactProject,
    setProjectFiles,
    setProjectRepository,
    migrateToBrowserGit,
    gitStatus,
    gitCurrentBranch,
    gitLog,
    stageFile,
    unstageFile,
    commit,
    loadFiles,
    syncFileChange,
    readProjectFiles,
    executeClientFileTool,
    executeClientGitTool,
    openFile,
    updateActiveFileDraft,
    saveActiveFile,
    newFile,
    renameActiveFile,
    deleteActiveFile,
  };
}
