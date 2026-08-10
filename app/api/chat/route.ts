/**
 * [INPUT]: strict user/resume/preview_feedback ChatTurn
 * [OUTPUT]: AgentRun-bound SSE plus durable transcript/tool invocation ledger
 * [POS]: A 域 AgentRun 执行器 —— HTTP 只持有可续租 lease，运行事实由 server/agentRuns.ts 持久化
 * [PROTOCOL]: 每轮主模型调用前严格准备 Checkpoint context，再持久化 model/tool identity；
 *   所有副作用执行前过 run fence，Stop 先落库再使迟到结果失效
 */
import { and, eq, isNull } from "drizzle-orm";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import {
  defaultLocale,
  isAppLocale,
  localeHeaderName,
  type AppLocale,
} from "@/i18n/locales";
import {
  ToolCallStreamAssembler,
  ToolCallStreamProtocolError,
} from "@/lib/agent/toolCallStreamAssembler";
import { TranscriptProtocolError } from "@/lib/agent/fullContextAssembler";
import { db } from "@/server/db";
import { conversations, projects } from "@/server/db/schema";
import { attachToConversation, AttachmentError } from "@/server/attachments";
import {
  acquireAgentRun,
  AgentRunCreationOutcome,
  AgentRunLeaseConfig,
  AgentRunServiceError,
  AgentRunServiceErrorCode,
  beginAgentModelRound,
  createAgentRun,
  failAgentRun,
  heartbeatAgentRun,
  markAsyncToolInvocationStarted,
  markServerToolInvocationStarted,
  recordAgentAssistantReply,
  recordAgentExternalWait,
  recordAgentToolRound,
  recordRejectedToolResult,
  recordServerToolResult,
  releaseAgentRunLease,
  runInAgentRunTransaction,
  waitForAgentBoundary,
  type AgentRunInvocation,
  type AgentRunLease,
  type AgentRunCreation,
} from "@/server/agentRuns";
import {
  agentHarnessFor,
  AgentHarnessRestoreError,
  restoreAgentHarness,
} from "@/server/agentHarness";
import {
  ContextCompactionError,
  ContextCompactionErrorCode,
  prepareAgentContext,
} from "@/server/contextCheckpoint";
import {
  DeepSeekUsageSchema,
  type ContextTokenBaseline,
  type DeepSeekUsage,
} from "@/server/contextTokenEstimate";
import { maybeAppendFigmaConnectionGate } from "@/server/integrations/figmaGate";
import llmClient from "@/server/llm";
import { listMessages } from "@/server/messages";
import { ownerIdFrom } from "@/server/owner";
import { previewFeedbackMessage } from "@/server/previewFeedback";
import {
  AgentToolPolicyError,
  agentToolEffect,
  agentToolExecutionDomain,
  serverDatabaseToolIsAtomicMutation,
} from "@/server/tools/agentToolPolicy";
import {
  executeToolCall,
  ToolExecutionErrorCode,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "@/server/tools/executor";
import { updateGeneratedTitlesFromUserMessage, makeInitialTitle } from "@/server/titles";
import {
  extractWriteFileStreamUpdate,
  type WriteFileStreamState,
} from "@/server/writeFileStream";
import {
  AgentRunFailureCode,
  AgentRunStatus,
  AgentToolExecutionDomain,
  AgentToolResultKind,
  type AgentRunSnapshot,
} from "@/types/agentRun";
import type { AttachmentSummary } from "@/types/attachment";
import {
  ChatEventSchema,
  ChatEventType,
  ContextCompactionPhase,
  ChatTurnSchema,
  FileChangeOperation,
  type ChatEvent,
  type ChatTurn,
} from "@/types/chat";
import { ClientToolCallSchema } from "@/types/clientTool";
import {
  ProjectStorageKind,
  ProjectStorageKindSchema,
  type ProjectStorageKind as ProjectStorageKindValue,
} from "@/types/projectStorage";
import { ToolName, type ToolCallMeta } from "@/types/tool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DbMessage = Awaited<ReturnType<typeof listMessages>>[number];
type ResolvedAgentHarness = ReturnType<typeof restoreAgentHarness>;
type ChatEventPayload = ChatEvent extends infer TEvent
  ? TEvent extends ChatEvent
    ? Omit<TEvent, "agentRunId" | "attempt">
    : never
  : never;

type DeepSeekStreamingParams = ChatCompletionCreateParamsStreaming & {
  thinking: { type: "disabled" };
};

const InvalidToolRoundMessage = {
  MixedDomains:
    "A tool-call round cannot mix client, server, and async execution domains.",
  MultipleAsync:
    "A tool-call round may contain only one async generate_image invocation.",
} as const;

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
  return Response.json(
    { error: "bad request", detail: `Invalid ${localeHeaderName}` },
    { status: 400 },
  );
}

