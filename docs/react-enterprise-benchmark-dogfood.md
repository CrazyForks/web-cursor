# React Enterprise Benchmark：项目规格与真实 Agent 测试日志

> 状态：进行中
> 测试日期：2026-08-10
> 被测产品：Web Cursor 本地真实前端
> 测试方式：通过浏览器与真实 Agent 对话，不 mock `/api/chat`，不直接修改被测项目代码
> 目的：创建一个会持续长大的 React 项目，检验 Agent 在多文件、跨模块、连续对话和真实预览中的能力边界。

## 1. 为什么创建这个项目

当前单元测试和协议测试能证明工具、AgentRun、停止、checkpoint 与上下文压缩是否按契约工作，但不能证明 Agent 能否长期维护一个较大的 React 项目。

本项目不是为了堆文件数，而是建立一个可重复扩展的真实测试对象，持续检验四件事：

1. Agent 能否先理解已有结构，再定位正确文件。
2. Agent 能否完成跨类型、数据、状态、组件和页面的修改。
3. Agent 能否通过预览发现并修复自己引入的问题。
4. 对话变长、项目变大后，Agent 是否仍能保持需求和架构一致性。

## 2. Benchmark 项目定义

项目名称：`Northstar Commerce Admin`

产品形态：桌面优先、支持移动端的电商运营管理后台。

首轮目标不是一次生成完整企业系统，而是生成一个可运行的骨架，再通过连续对话逐步增加模块。最终目标规模：

- 8 个业务域；
- 25～40 个页面；
- 120～200 个源文件；
- 2～4 万行代码；
- 具备真实跨模块数据关系和可操作界面；
- 所有数据使用项目内 mock，不依赖外部服务。

### 2.1 业务域

1. Dashboard：销售额、订单量、库存告警和趋势。
2. Products：商品列表、详情、状态和分类。
3. Orders：订单列表、详情、状态流转和退款。
4. Customers：客户列表、详情、标签和历史订单。
5. Inventory：库存、仓库和补货告警。
6. Campaigns：优惠活动、时间范围和适用商品。
7. Notifications：业务通知、已读状态和筛选。
8. Settings：成员角色、权限、店铺和界面设置。

### 2.2 首轮必须交付

- 完整后台布局：侧边栏、顶部栏、内容区和移动端导航。
- Dashboard 页面。
- Products、Orders、Customers 三个模块的列表页。
- 统一的 mock 数据层。
- 共享表格、状态标签、指标卡和空状态组件。
- 页面切换、搜索和筛选至少可实际交互。
- 不使用外部图片或网络 API，避免预览结果依赖网络。

### 2.3 后续连续任务

| 阶段 | 任务 | 主要检验能力 |
|---|---|---|
| 1 | 创建可运行骨架 | 初始规划、多文件创建、首次预览 |
| 2 | 增加商品详情和编辑 | 理解既有结构、表单状态、路由 |
| 3 | 订单取消后恢复库存 | 跨 Orders 与 Inventory 的业务修改 |
| 4 | 增加角色权限 | 跨菜单、页面、按钮的权限一致性 |
| 5 | 制造并修复请求竞态 | 运行问题定位和自主修复 |
| 6 | 完成移动端适配 | 跨页面视觉一致性 |
| 7 | 长对话后修改早期模块 | checkpoint 压缩后的需求保持 |

## 3. 检查基准

每轮对话记录以下结果：

| 检查项 | 通过条件 |
|---|---|
| 需求理解 | 没有遗漏明确约束，没有擅自改变业务语义 |
| 修改范围 | 修改与任务相关，不用无关重构扩大变更 |
| 项目结构 | 复用已有模块与共享能力，不重复造同类组件 |
| 工具使用 | 先读取/搜索再修改；工具调用有明确闭合结果 |
| 可运行性 | 预览成功，无阻断性运行错误 |
| 自主修复 | 自身引入错误时能读取证据并继续修复 |
| 用户可见进度 | 能看出 Agent 正在读取、修改、验证还是修复 |
| 连续迭代 | 后续任务能基于已有实现修改，而不是重写项目 |

## 4. 测试会话记录

### Round 1：创建项目骨架

状态：失败，可通过新一轮对话继续。

计划发送给 Agent 的需求：

> 创建一个名为 Northstar Commerce Admin 的大型电商运营后台骨架。使用 React + TypeScript 和项目现有运行环境。第一轮只完成 Dashboard、Products、Orders、Customers 四个页面，以及侧边栏、顶部栏、移动端导航、共享表格、指标卡、状态标签和项目内 mock 数据层。页面切换、搜索和筛选必须真实可操作。不要调用外部 API，不要使用外部图片。请采用可继续扩展到 Inventory、Campaigns、Notifications、Settings 的领域结构，完成后通过 Preview 验证并自行修复运行错误。

实际结果：

- 项目成功创建，项目 ID：`89d67f7b-53b8-4446-b476-7789b2763a98`。
- Agent 用约 5.2 分钟执行了 16 个模型轮次和 16 个工具轮次。
- 写入 15 个文件，包括项目配置、全局样式、mock 数据、导航状态、共享组件，以及 Dashboard、Products、Orders 页面。
- 在继续创建 Customers 页面、`App.tsx` 和 Preview 验证前耗尽模型轮次预算。
- 持久 AgentRun 状态为 `failed`，权威失败码为 `BUDGET_EXHAUSTED`，失败信息明确指出 model-round budget exhausted。
- 前端只显示 `Backend call failed`，没有显示预算耗尽、已完成范围或继续建议。
- Agent 没有执行 Preview，因此 Round 1 不满足可运行交付标准。

