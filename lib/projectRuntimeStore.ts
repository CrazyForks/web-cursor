/**
 * [INPUT]: 已通过共享 schema 校验的 ProjectDetail / ProjectRepositoryDescriptor 与显式加载事件
 * [OUTPUT]: 每个 Workbench 独享的 project/workspace 判别联合状态与原子状态转移动作
 * [POS]: B 域项目运行时状态 owner；不执行请求、不解析响应、不创建模块级项目单例
 * [PROTOCOL]: projectId 守卫丢弃旧异步结果；开始加载项目时必须同步清空旧 workspace。
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ProjectDetail } from "@/lib/projectTypes";
import type { ProjectRepositoryDescriptor } from "@/types/projectRepository";
import { ProjectStorageKind } from "@/types/projectStorage";

export const ProjectRuntimeProjectStatus = {
  Draft: "draft",
  Loading: "loading",
  Ready: "ready",
  Error: "error",
} as const;

export const ProjectRuntimeWorkspaceStatus = {
  Idle: "idle",
  Loading: "loading",
  Ready: "ready",
  LocalRepositoryMissing: "local_repository_missing",
  Error: "error",
} as const;

export type ProjectRuntimeProjectState =
  | { status: typeof ProjectRuntimeProjectStatus.Draft }
  | { status: typeof ProjectRuntimeProjectStatus.Loading; projectId: string }
  | { status: typeof ProjectRuntimeProjectStatus.Ready; detail: ProjectDetail }
  | { status: typeof ProjectRuntimeProjectStatus.Error; projectId: string; error: string };

export type ProjectRuntimeWorkspaceState =
  | { status: typeof ProjectRuntimeWorkspaceStatus.Idle }
  | { status: typeof ProjectRuntimeWorkspaceStatus.Loading; projectId: string }
  | {
      status: typeof ProjectRuntimeWorkspaceStatus.Ready;
      descriptor: ProjectRepositoryDescriptor;
    }
  | {
      status: typeof ProjectRuntimeWorkspaceStatus.LocalRepositoryMissing;
      projectId: string;
      error: string;
    }
  | {
      status: typeof ProjectRuntimeWorkspaceStatus.Error;
      projectId: string;
      error: string;
    };

export type ProjectRuntimeState = {
  project: ProjectRuntimeProjectState;
  workspace: ProjectRuntimeWorkspaceState;
  loadProject: (projectId: string) => void;
  setProjectReady: (detail: ProjectDetail) => void;
  setProjectError: (projectId: string, error: string) => void;
  setWorkspaceLoading: (projectId: string) => void;
  setWorkspaceReady: (descriptor: ProjectRepositoryDescriptor) => void;
  setWorkspaceLocalRepositoryMissing: (projectId: string, error: string) => void;
  setWorkspaceError: (projectId: string, error: string) => void;
};

export type ProjectRuntimeStoreApi = StoreApi<ProjectRuntimeState>;

const IDLE_WORKSPACE: ProjectRuntimeWorkspaceState = {
  status: ProjectRuntimeWorkspaceStatus.Idle,
};

function isCurrentReadyProject(state: ProjectRuntimeState, projectId: string): boolean {
  return state.project.status === ProjectRuntimeProjectStatus.Ready
    && state.project.detail.id === projectId;
}

function matchesCurrentReadyProject(
  state: ProjectRuntimeState,
  descriptor: ProjectRepositoryDescriptor,
): boolean {
  return state.project.status === ProjectRuntimeProjectStatus.Ready
    && state.project.detail.id === descriptor.projectId
    && state.project.detail.storageKind === descriptor.storageKind;
}

function isCurrentBrowserGitProject(state: ProjectRuntimeState, projectId: string): boolean {
  return isCurrentReadyProject(state, projectId)
    && state.project.status === ProjectRuntimeProjectStatus.Ready
    && state.project.detail.storageKind === ProjectStorageKind.BrowserGit;
}

function isCurrentProjectLoad(state: ProjectRuntimeState, projectId: string): boolean {
  return state.project.status === ProjectRuntimeProjectStatus.Loading
    && state.project.projectId === projectId;
}

function updateReadyProject(
  state: ProjectRuntimeState,
  detail: ProjectDetail,
): ProjectRuntimeState | Partial<ProjectRuntimeState> {
  if (isCurrentProjectLoad(state, detail.id)) {
    return {
      project: { status: ProjectRuntimeProjectStatus.Ready, detail },
      workspace: IDLE_WORKSPACE,
    };
  }
  if (isCurrentReadyProject(state, detail.id)) {
    return { project: { status: ProjectRuntimeProjectStatus.Ready, detail } };
  }
  return state;
}

export function createProjectRuntimeStore(initialProjectId?: string): ProjectRuntimeStoreApi {
  return createStore<ProjectRuntimeState>((set) => ({
    project: initialProjectId
      ? { status: ProjectRuntimeProjectStatus.Loading, projectId: initialProjectId }
      : { status: ProjectRuntimeProjectStatus.Draft },
    workspace: IDLE_WORKSPACE,
    loadProject: (projectId) => set({
      project: { status: ProjectRuntimeProjectStatus.Loading, projectId },
      workspace: IDLE_WORKSPACE,
    }),
    setProjectReady: (detail) => set((state) => updateReadyProject(state, detail)),
    setProjectError: (projectId, error) => set((state) => isCurrentProjectLoad(state, projectId)
      ? {
          project: { status: ProjectRuntimeProjectStatus.Error, projectId, error },
          workspace: IDLE_WORKSPACE,
        }
      : state),
    setWorkspaceLoading: (projectId) => set((state) => isCurrentReadyProject(state, projectId)
      ? { workspace: { status: ProjectRuntimeWorkspaceStatus.Loading, projectId } }
      : state),
    setWorkspaceReady: (descriptor) => set((state) => matchesCurrentReadyProject(state, descriptor)
      ? {
          workspace: {
            status: ProjectRuntimeWorkspaceStatus.Ready,
            descriptor,
          },
        }
      : state),
    setWorkspaceLocalRepositoryMissing: (projectId, error) => set((state) => (
      isCurrentBrowserGitProject(state, projectId)
        ? {
            workspace: {
              status: ProjectRuntimeWorkspaceStatus.LocalRepositoryMissing,
              projectId,
              error,
            },
          }
        : state
    )),
    setWorkspaceError: (projectId, error) => set((state) => isCurrentReadyProject(state, projectId)
      ? {
          workspace: {
            status: ProjectRuntimeWorkspaceStatus.Error,
            projectId,
            error,
          },
        }
      : state),
  }));
}
