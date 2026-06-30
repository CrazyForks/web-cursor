/**
 * [INPUT]: Figma OAuth callback query code/state
 * [OUTPUT]: Encrypted figma_connections row, consumed oauth_states row, then redirect back to Web Cursor
 * [POS]: A 域 Figma OAuth 回调 —— token 只在服务端换取并加密落库
 * [PROTOCOL]: state 必须存在、未过期、未消费；失败不伪装授权成功
 */
import { completeFigmaOAuthCallback, FigmaOAuthError } from "@/server/figma/oauth";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return Response.json({ error: "Missing OAuth code or state.", code: "FIGMA_BAD_CALLBACK" }, { status: 400 });
    }

    const redirectTo = await completeFigmaOAuthCallback(req, state, code);
    return Response.redirect(new URL(redirectTo, url.origin), 302);
  } catch (error) {
    if (error instanceof FigmaOAuthError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
