/**
 * [INPUT]: AgentRun create/claim/transition commands, exact tool invocation receipts
 * [OUTPUT]: durable run snapshots, execution leases, idempotent tool-result closure and recovery
 * [POS]: A 域 AgentRun 权威状态机 —— HTTP/SSE 只是 transport，运行事实与 Stop fence 都在这里
 * [PROTOCOL]: 所有状态跃迁与副作用授权共用 run advisory lock；未知/迟到结果只记诊断，绝不猜测补全
 */
import "server-only";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { db } from "@/server/db";
import {
  agentRunDiagnostics,
  agentRunStopIntents,
  agentRuns,
  agentToolInvocations,
  agentToolResults,
  conversations,
  imageJobs,
  imageRuns,
  projects,
} from "@/server/db/schema";
import { appendMessage } from "@/server/messages";
import {
  AgentRunDiagnosticCode,
  AgentRunFailureCode,
  AgentRunRequestStopOutcome,
  AgentRunRequestStopResponseSchema,
  AgentRunSnapshotSchema,
  AgentRunStatus,
  AgentRunTrigger,
  AgentToolEffect,
  AgentToolExecutionDomain,
  AgentToolResultKind,
  agentRunCanTransition,
  agentRunIsTerminal,
  type AgentRunFailureCode as AgentRunFailureCodeValue,
  type AgentRunRequestStopResponse,
  type AgentRunSnapshot,
  type AgentRunStatus as AgentRunStatusValue,
  type AgentRunTrigger as AgentRunTriggerValue,
  type AgentToolEffect as AgentToolEffectValue,
  type AgentToolExecutionDomain as AgentToolExecutionDomainValue,
  type AgentToolResultKind as AgentToolResultKindValue,
} from "@/types/agentRun";
import type { AgentHarnessIdentity } from "@/types/agentHarness";
import {
  ImageJobErrorCode,
  ImageJobStatus,
  ImageRunStatus,
} from "@/types/image";
import {
  ProjectRepositoryDescriptorSchema,
  type ProjectRepositoryDescriptor,
} from "@/types/projectRepository";
import { ProjectStorageKind, ProjectStorageKindSchema } from "@/types/projectStorage";
import { ToolResultType, type ToolCallMeta } from "@/types/tool";
import type { StoredMessageInput } from "@/types/transcript";

export type AgentRunTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];
type AgentRunRow = typeof agentRuns.$inferSelect;
type AgentToolInvocationRow = typeof agentToolInvocations.$inferSelect;

export const AgentRunLeaseConfig = {
  TtlMs: 60_000,
  HeartbeatIntervalMs: 15_000,
} as const;

export const AgentRunBudget = {
  ModelRounds: 16,
  ToolRounds: 16,
} as const;

export const AgentRunServiceErrorCode = {
  NotFound: "AGENT_RUN_NOT_FOUND",
  Conflict: "AGENT_RUN_CONFLICT",
  OpenRunExists: "AGENT_RUN_OPEN_EXISTS",
  InvalidTransition: "AGENT_RUN_INVALID_TRANSITION",
  AttemptMismatch: "AGENT_RUN_ATTEMPT_MISMATCH",
  LeaseLost: "AGENT_RUN_LEASE_LOST",
  BudgetExceeded: "AGENT_RUN_BUDGET_EXCEEDED",
  RepositoryMismatch: "AGENT_RUN_REPOSITORY_MISMATCH",
  InvocationConflict: "AGENT_TOOL_INVOCATION_CONFLICT",
  LateResult: "AGENT_TOOL_RESULT_LATE",
} as const;

export type AgentRunServiceErrorCode =
  typeof AgentRunServiceErrorCode[keyof typeof AgentRunServiceErrorCode];

export class AgentRunServiceError extends Error {
  constructor(
    readonly code: AgentRunServiceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentRunServiceError";
  }
}

export type AgentRunLease = Readonly<{
  run: AgentRunSnapshot;
  leaseId: string;
  harnessIdentity: AgentHarnessIdentity;
}>;

export const AgentRunCreationOutcome = {
  Leased: "leased",
  Cancelled: "cancelled",
} as const;

export type AgentRunCreation =
  | Readonly<{
      outcome: typeof AgentRunCreationOutcome.Leased;
      execution: AgentRunLease;
    }>
  | Readonly<{
      outcome: typeof AgentRunCreationOutcome.Cancelled;
      run: AgentRunSnapshot;
    }>;

export type AgentRunInvocationInput = Readonly<{
  toolCall: ToolCallMeta;
  callIndex: number;
  executionDomain: AgentToolExecutionDomainValue;
  effect: AgentToolEffectValue;
}>;

export type AgentRunInvocation = Readonly<{
  id: string;
  agentRunId: string;
  attempt: number;
  modelRound: number;
  callIndex: number;
  providerCallId: string;
  toolName: string;
  arguments: string;
  executionDomain: AgentToolExecutionDomainValue;
  effect: AgentToolEffectValue;
}>;

const TERMINAL_RUN_STATUSES = [
  AgentRunStatus.Completed,
  AgentRunStatus.Failed,
  AgentRunStatus.Cancelled,
] as const;

function toIso(value: Date): string {
  return value.toISOString();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toSnapshot(row: AgentRunRow): AgentRunSnapshot {
  const hasFailure = row.failureCode !== null || row.failureMessage !== null;
  if (hasFailure && (row.failureCode === null || row.failureMessage === null)) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.Conflict,
      `Run ${row.id} has a partial failure record.`,
    );
  }

  return AgentRunSnapshotSchema.parse({
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    requestId: row.requestId,
    trigger: row.trigger,
    status: row.status,
    attempt: row.attempt,
    modelRounds: row.modelRounds,
    toolRounds: row.toolRounds,
    maxModelRounds: row.maxModelRounds,
    maxToolRounds: row.maxToolRounds,
    repository: row.repository,
    failure: row.failureCode === null
      ? null
      : { code: row.failureCode, message: row.failureMessage },
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    startedAt: toIso(row.startedAt),
    cancelRequestedAt: row.cancelRequestedAt ? toIso(row.cancelRequestedAt) : null,
    completedAt: row.completedAt ? toIso(row.completedAt) : null,
  });
}

