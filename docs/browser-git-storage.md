# Web Cursor 可选 Browser Git 存储——需求与实现设计

> 状态：新建 Browser Git、旧 Database 项目迁移、Agent client file/Git tools 与关键前端 E2E 已接通。
>
> 当前范围：只支持浏览器本地 Git，不支持 ZIP、Blob、云端同步、跨设备恢复或 Git remote。

## 1. 核心判断

【核心判断】

✅ 值得实现：用户需要真实 Git 语义，但 Web Cursor 仍要允许不使用 Git。database_v1 与 browser_git_v1 应是两种显式存储后端，不是一个可随意切换的 UI boolean。

【关键洞察】

- 数据结构：一个项目任意时刻只能有一个可写源码来源。
- 复杂度：Editor、Agent、Preview 统一依赖 ProjectRepository，避免按页面散落 storage 分支。
- 风险点：迁移中途双写、浏览器数据丢失、跨标签并发、服务端 Agent 误写 Browser Git。
- 测试策略：只保护 storage guard、revision/CAS、Repository contract、Worker 持久化、Git 状态、迁移原子性和 tool-call 配对等真实不变量。

## 2. 唯一来源原则

| storage kind | 唯一可写源码来源 | Git 能力 |
|---|---|---|
| database_v1 | Postgres project_files | 无 |
| browser_git_v1 | LightningFS/IndexedDB 中的 working tree 与 .git | isomorphic-git |

规则：

1. 项目只能有一个 active storage kind。
2. database_v1 项目只能经 Database adapter 读写。
3. browser_git_v1 项目只能经 Browser Repository Worker 读写。
4. WebContainer 是运行镜像，不是源码 owner，运行产生的文件不得回写 Repository。
5. 迁移准备阶段的 Browser Git candidate 不是 active source；迁移激活前，Database 仍是唯一来源。
6. 迁移成功后禁止静默回退到旧 project_files。
7. 未知 storage kind、状态、action 或协议字段必须明确失败，不做默认映射。

Browser Git 数据流：

~~~text
Monaco save / Agent client tool
            │
            ▼
ProjectRepository
            │
            ▼
Browser Repository Worker
            │
            ▼
LightningFS / IndexedDB  ←→  isomorphic-git
            │
            └──── export files ────▶ WebContainer runtime mirror
~~~

## 3. 当前产品边界

### 3.1 本期目标

1. 新建项目时用户可选择 Database 或 Browser Git。
2. 旧项目默认并继续使用 Database。
3. Database 项目可以由用户主动迁移为 Browser Git。
4. Browser Git 支持文件 CRUD、搜索、status、stage、unstage、commit、log 和 current branch。
5. 刷新页面或重启 Worker 后，本地仓库仍可从 IndexedDB 打开。
6. Editor、Agent 和 Preview 始终读取同一个 active Repository。
7. Browser Git 本地数据缺失时明确显示不可用，不从 Database 猜测恢复。

### 3.2 明确不做

- ZIP repository snapshot。
- Vercel Blob 或其他云端仓库同步。
- 清除站点数据后的恢复。
- 跨浏览器、跨设备恢复。
- GitHub/GitLab remote、fetch、pull、push。
- 多设备 working tree 合并。
- 第一版 Git → Database 迁移。
- 自动 commit。
- 通过时间戳判断哪份代码更新。

这些能力以后若有真实需求，应作为新需求重新设计，不在当前代码中预埋半成品协议。

### 3.3 浏览器存储限制

LightningFS 的数据落在浏览器 IndexedDB：

- 刷新页面：应保留。
- Worker 重启：应保留。
- 正常关闭并重新打开同一浏览器：通常保留。
- 用户清除站点数据：丢失。
- 无痕模式结束：丢失。
- 更换浏览器、域名或设备：不可见。
- 浏览器在存储压力下是否回收：由浏览器策略决定。

产品必须在用户选择 Browser Git 时展示这一限制。后续可以评估 navigator.storage.persist() 和 navigator.storage.estimate()，但它们不是当前已实现能力，也不能被描述成云端备份。

## 4. 用户需求

### R-GIT-1：新建项目选择存储

作为用户，我创建项目时可以选择：

