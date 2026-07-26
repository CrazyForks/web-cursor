/**
 * [INPUT]: owner header, AgentRun UUID path, and strict empty stop body
 * [OUTPUT]: Persisted cancelled AgentRun snapshot
 * [POS]: A-domain AgentRun durable cancellation-fence HTTP action
 * [PROTOCOL]: Owner/run identity and body fail closed; service transition errors preserve their exact code
 */
import { z } from "zod";
import {
  AgentRunServiceError,
  AgentRunServiceErrorCode,
  cancelAgentRun,
} from "@/server/agentRuns";
import { ownerIdFrom } from "@/server/owner";
import {
  AgentRunIdSchema,
  AgentRunStopBodySchema,
} from "@/types/agentRun";

type Ctx = { params: Promise<{ id: string }> };

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
  console.error("Failed to stop AgentRun", error);
  return Response.json({ error: "internal error" }, { status: 500 });
}

export async function POST(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  try {
    const runId = AgentRunIdSchema.parse((await ctx.params).id);
    AgentRunStopBodySchema.parse(await req.json().catch(() => null));
    return Response.json(await cancelAgentRun(ownerId, runId));
  } catch (error) {
    return errorResponse(error);
  }
}