function leaseExpiry(now: Date): Date {
  return new Date(now.getTime() + AgentRunLeaseConfig.TtlMs);
}

async function lockRun(tx: AgentRunTransaction, runId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"agent-run:" + runId}))`,
  );
}

async function lockConversation(
  tx: AgentRunTransaction,
  conversationId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`,
  );
}

async function lockProject(
  tx: AgentRunTransaction,
  projectId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"agent-project:" + projectId}))`,
  );
}

async function lockRequest(
  tx: AgentRunTransaction,
  ownerId: string,
  requestId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${
      `agent-request:${ownerId}:${requestId}`
    }))`,
  );
}

async function ownedRunRow(
  tx: AgentRunTransaction,
  runId: string,
  ownerId: string,
): Promise<AgentRunRow> {
  const [row] = await tx
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.ownerId, ownerId)))
    .limit(1);
  if (!row) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.NotFound,
      `AgentRun not found: ${runId}`,
    );
  }
  return row;
}

async function resolveRepository(
  tx: AgentRunTransaction,
  ownerId: string,
  projectId: string,
  conversationId: string,
  requested: ProjectRepositoryDescriptor | undefined,
): Promise<ProjectRepositoryDescriptor> {
  const [owned] = await tx
    .select({
      projectId: conversations.projectId,
      storageKind: projects.storageKind,
      revision: projects.codeRevision,
    })
    .from(conversations)
    .innerJoin(projects, eq(conversations.projectId, projects.id))
    .where(and(
      eq(conversations.id, conversationId),
      eq(projects.id, projectId),
      eq(projects.ownerId, ownerId),
      isNull(conversations.deletedAt),
      isNull(projects.deletedAt),
    ))
    .limit(1);
  if (!owned) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.NotFound,
      "Project/conversation ownership does not match.",
    );
  }

  const storageKind = ProjectStorageKindSchema.parse(owned.storageKind);
  const authoritative = storageKind === ProjectStorageKind.Database
    ? ProjectRepositoryDescriptorSchema.parse({
        projectId,
        storageKind,
        revision: owned.revision,
      })
    : requested;

  if (!authoritative) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.RepositoryMismatch,
      "Browser Git runs require an action-time repository descriptor.",
    );
  }
  const parsed = ProjectRepositoryDescriptorSchema.parse(authoritative);
  if (parsed.projectId !== projectId || parsed.storageKind !== storageKind) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.RepositoryMismatch,
      "Repository descriptor does not match the owned project.",
    );
  }
  if (requested && !sameJson(parsed, requested)) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.RepositoryMismatch,
      "Repository descriptor is stale or differs from server state.",
    );
  }
  return parsed;
}

function assertTransition(
  runId: string,
  from: AgentRunStatusValue,
  to: AgentRunStatusValue,
): void {
  if (agentRunCanTransition(from, to)) return;
  throw new AgentRunServiceError(
    AgentRunServiceErrorCode.InvalidTransition,
    `Run ${runId} cannot transition from ${from} to ${to}.`,
  );
}

function assertLease(
  row: AgentRunRow,
  attempt: number,
  leaseId: string,
  now: Date,
): void {
  if (row.attempt !== attempt) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.AttemptMismatch,
      `Run ${row.id} is attempt ${row.attempt}; received ${attempt}.`,
    );
  }
  if (
    row.status !== AgentRunStatus.Running
    || row.leaseId !== leaseId
    || !row.leaseExpiresAt
    || row.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.LeaseLost,
      `Run ${row.id} no longer owns the active execution lease.`,
    );
  }
}

async function insertDiagnostic(
  tx: AgentRunTransaction,
  input: {
    runId: string;
    attempt: number;
    code: typeof AgentRunDiagnosticCode[keyof typeof AgentRunDiagnosticCode];
    invocationId?: string;
    detail: string;
  },
): Promise<void> {
  await tx.insert(agentRunDiagnostics).values({
    agentRunId: input.runId,
    attempt: input.attempt,
    code: input.code,
    invocationId: input.invocationId,
    detail: input.detail,
  });
}

async function persistDiagnostic(
  input: Parameters<typeof insertDiagnostic>[1],
): Promise<void> {
  await db.insert(agentRunDiagnostics).values({
    agentRunId: input.runId,
    attempt: input.attempt,
    code: input.code,
    invocationId: input.invocationId,
    detail: input.detail,
  });
}

