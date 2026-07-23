"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useProjectSession } from "@/hooks/useProjectSession";
import type { ProjectFileSummary, RepositoryProjectRef, StoredMessage } from "@/lib/projectTypes";
import type { Message, SendAttachment } from "@/lib/types";
import type { EditorWorkspaceModel, PreviewWorkspaceModel } from "@/components/workbench/WorkspacePanels";
import VscodeProjectWorkbench from "@/components/workbench/VscodeProjectWorkbench";
import type { SourceControlModel } from "@/components/workbench/SourceControlPanel";
import WorkbenchSkeleton from "@/components/workbench/WorkbenchSkeleton";
import type { GitCommitInput } from "@/types/browserGitRepository";
import { ProjectStorageKind } from "@/types/projectStorage";
import type { ProjectRepositoryDescriptor } from "@/types/projectRepository";
import type { WebContainerProjectFile } from "@/lib/webcontainer/types";
import {
  ProjectRuntimeProjectStatus,
  ProjectRuntimeWorkspaceStatus,
} from "@/lib/projectRuntimeStore";

type TitleUpdate = {
  conversationId: string;
  title: string;
  projectTitle?: string;
};

export type ProjectSessionModel = {
  projectId: string;
  currentConversationId?: string;
  lastTitleUpdate: TitleUpdate | null;
  openProject: (project: RepositoryProjectRef) => ProjectRepositoryDescriptor;
  restoreConversation: (project: RepositoryProjectRef, conversationId: string, rows: StoredMessage[]) => Promise<void>;
  loadFiles: (projectId: string, preferredPath?: string) => Promise<ProjectFileSummary[]>;
  runPreview: (projectId: string) => Promise<unknown>;
  migrateToBrowserGit: (author: GitCommitInput["author"]) => Promise<boolean>;
};

type ChatWorkspaceModel = {
  messages: Message[];
  currentProjectId?: string;
  onSend: (text: string, attachments?: SendAttachment[]) => void;
  onResume: () => void;
  onStop: () => void;
};

type ProjectWorkbenchBodyProps = {
  project: ProjectSessionModel;
  onToast: (message: string) => void;
  chat: ChatWorkspaceModel;
  editor: EditorWorkspaceModel;
  preview: PreviewWorkspaceModel;
  sourceControl: SourceControlModel;
  readProjectFiles: (projectId: string) => Promise<WebContainerProjectFile[]>;
  onProjectReady: () => void;
};

