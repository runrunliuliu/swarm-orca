# Tasks 工作台开发计划

状态：**P1（= M1）已实现并合入 main**（GitHub issue/PR 的 `Orca` tab）；**P1c（版面收口）已评审、有设计稿，
未实现**（§3 M1c，设计稿见 [设计文档 §7.13](README.md#713-版面收口2026-11-26设计稿未实现)）；P3 未开始；
**P4 的 main 数据面已落地**（issue #36，见 §9 与设计文档 §8.10），动作层与 M2a 验证未做。
本文不构成实现、部署、重启、创建 worktree 或启动 Agent 的授权。

关联：[调研与设计](README.md)（数据链就绪度、UI、关系存储）、[任务与工作区模型](../task-workspaces.md)
（一个任务如何绑定 worktree、如何续做）、[评审记录](discussion-record.md)（2026-11-09 只读 panel）。

## 0. 前提与共识

1. **"任务"身份是产品决定，不是既有 runtime 概念。** 一期用"tracker 身份 + 工作区身份"的渲染层投影，
   不实现逻辑任务 ID、跨入口路由、跨 runtime 续接。
2. **关系分三层存储**（设计文档 §8）：运行态/Agent 列表/实时用量**派生不存**；工作区侧 provenance 沿用既有字段；
   任务实体、绑定集合、用户意图、结算快照落 `taskRecords` domain。
3. **一期不碰** Agent 状态 store、用量扫描口径、RPC 契约与移动端实现。
4. **本视图只做 join 与汇总**，不复制 Agent 控制面或事件流（分工见设计文档 §5）。
5. 工作量以"工作包"（§4）为单位评估；执行者数量与并发上限由启动操作者按既有规则给定，本计划不设。
6. **评审后的收敛**（详见[评审记录](discussion-record.md)）：M1 可以现在做；M2 冻结到 H1
   （指定旧 build 的 round-trip）与 H2（`ambiguous_session` 频率）有证据；逐 Agent 的金额在会话级归因成立前
   不展示；M2 拆成 M2a（只读兼容验证）与 M2b（落库实现）。
7. **UI 优先的路标**（2026-11-16 定，见 §0.5）：先把"点开任务后的那一屏"做出来并拿到截图证据，
   再接真实数据 → 再翻列表主轴 → 最后落库。`Delivered` 已定为 agent done。

## 0.5 路标（UI 优先）

三段，每段结束都有一屏可演示的东西；每段可单独回滚。"先做哪个"看本表，"做到什么算完"看 §3 对应阶段。

| 路标 | 目标 | 看得到什么 | 主要工作包 | 不做 |
| --- | --- | --- | --- | --- |
| **P1 工作台 UI** | 先钉住那一屏 | 详情页 `Orca` tab：工作区、agent 行（带所属工作区）、token、用量三态、证据摘要 | WP1/WP2/WP3 的只读部分；P1a 明细见 [静态壳计划](p1a-ui-shell-plan.md) | 列表主轴、持久化 |
| **P1c 版面收口** | 那一屏"读得顺" | 内容感知双列、`Usage`/`Delivery` 通栏、历史去重、无死控件 | WP3 的版式切片（见 §3 M1c） | 存储、RPC、交付语义 |
| **P3 列表主轴** | 任务"排得开" | 分组（Delivered = agent done）、`◇` 徽标、一任务多工作区 | WP1/WP5 + M2b 的 renderer 部分 | 持久化 |
| **P4 持久化** | 任务"记得住" | primary、归档、结算快照、意图层 | WP0、WP4a–c（M2a → M2b） | 跨端 |

- **P1 允许停在 1a**：先交组件 + fixture 数据 + 全部状态与降级（可 CDP 截图评审），不接真实 selector、
  不建 tab 入口；1b 再接 `identity/join/usage` 三件套。2026-11-16 两轮评审都把"没有真机渲染"列为
  最大返工源，1a 就是回答它。
- **P1c 是 P1 的收尾而不是新阶段**：P1 已实现功能，P1c 只收版式（`TaskWorkbenchPanel` 的列策略、facts 位置、
  History 去重与死控件），不改数据面；设计稿与六个优化点见[设计文档 §7.13](README.md#713-版面收口2026-11-26设计稿未实现)。
- **旁路**：T1（Agent 派生树）可随时独立合入；M3（交付证据聚合）留在 P3 之后；M4（跨端）单独授权。
- **P3 与 P4 的切分**：分组与多工作区反查是纯 renderer 投影（P3），primary/归档/结算/意图层需要
  `taskRecords`（P4 且以 M2a 判决为门槛）。
- **路标**：P1（已实现）→ P1c（版面收口）→ P3 → P4；agent 侧建单 skills / CLI 动词与路标无关，保留。

## 1. 目标与非目标

**目标**

- 桌面端能从两个入口打开同一种视图：tracker 条目（GitHub/GitLab/Jira/Linear）与本地工作区；
  内容是"任务 → 工作区(0..N) → Agent(活/保留/历史) → 用量 → 交付证据"。
- 用量必须有三态：可用 / 未启用 / 不可用（远端、歧义、无匹配），**未知不记 0**。
- 逐 Agent 只展示 token；金额只到工作区级与任务级（会话行无 `worktreeId`，精确归因未成立）。
- M2 之后任务实体可持久化：绑定、primary、归档、验收、结算快照，并在启动时做一次只读对账。

**非目标（明确不做）**

- 逻辑任务 ID、跨入口/跨 runtime 任务续接、一任务多仓库联合验收（`../task-workspaces.md` 的保留设计）。
- 写入硬隔离、沙箱、把用量统计默认打开。
- SSH / 远端实时用量（只能显示不可用）。
- 修改 `agentStatusByPaneKey` 单一 store、`usage-*` 的归因口径、`*UsageProjectBreakdown` 的 key 形态。
- 迁移既有 worktree 的任务归属；只对用户显式动作（"归入任务"）写入 `taskRecords`。

## 2. 复用边界（不要重造）

| 需要的东西 | 复用 | 位置 |
| --- | --- | --- |
| Agent 行（活/保留/子 Agent） | `buildWorktreeAgentRows` + `selectWorktreeAgentRowsCached` | `orca/src/renderer/src/components/dashboard/` |
| Agent 行形状 | `DashboardCard` | `orca/src/shared/dashboard-snapshot.ts` |
| 历史会话 → 工作区 | AI Vault cwd 映射 | `orca/src/renderer/src/components/right-sidebar/ai-vault-session-worktree.ts` |
| 工作区用量聚合 | `*UsageProjectBreakdown`（key = `worktree:<id>`） | `orca/src/renderer/src/store/slices/` |
| 会话级归因 | `resolveAutomationRunUsage` 的判定顺序与语汇 | `orca/src/main/claude-usage/claude-usage-automation-attribution.ts` |
| 未知/不可用语汇 | `AutomationUsageSummary`、`AutomationRunUsageUnavailableReason` | `orca/src/shared/automation-usage-summary.ts`、`automations-types.ts` |
| 任务 ⇄ 工作区反查 | 现有单条反查 + Linear 索引 | `orca/src/renderer/src/lib/github-work-item-workspace-attachment.ts`、`task-page-linear-in-orca-issues.ts` |
| 持久化 | profile-state domain 写 + revision CAS | `orca/src/main/persistence/profile-state/` |

## 3. 阶段与退出条件

本节按历史编号（M/T）排列，**执行顺序以 §0.5 路标为准**：P1(=M1，已实现) → P1c(版面收口) → P3 → P4。
每个标题后的"路标"标注它落在哪一段。

### M0 决策冻结（0.5–1 天）

- 交付：设计文档 §6 的 D1–D6 逐条结论 + 失效条件；`taskRecords` 字段表与错误/不可用枚举冻结；
  用量三态的文案例句（进 catalog 前先定口径）。
- 评审遗留（设计文档 §6.1 R1–R7）在 M0 一起冻结：分组优先级与 `Delivered` 定义、`◇` 徽标语义、
  `M2a/M2b` 门槛、`projectBreakdown.key` 解析层归属。
- 退出：每条决策都有结论，或明确标为 `escalate-value-choice`（交回决策人）。
  未冻结的项不得进入 M2 编码。
- 不做：任何代码、任何 schema。

### T1 Agent 派生树（1–2 天，路标旁路，可随时合入）

需求与形态见[设计文档 §7.8](README.md#78-agent-派生树旁路可随时独立合入)。这条**不依赖** `taskRecords`，
也**不需要 M2a 判决**，可以作为独立小改动先行合入；与 M1 并行时共用 renderer 的 Agent 行模型。

- 范围：新增来源指针 + 列表层级/折叠/连接线 + 计数与关闭语义；**不改实际 PTY/tab/split 布局**。
- 交付：
  - WP-T1a 来源记录：`TerminalTab` 增加 additive 可选字段（`spawnedFromPaneKey` / `parentTabId` 取一），
    由 `terminal create` / `tab.newAgent` 在"从某个 agent 启动"时写入；随 tab 持久化。
  - WP-T1b 层级渲染：复用 `applyAgentRowLineage` 与 `agent-child-row-model`，把用户派生行按 1 层子行渲染；
    provider subagent 继续走既有路径。
  - WP-T1c 交互与边界：折叠与计数、父 tab 关闭后子行上提并标"来源已关闭"、跨工作区不建树。
- 退出：
  - 四个验收点（设计文档 §7.8）各有一条断言或截图；
  - 旧 build 读新 tab 记录忽略未知字段、tab 正常恢复（additive 兼容用例）；
  - 关闭父 tab 不自动关子 tab，且不丢子行状态；
  - `Needs you` 计数不因父子关系重复累计（单测）；
  - `pnpm tc`、定向 `pnpm test`、i18n 抽取、`check:code-quality:changed` 通过。
- 不做：自动推断父子、移动端、把子 tab 变成 pane、跨工作区树。

### M1 只读面板（3–5 天，路标 P1）

- 在既有 issue/PR 详情新增 `Orca` tab；顺序 GitHub issue/PR → Linear → GitLab → Jira。
- 面板内容：工作区（0..N）、Agent 行（含历史）、用量三态、`[ Open workspace ]` / `[ resume ]` 动作。
- 数据全部走 §2 的既有来源；**零持久化、零新增 RPC**。
- 退出：
  - 对照覆盖 **Claude + Codex + OpenCode + Muse**：面板合计 == `projectBreakdown['worktree:<id>']`；
  - 三态与空态各有用例（未启用、远端、歧义、无工作区）；逐 Agent 只出现 token，不出现金额；
  - `projectBreakdown.key` 走解析层且有单测；
  - identity/join/usage selector 可被 M2 直接引用（不是页面内拼装）；
  - `pnpm tc`、定向 `pnpm test`、i18n 抽取与覆盖、`check:code-quality:changed` 通过。
- 不做：列表主轴、分组、任务归档、移动端、逐 Agent 金额。

### M1c 版面收口（1–2 天，路标 P1c）

P1 已把功能做齐，但版面仍是 P1 定下的固定双列；本阶段只收版式，不改数据面。六个优化点与预期版式见
[设计文档 §7.13](README.md#713-版面收口2026-11-26设计稿未实现)。

- 前提：P1 已实现；只改版式与可见性，不改 §2 的数据来源与 §8 的存储。
- 范围：
  - 双列由固定 `1.4fr/1fr` 改为内容感知（按 Agent / 工作区数量与宽度切换列宽或单列）；
  - `Usage` / `Delivery` 从右列移为整宽 facts band；
  - Run 历史条与 Agents → History 只留一处；`History` 标签去重；
  - 未接线的 `Open terminal`、不可用的 `New workspace` / `Load evidence` 不再渲染成禁用按钮；
  - `History` 计数回到左列标题；1100px 阈值改容器查询或提高下限，补 1100–1300px fixture。
- 退出：
  - `tests/tools/task-workbench-rendered/run.mjs --all` 全绿，并新增/更新 fixture 覆盖窄列与 1100–1300px；
  - 每个 fixture 的 `data-wb-columns` / 版式断言与设计稿一致；交付行在宽屏不换行（截图证据）；
  - `pnpm tc`、定向 `pnpm test`、`check:code-quality:changed` 通过；
  - 新增生产组件渲染图（`ui/impl-*`），设计稿不替代。
- 不做：列表主轴（P3）、持久化（P4）、交付/归档语义、任何 RPC 或 schema 改动。

### M2a 存储兼容验证（1–2 天，只读；P4 的门槛）

- 指定**旧 build** 做 新→旧→新 round-trip；断言未知 top-level domain 被读入、保留、写回。
- 断言 `orca profile state` export / recovery / 备份恢复包含未知 domain。
- 产出判决：通过 → 进入 M2b；不通过 → 范围收缩为 M1，并在设计文档 §8.2 记录原因。
- 退出：三项断言各有一条可复现命令与结果；不写任何生产数据。

### M2b 列表主轴 + 落库（5–8 天；P3 的 renderer 部分 + P4 的 main 部分）

- 新增 `taskRecords` domain（字段见设计文档 §8.3）：记录、绑定、`externalIndex`、primary、`intent`、`usageSettlement`。
- main 侧：load 归一化（逐条 `schemaVersion`）、唯一性校验、写入走 `writeProfileStateDomain` + revision CAS、
  启动一次有界对账（绑定解析 / 标记 unresolved / 回填 `resolvedVia`）。
- renderer 侧：列表分组（Needs you / Working / Delivered / Unlinked）、`[ primary workspace ]`、
  "归入任务 / 从任务移除 / 归档"动作。
- 反查升级：`find*Attachment` → 列表版；GitLab/Jira 补同构 collector。
- 前置门槛：**M2a 判决通过**，且设计文档 §8.9 的第 2–3 条（revision CAS、记录级迁移）跑通；
  不通过则不引入 domain，退回纯投影。
- 退出：上文 **H 的 1–7 全绿**（覆盖设计文档 §8.9 的存储专项与评审补充）；投影一致性用例；
  1000 工作区规模下列表构建复用缓存 pass、无逐行扫描；G 的三项数字留证。
- 不做：跨 runtime、跨仓库联合验收、移动端。

#### M2b 存储交付细则（WP4 必须逐项落地）

设计理由见[设计文档 §8](README.md#8-关系怎么存持久化设计)，本节只写"实现时要交出什么"。

**A. domain 合同**

| 项 | 要求 |
| --- | --- |
| 位置 | profile-state 的 top-level JSON domain `taskRecords`；**不加 DDL、不改 `PROFILE_STATE_DATABASE_SCHEMA_VERSION`** |
| 顶层 | `{ recordsVersion: 1, byId, externalIndex }`；未知顶层字段读入后原样保留 |
| 记录不变量 | `taskId` 非空且唯一；`bindings[].worktreeId` 非空、同一任务内不重复；`primaryWorktreeId` 必须在 `bindings` 中 |
| `externalIndex` | `provider · host · repo · number` → `taskId`，**0..1**；重复绑定必须**拒绝并报冲突**，不得覆盖或静默合并 |
| 上限 | 单任务 ≤ 64 个绑定；单记录 JSON ≤ 8 KiB；整个 domain ≤ 8 MiB；超限拒绝写入并报错（不静默截断） |
| 枚举 | `unavailableReason` 只用既有语汇：`usage_not_enabled` / `remote_usage_unavailable` / `scan_failed` / `no_matching_session` / `ambiguous_session` |

**B. 写入路径与并发**

- 写入者只有 main 的 Store；renderer 通过 IPC 提交意图（新增/绑定/解绑/归档/改 primary），**不得**拼整个 domain 覆盖写。
- 一律走 `writeProfileStateDomain({ domain:'taskRecords', payload, expectedRevision })`。
- revision 冲突（`ProfileStateRevisionConflictError`）：重读 → 重放意图 → 最多重试 3 次；仍冲突则失败上报，不降级为"最后写入者胜"。
- 变更只重写 `taskRecords` 一行；不连带写 `worktreeMeta` / `settings`。

**C. `usageSettlement` 触发与幂等**

| 触发 | 时点 | 约束 |
| --- | --- | --- |
| 任务归档 | 写入 `intent.archived = true` **之前** | 先结算成功再置归档；结算失败则保留原状态并报错 |
| 绑定移除 / 工作区删除 | 该 binding 标记前 | 只结算被移除 binding 对应的工作区聚合 |
| 显式"重新结算" | 用户动作 | 覆盖旧快照并更新 `collectedAt`；保留 `unavailableReason` |

- 幂等键：`(taskId, worktreeId, collectedAt)`；重放不产生第二份快照。
- 结算读的是 `*UsageProjectBreakdown` 的 `worktree:<id>` 聚合；**拿不到就记 `unavailableReason`，不记 0、不按比例拆分**。
- 结算不触发强制重扫（不因打开任务页而拉 `refresh(force)`）。

**D. binding 解析与对账**

- 解析顺序：locator `worktreeId` → `worktreeIdentityAliases` → `priorWorktreeIds`；命中即回填 `resolvedVia`。
- 解析失败：`lastVerifiedAt = null`，列表显示 unresolved；**不删记录、不改绑定的 `boundBy`**。
- 启动对账一次、有界（受单次预算与并发约束）；不做后台 watcher、不自动重试。
- 对账只写 `lastVerifiedAt` / `resolvedVia`，不写 `intent`、不写 `usageSettlement`。

**E. 生命周期与 GC 解耦**

| 事件 | 必须的行为 |
| --- | --- |
| 工作区被 Orca 删除 | binding unresolved + 结算；任务记录保留 |
| 工作区被外部删除 | 只读对账标记，不自动删 |
| 目录改名 | 别名解析并改写 `worktreeId`，保留旧 id 于 `resolvedVia` 记录 |
| 仓库移除（`gcStaleWorktreeMeta` 会清 meta） | 记录仍可读，binding unresolved；不跟随 meta 一起清 |
| 任务删除 | 显式动作，先结算后删；**不级联删工作区** |

**F. 失败与降级行为**

- domain payload 损坏 / `recordsVersion` 未知：**fail-closed**（拒写、上报、不清空、不重建空 domain）。
- 单条记录字段未知或类型不符：丢弃该条并计数上报，其余记录照常加载；不得整 domain 判死。
- 读取路径不得因任务记录缺失而阻塞工作区列表或 Agent 状态展示。

**G. 体量 / 写入频率门禁（退出前实测）**

- 1000 任务 × 3 绑定：domain 序列化 + 读入耗时基线（给出数字，不写"应该很快"）。
- 运行态变化（Agent working/idle、消息流）**不得**触发 `taskRecords` 写入（用写入计数器证明）。
- 单次绑定/归档/结算只产生 1 次 domain 写。

**H. M2b 退出条件（与上表一一对应）**

1. A 表全部有单测（含重复 `externalIndex` 拒绝、上限拒绝、primary 不在 bindings 时拒绝）。
2. B 的 CAS 冲突路径有并发用例，且验证"重试 3 次后失败上报"。
3. C 的三条触发各有用例，且幂等键重放不产生第二份快照；未启用/远端/歧义三态都覆盖。
4. D 的四条解析路径与 unresolved 分支各有用例。
5. E 的五种事件各有断言（含 `worktreeMeta` 被 GC 后记录仍可读）。
6. F 的三类损坏输入各有一条 fail-closed 或逐条降级用例。
7. G 三项数字与写入计数器结果记录在 §9 证据列。

### M3 交付证据聚合（2–3 天，路标 P3 之后）

- 任务级交付区：commits、PR/MR、checks、review 状态、`sparseTaskBinding` 证据（base/cone/requiredPaths）。
- 退出：一个有 PR 的任务与一个无 PR 的任务各有一份截图/断言；不可用状态不显示为 0。

### M4 跨端（可选，未估）

- 新只读 RPC（task usage/摘要）+ mobile allowlist + 录制 golden + 移动端详情接入。
- 需要单独授权与 wire 兼容评审；不在本计划默认范围内。

## 4. 工作包与文件所有权

| WP | 内容 | 主要落点 | 依赖 | 可并行 |
| --- | --- | --- | --- | --- |
| WP1 | 任务投影（`taskKey`、分组、一任务多工作区） | `orca/src/renderer/src/components/task-workbench/*`、`orca/src/renderer/src/lib/` | M0 | 与 WP2 并行 |
| WP2 | 用量聚合与三态收敛 | 同上 + `orca/src/shared/task-workbench-*.ts` | M0 | 与 WP1 并行 |
| WP3 | UI（面板 / 列表 / 空态 / 动作） | `task-workbench/` 组件与 `use-task-workbench-*` | WP1、WP2 | 否（串行收口） |
| WP4a | `taskRecords` domain + 归一化 + 上限/不变量校验（main） | `orca/src/main/task-records/*`、`orca/src/main/persistence/loading-store/normalize-loaded-task-records.ts` | M0 字段表 | 与 WP1/WP2 并行 |
| WP4b | 写入意图 + revision CAS 重试（main/IPC） | 同上 + IPC 意图层 | WP4a | 否（串行） |
| WP4c | 启动对账 + `usageSettlement` 结算 | 同上 | WP4a、M2a 判决 | 与 WP5 并行 |
| WP5 | 反查索引升级（四 provider） | 现有 `*workspace-attachment*`、`task-page-linear-in-orca-issues.ts` | WP4 字段表 | 是 |
| WP0 | M2a 存储兼容验证（只读 fixture，不写生产库） | 独立 fixture + 手写旧 build 快照 | M0 | 是 |
| WP-T1a | Agent 派生来源记录（tab additive 字段） | `orca/src/shared/terminal-tab-types.ts`、terminal create 路径 | M0（只锁定义） | 与 T1b/T1c 并行 |
| WP-T1b | 层级渲染（复用 lineage / child row 模型） | `orca/src/renderer/src/components/sidebar/*` | WP-T1a | 否（串行收口） |
| WP-T1c | 折叠、计数、关闭父 tab 的上提语义 | 同上 + Dashboard 行模型 | WP-T1b | 否 |
| WP6 | 测试与基准 | 与各项同目录 `*.test.ts` | 全程 | 是 |

约束：

- 新文件按职责命名，不用 `helpers`/`utils`；不新增 `max-lines` 豁免，触发 ratchet 就拆文件。
- 并行写入必须文件所有权不重叠：WP4 只写 main 与 shared，WP1–WP3 只写 renderer；共享类型先由 WP4 冻结。
- 不修改 `mobile/`、`agent-status-*`、`*/usage/*` 的归因实现（只读消费）。

## 5. 测试矩阵

| 范围 | 要点 |
| --- | --- |
| 投影 | 同 issue 两个工作区；同名分支不同仓库；归档工作区不计入 Needs you；无 tracker 工作区进 `UNLINKED` |
| 用量三态 | 可用 / 未启用 / 远端 / `ambiguous_session` / `no_matching_session` / 未定价模型 |
| 归因 | 会话级只用 `worktreeId`；时间窗歧义不猜；与 `projectBreakdown` 数值一致 |
| 持久化 | **指定旧 build** 的 新→旧→新 round-trip；旧 build 的 selective 与 full write 两条路径都保留；revision CAS 冲突后重读重试；记录级 `schemaVersion` 迁移；malformed/未知字段加载降级 |
| 导出/恢复 | `orca profile state` export / recovery / 备份恢复包含未知 domain |
| 结算快照 | `usageSettlement` 在删除、归档、扫描失败、未启用、远端不可用下的失败注入 |
| 归属防串 | 跨 `hostId`/`repoId` 的同名 `externalKey` 不串任务 |
| 对账 | 工作区外部删除、目录改名（`priorWorktreeIds`/别名）、仓库移除、归档后再打开 |
| GC 解耦 | `worktreeMeta` 行被 30 天 GC 后任务记录仍可读且标 unresolved |
| 性能 | 1000 工作区列表构建、面板打开耗时、domain 序列化/读入基线 |
| i18n / 样式 | 全部新文案进 catalog；只用 `components/ui/` primitive；无 raw 色值 |
| Agent 派生树 | 从 A 启动 B/C 的两层渲染与折叠计数；CLI 启动的 D 保持平级；关闭 A 后 B/C 上提并带"来源已关闭"；provider subagent 与用户派生共存不重复计数；旧 build 忽略未知字段仍能恢复 tab |
| UX 验收 | 分组优先级与 `Delivered` 定义；loading/未授权/部分失败/过期/scan failed 态；三态文案不被读成 0；动作在已归档/不可恢复时禁用并有说明；迁移后 `conversation/checks/files` 可发现；键盘与焦点返回；屏幕阅读器名称与非颜色表达；窄桌面/长标题/大数字布局边界；primary fallback 标识；Agent 内容隐私遮蔽 |

命令：`pnpm tc`、`pnpm test <path>`、`pnpm run check:code-quality:changed`、
`pnpm run verify:rpc-params-catalog`（仅若动契约）、`pnpm run verify:localization-extraction`。
按 `AGENTS.md` 的批量规则跑 vitest（小批、`--maxWorkers=2`）。

## 6. 验收与证据口径

- 每个验收项记录：命令、cwd、起止时间、退出码、相关快照 hash；未知不记 0。
- 真机渲染校验需 CDP 截图（`ORCA_BACKGROUND_LAUNCH=1`，不抢焦点）；没有截图不算通过。
- 远端/SSH 与需要计费的场景单列"未验证"，不作为通过证据。
- 面板能打开、类型检查通过，都不构成功能验收；必须有对照数字。

## 7. 顺序、依赖与风险

顺序：M0 → **P1（1a → 1b，已实现）→ P1c（版面收口）→ P3 → P4**；T1 旁路（可随时合入），M3 跟在 P3 后，M4 单独授权。
旧标签的对应关系：P1 = M1；P3 = M2b 的 renderer 部分；P4 = M2a + M2b 的 main 部分。

| 风险 | 处理 |
| --- | --- |
| `projectBreakdown.key = worktree:<id>` 是未文档化实现细节 | renderer 侧加解析 + 回退层，对前缀做单测；上游变化只改一处 |
| 降级 round-trip 未实测 | 作为 M2 前置门槛；不通过就退回纯投影（仅 M1） |
| 任务记录只增不减 | §8.7 lifecycle + 启动对账 + 显式"清理无归属任务"，不做后台 watcher |
| 用量缓存因改名重扫（`worktreeFingerprint` 含 `displayName`） | 不做高频重命名；重命名走显式动作 |
| 与 Agent Dashboard / Agents feed 入口打架 | 分工写进文案与文档，互链不复制 |
| 双写漂移（Agent 状态 / 用量） | 坚持"派生不存"；`usageSettlement` 只在失去读取能力前写入 |
| 逐 Agent 金额被当成事实 | 只显示 token；金额仅任务/工作区级；会话级归因（H5）通过后才放开 |
| M2a 结论被跳过 | M2b 的开工条件写成"M2a 判决通过"，没有判决不得写 `taskRecords` |
| 派生树靠猜父子 | 只认创建时写入的来源指针；无来源一律平级，不做标题/时间相似度推断 |
| 并行工作包互相踩文件 | §4 的所有权划分 + 共享类型先冻结 |
| agent 直接写共享 tracker（能力保留） | 不再由 app 保证"写前有人确认"：建单由 agent 按技能约束或用户指令执行；UI 不承诺二次确认 |
| 不可达的 `taskDraft` 残留 | renderer 已无生产者（字段、`app:getTaskDraftDirectory` IPC、archive sweep、侧栏徽标/菜单、计数排除）；删除按 additive 字段下线处理（跑 `verify:rpc-params-catalog`），不静默迁移 |

回滚：

- M1 是纯 UI + 只读 hook，可整体 revert，无数据残留。
- 不可达的 `taskDraft` 残留与 IPC 按独立一刀清理。
- M2 落地后回滚 = 停止写入并保留 domain 行（旧 build 保留未知 domain），**不删数据**；
  清理需单独授权。

## 8. 未决输入

- D1/D3/D5/D6（设计文档 §6）尚未拍板；D4 已由 R1 定。
- P1 是否扩到 Linear / Jira / GitLab 的 `Orca` tab 未决；目前只有 GitHub issue/PR 接了真实数据。
- 移动端是否在一期之后做（D5）未知。
- 是否允许真机渲染验收与远端/计费场景验证，需单独授权。

## 9. 阶段状态

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| **P1 工作台 UI**（= M1；1a 静态壳 → 1b 接线） | 已实现：1a、1b 与真实 `Orca` tab 均合入 main（GitHub issue/PR）；真机交互验收未做 | `swarm-orca` main `42232cbd`（P1a）→ `e91e115d`（P1b）；父仓库 pin `36e06e3a`、`dev_liuliu` merge `08ce3fa7`；线上构件 `0.1.0+39a6ecbc2818` 于 2026-11-17 重启后核验（`buildId` 一致、`source=pointer`、`pointer.state=ok`）。缺口：只有 `tests/tools/task-workbench-rendered` 的渲染证据，无交互验收；仓库内未找到 P1b 独立评审回执 |
| **P1c 版面收口**（= M1c；设计稿见 [设计文档 §7.13](README.md#713-版面收口2026-11-26设计稿未实现)） | 已评审、有设计稿，未实现 | 评审用现有 harness 跑 `run.mjs --all`（27/27 PASS）；设计稿 `ui/design-workbench-20261126-expected.png`（1440×900，HTML/CSS，非生产组件渲染，源码 `ui/src/design-workbench-20261126-expected.html`）；实现与 `impl-*` 生产渲染证据待补 |
| **P3 列表主轴**（= M2b renderer） | 未开始（其前置薄切片已完成，见下一行） | — |
| **P3 前置薄切片：GitHub 列表行内活动徽标**（issue #27） | 已实现（本仓库；不分组、不重排、零持久化）；有 harness 的 CDP 截图（G1/G2），无真机验收 | 纯 selector `lib/task-workbench/task-workbench-row-activity.ts` + 列表页批量 hook `components/use-task-page-github-row-activity.ts` + 徽标 `components/task-page/github/RowActivityBadge.tsx`；CDP 截图 `ui/impl-github-rows-badge-{wide,narrow}.png`（harness fixture `d6_github_task_rows`）；单测覆盖 README §7.2 的并集规则（working+done → Working、任一 needs-you、归档不参与、failure/cancellation/sessionBoundary 不算 Delivered、outcome 缺失算 done、0 工作区不产徽标、有工作区无 agent → Workspace）；行级归属按 repoId+linkedIssue/linkedPR 反查（identity 的 GitHub key 是 owner/repo 级） |
| **P4 持久化**（= M2a + M2b main） | 部分：`taskRecords` domain、绑定写入、移除前结算、读取投影与降级（issue #36）；动作层、启动对账、M2a round-trip 未做 | 落点与偏离见 [设计文档 §8.10](README.md#810-p4-已落地切片issue-362026-11-19)；单测：`shared/task-records*`、`loading-store/task-records-*`、`main/task-records/*`、`main/ipc/task-records.test.ts`、renderer `task-workbench-history-merge` / `task-workbench-session-totals`；`tc:node`、`tc:web`、`check:code-quality:changed` 通过；未做真机渲染验收 |
| T1 Agent 派生树（旁路） | 未开始 | — |
| M0 决策冻结 | 部分：D12（`Delivered` = agent done）已定，D1/D3/D5/D6 待定 | — |
| M1 只读面板（= P1） | 已实现（GitHub issue/PR；Linear/Jira/GitLab 未接） | 见 P1 行 |
| M2a 存储兼容验证 | 未开始 | — |
| M2b 列表主轴 + 落库 | 部分（只做 main 侧数据面，见 P4 行） | 同上 |
| M3 交付证据聚合 | 未开始 | — |
| M4 跨端 | 未开始（未估） | — |
