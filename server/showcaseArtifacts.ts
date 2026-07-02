/**
 * [INPUT]: dev-generated showcase artifact dist files and artifact blob rows
 * [OUTPUT]: persisted artifact metadata and ready artifact file streams for public showcase rendering
 * [POS]: A 域案例 artifact 存储层 —— 只存取浏览器 WebContainer 生成的 dist 产物，不执行生成代码
 * [PROTOCOL]: 服务端绝不 npm install/build；上传只在 dev 环境开放；artifact 状态来自显式常量。
 */
import "server-only";
import { get, put } from "@vercel/blob";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/server/db";
import { showcaseArtifacts, showcaseCases } from "@/server/db/schema";
import { ShowcaseArtifactStatus } from "@/types/showcaseArtifact";

export type ReadyShowcaseArtifact = {
  id: string;
  filesHash: string;
  entryUrl: string;
  createdAt: string;
};

export type ShowcaseArtifactFile = {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
};

const ARTIFACT_FILE_FIELD_PREFIX = "artifactFile:";

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function artifactEntryUrl(slug: string) {
  return `/showcase-artifacts/${encodeURIComponent(slug)}#/`;
}

function contentTypeForPath(path: string) {
  const extension = path.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return extension ? CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream" : "application/octet-stream";
}

function artifactAssetUrl(slug: string, path: string) {
  return `/showcase-artifacts/${encodeURIComponent(slug)}/${path}`;
}

