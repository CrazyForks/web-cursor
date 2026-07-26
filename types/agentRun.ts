/**
 * [INPUT]: AgentRun API payloads and persisted run status values
 * [OUTPUT]: Strict Zod contracts, inferred types, and explicit lifecycle predicates
 * [POS]: Shared AgentRun protocol boundary used by A-domain persistence and B-domain restore UI
 * [PROTOCOL]: Unknown fields/statuses fail closed; snapshots never expose lease or full harness identity
 */
import { z } from "zod";
import { ProjectRepositoryDescriptorSchema } from "./projectRepository";

export const AgentRunStatus = {
  Running: "running",
  WaitingClientTool: "waiting_client_tool",
  WaitingAsyncTool: "waiting_async_tool",
  WaitingExternal: "waiting_external",
  WaitingResume: "waiting_resume",
  WaitingFeedback: "waiting_feedback",
  Blocked: "blocked",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;

export const AgentRunStatusSchema = z.enum(AgentRunStatus);
export type AgentRunStatus =
  typeof AgentRunStatus[keyof typeof AgentRunStatus];

export const AgentRunTrigger = {
  User: "user",
  PreviewFeedback: "preview_feedback",
} as const;

export const AgentRunTriggerSchema = z.enum(AgentRunTrigger);
export type AgentRunTrigger =
  typeof AgentRunTrigger[keyof typeof AgentRunTrigger];

export const AgentToolExecutionDomain = {
  Server: "server",
  Client: "client",
  Async: "async",
} as const;

export const AgentToolExecutionDomainSchema = z.enum(AgentToolExecutionDomain);
export type AgentToolExecutionDomain =
  typeof AgentToolExecutionDomain[keyof typeof AgentToolExecutionDomain];

export const AgentToolEffect = {
  Read: "read",
  Mutation: "mutation",
} as const;

export const AgentToolEffectSchema = z.enum(AgentToolEffect);
export type AgentToolEffect =
  typeof AgentToolEffect[keyof typeof AgentToolEffect];

export const AgentToolResultKind = {
  Success: "success",
  Error: "error",
  Interrupted: "interrupted",
} as const;

export const AgentToolResultKindSchema = z.enum(AgentToolResultKind);
export type AgentToolResultKind =
  typeof AgentToolResultKind[keyof typeof AgentToolResultKind];

export const AgentRunFailureCode = {
  ModelError: "MODEL_ERROR",
  ToolRoundLimit: "TOOL_ROUND_LIMIT",
  ProtocolError: "PROTOCOL_ERROR",
  LeaseLost: "LEASE_LOST",
  BudgetExhausted: "BUDGET_EXHAUSTED",
  ClientResultUncertain: "CLIENT_RESULT_UNCERTAIN",
  InternalError: "INTERNAL_ERROR",
} as const;

export const AgentRunFailureCodeSchema = z.enum(AgentRunFailureCode);
export type AgentRunFailureCode =
  typeof AgentRunFailureCode[keyof typeof AgentRunFailureCode];

export const AgentRunDiagnosticCode = {
  LateToolResultDropped: "LATE_TOOL_RESULT_DROPPED",
  ConflictingToolResult: "CONFLICTING_TOOL_RESULT",
  LeaseLost: "LEASE_LOST",
  MutationResultUncertain: "MUTATION_RESULT_UNCERTAIN",
} as const;

export const AgentRunDiagnosticCodeSchema = z.enum(AgentRunDiagnosticCode);
export type AgentRunDiagnosticCode =
  typeof AgentRunDiagnosticCode[keyof typeof AgentRunDiagnosticCode];

export const AgentRunIdSchema = z.string().uuid();
export type AgentRunId = z.infer<typeof AgentRunIdSchema>;

export const AgentRunRequestIdSchema = z.string().uuid();
export type AgentRunRequestId = z.infer<typeof AgentRunRequestIdSchema>;

export const AgentRunFailureSchema = z.object({
  code: AgentRunFailureCodeSchema,
  message: z.string(),
}).strict();

export type AgentRunFailure = z.infer<typeof AgentRunFailureSchema>;

export const AgentRunSnapshotSchema = z.object({
  id: AgentRunIdSchema,
  projectId: z.string().uuid(),
  conversationId: z.string().uuid(),
  requestId: AgentRunRequestIdSchema,
  trigger: AgentRunTriggerSchema,
  status: AgentRunStatusSchema,
  attempt: z.number().int().positive(),
  modelRounds: z.number().int().nonnegative(),
  toolRounds: z.number().int().nonnegative(),
  maxModelRounds: z.number().int().positive(),
  maxToolRounds: z.number().int().positive(),
  repository: ProjectRepositoryDescriptorSchema,
  failure: AgentRunFailureSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime(),
  cancelRequestedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
}).strict();

export type AgentRunSnapshot = z.infer<typeof AgentRunSnapshotSchema>;

export const AgentRunRestoreResponseSchema = z.object({
  run: AgentRunSnapshotSchema.nullable(),
}).strict();

export type AgentRunRestoreResponse =
  z.infer<typeof AgentRunRestoreResponseSchema>;

export const AgentRunStopBodySchema = z.object({}).strict();
export type AgentRunStopBody = z.infer<typeof AgentRunStopBodySchema>;

export const AgentRunRequestStopOutcome = {
  PendingRun: "pending_run",
  RunTerminal: "run_terminal",
} as const;

export const AgentRunRequestStopOutcomeSchema = z.enum(
  AgentRunRequestStopOutcome,
);
export type AgentRunRequestStopOutcome =
  typeof AgentRunRequestStopOutcome[keyof typeof AgentRunRequestStopOutcome];

export const AgentRunRequestStopBodySchema = z.object({}).strict();
export type AgentRunRequestStopBody =
  z.infer<typeof AgentRunRequestStopBodySchema>;

const AgentRunRequestStopReceiptShape = {
  requestId: AgentRunRequestIdSchema,
  requestedAt: z.string().datetime(),
};

export const AgentRunRequestStopResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      ...AgentRunRequestStopReceiptShape,
      outcome: z.literal(AgentRunRequestStopOutcome.PendingRun),
    }).strict(),
    z.object({
      ...AgentRunRequestStopReceiptShape,
      outcome: z.literal(AgentRunRequestStopOutcome.RunTerminal),
      run: AgentRunSnapshotSchema,
    }).strict(),
  ],
).superRefine((receipt, context) => {
  if (receipt.outcome !== AgentRunRequestStopOutcome.RunTerminal) return;
  if (receipt.run.requestId !== receipt.requestId) {
    context.addIssue({
      code: "custom",
      path: ["run", "requestId"],
      message: "run.requestId must match requestId",
    });
  }
  if (!agentRunIsTerminal(receipt.run.status)) {
    context.addIssue({
      code: "custom",
      path: ["run", "status"],
      message: "run must be terminal",
    });
  }
});