阶段判断：项目没有丢失，已写入文件可以继续使用；下一轮必须要求 Agent 先检查现有文件，只补齐缺失部分并执行 Preview，禁止重建已经存在的模块。

### Round 2：从预算耗尽处恢复

状态：通过。

计划发送给 Agent 的需求：

> Continue the existing Northstar project from the current files. Do not recreate completed files. First inspect what is missing, then finish Customers, App wiring, and any required entry files. Run Preview, inspect build/runtime errors, and repair them. Keep this iteration strictly scoped to making the original four-page skeleton complete and runnable.

实际结果：

- Agent 没有重建首轮已经完成的文件，先检查现状并准确识别出只缺少 `src/pages/CustomersPage.tsx` 和 `src/App.tsx`。
- 本轮只创建上述 2 个文件，项目文件数从 15 增加到 17，修改范围符合要求。
- Agent 成功调用 Preview，项目可以运行。
- 独立验证四个页面均可通过导航切换：Dashboard、Products、Orders、Customers。
- Products 页的局部搜索可用：输入 `Wireless` 后，结果从 12 条收敛为 1 条，只保留 `Wireless Headphones`。
- Customers 页的全局搜索可用：输入 `Alice` 后，结果收敛为 1 条，只保留 `Alice Johnson`。
- 预览宽度小于 1024px 时，侧边栏收起为移动菜单；通过“Open menu”可以打开导航并切换页面。
- 浏览器日志中没有 `error` 或 `warn`。

阶段判断：持久项目数据确实支持跨 AgentRun 续做。第二轮能读取并复用第一轮的 15 个文件，不需要 checkpoint 才能完成这种“用户主动继续”的恢复；checkpoint 和上下文压缩主要解决的是单个长对话继续增长后的输入预算问题。

### Round 3：库存与取消订单的跨模块联动

状态：核心业务通过，Agent 自主验证未通过。

计划发送给 Agent 的需求：

> Continue the existing Northstar Commerce Admin. Do not recreate completed files and do not add an HTTP backend. First inspect the current Product and Order contracts and the existing navigation/state structure. Add an Inventory page, then implement order cancellation with shared in-memory React state.
>
> Define an explicit OrderItem contract with productId and quantity, and add explicit line items to every mock order; do not infer inventory restoration from the existing aggregate item count. Only pending and processing orders are cancellable. Cancelling an order must atomically change its status to cancelled and restore each referenced product's stock by the exact ordered quantity. Products and Inventory must read the same stock state. A cancelled order must not be cancellable again, and shipped, delivered, refunded, or already-cancelled orders must not change inventory.
>
> Keep one clear business entry point for cancellation, avoid duplicate state per page, do not add a state-management dependency, and preserve the existing four pages and interactions. Add Inventory to navigation with stock search and low-stock filtering. Run Preview when finished, exercise one cancellable order, and verify in the UI that the matching inventory values increase exactly once. Inspect build/runtime errors and repair any errors you introduced.

验收条件：

1. 现有四个页面和交互不回归，新增 Inventory 页面可导航。
2. 每个订单都有明确的 `OrderItem[]`，库存变化不依赖聚合数量猜测。
3. Products 与 Inventory 读取同一份库存状态。
4. 只有 `pending`、`processing` 可以取消。
5. 一次取消同时更新订单状态和所有关联商品库存。
6. 同一订单不能重复恢复库存；不可取消状态不能改变库存。
7. Preview 成功，真实操作和浏览器日志验证通过。

实际结果：

- Agent 先读取现有数据、导航和页面结构，再给出逐文件计划；没有重建项目。
- 修改 8 个现有文件并新增 `src/app/store.ts`、`src/pages/InventoryPage.tsx`，项目从 17 个文件增长到 19 个文件。
- `Order` 的聚合 `items` 被明确的 `OrderItem[]` 替代；每个 mock 订单都包含确定的 `productId` 与 `quantity`。
- 新增单一共享内存 store，Products、Orders、Inventory、Dashboard 订阅同一份 products/orders 状态。
- 新增 Inventory 导航、库存搜索和 `<20` 低库存筛选。独立验证筛选结果为 2 条：库存 0 的 Stainless Steel Water Bottle 和库存 15 的 Smart Watch Series X。
- 独立验证 ORD-1004：取消前 Leather Wallet 库存为 180，订单状态为 `pending`；点击一次 Cancel 后订单变为 `cancelled`、按钮消失，Inventory 和 Products 中库存均变为 181。
- 再次进入 ORD-1004 时不存在 Cancel 按钮，无法重复恢复库存。
- 浏览器日志中没有 `error` 或 `warn`。
- Agent 虽然调用了 Preview，却没有按需求亲自取消订单并检查库存，只在最终回答中列出“如何验证”；该验收项由外部测试补做，详见 ISSUE-002。

