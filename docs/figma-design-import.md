# Figma Design Import

> 目标：用户输入 Figma 链接后，agent 能读取指定设计上下文，并按设计风格生成 React 页面。

## 0. 核心判断

【值得实现】

Figma 输入能把 Web Cursor 从“文字生成 UI”升级为“基于真实设计生成 UI”。这符合项目的核心闭环：agent 读取外部事实，写项目文件，再通过 Preview 验收。

【不建议实现】

不要把能力押在 Figma 官方 Remote MCP 申请通过上。当前官方 Remote MCP 是受控准入，只有 Figma MCP Catalog 中列出的客户端可直接连接。完整产品应先设计 provider 抽象，短期走 Figma OAuth + REST API，后续 MCP 可作为替换实现。

## 1. 范围

第一阶段只支持“指定 frame/node 链接”：

- 用户必须提供包含 `node-id` 的 Figma 链接。
- 不做整文件自动猜测主页面。
- 不做 1:1 design-to-code 引擎。
- 服务端只提取可实现事实，React 代码仍由 agent 写。

支持链接：

```text
https://www.figma.com/design/:fileKey/:fileName?node-id=1-2
https://www.figma.com/file/:fileKey/:fileName?node-id=1-2
```

不支持时明确返回错误，不做字段猜测。

## 2. 架构位置

Figma 能力只在 A 域服务端执行：

```text
用户输入 Figma 链接
  -> B 域前端把原始消息发给 /api/chat
  -> A 域 agent 调 inspect_figma_design
  -> A 域读取 Figma token，调用 REST/MCP provider
  -> 工具结果进入 transcript
  -> agent 基于工具结果写 React 项目文件
  -> B 域 run_preview
  -> C 域 iframe 只执行最终 React
```

约束：

- Figma token 不进入 B/C 域。
- iframe 不直接请求 Figma。
- 第一阶段不做 Figma 导出资产转存；如返回 Figma 图片 URL，必须在工具结果中标明 `expiresAt` 或 `ttlWarning`。
- 工具失败必须返回明确错误码和诊断信息。

## 3. 授权模型

第一阶段只做 Figma OAuth，绑定到当前项目已有的匿名 `ownerId`。这能支撑本地开发和早期内测，但不等价于真实用户登录；公网产品必须先补真实 user/session，再把连接归属从 `ownerId` 迁移到 `userId`。

本阶段不要做通用 integration 表，也不要提前保存 `provider` / `authType`：

- 表名 `figma_connections` 已经表达 provider 是 Figma。
- 本阶段只有 OAuth，不需要 `authType: "oauth"`。
- 当前项目没有真实 user/session，只使用 `ownerId`，不要在 schema 里写 `ownerId / userId` 这种摇摆字段。

建议表：

```text
figma_connections
- id
- ownerId
- figmaUserId
- accessTokenEncrypted
- refreshTokenEncrypted
- expiresAt
- scopes
- createdAt
- updatedAt
- revokedAt

oauth_states
- id
- ownerId
- state
- codeVerifier
- redirectTo
- expiresAt
- consumedAt
- createdAt
```

约束：

- `figma_connections`：同一 `ownerId` 同时只能有一个未撤销连接，建议加 `unique(ownerId) where revokedAt is null`。
- `oauth_states.state` 必须唯一。
- `oauth_states` 必须短 TTL；过期、已消费或不存在的 `state` 直接返回错误，不做兜底。
- `returnTo` 只允许站内相对路径，禁止任意外链跳转。
- token 必须加密保存；缺少加密密钥时接口应明确失败，不允许明文降级。
- `scopes` 保存本阶段请求的 scope，用于后续诊断权限不足；如果后续接入的 Figma token 响应明确返回实际授权 scope，再迁移为保存实际返回值。

OAuth 流程：

```text
GET /api/integrations/figma/oauth/start
  -> 生成 state + PKCE verifier/challenge
  -> 写 oauth_states，短 TTL
  -> redirect 到 Figma OAuth

GET /api/integrations/figma/oauth/callback
  -> 校验 state
  -> 用 code + verifier 换 token
  -> 从 token 响应读取 Figma user id
  -> 加密保存 token
  -> redirect 回 Web Cursor
```

