/**
 * [INPUT]: dev-only multipart form { slug, filesHash, buildLog, artifactFile:* }
 * [OUTPUT]: persisted showcase artifact metadata
 * [POS]: A 域案例 artifact 上传入口 —— 接收浏览器 WebContainer 生成的 dist 产物并存储
 * [PROTOCOL]: 只允许 development；严格 schema；服务端只存储，不执行生成代码。
 */
import { parseShowcaseArtifactFormData, saveShowcaseArtifact } from "@/server/showcaseArtifacts";
import { SaveShowcaseArtifactSchema } from "@/types/showcaseArtifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    return errorResponse("Showcase artifact upload is only available in development.", 404);
  }

  try {
    const { fields, files } = await parseShowcaseArtifactFormData(await req.formData());
    const parsed = SaveShowcaseArtifactSchema.safeParse(fields);
    if (!parsed.success) {
      return errorResponse(parsed.error.message, 400);
    }
    return Response.json(await saveShowcaseArtifact({ ...parsed.data, files }), { status: 201 });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error), 400);
  }
}
