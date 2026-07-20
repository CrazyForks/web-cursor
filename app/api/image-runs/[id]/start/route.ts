/**
 * [INPUT]: owner-scoped image run id
 * [OUTPUT]: 204 after scheduling one server-owned worker
 * [POS]: A 域生图 worker 启动入口 —— 浏览器只触发一次，服务端在响应结束后轮询 provider
 * [PROTOCOL]: 只使用 POST；owner/runId 必须精确匹配；后台执行受 Route Handler maxDuration 约束。
 */
import { after } from "next/server";
import { z } from "zod";
import { runImageRunWorker } from "@/server/image/runner";
import { ownerIdFrom } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const RunIdSchema = z.string().uuid();

export async function POST(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  const parsedRunId = RunIdSchema.safeParse((await ctx.params).id);
  if (!parsedRunId.success) {
    return Response.json({ error: "bad image run id" }, { status: 400 });
  }

  const runId = parsedRunId.data;
  const publicBaseUrl = new URL(req.url).origin;
  after(async () => {
    try {
      await runImageRunWorker(runId, ownerId, { publicBaseUrl });
    } catch (error) {
      console.error("[image-run-worker] stopped unexpectedly", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return new Response(null, { status: 204 });
}