function withRun(
  run: AgentRunSnapshot,
  event: ChatEventPayload,
): ChatEvent {
  return ChatEventSchema.parse({
    ...event,
    agentRunId: run.id,
    attempt: run.attempt,
  });
}

async function requestAssistant(
  messages: ChatCompletionCreateParamsStreaming["messages"],
  harness: ResolvedAgentHarness,
  signal: AbortSignal,
) {
  const params: DeepSeekStreamingParams = {
    messages,
    model: harness.model,
    tools: harness.tools,
    tool_choice: harness.toolChoice,
    stream: harness.stream,
    stream_options: { include_usage: true },
    thinking: harness.thinking,
  };
  return llmClient.chat.completions.create(params, { signal });
}

async function collectAssistantTurn(
  messages: ChatCompletionCreateParamsStreaming["messages"],
  harness: ResolvedAgentHarness,
  send: (event: ChatEventPayload) => void,
  signal: AbortSignal,
): Promise<{
  text: string;
  toolCalls: ToolCallMeta[];
  usage: DeepSeekUsage;
}> {
  const stream = await requestAssistant(messages, harness, signal);
  const toolCalls = new ToolCallStreamAssembler();
  const announced = new Set<number>();
  const fileStreams = new Map<number, WriteFileStreamState>();
  let text = "";
  let usage: DeepSeekUsage | null = null;

  for await (const chunk of stream) {
    signal.throwIfAborted();
    if (chunk.usage) {
      const parsed = DeepSeekUsageSchema.safeParse(chunk.usage);
      if (!parsed.success) {
        throw new ContextCompactionError(
          ContextCompactionErrorCode.ProviderUsageInvalid,
          parsed.error.message,
        );
      }
      if (usage && usage.total_tokens !== parsed.data.total_tokens) {
        throw new ContextCompactionError(
          ContextCompactionErrorCode.ProviderUsageInvalid,
          "DeepSeek emitted conflicting total_tokens values.",
        );
      }
      usage = parsed.data;
    }
    const choice = chunk.choices[0];
    toolCalls.observeFinishReason(choice?.finish_reason);
    const delta = choice?.delta;
    if (delta?.content) {
      text += delta.content;
      send({ type: ChatEventType.Chat, delta: delta.content });
    }

    for (const toolDelta of delta?.tool_calls ?? []) {
      const next = toolCalls.append(toolDelta);
      if (
        next.id
        && next.name === ToolName.WriteFile
        && next.arguments !== undefined
        && typeof toolDelta.function?.arguments === "string"
        && toolDelta.function.arguments.length > 0
      ) {
        const update = extractWriteFileStreamUpdate(
          next.arguments,
          fileStreams.get(next.index),
        );
        if (update) {
          fileStreams.set(next.index, update.state);
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

      if (next.id && next.name && !announced.has(next.index)) {
        announced.add(next.index);
        send({
          type: ChatEventType.ToolsCall,
          index: next.index,
          id: next.id,
          name: next.name,
        });
      }
    }
  }

  if (!usage) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.ProviderUsageMissing,
      "DeepSeek stream ended without the requested usage chunk.",
    );
  }
  return { text, toolCalls: toolCalls.finish(), usage };
}