export async function createAgentRun(input: {
  ownerId: string;
  projectId: string;
  conversationId: string;
  requestId: string;
  trigger?: AgentRunTriggerValue;
  repository?: ProjectRepositoryDescriptor;
  harnessIdentity: AgentHarnessIdentity;
  userMessage: StoredMessageInput;
  writer?: AgentRunTransaction;
}): Promise<AgentRunCreation> {
  const execute = async (tx: AgentRunTransaction): Promise<AgentRunCreation> => {
    await lockRequest(tx, input.ownerId, input.requestId);
    await lockProject(tx, input.projectId);
    await lockConversation(tx, input.conversationId);

    const [duplicate] = await tx
      .select()
      .from(agentRuns)
      .where(and(
        eq(agentRuns.ownerId, input.ownerId),
        eq(agentRuns.requestId, input.requestId),
      ))
      .limit(1);
    if (duplicate) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.Conflict,
        `Request ${input.requestId} already created run ${duplicate.id}.`,
      );
    }

    const [stopIntent] = await tx
      .select()
      .from(agentRunStopIntents)
      .where(and(
        eq(agentRunStopIntents.ownerId, input.ownerId),
        eq(agentRunStopIntents.requestId, input.requestId),
      ))
      .limit(1);
    if (
      stopIntent
      && (stopIntent.agentRunId !== null || stopIntent.consumedAt !== null)
    ) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.Conflict,
        `Stop intent for request ${input.requestId} is already consumed.`,
      );
    }

    const repository = await resolveRepository(
      tx,
      input.ownerId,
      input.projectId,
      input.conversationId,
      input.repository,
    );

    const [open] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(
        eq(agentRuns.projectId, input.projectId),
        notInArray(agentRuns.status, [...TERMINAL_RUN_STATUSES]),
      ))
      .limit(1);
    if (open) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.OpenRunExists,
        `Project already has open run ${open.id}.`,
      );
    }

    const now = new Date();
    const cancelledBeforeStart = stopIntent !== undefined;
    const leaseId = cancelledBeforeStart ? null : randomUUID();
    const [row] = await tx
      .insert(agentRuns)
      .values({
        ownerId: input.ownerId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        requestId: input.requestId,
        trigger: input.trigger ?? AgentRunTrigger.User,
        status: cancelledBeforeStart
          ? AgentRunStatus.Cancelled
          : AgentRunStatus.Running,
        attempt: 1,
        leaseId,
        leaseExpiresAt: leaseId ? leaseExpiry(now) : null,
        heartbeatAt: leaseId ? now : null,
        harnessIdentity: input.harnessIdentity,
        repository,
        maxModelRounds: AgentRunBudget.ModelRounds,
        maxToolRounds: AgentRunBudget.ToolRounds,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
        cancelRequestedAt: stopIntent?.requestedAt,
        completedAt: cancelledBeforeStart ? now : null,
      })
      .returning();
    await appendMessage(input.conversationId, input.userMessage, {
      writer: tx,
      agentRunId: row.id,
    });
    if (stopIntent) {
      await tx
        .update(agentRunStopIntents)
        .set({
          agentRunId: row.id,
          consumedAt: now,
        })
        .where(eq(agentRunStopIntents.id, stopIntent.id));
      return {
        outcome: AgentRunCreationOutcome.Cancelled,
        run: toSnapshot(row),
      };
    }
    if (!leaseId) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.Conflict,
        `Run ${row.id} was created without an execution lease.`,
      );
    }
    return {
      outcome: AgentRunCreationOutcome.Leased,
      execution: {
        run: toSnapshot(row),
        leaseId,
        harnessIdentity: row.harnessIdentity,
      },
    };
  };
  return input.writer ? execute(input.writer) : db.transaction(execute);
}

export async function acquireAgentRun(input: {
  ownerId: string;
  runId: string;
  conversationId: string;
  expectedAttempt: number;
  allowedStatuses: readonly AgentRunStatusValue[];
  message?: StoredMessageInput;
}): Promise<AgentRunLease> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    if (current.conversationId !== input.conversationId) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.Conflict,
        "Run does not belong to the requested conversation.",
      );
    }
    if (current.attempt !== input.expectedAttempt) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.AttemptMismatch,
        `Run is attempt ${current.attempt}; received ${input.expectedAttempt}.`,
      );
    }
    if (!input.allowedStatuses.includes(current.status)) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvalidTransition,
        `Run ${current.id} cannot resume from ${current.status}.`,
      );
    }
    assertTransition(current.id, current.status, AgentRunStatus.Running);

    await lockConversation(tx, current.conversationId);
    const now = new Date();
    const leaseId = randomUUID();
    const [row] = await tx
      .update(agentRuns)
      .set({
        status: AgentRunStatus.Running,
        attempt: current.attempt + 1,
        leaseId,
        leaseExpiresAt: leaseExpiry(now),
        heartbeatAt: now,
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(agentRuns.id, current.id))
      .returning();
    if (input.message) {
      await appendMessage(current.conversationId, input.message, {
        writer: tx,
        agentRunId: current.id,
      });
    }
    return {
      run: toSnapshot(row),
      leaseId,
      harnessIdentity: row.harnessIdentity,
    };
  });
}

export async function heartbeatAgentRun(input: {
  ownerId: string;
  runId: string;
  attempt: number;
  leaseId: string;
}): Promise<AgentRunSnapshot> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const now = new Date();
    assertLease(current, input.attempt, input.leaseId, now);
    const [row] = await tx
      .update(agentRuns)
      .set({
        heartbeatAt: now,
        leaseExpiresAt: leaseExpiry(now),
        updatedAt: now,
      })
      .where(eq(agentRuns.id, current.id))
      .returning();
    return toSnapshot(row);
  });
}

export async function beginAgentModelRound(input: {
  ownerId: string;
  runId: string;
  attempt: number;
  leaseId: string;
}): Promise<number> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const now = new Date();
    assertLease(current, input.attempt, input.leaseId, now);
    if (current.modelRounds >= current.maxModelRounds) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.BudgetExceeded,
        `Run ${current.id} exhausted its model-round budget.`,
      );
    }
    const [row] = await tx
      .update(agentRuns)
      .set({
        modelRounds: sql`${agentRuns.modelRounds} + 1`,
        heartbeatAt: now,
        leaseExpiresAt: leaseExpiry(now),
        updatedAt: now,
      })
      .where(eq(agentRuns.id, current.id))
      .returning({ modelRounds: agentRuns.modelRounds });
    return row.modelRounds;
  });
}

function toInvocation(row: AgentToolInvocationRow): AgentRunInvocation {
  return {
    id: row.id,
    agentRunId: row.agentRunId,
    attempt: row.attempt,
    modelRound: row.modelRound,
    callIndex: row.callIndex,
    providerCallId: row.providerCallId,
    toolName: row.toolName,
    arguments: row.arguments,
    executionDomain: row.executionDomain,
    effect: row.effect,
  };
}

export async function recordAgentToolRound(input: {
  ownerId: string;
  runId: string;
  attempt: number;
  leaseId: string;
  modelRound: number;
  assistantText: string;
  model: string;
  invocations: readonly AgentRunInvocationInput[];
}): Promise<AgentRunInvocation[]> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const now = new Date();
    assertLease(current, input.attempt, input.leaseId, now);
    if (input.modelRound !== current.modelRounds) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.Conflict,
        `Model round ${input.modelRound} is not current round ${current.modelRounds}.`,
      );
    }
    if (current.toolRounds >= current.maxToolRounds) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.BudgetExceeded,
        `Run ${current.id} exhausted its tool-round budget.`,
      );
    }

    await lockConversation(tx, current.conversationId);
    const toolCalls = input.invocations.map(({ toolCall }) => toolCall);
    const assistant = await appendMessage(current.conversationId, {
      role: "assistant",
      content: input.assistantText,
      model: input.model,
      meta: { toolCalls },
    }, { writer: tx, agentRunId: current.id });
    const rows = await tx
      .insert(agentToolInvocations)
      .values(input.invocations.map((invocation) => ({
        agentRunId: current.id,
        assistantMessageId: assistant.id,
        attempt: current.attempt,
        modelRound: input.modelRound,
        callIndex: invocation.callIndex,
        providerCallId: invocation.toolCall.id,
        toolName: invocation.toolCall.name,
        arguments: invocation.toolCall.arguments,
        executionDomain: invocation.executionDomain,
        effect: invocation.effect,
      })))
      .returning();
    await tx
      .update(agentRuns)
      .set({
        toolRounds: sql`${agentRuns.toolRounds} + 1`,
        heartbeatAt: now,
        leaseExpiresAt: leaseExpiry(now),
        updatedAt: now,
      })
      .where(eq(agentRuns.id, current.id));
    return rows.map(toInvocation);
  });
}