- Database：代码存在服务端数据库，不提供 Git。
- Browser Git：代码存在当前浏览器 IndexedDB，提供 Git。

验收：

- 请求必须显式提供合法 storage kind。
- 未知字段和未知 storage kind 返回 400。
- Browser Git 项目在本地仓库初始化完成前不可进入编辑、预览或 Agent。
- 初始化失败显示明确错误并允许重试或删除。

### R-GIT-2：旧项目兼容

作为旧项目用户，我不做任何操作时，项目行为与改造前一致。

验收：

- 旧行通过 schema migration 明确回填 database_v1。
- 运行时不使用 null fallback 猜 storage kind。
- Database 文件 API、Editor、Agent 和 Preview 继续工作。

### R-GIT-3：Database 项目启用 Git

作为用户，我可以把 Database 项目迁移到 Browser Git。

验收：

- 迁移前先完成 draft/preflight。
- 以一个明确的 Database source revision 读取完整文件集合。
- 在项目最终 namespace 中建立尚未激活的本地 candidate，原样写文件并创建 initial commit。
- 校验路径集合、逐字内容、clean status、HEAD 和 source revision。
- source revision 未变化时才原子切换 storage kind。
- 任一步失败，Database 继续是唯一 active source。
- 激活成功后，Database 文件 API 拒绝对该项目读写。

### R-GIT-4：本地文件编辑

