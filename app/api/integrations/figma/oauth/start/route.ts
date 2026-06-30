/**
 * [INPUT]: ownerId query + optional returnTo query
 * [OUTPUT]: Redirect to Figma OAuth authorization URL
 * [POS]: A 域 Figma OAuth 起点 —— 生成 state/PKCE 并写入短 TTL oauth_states
 * [PROTOCOL]: 浏览器跳转带不上 x-owner-id；本匿名阶段 ownerId 由 query 显式传入并严格校验 UUID
 */
import {
  createFigmaOAuthStart,
  FigmaOAuthError,
  parseOwnerId,
  parseReturnTo,
} from "@/server/figma/oauth";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ownerId = parseOwnerId(url.searchParams.get("ownerId"));
    const returnTo = parseReturnTo(url.searchParams.get("returnTo"));
    const figmaUrl = await createFigmaOAuthStart(req, ownerId, returnTo);
    return Response.redirect(figmaUrl, 302);
  } catch (error) {
    if (error instanceof FigmaOAuthError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