最小 scope：

- `file_content:read`：读取文件、节点、导出图片。
- `file_metadata:read`：只有需要 metadata 时再加。
- `file_variables:read`：只有读取 variables/design tokens 时再加；该能力受 Figma 计划限制，不能默认依赖。

`GET /api/integrations/figma/status` 返回当前 owner 的连接状态。`loading` 是前端本地状态，不由后端返回。

```ts
type FigmaConnectionStatus =
  | {
      status: "connected";
      figmaUserId: string;
      scopes: string[];
      expiresAt: string | null;
    }
  | {
      status: "disconnected";
    };
```

如果状态查询本身失败，Route Handler 返回非 2xx 和明确错误体；前端把它映射成 `figmaStatus = "error"`。

## 4. 绑定卡片交互

未绑定 Figma 时，不改历史 message 状态。agent 发送一条绑定卡片 message，前端按当前 `figma_connections` 状态动态渲染卡片。

核心原则：

```text
messages 表：记录当时 agent 发过“需要绑定 Figma”的事实
figma_connections 表：记录当前用户是否已绑定 Figma
前端渲染：message 静态意图 + 当前 figma status 动态合成 UI
```

绑定成功后，只更新 `figma_connections`。不回写、不 patch、不删除原 assistant message。刷新后前端重新读取 messages 和 Figma status，同一条历史卡片自然显示为“已连接”。

### 4.1 Message 形态

当 agent 需要读取 Figma 但用户未绑定时，后端写入 assistant message：

```json
{
  "role": "assistant",
  "content": "需要连接 Figma 才能读取这个设计链接。",
  "meta": {
    "kind": "integration_card",
    "provider": "figma",
    "action": "connect",
    "reason": "FIGMA_NOT_CONNECTED",
    "resume": {
      "type": "conversation"
    }
  }
}
```

规则：

- `content` 是给旧 UI / 无卡片渲染能力时的 fallback 文案。
- `meta.kind="integration_card"` 是前端渲染卡片的权威标记。
- message 不保存 `connected/disconnected` 状态。
- 绑定状态只来自 `GET /api/integrations/figma/status`。

### 4.2 前端渲染

打开会话时并行读取：

```text
GET /api/conversations/:id/messages
GET /api/integrations/figma/status
```

渲染逻辑：

```text
if message.meta.kind === "integration_card"
  render IntegrationCard(message.meta, figmaStatus)
```

卡片状态：

```text
figmaStatus = "loading"
  -> 显示“正在检查 Figma 连接…”

figmaStatus = "disconnected"
  -> 显示“需要连接 Figma”
  -> 显示 [连接 Figma] 按钮

figmaStatus = "connected"
  -> 显示“已连接 Figma”
  -> 显示 [继续生成] 按钮

figmaStatus = "error"
  -> 显示“检查 Figma 连接失败”
  -> 显示 [重试] 按钮
```

点击“连接 Figma”：

```text
跳转 /api/integrations/figma/oauth/start?ownerId=<当前匿名 ownerId>&returnTo=<当前项目/会话 URL>
```

说明：当前项目的 `ownerId` 只存在浏览器 localStorage，普通浏览器跳转不会自动带 `x-owner-id` header。因此 OAuth start 在第一阶段通过 query 显式接收 `ownerId`，并在服务端严格校验 UUID。公网产品补真实 session 后，应移除 query ownerId，改为从 session 取用户身份。

OAuth callback 成功：

```text
后端只更新 figma_connections
前端回到原页面
前端重新请求 figma status
历史卡片从“连接 Figma”变成“已连接”
```

点击“继续生成”：

```text
POST /api/chat { kind: "resume", conversationId }
```

不建议绑定成功后自动 resume。按钮更明确，避免用户只是授权但不想继续执行。

### 4.3 后端兜底

即使前端已经显示已连接，`inspect_figma_design` 工具执行前仍必须重新校验 `figma_connections`：

