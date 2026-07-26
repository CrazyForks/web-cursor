/**
 * [INPUT]: conversationId + 严格消息字段；可选 AgentRun 归属与事务 writer
 * [OUTPUT]: appendMessage 追加一条；listMessages 列某会话的消息数组
 * [POS]: A 域 messages 表读写 —— /api/chat 落库 + GET messages 回放都走它
 * [PROTOCOL]: seq 由 DB identity 原子分配（insert 不传 seq）；读一律按 seq 升序、排除软删
 *   appendMessage 兼容旧的第三参数 tx；新代码用 options 同时绑定 agentRunId 与 tx
 */
import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  AgentRunIdSchema,
  type AgentRunId,
} from "@/types/agentRun";
import {
  StoredMessageInputSchema,
  type StoredMessageInput,
} from "@/types/transcript";
import { db } from "./db";
import { messages } from "./db/schema";

type NewMessage = StoredMessageInput;

/** db 或 db.transaction 的 tx 都能写消息。 */
type MessageWriter = Pick<typeof db, "insert">;

export type AppendMessageOptions = Readonly<{
  writer?: MessageWriter;
  agentRunId?: AgentRunId;
}>;

/** 追加一条消息：不传 seq（DB identity 原子分配，多实例无竞态）。 */
export async function appendMessage(
  conversationId: string,
  m: NewMessage,
  writerOrOptions: MessageWriter | AppendMessageOptions = db,
) {
  const message = StoredMessageInputSchema.parse(m);
  const options: AppendMessageOptions = "insert" in writerOrOptions
    ? { writer: writerOrOptions }
    : writerOrOptions;
  const writer = options.writer ?? db;
  const agentRunId = options.agentRunId === undefined
    ? undefined
    : AgentRunIdSchema.parse(options.agentRunId);
  const [row] = await writer
    .insert(messages)
    .values({
      conversationId,
      ...message,
      ...(agentRunId === undefined ? {} : { agentRunId }),
    })
    .returning();
  return row;
}

/** 列某会话的消息：按 seq 升序、排除软删。SQL: WHERE conversation_id=$1 AND deleted_at IS NULL ORDER BY seq */
export function listMessages(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.seq));
}
