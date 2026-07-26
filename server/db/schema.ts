/**
 * [INPUT]: 无（纯表定义）
 * [OUTPUT]: drizzle 表对象，供 lib/db/index.ts 与各 Route Handler import
 * [POS]: A 域持久层 schema —— 项目、会话、AgentRun ledger 与工具闭合记录的权威存储
 *   关系：projects 1—N conversations 1—N {agent_runs, messages}
 *   request stop intent 按 owner/request 唯一；agent_runs 1—N tool_invocations 1—1 tool_results，并可关联 image_runs
 * [PROTOCOL]: 改表先改这里 + 跑 pnpm db:push
 *   - 代码(project_files)挂项目、**会话间共享**：切会话只换聊天记录，代码不随会话变
 *   - seq 用 identity（多实例防竞态，禁 MAX+1）
 *   - AgentRun/tool ledger 不软删；已有业务实体仍按各自 deleted_at 契约过滤
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  bigint,
  index,
  uniqueIndex,
  integer,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AgentHarnessIdentity } from "../../types/agentHarness";
import type {
  AgentRunDiagnosticCode as AgentRunDiagnosticCodeValue,
  AgentRunFailureCode as AgentRunFailureCodeValue,
  AgentRunStatus as AgentRunStatusValue,
  AgentRunTrigger as AgentRunTriggerValue,
  AgentToolEffect as AgentToolEffectValue,
  AgentToolExecutionDomain as AgentToolExecutionDomainValue,
  AgentToolResultKind as AgentToolResultKindValue,
} from "../../types/agentRun";
import type {
  GenerateImageItemInput,
  GenerateImageJobResult,
  GenerateImageRunResult,
  GeneratedImageMimeType,
  ImageAssetSource,
  ImageJobError,
  ImageJobStatus,
  ImageProvider,
  ImageProviderModel,
  ImageRunStatus,
} from "../../types/image";
import type { ProjectRepositoryDescriptor } from "../../types/projectRepository";
import type { ShowcaseArtifactStatus } from "../../types/showcaseArtifact";
import { ProjectStorageKind, type ProjectStorageKind as ProjectStorageKindValue } from "../../types/projectStorage";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  // Explicit schema default backfills legacy rows. Application requests must still provide this field.
  storageKind: text("storage_kind")
    .$type<ProjectStorageKindValue>()
    .notNull()
    .default(ProjectStorageKind.Database),
  codeRevision: bigint("code_revision", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),     // 软删：null=存活
}, (t) => ({ ownerIdx: index("idx_projects_owner").on(t.ownerId) }));

// 代码文件：挂项目、会话间共享（一期一行 App.jsx，结构支持二期多文件）
export const projectFiles = pgTable("project_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  // 部分唯一索引：只约束未软删的行，否则软删后建同名 path 会撞唯一约束
  uqPath: uniqueIndex("uq_file_path").on(t.projectId, t.path).where(sql`${t.deletedAt} is null`),
}));

// 对话线索：一个项目下可有多条，各自独立聊天记录（都对着项目的共享代码）
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  requestId: uuid("request_id").notNull(),
  trigger: text("trigger").$type<AgentRunTriggerValue>().notNull(),
  status: text("status").$type<AgentRunStatusValue>().notNull(),
  attempt: integer("attempt").notNull().default(1),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  harnessIdentity: jsonb("harness_identity").$type<AgentHarnessIdentity>().notNull(),
  repository: jsonb("repository").$type<ProjectRepositoryDescriptor>().notNull(),
  modelRounds: integer("model_rounds").notNull().default(0),
  toolRounds: integer("tool_rounds").notNull().default(0),
  maxModelRounds: integer("max_model_rounds").notNull(),
  maxToolRounds: integer("max_tool_rounds").notNull(),
  failureCode: text("failure_code").$type<AgentRunFailureCodeValue>(),
  failureMessage: text("failure_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => ({
  ownerStatusCreatedIdx: index("idx_agent_runs_owner_status_created")
    .on(t.ownerId, t.status, t.createdAt),
  conversationCreatedIdx: index("idx_agent_runs_conversation_created")
    .on(t.conversationId, t.createdAt),
  projectStatusCreatedIdx: index("idx_agent_runs_project_status_created")
    .on(t.projectId, t.status, t.createdAt),
  ownerRequestUnique: uniqueIndex("uq_agent_runs_owner_request")
    .on(t.ownerId, t.requestId),
  attemptPositive: check("ck_agent_runs_attempt_positive", sql`${t.attempt} > 0`),
  modelRoundsNonnegative: check(
    "ck_agent_runs_model_rounds_nonnegative",
    sql`${t.modelRounds} >= 0`,
  ),
  toolRoundsNonnegative: check(
    "ck_agent_runs_tool_rounds_nonnegative",
    sql`${t.toolRounds} >= 0`,
  ),
  maxModelRoundsPositive: check(
    "ck_agent_runs_max_model_rounds_positive",
    sql`${t.maxModelRounds} > 0`,
  ),
  maxToolRoundsPositive: check(
    "ck_agent_runs_max_tool_rounds_positive",
    sql`${t.maxToolRounds} > 0`,
  ),
}));

export const agentRunStopIntents = pgTable("agent_run_stop_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  requestId: uuid("request_id").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (t) => ({
  ownerRequestUnique: uniqueIndex("uq_agent_run_stop_intents_owner_request")
    .on(t.ownerId, t.requestId),
  agentRunUnique: uniqueIndex("uq_agent_run_stop_intents_agent_run")
    .on(t.agentRunId)
    .where(sql`${t.agentRunId} is not null`),
  consumptionComplete: check(
    "ck_agent_run_stop_intents_consumption_complete",
    sql`(${t.agentRunId} is null and ${t.consumedAt} is null)
      or (${t.agentRunId} is not null and ${t.consumedAt} is not null)`,
  ),
}));

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  // Legacy transcript rows predate AgentRun and intentionally remain null.
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  // 全局自增，Postgres 原子分配；多实例并发写不竞态。只用于会话内 ORDER BY，跳号无所谓。
  seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  role: text("role").notNull(),              // user | assistant | tool | system
  content: text("content").notNull(),
  model: text("model"),                      // assistant 才有：用了哪个模型
  meta: jsonb("meta"),                       // tool 结果细节 / { kind:'code'|'reply', attempt, stack }
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  convIdx: index("idx_messages_conv").on(t.conversationId, t.seq),
  runSeqIdx: index("idx_messages_run_seq").on(t.agentRunId, t.seq),
}));

export const agentToolInvocations = pgTable("agent_tool_invocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentRunId: uuid("agent_run_id").notNull().references(() => agentRuns.id),
  assistantMessageId: uuid("assistant_message_id").notNull().references(() => messages.id),
  attempt: integer("attempt").notNull(),
  modelRound: integer("model_round").notNull(),
  callIndex: integer("call_index").notNull(),
  providerCallId: text("provider_call_id").notNull(),
  toolName: text("tool_name").notNull(),
  arguments: text("arguments").notNull(),
  executionDomain: text("execution_domain")
    .$type<AgentToolExecutionDomainValue>()
    .notNull(),
  effect: text("effect").$type<AgentToolEffectValue>().notNull(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runRoundCallUnique: uniqueIndex("uq_agent_tool_invocations_run_round_call")
    .on(t.agentRunId, t.modelRound, t.callIndex),
  runCreatedIdx: index("idx_agent_tool_invocations_run_created")
    .on(t.agentRunId, t.createdAt),
  attemptPositive: check(
    "ck_agent_tool_invocations_attempt_positive",
    sql`${t.attempt} > 0`,
  ),
  modelRoundPositive: check(
    "ck_agent_tool_invocations_model_round_positive",
    sql`${t.modelRound} > 0`,
  ),
  callIndexNonnegative: check(
    "ck_agent_tool_invocations_call_index_nonnegative",
    sql`${t.callIndex} >= 0`,
  ),
}));

export const agentToolResults = pgTable("agent_tool_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentRunId: uuid("agent_run_id").notNull().references(() => agentRuns.id),
  invocationId: uuid("invocation_id").notNull().references(() => agentToolInvocations.id),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  kind: text("kind").$type<AgentToolResultKindValue>().notNull(),
  // Preserve the exact provider/tool result bytes for deterministic transcript replay.
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  invocationUnique: uniqueIndex("uq_agent_tool_results_invocation")
    .on(t.invocationId),
  runCreatedIdx: index("idx_agent_tool_results_run_created")
    .on(t.agentRunId, t.createdAt),
}));

export const agentRunDiagnostics = pgTable("agent_run_diagnostics", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentRunId: uuid("agent_run_id").notNull().references(() => agentRuns.id),
  attempt: integer("attempt").notNull(),
  code: text("code").$type<AgentRunDiagnosticCodeValue>().notNull(),
  invocationId: uuid("invocation_id").references(() => agentToolInvocations.id),
  detail: text("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runCreatedIdx: index("idx_agent_run_diagnostics_run_created")
    .on(t.agentRunId, t.createdAt),
  attemptPositive: check(
    "ck_agent_run_diagnostics_attempt_positive",
    sql`${t.attempt} > 0`,
  ),
}));

export const imageRuns = pgTable("image_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  // Legacy image runs predate AgentRun/tool invocation attribution and remain null.
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
  toolInvocationId: uuid("tool_invocation_id").references(() => agentToolInvocations.id),
  toolCallId: text("tool_call_id").notNull(),
  status: text("status").$type<ImageRunStatus>().notNull(),
  result: jsonb("result").$type<GenerateImageRunResult>(),
  error: jsonb("error").$type<ImageJobError>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  ownerStatusIdx: index("idx_image_runs_owner_status").on(t.ownerId, t.status, t.createdAt),
  conversationStatusIdx: index("idx_image_runs_conversation_status").on(t.conversationId, t.status, t.createdAt),
  legacyToolCallUnique: uniqueIndex("uq_image_runs_legacy_tool_call")
    .on(t.conversationId, t.toolCallId)
    .where(sql`${t.toolInvocationId} is null and ${t.deletedAt} is null`),
  toolInvocationUnique: uniqueIndex("uq_image_runs_tool_invocation")
    .on(t.toolInvocationId)
    .where(sql`${t.toolInvocationId} is not null and ${t.deletedAt} is null`),
}));

export const imageJobs = pgTable("image_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => imageRuns.id, { onDelete: "cascade" }),
  status: text("status").$type<ImageJobStatus>().notNull(),
  input: jsonb("input").$type<GenerateImageItemInput>().notNull(),
  result: jsonb("result").$type<GenerateImageJobResult>(),
  error: jsonb("error").$type<ImageJobError>(),
  provider: text("provider").$type<ImageProvider>().notNull(),
  providerModel: text("provider_model").$type<ImageProviderModel>().notNull(),
  providerJobId: text("provider_job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  runStatusIdx: index("idx_image_jobs_run_status").on(t.runId, t.status, t.createdAt),
  providerPollIdx: index("idx_image_jobs_provider_poll").on(t.provider, t.providerModel, t.status, t.lastPolledAt),
}));

export const projectAssets = pgTable("project_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  imageJobId: uuid("image_job_id").references(() => imageJobs.id, { onDelete: "set null" }),
  source: text("source").$type<ImageAssetSource>().notNull(),
  mimeType: text("mime_type").$type<GeneratedImageMimeType>().notNull(),
  blobPath: text("blob_path").notNull(),
  publicUrl: text("public_url").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  projectIdx: index("idx_project_assets_project").on(t.projectId, t.createdAt),
  ownerIdx: index("idx_project_assets_owner").on(t.ownerId, t.createdAt),
  imageJobIdx: index("idx_project_assets_image_job").on(t.imageJobId),
  imageJobUnique: uniqueIndex("uq_project_assets_image_job").on(t.imageJobId).where(sql`${t.imageJobId} is not null and ${t.deletedAt} is null`),
}));

export const chatAttachments = pgTable("chat_attachments", {
  id: uuid("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  mimeType: text("mime_type").notNull(),
  blobPath: text("blob_path").notNull(),
  blobUrl: text("blob_url").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  originalName: text("original_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  ownerIdx: index("idx_chat_attachments_owner").on(t.ownerId, t.createdAt),
  conversationIdx: index("idx_chat_attachments_conversation").on(t.conversationId),
}));

export const showcaseCases = pgTable("showcase_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  ownerId: text("owner_id").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  coverImageUrl: text("cover_image_url"),
  coverImageAlt: text("cover_image_alt"),
  sortOrder: integer("sort_order").notNull().default(1000),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugUnique: uniqueIndex("uq_showcase_cases_slug").on(t.slug),
  publishedIdx: index("idx_showcase_cases_published").on(t.publishedAt, t.sortOrder),
  projectIdx: index("idx_showcase_cases_project").on(t.projectId),
  conversationIdx: index("idx_showcase_cases_conversation").on(t.conversationId),
}));

export const showcaseArtifacts = pgTable("showcase_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  showcaseCaseId: uuid("showcase_case_id").notNull().references(() => showcaseCases.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  filesHash: text("files_hash").notNull(),
  status: text("status").$type<ShowcaseArtifactStatus>().notNull(),
  htmlBlobPath: text("html_blob_path").notNull(),
  blobPrefix: text("blob_prefix"),
  entryPath: text("entry_path"),
  filePaths: jsonb("file_paths").$type<string[]>(),
  sizeBytes: integer("size_bytes").notNull(),
  buildLog: text("build_log").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  caseIdx: index("idx_showcase_artifacts_case").on(t.showcaseCaseId, t.createdAt),
  readyIdx: index("idx_showcase_artifacts_ready").on(t.showcaseCaseId, t.status, t.createdAt),
}));

export const figmaConnections = pgTable("figma_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  figmaUserId: text("figma_user_id").notNull(),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => ({
  ownerIdx: index("idx_figma_connections_owner").on(t.ownerId),
  activeOwnerUnique: uniqueIndex("uq_figma_connections_active_owner")
    .on(t.ownerId)
    .where(sql`${t.revokedAt} is null`),
}));

export const oauthStates = pgTable("oauth_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  state: text("state").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  redirectTo: text("redirect_to").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  stateUnique: uniqueIndex("uq_oauth_states_state").on(t.state),
  ownerExpiryIdx: index("idx_oauth_states_owner_expires").on(t.ownerId, t.expiresAt),
}));
