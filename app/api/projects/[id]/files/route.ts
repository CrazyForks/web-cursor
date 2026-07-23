/**
 * [INPUT]: project id + x-owner-id + optional includeContent=1
 * [OUTPUT]: 当前 project revision + live file summaries，或带 content 的完整文件列表
 * [POS]: A 域文件 REST API —— 前端文件树读取入口
 * [PROTOCOL]: 默认只返回文件列表；小项目工作台可用 includeContent=1 一次性拉全量内容
 */
import { ownsProject } from "@/server/guard";
import {
  FileOperationError,
  FileOperationErrorCode,
  listProjectFileContentsSnapshot,
  listProjectFilesSnapshot,
} from "@/server/files";
import { ownerIdFrom } from "@/server/owner";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  const { id } = await ctx.params;
  if (!(await ownsProject(id, ownerId))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const includeContent = new URL(req.url).searchParams.get("includeContent") === "1";
  try {
    return Response.json(includeContent
      ? await listProjectFileContentsSnapshot(id)
      : await listProjectFilesSnapshot(id));
  } catch (error) {
    if (error instanceof FileOperationError) {
      const status = error.code === FileOperationErrorCode.NotFound
        ? 404
        : error.code === FileOperationErrorCode.StorageMismatch
          ? 409
          : 500;
      return Response.json({ error: error.message, code: error.code }, { status });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
