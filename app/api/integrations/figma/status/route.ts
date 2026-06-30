/**
 * [INPUT]: x-owner-id header; optional POST body { action: "disconnect" }
 * [OUTPUT]: Current Figma connection status for the owner, or 204 after disconnect
 * [POS]: A 域 Figma 连接状态接口 —— 前端卡片只读这里的当前授权状态
 * [PROTOCOL]: 只支持 GET/POST；未知 action 直接 400，不做默认动作
 */
import { z } from "zod";
import { disconnectFigma, getFigmaConnectionStatus, parseOwnerId } from "@/server/figma/oauth";

const FigmaStatusAction = {
  Disconnect: "disconnect",
} as const;

const StatusPostBodySchema = z.object({
  action: z.literal(FigmaStatusAction.Disconnect),
}).strict();

function ownerFrom(req: Request): string | Response {
  try {
    return parseOwnerId(req.headers.get("x-owner-id"));
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
}

export async function GET(req: Request) {
  const ownerId = ownerFrom(req);
  if (ownerId instanceof Response) return ownerId;

  try {
    return Response.json(await getFigmaConnectionStatus(ownerId));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const ownerId = ownerFrom(req);
  if (ownerId instanceof Response) return ownerId;

  let body: z.infer<typeof StatusPostBodySchema>;
  try {
    body = StatusPostBodySchema.parse(await req.json());
  } catch (error) {
    return Response.json({ error: "bad request", detail: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }

  if (body.action === FigmaStatusAction.Disconnect) {
    await disconnectFigma(ownerId);
    return new Response(null, { status: 204 });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
