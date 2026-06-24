/**
 * [INPUT]: kind=user 的用户消息，或 kind=resume 的已闭合 transcript 续写请求
 * [OUTPUT]: SSE(init/tools_call/code/chat/done/error)，并落库 assistant 全量回复
 * [POS]: A 域 LLM 代理 —— 持 key、读 DB transcript、流式转发 DeepSeek
 * [PROTOCOL]: tool result 不在这里落库；前端先调用 tool-results 闭合 tool_call，再用 resume 触发修复续写。
 */
import { z } from "zod";
import { parse, Allow } from "partial-json";
import { toLLMMessages } from "@/server/context";
import { db } from "@/server/db";
import { conversations, projects } from "@/server/db/schema";
import deepseekClient, { SYSTEM_PROMPT, TOOL_TYPE, tools } from "@/server/deepseek";
import { appendMessage, listMessages } from "@/server/messages";
import { ownsConversation, ownsProject } from "@/server/guard";
import { closeInterruptedToolCall } from "@/server/toolCalls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChatBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    message: z.string().min(1),
    projectId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.literal("resume"),
    conversationId: z.string().uuid(),
  }),
]);

type DbMessage = Awaited<ReturnType<typeof listMessages>>[number];

function sseResponse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

async function streamAssistant(
  conversationId: string,
  projectId: string | undefined,
  created: boolean,
  rows: DbMessage[],
) {
  const stream = await deepseekClient.chat.completions.create({
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...toLLMMessages(rows)],
    model: "deepseek-v4-pro",
    tools,
    stream: true,
  });
  const encoder = new TextEncoder();

  return sseResponse(new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
      };

      let name = "";
      let args = "";
      let finalCode = "";
      let sentCode = 0;
      let finalReply = "";
      let sentReply = 0;
      let text = "";
      let toolCallId = "";

      if (created) {
        send({ type: "init", conversationId, projectId });
      }

      try {
        for await (const chunk of stream) {
          const d = chunk.choices[0]?.delta;
          const tc = d?.tool_calls?.[0];

          if (tc?.id) {
            toolCallId = tc.id;
            send({
              type: "tools_call",
              index: tc.index ?? 0,
              id: tc.id,
              name: tc.function?.name ?? "",
            });
          }

          if (tc?.function?.name) name = tc.function.name;
          if (tc?.function?.arguments) {
            args += tc.function.arguments;
            if (name === TOOL_TYPE.WRITE_APP) {
              const code = parse(args, Allow.STR | Allow.OBJ)?.code ?? "";
              if (code.length > sentCode) {
                send({ type: "code", delta: code.slice(sentCode) });
                sentCode = code.length;
              }
              finalCode = code;
            } else if (name === TOOL_TYPE.REPLY) {
              const reply = parse(args, Allow.STR | Allow.OBJ)?.message ?? "";
              if (reply.length > sentReply) {
                send({ type: "chat", delta: reply.slice(sentReply) });
                sentReply = reply.length;
              }
              finalReply = reply;
            }
          }

          if (d?.content) {
            text += d.content;
            send({ type: "chat", delta: d.content });
          }
        }

        const content = finalCode || finalReply || text;
        if (content) {
          await appendMessage(conversationId, {
            role: "assistant",
            content,
            model: "deepseek-v4-pro",
            meta: {
              kind: finalCode ? "code" : "reply",
              ...(toolCallId ? {
                toolCalls: [{ id: toolCallId, name: name || TOOL_TYPE.WRITE_APP, arguments: args }],
              } : {}),
            },
          });
        }
        send({ type: "done" });
      } catch (e) {
        send({ type: "error", message: String(e) });
      } finally {
        controller.close();
      }
    },
  }));
}

export async function POST(req: Request) {
  const ownerId = req.headers.get("x-owner-id");
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  let body: z.infer<typeof ChatBodySchema>;
  try {
    body = ChatBodySchema.parse(await req.json());
  } catch (e) {
    return Response.json({ error: "bad request", detail: String(e) }, { status: 400 });
  }

  if (body.kind === "resume") {
    if (!(await ownsConversation(body.conversationId, ownerId))) {
      return new Response("Not Found", { status: 404 });
    }
    const rows = await listMessages(body.conversationId);
    return streamAssistant(body.conversationId, undefined, false, rows);
  }

  let { conversationId, projectId } = body;
  const created = !conversationId;

  if (conversationId) {
    if (!(await ownsConversation(conversationId, ownerId))) {
      return new Response("Not Found", { status: 404 });
    }
    let rows = await listMessages(conversationId);
    if (await closeInterruptedToolCall(conversationId, rows)) {
      rows = await listMessages(conversationId);
    }
  } else {
    if (projectId) {
      if (!(await ownsProject(projectId, ownerId))) {
        return new Response("Not Found", { status: 404 });
      }
    } else {
      const [project] = await db.insert(projects).values({ ownerId, title: "untitled" }).returning();
      projectId = project.id;
    }
    const [conversation] = await db.insert(conversations).values({ projectId, title: "untitled" }).returning();
    conversationId = conversation.id;
  }

  await appendMessage(conversationId, {
    role: "user",
    content: body.message,
  });

  const rows = await listMessages(conversationId);
  return streamAssistant(conversationId, projectId, created, rows);
}