export type AgentRunRequestStopResponse =
  z.infer<typeof AgentRunRequestStopResponseSchema>;

export const AgentRunCompleteBodySchema = z.object({}).strict();
export type AgentRunCompleteBody = z.infer<typeof AgentRunCompleteBodySchema>;

export const AgentRunRecoverBodySchema = z.object({
  attempt: z.number().int().positive(),
}).strict();

export type AgentRunRecoverBody = z.infer<typeof AgentRunRecoverBodySchema>;

export const AgentRunStartInvocationBodySchema = z.object({
  attempt: z.number().int().positive(),
}).strict();

export type AgentRunStartInvocationBody =
  z.infer<typeof AgentRunStartInvocationBodySchema>;

const AgentRunTransitions = {
  [AgentRunStatus.Running]: [
    AgentRunStatus.WaitingClientTool,
    AgentRunStatus.WaitingAsyncTool,
    AgentRunStatus.WaitingExternal,
    AgentRunStatus.WaitingFeedback,
    AgentRunStatus.WaitingResume,
    AgentRunStatus.Completed,
    AgentRunStatus.Failed,
    AgentRunStatus.Cancelled,
    AgentRunStatus.Blocked,
  ],
  [AgentRunStatus.WaitingClientTool]: [
    AgentRunStatus.WaitingResume,
    AgentRunStatus.Cancelled,
    AgentRunStatus.Blocked,
  ],
  [AgentRunStatus.WaitingAsyncTool]: [
    AgentRunStatus.WaitingResume,
    AgentRunStatus.Failed,
    AgentRunStatus.Cancelled,
    AgentRunStatus.Blocked,
  ],
  [AgentRunStatus.WaitingExternal]: [
    AgentRunStatus.Running,
    AgentRunStatus.Cancelled,
    AgentRunStatus.Blocked,
  ],
  [AgentRunStatus.WaitingResume]: [
    AgentRunStatus.Running,
    AgentRunStatus.Cancelled,
    AgentRunStatus.Blocked,
  ],
  [AgentRunStatus.WaitingFeedback]: [
    AgentRunStatus.Running,
    AgentRunStatus.Completed,
    AgentRunStatus.Cancelled,
    AgentRunStatus.Blocked,
  ],
  [AgentRunStatus.Blocked]: [
    AgentRunStatus.Cancelled,
  ],
  [AgentRunStatus.Completed]: [],
  [AgentRunStatus.Failed]: [],
  [AgentRunStatus.Cancelled]: [],
} as const satisfies Record<AgentRunStatus, readonly AgentRunStatus[]>;

export function agentRunIsTerminal(status: AgentRunStatus): boolean {
  return status === AgentRunStatus.Completed
    || status === AgentRunStatus.Failed
    || status === AgentRunStatus.Cancelled;
}

export function agentRunIsOpen(status: AgentRunStatus): boolean {
  return !agentRunIsTerminal(status);
}

export function agentRunCanResume(status: AgentRunStatus): boolean {
  return status === AgentRunStatus.WaitingResume
    || status === AgentRunStatus.WaitingExternal;
}

export function agentRunNeedsClientCompletion(status: AgentRunStatus): boolean {
  return status === AgentRunStatus.WaitingFeedback;
}

/**
 * Returning true for identical states is an explicit idempotency decision.
 * Terminal states still have no transition to a different state.
 */
export function agentRunCanTransition(
  from: AgentRunStatus,
  to: AgentRunStatus,
): boolean {
  if (from === to) return true;
  return AgentRunTransitions[from].some((candidate) => candidate === to);
}