阶段判断：跨 Orders、Products、Inventory 的共享状态和业务联动已经成立，说明案例开始具备真实维护价值；但 Agent 仍会把明确要求的运行验证降级成验证说明，不能仅凭它的完成声明判断任务通过。

### Round 4：从 Demo 扩展为中型领域项目

状态：通过；发现并修复两次回归，Agent 的成功声明仍需外部核验。

目标：把当前 19 文件的页面 Demo 扩展为约 45～60 个文件的中型 React 项目。新增文件必须对应真实职责，不允许通过空壳、转发文件或重复组件凑数量。

计划发送给 Agent 的需求：

> Expand the existing Northstar Commerce Admin from a 19-file demo into a maintainable medium-sized React and TypeScript application. Preserve every working flow from the existing Dashboard, Products, Orders, Customers, and Inventory pages. Do not add an HTTP backend, external APIs, a state-management dependency, or placeholder files. Aim for roughly 45–60 source/config files only through real responsibilities; do not create empty wrappers, barrel-only files, or duplicate components.
>
> First inspect the existing contracts, shared store, navigation, components, and styles. Then reorganize incrementally around `domains/products`, `domains/orders`, `domains/inventory`, and `shared` without rewriting working behavior from scratch.
>
> Product Catalog vertical slice: add product detail, create, and edit flows; explicit category and variant data; validated name, SKU, category, price, and stock fields; duplicate-SKU rejection; unsaved-change protection; and create/edit results that immediately appear in Products and Inventory.
>
> Order vertical slice: add order detail with explicit line items and a status timeline; replace immediate cancellation with a confirmation dialog that lists the exact inventory quantities to restore; show success feedback; keep pending/processing as the only cancellable statuses; and preserve exactly-once inventory restoration.
>
> Inventory vertical slice: add warehouse data, manual stock adjustment with a required reason, and an inventory movement ledger. Every product starts in a defined warehouse. Product creation creates its initial stock movement, manual adjustments create signed movements, and order cancellation creates one restock movement per affected line item. Products, Inventory, order details, and the movement ledger must read one shared state.
>
> Shared UI: add reusable Modal, Toast, Tabs, Breadcrumbs, FormField, EmptyState, and PageHeader components only where they are genuinely reused. Keep state ownership clear: business state belongs to one commerce store/provider; draft form state belongs to the form; modal state belongs to the invoking flow. Avoid effects that merely copy React state into other React state.
>
> Keep files focused and normally below 250 lines. Split the current oversized seed data and styles by real domain responsibility while preserving behavior. Use explicit contracts and business result types; do not guess or silently normalize unknown values. Run Preview, inspect build/runtime errors, and repair them. If the Preview tool cannot perform interactive verification, say so explicitly instead of claiming the workflows were exercised. In the final response, list the resulting file count, the main domain boundaries, and the exact workflows that were actually verified.

验收条件：

1. 项目达到约 45～60 个有实际职责的文件，不靠空文件或重复组件凑数。
2. 原有五页导航、搜索、筛选和订单取消库存联动不回归。
3. 创建/编辑商品后 Products 与 Inventory 同步，重复 SKU 被明确拒绝。
4. 订单取消先展示影响明细，确认后更新状态、库存和 movement ledger，且只能执行一次。
5. 手工库存调整必须填写原因并生成带正负数量的 movement。
6. 业务状态只有一个 owner；表单草稿和弹窗状态留在各自交互边界。
7. Preview 构建成功，无阻断性运行错误；Agent 不得虚构未执行的交互验证。

实际结果：

- 项目文件树最终显示 **50 个文件**，达到本轮 45～60 个文件的目标。文件按 `domains/products`、`domains/orders`、`domains/inventory`、`domains/customers`、`shared`、`data`、`styles` 和 `pages` 划分。
- 文件增长来自实际职责拆分：商品筛选/表格/表单/详情、订单表格/详情/取消确认、库存表格/调整弹窗/流水、分域 seed 数据和分层样式；没有发现为空的占位文件或仅做 re-export 的 barrel 文件。
- 商品流程通过：重复 SKU `WH-1000XM5` 会显示明确错误；创建 `Benchmark Camera`（SKU `BENCH-CAM-001`、初始库存 7）后，Products 和 Inventory 同时出现该商品，movement ledger 生成 `Initial +7`；编辑为 `Benchmark Camera Pro` 后库存仍为 10。
- 商品表单的未保存修改保护通过：新建表单发生修改后离开，会出现丢弃确认。
- 库存流程通过：空原因提交时弹窗保持打开并显示 `Reason is required.`；填写 `Final regression check` 后，Wireless Headphones 库存由 125 增至 127，并新增 `Manual Adjust +2` 流水。
- 订单流程通过：取消 `ORD-1004` 前先展示确认弹窗，明确 Leather Wallet 将恢复 `+1`、新库存为 181；确认后订单变为 `Cancelled`，取消按钮消失，并新增一条 `Restock +1` 流水。
- 第一次扩展后，Agent 错误地引用历史 `SERVER_READY` 宣称 Preview 成功；外部强制新开 Preview 后发现多处错误导入，旧 Dashboard 只是热更新失败后的残留界面。把错误证据回填给 Agent 后，Agent 修正导入并恢复可运行状态，详见 ISSUE-004。
- 从 37 个文件继续拆分到 50 个文件时，`StockAdjustmentDialog` 一度丢失“原因必填”的可见错误，`StockLevelsTable` 还出现无实际行为的可点击商品名。外部测试发现后，Agent 只修改库存弹窗、库存表格和 Inventory 页面，恢复校验并删除假交互。
- 最终使用全新的 Preview run 13 回归 Dashboard、Products、Inventory、Orders。商品页可打开且显示 12 条 seed 商品；手工调整与订单取消的两条流水同时存在；09:00 后浏览器日志没有新的 error。

