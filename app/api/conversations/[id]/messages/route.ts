/**
 * [INPUT]: 会话 id（URL）
 * [OUTPUT]: 该会话的 messages 数组（按 seq 升序，排除软删）
 * [POS]: A 域回放接口 —— 前端刷新后恢复整段对话用
 * [PROTOCOL]: 经 ownsConversation 反查归属（会话→项目→owner），不是你的返 404
 */
import { listMessages } from "@/server/messages";
import { ownsConversation } from "@/server/guard";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const ownerId = req.headers.get("x-owner-id");
  if (!ownerId) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  if (!(await ownsConversation(id, ownerId))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json(await listMessages(id));
}
