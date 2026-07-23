/**
 * [INPUT]: conversation id + project/tool/tool_call_id + browser-side strict execution result
 * [OUTPUT]: 204 after appending one role=tool message
 * [POS]: A 域 tool-call 闭合接口 —— 只记录沙箱/转译结果，不触发 LLM
 * [PROTOCOL]: transaction advisory lock 串行化同会话回传；只接受最新 assistant round 的下一个精确 call。
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { conversations, messages, projects } from "@/server/db/schema";
import { appendMessage } from "@/server/messages";
import { ownerIdFrom } from "@/server/owner";
import { ClientToolResultSubmissionSchema, clientToolRunsInBrowser } from "@/types/clientTool";
import { ProjectStorageKindSchema } from "@/types/projectStorage";
import { findNextPendingToolCall } from "@/lib/pendingToolCall";

class ToolResultConflict extends Error {}

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  const { id } = await ctx.params;
  const parsed = ClientToolResultSubmissionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "bad request", detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);

      const [owned] = await tx
        .select({ projectId: conversations.projectId, storageKind: projects.storageKind })
        .from(conversations)
        .innerJoin(projects, eq(conversations.projectId, projects.id))
        .where(and(
          eq(conversations.id, id),
          isNull(conversations.deletedAt),
          eq(projects.ownerId, ownerId),
          isNull(projects.deletedAt),
        ))
        .limit(1);
      if (!owned) return "not_found" as const;
      if (owned.projectId !== parsed.data.projectId) {
        throw new ToolResultConflict("projectId does not match the conversation project.");
      }

      const storageKind = ProjectStorageKindSchema.parse(owned.storageKind);
      if (!clientToolRunsInBrowser(parsed.data.tool, storageKind)) {
        throw new ToolResultConflict("tool is not client-executed for this project storage kind.");
      }

      const rows = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, id), isNull(messages.deletedAt)))
        .orderBy(asc(messages.seq));
      const pending = findNextPendingToolCall(rows);
      if (!pending) {
        throw new ToolResultConflict("no pending client tool call; result is duplicate or late.");
      }
      if (pending.id !== parsed.data.toolCallId || pending.name !== parsed.data.tool) {
        throw new ToolResultConflict(
          `expected ${pending.name}/${pending.id}; received ${parsed.data.tool}/${parsed.data.toolCallId}.`,
        );
      }

      await appendMessage(id, {
        role: "tool",
        content: JSON.stringify(parsed.data.result),
        meta: { toolCallId: parsed.data.toolCallId },
      }, tx);
      return "appended" as const;
    });
    if (outcome === "not_found") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof ToolResultConflict) {
      return Response.json({ error: "tool result conflict", detail: e.message }, { status: 409 });
    }
    console.error("Failed to append client tool result", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