阶段判断：项目已经从 19 文件 Demo 扩展为可继续增长的 50 文件中型案例，且具备商品、订单、库存之间的真实业务关系。Agent 能在明确证据下修复跨文件错误，但仍会把历史 Preview 成功当成当前成功，不能省略外部的新运行与交互验收。

### Round 5：角色权限与团队管理

状态：通过；发现并修复只读操作入口问题，宿主控制台问题单独保留。

目标：在现有 50 文件项目上增加真正跨导航、页面和业务动作的权限系统。默认管理员必须保持 Round 4 的全部能力；权限判断必须来自一份显式契约，不能在各页面散落角色字符串。

计划发送给 Agent 的需求：

> Continue the existing 50-file Northstar Commerce Admin. Preserve all verified Round 4 behavior. Add a complete client-side role and permission vertical slice without an HTTP backend, authentication service, new state-management dependency, or placeholder files.
>
> Define explicit role and permission constants and derive their TypeScript types from those constants. Use exactly three roles: Admin, Operations, and Warehouse. Keep one authoritative permission map and one current-session role owner; pages and components must ask the same permission function instead of comparing role strings themselves.
>
> Permissions: Admin can access every existing page and perform every existing action. Operations can access Dashboard, Products, Orders, Customers, and read Inventory; they can create/edit products and cancel eligible orders, but cannot manually adjust stock or manage team roles. Warehouse can access Dashboard, read Products, and access Inventory; they can manually adjust stock, but cannot access Orders or Customers, create/edit products, cancel orders, or manage team roles.
>
> Add a visible role switcher in the top bar for this benchmark. Switching roles must immediately update sidebar visibility and all guarded actions. If the current page becomes inaccessible, navigate to Dashboard; never leave forbidden content visible. Hiding a sidebar item is not sufficient: centralize page access in the page router and render a clear access-denied state for any denied page request.
>
> Add an Admin-only Team & Roles page backed by explicit mock members in the shared in-memory store. Admin can change another member's role among the three exact roles and gets success feedback. Non-admin roles must not see the navigation entry and must not be able to perform the assignment action. The role switcher changes only the current benchmark session role; team assignments are separate business data.
>
> Apply permissions to the existing real actions: Add Product, Edit Product, Cancel Order, and manual stock adjustment. Read-only users must still be able to view the permitted lists and detail pages. Do not silently no-op denied actions; if a guarded action can still be invoked programmatically, return or display an explicit denial result.
>
> First inspect the existing navigation, store, Topbar, Sidebar, page router, product/order/inventory action entry points, and shared UI. Reuse the current state topology. Keep new files focused and split only real responsibilities. Run a fresh Preview after the final write and report the exact file count and only what was actually verified; do not cite an older SERVER_READY result.

验收条件：

1. 默认 Admin 下 Round 4 的商品、订单、库存能力不回归。
2. Operations 看不到 Team，不能调整库存，但仍可创建/编辑商品和取消订单。
3. Warehouse 看不到 Orders、Customers、Team，Products 为只读，Inventory 可调整。
4. 角色切换后导航、当前页面和动作权限同步更新，不残留无权页面。
5. 页面访问与业务动作都有集中权限保护，不能只靠隐藏按钮。
6. Admin 可在 Team & Roles 修改成员角色；当前会话角色与成员业务数据互不混淆。
7. 最后一次写入后启动全新 Preview，并由外部测试真实操作三种角色和关键动作。

实际结果：

- 项目文件树从 50 增长到 **58 个文件**，新增 `domains/auth`、会话角色 owner、团队 store/seed、Team 页面和角色样式。Agent 最终回答写成 57 个文件，与项目树权威计数不一致。
- 新增唯一角色集合 Admin、Operations、Warehouse，以及集中 permission map、页面权限映射和 `canPerform` / `canAccessPage` / `usePermission` 入口。侧栏、页面路由和业务页面使用同一权限来源。
- Admin 验证通过：可看到所有原有页面和 Team & Roles；把 Marcus Webb 从 Operations 改为 Warehouse 后出现成功反馈，离开 Team 再返回仍保持修改；团队成员角色变更没有改变当前 Admin 会话角色。
- Operations 验证通过：可访问 Dashboard、Products、Orders、Customers 和只读 Inventory；Products 保留 Add/Edit，Orders 显示 3 个可取消操作；Inventory 修复后不再渲染动作列或 `+/-` 按钮。
- Warehouse 验证通过：从 Orders 切换为 Warehouse 后立即返回 Dashboard；Orders、Customers、Team 三个导航入口消失；Products 不显示 Add/Edit，但仍可通过商品名查看；Inventory 保留 12 个调整入口，实际将 Wireless Headphones 从 125 调整为 126，并生成 `Manual Adjust +1 / Warehouse cycle count` 流水。
- 外部首次验证 run 17 时发现 ISSUE-005：Operations 的库存调整按钮和 Warehouse 的商品编辑按钮仍然显示，点击后才拒绝。Agent 随后只修改两张表和两个页面接线；最终 run 18 中 Operations 调整按钮为 0、Warehouse 编辑按钮为 0，业务 handler 的拒绝检查仍保留。
- 角色切换时页面权限同步生效：Admin 的 Team 页面切换为 Operations、Operations 的 Orders 页面切换为 Warehouse，都会自动回 Dashboard，不残留无权页面。
- 最终强制启动全新 Preview run 18，三种角色的上述交互均由外部实际执行。生成项目最终页面没有阻断性运行错误；Web Cursor 宿主页面曾记录 5 次 React 最大更新深度错误，单独记录为 ISSUE-006，不能归因给 Northstar Preview。