- 未绑定：返回 `FIGMA_NOT_CONNECTED`。
- token 过期且刷新失败：返回 `FIGMA_UNAUTHORIZED`。
- 用户无文件权限：返回 `FIGMA_FORBIDDEN`。

前端卡片是交互状态，不是权限依据。

## 5. Provider 抽象

不要让 agent 感知 Figma REST 或 MCP 原始协议。agent 只调用内部工具。

```ts
interface FigmaDesignProvider {
  inspectDesign(
    target: FigmaTarget,
    options: InspectFigmaOptions,
  ): Promise<FigmaDesignContext>;
}
```

实现：

```text
server/figma/providers/restProvider.ts
server/figma/providers/mcpProvider.ts
```

运行时选择：

```text
FIGMA_PROVIDER=rest | mcp
```

第一阶段用 REST provider。等官方 MCP client 准入通过后，再增加 MCP provider，不改变 agent 工具契约。

## 6. 工具契约

新增工具：

```text
inspect_figma_design
```

参数：

```ts
{
  figmaUrl: string;
  maxDepth?: number;
  includeAssets: boolean;
}
```

规则：

- `figmaUrl` 必须由服务端解析并校验。
- 没有 `node-id` 时返回 `FIGMA_NODE_REQUIRED`，让 agent 回复用户补具体 frame 链接。
- `node-id` 的 `-` 转 `:` 是 Figma URL/API 明确规则，不属于猜字段。
- `maxDepth` 和节点数必须有限制，避免大文件塞爆上下文。
- `includeAssets=true` 时，服务端只获取 Figma 导出 URL，不转存到 Web Cursor 存储。

返回：

```ts
{
  status: "ok";
  tool: "inspect_figma_design";
  source: {
    fileKey: string;
    nodeId: string;
    fileName: string;
    nodeName: string;
  };
  figmaTree: SimplifiedFigmaNode;
  assets: FigmaAssetRef[];
  warnings: string[];
}
```

## 7. 轻量转换策略

不做深度 design-to-code 转换，但必须做 sanitizer/compressor。

原因：

- 原始 Figma JSON 过大，容易超出 LLM context。
- 原始字段包含大量实现无关信息。
- 资产 URL 有时效风险，需要在工具结果中显式暴露。
- 直接把原始 JSON 丢给 AI 会让模型猜字段语义，违反“禁止猜字段”。

保留字段白名单：

```text
id
name
type
visible
absoluteBoundingBox
layoutMode
primaryAxisSizingMode
counterAxisSizingMode
itemSpacing
paddingLeft / paddingRight / paddingTop / paddingBottom
fills
strokes
effects
opacity
style
characters
children
```

丢弃：

```text
pluginData
devStatus
复杂 metadata
不可见节点
过深 children
未知字段
```

输出示例：

```json
{
  "id": "1:2",
  "name": "Hero",
  "type": "FRAME",
  "box": { "x": 0, "y": 0, "w": 1440, "h": 900 },
  "layout": { "mode": "VERTICAL", "gap": 32, "padding": [80, 96, 80, 96] },
  "style": { "bg": "#0B0F14" },
  "children": [
    {
      "type": "TEXT",
      "name": "Headline",
      "text": "Build faster",
      "box": { "w": 720, "h": 120 },
      "font": { "family": "Inter", "size": 64, "weight": 700 },
      "color": "#FFFFFF"
    },
    {
      "type": "IMAGE",
      "name": "Product screenshot",
      "assetUrl": "https://figma-export-url.example/image.png",
      "ttlWarning": "Figma export URL may expire."
    }
  ]
}
```

## 8. Figma 资产策略

第一阶段砍掉 Figma 资产转存，不新增 `project_assets` 依赖。工具可以返回 Figma 导出 URL，但必须把 URL 生命周期风险暴露给 agent 和 UI。

返回类型：

```ts
type FigmaAssetRef = {
  source: "figma_export";
  sourceFileKey: string;
  sourceNodeId: string;
  url: string;
  mimeType: "image/png" | "image/jpeg" | "image/svg+xml";
  width?: number;
  height?: number;
  ttlWarning: string;
};
```