async function transitionFromLease(
  tx: AgentRunTransaction,
  current: AgentRunRow,
  nextStatus: AgentRunStatusValue,
  now: Date,
  failure?: { code: AgentRunFailureCodeValue; message: string },
): Promise<AgentRunRow> {
  assertTransition(current.id, current.status, nextStatus);
  const terminal = agentRunIsTerminal(nextStatus);
  const [row] = await tx
    .update(agentRuns)
    .set({
      status: nextStatus,
      leaseId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      failureCode: failure?.code ?? null,
      failureMessage: failure?.message ?? null,
      completedAt: terminal ? now : null,
      updatedAt: now,
    })
    .where(eq(agentRuns.id, current.id))
    .returning();
  return row;
}

export async function waitForAgentBoundary(input: {
  ownerId: string;
  runId: string;
  attempt: number;
  leaseId: string;
  status:
    | typeof AgentRunStatus.WaitingClientTool
    | typeof AgentRunStatus.WaitingAsyncTool
    | typeof AgentRunStatus.WaitingExternal
    | typeof AgentRunStatus.WaitingResume;
  invocationIds?: readonly string[];
  writer?: AgentRunTransaction;
}): Promise<AgentRunSnapshot> {
  const execute = async (tx: AgentRunTransaction): Promise<AgentRunSnapshot> => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const now = new Date();
    assertLease(current, input.attempt, input.leaseId, now);
    if (input.invocationIds?.length) {
      await tx
        .update(agentToolInvocations)
        .set({ dispatchedAt: now })
        .where(and(
          eq(agentToolInvocations.agentRunId, current.id),
          inArray(agentToolInvocations.id, [...input.invocationIds]),
        ));
    }
    return toSnapshot(await transitionFromLease(tx, current, input.status, now));
  };
  return input.writer ? execute(input.writer) : db.transaction(execute);
}

export async function recordAgentAssistantReply(input: {
  ownerId: string;
  runId: string;
  attempt: number;
  leaseId: string;
  content: string;
  model: string;
}): Promise<AgentRunSnapshot> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const now = new Date();
    assertLease(current, input.attempt, input.leaseId, now);
    await lockConversation(tx, current.conversationId);
    if (input.content) {
      await appendMessage(current.conversationId, {
        role: "assistant",
        content: input.content,
        model: input.model,
        meta: { kind: "reply" },
      }, { writer: tx, agentRunId: current.id });
    }
    return toSnapshot(await transitionFromLease(
      tx,
      current,
      AgentRunStatus.WaitingFeedback,
      now,
    ));
  });
}

export async function recordAgentExternalWait(input: {
  ownerId: string;
  runId: string;
  attempt: number;
  leaseId: string;
  assistantMessage: StoredMessageInput;
}): Promise<AgentRunSnapshot> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const now = new Date();
    assertLease(current, input.attempt, input.leaseId, now);
    await lockConversation(tx, current.conversationId);
    await appendMessage(current.conversationId, input.assistantMessage, {
      writer: tx,
      agentRunId: current.id,
    });
    return toSnapshot(await transitionFromLease(
      tx,
      current,
      AgentRunStatus.WaitingExternal,
      now,
    ));
  });
}

async function invocationWithResult(
  tx: AgentRunTransaction,
  runId: string,
  invocationId: string,
): Promise<{
  invocation: AgentToolInvocationRow;
  result: typeof agentToolResults.$inferSelect | null;
}> {
  const [row] = await tx
    .select({
      invocation: agentToolInvocations,
      result: agentToolResults,
    })
    .from(agentToolInvocations)
    .leftJoin(
      agentToolResults,
      eq(agentToolResults.invocationId, agentToolInvocations.id),
    )
    .where(and(
      eq(agentToolInvocations.id, invocationId),
      eq(agentToolInvocations.agentRunId, runId),
    ))
    .limit(1);
  if (!row) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.NotFound,
      `Invocation not found: ${invocationId}`,
    );
  }
  return row;
}

async function allInvocationsClosed(
  tx: AgentRunTransaction,
  runId: string,
): Promise<boolean> {
  return !(await nextUnclosedInvocation(tx, runId));
}

async function nextUnclosedInvocation(
  tx: AgentRunTransaction,
  runId: string,
): Promise<AgentToolInvocationRow | null> {
  const [open] = await tx
    .select({ invocation: agentToolInvocations })
    .from(agentToolInvocations)
    .leftJoin(
      agentToolResults,
      eq(agentToolResults.invocationId, agentToolInvocations.id),
    )
    .where(and(
      eq(agentToolInvocations.agentRunId, runId),
      isNull(agentToolResults.id),
    ))
    .orderBy(
      asc(agentToolInvocations.modelRound),
      asc(agentToolInvocations.callIndex),
    )
    .limit(1);
  return open?.invocation ?? null;
}

async function appendInvocationResult(
  tx: AgentRunTransaction,
  current: AgentRunRow,
  invocation: AgentToolInvocationRow,
  kind: AgentToolResultKindValue,
  content: string,
): Promise<void> {
  const pending = await nextUnclosedInvocation(tx, current.id);
  if (!pending || pending.id !== invocation.id) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.InvocationConflict,
      `Invocation ${invocation.id} is not the next transcript result boundary.`,
    );
  }
  const message = await appendMessage(current.conversationId, {
    role: "tool",
    content,
    meta: { toolCallId: invocation.providerCallId },
  }, { writer: tx, agentRunId: current.id });
  await tx.insert(agentToolResults).values({
    agentRunId: current.id,
    invocationId: invocation.id,
    messageId: message.id,
    kind,
    content,
  });
}

