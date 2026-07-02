/**
 * [INPUT]: public showcase detail assembled by server/showcase
 * [OUTPUT]: read-only workbench-like view with chat, code, and client WebContainer preview
 * [POS]: B 域公开案例展示组件 —— 复用预览运行能力，但不暴露编辑、聊天、文件写入入口
 * [PROTOCOL]: 只读；不调用 /api/chat 或任何 project file write API。
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileCode2, Folder } from "lucide-react";
import ChatPanel from "@/components/chat/ChatPanel";
import Spinner from "@/components/common/Spinner";
import TopBar from "@/components/common/TopBar";
import CodeEditor from "@/components/editor/CodeEditor";
import PreviewPanel from "@/components/preview/PreviewPanel";
import { usePreview } from "@/hooks/usePreview";
import { generateAndUploadShowcaseArtifact } from "@/lib/webcontainer/showcaseArtifact";
import type { Message } from "@/lib/types";
import type { ShowcaseDetail, ShowcaseFile, ShowcaseMessage } from "@/lib/showcaseTypes";
import { WEB_CONTAINER_RUN_EVENT, type WebContainerProjectFile, type WebContainerRunEvent } from "@/lib/webcontainer/types";
import type { WorkbenchViewMode } from "@/lib/workbenchStore";

function fileName(path: string) {
  return path.split("/").at(-1) ?? path;
}

function dirName(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function groupedFiles(files: ShowcaseFile[]) {
  const groups = new Map<string, ShowcaseFile[]>();
  for (const file of files) {
    const dir = dirName(file.path);
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, rows]) => ({ dir, files: rows.toSorted((a, b) => a.path.localeCompare(b.path)) }));
}

function toChatMessages(rows: ShowcaseMessage[]): Message[] {
  const restored: Message[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      restored.push({
        id: row.id,
        role: "user",
        text: row.content,
        attachments: row.meta?.attachments,
      });
      continue;
    }

    if (row.role === "assistant" && (row.content.trim() || row.imageRuns?.length)) {
      restored.push({
        id: row.id,
        role: "ai",
        attempts: [],
        chatText: row.content.trim() ? row.content : undefined,
        imageRuns: row.imageRuns,
      });
    }
  }
  return restored;
}

function FileRail({
  files,
  activePath,
  onOpenFile,
}: {
  files: ShowcaseFile[];
  activePath?: string;
  onOpenFile: (path: string) => void;
}) {
  const groups = useMemo(() => groupedFiles(files), [files]);

  return (
    <aside className="flex h-full w-[240px] flex-none flex-col border-r border-border bg-panel">
      <div className="h-11 flex-none flex items-center justify-between gap-2 border-b border-border bg-panel2 px-3.5 text-[12px] uppercase tracking-[0.08em] text-muted">
        <span>Files</span>
        <span className="ml-auto rounded bg-codebg px-2 py-0.5 text-[11px] tracking-normal text-muted">{files.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div key={group.dir || "__root"}>
              {group.dir && (
                <div className="mb-1.5 flex items-center gap-1.5 px-1.5 text-[11px] uppercase tracking-[0.06em] text-muted">
                  <Folder size={12} strokeWidth={1.8} className="text-muted" />
                  <span className="truncate">{group.dir}</span>
                </div>
              )}
              <div className="flex flex-col gap-1">
                {group.files.map((file) => {
                  const active = file.path === activePath;
                  return (
                    <button
                      key={file.path}
                      className={
                        "flex h-8 items-center gap-2 rounded-md border px-2.5 text-left text-[12.5px] transition " +
                        (active
                          ? "border-accent bg-[#1b1713] text-fg shadow-[inset_3px_0_0_#f54e00]"
                          : "border-transparent text-muted hover:bg-panel2 hover:text-fg")
                      }
                      onClick={() => onOpenFile(file.path)}
                      title={file.path}
                    >
                      <FileCode2 size={13} strokeWidth={1.8} className={active ? "text-accent" : "text-muted"} />
                      <span className="min-w-0 flex-1 truncate">{fileName(file.path)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function ReadOnlyCode({ files }: { files: ShowcaseFile[] }) {
  const initialPath = files.find((file) => file.path === "src/App.tsx")?.path ?? files[0]?.path;
  const [activePath, setActivePath] = useState(initialPath);
  const activeFile = files.find((file) => file.path === activePath) ?? files[0];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-codebg">
      <FileRail files={files} activePath={activeFile?.path} onOpenFile={setActivePath} />
      <section className="flex min-w-0 flex-1 flex-col bg-[#11110f]">
        <div className="h-11 flex-none border-b border-border bg-panel px-3 text-[12px] text-muted">
          <div className="flex h-full min-w-0 max-w-[520px] items-center gap-2 border-t-2 border-accent bg-panel2 px-3">
            <FileCode2 size={14} strokeWidth={1.8} className="text-accent" />
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{activeFile?.path ?? "No file"}</span>
          </div>
        </div>
        <div className="relative min-h-0 flex-1 border-t border-border">
          {activeFile ? (
            <CodeEditor path={activeFile.path} value={activeFile.content} onChange={() => undefined} readOnly />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-[13px] text-muted">No files</div>
          )}
        </div>
      </section>
    </div>
  );
}

function ArtifactPreview({ entryUrl }: { entryUrl: string }) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-panel p-3">
      <iframe
        sandbox="allow-scripts allow-forms allow-popups"
        src={entryUrl}
        title="showcase artifact preview"
        className="block h-full w-full rounded-lg border border-border bg-white"
      />
    </div>
  );
}

function ShowcasePreview({ files, artifactUrl }: { files: ShowcaseFile[]; artifactUrl?: string }) {
  const projectFiles = useMemo<WebContainerProjectFile[]>(
    () => files.map((file) => ({ path: file.path, content: file.content })),
    [files],
  );
  const readProjectFiles = useCallback(async () => projectFiles, [projectFiles]);
  const preview = usePreview(readProjectFiles);

  useEffect(() => {
    if (artifactUrl) return;
    if (projectFiles.length === 0) return;
    void preview.runPreview("showcase");
  }, [artifactUrl, preview.runPreview, projectFiles.length]);

  if (artifactUrl) return <ArtifactPreview entryUrl={artifactUrl} />;

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border">
      <PreviewPanel
        iframeRef={preview.iframeRef}
        status={preview.status}
        overlay={preview.overlay}
        setOverlay={preview.setOverlay}
        previewActive={preview.previewActive}
        previewRunPhase={preview.previewRunPhase}
        previewUrl={preview.previewUrl}
        runLogs={preview.runLogs}
        canAct={false}
        onRerun={() => undefined}
      />
    </div>
  );
}

export default function ShowcaseWorkbench({ detail }: { detail: ShowcaseDetail }) {
  const messages = useMemo(() => toChatMessages(detail.messages), [detail.messages]);
  const projectFiles = useMemo<WebContainerProjectFile[]>(
    () => detail.files.map((file) => ({ path: file.path, content: file.content })),
    [detail.files],
  );
  const [viewMode, setViewMode] = useState<WorkbenchViewMode>("preview");
  const [artifactUrl, setArtifactUrl] = useState(detail.artifact?.entryUrl);
  const [artifactStatus, setArtifactStatus] = useState("");
  const [artifactBusy, setArtifactBusy] = useState(false);
  const canGenerateArtifact = process.env.NODE_ENV === "development";

  function artifactEventText(event: WebContainerRunEvent) {
    switch (event.type) {
      case WEB_CONTAINER_RUN_EVENT.BootStart:
        return "启动 WebContainer";
      case WEB_CONTAINER_RUN_EVENT.MountStart:
        return "挂载项目文件";
      case WEB_CONTAINER_RUN_EVENT.InstallStart:
        return "安装依赖";
      case WEB_CONTAINER_RUN_EVENT.BuildStart:
        return "构建静态产物";
      case WEB_CONTAINER_RUN_EVENT.BuildReady:
        return "静态产物已生成";
      default:
        return "";
    }
  }

  async function generateArtifact() {
    if (artifactBusy) return;
    setArtifactBusy(true);
    setArtifactStatus("准备生成静态预览");
    try {
      const saved = await generateAndUploadShowcaseArtifact({
        slug: detail.slug,
        files: projectFiles,
        onEvent: (event) => {
          const text = artifactEventText(event);
          if (text) setArtifactStatus(text);
        },
      });
      setArtifactUrl(saved.entryUrl);
      setArtifactStatus(`已保存静态预览 · ${Math.round(saved.sizeBytes / 1024)} KB`);
    } catch (error) {
      setArtifactStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setArtifactBusy(false);
    }
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-bg text-fg">
      <TopBar
        projName={detail.title}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        rightSlot={
          <div className="flex items-center gap-2">
            {canGenerateArtifact && (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-codebg px-3 py-1 text-[12px] text-muted transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
                disabled={artifactBusy}
                onClick={generateArtifact}
                title={artifactStatus || "生成静态预览"}
              >
                {artifactBusy && <Spinner />}
                生成静态预览
              </button>
            )}
            <span className="rounded-full border border-border bg-codebg px-3 py-1 text-[12px] text-muted">
              只读案例
            </span>
          </div>
        }
      />

      <main className="flex min-h-0 flex-1">
        <section className="min-h-0 w-[380px] flex-none overflow-hidden border-r border-border">
          <ChatPanel
            messages={messages}
            onSend={() => undefined}
            onResume={() => undefined}
            onStop={() => undefined}
            readOnly
          />
        </section>
        <section className="relative min-w-0 flex-1 bg-bg p-3">
          <div className={(viewMode === "code" ? "flex" : "hidden") + " absolute inset-3"}>
            <ReadOnlyCode files={detail.files} />
          </div>
          <div className={(viewMode === "preview" ? "flex" : "hidden") + " absolute inset-3"}>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
              {canGenerateArtifact && artifactStatus && (
                <div className="flex-none rounded-lg border border-border bg-panel2 px-3 py-2 text-[12px] text-muted">
                  {artifactStatus}
                </div>
              )}
              <ShowcasePreview files={detail.files} artifactUrl={artifactUrl} />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
