/**
 * [INPUT]: project editor/preview/chat/Git/terminal models
 * [OUTPUT]: VS Code-style activity bar, primary sidebar, editor group, bottom panel, auxiliary Agent sidebar
 * [POS]: B 域项目工作台布局 owner —— 只管理区域显隐和 tab 选择
 * [PROTOCOL]: source state stays in ProjectRepository; this component only composes stable UI boundaries.
 */
"use client";

import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, Files, GitBranch, TerminalSquare, X } from "lucide-react";
import type { Message, SendAttachment } from "@/lib/types";
import type { WebContainerProjectFile } from "@/lib/webcontainer/types";
import { ProjectStorageKind, type ProjectStorageKind as ProjectStorageKindValue } from "@/types/projectStorage";
import ConversationSidebar from "@/components/workbench/ConversationSidebar";
import ProjectExplorer from "@/components/workbench/ProjectExplorer";
import SourceControlPanel, { type SourceControlModel } from "@/components/workbench/SourceControlPanel";
import TerminalPanel from "@/components/workbench/TerminalPanel";
import WorkspacePanels, { type EditorWorkspaceModel, type PreviewWorkspaceModel } from "@/components/workbench/WorkspacePanels";
import type { Conversation } from "@/lib/projectTypes";

const PrimaryView = {
  Explorer: "explorer",
  SourceControl: "source-control",
} as const;

const BottomView = {
  Problems: "problems",
  Output: "output",
  Terminal: "terminal",
} as const;

type ChatModel = {
  messages: Message[];
  currentProjectId?: string;
  onSend: (text: string, attachments?: SendAttachment[]) => void;
  onResume: () => void;
  onStop: () => void;
};

export default function VscodeProjectWorkbench({
  conversations,
  currentConversationId,
  loadingConversationId,
  onNewConversation,
  onOpenConversation,
  chat,
  editor,
  preview,
  sourceControl,
  storageKind,
  storageLabel,
  migrationLabel,
  onMigrate,
  readProjectFiles,
}: {
  conversations: Conversation[];
  currentConversationId?: string;
  loadingConversationId: string | null;
  onNewConversation(): void;
  onOpenConversation(conversationId: string): void;
  chat: ChatModel;
  editor: EditorWorkspaceModel;
  preview: PreviewWorkspaceModel;
  sourceControl: SourceControlModel;
  storageKind?: ProjectStorageKindValue;
  storageLabel: string;
  migrationLabel: string;
  onMigrate(): void;
  readProjectFiles(projectId: string): Promise<WebContainerProjectFile[]>;
}) {
  const [primaryView, setPrimaryView] = useState<typeof PrimaryView[keyof typeof PrimaryView]>(PrimaryView.Explorer);
  const [bottomView, setBottomView] = useState<typeof BottomView[keyof typeof BottomView]>(BottomView.Terminal);
  const [bottomOpen, setBottomOpen] = useState(true);

  const activityButton = (active: boolean) =>
    "relative grid h-12 w-12 place-items-center transition " +
    (active ? "text-fg" : "text-muted hover:text-fg");

  const terminalActive = bottomOpen && bottomView === BottomView.Terminal;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-12 flex-none flex-col items-center border-r border-border bg-[#171714]" aria-label="Activity Bar">
          <button
            type="button"
            className={activityButton(primaryView === PrimaryView.Explorer)}
            title="Explorer"
            aria-label="Explorer"
            onClick={() => setPrimaryView(PrimaryView.Explorer)}
          >
            {primaryView === PrimaryView.Explorer && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
            <Files size={22} strokeWidth={1.7} />
          </button>
          <button
            type="button"
            className={activityButton(primaryView === PrimaryView.SourceControl)}
            title="Source Control"
            aria-label="Source Control"
            onClick={() => setPrimaryView(PrimaryView.SourceControl)}
          >
            {primaryView === PrimaryView.SourceControl && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
            <GitBranch size={22} strokeWidth={1.7} />
          </button>
          <div className="mt-auto grid h-12 w-12 place-items-center text-accent" title="Agent 在右侧">
            <Bot size={21} strokeWidth={1.7} />
          </div>
        </nav>

        <aside className="w-[260px] flex-none border-r border-border bg-panel">
          {primaryView === PrimaryView.Explorer ? (
            <ProjectExplorer
              files={editor.files}
              activePath={editor.activePath}
              onOpenFile={editor.onOpenFile}
              onNewFile={editor.onNewFile}
            />
          ) : (
            <SourceControlPanel model={sourceControl} onMigrate={onMigrate} />
          )}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-bg">
          <div className="min-h-0 flex-1">
            <WorkspacePanels editor={editor} preview={preview} compact />
          </div>
          <section className={(bottomOpen ? "h-[230px]" : "h-9") + " flex-none border-t border-border bg-[#11110f]"}>
            <div className="flex h-9 items-center border-b border-border bg-panel px-2">
              {Object.values(BottomView).map((view) => (
                <button
                  key={view}
                  type="button"
                  className={
                    "h-9 border-b-2 px-3 text-[11px] uppercase tracking-[0.06em] transition " +
                    (bottomOpen && bottomView === view ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")
                  }
                  onClick={() => {
                    setBottomView(view);
                    setBottomOpen(true);
                  }}
                >
                  {view}
                </button>
              ))}
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-panel2 hover:text-fg"
                  aria-label={bottomOpen ? "收起底部面板" : "展开底部面板"}
                  onClick={() => setBottomOpen((open) => !open)}
                >
                  {bottomOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </button>
                <button
                  type="button"
                  className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-panel2 hover:text-fg"
                  aria-label="关闭底部面板"
                  onClick={() => setBottomOpen(false)}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            {bottomOpen && (
              <div className="h-[calc(100%-2.25rem)] min-h-0">
                {bottomView === BottomView.Terminal && (
                  <TerminalPanel active={terminalActive} projectId={chat.currentProjectId} readProjectFiles={readProjectFiles} />
                )}
                {bottomView === BottomView.Output && (
                  <pre className="h-full overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-5 text-muted">
                    {preview.runLogs.join("") || "尚无 Preview 输出。"}
                  </pre>
                )}
                {bottomView === BottomView.Problems && (
                  <div className="h-full overflow-auto px-3 py-2 text-xs text-muted">
                    {preview.overlay.show ? preview.overlay.message : "没有检测到问题。"}
                  </div>
                )}
              </div>
            )}
          </section>
        </section>

        <ConversationSidebar
          placement="right"
          conversations={conversations}
          currentConversationId={currentConversationId}
          loadingConversationId={loadingConversationId}
          messages={chat.messages}
          projectId={chat.currentProjectId}
          onNewConversation={onNewConversation}
          onOpenConversation={onOpenConversation}
          onSend={chat.onSend}
          onResume={chat.onResume}
          onStop={chat.onStop}
        />
      </div>
      <footer className="flex h-6 flex-none items-center gap-3 bg-accent px-3 text-[11px] text-white">
        <span className="inline-flex items-center gap-1"><GitBranch size={12} /> {storageKind === ProjectStorageKind.BrowserGit ? "Git" : "No Git"}</span>
        <span>{storageLabel}</span>
        {storageKind === ProjectStorageKind.Database && (
          <button
            type="button"
            className="rounded bg-white/15 px-2 py-0.5 font-semibold hover:bg-white/25"
            onClick={onMigrate}
          >
            {migrationLabel}
          </button>
        )}
        <span className="ml-auto inline-flex items-center gap-1"><TerminalSquare size={12} /> WebContainer</span>
      </footer>
    </div>
  );
}
