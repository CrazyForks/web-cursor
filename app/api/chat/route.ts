/**
 * [INPUT]: kind=user 的用户消息，或 kind=resume 的已闭合 transcript 续写请求
 * [OUTPUT]: SSE(init/tools_call/tool_result/tool_pending/files_changed/chat/done/error)，并落库完整 transcript
 * [POS]: A 域 LLM Agent loop —— 持 key、读 DB transcript、执行后端文件工具、流式转发
 * [PROTOCOL]: 每次 HTTP loop 只解析一次 versioned Harness；provider tool stream 与 Transcript 都 fail closed。
 *   Database 工具由 server 执行且结果经 conversation fence 闭合；Browser Git 整轮交给 client。
 */
import { toLLMMessages, TranscriptProtocolError } from "@/server/context";
import { ToolCallStreamAssembler } from "@/lib/agent/toolCallStreamAssembler";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { defaultLocale, isAppLocale, localeHeaderName, type AppLocale } from "@/i18n/locales";
import { db } from "@/server/db";
import { conversations, projects } from "@/server/db/schema";
import llmClient from "@/server/llm";
import { agentHarnessFor } from "@/server/agentHarness";
import { getOwnedConversationProjectId, ownsConversation, ownsProject } from "@/server/guard";
import { ownerIdFrom } from "@/server/owner";
import { appendMessage, listMessages } from "@/server/messages";
import { attachToConversation, AttachmentError } from "@/server/attachments";
import {
  appendPendingToolResults,
  PendingToolResultAppendStatus,
  prepareTranscriptForModelInput,
  TailToolCallError,
  TailToolCallReadiness,
  type PendingToolResultAppendOutcome,
} from "@/server/toolCalls";
import { makeInitialTitle, updateGeneratedTitlesFromUserMessage } from "@/server/titles";
import {
  executeToolCall,
  ToolExecutionErrorCode,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "@/server/tools/executor";
import { maybeAppendFigmaConnectionGate } from "@/server/integrations/figmaGate";
import { ChatEventType, ChatTurnSchema, type ChatEvent, type ChatTurn } from "@/types/chat";
import { FileChangeOperation } from "@/types/chat";
import type { AttachmentSummary } from "@/types/attachment";
import type { IntegrationCardMeta } from "@/types/integration";
import { ToolName, ToolResultType, type ToolCallMeta } from "@/types/tool";
import { extractWriteFileStreamUpdate, type WriteFileStreamState } from "@/server/writeFileStream";
import {
  ProjectStorageKind,
  ProjectStorageKindSchema,
  type ProjectStorageKind as ProjectStorageKindValue,
} from "@/types/projectStorage";
import type { ProjectRepositoryDescriptor } from "@/types/projectRepository";
import { toProjectRepositoryDescriptor } from "@/server/projectResponse";
import { and, eq, isNull } from "drizzle-orm";
import { ClientToolCallSchema, clientToolRunsInBrowser } from "@/types/clientTool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DbMessage = Awaited<ReturnType<typeof listMessages>>[number];
type ResolvedAgentHarness = ReturnType<typeof agentHarnessFor>;

const MAX_TOOL_ROUNDS = 16;

const ChatRequestErrorCode = {
  AsyncToolPending: "ASYNC_TOOL_PENDING",
} as const;

const ChatAgentDiagnosticCode = {
  StaleServerToolResultDropped: "STALE_SERVER_TOOL_RESULT_DROPPED",
} as const;

const TOOL_ROUND_LIMIT_MESSAGE: Record<AppLocale, (max: number) => string> = {
  zh: (max) => `工具调用超过上限 ${max} 轮，已停止。`,
  en: (max) => `Stopped: tool calls exceeded the limit of ${max} rounds.`,
};

type DeepSeekStreamingParams = ChatCompletionCreateParamsStreaming & {
  thinking: { type: "disabled" };
};

function sseResponse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

function requestLocale(req: Request): AppLocale | Response {
  const locale = req.headers.get(localeHeaderName);
  if (locale === null) return defaultLocale;
  if (isAppLocale(locale)) return locale;
  return Response.json({ error: "bad request", detail: `Invalid ${localeHeaderName}` }, { status: 400 });
}

function serverToolResultsWereAppended(
  conversationId: string,
  outcome: PendingToolResultAppendOutcome,
): boolean {
  if (outcome.status === PendingToolResultAppendStatus.Appended) return true;

  console.warn(ChatAgentDiagnosticCode.StaleServerToolResultDropped, {
    conversationId,
    rejectedIndex: outcome.rejectedIndex,
    expected: outcome.expected,
    received: outcome.received,
  });
  return false;
}

function assistantMessages(rows: DbMessage[], harness: ResolvedAgentHarness) {
  return [
    { role: "system" as const, content: harness.systemPrompt },
    ...toLLMMessages(rows),
  ];
}

async function requestAssistant(
  rows: DbMessage[],
  harness: ResolvedAgentHarness,
  signal: AbortSignal,
) {
  const params: DeepSeekStreamingParams = {
    messages: assistantMessages(rows, harness),
    model: harness.model,
    tools: harness.tools,
    tool_choice: harness.toolChoice,
    stream: harness.stream,
    thinking: harness.thinking,
  };
  return llmClient.chat.completions.create(params, { signal });
}

async function collectAssistantTurn(
  rows: DbMessage[],
  harness: ResolvedAgentHarness,
  send: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<{ text: string; toolCalls: ToolCallMeta[] }> {
  const stream = await requestAssistant(rows, harness, signal);
  const toolCalls = new ToolCallStreamAssembler();
  const announcedToolCalls = new Set<number>();
  const writeFileStreams = new Map<number, WriteFileStreamState>();
  let text = "";

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    toolCalls.observeFinishReason(choice?.finish_reason);
    const delta = choice?.delta;
    if (delta?.content) {
      text += delta.content;
      send({ type: ChatEventType.Chat, delta: delta.content });
    }

    for (const tc of delta?.tool_calls ?? []) {
      const next = toolCalls.append(tc);

      if (
        next.id
        && next.name === ToolName.WriteFile
        && next.arguments !== undefined
        && typeof tc.function?.arguments === "string"
        && tc.function.arguments.length > 0
      ) {
        const update = extractWriteFileStreamUpdate(
          next.arguments,
          writeFileStreams.get(next.index),
        );
        if (update) {
          writeFileStreams.set(next.index, update.state);
          if (update.path || update.delta) {
            send({
              type: ChatEventType.FileWriteStream,
              toolCallId: next.id,
              path: update.path,
              delta: update.delta,
            });
          }
        }
      }

      if (next.id && next.name && !announcedToolCalls.has(next.index)) {
        announcedToolCalls.add(next.index);
        send({
          type: ChatEventType.ToolsCall,
          index: next.index,
          id: next.id,
          name: next.name,
        });
      }
    }
  }

  return {
    text,
    toolCalls: toolCalls.finish(),
  };
}

function fileChangedEvent(
  result: Awaited<ReturnType<typeof executeToolCall>>,
): Extract<ChatEvent, { type: typeof ChatEventType.FilesChanged }> | null {
  if (result.status !== "ok") return null;

  if (result.tool === ToolName.WriteFile) {
    return { type: ChatEventType.FilesChanged, operation: FileChangeOperation.Write, path: result.path };
  }
  if (result.tool === ToolName.DeleteFile) {
    return { type: ChatEventType.FilesChanged, operation: FileChangeOperation.Delete, path: result.path };
  }
  if (result.tool === ToolName.RenameFile) {
    return {
      type: ChatEventType.FilesChanged,
      operation: FileChangeOperation.Rename,
      path: result.newPath,
      oldPath: result.oldPath,
    };
  }
  return null;
}

async function runAgentLoop({
  ownerId,
  conversationId,
  projectId,
  storageKind,
  created,
  initRepository,
  userMessage,
  locale,
  send,
  signal,
}: {
  ownerId: string;
  conversationId: string;
  projectId: string;
  storageKind: ProjectStorageKindValue;
  created: boolean;
  initRepository?: ProjectRepositoryDescriptor;
  userMessage?: string;
  locale: AppLocale;
  send: (event: ChatEvent) => void;
  signal: AbortSignal;
}) {
  const harness = agentHarnessFor(locale, storageKind);

  if (created) {
    if (!initRepository) throw new Error("Missing repository descriptor for new conversation.");
    send({ type: ChatEventType.Init, conversationId, repository: initRepository });
  }
  if (userMessage) {
    try {
      const titleUpdate = await updateGeneratedTitlesFromUserMessage({
        conversationId,
        projectId,
        userMessage,
        signal,
      });
      if (titleUpdate) send({ type: ChatEventType.Title, conversationId, ...titleUpdate });
    } catch (titleError) {
      if (signal.aborted) throw titleError;
      console.warn("Failed to generate chat title", titleError);
    }
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    signal.throwIfAborted();
    const rows = await listMessages(conversationId);
    const assistant = await collectAssistantTurn(rows, harness, send, signal);
    signal.throwIfAborted();

    if (assistant.toolCalls.length === 0) {
      if (assistant.text) {
        await appendMessage(conversationId, {
          role: "assistant",
          content: assistant.text,
          model: harness.model,
          meta: { kind: "reply" },
        });
      }
      send({ type: ChatEventType.Done });
      return;
    }

    await appendMessage(conversationId, {
      role: "assistant",
      content: assistant.text,
      model: harness.model,
      meta: { toolCalls: assistant.toolCalls },
    });

    const clientExecution = assistant.toolCalls.map((toolCall) =>
      clientToolRunsInBrowser(toolCall.name, storageKind)
    );
    const hasClientTool = clientExecution.some(Boolean);
    const hasServerTool = clientExecution.some((runsOnClient) => !runsOnClient);
    if (hasClientTool && hasServerTool) {
      const message = "A tool-call round cannot mix browser-executed and server-executed tools.";
      const rejectedResults = assistant.toolCalls.map((toolCall) => {
        const result: ToolExecutionResult = {
          status: "error",
          tool: toolCall.name,
          code: ToolExecutionErrorCode.BadArgs,
          message,
        };
        return {
          toolCall,
          write: {
            toolCall,
            content: JSON.stringify(result),
          },
        };
      });
      signal.throwIfAborted();
      const outcome = await appendPendingToolResults(
        conversationId,
        rejectedResults.map(({ write }) => write),
      );
      if (!serverToolResultsWereAppended(conversationId, outcome)) return;

      for (const { toolCall } of rejectedResults) {
        send({ type: ChatEventType.ToolResult, name: toolCall.name, status: "error" });
      }
      continue;
    }

    if (hasClientTool) {
      const calls = assistant.toolCalls.map((toolCall) => ClientToolCallSchema.parse({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      }));
      send({ type: ChatEventType.ClientToolCalls, calls });
      return;
    }

    const ctx: ToolExecutionContext = {
      ownerId,
      projectId,
      conversationId,
    };

    for (const toolCall of assistant.toolCalls) {
      signal.throwIfAborted();
      const result = await executeToolCall(toolCall, ctx);
      if (result.status === "pending" && result.tool === ToolName.GenerateImage) {
        send({
          type: ChatEventType.ToolPending,
          id: toolCall.id,
          name: ToolName.GenerateImage,
          runId: result.runId,
          jobs: result.jobs,
        });
        send({ type: ChatEventType.Done });
        return;
      }

      signal.throwIfAborted();
      const outcome = await appendPendingToolResults(conversationId, [{
        toolCall,
        content: JSON.stringify(result),
      }]);
      if (!serverToolResultsWereAppended(conversationId, outcome)) return;

      send({ type: ChatEventType.ToolResult, name: toolCall.name, status: result.status });

      const changedEvent = fileChangedEvent(result);
      if (changedEvent) send(changedEvent);

    }
  }

  send({ type: ChatEventType.Error, message: TOOL_ROUND_LIMIT_MESSAGE[locale](MAX_TOOL_ROUNDS) });
}

async function prepareChatTranscript(conversationId: string): Promise<Response | null> {
  try {
    const readiness = await prepareTranscriptForModelInput(conversationId);
    if (readiness === TailToolCallReadiness.WaitingAsync) {
      return Response.json({
        error: "async tool pending",
        code: ChatRequestErrorCode.AsyncToolPending,
      }, { status: 409 });
    }
    return null;
  } catch (error) {
    if (error instanceof TranscriptProtocolError || error instanceof TailToolCallError) {
      return Response.json({
        error: "transcript protocol error",
        code: error.code,
        detail: error.message,
      }, { status: 409 });
    }
    throw error;
  }
}

function streamAgent(args: {
  conversationId: string;
  projectId: string;
  storageKind: ProjectStorageKindValue;
  ownerId: string;
  created: boolean;
  initRepository?: ProjectRepositoryDescriptor;
  userMessage?: string;
  locale: AppLocale;
}, requestSignal: AbortSignal) {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const abort = () => abortController.abort(requestSignal.reason);
  if (requestSignal.aborted) abort();
  else requestSignal.addEventListener("abort", abort, { once: true });

  return sseResponse(new ReadableStream({
    async start(controller) {
      const send = (event: ChatEvent) => {
        if (abortController.signal.aborted) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        await runAgentLoop({ ...args, send, signal: abortController.signal });
      } catch (error) {
        if (!abortController.signal.aborted) {
          send({ type: ChatEventType.Error, message: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        requestSignal.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {
          // The client may already have cancelled the response stream.
        }
      }
    },
    cancel() {
      abortController.abort();
    },
  }));
}

function streamStaticAssistant(args: {
  conversationId: string;
  projectId: string;
  created: boolean;
  initRepository?: ProjectRepositoryDescriptor;
  content: string;
  integrationCard?: IntegrationCardMeta;
}) {
  const encoder = new TextEncoder();

  return sseResponse(new ReadableStream({
    start(controller) {
      const send = (event: ChatEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      if (args.created) {
        if (!args.initRepository) throw new Error("Missing repository descriptor for new conversation.");
        send({
          type: ChatEventType.Init,
          conversationId: args.conversationId,
          repository: args.initRepository,
        });
      }
      send({ type: ChatEventType.Chat, delta: args.content });
      if (args.integrationCard) {
        send({ type: ChatEventType.IntegrationCard, meta: args.integrationCard });
      }
      send({ type: ChatEventType.Done });
      controller.close();
    },
  }));
}

function previewFeedbackMessage(result: Extract<ChatTurn, { kind: "preview_feedback" }>["result"], locale: AppLocale) {
  if (locale === "en") {
    if (result.status === "ok") {
      return [
        `Browser preview result: ${result.type}${result.durationMs ? `, ${result.durationMs}ms` : ""}.`,
        `WebContainer dev server: ${result.url} (port ${result.port}).`,
        result.rawLog ? `Raw npm dev output:\n${result.rawLog}` : "",
      ].filter(Boolean).join("\n");
    }

    if (result.type === ToolResultType.InstallError || result.type === ToolResultType.DevServerError) {
      return [
        `Browser preview failed: ${result.type}`,
        `Command: ${result.command}`,
        `Exit code: ${result.exitCode ?? "not exited"}`,
        `Error message: ${result.message}`,
        `Raw command output:\n${result.rawLog}`,
        "Continue fixing the project files based on this real npm/Rsbuild output; do not assume the project is already running.",
      ].join("\n");
    }

    return [
      `Browser preview failed: ${result.type}`,
      `Error message: ${result.message}`,
      result.type === ToolResultType.BrowserRuntimeError && result.stack ? `Stack trace: ${result.stack}` : "",
      result.type === ToolResultType.BrowserRuntimeError && result.rawLog ? `Raw npm dev output:\n${result.rawLog}` : "",
      "Continue fixing the project files based on this real preview result; do not assume the project is already running.",
    ].filter(Boolean).join("\n");
  }

  if (result.status === "ok") {
    return [
      `浏览器预览结果：${result.type}${result.durationMs ? `，耗时 ${result.durationMs}ms` : ""}。`,
      `WebContainer dev server：${result.url}（端口 ${result.port}）。`,
      result.rawLog ? `npm dev 原始输出：\n${result.rawLog}` : "",
    ].filter(Boolean).join("\n");
  }

  if (result.type === ToolResultType.InstallError || result.type === ToolResultType.DevServerError) {
    return [
      `浏览器预览失败：${result.type}`,
      `执行命令：${result.command}`,
      `退出码：${result.exitCode ?? "进程未退出"}`,
      `错误信息：${result.message}`,
      `原始命令输出：\n${result.rawLog}`,
      "请根据这个真实 npm/Rsbuild 输出继续修复项目文件；不要假设项目已经能运行。",
    ].join("\n");
  }

  return [
    `浏览器预览失败：${result.type}`,
    `错误信息：${result.message}`,
    result.type === ToolResultType.BrowserRuntimeError && result.stack ? `错误堆栈：${result.stack}` : "",
    result.type === ToolResultType.BrowserRuntimeError && result.rawLog ? `npm dev 原始输出：\n${result.rawLog}` : "",
    "请根据这个真实预览结果继续修复项目文件；不要假设项目已经能运行。",
  ].filter(Boolean).join("\n");
}

export async function POST(req: Request) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  const locale = requestLocale(req);
  if (locale instanceof Response) return locale;

  let body: ChatTurn;
  try {
    body = ChatTurnSchema.parse(await req.json());
  } catch (e) {
    return Response.json({ error: "bad request", detail: String(e) }, { status: 400 });
  }

  if (body.kind === "resume") {
    const projectId = await getOwnedConversationProjectId(body.conversationId, ownerId);
    if (!projectId) return new Response("Not Found", { status: 404 });
    const [project] = await db.select().from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) return new Response("Not Found", { status: 404 });
    const storageKind = ProjectStorageKindSchema.parse(project.storageKind);
    const preparationError = await prepareChatTranscript(body.conversationId);
    if (preparationError) return preparationError;
    return streamAgent({ conversationId: body.conversationId, projectId, storageKind, ownerId, created: false, locale }, req.signal);
  }

  if (body.kind === "preview_feedback") {
    const projectId = await getOwnedConversationProjectId(body.conversationId, ownerId);
    if (!projectId) return new Response("Not Found", { status: 404 });
    const [project] = await db.select().from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) return new Response("Not Found", { status: 404 });
    const storageKind = ProjectStorageKindSchema.parse(project.storageKind);

    const preparationError = await prepareChatTranscript(body.conversationId);
    if (preparationError) return preparationError;
    await appendMessage(body.conversationId, {
      role: "user",
      content: previewFeedbackMessage(body.result, locale),
      meta: { previewResult: body.result },
    });

    return streamAgent({ conversationId: body.conversationId, projectId, storageKind, ownerId, created: false, locale }, req.signal);
  }

  let { conversationId, projectId } = body;
  const created = !conversationId;
  const initialTitle = makeInitialTitle(body.message);

  if (conversationId) {
    if (!(await ownsConversation(conversationId, ownerId))) {
      return new Response("Not Found", { status: 404 });
    }
    const ownedProjectId = await getOwnedConversationProjectId(conversationId, ownerId);
    if (!ownedProjectId) return new Response("Not Found", { status: 404 });
    projectId = ownedProjectId;
  } else {
    if (projectId) {
      if (!(await ownsProject(projectId, ownerId))) {
        return new Response("Not Found", { status: 404 });
      }
    } else {
      // Compatibility path until the homepage creates projects explicitly before starting chat.
      const [project] = await db.insert(projects).values({
        ownerId,
        title: initialTitle,
        storageKind: ProjectStorageKind.Database,
      }).returning();
      projectId = project.id;
    }
    const [conversation] = await db.insert(conversations).values({ projectId, title: initialTitle }).returning();
    conversationId = conversation.id;
  }

  const [project] = await db.select().from(projects)
    .where(and(
      eq(projects.id, projectId),
      eq(projects.ownerId, ownerId),
      isNull(projects.deletedAt),
    ))
    .limit(1);
  if (!project) return new Response("Not Found", { status: 404 });
  const storageKind = ProjectStorageKindSchema.parse(project.storageKind);
  const initRepository: ProjectRepositoryDescriptor | undefined = created
    ? toProjectRepositoryDescriptor(project)
    : undefined;

  const preparationError = await prepareChatTranscript(conversationId);
  if (preparationError) return preparationError;

  let attachments: AttachmentSummary[] | undefined;
  const attachmentIds = body.attachments?.map((attachment) => attachment.id) ?? [];
  if (attachmentIds.length) {
    try {
      attachments = await attachToConversation({ ownerId, conversationId, projectId, attachmentIds });
    } catch (error) {
      if (error instanceof AttachmentError) {
        return Response.json({ error: error.message, code: error.code }, { status: 400 });
      }
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  await appendMessage(conversationId, {
    role: "user",
    content: body.message,
    meta: attachments?.length ? { attachments } : undefined,
  });

  const figmaGate = await maybeAppendFigmaConnectionGate({
    ownerId,
    conversationId,
    message: body.message,
    locale,
  });
  if (figmaGate) {
    return streamStaticAssistant({
      conversationId,
      projectId,
      created,
      initRepository,
      content: figmaGate.content,
      integrationCard: figmaGate.meta,
    });
  }

  return streamAgent({
    conversationId,
    projectId,
    storageKind,
    ownerId,
    created,
    initRepository,
    userMessage: body.message,
    locale,
  }, req.signal);
}