阶段判断：角色权限已经成为真实的跨模块纵向切片，不只是菜单显隐。项目具备集中权限契约、会话角色、页面保护、动作保护和独立团队业务数据；同时再次证明 Agent 的“已隐藏”和文件计数声明都必须由最新 Preview 与项目树外部核验。

### Round 6：Campaigns 与跨页面促销价格

状态：完成。最终外部验收使用全新 Preview run 24，项目树实测为 66 个文件。

目标：把占位的 Campaigns 导航扩展为真实促销业务域，让活动生命周期、商品选择、冲突规则、价格展示和角色权限形成一条可操作闭环。商品原价必须保持不变，活动价只能由活动状态派生。

计划发送给 Agent 的需求：

> Continue the existing 58-file Northstar Commerce Admin and preserve all verified Round 5 behavior. Replace the Campaigns placeholder with a complete client-side campaign vertical slice. Do not add an HTTP backend, external API, date library, state-management dependency, placeholder file, or duplicated permission system.
>
> Define explicit constants and derived TypeScript types for campaign status. Use exactly Draft, Active, and Paused. A campaign has an explicit id, name, integer discountPercent, startDate, endDate, productIds, and status. Keep product base price unchanged. Effective sale price must be derived from an Active campaign, rounded to two decimals, and exposed through one campaign pricing helper.
>
> Add one campaign store as the owner of campaign data, with a subscription mechanism so Campaigns, Products, product detail, and Dashboard update immediately. Seed one Active campaign on a small explicit product set so cross-page pricing is visible immediately. Do not copy campaign state into the commerce store.
>
> Campaign list: status filter, product/name search, affected product count, date range, discount, status badge, and real create/view/edit actions. Campaign form: required name, integer discount from 1 through 90, valid start and end dates with start <= end, and at least one explicitly selected product. New campaigns start as Draft. Draft and Paused campaigns are editable; Active campaigns are read-only until paused.
>
> Lifecycle: Draft can activate; Active can pause; Paused can activate. Activating must reject a campaign if any selected product is already in another Active campaign, and the error must name the conflicting campaign and products. A failed activation must not partially change status or prices. Pausing removes its sale prices immediately.
>
> Cross-page behavior: Products list and product detail show the base price and effective sale price only while an applicable campaign is Active. Dashboard adds an Active Campaigns metric and discounted-product count derived from the campaign store. Existing orders remain historical and must not recalculate totals.
>
> Permissions: extend the existing single permission map. Admin and Operations can access Campaigns and create/edit/activate/pause campaigns. Warehouse cannot access Campaigns and must not see its navigation entry, but can still read resulting sale prices on Products. Do not compare role strings inside pages.
>
> Move Campaigns out of Coming Soon into a real navigation section. Preserve Notifications as the remaining placeholder. Keep page access protected by the existing router guard and keep denied business action handlers explicit even when buttons are hidden.
>
> First inspect the existing permission contract, Sidebar, App page router, product contracts/store, Products list/detail, Dashboard metrics, shared form/table/status UI, and styles. Reuse current boundaries and split only genuine responsibilities. Run a genuinely fresh Preview after the final write. In the final response, report the exact file count from the project state and only workflows actually verified; do not cite an older SERVER_READY.

验收条件：

1. Campaigns 成为真实页面，不再跳回 Dashboard；Admin 和 Operations 可见，Warehouse 不可见。
2. 表单拒绝空名称、非法折扣、反向日期和未选商品，新活动固定从 Draft 开始。
3. 激活后 Products 列表与详情立即显示活动价，基础价格不被覆盖；暂停后活动价立即消失。
4. 两个活动不能同时覆盖同一商品；冲突激活原子失败并明确指出活动和商品。
5. Dashboard 的活动数和折扣商品数随启停同步变化，历史订单金额不变化。
6. Campaigns、Products、Dashboard 订阅同一 campaign store，不复制活动状态到 commerce store。
7. 最后一次写入后启动全新 Preview，并由外部测试真实操作创建、激活、冲突、暂停和三角色权限。

实际结果：

