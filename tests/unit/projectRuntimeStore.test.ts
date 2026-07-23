import { describe, expect, it } from "vitest";
import {
  createProjectRuntimeStore,
  ProjectRuntimeProjectStatus,
  ProjectRuntimeWorkspaceStatus,
} from "../../lib/projectRuntimeStore";
import type { ProjectDetail } from "../../lib/projectTypes";
import type { ProjectRepositoryDescriptor } from "../../types/projectRepository";
import { ProjectStorageKind } from "../../types/projectStorage";

const PROJECT_A_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_B_ID = "00000000-0000-4000-8000-000000000002";

function databaseProject(id: string, title: string): ProjectDetail {
  return {
    id,
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    storageKind: ProjectStorageKind.Database,
    codeRevision: 1,
    conversations: [],
    files: [],
  };
}

function browserGitProject(id: string, title: string): ProjectDetail {
  return {
    id,
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    storageKind: ProjectStorageKind.BrowserGit,
    conversations: [],
  };
}

function databaseRepository(projectId: string): ProjectRepositoryDescriptor {
  return {
    projectId,
    storageKind: ProjectStorageKind.Database,
    revision: 1,
  };
}

function readyProjectAndWorkspace(projectId: string) {
  const store = createProjectRuntimeStore(projectId);
  store.getState().setProjectReady(databaseProject(projectId, "Project"));
  store.getState().setWorkspaceReady(databaseRepository(projectId));
  return store;
}

describe("createProjectRuntimeStore", () => {
  it("isolates state between Workbench store instances", () => {
    const first = createProjectRuntimeStore(PROJECT_A_ID);
    const second = createProjectRuntimeStore(PROJECT_B_ID);

    first.getState().setProjectReady(databaseProject(PROJECT_A_ID, "First"));

    expect(first.getState().project.status).toBe(ProjectRuntimeProjectStatus.Ready);
    expect(second.getState().project).toEqual({
      status: ProjectRuntimeProjectStatus.Loading,
      projectId: PROJECT_B_ID,
    });
  });

  it("keeps a ready project while exposing a missing local repository", () => {
    const store = createProjectRuntimeStore(PROJECT_A_ID);
    const project = browserGitProject(PROJECT_A_ID, "Project A");
    store.getState().setProjectReady(project);
    store.getState().setWorkspaceLocalRepositoryMissing(PROJECT_A_ID, "Repository is unavailable");

    expect(store.getState().project).toEqual({
      status: ProjectRuntimeProjectStatus.Ready,
      detail: project,
    });
    expect(store.getState().workspace).toEqual({
      status: ProjectRuntimeWorkspaceStatus.LocalRepositoryMissing,
      projectId: PROJECT_A_ID,
      error: "Repository is unavailable",
    });
  });

  it("rejects workspace states that contradict the backend project storage contract", () => {
    const store = createProjectRuntimeStore(PROJECT_A_ID);
    const project = databaseProject(PROJECT_A_ID, "Database Project");
    store.getState().setProjectReady(project);

    store.getState().setWorkspaceLocalRepositoryMissing(PROJECT_A_ID, "impossible");
    store.getState().setWorkspaceReady({
      projectId: PROJECT_A_ID,
      storageKind: ProjectStorageKind.BrowserGit,
      revision: 0,
    });

    expect(store.getState().project).toEqual({
      status: ProjectRuntimeProjectStatus.Ready,
      detail: project,
    });
    expect(store.getState().workspace).toEqual({
      status: ProjectRuntimeWorkspaceStatus.Idle,
    });
  });

  it("clears the previous workspace when reloading a project", () => {
    const store = readyProjectAndWorkspace(PROJECT_A_ID);

    store.getState().loadProject(PROJECT_A_ID);

    expect(store.getState().project).toEqual({
      status: ProjectRuntimeProjectStatus.Loading,
      projectId: PROJECT_A_ID,
    });
    expect(store.getState().workspace).toEqual({
      status: ProjectRuntimeWorkspaceStatus.Idle,
    });
  });

  it("refreshes the current project detail without discarding its ready workspace", () => {
    const store = readyProjectAndWorkspace(PROJECT_A_ID);
    const descriptor = databaseRepository(PROJECT_A_ID);
    const refreshedDetail = databaseProject(PROJECT_A_ID, "Updated Project");

    store.getState().setProjectReady(refreshedDetail);

    expect(store.getState().project).toEqual({
      status: ProjectRuntimeProjectStatus.Ready,
      detail: refreshedDetail,
    });
    expect(store.getState().workspace).toEqual({
      status: ProjectRuntimeWorkspaceStatus.Ready,
      descriptor,
    });
  });

  it("does not retain or restore workspace state when switching projects", () => {
    const store = readyProjectAndWorkspace(PROJECT_A_ID);

    store.getState().loadProject(PROJECT_B_ID);
    store.getState().setWorkspaceReady(databaseRepository(PROJECT_A_ID));
    store.getState().setProjectReady(databaseProject(PROJECT_A_ID, "Stale Project A"));

    expect(store.getState().project).toEqual({
      status: ProjectRuntimeProjectStatus.Loading,
      projectId: PROJECT_B_ID,
    });
    expect(store.getState().workspace).toEqual({
      status: ProjectRuntimeWorkspaceStatus.Idle,
    });

    const projectB = databaseProject(PROJECT_B_ID, "Project B");
    store.getState().setProjectReady(projectB);

    expect(store.getState().project).toEqual({
      status: ProjectRuntimeProjectStatus.Ready,
      detail: projectB,
    });
    expect(store.getState().workspace).toEqual({
      status: ProjectRuntimeWorkspaceStatus.Idle,
    });
  });
});
