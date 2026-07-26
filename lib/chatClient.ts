/**
 * [INPUT]: Strict ChatTurn requests, AgentRun lifecycle commands, client tool results, and AbortSignals
 * [OUTPUT]: Validated ChatEvent stream plus AgentRun start/stop/complete/recover/restore client operations
 * [POS]: B 域 → A 域 AgentRun/chat HTTP and SSE protocol boundary
 * [PROTOCOL]: Every JSON body and response crosses a strict schema；malformed SSE data fails closed；
 *   iterator 提前退出必须 cancel response reader，让服务端释放对应 transport lease
 */
"use client";

import { z } from "zod";
import { localeHeaderName } from "@/i18n/locales";
import {
  AgentRunCompleteBodySchema,
  AgentRunIdSchema,
  AgentRunRecoverBodySchema,
  AgentRunRequestIdSchema,
  AgentRunRequestStopBodySchema,
  AgentRunRequestStopResponseSchema,
  AgentRunRestoreResponseSchema,
  AgentRunSnapshotSchema,
  AgentRunStartInvocationBodySchema,
  AgentRunStopBodySchema,
  type AgentRunRequestStopResponse,
  type AgentRunRestoreResponse,
  type AgentRunSnapshot,
} from "@/types/agentRun";
import {
  ChatEventSchema,
  ChatTurnSchema,
  type ChatEvent,
  type ChatTurn,
} from "@/types/chat";
import {
  ClientToolResultSubmissionSchema,
  type ClientToolResultSubmission,
} from "@/types/clientTool";
import { getOwnerId } from "./owner";

const ConversationIdSchema = z.string().uuid();
const ClientToolInvocationIdSchema = z.string().uuid();

function jsonHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "x-owner-id": getOwnerId(),
  };
}

async function responseError(path: string, response: Response): Promise<Error> {
  const detail = await response.text().catch(() => "");
  return new Error(`${path} ${response.status} ${detail}`.trim());
}

function sseData(block: string): string | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line === "data" || line.startsWith("data:"));
  if (dataLines.length === 0) return null;
  return dataLines
    .map((line) => line === "data" ? "" : line.slice(5).replace(/^ /, ""))
    .join("\n");
}

function parseChatEventBlock(block: string): ChatEvent | null {
  const data = sseData(block);
  if (data === null) return null;
  try {
    return ChatEventSchema.parse(JSON.parse(data));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const protocolError = new Error(`Invalid /api/chat SSE event: ${detail}`, { cause: error });
    protocolError.name = "ChatClientProtocolError";
    throw protocolError;
  }
}

/** 调后端 /api/chat，逐条 yield 已校验的 SSE 事件。signal 中止当前后端流。 */
export async function* streamChat(
  turn: ChatTurn,
  locale: string,
  signal: AbortSignal,
): AsyncIterable<ChatEvent> {
  const path = "/api/chat";
  const res = await fetch(path, {
    method: "POST",
    headers: { ...jsonHeaders(), [localeHeaderName]: locale },
    body: JSON.stringify(ChatTurnSchema.parse(turn)),
    signal,
  });

  if (!res.ok || !res.body) {
    throw await responseError(path, res);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        reachedEof = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseChatEventBlock(block);
        if (event) yield event;
      }
    }

    if (buffer) {
      const event = parseChatEventBlock(buffer);
      if (event) yield event;
    }
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

/** Close one pending model tool call. This records execution result only; it never calls the LLM. */
export async function postToolResult(
  submission: ClientToolResultSubmission,
  signal: AbortSignal,
): Promise<void> {
  const body = ClientToolResultSubmissionSchema.parse(submission);
  const path = `/api/agent-runs/${body.agentRunId}/tool-invocations/${body.invocationId}/result`;
  const res = await fetch(path, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await responseError(path, res);
}

export async function startClientToolInvocation(
  agentRunId: string,
  invocationId: string,
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  const parsedAgentRunId = AgentRunIdSchema.parse(agentRunId);
  const parsedInvocationId = ClientToolInvocationIdSchema.parse(invocationId);
  const body = AgentRunStartInvocationBodySchema.parse({ attempt });
  const path = `/api/agent-runs/${parsedAgentRunId}/tool-invocations/${parsedInvocationId}/start`;
  const res = await fetch(path, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (res.status !== 204) throw await responseError(path, res);
}

export async function stopAgentRun(agentRunId: string): Promise<AgentRunSnapshot> {
  const parsedAgentRunId = AgentRunIdSchema.parse(agentRunId);
  const body = AgentRunStopBodySchema.parse({});
  const path = `/api/agent-runs/${parsedAgentRunId}/stop`;
  const res = await fetch(path, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    keepalive: true,
  });
  if (!res.ok) throw await responseError(path, res);
  return AgentRunSnapshotSchema.parse(await res.json());
}

export async function stopAgentRunRequest(
  requestId: string,
): Promise<AgentRunRequestStopResponse> {
  const parsedRequestId = AgentRunRequestIdSchema.parse(requestId);
  const body = AgentRunRequestStopBodySchema.parse({});
  const path = `/api/agent-run-requests/${parsedRequestId}/stop`;
  const res = await fetch(path, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    keepalive: true,
  });
  if (!res.ok) throw await responseError(path, res);
  return AgentRunRequestStopResponseSchema.parse(await res.json());
}

export async function completeAgentRun(agentRunId: string): Promise<AgentRunSnapshot> {
  const parsedAgentRunId = AgentRunIdSchema.parse(agentRunId);
  const body = AgentRunCompleteBodySchema.parse({});
  const path = `/api/agent-runs/${parsedAgentRunId}/complete`;
  const res = await fetch(path, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await responseError(path, res);
  return AgentRunSnapshotSchema.parse(await res.json());
}

export async function recoverAgentRun(
  agentRunId: string,
  attempt: number,
): Promise<AgentRunSnapshot> {
  const parsedAgentRunId = AgentRunIdSchema.parse(agentRunId);
  const body = AgentRunRecoverBodySchema.parse({ attempt });
  const path = `/api/agent-runs/${parsedAgentRunId}/recover`;
  const res = await fetch(path, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await responseError(path, res);
  return AgentRunSnapshotSchema.parse(await res.json());
}

export async function getConversationAgentRun(
  conversationId: string,
  signal?: AbortSignal,
): Promise<AgentRunRestoreResponse> {
  const parsedConversationId = ConversationIdSchema.parse(conversationId);
  const path = `/api/conversations/${parsedConversationId}/agent-run`;
  const res = await fetch(path, {
    method: "GET",
    headers: { "x-owner-id": getOwnerId() },
    signal,
  });
  if (!res.ok) throw await responseError(path, res);
  return AgentRunRestoreResponseSchema.parse(await res.json());
}
