/**
 * [INPUT]: owner header, AgentRun/invocation UUID paths, and strict client tool-result submission
 * [OUTPUT]: 204 after exact or idempotently duplicate terminal result persistence
 * [POS]: A-domain durable client-tool result closure action
 * [PROTOCOL]: Body/path identities must match byte-for-byte; result bytes are persisted without field repair
 */
import { z } from "zod";
import {
  AgentRunServiceError,
  AgentRunServiceErrorCode,
  recordClientToolResult,
} from "@/server/agentRuns";
import { ownerIdFrom } from "@/server/owner";
import {
  AgentRunIdSchema,
  AgentToolResultKind,
} from "@/types/agentRun";
import { ClientToolResultSubmissionSchema } from "@/types/clientTool";

type Ctx = {
  params: Promise<{
    id: string;
    invocationId: string;
  }>;
};

const InvocationIdSchema = z.string().uuid();

const ClientToolResultStatus = {
  Ok: "ok",
  Error: "error",
} as const;

const ClientToolResultStatusSchema = z.enum(ClientToolResultStatus);

function clientToolResultStatus(result: unknown) {
  if (
    typeof result !== "object"
    || result === null
    || !Object.prototype.hasOwnProperty.call(result, "status")
  ) {
    throw new TypeError(
      "Strict client tool result is missing its status discriminator.",
    );
  }
  return ClientToolResultStatusSchema.parse(
    Reflect.get(result, "status"),
  );
}

function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "bad request", detail: error.flatten() },
      { status: 400 },
    );
  }
  if (error instanceof AgentRunServiceError) {
    const status = error.code === AgentRunServiceErrorCode.NotFound
      ? 404
      : error.code === AgentRunServiceErrorCode.Conflict
        || error.code === AgentRunServiceErrorCode.OpenRunExists
        || error.code === AgentRunServiceErrorCode.InvalidTransition
        || error.code === AgentRunServiceErrorCode.AttemptMismatch
        || error.code === AgentRunServiceErrorCode.LeaseLost
        || error.code === AgentRunServiceErrorCode.RepositoryMismatch
        || error.code === AgentRunServiceErrorCode.InvocationConflict
        || error.code === AgentRunServiceErrorCode.LateResult
        || error.code === AgentRunServiceErrorCode.BudgetExceeded
        ? 409
        : 500;
    return Response.json(
      { error: error.message, code: error.code },
      { status },
    );
  }
  console.error("Failed to record client tool result", error);
  return Response.json({ error: "internal error" }, { status: 500 });
}

export async function POST(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  try {
    const params = await ctx.params;
    const runId = AgentRunIdSchema.parse(params.id);
    const invocationId = InvocationIdSchema.parse(params.invocationId);
    const body = ClientToolResultSubmissionSchema.parse(
      await req.json().catch(() => null),
    );
    const resultStatus = clientToolResultStatus(body.result);
    if (
      body.agentRunId !== runId
      || body.invocationId !== invocationId
    ) {
      return Response.json(
        { error: "body AgentRun/invocation identity does not match path" },
        { status: 409 },
      );
    }

    await recordClientToolResult({
      ownerId,
      runId,
      projectId: body.projectId,
      invocationId,
      attempt: body.attempt,
      providerCallId: body.toolCallId,
      toolName: body.tool,
      content: JSON.stringify(body.result),
      kind: resultStatus === ClientToolResultStatus.Ok
        ? AgentToolResultKind.Success
        : AgentToolResultKind.Error,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