- Agent 增加 Campaign 领域、campaign store、活动列表/表单/详情，并接入 Sidebar、Dashboard、Products 列表与商品详情。最终项目树由 Round 5 的 58 个文件扩展到 66 个文件。
- 全新 Preview run 24 中，初始活动数为 1、折扣商品数为 3；`Wireless Headphones` 保留 `$349.99` 原价并派生 `$297.49` 活动价。`ORD-1001` 仍为历史金额 `$379.98`，没有被活动价重算。
- 表单空提交会明确显示 `Campaign name is required.`；折扣、日期顺序和至少一个商品的校验逻辑也已落在同一表单提交契约中。由于当前自动化通道对原生 `date` 输入的填充不稳定，本轮没有把“新建活动成功”作为外部已验证结论，而是使用已有 Draft 活动验证后续生命周期。
- 外部实际把 `Apparel Clearance` 从 Draft 激活为 Active，Dashboard 从 `1 / 3 discounted products` 更新为 `2 / 5 discounted products`，商品列表同步显示服装活动价；Warehouse 虽无 Campaigns 入口，仍能看到活动价。
- 外部把 `Apparel Clearance` 暂停、加入 `Wireless Headphones` 后尝试重新激活。最终提示精确为 `Campaign "Summer Electronics Sale" already covers: Wireless Headphones.`，活动保持未激活，证明冲突失败原子化。
- 首次实现发现三处业务反馈问题：Paused 被显示为 Shipped、冲突提示遗漏商品名、Sidebar 活动数要等导航才刷新。Agent 按外部复现结果做最小修复；run 24 中 Paused 标签、结构化冲突结果和 Sidebar 订阅均回归通过，详见 ISSUE-007 至 ISSUE-009。
- Admin 与 Operations 均可进入并管理 Campaigns；Warehouse 切换时从 Campaigns 自动回 Dashboard，Campaigns 导航数量为 0，但 Products 中仍可读取活动价。
- 生成项目 iframe 未出现运行错误；宿主 Web Cursor 仍出现 ISSUE-006 的最大更新深度错误。

阶段判断：Campaigns 已经形成“活动状态 → 冲突规则 → 派生价格 → Dashboard/Products → 角色权限”的完整跨页面切片。更重要的是，这轮再次证明 `SERVER_READY` 只代表能构建，不能替代真实业务操作；三个用户可见问题都只有在外部实际启停活动后才暴露。

## 5. 已发现问题

| 编号 | 严重程度 | 分类 | 状态 | 标题 |
|---|---|---|---|---|
| ISSUE-001 | Medium | UX / Agent progress | Resolved | 大任务耗尽预算后，前端只显示 `Backend call failed` |
| ISSUE-002 | Medium | Agent instruction following | Open | Agent 把明确要求的 Preview 操作验证改成了“如何验证”说明 |
| ISSUE-003 | Medium | Generated project UX | Resolved | 取消订单无确认或撤销，单击后立即执行不可逆操作 |
| ISSUE-004 | High | Agent verification | Open | Agent 宣称 Preview 构建成功，但实际仍有阻断性导入错误 |
| ISSUE-005 | Medium | Generated project UX / Permissions | Resolved | 只读角色仍显示无权执行的商品编辑和库存调整按钮 |
| ISSUE-006 | Medium | Web Cursor host / Console | Open | Round 5 执行期间宿主页面重复出现 React 最大更新深度错误 |
| ISSUE-007 | Medium | Generated project UX / Status | Resolved | Paused Campaign 被错误显示为 Shipped |
| ISSUE-008 | Medium | Generated project UX / Validation | Resolved | Campaign 激活冲突提示遗漏具体商品名 |
| ISSUE-009 | Low | Generated project UX / Reactivity | Resolved | Sidebar 的 Active Campaign 数量不会立即刷新 |

### ISSUE-001：大任务耗尽预算后，前端隐藏真实失败原因和恢复路径

| 字段 | 内容 |
|---|---|
| 严重程度 | Medium |
| 分类 | UX / Agent progress |
| 页面 | `/p/89d67f7b-53b8-4446-b476-7789b2763a98` |

**现象**

Agent 在完成 15 个文件后耗尽 16 个模型轮次预算。数据库中的 AgentRun 已准确记录 `BUDGET_EXHAUSTED`，但用户界面只显示 `Backend call failed`。用户无法判断已经完成了什么、为什么停止、现有文件是否安全，以及应该点击重试还是发送“继续”。

**复现步骤**

1. 从首页创建 Database 项目，并发送 Round 1 的大型多文件需求。
2. 等待 Agent 连续写入文件。
3. Agent 达到 16 个模型轮次后停止。
4. 观察聊天尾部只显示 `Backend call failed`，且未执行 Preview。

**期望结果**

前端应根据持久失败码显示明确状态，例如“本轮已达到执行预算，已保留 15 个文件；可继续完成剩余任务”，并列出已完成阶段、未完成阶段和明确的继续入口。它不应该把可恢复的预算终止表现成模糊的后端故障。

**当前绕过方式**

发送新消息，明确要求读取现有文件并从未完成处继续。

**处理结果**

已移除 AgentRun 的 16 轮硬限制。`modelRounds` 和 `toolRounds` 只保留为进度与诊断计数，不再用于终止运行，因此该问题不再能通过固定轮次复现。用户停止、执行租约和上下文压缩仍按原有逻辑工作。

### ISSUE-002：Agent 没有执行明确要求的 Preview 业务验证