- list/read/search/write/delete/rename 全部通过 ProjectRepository。
- mutation 携带 expectedRevision。
- stale revision 返回明确 conflict，不能静默覆盖。
- 普通文件 API 拒绝 .git/** 与 node_modules/**。
- node_modules 属于 WebContainer runtime，不属于源码 Repository。

### R-GIT-5：Git 操作

- init 必须提供合法 default branch。
- status 返回 isomorphic-git 原始 matrix 语义。
- stage/unstage 只作用于合法 workspace path。
- commit 必须提供明确 author name/email 与非空 message。
- 没有 staged change 时明确失败。
- log 和 current branch 在 Worker 重启后保持一致。

### R-GIT-6：Agent 修改

- Database 项目的文件工具仍在服务端执行。
- Browser Git 项目的文件工具由浏览器执行。
- 后端数据库中的 storage kind 同时决定 system prompt 项目契约与 LLM 可见工具集合。
- Database 项目不向 LLM 暴露 Git 工具。
- Browser Git 项目向 LLM 暴露 status、stage、unstage、commit、log 和 current branch。
- Agent 只有在用户明确要求提交且明确提供 author name/email 时才能 commit；不能猜身份，也不自动提交。
- 服务端只产生严格的 client tool call，不直接接触 Browser Git 源码。
- tool call/result 必须按 toolCallId、tool name 和 schema 严格配对。
- 重复、迟到、跨项目或已关闭的 tool result 必须拒绝。
- 相同 mutation toolCallId 不能重复写。

### R-GIT-7：Preview

- Preview 从 active ProjectRepository 导出文件。
- .git 与 node_modules 不进入预览源码。
- Preview 结果绑定 workspace revision。
- 旧 revision 的运行结果不得触发 Agent 自修复。
- WebContainer 产生的依赖、缓存和输出不回写 Repository。

### R-GIT-8：本地仓库缺失

当 server metadata 表示 browser_git_v1，但当前浏览器没有对应 IndexedDB repository：

- 显示明确的“本地仓库缺失”状态。
- 禁止编辑、Agent、Preview 和 Git mutation。
- 不读取 legacy project_files 伪装恢复成功。
- 当前版本不提供云端恢复。

### R-GIT-9：项目删除

- 服务端项目按现有删除规则处理。
- 浏览器应清理对应 LightningFS namespace。
- 清理失败要显示可诊断错误；不得把其他 project namespace 一并删除。

## 5. 非功能需求

### 5.1 一致性

- 一个项目一个 active storage kind。
- 一个 Browser Git project 一个 Worker-owned filesystem namespace。
- mutation 串行执行并使用 revision CAS。
- Git metadata mutation 必须 flush filesystem。
- storage 切换只能发生在迁移激活事务中。

### 5.2 安全

- LLM key 不进入浏览器或 iframe。
- AI 代码仍只在独立 origin sandbox 执行。
- Worker command、API body 和 tool result 使用 strict schema。
- 路径拒绝绝对路径、空 segment、.、..、NUL、.git/** 和 node_modules/**。
- 不把外部输入自动清洗成另一个合法字段或枚举。

### 5.3 可诊断性

至少区分：

- unsupported storage。
- repository not initialized。
- local repository missing。
- revision conflict。
- protocol violation。
- bad path / reserved path。
- bad Git ref。
- author required。
- nothing to commit。
- migration source changed。

### 5.4 向后兼容

- Database 项目在 Browser Git UI 未使用时保持原行为。
- 新增字段必须通过明确 schema migration 回填。
- Browser Git 未完成 provisioning 前不开放为可编辑项目。

## 6. 状态拓扑

| 事实 | Owner |
|---|---|
| 项目 active storage kind | Postgres project metadata |
| Database 文件与 code revision | Postgres |
| Browser Git working tree / index / objects / refs | Repository Worker + LightningFS |
| Browser Git workspace revision | Repository Worker metadata |
| Editor 未保存 draft | Editor state owner |
| Preview 运行文件 | WebContainer runtime |
| Agent transcript | chat state / server message storage |
| 迁移对话框与执行中状态 | ProjectWorkbenchBody action state |

useEffect 只负责连接外部系统，例如 Worker/WebContainer/window event；storage 切换、revision 接受和 migration transition 必须通过 action/reducer/transaction 表达。

## 7. 已实现契约

### 7.1 Storage kind

types/projectStorage.ts 定义 database_v1 与 browser_git_v1。

项目创建 schema、Project detail 和 Repository descriptor 都是 strict discriminated union。

### 7.2 Project revision/CAS

- projects.code_revision 是 Database 项目的代码版本。
- Database write/delete/rename 需要 expectedRevision。
- revision claim 与文件 mutation 在同一事务。
- 失败 mutation 回滚 revision。
- Browser Worker 维护独立 workspace revision，并要求成功 mutation 精确返回 expected + 1。

### 7.3 ProjectRepository

~~~ts
interface ProjectRepository {
  readonly projectId: string;
  readonly storageKind: ProjectStorageKind;
  getRevision(): number;
  listFiles(): Promise<ProjectFilesSnapshot>;
  readWorkspace(): Promise<ProjectWorkspaceSnapshot>;
  readFile(path: string): Promise<RevisionedProjectFileContent>;
  searchText(query: string): Promise<ProjectTextSearchResult>;
  writeFile(input: WriteProjectFileInput): Promise<RepositoryWriteChange>;
  deleteFile(input: DeleteProjectFileInput): Promise<RepositoryDeleteChange>;
  renameFile(input: RenameProjectFileInput): Promise<RepositoryRenameChange>;
  exportPreviewFiles(): Promise<PreviewWorkspaceSnapshot>;
}
~~~

Database 与 Browser Git adapter 必须通过同一 portable contract。

### 7.4 Browser Repository Worker

已实现：

- per-project LightningFS namespace。
- IndexedDB 持久化。
- command queue 串行化。
- strict request/response schema。
- list/read/search/write/delete/rename。
- revision CAS。
- Git init/status/stage/unstage/commit/log/current branch。
- .git/** 与 node_modules/** guard。
- filesystem flush。

已接入真实用户创建入口与旧 Database 项目迁移入口。

## 8. 新建 Browser Git Provisioning 设计

采用 local-first，不新增服务端 provisioning 状态：

~~~text
用户选择 Browser Git
  → browser 生成 project UUID
  → Worker 显式 provision 专属 namespace
  → git init
  → 验证 repository 可重新打开
  → POST 创建同 UUID 的 browser_git_v1 project
  → 项目 ready
~~~

约束：

1. 本地 provision/init 成功前不创建服务端项目，也不发送第一条 Agent 消息。
2. Browser Git create body 必须携带 client-generated UUID；Database create 不接受该字段。
3. 相同 owner/id/title/storage 的重复 POST 是幂等重试；任何字段不一致返回 conflict。
4. Worker 的 provision 与 open-existing 是不同命令。
5. open-existing 找不到 revision marker 时返回 LOCAL_REPOSITORY_MISSING，禁止创建空仓库。
6. 服务端项目行存在只代表 local init 曾确认成功，不代表存在云端备份。
7. ready 后本地仓库缺失时进入 explicit missing 状态。
8. 不回退到 Database，也不创建空文件数组伪装 ready。
9. POST 响应不确定时保留本地 candidate，避免删掉一个服务端可能已成功引用的唯一来源。

## 9. Database → Browser Git Migration 设计

### 9.1 Preflight

- 保存或明确处理 Editor draft。
- 确认没有活动中的 Database mutation。
- 获取 source code revision 和完整 live files。
- 校验所有路径可以进入 Browser Repository。
- 要求显式 Git author。

### 9.2 Candidate

- 使用项目最终 Browser Git namespace；项目 metadata 仍为 database_v1 时，该 namespace 只是非 active candidate。
- 每次重试先 wipe 整个项目 namespace，再从同一个 Database snapshot 重新导入，禁止夹带上一次残留。
- 初始化 Git。
- 原样写入文件，不改名、不补字段、不改内容。
- stage 全部导入文件。
- 创建 initial import commit。
- 校验 path 集合、每个文件逐字内容、clean status、current branch 和 HEAD。
- local revision 必须严格等于 source revision，激活后 revision 连续递增。

### 9.3 Activate

- 使用明确的 `POST /api/projects/[id]/migrate-browser-git` action route；迁移 body 不再携带用于 Route 分流的 `action` 字段。
- 服务端在事务中重新检查 project owner、当前 storage kind 与 source revision。
- 只有 source revision 与 prepare 时完全一致才切换到 browser_git_v1。
- stale source 返回 conflict，Database 保持 active。
- 激活成功后 Database 文件 API 对该项目返回 storage mismatch。
- candidate 已位于最终 namespace，因此没有激活后的本地 promotion/finalize 步骤。
- importCommitOid 是客户端完成 Git 导入的严格格式证据；服务端不接触 IndexedDB，因此不声称验证 commit 内容。

### 9.4 失败语义

| 失败点 | 结果 |
|---|---|
| preflight 失败 | Database 保持 active |
| candidate 写入/commit/校验失败 | Database 保持 active；重试时 wipe candidate |
| source revision 变化 | Database 保持 active，要求重新迁移 |
| activate 事务失败 | Database 保持 active |
| migrate-browser-git POST 响应不确定 | GET 项目 metadata；只有明确为 browser_git_v1 且本地 candidate 可打开时视为成功 |

因为激活前已经在最终 namespace 完成文件、Git 与重开校验，服务端 CAS 是最后一个有状态步骤，不存在“服务端已切换但本地还要 promotion”的危险窗口。

## 10. Agent Client Tools 设计

~~~text
Postgres projects.storageKind
  ├── system prompt：声明唯一来源、Terminal 边界和 commit policy
  └── LLM tool set：
       database_v1    → 文件工具在服务端执行，不暴露 Git 工具
       browser_git_v1 → 文件工具和 Git 工具在浏览器执行

server LLM loop
  → emit strict client tool call
  → browser validates pending toolCallId
  → ProjectRepository / BrowserGitProjectRepository executes
  → browser posts strict tool result
  → server validates pair and continues loop
~~~

核心不变量：

- toolCallId 唯一。
- tool name 与 result schema 一致。
- projectId 与 active conversation 一致。
- mutation result 带实际 revision。
- 重放 mutation toolCallId 返回之前结果或明确拒绝，不再次写。
- stop 后不启动新 mutation。
- `git_commit` 参数严格要求非空 message 和用户明确提供的 author name/email。
- Git 工具只操作 LightningFS/IndexedDB 中的 canonical repository，不经过 WebContainer Terminal。
- stage/unstage/commit 改变 Git 外部状态后，Source Control 必须重新读取状态。
- Agent `git_status` 只返回变更文件；`head !== stage` 表示 staged change，`workdir !== stage` 表示 unstaged change，空数组表示 clean。

本期 Agent Git 工具为：

- `git_status`
- `git_stage`
- `git_unstage`
- `git_commit`
- `git_log`
- `git_current_branch`

`git_diff` 暂未加入。当前 repository 尚未定义 staged/working-tree diff 的输出格式、二进制文件策略和大小限制，不能用不完整的字符串比较伪装 Git diff。

## 11. Editor、Preview 与 Git UI

### Editor

- draft 由 Editor owner 持有。
- save action 调 Repository mutation。
- conflict 保留 draft，并刷新 active Repository。
- 不用 effect 观察 draft 自动写文件。

### Preview

- action 读取 exportPreviewFiles()。
- mount 到 WebContainer 后运行。
- result 携带启动时 revision；stale result 只展示，不驱动自修。

### Git UI

第一版包括 storage kind、本地存储警告、status、stage/unstage、commit author/message、log 和 local repository missing 状态。

branch create/checkout 尚未拍板，当前只读取 current branch。

## 12. 文件变更树

~~~text
/types
  ├── DONE projectStorage.ts
  ├── DONE projectRevision.ts
  ├── DONE projectRepository.ts
  ├── DONE browserRepositoryProtocol.ts
  ├── DONE browserGitRepository.ts
  └── DONE projectMigration.ts
/lib/projectRepository
  ├── DONE database.ts
  ├── DONE browser.ts
  ├── DONE browserGitWorker.ts
  ├── DONE browserGitWorkerClient.ts
  ├── DONE clientFileToolExecutor.ts
  ├── DONE clientGitToolExecutor.ts
  ├── DONE factory.ts
  └── DONE migrate.ts
/server
  ├── DONE storage-aware system prompt + LLM tool selection
  ├── DONE projectRevisionTransaction.ts
  ├── DONE projectResponse.ts
  ├── DONE Browser Git local-first create + strict client tool result endpoint
  └── DONE storage migration source-revision CAS
/app/api/projects
  ├── DONE Database-compatible project/files routes
  ├── DONE Browser Git client UUID idempotent create
  └── DONE explicit migrate-browser-git POST route
/components
  ├── DONE storage choice UI
  ├── DONE provisioning/missing UI
  ├── DONE Database→Browser Git author/migration UI
  └── PLANNED Git panel
/hooks
  ├── DONE ProjectRepository composition
  ├── DONE Browser Git lifecycle owner
  └── DONE client tool loop
/tests
  ├── DONE unit storage/revision/repository contract
  ├── DONE browser Worker/Git persistence
  ├── DONE provisioning state tests
  ├── DONE migration contract/CAS/real Worker tests
  ├── DONE frontend create/missing/migration E2E
  └── DONE client tool pairing tests
~~~

## 13. 分阶段 TODO

### Phase 1–6：底层基础

- [x] Storage kind strict contract。
- [x] Database revision/CAS。
- [x] ProjectRepository + Database adapter。
- [x] Browser Worker + IndexedDB CRUD/CAS。
- [x] isomorphic-git MVP。
- [x] Worker restart 后文件与 Git 历史保持。
- [x] 明确纯本地存储限制。
- [x] 删除 ZIP/Blob/云端同步实现与 schema。

### Phase 7：新建 Browser Git Provisioning

- [x] 冻结 local-first lifecycle contract，不新增 server provisioning enum。
- [x] 先写 provisioning/open-existing 失败测试。
- [x] 新建 UI 增加 storage 选择与本地限制警告。
- [x] 初始化本地 namespace 与 Git 后创建同 UUID server project。
- [x] 验证 Worker 重开。
- [x] Browser Git create exact retry 幂等。
- [x] missing/retry UI。
- [x] 阻止第一条 Agent 消息直到 repository ready。

### Phase 8：Database → Browser Git Migration

- [x] 冻结 strict migration route/body/Worker contract。
- [x] source revision/CAS 状态测试。
- [x] draft 与显式 Git author preflight。
- [x] final namespace inactive candidate + retry wipe。
- [x] initial import commit（包括空项目）。
- [x] path/content/status/branch/HEAD 校验。
- [x] source revision CAS activate。
- [x] Database API storage guard 返回明确 409。
- [x] 消除激活后 finalize：激活前已在最终 namespace 验证。
- [x] legacy files 只读保留且永不 fallback。

### Phase 9：Agent Client File / Git Tools

- [x] 按 storage kind 选择执行域。
- [x] Browser Git 六个文件工具转 client call。
- [x] system prompt 直接声明 Database/Browser Git 权威能力。
- [x] Database 不暴露 Git tools；Browser Git 暴露本地 Git tools。
- [x] Browser Git status/stage/unstage/commit/log/current branch 转 client call。
- [x] commit author/message strict schema；不猜身份、不自动提交。
- [x] strict tool result endpoint。
- [x] duplicate/late/out-of-order/cross-project guard。
- [x] mutation idempotency。
- [x] stop semantics。

### Phase 10：Editor、Preview 与 Git UI

- [ ] draft/save/conflict。
- [ ] Preview revision binding。
- [x] VS Code 风格 Activity Bar、Primary Sidebar、中央 Editor/Preview、Bottom Panel 与右侧 Agent。
- [x] Git status/stage/unstage/commit/log Source Control panel。
- [x] 共享 WebContainer 的 jsh 交互终端。
- [x] Terminal 明确标注为 runtime mirror；终端文件写入不回写 Repository，Git 操作不走 WebContainer。
- [x] Agent system context 按 storageKind 声明权威 capability；Browser Git 文件 mutation 只修改 working tree，不自动提交。
- [x] local storage warning。
- [x] repository missing UI。
- [x] 新建、missing 与 Database→Browser Git 关键前端 E2E。

### Phase 11：生命周期与后续决策

- [ ] project delete 清理 namespace。
- [ ] candidate/migration cleanup。
- [ ] legacy files 按确认周期清理。
- [ ] 评估 persistent storage API。
- [ ] 根据真实需求决定 remote 或云同步，不提前实现。

## 14. 测试策略

必须自动化：

- strict storage/schema。
- Database mutation CAS 与 transaction rollback。
- Database/Browser adapter portable contract。
- Worker command serialization、project isolation、reserved paths。
- IndexedDB 在 Worker restart 后保留。
- Git init/status/stage/unstage/commit/log 持久化。
- provisioning lifecycle 幂等。
- migration source revision conflict 不切换 storage。
- migration 成功后 Database API 拒绝读写。
- client tool call/result 严格配对与 mutation 幂等。
- stale Preview 不触发 Agent 自修。

不新增纯文案、简单标签/图标、重复类型检查或已被 shared contract 覆盖的测试。

验证命令：

~~~bash
pnpm test:unit
pnpm test:browser
pnpm exec tsc --noEmit
pnpm build
git diff --check
~~~

## 15. 待确认决策

1. 第一版迁移 author 已决定每次显式输入且不持久化；以后是否保存为 owner/project 偏好是独立需求。
2. legacy project_files 当前只读保留且永不 fallback；自动清理周期仍需产品确认。
3. 第一版是否支持 branch create/checkout。
4. 跨标签页使用单写 lease，还是第一版明确禁止同时打开同一 Git 项目。
5. 跨标签页单写策略确认前，Browser Git 不声称支持同项目多标签并发编辑。

这些决策没有权威答案时，停止对应代码，不写默认兜底。

## 16. 验收清单

- [x] 旧 Database 项目不受 storage 抽象影响。
- [x] Browser Repository 文件与 Git 基础能力在真实 Chromium 工作。
- [x] Worker restart 后 IndexedDB 文件、HEAD、status 和 log 保持。
- [x] 普通文件 API 不能写 .git/** 或 node_modules/**。
- [x] 当前代码不包含 repository ZIP/Blob/cloud sync。
- [x] 用户可以新建 ready Browser Git 项目。
- [x] 用户可以安全迁移旧 Database 项目。
- [x] Agent 可以修改 Browser Git 项目。
- [x] Agent 可以读取并操作 Browser Git status/index/history，用户明确授权和作者身份后可以 commit。
- [ ] Editor、Preview 与 Git UI 完成闭环。
- [x] 用户可在 Source Control 显式暂存和提交，Terminal 可运行项目命令且不成为第二文件源。
- [x] 本地仓库缺失时明确失败且不回退 Database。
