/**
 * [INPUT]: optional projectId from route /p/[projectId]
 * [OUTPUT]: 三栏工作台；有 projectId 时带历史会话栏，无 projectId 时保持一期原始工作台
 * [POS]: B 域工作台容器 —— 组装 useChat、历史会话、编辑器和预览
 * [PROTOCOL]: 历史会话只在项目路由加载；无项目入口直接发 /api/chat 懒建 project/conversation。
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { req } from "@/lib/api";
import { useChat } from "@/hooks/useChat";
import type { ProjectDetail, StoredMessage } from "@/lib/projectTypes";
import { formatTime } from "@/lib/projectTypes";
import TopBar from "@/components/TopBar";
import ChatPanel from "@/components/ChatPanel";
import EditorPanel from "@/components/EditorPanel";
import PreviewPanel from "@/components/PreviewPanel";
import ExportModal from "@/components/ExportModal";
import Toast from "@/components/Toast";

function WorkbenchSkeleton() {
  return (
    <main className="flex-1 flex min-h-0">
      <div className="flex h-full w-[380px] flex-none flex-col border-r border-border bg-panel">
        <div className="h-9 border-b border-border px-[14px] flex items-center">
          <div className="h-3 w-20 rounded bg-panel2 animate-pulse" />
        </div>
        <div className="border-b border-border p-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="mb-1.5 flex items-center gap-2 rounded-md px-2.5 py-2">
              <div className="h-6 w-6 rounded-md bg-panel2 animate-pulse" />
              <div className="min-w-0 flex-1">
                <div className="h-3 w-28 rounded bg-panel2 animate-pulse" />
                <div className="mt-2 h-2.5 w-20 rounded bg-panel2 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex-1 p-4">
          <div className="h-4 w-40 rounded bg-panel2 animate-pulse" />
          <div className="mt-4 h-16 rounded-lg bg-panel2 animate-pulse" />
          <div className="mt-3 h-12 rounded-lg bg-panel2 animate-pulse" />
        </div>
      </div>
      <div className="flex-[1.05] border-r border-border bg-codebg">
        <div className="h-9 border-b border-border px-[14px] flex items-center">
          <div className="h-3 w-20 rounded bg-panel2 animate-pulse" />
        </div>
        <div className="p-6">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="mb-3 h-3 rounded bg-panel2 animate-pulse" style={{ width: `${80 - i * 7}%` }} />
          ))}
        </div>
      </div>
      <div className="flex-1 bg-panel">
        <div className="h-9 border-b border-border px-[14px] flex items-center">
          <div className="h-3 w-20 rounded bg-panel2 animate-pulse" />
        </div>
        <div className="h-[34px] border-b border-border px-[14px] flex items-center gap-2">
          <div className="h-2.5 w-2.5 rounded-full bg-panel2 animate-pulse" />
          <div className="h-3 w-28 rounded bg-panel2 animate-pulse" />
        </div>
        <div className="flex h-[calc(100%-70px)] items-center justify-center">
          <div className="h-20 w-20 rounded-2xl border border-dashed border-border bg-panel2/40 animate-pulse" />
        </div>
      </div>
    </main>
  );
}

export default function Workbench({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const s = useChat();
  const {
    openProject,
    openConversation: restoreConversation,
    currentConversationId,
  } = s;
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [loadingProject, setLoadingProject] = useState(!!projectId);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 1900);
  }

  const loadProject = useCallback(async () => {
    if (!projectId) return;
    setLoadingProject(true);
    try {
      const detail = await req<ProjectDetail>("GET", `/api/projects/${projectId}`);
      setProjectDetail(detail);
      openProject({ id: detail.id, title: detail.title });

      if (detail.conversations[0]) {
        setLoadingConversationId(detail.conversations[0].id);
        const rows = await req<StoredMessage[]>("GET", `/api/conversations/${detail.conversations[0].id}/messages`);
        await restoreConversation({ id: detail.id, title: detail.title }, detail.conversations[0].id, rows);
      }
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    } finally {
      setLoadingConversationId(null);
      setLoadingProject(false);
    }
  }, [openProject, projectId, restoreConversation]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  const openConversation = useCallback(
    async (conversationId: string) => {
      if (!projectDetail) return;
      setLoadingConversationId(conversationId);
      try {
        const rows = await req<StoredMessage[]>("GET", `/api/conversations/${conversationId}/messages`);
        await restoreConversation({ id: projectDetail.id, title: projectDetail.title }, conversationId, rows);
      } catch (e) {
        showToast(String(e instanceof Error ? e.message : e));
      } finally {
        setLoadingConversationId(null);
      }
    },
    [projectDetail, restoreConversation]
  );

  const newConversation = useCallback(() => {
    if (!projectDetail) return;
    openProject({ id: projectDetail.id, title: projectDetail.title });
  }, [openProject, projectDetail]);

  useEffect(() => {
    if (!projectDetail || !currentConversationId) return;
    if (projectDetail.conversations.some((c) => c.id === currentConversationId)) return;

    req<ProjectDetail>("GET", `/api/projects/${projectDetail.id}`)
      .then(setProjectDetail)
      .catch((e) => showToast(String(e instanceof Error ? e.message : e)));
  }, [currentConversationId, projectDetail]);

  const conversations = useMemo(() => projectDetail?.conversations ?? [], [projectDetail]);
  const showHistory = !!projectId;

  return (
    <div className="h-screen flex flex-col">
      <TopBar
        projName={projectDetail?.title ?? s.projName}
        canAct={s.hasResult && !s.busy}
        onHome={projectId ? () => router.push("/") : undefined}
        onRerun={s.rerun}
        onExport={() => setExportOpen(true)}
      />

      {loadingProject ? (
        <WorkbenchSkeleton />
      ) : (
        <main className="flex-1 flex min-h-0">
          {showHistory ? (
            <div className="flex h-full w-[380px] flex-none flex-col border-r border-border bg-panel">
              <div className="h-9 flex-none flex items-center justify-between gap-2 px-[14px] border-b border-border text-[12px] text-muted uppercase tracking-[0.06em]">
                <span>对话线索</span>
                <button className="rounded-md border border-border bg-panel2 px-2 py-1 text-[12px] text-accent hover:border-accent" onClick={newConversation}>
                  ＋ 新会话
                </button>
              </div>
              <div className="max-h-[160px] flex-none overflow-y-auto border-b border-border p-2">
                {conversations.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-3 py-3 text-[12px] leading-5 text-muted">
                    当前项目还没有历史会话。直接在下方输入，后端会懒建会话。
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {conversations.map((conversation) => {
                      const active = conversation.id === currentConversationId;
                      const loading = conversation.id === loadingConversationId;
                      return (
                        <button
                          key={conversation.id}
                          className={
                            "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition " +
                            (active ? "border-accent bg-[#172033]" : "border-transparent hover:bg-panel2")
                          }
                          onClick={() => openConversation(conversation.id)}
                        >
                          <span className={active ? "text-accent" : "text-muted"}>{loading ? "…" : "💬"}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-fg">{conversation.title || "未命名会话"}</span>
                            <span className="block text-[11px] text-muted">{formatTime(conversation.createdAt)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1">
                <ChatPanel
                  messages={s.messages}
                  busy={s.busy}
                  curAiId={s.curAiId.current}
                  onSend={s.send}
                  onStop={s.stop}
                />
              </div>
            </div>
          ) : (
            <div className="h-full w-[340px] flex-none border-r border-border bg-panel">
              <ChatPanel
                messages={s.messages}
                busy={s.busy}
                curAiId={s.curAiId.current}
                onSend={s.send}
                onStop={s.stop}
              />
            </div>
          )}

          <EditorPanel code={s.code} writing={s.writing} />
          <PreviewPanel
            iframeRef={s.iframeRef}
            status={s.status}
            overlay={s.overlay}
            setOverlay={s.setOverlay}
            previewActive={s.previewActive}
          />
        </main>
      )}

      {exportOpen && (
        <ExportModal
          code={s.code}
          projName={s.projName}
          onClose={() => setExportOpen(false)}
          onToast={showToast}
        />
      )}
      <Toast message={toast} />
    </div>
  );
}
