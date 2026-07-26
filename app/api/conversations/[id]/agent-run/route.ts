/**
 * [INPUT]: owner header and conversation UUID path
 * [OUTPUT]: Strict {run: AgentRunSnapshot | null} restore response
 * [POS]: A-domain AgentRun refresh/reconnect snapshot query
 * [PROTOCOL]: GET is read-only; state reconciliation requires the explicit exact-attempt recover action
 */
import { z } from "zod";
import {
  AgentRunServiceError,
  AgentRunServiceErrorCode,
  restoreLatestAgentRun,
} from "@/server/agentRuns";
import { ownsConversation } from "@/server/guard";
import { ownerIdFrom } from "@/server/owner";
import { AgentRunRestoreResponseSchema } from "@/types/agentRun";

type Ctx = { params: Promise<{ id: string }> };

const ConversationIdSchema = z.string().uuid();

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
  console.error("Failed to restore AgentRun", error);
  return Response.json({ error: "internal error" }, { status: 500 });
}

export async function GET(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  try {
    const conversationId = ConversationIdSchema.parse((await ctx.params).id);
    if (!await ownsConversation(conversationId, ownerId)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const run = await restoreLatestAgentRun(ownerId, conversationId);
    return Response.json(AgentRunRestoreResponseSchema.parse({ run }));
  } catch (error) {
    return errorResponse(error);
  }
}
