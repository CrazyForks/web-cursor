/**
 * [INPUT]: 用户 prompt、AgentRun 会话恢复请求、文件/预览/client-tool 依赖
 * [OUTPUT]: 聊天状态以及 send/resume/stop/openConversation/finishConversationRestore actions
 * [POS]: B 域 AgentRun transport 与客户端工具编排 owner
 * [PROTOCOL]: 持久 Stop 先于 transport abort/导航；每个 SSE transport 固定 run identity；
 *   client side effect 先 start invocation，刷新后的 client boundary 只通过显式 recover POST 接管
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  completeAgentRun,
  getConversationAgentRun,
  postToolResult,
  recoverAgentRun,
  startClientToolInvocation,
  stopAgentRun,
  stopAgentRunRequest,
  streamChat,
} from "@/lib/chatClient";
import { useConversationStore } from "@/lib/conversationStore";
import { AiTimelineItemKind } from "@/lib/types";
import type { AgentFileChange, AiTimelineItem, ImageRunView, Message, SendAttachment, Status } from "@/lib/types";
import type { ProjectFileSummary } from "@/lib/projectTypes";
import { ChatEventType, ChatTurnSchema, FileChangeOperation, type ChatEvent, type ChatTurn } from "@/types/chat";
import {
  AgentRunRequestStopOutcome,
  AgentRunStatus,
  agentRunCanResume,
  agentRunIsTerminal,
  type AgentRunSnapshot,
} from "@/types/agentRun";
import { ImageJobStatus, ImageRunStatus } from "@/types/image";
import { isIntegrationCardMeta } from "@/types/integration";
import { ToolName, ToolResultType, type ToolResult } from "@/types/tool";
import { AttachmentSummarySchema } from "@/types/attachment";
import {
  ProjectRepositoryDescriptorSchema,
  type ProjectRepositoryDescriptor,
} from "@/types/projectRepository";
import {
  ClientFileToolCallSchema,
  ClientGitToolCallSchema,
  ClientToolCallSchema,
  ClientToolResultSubmissionSchema,
  isClientFileToolName,
  type ClientFileToolCall,
  type ClientFileToolResult,
  type ClientGitToolCall,
  type ClientGitToolResult,
  type ClientToolCall,
} from "@/types/clientTool";

const APP_ENTRY_PATH = "src/App.tsx";
const MAX_CLIENT_TOOL_RESUMES = 24;

type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  meta?: unknown;
  imageRuns?: ImageRunView[];
};

type ProjectRef = {
  id: string;
  title: string;
};

type TimelineStamp = Pick<AiTimelineItem, "receivedAt" | "order">;

type AgentRunIdentity = {
  runId: string;
  attempt: number;
};

type StopRequest = {
  controller: AbortController | null;
  runId: string | null;
  requestId: string | null;
  requestStopPersisted: boolean;
  promise?: Promise<boolean>;
  settled: Promise<boolean>;
  settledValue: boolean | null;
  resolveSettled: (value: boolean) => void;
};

type ConsumedTurn =
  | {
      aborted: true;
      filesChanged: boolean;
      clientToolCalls: ClientToolCall[];
    }
  | {
      aborted: false;
      filesChanged: boolean;
      shouldRunPreviewForFilesChanged: boolean;
      filesChangedProjectId: string | null;
      clientToolCalls: ClientToolCall[];
      identity: AgentRunIdentity;
      run: AgentRunSnapshot;
    };

const RestoredAttachmentSchema = AttachmentSummarySchema.array();

type UseChatDeps = {
  loadFiles: (projectId: string, preferredPath?: string) => Promise<ProjectFileSummary[]>;
  executeClientFileTool: (projectId: string, call: ClientFileToolCall) => Promise<ClientFileToolResult>;
  executeClientGitTool: (projectId: string, call: ClientGitToolCall) => Promise<ClientGitToolResult>;
  handlePersistedFileChange: (
    ev: Extract<ChatEvent, { type: typeof ChatEventType.FilesChanged }>
  ) => Promise<{ projectId: string; shouldRunPreview: boolean } | null>;
  getRepositoryDescriptor: (projectId: string) => ProjectRepositoryDescriptor;
  runPreview: (projectId: string, signal?: AbortSignal) => Promise<ToolResult | null>;
  cancelPreview: () => void;
  setPreviewStatus: (status: Status) => void;
  onError: (error: unknown) => void;
  onProjectInitialized: (project: {
    repository: ProjectRepositoryDescriptor;
    conversationId: string;
  }) => void;
  onTitleUpdate: (update: { conversationId: string; title: string; projectTitle?: string }) => void;
};

function previewSucceeded(result: ToolResult | null): boolean {
  return result?.status === "ok" && result.type === ToolResultType.ServerReady;
}

function previewSummary(
  result: ToolResult | null,
  shouldRunPreview: boolean,
  t: ReturnType<typeof useTranslations<"Agent">>
) {
  if (!shouldRunPreview) {
    return { summaryKind: "ok" as const, summary: t("filesUpdatedNoPreview") };
  }
  if (previewSucceeded(result)) {
    return { summaryKind: "ok" as const, summary: t("filesUpdatedRenderOk") };
  }
  if (result) {
    return { summaryKind: "fail" as const, summary: t("filesUpdatedPreviewFailed") };
  }
  return { summaryKind: "fail" as const, summary: t("filesUpdatedNoResult") };
}

function interruptedPreviewResult(message: string): ToolResult {
  return { status: "error", type: ToolResultType.ToolInterrupted, message };
}

function createStopRequest(
  controller: AbortController | null,
  runId: string | null,
  requestId: string | null,
): StopRequest {
  let resolveSettled!: (value: boolean) => void;
  const settled = new Promise<boolean>((resolve) => {
    resolveSettled = resolve;
  });
  return {
    controller,
    runId,
    requestId,
    requestStopPersisted: false,
    settled,
    settledValue: null,
    resolveSettled,
  };
}

function settleStopRequest(request: StopRequest, value: boolean): void {
  if (request.settledValue !== null) return;
  request.settledValue = value;
  request.resolveSettled(value);
}

function clientFileChangedEvent(
  result: ClientFileToolResult,
  identity: AgentRunIdentity,
): Extract<ChatEvent, { type: typeof ChatEventType.FilesChanged }> | null {
  if (result.status !== "ok") return null;
  if (result.tool === ToolName.WriteFile) {
    return {
      type: ChatEventType.FilesChanged,
      agentRunId: identity.runId,
      attempt: identity.attempt,
      operation: FileChangeOperation.Write,
      path: result.path,
    };
  }
  if (result.tool === ToolName.DeleteFile) {
    return {
      type: ChatEventType.FilesChanged,
      agentRunId: identity.runId,
      attempt: identity.attempt,
      operation: FileChangeOperation.Delete,
      path: result.path,
    };
  }
  if (result.tool === ToolName.RenameFile) {
    return {
      type: ChatEventType.FilesChanged,
      agentRunId: identity.runId,
      attempt: identity.attempt,
      operation: FileChangeOperation.Rename,
      path: result.newPath,
      oldPath: result.oldPath,
    };
  }
  return null;
}

function restoreRunIsBusy(run: AgentRunSnapshot | null): boolean {
  return Boolean(run && !agentRunIsTerminal(run.status));
}

function runFailureError(run: AgentRunSnapshot): Error {
  if (run.failure) return new Error(`${run.failure.code}: ${run.failure.message}`);
  return new Error(`PROTOCOL_VIOLATION: AgentRun ${run.id} is ${run.status} without failure details.`);
}

function setAgentActivity(text: string) {
  useConversationStore.getState().setActivity(text);
}

function finishAgentTurn() {
  useConversationStore.getState().finishTurn();
}

function appendTimelineItem<T extends AiTimelineItem>(timeline: AiTimelineItem[] | undefined, item: T) {
  return [...(timeline ?? []), item];
}

function restoredAttachments(meta: unknown) {
  const rawAttachments = (meta as { attachments?: unknown } | null)?.attachments;
  if (rawAttachments === undefined) return undefined;

  const parsed = RestoredAttachmentSchema.safeParse(rawAttachments);
  if (!parsed.success) {
    console.warn("Invalid restored attachment meta", parsed.error.message);
    return undefined;
  }
  return parsed.data;
}

export function useChat(deps: UseChatDeps) {
  const t = useTranslations("Agent");
  const locale = useLocale();
  const activeRequestRef = useRef<AbortController | null>(null);
  const activeUserRequestRef = useRef<{
    controller: AbortController;
    requestId: string;
  } | null>(null);
  const activeRunIdentityRef = useRef<AgentRunIdentity | null>(null);
  const activeRunSnapshotRef = useRef<AgentRunSnapshot | null>(null);
  const stopRequestedRef = useRef<StopRequest | null>(null);
  const curAiIdRef = useRef<string>("");
  const lastPromptRef = useRef<string>("");
  const lastAttachmentsRef = useRef<SendAttachment[]>([]);
  const projectIdRef = useRef<string | undefined>(undefined);
  const convIdRef = useRef<string | undefined>(undefined);
  const timelineOrderRef = useRef(0);
  const clientToolResultCacheRef = useRef(new Map<string, Promise<ClientFileToolResult>>());
  const clientGitToolResultCacheRef = useRef(new Map<string, Promise<ClientGitToolResult>>());

  const [messages, setMessages] = useState<Message[]>([]);
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<string | undefined>(undefined);
  const [currentConversationId, setCurrentConversationId] = useState<string | undefined>(undefined);
  const [lastTitleUpdate, setLastTitleUpdate] = useState<{
    conversationId: string;
    title: string;
    projectTitle?: string;
  } | null>(null);

  useEffect(() => () => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    activeUserRequestRef.current = null;
    stopRequestedRef.current = null;
    deps.cancelPreview();
  }, [deps.cancelPreview]);

  const setProjectContext = useCallback((projectId?: string, conversationId?: string) => {
    projectIdRef.current = projectId;
    convIdRef.current = conversationId;
    setCurrentProjectId(projectId);
    setCurrentConversationId(conversationId);
  }, []);

  const markTimeline = useCallback((): TimelineStamp => ({
    receivedAt: Date.now(),
    order: timelineOrderRef.current++,
  }), []);

  const updateAi = useCallback(
    (fn: (m: Extract<Message, { role: "ai" }>) => Extract<Message, { role: "ai" }>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === curAiIdRef.current && m.role === "ai" ? fn(m) : m))
      );
    },
    []
  );

  const appendFileChange = useCallback((change: Omit<AgentFileChange, "id">, stamp?: TimelineStamp) => {
    const changeId = crypto.randomUUID();
    updateAi((m) => ({
      ...m,
      fileChanges: [...(m.fileChanges ?? []), { ...change, id: changeId }],
      timeline: stamp
        ? appendTimelineItem(m.timeline, {
            id: `file-change-${changeId}`,
            kind: AiTimelineItemKind.FileChange,
            changeId,
            ...stamp,
          })
        : m.timeline,
    }));
  }, [updateAi]);

  const appendFileWriteStream = useCallback((ev: Extract<ChatEvent, { type: typeof ChatEventType.FileWriteStream }>, stamp: TimelineStamp) => {
    updateAi((m) => {
      const streams = m.fileWriteStreams ?? [];
      const existing = streams.find((stream) => stream.toolCallId === ev.toolCallId);
      if (!existing) {
        return {
          ...m,
          fileWriteStreams: [
            ...streams,
            {
              toolCallId: ev.toolCallId,
              path: ev.path,
              content: ev.delta ?? "",
              collapsed: false,
            },
          ],
          timeline: appendTimelineItem(m.timeline, {
            id: `file-write-stream-${ev.toolCallId}`,
            kind: AiTimelineItemKind.FileWriteStream,
            toolCallId: ev.toolCallId,
            ...stamp,
          }),
        };
      }

      return {
        ...m,
        fileWriteStreams: streams.map((stream) =>
          stream.toolCallId === ev.toolCallId
            ? {
                ...stream,
                path: ev.path ?? stream.path,
                content: stream.content + (ev.delta ?? ""),
                collapsed: false,
              }
            : stream
        ),
      };
    });
  }, [updateAi]);

  const collapseFileWriteStreams = useCallback(() => {
    updateAi((m) => ({
      ...m,
      fileWriteStreams: m.fileWriteStreams?.map((stream) => ({
        ...stream,
        collapsed: true,
      })),
    }));
  }, [updateAi]);

  const detachCurrentTransport = useCallback(async () => {
    const pendingStop = stopRequestedRef.current;
    if (pendingStop) await pendingStop.settled;
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    activeUserRequestRef.current = null;
    activeRunIdentityRef.current = null;
    activeRunSnapshotRef.current = null;
    stopRequestedRef.current = null;
    deps.cancelPreview();
  }, [deps]);

  const openProjectChat = useCallback(async (project: ProjectRef) => {
    await detachCurrentTransport();
    timelineOrderRef.current = 0;
    setProjectContext(project.id, undefined);
    setMessages([]);
    setWriting(false);
    setBusy(false);
    finishAgentTurn();
  }, [detachCurrentTransport, setProjectContext]);

  const openConversation = useCallback(
    async (
      project: ProjectRef,
      conversationId: string,
      rows: StoredMessage[],
      run: AgentRunSnapshot | null = null,
    ) => {
      await detachCurrentTransport();
      if (
        run
        && (
          run.projectId !== project.id
          || run.conversationId !== conversationId
        )
      ) {
        throw new Error(
          `PROTOCOL_VIOLATION: restored AgentRun ${run.id} does not belong to project/conversation.`,
        );
      }
      timelineOrderRef.current = 0;
      setProjectContext(project.id, conversationId);
      activeRunSnapshotRef.current = run;
      activeRunIdentityRef.current = run
        ? { runId: run.id, attempt: run.attempt }
        : null;

      const restored: Message[] = [];
      for (const row of rows) {
        if (row.role === "user") {
          restored.push({
            id: row.id,
            role: "user",
            text: row.content,
            attachments: restoredAttachments(row.meta),
          });
        } else if (row.role === "assistant" && row.content.trim()) {
          restored.push({
            id: row.id,
            role: "ai",
            attempts: [],
            chatText: row.content,
            imageRuns: row.imageRuns,
            integrationCard: isIntegrationCardMeta(row.meta) ? row.meta : undefined,
          });
        } else if (row.role === "assistant") {
          if (row.imageRuns?.length) {
            restored.push({
              id: row.id,
              role: "ai",
              attempts: [],
              imageRuns: row.imageRuns,
              integrationCard: isIntegrationCardMeta(row.meta) ? row.meta : undefined,
            });
          }
        }
      }
      setMessages(restored);
      const restoredBusy = restoreRunIsBusy(run);
      setWriting(restoredBusy);
      setBusy(restoredBusy);
      const lastAiMessage = [...restored].reverse().find((message) => message.role === "ai");
      curAiIdRef.current = lastAiMessage?.id ?? "";
      if (restoredBusy) {
        useConversationStore.getState().startTurn(curAiIdRef.current);
      } else {
        finishAgentTurn();
      }
      if (run?.status === AgentRunStatus.Blocked) {
        deps.onError(runFailureError(run));
      }
    },
    [deps, detachCurrentTransport, setProjectContext]
  );

  const applyTerminalStop = useCallback((
    request: StopRequest,
    stopped: AgentRunSnapshot,
  ) => {
    if (stopRequestedRef.current !== request) return;
    activeRunSnapshotRef.current = stopped;
    activeRunIdentityRef.current = {
      runId: stopped.id,
      attempt: stopped.attempt,
    };
    setMessages((previous) => previous.map((message) => (
      message.role === "ai" && message.imageRuns
        ? {
            ...message,
            imageRuns: message.imageRuns.map((imageRun) => (
              imageRun.agentRunId === stopped.id
                ? { ...imageRun, resumeOnTerminal: false }
                : imageRun
            )),
          }
        : message
    )));
    if (
      request.controller
      && activeRequestRef.current === request.controller
    ) {
      request.controller.abort();
    }
    deps.cancelPreview();
    setBusy(false);
    setWriting(false);
    if (stopped.status === AgentRunStatus.Cancelled) {
      useConversationStore.getState().stopTurn();
      deps.setPreviewStatus({ kind: "", text: t("stopped") });
    } else {
      finishAgentTurn();
      deps.setPreviewStatus({ kind: "", text: t("waitingUser") });
      if (stopped.status === AgentRunStatus.Failed) {
        deps.onError(runFailureError(stopped));
      }
    }
    stopRequestedRef.current = null;
  }, [deps, t]);

  const persistStopRequest = useCallback((
    request: StopRequest,
    identity: AgentRunIdentity,
  ): Promise<boolean> => {
    if (request.runId && request.runId !== identity.runId) {
      settleStopRequest(request, false);
      return Promise.reject(new Error(
        `PROTOCOL_VIOLATION: Stop request run ${request.runId} does not match ${identity.runId}.`,
      ));
    }
    request.runId = identity.runId;
    if (request.promise) return request.promise;

    request.promise = (async () => {
      try {
        const stopped = await stopAgentRun(identity.runId);
        if (
          stopped.id !== identity.runId
          || !agentRunIsTerminal(stopped.status)
        ) {
          throw new Error(
            `PROTOCOL_VIOLATION: Stop response did not close AgentRun ${identity.runId}.`,
          );
        }
        applyTerminalStop(request, stopped);
        return true;
      } catch (error) {
        if (stopRequestedRef.current === request) {
          stopRequestedRef.current = null;
          deps.onError(error);
        }
        return false;
      }
    })();
    void request.promise.then(
      (value) => settleStopRequest(request, value),
      () => settleStopRequest(request, false),
    );
    return request.promise;
  }, [applyTerminalStop, deps]);

  const persistRequestIdentityStop = useCallback((
    request: StopRequest,
    requestId: string,
  ): Promise<boolean> => {
    if (request.requestId && request.requestId !== requestId) {
      settleStopRequest(request, false);
      return Promise.reject(new Error(
        `PROTOCOL_VIOLATION: Stop request ${request.requestId} does not match ${requestId}.`,
      ));
    }
    request.requestId = requestId;
    if (request.promise) return request.promise;

    request.promise = (async () => {
      try {
        const receipt = await stopAgentRunRequest(requestId);
        if (receipt.requestId !== requestId) {
          throw new Error(
            `PROTOCOL_VIOLATION: Stop receipt request ${receipt.requestId} does not match ${requestId}.`,
          );
        }
        request.requestStopPersisted = true;
        settleStopRequest(request, true);
        if (receipt.outcome === AgentRunRequestStopOutcome.PendingRun) {
          return false;
        }

        const stopped = receipt.run;
        request.runId = stopped.id;
        if (!agentRunIsTerminal(stopped.status)) {
          throw new Error(
            `PROTOCOL_VIOLATION: request Stop did not close AgentRun ${stopped.id}.`,
          );
        }
        applyTerminalStop(request, stopped);
        return true;
      } catch (error) {
        if (stopRequestedRef.current === request) {
          stopRequestedRef.current = null;
          deps.onError(error);
        }
        return false;
      }
    })();
    void request.promise.then(
      (value) => settleStopRequest(request, value),
      () => settleStopRequest(request, false),
    );
    return request.promise;
  }, [applyTerminalStop, deps]);

  const stopRequestedForTransport = useCallback(async (
    controller: AbortController,
    identity: AgentRunIdentity,
  ): Promise<boolean> => {
    const request = stopRequestedRef.current;
    if (!request || request.controller !== controller) return false;
    return persistStopRequest(request, identity);
  }, [persistStopRequest]);

  const runLoop = useCallback(
    async (
      firstMessage: string,
      controller: AbortController,
      attachments: SendAttachment[] = [],
      initialTurn?: ChatTurn,
    ) => {
      const signal = controller.signal;
      const projectId = projectIdRef.current;
      let turn: ChatTurn = initialTurn ?? ChatTurnSchema.parse({
        kind: "user",
        message: firstMessage,
        projectId,
        conversationId: convIdRef.current,
        attachments: attachments.map((attachment) => ({ id: attachment.id })),
        requestId: crypto.randomUUID(),
        ...(projectId
          ? { repository: deps.getRepositoryDescriptor(projectId) }
          : {}),
      });

      setWriting(true);
      deps.setPreviewStatus({ kind: "load", text: t("modifyingFiles") });
      setAgentActivity(t("modifyingFiles"));

      let pendingFilesChanged = false;
      let pendingShouldRunPreview = false;
      let pendingFilesChangedProjectId: string | null = null;

      async function consumeTurn(currentTurn: ChatTurn): Promise<ConsumedTurn> {
        let filesChanged = false;
        let shouldRunPreviewForFilesChanged = false;
        let filesChangedProjectId: string | null = null;
        let clientToolCalls: ClientToolCall[] = [];
        let transportIdentity: AgentRunIdentity | null = null;
        let latestRun: AgentRunSnapshot | null = null;
        let doneReceived = false;

        for await (const ev of streamChat(currentTurn, locale, signal)) {
          if (signal.aborted) return { filesChanged, clientToolCalls, aborted: true };
          if (doneReceived) {
            throw new Error("PROTOCOL_VIOLATION: SSE transport emitted an event after done.");
          }

          const eventIdentity = {
            runId: ev.agentRunId,
            attempt: ev.attempt,
          };
          if (!transportIdentity) {
            if (currentTurn.kind !== "user") {
              if (eventIdentity.runId !== currentTurn.runId) {
                throw new Error(
                  `PROTOCOL_VIOLATION: transport returned run ${eventIdentity.runId}, expected ${currentTurn.runId}.`,
                );
              }
              if (eventIdentity.attempt !== currentTurn.attempt + 1) {
                throw new Error(
                  `PROTOCOL_VIOLATION: transport attempt ${eventIdentity.attempt} must follow ${currentTurn.attempt}.`,
                );
              }
            }
            transportIdentity = eventIdentity;
            activeRunIdentityRef.current = eventIdentity;
          } else if (
            eventIdentity.runId !== transportIdentity.runId
            || eventIdentity.attempt !== transportIdentity.attempt
          ) {
            throw new Error("PROTOCOL_VIOLATION: SSE transport changed AgentRun identity.");
          }

          const pendingStop = stopRequestedRef.current;
          if (
            pendingStop?.controller === controller
            && pendingStop.runId
            && await stopRequestedForTransport(controller, transportIdentity)
          ) {
            return { filesChanged, clientToolCalls, aborted: true };
          }

          if (ev.type === ChatEventType.Init) {
            const repository = ProjectRepositoryDescriptorSchema.parse(ev.repository);
            projectIdRef.current = repository.projectId;
            convIdRef.current = ev.conversationId;
            setCurrentProjectId(repository.projectId);
            setCurrentConversationId(ev.conversationId);
            deps.onProjectInitialized({
              repository,
              conversationId: ev.conversationId,
            });
          } else if (ev.type === ChatEventType.RunState) {
            if (
              currentTurn.kind === "user"
              && ev.run.requestId !== currentTurn.requestId
            ) {
              throw new Error(
                `PROTOCOL_VIOLATION: AgentRun ${ev.run.id} requestId does not match the user turn.`,
              );
            }
            latestRun = ev.run;
            activeRunSnapshotRef.current = ev.run;
          } else if (ev.type === ChatEventType.ToolsCall) {
            if (ev.name === ToolName.RunPreview) {
              deps.setPreviewStatus({ kind: "load", text: t("runningPreview") });
              setAgentActivity(t("runningPreview"));
            } else if (ev.name === ToolName.WriteFile || ev.name === ToolName.DeleteFile || ev.name === ToolName.RenameFile) {
              deps.setPreviewStatus({ kind: "load", text: t("writingFiles") });
              setAgentActivity(t("writingFiles"));
            } else if (
              ev.name === ToolName.ListFiles
              || ev.name === ToolName.SearchText
              || ev.name === ToolName.ReadFile
            ) {
              deps.setPreviewStatus({ kind: "load", text: t("readingFiles") });
              setAgentActivity(t("readingFiles"));
            }
          } else if (ev.type === ChatEventType.ClientToolCalls) {
            if (clientToolCalls.length > 0) {
              throw new Error("PROTOCOL_VIOLATION: received more than one client tool boundary in a turn.");
            }
            clientToolCalls = ClientToolCallSchema.array().parse(ev.calls);
            if (clientToolCalls.length === 0) {
              throw new Error("PROTOCOL_VIOLATION: client tool boundary must contain at least one call.");
            }
            for (const call of clientToolCalls) {
              if (
                call.agentRunId !== transportIdentity.runId
                || call.attempt !== transportIdentity.attempt
              ) {
                throw new Error(
                  "PROTOCOL_VIOLATION: client tool call identity does not match its SSE transport.",
                );
              }
            }
          } else if (ev.type === ChatEventType.ToolResult) {
            if (ev.status === "error") {
              deps.setPreviewStatus({ kind: "err", text: t("toolFailed", { name: ev.name }) });
              setAgentActivity(t("toolFailedHandling", { name: ev.name }));
            }
          } else if (ev.type === ChatEventType.ToolPending) {
            const stamp = markTimeline();
            updateAi((m) => ({
              ...m,
              imageRuns: [
                ...(m.imageRuns ?? []),
                {
                  runId: ev.runId,
                  agentRunId: ev.agentRunId,
                  toolCallId: ev.id,
                  status: ImageRunStatus.Pending,
                  resumeOnTerminal: true,
                  jobs: ev.jobs.map((job) => ({
                    id: job.jobId,
                    status: ImageJobStatus.Pending,
                    input: {
                      label: job.label,
                      prompt: job.prompt,
                      aspectRatio: job.aspectRatio,
                      inputImages: job.inputImages,
                    },
                  })),
                },
              ],
              timeline: appendTimelineItem(m.timeline, {
                id: `image-run-${ev.runId}`,
                kind: AiTimelineItemKind.ImageRun,
                runId: ev.runId,
                ...stamp,
              }),
            }));
            deps.setPreviewStatus({ kind: "load", text: t("generatingImages") });
            setAgentActivity(t("generatingImages"));
          } else if (ev.type === ChatEventType.FileWriteStream) {
            appendFileWriteStream(ev, markTimeline());
            deps.setPreviewStatus({ kind: "load", text: t("writingFiles") });
            setAgentActivity(t("writingFiles"));
          } else if (ev.type === ChatEventType.FilesChanged) {
            filesChanged = true;
            if (ev.path && ev.operation) {
              appendFileChange({ operation: ev.operation, path: ev.path, oldPath: ev.oldPath }, markTimeline());
              deps.setPreviewStatus({ kind: "load", text: t("fileUpdated", { path: ev.path }) });
              setAgentActivity(t("fileUpdatedHandling", { path: ev.path }));
              const handled = await deps.handlePersistedFileChange(ev);
              if (handled) {
                shouldRunPreviewForFilesChanged ||= handled.shouldRunPreview;
                filesChangedProjectId = handled.projectId;
              }
            } else {
              deps.setPreviewStatus({ kind: "load", text: t("filesUpdatedRefresh") });
              setAgentActivity(t("filesUpdatedPrepareRefresh"));
              const projectId = projectIdRef.current;
              if (projectId) {
                await deps.loadFiles(projectId, APP_ENTRY_PATH);
                shouldRunPreviewForFilesChanged = true;
                filesChangedProjectId = projectId;
              }
            }
          } else if (ev.type === ChatEventType.Chat) {
            const stamp = markTimeline();
            updateAi((m) => {
              const hasChatTimelineItem = m.timeline?.some((item) => item.kind === AiTimelineItemKind.Chat);
              return {
                ...m,
                chatText: (m.chatText ?? "") + ev.delta,
                timeline: hasChatTimelineItem
                  ? m.timeline
                  : appendTimelineItem(m.timeline, {
                      id: `chat-${m.id}`,
                      kind: AiTimelineItemKind.Chat,
                      ...stamp,
                    }),
              };
            });
            setAgentActivity(t("replying"));
          } else if (ev.type === ChatEventType.IntegrationCard) {
            updateAi((m) => ({ ...m, integrationCard: ev.meta }));
            setAgentActivity(t("waitingFigma"));
          } else if (ev.type === ChatEventType.Title) {
            const update = { conversationId: ev.conversationId, title: ev.title, projectTitle: ev.projectTitle };
            setLastTitleUpdate(update);
            deps.onTitleUpdate(update);
          } else if (ev.type === ChatEventType.Error) {
            throw new Error(ev.message);
          } else if (ev.type === ChatEventType.Done) {
            if (doneReceived) {
              throw new Error("PROTOCOL_VIOLATION: SSE transport emitted duplicate done events.");
            }
            doneReceived = true;
          }

          if (
            stopRequestedRef.current?.controller === controller
            && await stopRequestedForTransport(controller, transportIdentity)
          ) {
            return { filesChanged, clientToolCalls, aborted: true };
          }
        }

        if (!transportIdentity || !latestRun || !doneReceived) {
          throw new Error(
            "PROTOCOL_VIOLATION: SSE transport ended without identity, run_state, and done.",
          );
        }
        return {
          filesChanged,
          shouldRunPreviewForFilesChanged,
          filesChangedProjectId,
          clientToolCalls,
          identity: transportIdentity,
          run: latestRun,
          aborted: false,
        };
      }

      try {
        for (let resumeCount = 0; resumeCount < MAX_CLIENT_TOOL_RESUMES; resumeCount++) {
          const result = await consumeTurn(turn);
          if (result.aborted || signal.aborted) return;

          pendingFilesChanged ||= result.filesChanged;
          pendingShouldRunPreview ||= Boolean(result.shouldRunPreviewForFilesChanged);
          pendingFilesChangedProjectId = result.filesChangedProjectId ?? pendingFilesChangedProjectId;

          if (result.clientToolCalls.length === 0) {
            collapseFileWriteStreams();
            if (result.run.status === AgentRunStatus.WaitingFeedback) {
              if (
                await stopRequestedForTransport(controller, result.identity)
                || signal.aborted
              ) {
                return;
              }

              const shouldRunPreview = pendingFilesChanged
                && pendingShouldRunPreview
                && Boolean(pendingFilesChangedProjectId);
              const preview = shouldRunPreview && pendingFilesChangedProjectId
                ? await deps.runPreview(pendingFilesChangedProjectId, signal)
                : null;
              if (
                signal.aborted
                || await stopRequestedForTransport(controller, result.identity)
              ) {
                return;
              }

              if (pendingFilesChanged) {
                const summary = previewSummary(preview, pendingShouldRunPreview, t);
                updateAi((m) => ({
                  ...m,
                  summaryKind: summary.summaryKind,
                  summary: summary.summary,
                }));
              }

              pendingFilesChanged = false;
              pendingShouldRunPreview = false;
              pendingFilesChangedProjectId = null;
              if (shouldRunPreview && !previewSucceeded(preview)) {
                const conversationId = convIdRef.current;
                if (!conversationId) throw new Error(t("missingConversation"));
                const feedback = preview
                  ?? interruptedPreviewResult(t("previewNoResult"));
                deps.setPreviewStatus({ kind: "load", text: t("previewErrorFixing") });
                setAgentActivity(t("previewErrorFixing"));
                turn = {
                  kind: "preview_feedback",
                  conversationId,
                  runId: result.run.id,
                  attempt: result.run.attempt,
                  result: feedback,
                };
                continue;
              }

              const completed = await completeAgentRun(result.run.id);
              if (
                completed.id !== result.run.id
                || !agentRunIsTerminal(completed.status)
              ) {
                throw new Error(
                  `PROTOCOL_VIOLATION: completion did not close AgentRun ${result.run.id}.`,
                );
              }
              if (signal.aborted) return;
              activeRunSnapshotRef.current = completed;
              activeRunIdentityRef.current = {
                runId: completed.id,
                attempt: completed.attempt,
              };
              setWriting(false);
              setBusy(false);
              if (completed.status === AgentRunStatus.Cancelled) {
                useConversationStore.getState().stopTurn();
                deps.setPreviewStatus({ kind: "", text: t("stopped") });
              } else {
                finishAgentTurn();
                deps.setPreviewStatus({ kind: "", text: t("waitingUser") });
                if (completed.status === AgentRunStatus.Failed) {
                  deps.onError(runFailureError(completed));
                }
              }
              return;
            }

            if (result.run.status === AgentRunStatus.WaitingAsyncTool) {
              setWriting(true);
              setBusy(true);
              return;
            }
            if (result.run.status === AgentRunStatus.WaitingExternal) {
              setWriting(false);
              setBusy(true);
              useConversationStore.getState().setWriting(false);
              return;
            }
            if (result.run.status === AgentRunStatus.Blocked) {
              setWriting(false);
              setBusy(true);
              useConversationStore.getState().setWriting(false);
              deps.onError(runFailureError(result.run));
              return;
            }
            if (agentRunIsTerminal(result.run.status)) {
              const pendingStop = stopRequestedRef.current;
              if (pendingStop?.controller === controller) {
                pendingStop.runId = result.run.id;
                settleStopRequest(pendingStop, true);
                stopRequestedRef.current = null;
              }
              setWriting(false);
              setBusy(false);
              if (result.run.status === AgentRunStatus.Cancelled) {
                useConversationStore.getState().stopTurn();
                deps.setPreviewStatus({ kind: "", text: t("stopped") });
              } else {
                finishAgentTurn();
                deps.setPreviewStatus({ kind: "", text: t("waitingUser") });
                if (result.run.status === AgentRunStatus.Failed) {
                  deps.onError(runFailureError(result.run));
                }
              }
              return;
            }
            throw new Error(
              `PROTOCOL_VIOLATION: transport ended at unexpected AgentRun status ${result.run.status}.`,
            );
          }

          if (result.run.status !== AgentRunStatus.WaitingClientTool) {
            throw new Error(
              `PROTOCOL_VIOLATION: client tool calls ended at ${result.run.status}.`,
            );
          }

          const conversationId = convIdRef.current;
          const projectId = projectIdRef.current;
          if (!conversationId || !projectId) {
            throw new Error(t("missingConversation"));
          }

          if (pendingFilesChanged) {
            await deps.loadFiles(projectId, APP_ENTRY_PATH);
            if (signal.aborted) return;
          }

          const firstCall = result.clientToolCalls[0];
          const batchIdentity = {
            runId: firstCall.agentRunId,
            attempt: firstCall.attempt,
          };
          for (const call of result.clientToolCalls) {
            if (
              signal.aborted
              || await stopRequestedForTransport(controller, batchIdentity)
            ) {
              return;
            }
            await startClientToolInvocation(
              call.agentRunId,
              call.invocationId,
              call.attempt,
              signal,
            );
            if (
              signal.aborted
              || await stopRequestedForTransport(controller, batchIdentity)
            ) {
              return;
            }

            if (call.name === ToolName.RunPreview) {
              deps.setPreviewStatus({ kind: "load", text: t("runningPreview") });
              setAgentActivity(t("runningPreview"));
              const preview = await deps.runPreview(projectId, signal);
              if (
                signal.aborted
                || await stopRequestedForTransport(controller, batchIdentity)
              ) {
                return;
              }
              const submission = ClientToolResultSubmissionSchema.parse({
                projectId,
                toolCallId: call.id,
                invocationId: call.invocationId,
                agentRunId: call.agentRunId,
                attempt: call.attempt,
                tool: ToolName.RunPreview,
                result: preview ?? interruptedPreviewResult(t("previewNoResult")),
              });
              await postToolResult(submission, signal);
              if (signal.aborted) return;

              const previewPassed = previewSucceeded(preview);
              deps.setPreviewStatus({
                kind: "load",
                text: previewPassed ? t("previewOkSummarizing") : t("previewErrorFixing"),
              });
              setAgentActivity(previewPassed ? t("previewOkSummarizing") : t("previewErrorFixing"));
              pendingFilesChanged = false;
              pendingShouldRunPreview = false;
              pendingFilesChangedProjectId = null;
              continue;
            }

            if (isClientFileToolName(call.name)) {
              const fileCall = ClientFileToolCallSchema.parse(call);
              const cacheKey = fileCall.invocationId;
              let execution = clientToolResultCacheRef.current.get(cacheKey);
              if (!execution) {
                execution = deps.executeClientFileTool(projectId, fileCall);
                clientToolResultCacheRef.current.set(cacheKey, execution);
              }
              const fileResult = await execution;
              if (
                signal.aborted
                || await stopRequestedForTransport(controller, batchIdentity)
              ) {
                return;
              }

              if (fileResult.status === "error") {
                deps.setPreviewStatus({ kind: "err", text: t("toolFailed", { name: fileResult.tool }) });
                setAgentActivity(t("toolFailedHandling", { name: fileResult.tool }));
              }

              const changedEvent = clientFileChangedEvent(fileResult, {
                runId: fileCall.agentRunId,
                attempt: fileCall.attempt,
              });
              if (changedEvent?.path && changedEvent.operation) {
                appendFileChange({
                  operation: changedEvent.operation,
                  path: changedEvent.path,
                  oldPath: changedEvent.oldPath,
                }, markTimeline());
                const handled = await deps.handlePersistedFileChange(changedEvent);
                if (
                  signal.aborted
                  || await stopRequestedForTransport(controller, batchIdentity)
                ) {
                  return;
                }
                if (handled) {
                  pendingFilesChanged = true;
                  pendingShouldRunPreview ||= handled.shouldRunPreview;
                  pendingFilesChangedProjectId = handled.projectId;
                }
              }

              const submission = ClientToolResultSubmissionSchema.parse({
                projectId,
                toolCallId: fileCall.id,
                invocationId: fileCall.invocationId,
                agentRunId: fileCall.agentRunId,
                attempt: fileCall.attempt,
                tool: fileCall.name,
                result: fileResult,
              });
              await postToolResult(submission, signal);
              continue;
            }

            const gitCall = ClientGitToolCallSchema.parse(call);
            const cacheKey = gitCall.invocationId;
            let execution = clientGitToolResultCacheRef.current.get(cacheKey);
            if (!execution) {
              execution = deps.executeClientGitTool(projectId, gitCall);
              clientGitToolResultCacheRef.current.set(cacheKey, execution);
            }
            const gitResult = await execution;
            if (
              signal.aborted
              || await stopRequestedForTransport(controller, batchIdentity)
            ) {
              return;
            }
            if (gitResult.status === "error") {
              deps.setPreviewStatus({ kind: "err", text: t("toolFailed", { name: gitResult.tool }) });
              setAgentActivity(t("toolFailedHandling", { name: gitResult.tool }));
            }
            const submission = ClientToolResultSubmissionSchema.parse({
              projectId,
              toolCallId: gitCall.id,
              invocationId: gitCall.invocationId,
              agentRunId: gitCall.agentRunId,
              attempt: gitCall.attempt,
              tool: gitCall.name,
              result: gitResult,
            });
            await postToolResult(submission, signal);
          }
          if (
            signal.aborted
            || await stopRequestedForTransport(controller, batchIdentity)
          ) {
            return;
          }
          turn = {
            kind: "resume",
            conversationId,
            runId: batchIdentity.runId,
            attempt: batchIdentity.attempt,
          };
        }

        throw new Error(t("resumeLimit", { max: MAX_CLIENT_TOOL_RESUMES }));
      } catch (error) {
        if (signal.aborted) return;
        const pendingStop = stopRequestedRef.current;
        if (pendingStop?.controller === controller) {
          const persisted = pendingStop.settledValue
            ?? await pendingStop.settled;
          if (signal.aborted) return;
          if (stopRequestedRef.current === pendingStop) {
            stopRequestedRef.current = null;
            if (persisted) {
              setWriting(false);
              setBusy(false);
              useConversationStore.getState().stopTurn();
              deps.setPreviewStatus({ kind: "", text: t("stopped") });
              return;
            }
          } else if (activeRequestRef.current !== controller) {
            return;
          }
        }
        setWriting(false);
        deps.setPreviewStatus({ kind: "err", text: t("requestFailed"), meta: "" });
        deps.onError(error);
        updateAi((m) => ({ ...m, summaryKind: "fail", summary: t("backendFailed") }));
        setBusy(false);
        finishAgentTurn();
        return;
      }
    },
    [
      appendFileChange,
      appendFileWriteStream,
      collapseFileWriteStreams,
      deps,
      locale,
      markTimeline,
      stopRequestedForTransport,
      t,
      updateAi,
    ]
  );

  const startTransport = useCallback((
    firstMessage: string,
    attachments: SendAttachment[],
    initialTurn: ChatTurn,
  ) => {
    const controller = new AbortController();
    activeRequestRef.current = controller;
    activeUserRequestRef.current = initialTurn.kind === "user"
      ? { controller, requestId: initialTurn.requestId }
      : null;
    void runLoop(firstMessage, controller, attachments, initialTurn)
      .catch((error) => {
        if (controller.signal.aborted) return;
        setBusy(false);
        setWriting(false);
        finishAgentTurn();
        deps.setPreviewStatus({ kind: "err", text: t("internalError"), meta: "" });
        deps.onError(error);
        updateAi((message) => ({
          ...message,
          summaryKind: "fail",
          summary: t("backendFailed"),
        }));
      })
      .finally(() => {
        if (activeRequestRef.current === controller) {
          activeRequestRef.current = null;
        }
        if (activeUserRequestRef.current?.controller === controller) {
          activeUserRequestRef.current = null;
        }
        if (
          stopRequestedRef.current?.controller === controller
          && !stopRequestedRef.current.promise
        ) {
          settleStopRequest(stopRequestedRef.current, false);
          stopRequestedRef.current = null;
        }
      });
  }, [deps, runLoop, t, updateAi]);

  const startContinuation = useCallback((
    turn: Extract<ChatTurn, { kind: "resume" | "preview_feedback" }>,
  ) => {
    if (activeRequestRef.current || stopRequestedRef.current) return false;
    const activeRun = activeRunSnapshotRef.current;
    if (
      !activeRun
      || activeRun.id !== turn.runId
      || activeRun.attempt !== turn.attempt
      || activeRun.conversationId !== turn.conversationId
    ) {
      deps.onError(new Error(
        `PROTOCOL_VIOLATION: continuation identity ${turn.runId}/${turn.attempt} is stale.`,
      ));
      return false;
    }
    const aiId = crypto.randomUUID();
    curAiIdRef.current = aiId;
    timelineOrderRef.current = 0;
    setMessages((previous) => [
      ...previous,
      {
        id: aiId,
        role: "ai",
        attempts: [],
        fileChanges: [],
        timeline: [],
      },
    ]);
    setBusy(true);
    setWriting(true);
    useConversationStore.getState().startTurn(aiId);
    startTransport("", [], turn);
    return true;
  }, [deps, startTransport]);

  const send = useCallback(
    (prompt: string, attachments: SendAttachment[] = []) => {
      const p = prompt.trim();
      if (
        busy
        || activeRequestRef.current
        || stopRequestedRef.current
        || (!p && attachments.length === 0)
      ) {
        return;
      }
      const existingRun = activeRunSnapshotRef.current;
      if (existingRun && !agentRunIsTerminal(existingRun.status)) {
        deps.onError(new Error(
          `PROTOCOL_VIOLATION: AgentRun ${existingRun.id} is still ${existingRun.status}.`,
        ));
        return;
      }
      const messageText = p || t("attachmentOnly");
      const projectId = projectIdRef.current;
      let turn: ChatTurn;
      try {
        turn = ChatTurnSchema.parse({
          kind: "user",
          message: messageText,
          projectId,
          conversationId: convIdRef.current,
          attachments: attachments.map((attachment) => ({ id: attachment.id })),
          requestId: crypto.randomUUID(),
          ...(projectId
            ? { repository: deps.getRepositoryDescriptor(projectId) }
            : {}),
        });
      } catch (error) {
        deps.onError(error);
        return;
      }

      activeRunIdentityRef.current = null;
      activeRunSnapshotRef.current = null;
      stopRequestedRef.current = null;
      lastPromptRef.current = messageText;
      lastAttachmentsRef.current = attachments;
      timelineOrderRef.current = 0;

      const userId = crypto.randomUUID();
      const aiId = crypto.randomUUID();
      curAiIdRef.current = aiId;
      setMessages((prev) => [
        ...prev,
        {
          id: userId,
          role: "user",
          text: messageText,
          attachments: attachments.map((attachment) => ({
            id: attachment.id,
            type: attachment.type,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            name: attachment.name,
            previewUrl: attachment.previewUrl,
          })),
        },
        { id: aiId, role: "ai", attempts: [], fileChanges: [], timeline: [] },
      ]);
      setBusy(true);
      useConversationStore.getState().startTurn(aiId);
      startTransport(messageText, attachments, turn);
    },
    [busy, deps, startTransport, t]
  );

  const resume = useCallback(() => {
    if (activeRequestRef.current) return;
    const conversationId = convIdRef.current;
    const expectedRun = activeRunSnapshotRef.current;
    if (!conversationId || !expectedRun) {
      deps.onError(new Error("PROTOCOL_VIOLATION: no active AgentRun is available to resume."));
      return;
    }

    void getConversationAgentRun(conversationId)
      .then(({ run }) => {
        if (
          convIdRef.current !== conversationId
          || activeRunSnapshotRef.current?.id !== expectedRun.id
          || activeRunSnapshotRef.current.attempt !== expectedRun.attempt
        ) {
          return;
        }
        if (!run || run.id !== expectedRun.id) {
          throw new Error(
            `PROTOCOL_VIOLATION: conversation restore did not return AgentRun ${expectedRun.id}.`,
          );
        }
        activeRunSnapshotRef.current = run;
        activeRunIdentityRef.current = {
          runId: run.id,
          attempt: run.attempt,
        };
        if (!agentRunCanResume(run.status)) {
          throw new Error(
            `PROTOCOL_VIOLATION: AgentRun ${run.id} cannot resume from ${run.status}.`,
          );
        }
        startContinuation({
          kind: "resume",
          conversationId,
          runId: run.id,
          attempt: run.attempt,
        });
      })
      .catch((error) => deps.onError(error));
  }, [deps, startContinuation]);

  const finishConversationRestore = useCallback(async (
    restoredRun: AgentRunSnapshot | null,
    preview: ToolResult | null,
    previewWasRun: boolean,
  ) => {
    if (!restoredRun) return;
    let activeRun = activeRunSnapshotRef.current;
    if (
      !activeRun
      || activeRun.id !== restoredRun.id
      || activeRun.attempt !== restoredRun.attempt
      || activeRun.conversationId !== convIdRef.current
    ) {
      return;
    }

    if (
      activeRun.status === AgentRunStatus.WaitingClientTool
      || activeRun.status === AgentRunStatus.Running
    ) {
      try {
        const recovered = await recoverAgentRun(
          activeRun.id,
          activeRun.attempt,
        );
        if (
          recovered.id !== activeRun.id
          || recovered.attempt !== activeRun.attempt
        ) {
          throw new Error(
            `PROTOCOL_VIOLATION: recovery changed AgentRun ${activeRun.id} identity.`,
          );
        }
        if (
          activeRunSnapshotRef.current?.id !== activeRun.id
          || activeRunSnapshotRef.current.attempt !== activeRun.attempt
        ) {
          return;
        }
        activeRunSnapshotRef.current = recovered;
        activeRunIdentityRef.current = {
          runId: recovered.id,
          attempt: recovered.attempt,
        };
        activeRun = recovered;
      } catch (error) {
        deps.onError(error);
        return;
      }
    }

    if (activeRun.status === AgentRunStatus.Blocked) {
      setBusy(true);
      setWriting(false);
      useConversationStore.getState().setWriting(false);
      deps.onError(runFailureError(activeRun));
      return;
    }
    if (agentRunIsTerminal(activeRun.status)) {
      setBusy(false);
      setWriting(false);
      if (activeRun.status === AgentRunStatus.Cancelled) {
        useConversationStore.getState().stopTurn();
        deps.setPreviewStatus({ kind: "", text: t("stopped") });
      } else {
        finishAgentTurn();
        deps.setPreviewStatus({ kind: "", text: t("waitingUser") });
        if (activeRun.status === AgentRunStatus.Failed) {
          deps.onError(runFailureError(activeRun));
        }
      }
      return;
    }

    if (activeRun.status === AgentRunStatus.WaitingAsyncTool) {
      setBusy(true);
      setWriting(true);
      useConversationStore.getState().setWriting(true);
      return;
    }
    if (activeRun.status === AgentRunStatus.WaitingExternal) {
      setBusy(true);
      setWriting(false);
      useConversationStore.getState().setWriting(false);
      return;
    }

    if (activeRun.status === AgentRunStatus.WaitingResume) {
      startContinuation({
        kind: "resume",
        conversationId: activeRun.conversationId,
        runId: activeRun.id,
        attempt: activeRun.attempt,
      });
      return;
    }
    if (activeRun.status !== AgentRunStatus.WaitingFeedback) return;

    if (previewWasRun && preview?.status === "error") {
      startContinuation({
        kind: "preview_feedback",
        conversationId: activeRun.conversationId,
        runId: activeRun.id,
        attempt: activeRun.attempt,
        result: preview,
      });
      return;
    }
    if (previewWasRun && !previewSucceeded(preview)) {
      deps.onError(new Error(
        `PROTOCOL_VIOLATION: restored AgentRun ${activeRun.id} preview produced no result.`,
      ));
      return;
    }

    try {
      const completed = await completeAgentRun(activeRun.id);
      if (
        completed.id !== activeRun.id
        || !agentRunIsTerminal(completed.status)
      ) {
        throw new Error(
          `PROTOCOL_VIOLATION: completion did not close AgentRun ${activeRun.id}.`,
        );
      }
      if (
        activeRunSnapshotRef.current?.id !== activeRun.id
        || activeRunSnapshotRef.current.attempt !== activeRun.attempt
      ) {
        return;
      }
      activeRunSnapshotRef.current = completed;
      activeRunIdentityRef.current = {
        runId: completed.id,
        attempt: completed.attempt,
      };
      setBusy(false);
      setWriting(false);
      if (completed.status === AgentRunStatus.Cancelled) {
        useConversationStore.getState().stopTurn();
        deps.setPreviewStatus({ kind: "", text: t("stopped") });
      } else {
        finishAgentTurn();
        deps.setPreviewStatus({ kind: "", text: t("waitingUser") });
        if (completed.status === AgentRunStatus.Failed) {
          deps.onError(runFailureError(completed));
        }
      }
    } catch (error) {
      deps.onError(error);
    }
  }, [deps, startContinuation, t]);

  const stop = useCallback(() => {
    if (stopRequestedRef.current) return;
    const controller = activeRequestRef.current;
    const identity = activeRunIdentityRef.current;
    const activeUserRequest = controller
      && activeUserRequestRef.current?.controller === controller
      ? activeUserRequestRef.current
      : null;
    if (!controller && !identity) {
      deps.onError(new Error("PROTOCOL_VIOLATION: no active AgentRun is available to stop."));
      return;
    }
    if (!identity && !activeUserRequest) {
      deps.onError(new Error(
        "PROTOCOL_VIOLATION: active transport has neither AgentRun nor request identity.",
      ));
      return;
    }

    const request = createStopRequest(
      controller,
      identity?.runId ?? null,
      activeUserRequest?.requestId ?? null,
    );
    stopRequestedRef.current = request;
    if (identity) {
      void persistStopRequest(request, identity);
    } else if (activeUserRequest) {
      void persistRequestIdentityStop(request, activeUserRequest.requestId);
    }
  }, [deps, persistRequestIdentityStop, persistStopRequest]);

  const rerun = useCallback(() => {
    if (lastPromptRef.current) send(lastPromptRef.current, lastAttachmentsRef.current);
  }, [send]);

  return {
    curAiId: curAiIdRef,
    messages,
    writing,
    busy,
    currentProjectId,
    currentConversationId,
    lastTitleUpdate,
    setProjectContext,
    openProjectChat,
    openConversation,
    finishConversationRestore,
    send,
    resume,
    stop,
    rerun,
  };
}
