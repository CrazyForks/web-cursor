/**
 * [INPUT]: owner header, AgentRun UUID path, and strict expected attempt
 * [OUTPUT]: Recovered waiting_resume/blocked/terminal AgentRun snapshot
 * [POS]: A-domain explicit client-boundary takeover action used after refresh
 * [PROTOCOL]: GET restore stays read-only; only the exact attempt may reconcile unfinished client invocations
 */
import { z } from "zod";
import {
  AgentRunServiceError,
  AgentRunServiceErrorCode,
  recoverAgentRun,
} from "@/server/agentRuns";
import { ownerIdFrom } from "@/server/owner";
import {
  AgentRunIdSchema,
  AgentRunRecoverBodySchema,
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
      : 409;
    return Response.json(
      { error: error.message, code: error.code },
      { status },
    );
  }
  console.error("Failed to recover AgentRun", error);
  return Response.json({ error: "internal error" }, { status: 500 });
}

export async function POST(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  try {
    const runId = AgentRunIdSchema.parse((await ctx.params).id);
    const body = AgentRunRecoverBodySchema.parse(
      await req.json().catch(() => null),
    );
    return Response.json(await recoverAgentRun({
      ownerId,
      runId,
      expectedAttempt: body.attempt,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