function normalizeArtifactPath(path: string) {
  const normalized = path.replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid artifact file path: ${path}`);
  }
  return normalized;
}

function rewriteIndexHtmlArtifactPaths(html: string, slug: string, filePaths: string[]) {
  return filePaths
    .filter((path) => path !== "index.html")
    .reduce((current, path) => current.replaceAll(`/${path}`, artifactAssetUrl(slug, path)), html);
}

async function readBlobFile(blobPath: string, contentType: string): Promise<ShowcaseArtifactFile> {
  const result = await get(blobPath, { access: "private" }) as {
    statusCode?: number;
    stream?: ReadableStream<Uint8Array>;
  } | null;
  if (!result?.stream) throw new Error(`Showcase artifact blob missing: ${blobPath}`);
  if (result.statusCode !== undefined && result.statusCode !== 200) {
    throw new Error(`Showcase artifact blob read failed: ${result.statusCode}`);
  }

  return { stream: result.stream, contentType };
}

export async function getLatestReadyShowcaseArtifact(showcaseCaseId: string): Promise<ReadyShowcaseArtifact | null> {
  const [row] = await db
    .select({
      id: showcaseArtifacts.id,
      filesHash: showcaseArtifacts.filesHash,
      createdAt: showcaseArtifacts.createdAt,
      slug: showcaseCases.slug,
    })
    .from(showcaseArtifacts)
    .innerJoin(showcaseCases, eq(showcaseArtifacts.showcaseCaseId, showcaseCases.id))
    .where(and(
      eq(showcaseArtifacts.showcaseCaseId, showcaseCaseId),
      eq(showcaseArtifacts.status, ShowcaseArtifactStatus.Ready),
      isNotNull(showcaseArtifacts.blobPrefix),
      isNotNull(showcaseArtifacts.entryPath),
      isNull(showcaseArtifacts.deletedAt),
    ))
    .orderBy(desc(showcaseArtifacts.createdAt))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    filesHash: row.filesHash,
    entryUrl: artifactEntryUrl(row.slug),
    createdAt: iso(row.createdAt),
  };
}

export async function saveShowcaseArtifact(input: {
  slug: string;
  filesHash: string;
  files: {
    path: string;
    bytes: Uint8Array;
  }[];
  buildLog: string;
}) {
  const [showcase] = await db
    .select({
      id: showcaseCases.id,
      projectId: showcaseCases.projectId,
      conversationId: showcaseCases.conversationId,
    })
    .from(showcaseCases)
    .where(and(
      eq(showcaseCases.slug, input.slug),
      isNull(showcaseCases.revokedAt),
    ))
    .limit(1);

  if (!showcase) throw new Error(`Showcase case not found: ${input.slug}`);
  if (input.files.length === 0) throw new Error("Showcase artifact files are required");

  const artifactId = crypto.randomUUID();
  const blobPrefix = `showcase-artifacts/${showcase.id}/${input.filesHash}/${artifactId}/`;
  const filePaths = input.files.map((file) => normalizeArtifactPath(file.path));
  if (new Set(filePaths).size !== filePaths.length) throw new Error("Showcase artifact contains duplicate file paths");
  if (!filePaths.includes("index.html")) throw new Error("Showcase artifact missing index.html");

  let sizeBytes = 0;
  await Promise.all(input.files.map(async (file, index) => {
    const path = filePaths[index];
    const bytes = path === "index.html"
      ? new TextEncoder().encode(rewriteIndexHtmlArtifactPaths(new TextDecoder().decode(file.bytes), input.slug, filePaths))
      : file.bytes;
    sizeBytes += bytes.byteLength;
    await put(`${blobPrefix}${path}`, bytes, {
      access: "private",
      addRandomSuffix: false,
      contentType: contentTypeForPath(path),
    });
  }));

  const [row] = await db.insert(showcaseArtifacts).values({
    id: artifactId,
    showcaseCaseId: showcase.id,
    projectId: showcase.projectId,
    conversationId: showcase.conversationId,
    filesHash: input.filesHash,
    status: ShowcaseArtifactStatus.Ready,
    htmlBlobPath: `${blobPrefix}index.html`,
    blobPrefix,
    entryPath: "index.html",
    filePaths,
    sizeBytes,
    buildLog: input.buildLog,
  }).returning({
    id: showcaseArtifacts.id,
    filesHash: showcaseArtifacts.filesHash,
    sizeBytes: showcaseArtifacts.sizeBytes,
    createdAt: showcaseArtifacts.createdAt,
  });

  return {
    id: row.id,
    filesHash: row.filesHash,
    sizeBytes: row.sizeBytes,
    entryUrl: artifactEntryUrl(input.slug),
    createdAt: iso(row.createdAt),
  };
}

export async function getLatestReadyShowcaseArtifactFile(slug: string, requestedPath: string): Promise<ShowcaseArtifactFile | null> {
  const [row] = await db
    .select({
      blobPrefix: showcaseArtifacts.blobPrefix,
      entryPath: showcaseArtifacts.entryPath,
      filePaths: showcaseArtifacts.filePaths,
    })
    .from(showcaseArtifacts)
    .innerJoin(showcaseCases, eq(showcaseArtifacts.showcaseCaseId, showcaseCases.id))
    .where(and(
      eq(showcaseCases.slug, slug),
      eq(showcaseArtifacts.status, ShowcaseArtifactStatus.Ready),
      isNotNull(showcaseArtifacts.blobPrefix),
      isNotNull(showcaseArtifacts.entryPath),
      isNull(showcaseArtifacts.deletedAt),
      isNull(showcaseCases.revokedAt),
      isNotNull(showcaseCases.publishedAt),
    ))
    .orderBy(desc(showcaseArtifacts.createdAt))
    .limit(1);

  if (!row?.blobPrefix || !row.entryPath || !row.filePaths) return null;
  const path = requestedPath ? normalizeArtifactPath(requestedPath) : row.entryPath;
  if (!row.filePaths.includes(path)) return null;
  return readBlobFile(`${row.blobPrefix}${path}`, contentTypeForPath(path));
}

export async function parseShowcaseArtifactFormData(form: FormData) {
  const files: { path: string; bytes: Uint8Array }[] = [];
  const fields: Record<string, FormDataEntryValue> = {};

  for (const [key, value] of form.entries()) {
    if (key.startsWith(ARTIFACT_FILE_FIELD_PREFIX)) {
      if (!(value instanceof File)) throw new Error(`Invalid artifact file field: ${key}`);
      const path = normalizeArtifactPath(decodeURIComponent(key.slice(ARTIFACT_FILE_FIELD_PREFIX.length)));
      files.push({ path, bytes: new Uint8Array(await value.arrayBuffer()) });
      continue;
    }
    if (fields[key] !== undefined) throw new Error(`Duplicate artifact field: ${key}`);
    fields[key] = value;
  }

  return { fields, files };
}