export async function startClientToolInvocation(input: {
  ownerId: string;
  runId: string;
  invocationId: string;
  attempt: number;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const pair = await invocationWithResult(tx, current.id, input.invocationId);
    if (
      current.status !== AgentRunStatus.WaitingClientTool
      || current.attempt !== input.attempt
      || pair.invocation.attempt !== input.attempt
    ) {
      await persistDiagnostic({
        runId: current.id,
        attempt: input.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.LateToolResultDropped,
        detail: "Client requested execution after its run/attempt boundary closed.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.LateResult,
        "Client invocation is no longer authorized.",
      );
    }
    if (pair.invocation.executionDomain !== AgentToolExecutionDomain.Client) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Invocation is not assigned to the client execution domain.",
      );
    }
    if (pair.result) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Invocation already has a terminal result.",
      );
    }
    const pending = await nextUnclosedInvocation(tx, current.id);
    if (!pending || pending.id !== pair.invocation.id) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Invocation is not the next client execution boundary.",
      );
    }
    if (pair.invocation.startedAt) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Invocation execution was already claimed.",
      );
    }
    await tx
      .update(agentToolInvocations)
      .set({ startedAt: new Date() })
      .where(eq(agentToolInvocations.id, pair.invocation.id));
  });
}

export async function recordClientToolResult(input: {
  ownerId: string;
  runId: string;
  projectId: string;
  invocationId: string;
  attempt: number;
  providerCallId: string;
  toolName: string;
  kind: AgentToolResultKindValue;
  content: string;
}): Promise<{ duplicate: boolean; run: AgentRunSnapshot }> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const pair = await invocationWithResult(tx, current.id, input.invocationId);
    if (current.projectId !== input.projectId) {
      await persistDiagnostic({
        runId: current.id,
        attempt: input.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.ConflictingToolResult,
        detail: "Client result project differs from the persisted AgentRun.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.RepositoryMismatch,
        "Client result project does not match the AgentRun.",
      );
    }
    if (
      pair.invocation.providerCallId !== input.providerCallId
      || pair.invocation.toolName !== input.toolName
      || pair.invocation.executionDomain !== AgentToolExecutionDomain.Client
    ) {
      await persistDiagnostic({
        runId: current.id,
        attempt: input.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.ConflictingToolResult,
        detail: "Client result identity differs from the persisted invocation.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Client result identity does not match the invocation.",
      );
    }
    if (pair.result) {
      if (pair.result.content === input.content && pair.result.kind === input.kind) {
        return { duplicate: true, run: toSnapshot(current) };
      }
      if (pair.result.kind === AgentToolResultKind.Interrupted) {
        await persistDiagnostic({
          runId: current.id,
          attempt: input.attempt,
          invocationId: pair.invocation.id,
          code: AgentRunDiagnosticCode.LateToolResultDropped,
          detail: "Client result arrived after an interrupted invocation was closed.",
        });
        throw new AgentRunServiceError(
          AgentRunServiceErrorCode.LateResult,
          "Client result arrived after its invocation was interrupted.",
        );
      }
      await persistDiagnostic({
        runId: current.id,
        attempt: input.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.ConflictingToolResult,
        detail: "Invocation already has a different terminal result.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Invocation already has a different terminal result.",
      );
    }
    if (
      current.status !== AgentRunStatus.WaitingClientTool
      || current.attempt !== input.attempt
      || pair.invocation.attempt !== input.attempt
      || !pair.invocation.startedAt
    ) {
      await persistDiagnostic({
        runId: current.id,
        attempt: input.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.LateToolResultDropped,
        detail: "Late client result was dropped after the execution boundary closed.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.LateResult,
        "Client result arrived after its run/attempt boundary closed.",
      );
    }

    await lockConversation(tx, current.conversationId);
    await appendInvocationResult(
      tx,
      current,
      pair.invocation,
      input.kind,
      input.content,
    );
    if (!(await allInvocationsClosed(tx, current.id))) {
      return { duplicate: false, run: toSnapshot(current) };
    }
    const now = new Date();
    const [row] = await tx
      .update(agentRuns)
      .set({ status: AgentRunStatus.WaitingResume, updatedAt: now })
      .where(eq(agentRuns.id, current.id))
      .returning();
    return { duplicate: false, run: toSnapshot(row) };
  });
}

export async function recordAsyncToolResult(input: {
  ownerId: string;
  runId: string;
  invocationId: string;
  providerCallId: string;
  toolName: string;
  kind: AgentToolResultKindValue;
  content: string;
  beforeReceipt: (tx: AgentRunTransaction) => Promise<boolean>;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const pair = await invocationWithResult(tx, current.id, input.invocationId);
    if (
      pair.invocation.providerCallId !== input.providerCallId
      || pair.invocation.toolName !== input.toolName
      || pair.invocation.executionDomain !== AgentToolExecutionDomain.Async
    ) {
      await persistDiagnostic({
        runId: current.id,
        attempt: pair.invocation.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.ConflictingToolResult,
        detail: "Async result identity differs from the persisted invocation.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Async result identity does not match the persisted invocation.",
      );
    }
    if (pair.result) {
      if (pair.result.content === input.content && pair.result.kind === input.kind) {
        return false;
      }
      if (pair.result.kind === AgentToolResultKind.Interrupted) {
        await persistDiagnostic({
          runId: current.id,
          attempt: pair.invocation.attempt,
          invocationId: pair.invocation.id,
          code: AgentRunDiagnosticCode.LateToolResultDropped,
          detail: "Async result arrived after an interrupted invocation was closed.",
        });
        throw new AgentRunServiceError(
          AgentRunServiceErrorCode.LateResult,
          "Async result arrived after its invocation was interrupted.",
        );
      }
      await persistDiagnostic({
        runId: current.id,
        attempt: pair.invocation.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.ConflictingToolResult,
        detail: "Async invocation already has a different terminal result.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Async invocation already has a different terminal result.",
      );
    }
    if (
      current.status !== AgentRunStatus.WaitingAsyncTool
      || current.attempt !== pair.invocation.attempt
      || !pair.invocation.startedAt
    ) {
      await persistDiagnostic({
        runId: current.id,
        attempt: pair.invocation.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.LateToolResultDropped,
        detail: "Late async result was dropped after the run boundary closed.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.LateResult,
        "Async result arrived after its run boundary closed.",
      );
    }

    await lockConversation(tx, current.conversationId);
    if (!await input.beforeReceipt(tx)) return false;
    await appendInvocationResult(
      tx,
      current,
      pair.invocation,
      input.kind,
      input.content,
    );
    if (!(await allInvocationsClosed(tx, current.id))) return true;
    const now = new Date();
    await tx
      .update(agentRuns)
      .set({ status: AgentRunStatus.WaitingResume, updatedAt: now })
      .where(eq(agentRuns.id, current.id));
    return true;
  });
}

export async function withAsyncToolEffectFence<T>(input: {
  ownerId: string;
  runId: string;
  invocationId: string;
  operation: () => Promise<T>;
}): Promise<T> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const pair = await invocationWithResult(tx, current.id, input.invocationId);
    if (
      current.status !== AgentRunStatus.WaitingAsyncTool
      || pair.invocation.executionDomain !== AgentToolExecutionDomain.Async
      || !pair.invocation.startedAt
      || pair.result
    ) {
      await persistDiagnostic({
        runId: current.id,
        attempt: pair.invocation.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.LateToolResultDropped,
        detail: "Async provider/storage effect was rejected after cancellation or closure.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.LateResult,
        "Async invocation is no longer authorized to start another effect.",
      );
    }
    return input.operation();
  });
}

/**
 * Starts the external Promise while the run lock is held, but does not keep the
 * database transaction open while waiting for the remote provider. Returning a
 * wrapper prevents the transaction helper from awaiting/flattening the Promise.
 */
export async function startAsyncToolEffect<T>(input: {
  ownerId: string;
  runId: string;
  invocationId: string;
  start: () => Promise<T>;
}): Promise<{ result: Promise<T> }> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    const pair = await invocationWithResult(tx, current.id, input.invocationId);
    if (
      current.status !== AgentRunStatus.WaitingAsyncTool
      || pair.invocation.executionDomain !== AgentToolExecutionDomain.Async
      || !pair.invocation.startedAt
      || pair.result
    ) {
      await persistDiagnostic({
        runId: current.id,
        attempt: pair.invocation.attempt,
        invocationId: pair.invocation.id,
        code: AgentRunDiagnosticCode.LateToolResultDropped,
        detail: "Async provider effect was rejected after cancellation or closure.",
      });
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.LateResult,
        "Async invocation is no longer authorized to start a provider effect.",
      );
    }
    const result = input.start();
    void result.catch(() => undefined);
    return { result };
  });
}

