/**
 * [INPUT]: GET 取项目详情；POST 保留既有改名 / 软删契约
 * [OUTPUT]: storage-discriminated project detail / 更新后的项目元数据
 * [POS]: A 域项目详情与既有 metadata update 入口；Browser Git 迁移使用独立 action route
 * [PROTOCOL]: 不从 Browser Git 项目回退读取 project_files；本文件不再新增其他 POST action 分支
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { conversations, projects } from "@/server/db/schema";
import { listProjectFiles } from "@/server/files";
import { ownerIdFrom } from "@/server/owner";
import { toConversationResponse, toProjectResponse } from "@/server/projectResponse";
import { ProjectStorageKind } from "@/types/projectStorage";

type Ctx = { params: Promise<{ id: string }> };

// 项目详情 + 会话线索 + 文件列表（文件内容按需另取）
export async function GET(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;

  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId), isNull(projects.deletedAt)))
    .limit(1);
  if (!project) return Response.json({ error: "not found" }, { status: 404 });

  const convs = await db.select().from(conversations)
    .where(and(eq(conversations.projectId, id), isNull(conversations.deletedAt)))
    .orderBy(asc(conversations.createdAt));

  const projectResponse = toProjectResponse(project);
  const conversationResponses = convs.map(toConversationResponse);
  if (projectResponse.storageKind === ProjectStorageKind.Database) {
    const files = await listProjectFiles(id);
    return Response.json({ ...projectResponse, conversations: conversationResponses, files });
  }

  return Response.json({ ...projectResponse, conversations: conversationResponses });
}

// 既有兼容契约：{ title } 改名；{ deleted: true } 软删。本次只迁出新增的 Browser Git migration action。
const UpdateSchema = z.object({
  title: z.string().min(1).optional(),
  deleted: z.boolean().optional(),
}).strict().refine(
  (body) => body.title !== undefined || body.deleted !== undefined,
  { message: "At least one of title/deleted must be provided." },
);

export async function POST(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;

  const parsed = UpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "bad request", detail: parsed.error.flatten() }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.deleted) patch.deletedAt = new Date();

  try {
    const [row] = await db.update(projects).set(patch)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId), isNull(projects.deletedAt)))
      .returning();
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(toProjectResponse(row));
  } catch (error) {
    console.error("Failed to update project", error);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