流程：

```text
Figma images API / MCP 返回可下载 URL
  -> 服务端校验响应结构
  -> 工具结果返回 FigmaAssetRef
  -> agent 可临时引用该 URL
```

限制：

- 导出的 URL 可能过期，生成页面不保证长期可用。
- 导出 HTML 或长期分享时，Figma 图片可能失效。
- 如果后续要做可分享/可长期保存，再补“Figma asset 转存到 project_assets”。
- 不允许 URL 获取失败时生成占位图伪装成功。

## 9. 错误码

```ts
const FigmaErrorCode = {
  NotConnected: "FIGMA_NOT_CONNECTED",
  InvalidUrl: "FIGMA_INVALID_URL",
  NodeRequired: "FIGMA_NODE_REQUIRED",
  Unauthorized: "FIGMA_UNAUTHORIZED",
  Forbidden: "FIGMA_FORBIDDEN",
  NotFound: "FIGMA_NOT_FOUND",
  UnsupportedNode: "FIGMA_UNSUPPORTED_NODE",
  ProviderUnavailable: "FIGMA_PROVIDER_UNAVAILABLE",
  RateLimited: "FIGMA_RATE_LIMITED",
  AssetExportFailed: "FIGMA_ASSET_EXPORT_FAILED",
} as const;
```

失败结果示例：

```json
{
  "status": "error",
  "tool": "inspect_figma_design",
  "code": "FIGMA_NOT_CONNECTED",
  "message": "用户尚未连接 Figma。"
}
```

## 10. Agent Prompt 规则

需要补充到 system prompt：

- 用户消息包含 Figma 链接且需求依赖设计时，先调用 `inspect_figma_design`。
- 不要猜 Figma 链接内容。
- 没有 `node-id` 时，要求用户提供具体 frame 链接。
- `inspect_figma_design` 返回 `FIGMA_NOT_CONNECTED` 时，写入 `integration_card` assistant message；不要继续实现页面。
- 只能使用工具结果里的 `asset.url`，不能编造图片 URL。
- 如果工具结果包含 `ttlWarning`，最终回复需要提示用户该 Figma 图片链接可能过期。
- Figma 工具失败时，用 `reply` 暴露诊断信息。
- 根据 Figma tree 生成 React 页面后，必须 `list_files` 自检并 `run_preview` 验收。

## 11. 实施任务

```text
1. 设计并创建 figma_connections / oauth_states
2. 实现 Figma OAuth start/callback/status/disconnect
3. 实现 integration_card message meta 渲染
4. 前端加载会话时读取 Figma status，并按 status 动态渲染历史卡片
5. 实现“连接 Figma”按钮和 OAuth returnTo 回跳
6. 实现“继续生成”按钮，调用 /api/chat resume
7. 实现 Figma URL parser
8. 实现 REST provider：files/nodes/images
9. 实现 simplified tree sanitizer/compressor
10. 实现 Figma 导出 URL 获取和 ttlWarning 暴露
11. 新增 inspect_figma_design 工具定义、schema、executor 分支
12. 更新 system prompt
13. 用指定 frame 链接做端到端验证：绑定卡片 -> OAuth -> resume -> inspect -> write_file -> run_preview
```

## 12. 验收标准

- 未连接 Figma 时，输入 Figma 链接后产生 assistant integration card。
- 绑定卡片 message 不因 OAuth 成功被修改。
- OAuth 成功只更新 `figma_connections`。
- 刷新页面后，同一条历史绑定卡片能根据当前 Figma status 显示“已连接”。
- 用户点击“继续生成”后，agent 能 resume 原会话。
- 已连接 Figma 时，指定 frame 链接能成功读取目标 node。
- 无 `node-id` 时，不猜页面，要求用户补 frame 链接。
- Figma 图片/SVG 资产不转存；工具返回 Figma 导出 URL 和明确过期风险。
- agent 生成的 React 页面只引用工具结果中出现过的 URL。
- Preview 能运行；失败时错误进入 agent loop 继续修复。