export async function markServerToolInvocationStarted(input: {
  ownerId: string;
  runId: string;
  invocationId: string;
  attempt: number;
  leaseId: string;
  writer?: AgentRunTransaction;
}): Promise<AgentRunInvocation> {
  const execute = async (tx: AgentRunTransaction): Promise<AgentRunInvocation> => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    assertLease(current, input.attempt, input.leaseId, new Date());
    const pair = await invocationWithResult(tx, current.id, input.invocationId);
    if (pair.invocation.executionDomain !== AgentToolExecutionDomain.Server) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Invocation is not assigned to the server execution domain.",
      );
    }
    if (pair.result) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Invocation already has a terminal result.",
      );
    }
    const [row] = pair.invocation.startedAt
      ? [pair.invocation]
      : await tx
          .update(agentToolInvocations)
          .set({ startedAt: new Date() })
          .where(eq(agentToolInvocations.id, pair.invocation.id))
          .returning();
    return toInvocation(row);
  };
  return input.writer ? execute(input.writer) : db.transaction(execute);
}

export async function markAsyncToolInvocationStarted(input: {
  ownerId: string;
  runId: string;
  invocationId: string;
  attempt: number;
  leaseId: string;
  writer?: AgentRunTransaction;
}): Promise<AgentRunInvocation> {
  const execute = async (tx: AgentRunTransaction): Promise<AgentRunInvocation> => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    assertLease(current, input.attempt, input.leaseId, new Date());
    const pair = await invocationWithResult(tx, current.id, input.invocationId);
    if (pair.invocation.executionDomain !== AgentToolExecutionDomain.Async) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Invocation is not assigned to the async execution domain.",
      );
    }
    if (pair.result) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Invocation already has a terminal result.",
      );
    }
    const [row] = pair.invocation.startedAt
      ? [pair.invocation]
      : await tx
          .update(agentToolInvocations)
          .set({ startedAt: new Date() })
          .where(eq(agentToolInvocations.id, pair.invocation.id))
          .returning();
    return toInvocation(row);
  };
  return input.writer ? execute(input.writer) : db.transaction(execute);
}

export async function recordServerToolResult(input: {
  ownerId: string;
  runId: string;
  invocationId: string;
  attempt: number;
  leaseId: string;
  kind: AgentToolResultKindValue;
  content: string;
  writer?: AgentRunTransaction;
}): Promise<void> {
  const execute = async (tx: AgentRunTransaction): Promise<void> => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    assertLease(current, input.attempt, input.leaseId, new Date());
    const pair = await invocationWithResult(tx, current.id, input.invocationId);
    if (pair.result) {
      if (pair.result.content === input.content && pair.result.kind === input.kind) return;
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Server invocation already has a different terminal result.",
      );
    }
    if (!pair.invocation.startedAt) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Server invocation result arrived before execution started.",
      );
    }
    await lockConversation(tx, current.conversationId);
    await appendInvocationResult(
      tx,
      current,
      pair.invocation,
      input.kind,
      input.content,
    );
  };
  await (input.writer ? execute(input.writer) : db.transaction(execute));
}

