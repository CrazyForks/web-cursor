/**
 * [INPUT]: 会话 id（URL）
 * [OUTPUT]: 该会话的 messages 数组（按 seq 升序，排除软删）
 * [POS]: A 域回放接口 —— 前端刷新后恢复整段对话用
 * [PROTOCOL]: 经 ownsConversation 反查归属；返回前用统一 Transcript parser fail closed
 */
import { listMessages } from "@/server/messages";
import { ownsConversation } from "@/server/guard";
import { ownerIdFrom } from "@/server/owner";
import { listConversationAttachmentViews } from "@/server/attachments";
import type { AttachmentSummary } from "@/types/attachment";
import {
  parseStoredTranscript,
  TranscriptProtocolError,
} from "@/lib/agent/fullContextAssembler";
import { UserAttachmentsMetaSchema } from "@/types/transcript";

type Ctx = { params: Promise<{ id: string }> };
type MessageRow = Awaited<ReturnType<typeof listMessages>>[number];

function attachmentsFromMeta(meta: unknown): AttachmentSummary[] {
  if (
    typeof meta !== "object"
    || meta === null
    || !Object.prototype.hasOwnProperty.call(meta, "attachments")
  ) return [];
  return UserAttachmentsMetaSchema.parse(meta).attachments;
}

function enrichRowAttachments(row: MessageRow, views: Map<string, AttachmentSummary>): MessageRow {
  if (row.role !== "user") return row;

  const attachments = attachmentsFromMeta(row.meta);
  if (attachments.length === 0) return row;

  const enriched = attachments.map((attachment) => {
    const view = views.get(attachment.id);
    if (!view) {
      console.warn(`Missing chat attachment view for message ${row.id}: ${attachment.id}`);
      return attachment;
    }
    return {
      ...attachment,
      name: view.name ?? attachment.name,
      previewUrl: view.previewUrl,
    };
  });

  return {
    ...row,
    meta: {
      ...(row.meta && typeof row.meta === "object" && !Array.isArray(row.meta) ? row.meta : {}),
      attachments: enriched,
    },
  };
}

export async function GET(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  if (!(await ownsConversation(id, ownerId))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const rows = await listMessages(id);
  try {
    parseStoredTranscript(rows);
  } catch (error) {
    if (error instanceof TranscriptProtocolError) {
      return Response.json({
        error: "transcript protocol error",
        code: error.code,
        detail: error.message,
      }, { status: 409 });
    }
    throw error;
  }
  const attachmentIds = rows.flatMap((row) => attachmentsFromMeta(row.meta).map((attachment) => attachment.id));
  const views = await listConversationAttachmentViews(id, [...new Set(attachmentIds)]);

  return Response.json(rows.map((row) => enrichRowAttachments(row, views)));
}
