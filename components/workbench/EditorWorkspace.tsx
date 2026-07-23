"use client";

import EditorPanel from "@/components/editor/EditorPanel";
import type { ProjectFileSummary } from "@/lib/projectTypes";
import { useWorkbenchStore } from "@/lib/workbenchStore";

type EditorWorkspaceProps = {
  code: string;
  files: ProjectFileSummary[];
  currentProjectId?: string;
  activePath?: string;
  hasActiveFileDraft: boolean;
  writing: boolean;
  activeFileSyncing: boolean;
  onChange: (value: string) => void;
  onOpenFile: (path: string) => void;
  onSave: () => void;
  onNewFile: (path: string) => void;
  onRenameFile: (path: string) => void;
  onDeleteFile: () => void;
  compact?: boolean;
};

export default function EditorWorkspace({
  code,
  files,
  currentProjectId,
  activePath,
  hasActiveFileDraft,
  writing,
  activeFileSyncing,
  onChange,
  onOpenFile,
  onSave,
  onNewFile,
  onRenameFile,
  onDeleteFile,
  compact = false,
}: EditorWorkspaceProps) {
  const viewMode = useWorkbenchStore((state) => state.viewMode);
  const setViewMode = useWorkbenchStore((state) => state.setViewMode);

  function openFileInCode(path: string) {
    setViewMode("code");
    onOpenFile(path);
  }

  function newFileInCode(path: string) {
    setViewMode("code");
    onNewFile(path);
  }

  return (
    <div
      data-testid="editor-workspace"
      className={(viewMode === "code" ? "flex" : "hidden") + (compact ? " absolute inset-0" : " absolute inset-3")}
    >
      <EditorPanel
        code={code}
        files={files}
        currentProjectId={currentProjectId}
        activePath={activePath}
        hasActiveFileDraft={hasActiveFileDraft}
        writing={writing}
        activeFileSyncing={activeFileSyncing}
        onChange={onChange}
        onOpenFile={openFileInCode}
        onSave={onSave}
        onNewFile={newFileInCode}
        onRenameFile={onRenameFile}
        onDeleteFile={onDeleteFile}
        showFileExplorer={!compact}
      />
    </div>
  );
}