export default function ProjectWorkbenchBody({
  project,
  onToast,
  chat,
  editor,
  preview,
  sourceControl,
  readProjectFiles,
  onProjectReady,
}: ProjectWorkbenchBodyProps) {
  const t = useTranslations("Workbench");
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationName, setMigrationName] = useState("");
  const [migrationEmail, setMigrationEmail] = useState("");
  const [migrationError, setMigrationError] = useState("");
  const [migrating, setMigrating] = useState(false);
  const {
    projectState,
    workspaceState,
    conversations,
    loadingConversationId,
    retryProject,
    openConversation,
    newConversation: resetConversation,
  } = useProjectSession({
    projectId: project.projectId,
    currentConversationId: project.currentConversationId,
    lastTitleUpdate: project.lastTitleUpdate,
    openProject: project.openProject,
    restoreConversation: project.restoreConversation,
    loadFiles: project.loadFiles,
    runPreview: project.runPreview,
    onToast,
  });
  const storageKind = projectState.status === ProjectRuntimeProjectStatus.Ready
    ? projectState.detail.storageKind
    : undefined;
  const projectSourceControl = useMemo(
    () => ({ ...sourceControl, storageKind }),
    [sourceControl, storageKind],
  );

  const newConversation = useCallback(() => {
    resetConversation();
  }, [resetConversation]);

  const migrateProject = useCallback(async () => {
    setMigrationError("");
    setMigrating(true);
    try {
      const migrated = await project.migrateToBrowserGit({
        name: migrationName.trim(),
        email: migrationEmail.trim(),
      });
      if (!migrated) return;
      setMigrationOpen(false);
      await retryProject();
      onToast(t("migrationSucceeded"));
    } catch (error) {
      setMigrationError(String(error instanceof Error ? error.message : error));
    } finally {
      setMigrating(false);
    }
  }, [migrationEmail, migrationName, onToast, project, retryProject, t]);

  useEffect(() => {
    if (
      projectState.status === ProjectRuntimeProjectStatus.Ready
      && workspaceState.status === ProjectRuntimeWorkspaceStatus.Ready
    ) {
      onProjectReady();
    }
  }, [onProjectReady, projectState.status, workspaceState.status]);

  if (
    projectState.status === ProjectRuntimeProjectStatus.Draft
    || projectState.status === ProjectRuntimeProjectStatus.Loading
  ) {
    return <WorkbenchSkeleton />;
  }

  const loadError = projectState.status === ProjectRuntimeProjectStatus.Error
    ? {
        title: t("projectLoadFailedTitle"),
        description: projectState.error,
      }
    : workspaceState.status === ProjectRuntimeWorkspaceStatus.LocalRepositoryMissing
      ? {
          title: t("localRepositoryMissingTitle"),
          description: t("localRepositoryMissingDescription"),
        }
      : workspaceState.status === ProjectRuntimeWorkspaceStatus.Error
        ? {
            title: t("workspaceLoadFailedTitle"),
            description: workspaceState.error,
          }
        : null;

  if (loadError) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-bg px-6">
        <section
          className="w-full max-w-lg rounded-2xl border border-border bg-panel p-6 text-center"
          role="alert"
        >
          <h1 className="text-lg font-semibold text-fg">
            {loadError.title}
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            {loadError.description}
          </p>
          <button
            type="button"
            className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-[#d04200]"
            onClick={() => void retryProject()}
          >
            {t("retryProject")}
          </button>
        </section>
      </main>
    );
  }

  if (
    workspaceState.status === ProjectRuntimeWorkspaceStatus.Idle
    || workspaceState.status === ProjectRuntimeWorkspaceStatus.Loading
  ) {
    return <WorkbenchSkeleton />;
  }

  if (
    projectState.status !== ProjectRuntimeProjectStatus.Ready
    || workspaceState.status !== ProjectRuntimeWorkspaceStatus.Ready
  ) {
    return <WorkbenchSkeleton />;
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <VscodeProjectWorkbench
        conversations={conversations}
        currentConversationId={project.currentConversationId}
        loadingConversationId={loadingConversationId}
        onNewConversation={newConversation}
        onOpenConversation={openConversation}
        chat={chat}
        editor={editor}
        preview={preview}
        sourceControl={projectSourceControl}
        storageKind={storageKind}
        storageLabel={t("storageLabel", {
          storage: storageKind === ProjectStorageKind.BrowserGit
            ? t("storageBrowserGit")
            : t("storageDatabase"),
        })}
        migrationLabel={t("migrateToBrowserGit")}
        onMigrate={() => {
          setMigrationError("");
          setMigrationOpen(true);
        }}
        readProjectFiles={readProjectFiles}
      />
      {migrationOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
          <section
            className="w-full max-w-md rounded-2xl border border-border bg-panel p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="browser-git-migration-title"
          >
            <h2 id="browser-git-migration-title" className="text-lg font-semibold text-fg">
              {t("migrationTitle")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">{t("migrationDescription")}</p>
            <form
              className="mt-5 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void migrateProject();
              }}
            >
              <label className="block text-sm text-fg">
                <span>{t("gitAuthorName")}</span>
                <input
                  required
                  value={migrationName}
                  onChange={(event) => setMigrationName(event.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-border bg-bg px-3 py-2 outline-none focus:border-accent"
                />
              </label>
              <label className="block text-sm text-fg">
                <span>{t("gitAuthorEmail")}</span>
                <input
                  required
                  type="email"
                  value={migrationEmail}
                  onChange={(event) => setMigrationEmail(event.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-border bg-bg px-3 py-2 outline-none focus:border-accent"
                />
              </label>
              {migrationError && (
                <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500" role="alert">
                  {migrationError}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={migrating}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-fg disabled:opacity-50"
                  onClick={() => setMigrationOpen(false)}
                >
                  {t("cancelMigration")}
                </button>
                <button
                  type="submit"
                  disabled={migrating}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {migrating ? t("migrating") : t("confirmMigration")}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