| 字段 | 内容 |
|---|---|
| 严重程度 | Medium |
| 分类 | Agent instruction following |
| 页面 | `/p/89d67f7b-53b8-4446-b476-7789b2763a98` |

**现象**

Round 3 明确要求 Agent 在 Preview 中取消一个可取消订单，并验证对应库存只增加一次。Agent 调用了 Preview，但最终只输出“Go to Orders… Click Cancel… Navigate to Inventory”的人工验证步骤，没有实际执行这些交互，也没有提供取消前后证据。

**影响**

用户看到“项目构建并成功运行”容易误以为核心业务已经验证。实际上，订单状态更新、跨页面库存同步和防重复取消都需要外部测试再次操作才能确认。

**期望结果**

当需求明确要求运行验证时，Agent 应继续执行 Preview 工具交互，把具体订单、变更前库存、变更后库存和第二次取消结果作为 tool result 回填后再宣布完成。如果当前 Preview 工具不支持点击生成页面，应明确说明能力边界，不能把未执行的操作写成完成结果。

### ISSUE-003：取消订单缺少确认或撤销

| 字段 | 内容 |
|---|---|
| 严重程度 | Medium |
| 分类 | Generated project UX |

**现象**

订单表格中的 Cancel 是直接执行按钮。用户单击后没有确认对话框、影响说明或撤销入口，订单立即变成 `cancelled` 并恢复库存。

**期望结果**

执行前应至少显示确认对话框，明确订单编号和将恢复的商品数量；确认后再原子更新订单与库存。取消成功后应显示结果反馈。该问题属于 Agent 生成项目的产品质量问题，不是 Web Cursor 外壳本身的故障。

**处理结果**

Round 4 已增加取消确认弹窗。外部验证 `ORD-1004` 时，弹窗明确展示 Leather Wallet 恢复 `+1` 和新库存 181；确认后订单状态、共享库存、成功提示与 movement ledger 同步更新，取消按钮消失，无法重复执行。

### ISSUE-004：Agent 宣称 Preview 成功，但最终文件仍无法正常运行

| 字段 | 内容 |
|---|---|
| 严重程度 | High |
| 分类 | Agent verification |
| 页面 | `/p/89d67f7b-53b8-4446-b476-7789b2763a98` |

**现象**

Round 4 最终回复明确写了 `The Preview tool confirmed a clean build (SERVER_READY, no runtime errors)`。外部重新点击 Preview 后，页面仍保留旧 Dashboard，侧栏点击不生效；浏览器日志显示 `DashboardPage.tsx`、`ProductsPage.tsx`、`OrdersPage.tsx`、`InventoryPage.tsx` 等文件仍存在大量 `../../app/store`、`../../components/*`、`./ProductForm` 等错误导入路径。

**影响**

这是错误的成功声明。用户看到可见页面会误以为新功能已经运行，实际上只是热更新失败后保留的上一版界面，Round 4 新增流程均不可使用。

**期望结果**

Agent 在最终回复前必须以最后一次文件写入后的 Preview 结果为准；出现编译错误时继续修复并重新运行 Preview。成功条件不能只依赖历史 `SERVER_READY`，还应确认最新 run 没有 `RUNTIME_ERROR`，并至少读取一次新页面的可见内容。

**当前结果**

本次错误已通过外部强制新开 Preview、回填实际导入错误、让 Agent 修正后恢复；最终 run 13 的页面与跨模块交互已通过。不过 Web Cursor 还没有从机制上阻止 Agent 引用历史 Preview 结果，因此 ISSUE-004 保持 Open。

### ISSUE-005：只读角色仍显示无权执行的操作按钮

| 字段 | 内容 |
|---|---|
| 严重程度 | Medium |
| 分类 | Generated project UX / Permissions |

**现象**

Round 5 切换为 Operations 后，Inventory 页面仍为 12 个商品各渲染一个 `+/-` 按钮。点击按钮不会打开调整弹窗，而是提示 `You do not have permission to adjust stock.`。切换 Warehouse 后，Products 虽然隐藏了 Add Product，但每行仍保留 Edit 图标；点击后才提示没有编辑权限。业务写入没有越权，但只读页面展示了必然失败的操作。

**影响**

这与 Operations 只读 Inventory、Warehouse 只读 Products 的产品语义不一致，也与 Agent 最终回复中“按钮已隐藏”的声明不一致。用户必须点击后才知道没有权限。

**期望结果**

库存表格与商品表格应显式接收允许的动作；无权限时不渲染对应按钮，没有任何行级动作时不渲染空动作列。业务入口仍保留显式权限检查，避免仅靠隐藏按钮实现权限。

**处理结果**

`StockLevelsTable` 和 `ProductsTable` 已改为显式接收允许的动作；无权限时同时省略表头、单元格和按钮。最终 run 18 验证 Operations 的库存调整按钮为 0，Warehouse 的商品行级按钮为 0；Inventory 与 Products 页面 handler 的权限拒绝逻辑仍保留。

### ISSUE-006：宿主页面出现 React 最大更新深度错误

| 字段 | 内容 |
|---|---|
| 严重程度 | Medium |
| 分类 | Web Cursor host / Console |

**现象**

Round 5 的 Agent 写入、Preview 和外部权限验证期间，浏览器累计记录 5 次 `Maximum update depth exceeded`。错误 URL 指向 `http://127.0.0.1:3100/_next/static/...`，属于 Web Cursor 宿主页面，不是 WebContainer 中的 Northstar Preview。