function tokenBaselineFromTranscript(
  rows: readonly DbMessage[],
  usage: DeepSeekUsage,
): ContextTokenBaseline {
  const last = rows.at(-1);
  if (!last || !Number.isSafeInteger(last.seq) || last.seq <= 0) {
    throw new ContextCompactionError(
      ContextCompactionErrorCode.ProviderUsageInvalid,
      "Cannot bind DeepSeek usage to a persisted transcript boundary.",
    );
  }
  return {
    providerTotalTokens: usage.total_tokens,
    coveredThroughSeq: last.seq,
  };
}

async function withLeaseHeartbeat<T>(
  execution: AgentRunLease,
  ownerId: string,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  let heartbeatError: unknown;
  let heartbeatInFlight: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (heartbeatInFlight || controller.signal.aborted) return;
    heartbeatInFlight = heartbeatAgentRun({
      ownerId,
      runId: execution.run.id,
      attempt: execution.run.attempt,
      leaseId: execution.leaseId,
    }).catch((error) => {
      heartbeatError = error;
      controller.abort(error);
    }).finally(() => {
      heartbeatInFlight = null;
    });
  }, AgentRunLeaseConfig.HeartbeatIntervalMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (heartbeatError) throw heartbeatError;
    throw error;
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", abort);
    await heartbeatInFlight;
  }
}

