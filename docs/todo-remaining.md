# 待变更清单（change 1 收尾 · 自己手改用）

> 截至当前，change 1 还差的活。配套 `docs/backend-todo.md`（里程碑视角）——本文是**代码级、可勾选**的剩余变更，带文件位置。
> 已完成的不在此列（schema / db / messages / context / guard / `POST chat` / `POST·GET projects` / `GET projects/[id]` / `GET conversations messages` / 前端 chatClient+useChat 的 delta wiring）。

---

## 一、`app/api/chat/route.ts` 收尾

- [ ] **自修复工具回喂**：先拍 A / B（见 §二），再动手。当前 `appendMessage` 写死 `role:'user'`、body 没读 `role`。
- [ ] **请求体 zod 校验**：`message` 必填（现在可能 undefined 就喂给 LLM）。
- [ ] **开流前 try/catch**：`req.json()` / `db.insert` 抛错现在直接裸 500 无 body，包成结构化错误。
- [ ] **assistant 落库补 `model`**：现在只剩 `meta.kind`，`model` 之前被删了。
- [ ] *(延后)* line 34 `// todo: 把 projectid 相关代码传给 llm`：手改代码（R12）后才需要从 `project_files` 取当前代码喂 LLM；本期 AI-only 靠 messages 历史够用，**不做**。

---

## 二、自修复回喂方案（要先决定 A / B）

> 背景：沙箱执行 = `write_app` 的"工具结果"，失败要回喂 agent 自修复。`role:tool` 严格指"AI 调的工具的返回（带 tool_call_id）"，我们沙箱跑在浏览器、loop 跨 HTTP，所以要么缝 id（B）要么退化文本（A）。

### 方案 A · 文本式 ReAct（贴现状，简单）
回喂用 `user`，去掉冗余代码，来源放 `meta`。
- [ ] 前端 `hooks/useChat.ts` runLoop 两处 retry（`message = \`代码编译失败…\`` / `message = \`运行报错…\``）：**只发报错，去掉 `当前代码：${codeText}`**（后端已有上一版 assistant code）。
- [ ] 前端 `streamChat` 带 `meta: { source:'sandbox', attempt, stack }`；后端存进 `messages.meta`。
- [ ] 后端 role 仍 `user`（或读 body.role 默认 user）。
- [ ] 可砍 `server/context.ts` 的 tool→user 转换（没有 tool 数据了）。
- ✅ 验收：自修复一轮，SQL 见 `user(需求)/assistant(code)/user(报错,meta.source=sandbox)/assistant(fixed)`。

### 方案 B · 原生 function-calling（教科书 agent loop，工作量大）
`write_app` 变"写并执行"的真工具，沙箱结果作为它的 `tool_result`（带 `tool_call_id`）回喂。
- [ ] `tool_call_id` 放 `messages.meta`（jsonb），**不加专门列**（不按它查/连表，配对是内存里 `toLLMMessages` 做）。assistant 的 `tool_calls` 数组也存 `meta`（本来就得 jsonb）。
- [ ] 后端 chat：把 assistant 的 `tool_calls`（含 id）**落库到 meta**，write_app 后**不就地收尾**。
- [ ] 前端：从流里拿到 `tool_call_id`，沙箱跑完连同结果（OK/ERROR）回传。
- [ ] 后端：收到回传 → append `role:'tool'` + `tool_call_id` + content(错误/OK) → 续同一段对话再调 LLM。
- [ ] `toLLMMessages`：把 `assistant(tool_calls)` 与其 `tool(result)` **成对**喂 DeepSeek（不再 tool→user）；注意 DeepSeek 对 tool 消息配对/格式的要求。
- ⚠️ 风险：跨 HTTP 缝 `tool_call_id`、流式下取 id、DeepSeek 工具协议细节。

> 建议：当前架构 → **A**；想吃透真 agent loop → B。

---

## 三、前端编排 M2（R20 历史与项目管理 · 基本没做）

> 现状：`app/page.tsx` 还是一期单页工作台；`useChat` 只接了 `init`+delta，**没有项目列表 / 会话切换 / 刷新恢复**。这块是 change 1 剩下最大的一坨。

- [ ] **首页项目列表页**：`GET /api/projects` → 卡片列表 + "新建项目"（参考 `prototype-v2.html`）。
- [ ] **路由**：`/`（列表）+ `/p/[projectId]`（工作台）；或单页 client state。
- [ ] **工作台会话切换**：`GET /api/projects/[id]`（含 conversations）→ 左栏会话列表 + 切换/新建。
- [ ] **打开会话恢复**：`GET /api/conversations/[id]/messages` → ① 折叠成 UI 气泡渲染对话；② **取最后一条 `assistant & meta.kind==='code'` 当"当前代码"** 灌编辑器 + 跑沙箱恢复预览。
- [ ] **切会话不动代码**（Cursor 模型）：代码是项目级，切线索只换聊天记录。
- [ ] `useChat`：把"折叠 transcript"抽成纯函数（建议 `lib/transcript.ts`），实时和回放复用；**该函数要有单测**（历史回放正确性的唯一保证）。
- [ ] `lib/chatClient.ts` 头注释里"code 快照"等描述按 delta 校正（已基本改过，扫一遍）。

---

## 四、验收 M4

- [ ] `scripts/smoke.sh`：建项目 → chat(懒建会话) → 取 init 的 id → 伪造报错回喂 → SQL dump transcript，一键跑。
- [ ] 多实例自查（`backend-design §8`）：seq=identity / assistant 落库（`await` 或改 `waitUntil`）/ neon-http 单语句 / 无内存状态。
- [ ] **实跑一次端到端**（至今只过 `tsc`，没有运行时事实）：`pnpm dev` 走"发需求 → init → delta 流式 → 落库 → 刷新恢复"，留网络流 + SQL 当原始事实。

---

## 五、可选 / 整洁（可缓）

- [ ] `server/owner.ts`（`getOwnerId(req)` helper）—— 现在 route 内联 `req.headers.get`，重复了几处。
- [ ] `server/prompts.ts`（`SYSTEM_PROMPT` 还在 `server/deepseek.ts`，拆不拆都行）。
- [ ] assistant 落库改 `waitUntil`（serverless 下不阻塞 done）。
- [ ] `projects/route.ts` 的 `POST` 风格（`new Response(JSON.stringify)`）与其它 `Response.json` 不一致，想统一可顺手。

---

## 延后（不属于 change 1）

- `app/api/projects/[id]/files/route.ts`（`GET` + `PUT`）+ 两个保存触发点（AI = write_app 副作用、用户 = Monaco 手改防抖）—— 等 **R12 手改代码 / change 2 多文件** 再做。
- `project_files` 表本期不写；"当前代码"从 messages 最后一条 code 取。
