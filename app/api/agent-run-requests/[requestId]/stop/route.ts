/**
 * [INPUT]: owner header, AgentRun request UUID path, and strict empty stop body
 * [OUTPUT]: Strict durable stop receipt for either a pending request or terminal AgentRun
 * [POS]: A-domain request-identity cancellation action used before SSE reveals the AgentRun id
 * [PROTOCOL]: The request advisory lock serializes this intent with AgentRun creation; unknown body fields fail closed
 */
import { z } from "zod";
import {
  AgentRunServiceError,
  AgentRunServiceErrorCode,
  requestAgentRunStop,
} from "@/server/agentRuns";
import { ownerIdFrom } from "@/server/owner";
import {
  AgentRunRequestIdSchema,
  AgentRunRequestStopBodySchema,
  AgentRunRequestStopResponseSchema,
} from "@/types/agentRun";

type Ctx = { params: Promise<{ requestId: string }> };

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
  console.error("Failed to persist AgentRun request stop", error);
  return Response.json({ error: "internal error" }, { status: 500 });
}

export async function POST(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  try {
    const requestId = AgentRunRequestIdSchema.parse(
      (await ctx.params).requestId,
    );
    AgentRunRequestStopBodySchema.parse(await req.json().catch(() => null));
    const response = await requestAgentRunStop({ ownerId, requestId });
    return Response.json(AgentRunRequestStopResponseSchema.parse(response));
  } catch (error) {
    return errorResponse(error);
  }
}