function fileChangedEvent(
  result: ToolExecutionResult,
): Extract<ChatEventPayload, { type: typeof ChatEventType.FilesChanged }> | null {
  if (result.status !== "ok") return null;
  if (result.tool === ToolName.WriteFile) {
    return {
      type: ChatEventType.FilesChanged,
      operation: FileChangeOperation.Write,
      path: result.path,
    };
  }
  if (result.tool === ToolName.DeleteFile) {
    return {
      type: ChatEventType.FilesChanged,
      operation: FileChangeOperation.Delete,
      path: result.path,
    };
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

function toolResultKind(
  result: Exclude<ToolExecutionResult, { status: "pending" }>,
) {
  return result.status === "ok"
    ? AgentToolResultKind.Success
    : AgentToolResultKind.Error;
}

function rejectedToolResult(tool: string, message: string): ToolExecutionResult {
  return {
    status: "error",
    tool,
    code: ToolExecutionErrorCode.BadArgs,
    message,
  };
}

function invalidRoundMessage(invocations: readonly AgentRunInvocation[]) {
  const domains = new Set(invocations.map(({ executionDomain }) => executionDomain));
  if (domains.size > 1) return InvalidToolRoundMessage.MixedDomains;
  if (
    domains.has(AgentToolExecutionDomain.Async)
    && invocations.length > 1
  ) {
    return InvalidToolRoundMessage.MultipleAsync;
  }
  return null;
}

async function rejectInvalidRound(input: {
  execution: AgentRunLease;
  ownerId: string;
  invocations: readonly AgentRunInvocation[];
  message: string;
  send: (event: ChatEventPayload) => void;
}) {
  for (const invocation of input.invocations) {
    const result = rejectedToolResult(invocation.toolName, input.message);
    await recordRejectedToolResult({
      ownerId: input.ownerId,
      runId: input.execution.run.id,
      invocationId: invocation.id,
      attempt: input.execution.run.attempt,
      leaseId: input.execution.leaseId,
      content: JSON.stringify(result),
    });
    input.send({
      type: ChatEventType.ToolResult,
      name: invocation.toolName,
      status: "error",
    });
  }
}

async function executeServerInvocation(input: {
  execution: AgentRunLease;
  ownerId: string;
  projectId: string;
  conversationId: string;
  storageKind: ProjectStorageKindValue;
  invocation: AgentRunInvocation;
  signal: AbortSignal;
}): Promise<ToolExecutionResult> {
  const runIdentity = {
    ownerId: input.ownerId,
    runId: input.execution.run.id,
    invocationId: input.invocation.id,
    attempt: input.execution.run.attempt,
    leaseId: input.execution.leaseId,
  };
  const call: ToolCallMeta = {
    id: input.invocation.providerCallId,
    name: input.invocation.toolName,
    arguments: input.invocation.arguments,
  };
  const context: ToolExecutionContext = {
    ownerId: input.ownerId,
    projectId: input.projectId,
    conversationId: input.conversationId,
  };

  if (
    serverDatabaseToolIsAtomicMutation(
      input.invocation.toolName,
      input.storageKind,
    )
  ) {
    return runInAgentRunTransaction(async (tx) => {
      await markServerToolInvocationStarted({ ...runIdentity, writer: tx });
      const result = await executeToolCall(call, {
        ...context,
        databaseWriter: tx,
      });
      if (result.status === "pending") {
        throw new Error("Database mutation returned an async result.");
      }
      await recordServerToolResult({
        ...runIdentity,
        writer: tx,
        kind: toolResultKind(result),
        content: JSON.stringify(result),
      });
      return result;
    });
  }

  await markServerToolInvocationStarted(runIdentity);
  const result = await withLeaseHeartbeat(
    input.execution,
    input.ownerId,
    input.signal,
    (toolSignal) => {
      toolSignal.throwIfAborted();
      return executeToolCall(call, context);
    },
  );
  if (result.status === "pending") {
    throw new Error("Server invocation unexpectedly returned an async result.");
  }
  await recordServerToolResult({
    ...runIdentity,
    kind: toolResultKind(result),
    content: JSON.stringify(result),
  });
  return result;
}

async function executeAsyncInvocation(input: {
  execution: AgentRunLease;
  ownerId: string;
  projectId: string;
  conversationId: string;
  invocation: AgentRunInvocation;
}): Promise<{
  result: ToolExecutionResult;
  waitingRun: AgentRunSnapshot | null;
}> {
  return runInAgentRunTransaction(async (tx) => {
    const identity = {
      ownerId: input.ownerId,
      runId: input.execution.run.id,
      invocationId: input.invocation.id,
      attempt: input.execution.run.attempt,
      leaseId: input.execution.leaseId,
      writer: tx,
    };
    await markAsyncToolInvocationStarted(identity);
    const result = await executeToolCall({
      id: input.invocation.providerCallId,
      name: input.invocation.toolName,
      arguments: input.invocation.arguments,
    }, {
      ownerId: input.ownerId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      databaseWriter: tx,
      agentRun: {
        id: input.execution.run.id,
        invocationId: input.invocation.id,
      },
    });
    if (result.status !== "pending") {
      await recordRejectedToolResult({
        ...identity,
        content: JSON.stringify(result),
      });
      return { result, waitingRun: null };
    }
    const waitingRun = await waitForAgentBoundary({
      ownerId: input.ownerId,
      runId: input.execution.run.id,
      attempt: input.execution.run.attempt,
      leaseId: input.execution.leaseId,
      status: AgentRunStatus.WaitingAsyncTool,
      invocationIds: [input.invocation.id],
      writer: tx,
    });
    return { result, waitingRun };
  });
}

async function runAgentLoop(input: {
  execution: AgentRunLease;
  harness: ResolvedAgentHarness;
  ownerId: string;
  created: boolean;
  userMessage?: string;
  locale: AppLocale;
  send: (event: ChatEventPayload) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { run } = input.execution;
  const storageKind = ProjectStorageKindSchema.parse(run.repository.storageKind);
  if (input.created) {
    input.send({
      type: ChatEventType.Init,
      conversationId: run.conversationId,
      repository: run.repository,
    });
  }
  input.send({ type: ChatEventType.RunState, run });

  if (input.userMessage) {
    const figmaGate = await withLeaseHeartbeat(
      input.execution,
      input.ownerId,
      input.signal,
      () => maybeAppendFigmaConnectionGate({
        ownerId: input.ownerId,
        conversationId: run.conversationId,
        message: input.userMessage!,
        locale: input.locale,
      }),
    );
    input.signal.throwIfAborted();
    if (figmaGate) {
      const waitingRun = await recordAgentExternalWait({
        ownerId: input.ownerId,
        runId: run.id,
        attempt: run.attempt,
        leaseId: input.execution.leaseId,
        assistantMessage: {
          role: "assistant",
          content: figmaGate.content,
          model: input.harness.model,
          meta: figmaGate.meta,
        },
      });
      input.send({ type: ChatEventType.Chat, delta: figmaGate.content });
      input.send({
        type: ChatEventType.IntegrationCard,
        meta: figmaGate.meta,
      });
      input.send({ type: ChatEventType.RunState, run: waitingRun });
      input.send({ type: ChatEventType.Done });
      return;
    }

    try {
      const title = await withLeaseHeartbeat(
        input.execution,
        input.ownerId,
        input.signal,
        (titleSignal) => updateGeneratedTitlesFromUserMessage({
          conversationId: run.conversationId,
          projectId: run.projectId,
          userMessage: input.userMessage!,
          signal: titleSignal,
        }),
      );
      if (title) {
        input.send({
          type: ChatEventType.Title,
          conversationId: run.conversationId,
          ...title,
        });
      }
    } catch (error) {
      if (input.signal.aborted) throw error;
      console.warn("Failed to generate chat title", error);
    }
  }

  let tokenBaseline: ContextTokenBaseline | null = null;
  while (true) {
    input.signal.throwIfAborted();
    const rows = await listMessages(run.conversationId);
    const prepared = await withLeaseHeartbeat(
      input.execution,
      input.ownerId,
      input.signal,
      (contextSignal) => prepareAgentContext({
        conversationId: run.conversationId,
        currentRunId: run.id,
        rows,
        systemPrompt: input.harness.systemPrompt,
        tools: input.harness.tools,
        baseline: tokenBaseline,
        signal: contextSignal,
        onCompactionStarted: () => input.send({
          type: ChatEventType.ContextCompaction,
          phase: ContextCompactionPhase.Started,
        }),
      }),
    );
    if (prepared.compacted) {
      input.send({
        type: ChatEventType.ContextCompaction,
        phase: ContextCompactionPhase.Completed,
      });
    }
    const modelRound = await beginAgentModelRound({
      ownerId: input.ownerId,
      runId: run.id,
      attempt: run.attempt,
      leaseId: input.execution.leaseId,
    });
    const assistant = await withLeaseHeartbeat(
      input.execution,
      input.ownerId,
      input.signal,
      (modelSignal) => collectAssistantTurn(
        prepared.messages,
        input.harness,
        input.send,
        modelSignal,
      ),
    );
    input.signal.throwIfAborted();

    if (assistant.toolCalls.length === 0) {
      const waiting = await recordAgentAssistantReply({
        ownerId: input.ownerId,
        runId: run.id,
        attempt: run.attempt,
        leaseId: input.execution.leaseId,
        content: assistant.text,
        model: input.harness.model,
      });
      input.send({ type: ChatEventType.RunState, run: waiting });
      input.send({ type: ChatEventType.Done });
      return;
    }

    const invocations = await recordAgentToolRound({
      ownerId: input.ownerId,
      runId: run.id,
      attempt: run.attempt,
      leaseId: input.execution.leaseId,
      modelRound,
      assistantText: assistant.text,
      model: input.harness.model,
      invocations: assistant.toolCalls.map((toolCall, callIndex) => ({
        toolCall,
        callIndex,
        executionDomain: agentToolExecutionDomain(toolCall.name, storageKind),
        effect: agentToolEffect(toolCall.name),
      })),
    });
    tokenBaseline = tokenBaselineFromTranscript(
      await listMessages(run.conversationId),
      assistant.usage,
    );

    const rejection = invalidRoundMessage(invocations);
    if (rejection) {
      await rejectInvalidRound({
        execution: input.execution,
        ownerId: input.ownerId,
        invocations,
        message: rejection,
        send: input.send,
      });
      continue;
    }

    const domain = invocations[0].executionDomain;
    if (domain === AgentToolExecutionDomain.Client) {
      const waiting = await waitForAgentBoundary({
        ownerId: input.ownerId,
        runId: run.id,
        attempt: run.attempt,
        leaseId: input.execution.leaseId,
        status: AgentRunStatus.WaitingClientTool,
        invocationIds: invocations.map(({ id }) => id),
      });
      const calls = invocations.map((invocation) => ClientToolCallSchema.parse({
        id: invocation.providerCallId,
        name: invocation.toolName,
        arguments: invocation.arguments,
        invocationId: invocation.id,
        agentRunId: invocation.agentRunId,
        attempt: invocation.attempt,
      }));
      input.send({ type: ChatEventType.ClientToolCalls, calls });
      input.send({ type: ChatEventType.RunState, run: waiting });
      input.send({ type: ChatEventType.Done });
      return;
    }

    if (domain === AgentToolExecutionDomain.Async) {
      const asyncExecution = await executeAsyncInvocation({
        execution: input.execution,
        ownerId: input.ownerId,
        projectId: run.projectId,
        conversationId: run.conversationId,
        invocation: invocations[0],
      });
      if (
        asyncExecution.result.status === "pending"
        && asyncExecution.result.tool === ToolName.GenerateImage
        && asyncExecution.waitingRun
      ) {
        input.send({
          type: ChatEventType.ToolPending,
          id: invocations[0].providerCallId,
          name: ToolName.GenerateImage,
          runId: asyncExecution.result.runId,
          jobs: asyncExecution.result.jobs,
        });
        input.send({
          type: ChatEventType.RunState,
          run: asyncExecution.waitingRun,
        });
        input.send({ type: ChatEventType.Done });
        return;
      }
      input.send({
        type: ChatEventType.ToolResult,
        name: invocations[0].toolName,
        status: "error",
      });
      continue;
    }

    for (const invocation of invocations) {
      input.signal.throwIfAborted();
      const result = await executeServerInvocation({
        execution: input.execution,
        ownerId: input.ownerId,
        projectId: run.projectId,
        conversationId: run.conversationId,
        storageKind,
        invocation,
        signal: input.signal,
      });
      if (result.status === "pending") {
        throw new Error("Server domain returned an unhandled pending result.");
      }
      input.send({
        type: ChatEventType.ToolResult,
        name: invocation.toolName,
        status: result.status,
      });
      const changed = fileChangedEvent(result);
      if (changed) input.send(changed);
    }
  }
}

function failureCodeFor(error: unknown) {
  if (
    error instanceof ToolCallStreamProtocolError
    || error instanceof TranscriptProtocolError
    || error instanceof AgentToolPolicyError
  ) {
    return AgentRunFailureCode.ProtocolError;
  }
  if (
    error instanceof AgentRunServiceError
    && error.code === AgentRunServiceErrorCode.BudgetExceeded
  ) {
    return AgentRunFailureCode.BudgetExhausted;
  }
  return AgentRunFailureCode.ModelError;
}

async function settleStreamFailure(
  execution: AgentRunLease,
  ownerId: string,
  error: unknown,
): Promise<AgentRunSnapshot | null> {
  if (
    error instanceof AgentRunServiceError
    && (
      error.code === AgentRunServiceErrorCode.LeaseLost
      || error.code === AgentRunServiceErrorCode.AttemptMismatch
      || error.code === AgentRunServiceErrorCode.InvalidTransition
      || error.code === AgentRunServiceErrorCode.LateResult
    )
  ) {
    return null;
  }
  try {
    return await failAgentRun({
      ownerId,
      runId: execution.run.id,
      attempt: execution.run.attempt,
      leaseId: execution.leaseId,
      code: failureCodeFor(error),
      message: error instanceof Error ? error.message : String(error),
    });
  } catch (settleError) {
    console.warn("Failed to persist AgentRun failure", settleError);
    return null;
  }
}

function streamAgent(
  input: {
    execution: AgentRunLease;
    harness: ResolvedAgentHarness;
    ownerId: string;
    created: boolean;
    userMessage?: string;
    locale: AppLocale;
  },
  requestSignal: AbortSignal,
) {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const abort = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) abort();
  else requestSignal.addEventListener("abort", abort, { once: true });

  return sseResponse(new ReadableStream({
    async start(streamController) {
      const send = (event: ChatEventPayload) => {
        if (controller.signal.aborted) return;
        streamController.enqueue(encoder.encode(
          `data: ${JSON.stringify(withRun(input.execution.run, event))}\n\n`,
        ));
      };

      try {
        await runAgentLoop({ ...input, send, signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) {
          const failed = await settleStreamFailure(
            input.execution,
            input.ownerId,
            error,
          );
          if (failed) send({ type: ChatEventType.RunState, run: failed });
          send({
            type: ChatEventType.Error,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        requestSignal.removeEventListener("abort", abort);
        try {
          await releaseAgentRunLease({
            ownerId: input.ownerId,
            runId: input.execution.run.id,
            attempt: input.execution.run.attempt,
            leaseId: input.execution.leaseId,
          });
        } catch (error) {
          console.warn("Failed to release AgentRun transport lease", error);
        }
        try {
          streamController.close();
        } catch {
          // The client already cancelled the response stream.
        }
      }
    },
    cancel() {
      controller.abort();
    },
  }));
}

function streamCancelledAgentRun(input: {
  run: AgentRunSnapshot;
  created: boolean;
}) {
  const encoder = new TextEncoder();
  return sseResponse(new ReadableStream({
    start(controller) {
      const send = (event: ChatEventPayload) => {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify(withRun(input.run, event))}\n\n`,
        ));
      };
      if (input.created) {
        send({
          type: ChatEventType.Init,
          conversationId: input.run.conversationId,
          repository: input.run.repository,
        });
      }
      send({ type: ChatEventType.RunState, run: input.run });
      send({ type: ChatEventType.Done });
      controller.close();
    },
  }));
}

function agentRunErrorResponse(error: unknown): Response {
  if (error instanceof AgentHarnessRestoreError) {
    return Response.json(
      { error: "agent harness conflict", code: error.code, detail: error.message },
      { status: 409 },
    );
  }
  if (error instanceof AgentRunServiceError) {
    const status = error.code === AgentRunServiceErrorCode.NotFound ? 404 : 409;
    return Response.json(
      { error: "agent run error", code: error.code, detail: error.message },
      { status },
    );
  }
  console.error("Failed to prepare AgentRun", error);
  return Response.json(
    { error: "internal error", detail: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

async function createUserExecution(input: {
  body: Extract<ChatTurn, { kind: "user" }>;
  ownerId: string;
  locale: AppLocale;
}): Promise<{
  creation: AgentRunCreation;
  harness: ResolvedAgentHarness;
  created: boolean;
}> {
  const created = !input.body.conversationId;
  const initialTitle = makeInitialTitle(input.body.message);
  return runInAgentRunTransaction(async (writer) => {
    let { projectId, conversationId } = input.body;
    let storageKind: ProjectStorageKindValue;

    if (conversationId) {
      const [owned] = await writer
        .select({
          projectId: projects.id,
          storageKind: projects.storageKind,
        })
        .from(conversations)
        .innerJoin(projects, eq(conversations.projectId, projects.id))
        .where(and(
          eq(conversations.id, conversationId),
          eq(projects.ownerId, input.ownerId),
          isNull(conversations.deletedAt),
          isNull(projects.deletedAt),
        ))
        .limit(1);
      if (!owned) {
        throw new AgentRunServiceError(
          AgentRunServiceErrorCode.NotFound,
          "Conversation not found.",
        );
      }
      if (
        input.body.projectId
        && input.body.projectId !== owned.projectId
      ) {
        throw new AgentRunServiceError(
          AgentRunServiceErrorCode.RepositoryMismatch,
          "Conversation does not belong to the requested project.",
        );
      }
      projectId = owned.projectId;
      storageKind = ProjectStorageKindSchema.parse(owned.storageKind);
    } else {
      if (projectId) {
        const [owned] = await writer
          .select({ storageKind: projects.storageKind })
          .from(projects)
          .where(and(
            eq(projects.id, projectId),
            eq(projects.ownerId, input.ownerId),
            isNull(projects.deletedAt),
          ))
          .limit(1);
        if (!owned) {
          throw new AgentRunServiceError(
            AgentRunServiceErrorCode.NotFound,
            "Project not found.",
          );
        }
        storageKind = ProjectStorageKindSchema.parse(owned.storageKind);
      } else {
        const [project] = await writer
          .insert(projects)
          .values({
            ownerId: input.ownerId,
            title: initialTitle,
            storageKind: ProjectStorageKind.Database,
          })
          .returning({
            id: projects.id,
            storageKind: projects.storageKind,
          });
        projectId = project.id;
        storageKind = ProjectStorageKindSchema.parse(project.storageKind);
      }
      const [conversation] = await writer
        .insert(conversations)
        .values({ projectId, title: initialTitle })
        .returning({ id: conversations.id });
      conversationId = conversation.id;
    }

    const harness = agentHarnessFor(input.locale, storageKind);
    let attachments: AttachmentSummary[] | undefined;
    const attachmentIds = input.body.attachments?.map(({ id }) => id) ?? [];
    if (attachmentIds.length) {
      attachments = await attachToConversation({
        ownerId: input.ownerId,
        conversationId,
        projectId,
        attachmentIds,
        writer,
      });
    }

    const creation = await createAgentRun({
      ownerId: input.ownerId,
      projectId,
      conversationId,
      requestId: input.body.requestId,
      repository: input.body.repository,
      harnessIdentity: harness.identity,
      userMessage: {
        role: "user",
        content: input.body.message,
        meta: attachments?.length ? { attachments } : undefined,
      },
      writer,
    });
    return { creation, harness, created };
  });
}

export async function POST(req: Request) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });
  const locale = requestLocale(req);
  if (locale instanceof Response) return locale;

  const parsed = ChatTurnSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "bad request", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    if (body.kind === "resume") {
      const execution = await acquireAgentRun({
        ownerId,
        runId: body.runId,
        conversationId: body.conversationId,
        expectedAttempt: body.attempt,
        allowedStatuses: [
          AgentRunStatus.WaitingResume,
          AgentRunStatus.WaitingExternal,
        ],
      });
      return streamAgent({
        execution,
        harness: restoreAgentHarness(execution.harnessIdentity),
        ownerId,
        created: false,
        locale,
      }, req.signal);
    }

    if (body.kind === "preview_feedback") {
      const execution = await acquireAgentRun({
        ownerId,
        runId: body.runId,
        conversationId: body.conversationId,
        expectedAttempt: body.attempt,
        allowedStatuses: [AgentRunStatus.WaitingFeedback],
        message: {
          role: "user",
          content: previewFeedbackMessage(body.result, locale),
          meta: { previewResult: body.result },
        },
      });
      return streamAgent({
        execution,
        harness: restoreAgentHarness(execution.harnessIdentity),
        ownerId,
        created: false,
        locale,
      }, req.signal);
    }

    const prepared = await createUserExecution({ body, ownerId, locale });
    if (prepared.creation.outcome === AgentRunCreationOutcome.Cancelled) {
      return streamCancelledAgentRun({
        run: prepared.creation.run,
        created: prepared.created,
      });
    }
    return streamAgent({
      execution: prepared.creation.execution,
      harness: prepared.harness,
      created: prepared.created,
      ownerId,
      userMessage: body.message,
      locale,
    }, req.signal);
  } catch (error) {
    if (error instanceof AttachmentError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: 400 },
      );
    }
    return agentRunErrorResponse(error);
  }
}