export async function recordRejectedToolResult(input: {
  ownerId: string;
  runId: string;
  invocationId: string;
  attempt: number;
  leaseId: string;
  content: string;
  writer?: AgentRunTransaction;
}): Promise<void> {
  const execute = async (tx: AgentRunTransaction): Promise<void> => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    assertLease(current, input.attempt, input.leaseId, new Date());
    const pair = await invocationWithResult(tx, current.id, input.invocationId);
    if (pair.result) {
      if (
        pair.result.kind === AgentToolResultKind.Error
        && pair.result.content === input.content
      ) return;
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvocationConflict,
        "Rejected invocation already has a different terminal result.",
      );
    }
    await lockConversation(tx, current.conversationId);
    await appendInvocationResult(
      tx,
      current,
      pair.invocation,
      AgentToolResultKind.Error,
      input.content,
    );
  };
  await (input.writer ? execute(input.writer) : db.transaction(execute));
}

export async function runInAgentRunTransaction<T>(
  operation: (tx: AgentRunTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(operation);
}

export async function releaseAgentRunLease(input: {
  ownerId: string;
  runId: string;
  attempt: number;
  leaseId: string;
}): Promise<AgentRunSnapshot> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    if (
      current.status !== AgentRunStatus.Running
      || current.attempt !== input.attempt
      || current.leaseId !== input.leaseId
    ) {
      return toSnapshot(current);
    }
    return toSnapshot(await reconcileRecoverableRun(tx, current));
  });
}

export async function failAgentRun(input: {
  ownerId: string;
  runId: string;
  attempt: number;
  leaseId: string;
  code: AgentRunFailureCodeValue;
  message: string;
}): Promise<AgentRunSnapshot> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    assertLease(current, input.attempt, input.leaseId, new Date());
    return toSnapshot(await transitionFromLease(
      tx,
      current,
      AgentRunStatus.Failed,
      new Date(),
      { code: input.code, message: input.message },
    ));
  });
}

async function unclosedInvocations(
  tx: AgentRunTransaction,
  runId: string,
): Promise<AgentToolInvocationRow[]> {
  const rows = await tx
    .select({ invocation: agentToolInvocations })
    .from(agentToolInvocations)
    .leftJoin(
      agentToolResults,
      eq(agentToolResults.invocationId, agentToolInvocations.id),
    )
    .where(and(
      eq(agentToolInvocations.agentRunId, runId),
      isNull(agentToolResults.id),
    ))
    .orderBy(
      asc(agentToolInvocations.modelRound),
      asc(agentToolInvocations.callIndex),
    );
  return rows.map(({ invocation }) => invocation);
}

function interruptedToolContent(message: string): string {
  return JSON.stringify({
    status: "error",
    type: ToolResultType.ToolInterrupted,
    message,
  });
}

async function closeUnfinishedInvocations(
  tx: AgentRunTransaction,
  current: AgentRunRow,
  invocations: readonly AgentToolInvocationRow[],
  message: string,
): Promise<void> {
  if (invocations.length === 0) return;
  await lockConversation(tx, current.conversationId);
  const content = interruptedToolContent(message);
  for (const invocation of invocations) {
    await appendInvocationResult(
      tx,
      current,
      invocation,
      AgentToolResultKind.Interrupted,
      content,
    );
  }
}

async function cancelAgentRunInTransaction(
  tx: AgentRunTransaction,
  current: AgentRunRow,
  cancelRequestedAt = new Date(),
): Promise<AgentRunSnapshot> {
  if (agentRunIsTerminal(current.status)) return toSnapshot(current);
  assertTransition(current.id, current.status, AgentRunStatus.Cancelled);

  const now = new Date();
  const unfinished = await unclosedInvocations(tx, current.id);
  for (const invocation of unfinished) {
    if (invocation.startedAt && invocation.effect === AgentToolEffect.Mutation) {
      await insertDiagnostic(tx, {
        runId: current.id,
        attempt: current.attempt,
        invocationId: invocation.id,
        code: AgentRunDiagnosticCode.MutationResultUncertain,
        detail: "Run was stopped after a mutation invocation had started.",
      });
    }
  }
  await closeUnfinishedInvocations(
    tx,
    current,
    unfinished,
    "Agent run was stopped by the user.",
  );

  const imageError = {
    code: ImageJobErrorCode.AgentRunCancelled,
    message: "Parent AgentRun was cancelled.",
  };
  const cancelledImageRuns = await tx
    .update(imageRuns)
    .set({
      status: ImageRunStatus.Cancelled,
      error: imageError,
      updatedAt: now,
      completedAt: now,
    })
    .where(and(
      eq(imageRuns.agentRunId, current.id),
      inArray(imageRuns.status, [ImageRunStatus.Pending, ImageRunStatus.Running]),
      isNull(imageRuns.deletedAt),
    ))
    .returning({ id: imageRuns.id });
  if (cancelledImageRuns.length) {
    await tx
      .update(imageJobs)
      .set({
        status: ImageJobStatus.Cancelled,
        error: imageError,
        updatedAt: now,
        completedAt: now,
      })
      .where(and(
        inArray(imageJobs.runId, cancelledImageRuns.map(({ id }) => id)),
        inArray(imageJobs.status, [ImageJobStatus.Pending, ImageJobStatus.Running]),
        isNull(imageJobs.deletedAt),
      ));
  }

  const [row] = await tx
    .update(agentRuns)
    .set({
      status: AgentRunStatus.Cancelled,
      leaseId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      cancelRequestedAt,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(agentRuns.id, current.id))
    .returning();
  return toSnapshot(row);
}

export async function cancelAgentRun(
  ownerId: string,
  runId: string,
): Promise<AgentRunSnapshot> {
  return db.transaction(async (tx) => {
    await lockRun(tx, runId);
    const current = await ownedRunRow(tx, runId, ownerId);
    return cancelAgentRunInTransaction(tx, current);
  });
}

export async function requestAgentRunStop(input: {
  ownerId: string;
  requestId: string;
}): Promise<AgentRunRequestStopResponse> {
  return db.transaction(async (tx) => {
    await lockRequest(tx, input.ownerId, input.requestId);
    await tx
      .insert(agentRunStopIntents)
      .values({
        ownerId: input.ownerId,
        requestId: input.requestId,
      })
      .onConflictDoNothing({
        target: [
          agentRunStopIntents.ownerId,
          agentRunStopIntents.requestId,
        ],
      });

    const [intent] = await tx
      .select()
      .from(agentRunStopIntents)
      .where(and(
        eq(agentRunStopIntents.ownerId, input.ownerId),
        eq(agentRunStopIntents.requestId, input.requestId),
      ))
      .limit(1);
    if (!intent) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.Conflict,
        `Stop intent was not persisted for request ${input.requestId}.`,
      );
    }

    const [existing] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(
        eq(agentRuns.ownerId, input.ownerId),
        eq(agentRuns.requestId, input.requestId),
      ))
      .limit(1);
    if (!existing) {
      if (intent.agentRunId !== null || intent.consumedAt !== null) {
        throw new AgentRunServiceError(
          AgentRunServiceErrorCode.Conflict,
          `Stop intent for request ${input.requestId} has no matching AgentRun.`,
        );
      }
      return AgentRunRequestStopResponseSchema.parse({
        outcome: AgentRunRequestStopOutcome.PendingRun,
        requestId: intent.requestId,
        requestedAt: toIso(intent.requestedAt),
      });
    }

    await lockRun(tx, existing.id);
    const current = await ownedRunRow(tx, existing.id, input.ownerId);
    const run = await cancelAgentRunInTransaction(
      tx,
      current,
      intent.requestedAt,
    );
    if (intent.agentRunId !== null && intent.agentRunId !== existing.id) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.Conflict,
        `Stop intent for request ${input.requestId} belongs to another AgentRun.`,
      );
    }
    if (
      (intent.agentRunId === null) !== (intent.consumedAt === null)
    ) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.Conflict,
        `Stop intent for request ${input.requestId} has a partial consumption record.`,
      );
    }
    const consumedAt = intent.consumedAt ?? new Date();
    if (intent.agentRunId !== existing.id || intent.consumedAt === null) {
      await tx
        .update(agentRunStopIntents)
        .set({
          agentRunId: existing.id,
          consumedAt,
        })
        .where(eq(agentRunStopIntents.id, intent.id));
    }
    return AgentRunRequestStopResponseSchema.parse({
      outcome: AgentRunRequestStopOutcome.RunTerminal,
      requestId: intent.requestId,
      requestedAt: toIso(intent.requestedAt),
      run,
    });
  });
}

