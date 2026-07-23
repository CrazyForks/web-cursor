/**
 * [INPUT]: project id + single-line literal query + x-owner-id
 * [OUTPUT]: revisioned project text-search result
 * [POS]: A 域 Database repository REST API —— ProjectRepository.searchText 接缝
 * [PROTOCOL]: 只允许 owned database_v1 project；query 规则由 server/files.ts 权威校验
 */
import { ownsProject } from "@/server/guard";
import {
  FileOperationError,
  FileOperationErrorCode,
  searchProjectFiles,
} from "@/server/files";
import { ownerIdFrom } from "@/server/owner";

type Ctx = { params: Promise<{ id: string }> };

function searchError(error: unknown) {
  if (error instanceof FileOperationError) {
    const status = error.code === FileOperationErrorCode.NotFound
      ? 404
      : error.code === FileOperationErrorCode.StorageMismatch
        ? 409
        : 400;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

export async function GET(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });

  const { id } = await ctx.params;
  if (!(await ownsProject(id, ownerId))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const query = new URL(req.url).searchParams.get("query") ?? "";
  try {
    return Response.json(await searchProjectFiles(id, query));
  } catch (error) {
    return searchError(error);
  }
}