**边界确认**

在最终 run 18 中，从 Admin 的 Team 页面切换到 Operations 并自动返回 Dashboard，没有新增该错误；三种角色的生成项目交互仍然可用。因此当前证据不能把错误归因到生成项目的权限重定向，只能确认宿主页面在本轮长 Agent 交互期间发生过重复 React 更新。

**期望结果**

宿主页面不应在长对话、连续工具卡片写入或 Preview 切换期间产生 React 更新循环。后续需要结合发生时间检查 Agent 消息/工具结果渲染相关 effect，而不是让生成项目 Agent 修改业务代码。

Round 6 的长对话与 Preview 切换期间该错误继续出现，最新时间仍指向宿主 `http://127.0.0.1:3100/_next/...`。生成项目 run 24 可正常完成活动启停、冲突、价格和权限交互，因此 ISSUE-006 保持 Open，边界判断不变。

### ISSUE-007：Paused Campaign 被显示为 Shipped

| 字段 | 内容 |
|---|---|
| 严重程度 | Medium |
| 分类 | Generated project UX / Status |
| 状态 | Resolved |

**现象**

首次实现为了复用 `StatusBadge`，把 Campaign 的 `Paused` 状态映射成订单状态 `shipped`。活动实际已经暂停，但列表和详情展示 `Shipped`，业务语义错误。

**处理结果**

`StatusBadge` 显式增加 `paused` 契约和样式；Campaign 状态通过 `Record<CampaignStatus, StatusBadgeStatus>` 穷尽映射，不再用未知字符串默认兜底。run 24 实际暂停 `Summer Electronics Sale` 后，列表显示 `Paused`。

### ISSUE-008：Campaign 激活冲突提示遗漏具体商品名

| 字段 | 内容 |
|---|---|
| 严重程度 | Medium |
| 分类 | Generated project UX / Validation |
| 状态 | Resolved |

**现象**

首次冲突提示为 `Campaign "Summer Electronics Sale" already covers conflicting product(s).`，只指出冲突活动，没有告诉用户是哪些商品导致失败。

**处理结果**

`activateCampaign` 改为返回结构化的 `conflictCampaignName` 和 `conflictProductIds`，页面使用已有 productId→name 契约生成文案；store 不猜商品名。run 24 实际提示 `Campaign "Summer Electronics Sale" already covers: Wireless Headphones.`，失败后目标活动仍为 Draft，未部分激活。

### ISSUE-009：Sidebar 的 Active Campaign 数量不会立即刷新

| 字段 | 内容 |
|---|---|
| 严重程度 | Low |
| 分类 | Generated project UX / Reactivity |
| 状态 | Resolved |

**现象**

Campaign 列表已经从 1 个 Active 变成 2 个时，Sidebar 徽标仍为 1；只有导航到其他页面触发 Sidebar 重渲染后才更新。

**处理结果**

Sidebar 直接订阅唯一的 campaign store，并在 effect 清理时取消订阅。run 24 中暂停唯一 Active 活动后徽标在当前 Campaigns 页面立即消失；重新激活后立即恢复为 1。

## 6. 测试总结

本次已完成项目建档、六轮真实 Agent 对话和前端交互检查。

- Round 1 证明：固定 16 个模型轮次不足以一次完成当前规模的多文件骨架；真实失败原因已持久化，但前端反馈不够清楚。
- Round 2 证明：新 AgentRun 可以基于现有文件准确续做，没有重写已完成模块；17 文件项目能够成功 Preview。
- Round 3 证明：Agent 可以在既有结构上完成 Orders、Products、Inventory 三模块共享状态与原子业务修改；真实取消流程已由外部测试验证通过。
- Round 4 证明：Agent 可以把 19 文件 Demo 扩展为 50 文件的领域项目，并完成商品创建/编辑、订单详情/取消确认、库存调整/流水等纵向切片；但一次大范围写入和一次职责拆分都引入了真实回归，需要外部新 Preview 才能发现。
- Round 5 证明：Agent 可以在 50 文件项目中加入集中角色权限，并同时修改导航、页面路由、四个业务动作和团队管理；首次实现仍把“拒绝按钮”误报成“隐藏按钮”，外部验证后才修正。项目最终达到 58 个文件。
- Round 6 证明：Agent 可以在 58 文件项目中加入活动状态、冲突规则、派生价格和跨页面订阅；但首次实现仍出现状态语义复用、错误信息不完整和订阅遗漏，必须靠真实启停操作才能发现。项目最终达到 66 个文件。
- 当前核心交互已验证：Dashboard、Products、Inventory、Orders、Customers、Campaigns、Team 七个业务页；局部/全局搜索、商品创建与编辑、库存流水、订单取消、跨页面库存同步、三角色权限、Campaign 启停、冲突原子失败、派生活动价和活动指标联动。
- ISSUE-001、ISSUE-003、ISSUE-005、ISSUE-007、ISSUE-008、ISSUE-009 已处理；ISSUE-002、ISSUE-004 仍需从 Agent 工具能力和验证契约层面解决；ISSUE-006 需要在 Web Cursor 宿主消息/工具结果渲染链路中单独诊断。