export async function completeAgentRun(
  ownerId: string,
  runId: string,
): Promise<AgentRunSnapshot> {
  return db.transaction(async (tx) => {
    await lockRun(tx, runId);
    const current = await ownedRunRow(tx, runId, ownerId);
    if (agentRunIsTerminal(current.status)) return toSnapshot(current);
    if (current.status !== AgentRunStatus.WaitingFeedback) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvalidTransition,
        `Run ${runId} cannot complete from ${current.status}.`,
      );
    }
    assertTransition(current.id, current.status, AgentRunStatus.Completed);
    const now = new Date();
    const [row] = await tx
      .update(agentRuns)
      .set({
        status: AgentRunStatus.Completed,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(agentRuns.id, current.id))
      .returning();
    return toSnapshot(row);
  });
}

async function reconcileRecoverableRun(
  tx: AgentRunTransaction,
  current: AgentRunRow,
): Promise<AgentRunRow> {
  const unfinished = await unclosedInvocations(tx, current.id);
  const uncertain = unfinished.find(
    (invocation) =>
      invocation.startedAt !== null
      && invocation.effect === AgentToolEffect.Mutation,
  );
  const now = new Date();
  if (uncertain) {
    await insertDiagnostic(tx, {
      runId: current.id,
      attempt: current.attempt,
      invocationId: uncertain.id,
      code: AgentRunDiagnosticCode.MutationResultUncertain,
      detail: "Recovery cannot prove whether the started mutation committed.",
    });
    const [blocked] = await tx
      .update(agentRuns)
      .set({
        status: AgentRunStatus.Blocked,
        leaseId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        failureCode: AgentRunFailureCode.ClientResultUncertain,
        failureMessage: "A mutation started without a durable terminal receipt.",
        updatedAt: now,
      })
      .where(eq(agentRuns.id, current.id))
      .returning();
    return blocked;
  }

  await closeUnfinishedInvocations(
    tx,
    current,
    unfinished,
    "Previous execution ended before returning a durable tool result.",
  );
  const [recoverable] = await tx
    .update(agentRuns)
    .set({
      status: AgentRunStatus.WaitingResume,
      leaseId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: now,
    })
    .where(eq(agentRuns.id, current.id))
    .returning();
  return recoverable;
}

export async function restoreLatestAgentRun(
  ownerId: string,
  conversationId: string,
): Promise<AgentRunSnapshot | null> {
  const [latest] = await db
    .select()
    .from(agentRuns)
    .where(and(
      eq(agentRuns.ownerId, ownerId),
      eq(agentRuns.conversationId, conversationId),
    ))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return latest ? toSnapshot(latest) : null;
}

export async function recoverAgentRun(input: {
  ownerId: string;
  runId: string;
  expectedAttempt: number;
}): Promise<AgentRunSnapshot> {
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const current = await ownedRunRow(tx, input.runId, input.ownerId);
    if (current.attempt !== input.expectedAttempt) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.AttemptMismatch,
        `Run is attempt ${current.attempt}; received ${input.expectedAttempt}.`,
      );
    }
    if (
      agentRunIsTerminal(current.status)
      || current.status === AgentRunStatus.WaitingResume
      || current.status === AgentRunStatus.Blocked
    ) {
      return toSnapshot(current);
    }
    if (
      current.status !== AgentRunStatus.WaitingClientTool
      && current.status !== AgentRunStatus.Running
    ) {
      throw new AgentRunServiceError(
        AgentRunServiceErrorCode.InvalidTransition,
        `Run ${current.id} cannot recover from ${current.status}.`,
      );
    }
    return toSnapshot(await reconcileRecoverableRun(tx, current));
  });
}

export async function assertNoOpenAgentRunForProject(
  ownerId: string,
  projectId: string,
): Promise<void> {
  const [open] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.ownerId, ownerId),
      eq(agentRuns.projectId, projectId),
      notInArray(agentRuns.status, [...TERMINAL_RUN_STATUSES]),
    ))
    .limit(1);
  if (open) {
    throw new AgentRunServiceError(
      AgentRunServiceErrorCode.OpenRunExists,
      `Project has active run ${open.id}.`,
    );
  }
}
