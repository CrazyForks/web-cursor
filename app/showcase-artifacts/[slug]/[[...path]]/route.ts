/**
 * [INPUT]: public GET /showcase-artifacts/:slug[/path]
 * [OUTPUT]: latest ready showcase artifact file proxied from private Blob storage
 * [POS]: A 域案例静态产物托管入口 —— 用 Next Route Handler 为 iframe 提供真实 URL
 * [PROTOCOL]: 只读；只返回已发布且未撤销案例的 ready artifact 文件；path 必须存在于 artifact manifest。
 */
import { getLatestReadyShowcaseArtifactFile } from "@/server/showcaseArtifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; path?: string[] }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { slug, path } = await ctx.params;
  const artifactFile = await getLatestReadyShowcaseArtifactFile(slug, path?.join("/") ?? "");
  if (!artifactFile) return new Response("Not found", { status: 404 });

  return new Response(artifactFile.stream, {
    headers: {
      "Content-Type": artifactFile.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
