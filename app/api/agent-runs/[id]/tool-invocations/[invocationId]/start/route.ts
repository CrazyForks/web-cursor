/**
 * [INPUT]: owner header, AgentRun/invocation UUID paths, and strict {attempt} body
 * [OUTPUT]: 204 after the persisted client invocation start fence is recorded
 * [POS]: A-domain client-tool execution authorization action
 * [PROTOCOL]: Start is valid only for the exact owner/run/invocation/attempt boundary
 */
import { z } from "zod";
import {
  AgentRunServiceError,
  AgentRunServiceErrorCode,
  startClientToolInvocation,
} from "@/server/agentRuns";
import { ownerIdFrom } from "@/server/owner";
import {
  AgentRunIdSchema,
  AgentRunStartInvocationBodySchema,
} from "@/types/agentRun";

type Ctx = {
  params: Promise<{
    id: string;
    invocationId: string;
  }>;
};

const InvocationIdSchema = z.string().uuid();

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
  console.error("Failed to start client tool invocation", error);
  return Response.json({ error: "internal error" }, { status: 500 });
}

export async function POST(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  try {
    const params = await ctx.params;
    const runId = AgentRunIdSchema.parse(params.id);
    const invocationId = InvocationIdSchema.parse(params.invocationId);
    const body = AgentRunStartInvocationBodySchema.parse(
      await req.json().catch(() => null),
    );
    await startClientToolInvocation({
      ownerId,
      runId,
      invocationId,
      attempt: body.attempt,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
