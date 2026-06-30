/**
 * [INPUT]: ownerId and encrypted figma_connections rows
 * [OUTPUT]: Decrypted or refreshed Figma access token for server-side provider calls
 * [POS]: A 域 Figma token 读取层 —— token 只在服务端解密和刷新
 * [PROTOCOL]: 刷新响应必须通过 schema 校验；失败返回 FIGMA_UNAUTHORIZED，不明文降级
 */
import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { figmaConnections } from "@/server/db/schema";
import { encryptToken, decryptToken, FIGMA_TOKEN_URL } from "./oauth";
import { FigmaErrorCode, FigmaInspectError } from "./types";

const REFRESH_SKEW_MS = 60 * 1000;

const FigmaRefreshTokenResponseSchema = z.object({
  token_type: z.literal("bearer"),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
}).passthrough();

type ActiveConnection = {
  id: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  expiresAt: Date | null;
};

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new FigmaInspectError(FigmaErrorCode.ProviderUnavailable, `${name} is not configured.`);
  }
  return value;
}

function tokenExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() <= Date.now() + REFRESH_SKEW_MS;
}

function safeDecryptToken(value: string): string {
  try {
    return decryptToken(value);
  } catch (error) {
    throw new FigmaInspectError(
      FigmaErrorCode.Unauthorized,
      error instanceof Error ? `Stored Figma token cannot be decrypted: ${error.message}` : "Stored Figma token cannot be decrypted.",
    );
  }
}

async function loadActiveConnection(ownerId: string): Promise<ActiveConnection> {
  const [connection] = await db
    .select({
      id: figmaConnections.id,
      accessTokenEncrypted: figmaConnections.accessTokenEncrypted,
      refreshTokenEncrypted: figmaConnections.refreshTokenEncrypted,
      expiresAt: figmaConnections.expiresAt,
    })
    .from(figmaConnections)
    .where(and(eq(figmaConnections.ownerId, ownerId), isNull(figmaConnections.revokedAt)))
    .limit(1);

  if (!connection) {
    throw new FigmaInspectError(FigmaErrorCode.NotConnected, "Figma is not connected for the current owner.");
  }
  return connection;
}

async function refreshAccessToken(connection: ActiveConnection): Promise<string> {
  const clientId = readRequiredEnv("FIGMA_CLIENT_ID");
  const clientSecret = readRequiredEnv("FIGMA_CLIENT_SECRET");
  const refreshToken = safeDecryptToken(connection.refreshTokenEncrypted);
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(FIGMA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new FigmaInspectError(FigmaErrorCode.Unauthorized, `Figma token refresh failed with status ${response.status}.`);
  }

  const parsed = FigmaRefreshTokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new FigmaInspectError(FigmaErrorCode.Unauthorized, parsed.error.message);
  }

  const expiresAt = new Date(Date.now() + parsed.data.expires_in * 1000);
  await db
    .update(figmaConnections)
    .set({
      accessTokenEncrypted: encryptToken(parsed.data.access_token),
      refreshTokenEncrypted: encryptToken(parsed.data.refresh_token),
      expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(figmaConnections.id, connection.id));

  return parsed.data.access_token;
}

export async function getFigmaAccessToken(ownerId: string): Promise<string> {
  const connection = await loadActiveConnection(ownerId);
  if (tokenExpired(connection.expiresAt)) {
    return refreshAccessToken(connection);
  }
  return safeDecryptToken(connection.accessTokenEncrypted);
}
