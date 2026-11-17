# 以任务为中心的 Tasks tab 改造：调研与 UI 设计（草案 v1）

状态：**调研 + 设计草案**，未实现，未评审通过。
调研基线：本仓库的 `orca/` 层（upstream `v1.4.219` 快照，见 `orca/upstream.json`、`orca/UPSTREAM.md`）。
文中 `orca/...` 路径均相对本仓库根目录。
核对日：2026-11-09；2026-11-16 增补 §6.2、§6.3、§7.9（T2：列表页 dock 与任务草稿行）；
2026-11-17 增补 §6.5、§7.10（T2 方向变更：dock 改为 agent 输入框，§7.9 的预览卡/状态机/创建链撤销）。

本文只记录"代码里有什么 / 能怎么改"。不修改任何 schema、启动器、已装技能或既有会话；不构成实施、合并、
部署、重启或创建 worktree / Agent 的授权。文中行号与文件路径均为只读观察值，改动前需重新核对 HEAD。

本文遵守本仓库的 [public-repository boundary](../../../AGENTS.md) 与本层约定：不含组织配置、主机名、
真实 Run / Task / terminal ID、部署路径或凭据。

关联：[任务与工作区模型](../task-workspaces.md)（一个任务如何绑定 worktree、如何续做）、
[开发计划](development-plan.md)（阶段、工作包、退出条件与测试矩阵）、
[评审记录](discussion-record.md)（2026-11-09 只读 panel 的结论、缺项与失效条件）、
[评审记录（T2）](discussion-record-t2-dock.md)（2026-11-16 codex-ark / trae 两票）与
[评审 brief（T2）](review-brief-t2-dock.md)；
[工作台 UI 评审记录](discussion-record-task-workspace-ui.md)（2026-11-16 两轮）与对应
[第 1 轮 brief](review-brief-task-workspace-ui.md) / [第 2 轮追问](review-followup-task-workspace-ui-r2.md)。

---

## 1. 结论

**可行。** 但不是"重排 UI"，而是**换掉 Tasks tab 的信息主轴**。

- 四段数据链（任务 ⇄ 工作区、Agent、用量、交付证据）在代码里**基本都已存在**：
  worktree 记住来源任务、Agent 状态存储 + Agent Dashboard、用量扫描按 `worktreeId` 归因、
  PR/checks 已在 PR 页面。
- 唯一真正的空白是**任务身份**：`../task-workspaces.md` 的"未实现"表写明
  "逻辑任务 ID、稳定身份路由"不存在——没有 CLI 参数、没有 schema、没有持久记录。
- **关系存储**（§8）：并非全都要存——运行态/Agent 列表/实时用量是派生；任务实体、绑定集合、用户意图与
  "结算过的用量"必须存，落点是 profile-state 里新增的一个 JSON domain（不需要 DDL、不需要 bump schema 版本）。
- **2026-11-09 只读评审的收敛结论**：M1 可以现在做（3/3 同意）；M2 冻结到 H1（旧 build round-trip）与 H2
  （`ambiguous_session` 频率）有证据为止；逐 Agent 的金额在会话级归因成立前不展示，只显示 token 或"不可用"。
  分歧只在"是否值得为任务历史/多工作区语义承担 M2 成本"，属产品优先级，见[评审记录](discussion-record.md)。
- 实施拆分（工作包、退出条件、测试矩阵、回滚）见[开发计划](development-plan.md)。
- 因此推荐 **增量优先**：先在不新建 schema、不新增 RPC 的前提下，把 join 层做对（决策见 §6，
  UI 见 §7.4），验证归因质量后再决定是否翻列表主轴（§7.2 / §7.3）。

体量参考（用于判断改动成本，不是结论）：`task-page/` 47 个文件 + `use-task-page-*` 48 个 hook；
移动端 `mobile/src/tasks/` 206 个文件；`components/dashboard/` 62 个文件。

---

## 2. 现状：这个 tab 现在是什么

| 事实 | 证据 |
| --- | --- |
| 顶层视图 `TopLevelView = 'terminal' \| 'settings' \| 'tasks' \| 'activity' \| 'automations' \| 'space' \| 'skills' \| 'artifacts' \| 'mobile'` | `orca/src/shared/ui-chrome-types.ts:115` |
| "Tasks" 是**四个 issue provider 的列表页**：GitHub / GitLab / Jira / Linear | `orca/src/renderer/src/components/task-page/{github,gitlab,jira,linear}/` |
| 点条目进全页详情：PR → `PullRequestPage`；issue → `GitHubItemDialog` | `task-page/Content.tsx` |
| issue 详情 tab 只有 `conversation / checks / files`（`files` 仅 PR） | `components/github/github-work-item-identity.ts:54` |
| 详情页**不显示**任何工作区 / Agent / 用量信息 | `task-page/github/IssueDialog.tsx` 全文无 workspace/agent 引用 |
| 只有 Linear 有 `in-orca` 模式（只列已关联工作区的 ticket）；GitHub 无 | `use-task-page-linear-in-orca-effects.ts`、`github/ModeControls.tsx` |
| 已有的"按 Agent 看"的并行入口：Agent Dashboard（实验特性）、Agents feed（Activity） | `components/dashboard/`、`orca/docs/site/content/docs/activity.mdx` |
| 用量只在 Settings → Stats 下，且按 provider 分区，没有任务/工作区维度入口 | `components/stats/*`、`settings/settings-interface-secondary-section-renderers.tsx:110` |

一句话：现在是**tracker 镜像**；想法要的是**本地工作视图**。

---

## 3. 四段数据链就绪度

### 3.1 任务 ⇄ 工作区：已有，双向

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| worktree 记住来源任务 | `linkedIssue`(github) / `linkedLinearIssue` / `linkedGitLabIssue` / `linkedGitLabMR` / `linkedBitbucketPR` / `linkedAzureDevOpsPR` / `linkedGiteaPR` / `linkedWorkItem{provider:'github'\|'gitlab'\|'linear'\|'jira'}` / `linkedTaskSourceContext` | `orca/src/shared/worktree/meta-types.ts:18`、`shared/worktree/types.ts:12` |
| 来源消歧信息 | `TaskSourceContext{provider, projectId, hostId, repoId, providerIdentity, accountLabel}` | `shared/task-source-context.ts` |
| 反查：任务 → 工作区 | GitHub/GitLab：**单条**（取第一个非归档） | `renderer/src/lib/github-work-item-workspace-attachment.ts` |
| 反查：任务 → 工作区（列表） | Linear 有完整索引（含 workspace/org 归一） | `renderer/src/components/task-page-linear-in-orca-issues.ts` |
| 用户已能看到绑定 | worktree 卡片显示关联 Jira/Linear issue | `sidebar/worktree-card-jira-issue-display.test.ts` |
| 任务 sparse 证据 | `sparseTaskBinding{pinnedSha, baseSource, requestedCone, requiredPaths}` | `shared/worktree/sparse-task-binding.ts` |

**缺口**：
- `find*Attachment` 是"取第一个"，要支持"一任务 N 工作区"需升成列表索引（Change: S，影响多处调用点）。
- `linkedWorkItem` 是**快照**（title/url），provider 侧标题/状态变化后不会自动刷新；Linear/GitHub 有结构化字段，相对可靠。

### 3.2 Agent：三种来源齐备

| 来源 | 覆盖 | 位置 |
| --- | --- | --- |
| 活着的 Agent | 状态机（working/blocked/waiting/done/idle）、`model`、`prompt`、last message、子 Agent、子任务 token 上报 | `shared/agent-status-types.ts`、`shared/agent-status-store.ts` |
| 最近结束的 Agent（保留态） | 跨 worktree 的 kanban 卡片，含 `task / lastUserMessage / lastAgentMessage / review` | `components/dashboard/build-dashboard-snapshot.ts`、`shared/dashboard-snapshot.ts` |
| 历史会话（进程已死） | AI Vault 扫描 provider transcript，按 **cwd → worktree** 映射（`current/active/archived/unavailable`），每会话含 `totalTokens`、agent、model、时间窗 | `renderer/src/components/right-sidebar/ai-vault-session-worktree.ts`、`main/ai-vault/session-scanner-types.ts:120` |
| Agent ↔ provider session 精确 join | 状态行携带 `providerSession{key,id,transcriptPath}` | `shared/agent-session-resume.ts:34`、`agent-status-types.ts:157` |
| 子 Agent 自己的 token | 子任务行上报 `totalTokens` | `shared/agent-child-row-model.ts:66`、`shared/agent-status-child-work-evidence.ts` |

**缺口**：缺少统一的 join 层（worktree → 当前/历史 Agent 行），以及"谁是主 Agent"的判定规则。

### 3.3 消耗资源：聚合已算好，未暴露到任务维度（关键发现）

| 事实 | 证据 |
| --- | --- |
| 主进程按 `worktreeId + sessionId + model + day` 统一 rollup（Claude/Codex/OpenCode/Muse） | `main/usage/usage-rollup-records.ts`、`usage-event-aggregation.ts` |
| 归因 key = `worktree:<id>`；label = **worktree 显示名** | `main/usage/usage-event-attribution.ts:39-45` |
| `projectBreakdown[].key` 就是 `worktree:<id>`，且带 `estimatedCostUsd` | `main/claude-usage/claude-usage-report-aggregation.ts:121`、`shared/claude-usage-types.ts:39` |
| 渲染进程**今天就能读到**按 worktree 的聚合（`claudeUsageProjectBreakdown` 等） | `renderer/src/store/slices/`（`*UsageProjectBreakdown`）、`components/stats/ClaudeUsagePane.tsx:56` |
| 单会话归因已有成熟算法：sessionId 精确 → 否则 worktree + 时间窗；多重命中判 `ambiguous`，无命中判 `no_matching_session`，远端判 `remote_usage_unavailable`，**未知不记 0** | `main/automations/run-usage-collection.ts`、`main/claude-usage/claude-usage-automation-attribution.ts:48-91` |
| "按对象汇总用量"的既有范式（known/unavailable 计数） | `shared/automation-usage-summary.ts` |
| 计价口径 | 各家 `estimatedCostUsd`；Codex 有 `hasUnpricedModels` 标记未定价模型 |

**缺口**：
- 对外 session 行类型**没有 `worktreeId`**（`ClaudeUsageSessionRow` 只有 `projectLabel`），按会话归因需加 additive 字段（并处理 RPC catalog / wire 兼容）。
- **用量扫描默认关闭**（`main/claude-usage/store.ts:42` `enabled: false`）——多数用户首次打开会是空态。这是产品决策，不是缺陷。
- 移动端 / 配对客户端**没有任何 token 用量 RPC**（只有账号配额 `accounts` family）。

### 3.4 任务身份：唯一空白

`../task-workspaces.md` 明确：逻辑任务 ID 与跨入口路由不存在；"一任务多仓库绑定"不存在
（`software-development-v1` 任务记录只允许单值 `repository`）。

三条可选身份来源：

| 方案 | 定义 | 覆盖 | 成本 | 风险 |
| --- | --- | --- | --- | --- |
| A. tracker 身份 | `provider + project/repo + number`（`TaskProviderIdentity` 已存在） | 只有来自 tracker 的任务 | 零 schema | 排除"聊着就干了"的常见用法 |
| B. 工作区身份 | 一个专属 worktree = 一个任务（与 sparse task workspace 的隔离单位定义一致） | 全量 | 零 schema | "一任务两工作区"退化为两个任务 |
| C. 本地逻辑任务记录 | 新增持久任务记录 + 绑定集合 | 全量且正确 | 最高（跨 runtime ID 不能混用） | 与设计文档 §对象与关系 强耦合，需单独评审 |

**建议**：A + B 混合的**渲染层投影**（不落库），把 C 留作后置：

```text
taskKey = "provider:github:repo-17:#412"   // 有 tracker
taskKey = "workspace:web-app::feature/add-login"  // 无 tracker（本地任务，标题取 worktree displayName）
```

投影意味着"分组/排序/合计"都从既有 store 现算，**不新增持久化契约**；代价是跨窗口/跨端不共享，
跨入口续做仍需读 worktree 绑定（与现状一致）。

---

## 4. 可行性矩阵

| 设计元素 | 现状 | 缺口 | 量级 |
| --- | --- | --- | --- |
| 跨 provider 统一任务列表 | 四家各自列表 + 分页 + 缓存 | 需要一个投影层；跨宿主要带 host 维度 | M |
| 点开看到完成它的 Agent | 三种来源齐备 | join 层 + 主 Agent 判定 | S–M |
| Agent 的 model / 状态 / 消息 | 已有 | 无 | S |
| Agent 的 token / 花费 | 已有（会话级 + worktree 级） | session 行缺 `worktreeId`；歧义态表达 | S |
| 任务级合计花费 | 已有（`worktree:<id>`） | "未启用/未知/远端不可用"三态 | S |
| 工作区 / 分支 / 基线 / 脏状态 | 已有（含 sparse 回执） | 列表反查 | S |
| 交付证据（PR / checks / review） | 已有 | 任务级聚合视图 | M |
| 桌面端 | 可做 | — | — |
| 移动端 / 配对 / Web | 任务详情是另一套实现 | 新 RPC + allowlist + 录制 golden + wire 兼容 | L |
| SSH / 远端用量 | 明确不可用 | 只显示"不可用"，或等 host 侧发布 | L（不建议一期） |

---

## 5. 与既有视图的分工（必须先写清，否则三个页面互抢入口）

| 视图 | 回答的问题 | 粒度 |
| --- | --- | --- |
| **Tasks**（改造后） | "这个任务做到哪了？谁在做？花了多少？" | 任务 → 工作区 → Agent |
| **Agent Dashboard**（实验） | "现在有哪些 Agent 需要我？" | Agent 卡片（跨 worktree） |
| **Agents feed / Activity** | "我刚离开这段时间发生了什么？" | 事件流（时间序） |
| **AI Vault** | "某次会话当时聊了什么？" | 单个 provider 会话 |
| **Settings → Stats** | "我这周总体花了多少？" | provider / 模型 / 工作区聚合 |

改造后 Tasks 只做**任务维度的 join 与汇总**，不复制 Agent 的实时控制面，也不复制事件流。

---

## 6. 需先拍板的 6 个决策

| # | 决策 | 建议 | 不定的后果 |
| --- | --- | --- | --- |
| D1 | 任务身份（§3.4 A/B/C） | A+B 渲染层投影，C 后置 | 无法定义"点开的是哪个任务" |
| D2 | 用量默认关闭怎么办 | 面板显示"未启用"CTA，并**不**改默认值 | 改默认值涉及隐私面，不能顺手做 |
| D3 | 一任务多工作区的主/次 | worktree 新增显式 primary 语义（投影里也可先用"最近活动"代） | 现有代码处处"取第一个" |
| D4 | 无 tracker 的本地任务进不进列表 | 进；**R1 已修订**：不是独立分组，而是 `◇` 徽标 + 顶部筛选 | 最常见的用法被排除 |
| D5 | 移动端一期做不做 | 不做，明确"桌面独有"并登记 parity 豁免 | 跨端契约门禁会持续报差异 |
| D6 | 关系存哪（§8） | 派生不存；provenance 留既有字段；任务实体进 `taskRecords` domain | 变成"只有投影"，手动组织与历史成本全丢 |

### 6.1 评审后修正（2026-11-09）

下表来源列的 A/B/C 指 2026-11-09 的三位评审者；2026-11-16 的两位评审直接以 agent 名标注
（codex-ark / trae），R8–R15 沿用该表记法以免重编号。

| # | 修正 | 来源 |
| --- | --- | --- |
| R1 | `Unlinked` 从分组降为**徽标/筛选器**（`◇`）；分组只保留运行/交付状态，并定义互斥优先级 | A |
| R2 | 逐 Agent 只显示 **token**，金额只出现在工作区级与任务级；会话级归因未成立前不显示金额 | A、C |
| R3 | 图 B 默认折叠历史 Agent、次要工作区与 Delivery/Evidence | A |
| R4 | M1 的 selector 必须可被 M2 直接复用，否则暂停并重新拆包 | A、B |
| R5 | M2 拆为 `M2a 存储兼容验证` + `M2b 落库实现`；M2a 不过就只交付 M1 | B |
| R6 | M1 的对照数据要覆盖 OpenCode 与 Muse，不只 Claude/Codex | C |
| R7 | `projectBreakdown.key` 必须经解析层 + 单测，不直接散落 `split(':')` | C |

`Delivered` 的产品定义已于 2026-11-16 由产品 owner 定为 **agent done**（D12，见 §7.2 / §6.4）；
分组优先级（`Needs you > Working > Delivered`）与归属规则同步冻结，遗留只有"失败轮是否算"一项。

### 6.2 决策记录（2026-11-16，列表页 dock 与任务草稿行）

本节记录一轮独立于 D1–D6 的产品决策：Tasks **列表页**底部加一个 agent dock，用来把任务"说出来"。
设计与实现约束见 §7.9。

| # | 决策 | 取值 | 依据 |
| --- | --- | --- | --- |
| D7 | dock 位置 | Tasks 列表页的页面级底部 dock（列表卡片**外**），不挤压卡片边框；分页条仍钉在卡片内 | §7.9.2 |
| D8 | 草稿行是否侧栏可见 | **可见**：与普通工作区同一列表、同一 project group lane | 用户 2026-11-16 |
| D9 | 草稿行载体 | 一期 `FolderWorkspace` + `taskDraft` 标记（渲染层投影）；`taskRecords` 落地后换数据源，UI 不变 | §7.9.4 |
| D10 | 任务写通道 | Linear 走 `orca linear create`；GitHub 主通道走已有 `github.createIssue` RPC + 薄 CLI 动词（`gh` 仅备通道）；Jira 只出草稿、由预填表单落库；**一期不新增 RPC** | §7.9.6 / R8 |
| D11 | 草稿行生命周期默认 | 任务创建成功后保留并折叠、标 `#…`；30 天无活动且已关联任务 → 自动归档（不删目录、不删任务） | §7.9.8 |

D8/D9/D11 只描述一期的投影形态，**不等于**批准 `taskRecords` 落库：该项仍受 §8 与
[开发计划](development-plan.md) 的 M2a 判决约束。

### 6.3 评审后修正（2026-11-16，T2 面板）

两个独立评审（codex-ark / trae，同一 brief、互不可见）都给出"接受但需改"，并共同指出同一批事实性
问题。逐条修正如下（未改方向的只补约束）：

| # | 修正 | 依据 |
| --- | --- | --- |
| R8 | **GitHub 写通道改为 RPC 优先**：`github.createIssue` 已在 RPC catalog，缺的只是一个 CLI 动词；`gh` 降为备通道 | 评审 A、B 独立指出；`rpc-params-catalog.generated.ts` 有 `github.createIssue`，`src/cli/handlers` 无 github 动词 |
| R9 | §7.9.7 的失败清单改为**状态机**，新增 `issue-created-link-failed` / `duplicate-suspected` / `agent-crashed` 三态 | 评审 A、B |
| R10 | 草稿 folder workspace **必须显式传 `folderPath`**：`folderWorkspaces:create` 在不传时回落到 `projectGroup.parentPath`，会把 agent 的 cwd 放到仓库父目录 | 评审 A 指出，已在 `src/main/ipc/repos/folder-workspace-handlers.ts` 核对 |
| R11 | 草稿命名：`getWorkspaceIntentName` 对纯中文指令返回 `null`（`slugifyForWorkspaceName` 只保留 `[a-z0-9._-]`），必须有非空 fallback + 重名后缀 | 评审 B 指出，已在 `src/shared/workspace-name.ts` 核对 |
| R12 | 计数/Recent 排除必须落成**独立 selector 模块**（`task-draft-count-exclusion.ts`），M2b 扩此模块而不是散落 `if` | 评审 A、B |
| R13 | 防重：预览阶段先查同 repo 同标题 issue，命中则让用户选"复用 / 仍新建"；两个入口（dock 与 `＋ New issue`）共享同一提示 | 评审 A、B |
| R14 | 生命周期归属写清：30 天归档由**启动时一次有界 sweep** 执行（不做后台 watcher），活动信号用 `FolderWorkspace.lastActivityAt`；归档只隐藏、不删目录 | 评审 B 指出原文只有行为没有实现方 |
| R15 | 演化硬约束：草稿行**必须**同时写入 `linkedTask` 与 `linkedTaskSourceContext`，否则 M2b 投影会丢 `provider/projectId/repoId/hostId` | 评审 B |

评审还共同确认了两件事：形态 A（页面级 dock）正确，不采用卡片内位置；一期投影而非先做 `taskRecords` 的取舍成立。
完整记录见 [评审记录](discussion-record-t2-dock.md)。

---

### 6.4 评审后修正（2026-11-16，任务工作台 UI 两轮）

对象：§7.1 IA、§7.2 列表主轴、§7.3 图 B 工作台。两轮独立评审（codex-ark / trae）；第二轮只追问 4 个能改变
决定的点，两份稿见 [评审记录](discussion-record-task-workspace-ui.md)。

**能冻结（现在定）**

| 项 | 取值 |
| --- | --- |
| IA 主轴 | "任务 → 工作区(0..N) → Agent → 用量 → 交付证据"成立，不再推翻 |
| 一期形态 | M1 = 现有 issue/PR 详情加 `Orca` tab（§7.4），零持久化 |
| 分组规则 | 按**活跃（非归档）工作区状态并集**判定，不按 primary；0 工作区 / 无 tracker / 归档见 §7.2 |
| 侧栏 | **不加任务行**；只保留工作区/草稿行 + 任务徽标（两评一致） |
| 降级顺序 | §7.3.1（先牺牲 Delivery，再 Agent 历史，最后 Spend 细节；Workspaces 身份与 CTA 不牺牲） |
| selector 合同 | identity / join / usage 三件套必须可被 M2b 直接复用（R4），不在页面内拼装 |
| `Delivered` 定义 | **agent done**（D12，§7.2）：忽略 `sessionBoundary`，`failure/cancellation` 不计入；语义是"这一轮做完了"，不是验收通过 |

**不能冻结（现在保留为开放项）**

| 项 | 原因 |
| --- | --- |
| 图 B 的三区像素布局与折叠细节 | 无任何真机渲染证据（§12）；两评都判这是最大返工区 |
| 入口位置（点列表行 vs issue 详情 tab） | M1 与 M2b 必然不同，现在定就是自缚 |
| 任务头部字段（目标/验收/授权/owner） | M1 取不到；见下条 |
| 显式 primary | 需要持久化语义，属 M2b |

**任务意图层（两轮最大发现）**：工作台真正缺的一层是"任务目标/验收/授权/owner"。M1 只能从现有数据取到
弱信号：tracker 标题与 body、PR `checksSummary/reviewDecision/mergeable`、`sparseTaskBinding.requiredPaths`、
`linkedTaskSourceContext`；取不到的是显式验收标准、任务 owner、授权人。因此 **M1 在文案与命名上只能做
"任务聚合视图"，不得承诺完整任务对象**；两者分歧仅在此：A 认为可保留"工作台"名称仅限缩文案，B 认为
必须改名。本文取保守口径（B），M2b 有 `taskRecords` 后再叫"任务工作台"。

### 6.5 方向变更（2026-11-17，dock 改为 agent 输入框）

产品 owner 推翻了 §7.9.6 / §7.9.7 的"app 侧创建链"，改为把任务创建交还给 agent 自己。原话：
"任务列表页底部一个 TUI 输入框 → 选模型、输指令 → 发送后在新建的 taskDraft 草稿工作区里起 agent，
agent 用 Orca 既有 tracker skills 自己建 issue。dock 不调 tracker RPC、没有预览卡、没有状态机。"

| # | 决策 | 取值（取代旧值） | 旧值 |
| --- | --- | --- | --- |
| D13 | dock 的职责 | **只做输入**：一条指令 + 一个模型 + 一次发送；发送后的一切（建单、回报 URL）发生在草稿的 agent 会话里 | D7 位置不变，但去掉预览卡与 dock 内进度态 |
| D14 | 任务写通道 | **agent 通道**：agent 用 Orca 既有 tracker skills / CLI 动词自己建单；dock 不调 `linear.issueCreate`、不调 `github.createIssue`、不走 `gh` 备通道 | D10（RPC 优先 + 薄 CLI 动词 + `gh` 备通道） |
| D15 | 模型选择 | dock 内可选模型，以 `--model` 追加到 agent 启动参数；无候选时退化为自由文本输入；空值 = agent 自己配置的默认 | 无（新增） |
| D16 | 写前确认 | **取消** app 侧"预览 → 确认 → 执行"：写 tracker 由 agent 按 skill 的约束负责；app 侧不再提供预览卡，也不承诺提交前的二次确认 | R9 的 16 态状态机整体**撤销** |
| D17 | `linked to #…` | **延后**（本次未实现）：需要一条薄 CLI 动词转发 `folderWorkspace.update`，由 agent 建单后回写；当前只要求 agent 在会话里回报 issue URL | D11 的"创建成功后写 `linkedTask`" |

范围不变的部分：草稿仍用 `FolderWorkspace{ taskDraft: true }` 承载（D9）、目录仍是 `userData` scratch
（§7.9.5）、侧栏草稿行与计数/Recent 排除保留（D8）、`WP-T2d` 不做回退。实现形态见 §7.10。

代价（记在被撤销的一侧，供以后判断是否值得回去）：app 侧不再能证明"写 tracker 前有人确认"——那一条
验收标准随 D16 一起撤销；反过来，dock 也不再需要维护 16 个状态各自的 UI 与重试归属。

---

## 7. UI 设计

设计语言遵循 `orca/docs/STYLEGUIDE.md`：只用 `components/ui/` 既有 primitive（`card` `badge` `tabs`
`collapsible` `sheet` `hover-card` `tooltip` `progress` `separator`），不新增色值/字号/阴影层级；
状态 glyph 复用 Agent 既有语义（spinner=working、amber=needs you、emerald=done、red=blocked、gray=idle）。

线框图里的界面文案用英文（Orca 默认 UI 语言为英文，zh/ja/ko 走 locale catalog）；实现时所有文案都必须
进 catalog，不能把图里的字符串直接写死。`⚑` 表示折叠的子 Agent 组。

### 7.1 信息架构

```text
Tasks (top level view)
├── 工具条：provider 过滤 · 搜索 · 分组切换（Task / Provider）
├── 列表（分组）
│   ├── Needs you        ← 关联 Agent 里有 blocked/waiting
│   ├── Working          ← 有 working 的 Agent
│   └── Delivered        ← agent done（D12；不等于验收通过）
│   （`◇` 无 tracker 是行内徽标 + 顶部筛选，不是第 4 个分组，见 §6.1 R1）
└── 详情（点开列表行）
    ├── 头部：标题 · provider · 状态 · 主工作区/分支 · 基线 SHA · PR 缩略
    ├── 左：Agents（活 / 保留 / 历史，可折叠子 Agent）
    ├── 右：Workspaces（0..N） · Spend（用量）
    └── 底：Delivery（commits/PR/checks/review） · Evidence（binding / 会话链接）

另：底部 dock（常驻，§7.9）——不挂在上面任何一级下，横跨整个列表页：
一句话 → 任务草稿行 → agent 把任务写进 tracker。
```

底部 dock 与列表主轴**正交**：不论列表是今天的 provider 列表还是 §7.2 的分组列表，它都在同一位置；
它不进分组、不参与行内信息优先级，也不替代 `＋ New issue` 表单。

### 7.2 图 A：任务列表（方案 2 形态）

```text
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│  Tasks                              [ All providers ▾ ]   [ Search…        ]   ⌘F         │
│  ◉ Needs you 3    ◐ Working 4    ✓ Delivered 12   ◇ No tracker 5  [ Tracker: all ▾ ]      │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│  NEEDS YOU                                                                                │
│  ◉  Add login auth                    GitHub #412    ▦ 2 ws   ⚑ 2 agents    4m   $1.82    │
│  ◉  Retry backfill on resume          Linear FIN-88  ▦ 1 ws   ⚑ 1 agent     9m   $0.44    │
│                                                                                           │
│  WORKING                                                                                  │
│  ◐  Sparse task workspace rollout     Jira ORCA-31   ▦ 1 ws   ⚑ 3 agents    1m   $6.10    │
│  ◐  Task tab redesign                 local ◇        ▦ 1 ws   ⚑ 1 agent    now   —        │
│  –  investigation/perf-spike          local ◇        ▦ 1 ws   ⚑ 1 agent     1d   $0.91    │
│                                                                                           │
│  DELIVERED                                                                                │
│  ✓  Bump swarm-orca docs              GitLab !77     ▦ 1 ws   ⚑ 2 agents    2h   $2.20    │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│  ⌁ Ask Orca to create or change a task…                                         [▸ Send]  │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

图 A 底部的 dock 就是 §7.9 的形态（图 D）：T2 先在今天的 provider 列表上落地，M2b 翻列表主轴时
它不下移也不重做，只换数据源。

行内信息优先级（窄宽度降级顺序）：状态 → 标题 → provider → workspaces → agents → 时间 → 花费。
花费列在 D2 未解决前允许整体隐藏（设置项），不做 `$0` 占位。

分组规则（2026-11-16 两轮评审修正，| 号内为新增/改写部分）：

- **归属按状态并集，不按 primary**：取该任务下**所有非归档工作区**（+ tracker 条目自身）的状态并集；
  `Needs you` > `Working` > `Delivered` 依次判定。primary 只决定"默认打开哪个工作区"，不决定分组。
- 一条任务只出现在一个分组里；两个工作区一个 working 一个 done → `Working`；任一 needs-you → `Needs you`。
- **0 工作区**：有 tracker 且 open → `Working`；有 closed/merged 证据 → `Delivered`；
  既无 tracker 也无工作区 → 不成列表项（不凭空造任务）。
- **无 tracker 的工作区**：与有 tracker 的任务同组，只多一个 `◇` 徽标；多工作区合并在 M2b 之前**不做**。
- **已归档工作区**：不参与 `Needs you` / `Working`；只剩归档且有完成证据时只能出现在 Delivered 的
  `Show archived` 下。
- `◇` 是**属性徽标**（无 tracker），与分组正交；顶部 `◇ No tracker 5` 是筛选入口，不是第 4 个分组。
- `Delivered` = **agent done**（产品 owner 2026-11-16 定，D12）：该任务下**任一活跃工作区**里有 agent 处于
  `done`，且同任务下没有 `working/blocked/waiting`（否则按 `Needs you > Working` 优先）。
  - 有效 `done`：忽略 `sessionBoundary === true`（connect/resume/clear 落地，不是完成一轮）；
    `outcome === 'failure' | 'cancellation'` **不算** Delivered；`outcome` 缺失（provider 未上报）仍算 done。
  - 语义：Delivered = "agent 声明这一轮做完了"，**不等于验收通过**。UI 文案只能说 `Delivered · agent done`，
    不得写"已完成/验收通过"，测试夹具也不得把它们当作等价。
  - resume 后状态回到 working → 自动离开 Delivered（派生，不缓存）；无 agent 或 0 工作区的任务不可能是 Delivered。
- primary workspace 缺失时按"最近活动"兜底，并在 UI 显式标注为派生（不是用户选择）。

### 7.3 图 B：任务详情（工作台）

同图的矢量/位图版本：`task-workbench-ui.svg`、`task-workbench-ui.png`（2560×1720，2× 渲染，含 0 工作区与
降级两图）。P1a 的组件拆分、fixture 与截图清单见 [P1a 静态壳计划](p1a-ui-shell-plan.md)。

```text
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│  ← Tasks                                                                                  │
│    Add login auth        GitHub #412 · open · web-app                                     │
│    base 8f3c1ab → feature/add-login    PR #431 (draft · checks 5/6)                       │
│               [ Open workspace ]  [ ⋯ ]       交付/证据默认折叠                           │
├─────────────────────────────────────────────────────────────────┬─────────────────────────┤
│  AGENTS (4)                     [ All agents ▾ ]                │  WORKSPACES (2)         │
│  ┌─────────────────────────────────────────────────────────┐    │  ▸ web-app              │
│  │ ◐  claude-sonnet-4.5 · add-login-impl                   │    │  feature/add-login      │
│  │    "wire JWT middleware into auth routes"               │    │  1 agent · 412k tok     │
│  │    working · 12m · 412k tok        [open]               │    │  $1.20                  │
│  ├─────────────────────────────────────────────────────────┤    │  ▸ api                  │
│  │ ✓  codex-5.1 · jwt-verify-fix                           │    │  feature/jwt-verify     │
│  │    done · 6m · 890k tok        [resume]                 │    │  2 agents · 890k tok    │
│  ├─────────────────────────────────────────────────────────┤    │  $0.62                  │
│  │ ▸  archived & history (2) · 61k tok · 2d                │    │  + create workspace     │
│  │    (默认折叠，展开才拉 AI Vault 明细)                   │    │                         │
│  └─────────────────────────────────────────────────────────┘    │  SPEND · task level     │
│                                                                 │  1.36M tok              │
│                                                                 │  est. $1.82             │
│                                                                 │  claude 412k · $1.20    │
│                                                                 │  codex  890k · $0.62    │
│                                                                 │  opencode 61k · (—)     │
│                                                                 │  ⓘ 1 session            │
│                                                                 │      unattributed       │
├─────────────────────────────────────────────────────────────────┴─────────────────────────┤
│  DELIVERY   commits 3 · PR #431 draft · checks 5/6 · review pending  [ expand ]           │
│  EVIDENCE   binding ok · base 8f3c1ab · cone 4 dirs · requiredPaths present               │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Agent 行元素与来源：

| 元素 | 来源 |
| --- | --- |
| 状态 glyph | `agentStatusByPaneKey`（活）/ `retainedAgentsByPaneKey`（保留）/ `archived`（AI Vault） |
| 会话名 | `getAgentRowConversationName`（custom → quickCommand → provider title → generated → live title） |
| model | 状态行 `model`；历史会话取 transcript 记录的 model |
| 时长 | 状态行 `stateStartedAt` / 会话时间窗 |
| tokens | 会话级用量（需 D1 之外的 additive `worktreeId`，或 AI Vault `totalTokens`）；子 Agent 用 `totalTokens` 上报 |
| 花费 | **逐 Agent 不显示金额**（会话行无 `worktreeId`，精确归因未成立）：只显示 token，金额只到工作区/任务级；未定价显示 `—` 并给 `hasUnpricedModels` 提示 |
| `[open]` / `[resume]` / `[view]` | 复用 `activateThreadTerminal` / AI Vault resume / 结构化会话 resume |
| **所属工作区** | 评审新增（`M1` 必须）：多工作区时每个 Agent 行必须带 workspace 标识（`▦ web-app · feature/x`）；
只到 M2b 才可降为 secondary chip |

花费口径提示（tooltip 文案要点）：估算值、按 provider 计价、未启用统计/远端工作区/歧义会话不计入 0。

#### 7.3.1 降级顺序（评审新增；窗口边界必须有规则，否则每人一套）

原则一句话：**永远不牺牲 Workspaces 的身份与主操作**，它是 M1/M2b 的锚点；先牺牲 Delivery，其次 Agent 历史，
最后 Spend 细节。

| 条件 | 依次牺牲 | 形态 |
| --- | --- | --- |
| 窄窗 < 1100px | ① 左右并排 → ② Delivery 常驻 → ③ Spend 细节 | 单列：Header → Workspaces 摘要/CTA → Agents → Spend 一行摘要 → Delivery 折叠条 |
| 矮窗 480px | ① Delivery → ② 历史/保留 Agent → ③ Spend 图表 | Workspaces 保留紧凑摘要；Spend 降为一行 badge；Delivery 折叠条 |
| 0 工作区 | ① Spend → ② Delivery → ③ Agent 历史 | Workspaces 变主空态 + `Create workspace`；Spend 显示不可用/未启用 badge；Delivery 只读提示（M1 无工作区证据即空态，不隐藏） |
| 10+ Agent | ① 历史明细 → ② 保留 Agent 明细 → ③ Delivery 展开 | Agents 分 Active/Needs you 常显 + History 折叠；Workspaces 不隐藏 |

M1（§7.4 只读 tab）只实现前三行中最简单的一种：单列 + Delivery 折叠；图 B 的三区只作目标形态，不冻结像素。

### 7.4 图 C：增量方案（现有详情加一个 Orca 面板）

不改列表主轴，只在既有详情里加一个 tab（`ItemDialogTab` 增加 `'orca'`，PR 与 issue 共用）。
M1 阶段它的正式定位是 **任务聚合视图**（§6.4），tab 名可以是 `Orca`，但文案不得承诺完整任务对象：

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│  #412 Add login auth                          [ Use ]   [ Open in GitHub ↗ ]   │
│  Conversation     Checks     Files     [ Orca ]                                │
├────────────────────────────────────────────────────────────────────────────────┤
│  WORKSPACE   web-app · feature/add-login · base 8f3c1ab     [ Open workspace ] │
│              PR #431 draft · checks 5/6 · review pending                       │
│                                                                                │
│  AGENTS      ◐ claude-sonnet-4.5  add-login-impl   working 12m  412k tok       │
│              ✓ codex-5.1          jwt-verify-fix   done     6m  890k tok       │
│              – claude-opus        spike            archived 2d   61k tok       │
│                                                                                │
│  SPEND       1.36M tokens · est. $1.82        ⓘ 1 session unattributed         │
│                                                                                │
│  (无关联工作区时)  Create workspace from this issue  →                         │
│  (用量未启用时)    Usage tracking is off.  [ Turn on in Settings ]             │
└────────────────────────────────────────────────────────────────────────────────┘
```

为什么先做这个：详情页已经有 `repoId / number / type`，反查函数已在手，用量可从 store 现成的
`*UsageProjectBreakdown` 按 `worktree:<id>` 直读——**不需要新 scan、不需要新 RPC、不碰移动端契约**。

图 C 只覆盖"详情页里看任务"；列表页的输入入口是 §7.9 的底部 dock（图 D），两者不重复：
详情页不另开对话，列表页不复制 Agent 详情。

### 7.5 状态矩阵（必须逐条实现，否则会出现"假 0"）

| 场景 | 触发条件 | UI 表现 |
| --- | --- | --- |
| 用量可用 | `estimatedCostUsd !== null` | 数字 + 估算 tooltip |
| 用量统计未启用 | `scanState.enabled === false` | 面板空态 + `[ Turn on usage tracking ]` 跳 Settings → Stats |
| 未定价模型 | `hasUnpricedModels` | tokens 正常、花费显示 `—` + 说明 |
| 会话归因歧义 | 时间窗内多个候选 | `unavailable · ambiguous_session`，不猜 |
| 无匹配会话 | 窗口内无会话 | `unavailable · no_matching_session` |
| 远端 / SSH 工作区 | `executionHostId` 非本地 | `unavailable · remote host` |
| 无关联工作区 | 任务无绑定 | 主按钮 `Create workspace from this task` |
| 本地任务（无 tracker） | 仅在 worktree 侧存在 | 行内 `◇` 徽标 + 顶部筛选；按活跃工作区状态并入 Needs you/Working/Delivered，标题取 `displayName` |
| 工作区已归档 | `isArchived` | 折叠在 `Show archived` 下，不参与"Needs you"计数 |
| 逐 Agent 成本不可归因 | 会话行无 `worktreeId` / `ambiguous_session` | 该行只显示 token；成本显示 `—`，文案说明"仅到工作区级" |
| 无 tracker 的工作区 | 无 `linkedWorkItem` 等字段 | 行内 `◇` 徽标 + 顶部筛选；不影响其状态分组 |

### 7.6 组件与数据映射（实现清单草案）

| 新组件（建议命名） | 数据源 |
| --- | --- |
| `task-workbench-identity.ts`（投影：worktree+provider → `taskKey` + 分组） | `worktreesByRepo`、`linkedWorkItem`、`linkedTaskSourceContext`、`TaskProviderIdentity` |
| `task-workbench-agent-rows.ts` | 复用 `buildWorktreeAgentRows` + `selectWorktreeAgentRowsCached`（dashboard 已在用） |
| `task-workbench-usage.ts`（按 `worktree:<id>` 取聚合；三态收敛） | `claudeUsageProjectBreakdown` / `codexUsageProjectBreakdown` / `openCodeUsageProjectBreakdown` / `museUsageProjectBreakdown` |
| `TaskWorkbenchPanel.tsx` | 上述三者 + `sparseTaskBinding` + `linkedPR` |
| `task-workbench-agent-row.tsx` | `DashboardCard` 形状（`shared/dashboard-snapshot.ts`），避免再造一套行模型 |
| `task-workbench-usage-card.tsx` | `automation-usage-summary` 的 known/unavailable 语汇（不造新词） |

反查升级点：`findGithubWorkItemWorkspaceAttachment` → `findGithubWorkItemWorkspaceAttachments`（返回列表），
并给 Linear/GitLab/Jira 提供同构的 `collect*Attachments(worktrees, identity)`。

这些组件读的都是派生数据；**需要持久化的只有任务实体本身（§8）**，组件不直接写盘。

### 7.7 交互

- `⌘F` 聚焦搜索（与既有 Tasks / Agents feed 一致）；`↑/↓` 在列表内移动；`↵` 打开详情；`esc` 回列表。
- 行 hover 出 `[ Open workspace ]`，不改变点击语义（点击=详情）。
- Agent 行点击 = 打开该 Agent 的终端/会话；`[ resume ]` 仅在存在可恢复 provider session 时出现。
- 分组折叠状态持久化（沿用 `taskPageResume` 一类既有 UI 状态通道，不新建存储）。

### 7.8 Agent 派生树（旁路，可随时独立合入）

来源：用户 2026-11-09 的需求。"目前我在项目区的 TUI 中，新开 agent 的时候，会并行罗列"，
希望改成父子树：

```text
▾ TUI · claude-sonnet-4.5              ◐ working   12m
  ├─ 派生1 · codex-5.1                 ◐ working    4m
  └─ 派生2 · gpt-5.5                   ✓ done       2m
```

**这条不依赖 `taskRecords`，也不依赖 M2a**，可以在 M1 之前或并行单独交付。

现状（读代码）：

- Agent 状态 store 里**已经有子行/层级的能力**：`orchestration.parentPaneKey` 用于 host 上报的 subagent，
  `applyAgentRowLineage` 提供 `depth 0/1`、首/末子节点、`childCount` 与连接线（Dashboard 在用）；
  `shared/agent-child-row-model.ts` 提供子行模型。
- 缺的是**用户自己启动的 Agent 的派生关系**：`terminal create` / `tab.newAgent` 建的 tab 记的是
  `worktreeId`，没有"从哪个 pane 派生"的指针，所以只能并列。
- 因此根因不是渲染，而是**provenance 缺失**：没有父子指针，树就没有来源。

设计要求（三条，缺一条就不做）：

1. **来源必须显式**：新 agent 在创建时记录来源（`TerminalTab` 增加 additive 可选字段，
   例如 `spawnedFromPaneKey` / `parentTabId`，随 tab 持久化，与 `viewMode`/`isPinned` 同款先例）。
   **不靠**标题相似、时间接近或 tab 顺序去猜父子。
2. **三类来源分治**：① provider 上报的 subagent（已有 `parentPaneKey`，继续走现有子行）；
   ② 用户从某个 agent 启动的新 agent（本期新增，用 1 的来源字段）；
   ③ 没有来源（CLI、快捷键、外部创建）→ 保持平级，**不强行归属**。
3. **只是呈现层级，不改实际布局**：PTY、tab、split 的实际层级与生命周期不变；树只影响列表的缩进、
   连接线、折叠与计数。

展示与交互：

- 主展示位：侧栏/工作台里的 Agent 行列表（与 Dashboard 共用行模型与 lineage 计算）。
- 父行可折叠，折叠态显示 `▸ TUI · 2`（子数量）；子行保留自己的状态点、时长、token 与跳转。
- 排序：父行按现有规则，子行按创建时间升序；**子行不参与父级的 `Needs you` 计数重复累计**（父行汇总，
  子行明细，计数只算一次）。
- 关闭与归档：关闭父 tab **不自动关闭**子 tab（各自有独立 PTY）；父行消失后子行**上提一级**并显示
  `◇ 来源已关闭`（不丢失、不改写来源字段）。
- 跨工作区不建树：子 tab 与其来源必须在同一 `worktreeId`；跨工作区只做互链。

明确不做：

- 不改变 split/PTY 布局，不把子 tab 变成 pane。
- 不改 `agentStatusByPaneKey` 单一 store 的状态语义，不新增第二套状态来源。
- 不做"自动发现父子"（不猜）。
- 不在移动端一期实现（与 D5 一致）。

验收点：

- 从 A 启动 B、再启动 C：侧栏显示 `A ▸ B / C` 两层，折叠态计数正确。
- 直接用 CLI 启动 D：与 A 平级，不带连接线。
- 关闭 A：B、C 上提一级并带"来源已关闭"标记，状态点与跳转仍可用。
- provider 上报的 subagent 与用户派生同时存在：两类子行共存且不重复计数。
- 旧 build 读新 tab 记录：忽略未知可选字段，tab 仍能恢复（与 §8.6 的 additive 规则一致）。

### 7.8.1 实施状态（2026-11-09，分支 `agent-spawn-tree`）

已实现（`orca/` 快照上 5 个提交，逐条对应本节验收）：

- 来源字段：`TerminalTab.spawnedFromPaneKey?: string`（additive optional，缺省=平级）；host RPC
  `session.tabs` 只在调用方显式给出时转发，runtime-owned/headless 持久化、PTY 重发布不擦除、
  mobile/client 投影带出。
- 唯一写入入口：侧栏 agent 行的显式派生动作（full/compact 行上的派生按钮）。快捷键
  `handleNewAgentTab`、`cli`、外部创建**不写**来源，也不按 active tab 推断。
- 建树与折叠：行模型把来源投影成 renderer-only 的 lineage parent（不伪装成
  `entry.orchestration.parentPaneKey`），父行折叠沿用既有 `+N` 计数通道；provider subagent
  仍是 `rowSource:'subagent'` 的 synthetic 子行，可与用户派生子行共存。
- 交互：父 tab 缺失时子行上提为 root 并带 `originClosed`（显示 `◇ 来源已关闭`），状态点与
  跳转仍指向子行自身；跨 `worktreeId` 视为无来源。
- `Needs you` 去重：在 bucket 计数层按 lineage 分组只计一次（`collectAgentLineageAttentionCounts`），
  其它 bucket 计数不受影响。

已知限制（不是欠账，是本期取舍）：

1. **structured（native-chat）agent 暂不提供派生入口**：把来源透传进 structured launch/settlement
   与 paired host authority 需要 host/main 侧契约，超出本期 renderer-only 的窄改动；因此宁可
   不提供按钮，也不静默把用户降级到 legacy terminal create（丢掉 structured 会话/恢复能力）。
2. **`Needs you` 只在 renderer 计数层去重**；Task workbench 列表 selector 尚未实现，接入时
   必须复用同一函数，不得另建第二套计数。
3. **旧 build 的往返语义**：旧 build 读新 tab 记录能恢复 tab（未知字段被 Zod strip），但旧
   build **再写盘会丢掉** `spawnedFromPaneKey`，派生关系跨旧 build 不保留。验收措辞以本条
   为准；要跨版本保留需另做持久化兼容设计。
4. provider synthetic 行（`rowSource:'subagent'`）**不可派生**：其 `paneKey` 是合成值，写入
   来源会得到无法解析的父边。

证据与复核：实现分布在本节所列文件的提交里（来源字段、行模型、交互、发起端四处），
对应测试见 `orca/src/shared/workspace-session-terminal-schema.test.ts`、
`orca/src/renderer/src/components/sidebar/useWorktreeAgentRows.test.ts`、
`orca/src/renderer/src/components/dashboard/agent-row-lineage-model.test.ts`、
`orca/src/renderer/src/components/sidebar/WorktreeCardAgents.test.tsx`、
`orca/src/renderer/src/lib/agent-launch-caller-routing.test.ts`；每条验收都经过三方独立复审并
按复审结论收敛（synthetic 行不可派生、structured 路由 fail-closed、计数去重单点）。

**待你确认一件事**：你说的"项目区的 TUI"指哪一层——侧栏/工作台里的 Agent 行列表，还是顶部 tab bar
（或者两者都要）？我按"行列表为主、tab bar 只加父子小徽标"写的；如果实际是 tab bar 为主，本节的
展示与折叠段落需要改写。

### 7.9 列表页底部 dock 与任务草稿行（2026-11-16）

状态：**提案已部分撤销（2026-11-17，见 §6.5）**。位置（D7）、草稿行与载体（D8/D9）、目录与会话
（§7.9.5）、生命周期（§7.9.8）、计数排除（§7.9.8 末段）仍然有效；**§7.9.6 的任务写通道、
§7.9.7 的时序与状态机、§7.9.9 里的 `task-draft-issue-create.ts` / `task-draft-preview-card.tsx`
已被撤销**，当前实现形态见 §7.10。本节其余内容保留为 2026-11-16 评审通过的原始提案，供对照。
需求原话（用户 2026-11-16）："在任务页面下方加 agent 对话框，可以用来修改创建任务"；点击左上角
任务进入的页面指 **Tasks 列表页**，不是 issue/PR 详情页。草稿行"只是为了创建任务"，本质是
**task 开发模式（sparse task workspace，见 [任务工作区设计](../task-workspaces.md)）的前置工作**，
不承载代码；任务创建后实施方可能是别人。

#### 7.9.1 现状（读代码确认）

| 事实 | 证据 |
| --- | --- |
| 列表页 = `chrome`（provider / repo / 搜索 / `＋`）＋ `flex-1` 列表卡片；卡片底部已钉 `PaginationBar` | `orca/src/renderer/src/components/task-page/Frame.tsx`、`task-page/github/List.tsx`（分页条注释"sits outside the scroll container"）、`task-page/PaginationBar.tsx` |
| 卡片外只剩 frame 的 `pb-4 / pb-5` 内边距，没有常驻元素 | 同上 |
| 新建任务入口是各 provider 的表单弹窗（`＋` 在 `Filters` 工具条） | `task-page/{github,linear,jira}/Filters.tsx`、`task-page/*/IssueDialog.tsx` |
| agent 可写的只有 Linear | `orca/src/cli/handlers/linear.ts`（`linear create` → `linear.issueCreate`） |
| GitHub/Jira 创建只有 renderer store + IPC，无 agent 通道 | `use-task-page-github-issue-creation.ts`、`use-task-page-jira-issue-creation.ts` |
| 侧栏行是分型的；folder workspace 在每种 Group by 下都有 lane，并已有宿主计数 | `sidebar/worktree-list/grouping/row-types.ts`、`folder-workspace-lanes.ts`、`sidebar/host-section-folder-workspace-counts.test.ts`、`rows/virtual-row-dispatch.tsx` |
| folder workspace 已能承载 agent 会话，且自带 `linkedTask` | `shared/folder-workspace-types.ts`、`sidebar/folder-workspace-agent-startup.ts`、`shared/rpc-contract/folder-workspace-params.ts` |
| 现有快速创建模态**故意忽略** prompt 预填；带 prompt 的是 full-submit 路径 | `NewWorkspaceComposerModal.tsx:136-138`、`hooks/composer-state/full-submit-source-preparation.ts` |
| 名称派生已存在：`getWorkspaceIntentName` / `slugifyForWorkspaceName`（48 字符上限） | `orca/src/shared/workspace-name.ts` |

#### 7.9.2 图 D：列表页底部 dock（决策 D7）

同图另有矢量/位图版本：`t2-dock-ui.svg`、`t2-dock-ui.png`（2560×1600，2× 渲染）。

> **注意（2026-11-17）**：下面两张图和本小节文字是 2026-11-16 提案的原样：展开态带
> `[Create draft] [Cancel]`、图注写"写 tracker 前必须人工确认"。实际交付的是 §7.10 的两态输入框
> （模型 select + Send/Close），**没有** Create draft / Cancel / 预览确认。图不作修改，保留为提案记录。

```text
┌ Tasks 列表页 ────────────────────────────────────────────────────────────┐
│ chrome：× 关闭 │ GitHub GitLab Jira Linear │ repo/scope │ 搜索 ↻ ＋        │
│ ┌ 列表卡片（flex-1，自身滚动）────────────────────────────────────────┐  │
│ │ 行 …                                                               │  │
│ │ [PaginationBar]（多页时才出现，仍钉在卡片内）                       │  │
│ └────────────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────────┤
│ ⌁ Describe a task or change…                              [▸ Send]       │  ← 折叠态：一行
└──────────────────────────────────────────────────────────────────────────┘
   展开态：多行输入 ＋ 目标 chip（provider · owner/repo） ＋ [Create draft] [Cancel]
```

- 放在卡片外、frame 的内边距里；卡片 `flex-1` 自动让出高度，不改卡片边框与圆角。
- 折叠态常驻一行；`⌘⏎` 提交、`Esc` 折叠，焦点不抢列表键盘导航（与 §7.7 一致）。
- 列表页没有"当前任务"上下文，dock 的 provider/repo 取当前 source + 当前 repo/team 选择，
  并以 chip 显示；切换 source 时 chip 跟随，已输入的文本不丢。

#### 7.9.3 图 E：侧栏草稿行（决策 D8/D9）

```text
▾ web-app
  ⌁ add-login-retry        draft · ◐ 1 agent             ← 草稿徽标 + agent 状态点
  ▸ feature/login-fix      ◐ 1 agent                     ← 普通工作区（不变）

任务创建成功后同一行：
  ⌁ add-login-retry        draft · linked to #412 · – idle
```

- 复用 folder workspace 行（`sidebar/worktree-list/rows/folder-row.tsx`），只多一个草稿徽标与
  `linked to #…` 片段；分支/PR/脏状态等对草稿无意义的元素不渲染。
- 点击 = 打开它的会话（不是代码视图）；右键菜单去掉"创建 PR / 交付"一类动作。

#### 7.9.4 为什么先投影，而不是直接 `taskRecords`（决策 D9）

语义上 `taskRecords` 才是正确归属（§8.2 的 C 方案），但一期不先做它：

- M2 被 M2a（旧 build 的 新→旧→新 round-trip）冻结，未判决前不引入持久化 domain；
- 加"第三种侧栏行类型"要同时改 `row-types.ts`、`virtual-row-dispatch.tsx`、分组 lane、
  宿主计数与激活路径，成本高于收益；
- 草稿的产物是 tracker issue，**持久物已经存在**，本地只需要"会话 + 链接"，丢了不致命。

因此一期用 `FolderWorkspace` 承载，加一个 additive 可选字段：

```ts
export type FolderWorkspace = {
  …
  /** 由 Tasks 列表页 dock 自动创建、只用于撰写任务的草稿工作区。 */
  taskDraft?: boolean
}
```

`taskRecords` 落地后（M2b），草稿行的数据源换成任务记录，UI 与交互不变；届时 `taskDraft` 字段
的清理需单独授权，不做静默迁移。

#### 7.9.5 草稿的目录与会话

- 目录：`userData` 下的 scratch 路径（每草稿一个），**不是**仓库 checkout——agent 的 cwd 若是用户
  主检出，它就可能直接改代码，绕开工作区隔离；也不给草稿建 git worktree（分支、setup hook、
  脏状态、PR、sparse pin 对它全部无意义，还会污染工作区计数与用量归因）。
- 会话：`launchAgentInNewTab` 起一个 agent tab（folder workspace 已是合法 launch target，见
  `shared/workspace-launch-kind.ts`），初始 prompt 由 dock 生成。
- 一个草稿复用同一个 folder workspace：后续追问接着在同一会话里说，不要每条指令新建一行。

#### 7.9.6 任务写通道（决策 D10）

> **已被 §6.5 / §7.10 取代（2026-11-17，D14）**：dock 不再调任何 tracker RPC，也不提供 `gh` 备通道；
> 建单由草稿会话里的 agent 按既有 skills / CLI 动词完成。下表与 R8 决议保留为历史。

| provider | 通道 | 约束 |
| --- | --- | --- |
| Linear | `orca linear create`（`linear.issueCreate`，main 侧已有） | 走 app 自己的 RPC，优先使用 |
| GitHub | **主通道**：`github.createIssue` RPC（`orca/src/main/runtime/rpc/methods/github-issue-methods.ts`，已在 catalog）+ 一个薄 CLI 动词 `orca github create-issue`；**备通道**：`gh issue create --repo` | 评审修正（R8）：仓库已有带 app 账号的 GitHub 写 RPC，绕开它改用 shell 会丢掉 app 代管的认证与远端宿主路由；`gh` 仅在用户未绑定 app 账号或显式选择时使用，且必须显式 `--repo`（cwd 在 scratch 目录）。两条通道都要 fail-closed，不静默切换，并在回执里记下用的是哪条 |
| Jira | agent 只产出草稿 | 创建要填必填 custom fields；由 Orca 打开已预填的 Jira 表单（`task-page/jira/IssueDialog.tsx`）落库 |

- 远端 / SSH 宿主：GitHub 主通道（`github.createIssue`）由 runtime 路由，仍然可用；只有备通道 `gh` 会缺失。
  两条都不通时才禁用并说明，不静默 fallback 到本机。
- **写 tracker 前必须有人确认**：dock 内先渲染标题/正文/标签预览，用户点 `Create issue` 才允许执行；
  对共享 tracker 的写不可撤销，不做"agent 直接建"。

#### 7.9.7 时序

> **已被 §6.5 / §7.10 取代（2026-11-17，D16）**：预览卡、"用户确认后才执行"与下面这张 16 态状态机
> 整体撤销。当前时序只有一段：输入 → 建草稿工作区 → 起 agent（见 §7.10）。本节保留原始提案。

```text
用户在 dock 输入指令
  → dock 展开：解析出 provider / owner-repo / 任务标题候选（getWorkspaceIntentName 派生草稿名）
  → [Create draft]：createFolderWorkspace({ projectGroupId, name, taskDraft: true, folderPath: <scratch>, … })
  → 起 agent tab，prompt = 指令 + 任务上下文（provider、owner/repo、"先出预览，确认后才创建"）
  → agent 产出标题/正文/标签 → dock 内预览卡片 → 用户确认
  → agent 执行 orca linear create / orca github create-issue / 或 Orca 打开 Jira 预填表单
  → 成功后回写 linkedTask：草稿行显示 linked to #412，sidebar 与 Tasks 列表都可点开
```

失败分支必须各自可见、可重试。评审（R9）要求把它写成**状态机**而不是一行清单；实现时下列每个状态都要有 UI 与重试归属，缺一个就算未完成：

| 状态 | 触发 | dock / 草稿行表现 | 能否重试 |
| --- | --- | --- | --- |
| `idle` | 空输入 | 发送禁用；草稿行不存在 | — |
| `no-context` | 没有可用 provider / repo / team | chip 标红 + 引导去连接；不建草稿 | 配置后 |
| `creating-draft` | 正在建 folder workspace | 进度 + 取消；取消则回收刚建的行 | 是 |
| `draft-failed` | scratch 目录 / folder workspace 创建失败（含**忘了显式 `folderPath` 而落到 project group parentPath**） | 写明失败原因；不留在侧栏 | 是 |
| `agent-launch-failed` | agent 未安装 / 启动失败 | 草稿行保留，标 `agent failed`；可重试起 agent | 是 |
| `drafting` | agent 在跑、还没产出预览 | 草稿行显示 agent 状态点；dock 显示运行中 | — |
| `preview-ready` | 有标题/正文/标签待确认 | 预览卡片 + `[Create issue]` / `[Cancel]` | — |
| `creating-issue` | 已点确认、写入中 | 禁用重复点击 | — |
| `issue-created-link-failed` | 任务建了但 `linkedTask` 未写回 | 必须能自动对账：用 provider 回执的 issue 号回写；不得重跑创建 | 只重试写回 |
| `provider-rejected` | 必填字段 / team / repo 不合法 | 显示 provider 原文错误；可改后重试 | 是 |
| `duplicate-suspected` | 预览阶段查到同 repo 已有同标题 issue | 列出候选（`#412 …`），让用户选"复用 / 仍新建" | — |
| `remote-unsupported` | 远端 / SSH 宿主上通道不可用 | 显式不可用 + 说明；不 fallback 到本机执行 | 否 |
| `cancelled` | 用户取消确认 | 回到 `drafting`，已草拟内容不丢 | 是 |
| `agent-crashed` | agent 会话结束但没产出预览 | 草稿行标 `agent exited`；可重开会话 | 是 |
| `archived` | 30 天无活动且已关联，或用户显式归档 | 折叠/归档，可恢复；不删任务 | 恢复 |

其中 `issue-created-link-failed`、`duplicate-suspected`、`agent-crashed` 是评审新增（原文档遗漏）。

> 实施修正（2026-11-17，P2 第二刀）：应用内确认后的创建由 dock 直接调用既有 RPC
> （`window.api.runtime.call` → `linear.issueCreate` / `github.createIssue`）执行，**不由 agent 执行
> CLI 动词**；agent 只负责草拟，CLI 动词仍是 agent 通道。`gh` 备通道保留，但只在用户显式选择时由
> draft 会话执行，属于较弱的人工路径（一次 prompt 不等于一次 `gh` 执行）。原因：写前确认必须能由
> 代码与测试证明，不能依赖 agent 是否服从 prompt；本 Run 只声明“dock 自己发起的调用”这一范围，
> 不声明草稿会话全局零写入。决定与代价见 Run 的 `decisions.md`。
>
> 状态补充（2026-11-17，评审后）：上表把「任务建了但链接没写回」和「不知道建没建」当成同一格，实现里
> 二者必须分开。后端对可能已经落库的写会返回 `linear_write_unconfirmed`（带 `writeId`），若把它当作
> 可重试的拒绝，用户再点一次就是重复建单。因此新增第 16 个状态 `outcome-unknown`：不提供“再建一次”，
> 只提示去目标侧核对后决定链接或删除该草稿。`task removed` 行状态暂不实现——本切片没有任何读取能
> 回答“任务已被外部删除”，UI 不渲染一个无法产生的状态；等 P3/M2b 引入该读取时一起加回。

#### 7.9.8 生命周期（决策 D11）

| 事件 | 行为 |
| --- | --- |
| 任务创建成功 | 保留草稿行，折叠并标 `linked to #…`；写 `linkedTask` |
| 30 天无活动且已关联任务 | 启动时一次有界 sweep 置 `isArchived`（不做后台 watcher），活动信号用 `FolderWorkspace.lastActivityAt`；保留行与目录，可显式恢复；不删 issue |
| 用户显式 `Archive draft` | 只归档本地，不动 tracker |
| 用户显式 `Delete draft` | 删行与 scratch 目录，不动 tracker；不级联删任务 |
| 任务被外部删除 | 草稿行保留，标 `task removed`，提供显式清理；不自动删 |
| 多任务 | 一期一个草稿一行、一次对话一条任务；多任务另开草稿 |

不计入：工作区计数（`sidebar-count-badge.tsx`、`host-section-folder-workspace-counts` 路径）、
Needs you、Recent、用量归因。排除逻辑必须是**一个** selector，不得在各处散落 `if (taskDraft)`。

#### 7.9.9 组件与数据映射（实现清单草案）

| 组件 / 模块（建议命名） | 职责 | 主要落点 |
| --- | --- | --- |
| `task-page/TaskDock.tsx` | 折叠/展开、目标 chip、模型 select、Send/Close | `task-page/Frame.tsx` 下方 |
| `use-task-page-dock-actions.ts` | 建草稿 folder workspace + 起 agent + 投 prompt（含第二条指令复用同一会话） | 新文件 |
| `lib/task-draft-prompt.ts` | 注入目标 / scratch 约束 / "你自己用 skills 建单并回报 URL" | 新文件 |
| ~~`lib/task-draft-issue-create.ts`~~ | ~~三 provider 的创建提议与预览模型~~ | **撤销（D16）**，已删除 |
| ~~`task-draft-preview-card.tsx`~~ | ~~标题/正文/标签预览 + `[Create issue]`~~ | **撤销（D16）**，已删除 |
| `task-draft-count-exclusion.ts` | 计数/Recent 排除的单一判断 | 侧栏 selector |

命名：草稿期用 `getWorkspaceIntentName({ sourceText, fallbackName })`（指令前 5 词或
`<动词> <对象>`），任务落库后可改名为 `<provider>-<number>-<slug>`；**改名只走显式动作**，
因为 `worktreeFingerprint` 含 `displayName`，高频改名会反复作废用量缓存。

命名补丁（R11，评审发现）：`slugifyForWorkspaceName` 只保留 `[a-z0-9._-]`，纯中文指令会被滑成空串，
`getWorkspaceIntentName` 返回 `null`。实现时必须：小中文指令取 `fallbackName`（如 `draft-<provider>`）
而不是报错；重名时加 `-1` / `-2` 后缀，不依赖底层唯一约束报错。

#### 7.9.10 与既有入口的关系

- `＋ New issue` 表单保留：Jira 必填字段、用户想直接填时仍然更快。
- `Use` / `Start workspace from issue` 不变：草稿行不替代"从任务开开发工作区"，两者是链上的两段。
  task 开发模式的入口仍是 `orca worktree create --sparse-task-dir …`（见 [sparse 任务工作区](../sparse-task-workspace/README.md)）。
- Dashboard / Agents feed 不复制：dock 只做"把任务说出来"，不做实时 Agent 控制面（§5 分工不变）。

#### 7.9.11 门禁与测试

> **已被 §7.10 取代的部分**："三 provider 的创建提议与失败分支"、"`gh` 缺失/未登录的 fail-closed"、
> "写前预览确认"已随 D16 撤销；当前门禁与实测结果见 §7.10 的证据表。下面保留原始要求供对照。

- `FolderWorkspace.taskDraft` 是 additive 可选字段，随 `folderWorkspace.create/update` 参数与
  `folderWorkspaces` 目录往返；不改 DDL、不改 schema 版本；需运行
  `pnpm run verify:rpc-params-catalog`，若参数 schema 变更则重新生成 catalog，并确认旧 build 忽略未知字段。
- 单测：计数排除（每种 Group by 模式各一条）、草稿行渲染（徽标 / linked to）、dock 提交 → 创建参数、
  prompt 生成、三 provider 的创建提议与失败分支、`gh` 缺失/未登录的 fail-closed。
- 文案全部进 locale catalog（`verify:localization-extraction` / `-coverage`）；只用 `components/ui/` 既有 primitive。
- `pnpm tc`、定向 `pnpm test`、`pnpm run check:code-quality:changed`。
- 真机渲染需 CDP 截图；只通过类型检查不算验收。

#### 7.9.12 明确不做（一期）

> **已变**：原"不自动执行 tracker 写：一律先预览、再确认"被 D16 推翻——现在**就是**让 agent 直接在
> 草稿会话里写，app 不设确认；下面其余条目仍然有效。

- 不新增侧栏行类型（先用 `taskDraft` 标记，`taskRecords` 落地后再议）。
- 不新增写 tracker 的 RPC（GitHub 走 `gh`、Jira 走表单；Linear 复用既有 `linear.issueCreate`）。
- 不做无盘"虚拟工作区"（agent 必须有 cwd）。
- 不做"一句话建多个任务"、不做跨 repo 批量、不做移动端 / 配对端。
- 不自动执行 tracker 写：一律先预览、再确认。

#### 7.9.13 未决

- 一个草稿行是否允许承载多条任务（当前取"一行一任务"）。
- 草稿名是否沿用 `getWorkspaceIntentName`，还是要有 `<owner/repo>-<slug>` 的可读前缀。
- Jira 的"草稿 → 表单"交接形态：打开既有 `IssueDialog`，还是 dock 内嵌同一份字段表单。
- 远端宿主 / 无 `gh` 环境下的产品文案与是否提供"改用 Linear"的引导。

#### 7.9.14 以后怎么演化（与 M2b / task 开发模式的关系）

**结论：可以演化，但演化的是"行与数据源"，不是"目录"。** 草稿行不会变成代码工作区——
代码工作区仍由 `Use` / `orca worktree create --sparse-task-dir` 另建，草稿只在那一步之前提供任务身份。

| 面 | T2（投影期） | M2b 之后（`taskRecords`） | UI 是否重做 |
| --- | --- | --- | --- |
| 行数据源 | `FolderWorkspace{ taskDraft: true }` | `TaskRecord`（§8.3） | 否 |
| 行内元素 | 名称 · `draft` 徽标 · agent 状态点 · `linked to #…` | 同（多一个任务状态） | 否 |
| 点击行为 | 打开该草稿的会话 | 打开任务详情（图 B：左 Agents / 右 Workspaces / 底 Delivery） | 是：从"一个会话"扩到"任务工作台" |
| 会话宿主 | userData scratch 目录（folder workspace） | 任务绑定的 scratch 目录；仍不是 git worktree | 否（换归属，不换形态） |
| 开发工作区 | 既有 `Use` 链路，草稿不参与 | 任务记录 `bindings` 记载 0..N 个工作区，`primaryWorktreeId` 显式 | 是：多一个 Workspaces 列表 |
| 计数 | 排除在工作区计数之外 | 作为任务进任务列表与分组，仍不算工作区 | 否 |
| 契约 | `taskDraft` additive 字段 | 任务记录 + 该字段下线（单独授权，不静默迁移） | 否 |

需要说清楚的两件事：

1. **草稿行不是开发工作区的前身**。它是任务的"产房"；开发工作区是任务的下游产物，两者不同的生命
   周期（草稿可归档，工作区有分支/交付证据），不共用目录、也不共用"脏状态"。
2. **演化受 M2a 门禁约束**。旧 build 的 round-trip 判决不过，T2 就停在投影形态；那是可接受的终点，
   不是失败——因为草稿的持久物（tracker 任务）本来就不在本地。

迁移规则（M2b 开工时写死，本期不实现）：读取时把 `taskDraft` folder workspace 投影成"未落库任务"，
提供显式"归入任务"动作；不做启动时自动改写，也不删原 folder workspace。

**T2 实现必须先满足的硬约束（R15）**：草稿行写入 `linkedTask` 的同时必须写入
`linkedTaskSourceContext`（provider / projectId / repoId / hostId）。只存 issue 号会在 M2b 投影时丢掉
`externalKey` 需要的维度，变成无法对账的孤儿任务。

### 7.10 实现形态（2026-11-17）：dock = agent 输入框

状态：**已实现，分支 `task-workbench-p2a`（`891989fd`），未合入 `main`、未部署**。本节记录实际落地
的形态与证据；与 §7.9 的差异按 D13–D17（§6.5）。

形态（两个状态，没有第三个）：

```text
折叠态  │ ⌃ …  Describe a task or change…                                    │
展开态  │ [Describe a task or change…        ]                                 │
        │ (github · acme/widgets)  [Model ▾]  ⌘↵ to send, Esc to close  Close Send │
```

- 位置不变（D7）：列表卡片外、frame 内边距里；卡片仍 `flex-1` 让出高度，分页条仍在卡片内。
- 没有预览卡、没有进度态、没有状态机（D13/D16）；唯一的"失败"是发送前的校验错误（无目标、无本地仓库），
  以一行 `task-dock-error` 显示。
- 模型选择（D15）：有候选时是 `<select>`（首项 `Agent default` = 空值），无候选时退化为自由文本；
  选中值以 `--model` 追加到 agent 启动参数，空值不追加。

流程（一次发送）：

```text
再发送前校验（目标 / 本地仓库）
  → getTaskDraftDirectory（main IPC，userData 下的 scratch）
  → createFolderWorkspace({ taskDraft: true, folderPath: <scratch>, … })
  → launchAgentInNewTab（folder workspace 作 launch target）+ prompt
  → 后续指令投同一会话（不新建行、不新建会话）
```

prompt 只注入三件事：指令本身、目标（`provider · owner/repo`）、以及约束——"你自己用 Orca 已有的
tracker skills 建单，完成后在会话里回报 issue URL；不得改仓库代码（cwd 是 scratch 目录）"。
app 侧**不**调 tracker RPC（D14）；`orca github create-issue`、`orca linear create`、
`task-draft-directory` IPC 与 archive sweep 保留，但只作为 agent 通道与草稿生命周期设施。

删除（本方向直接删除，不是隐藏）：`lib/task-draft-{issue-create,receipt,execute,create-flow}.ts`、
`hooks/use-task-draft-{polling,create-actions}.ts`、`components/task-page/task-draft-preview-card.tsx`
及其测试。

落点：`task-page/TaskDock.tsx`、`hooks/use-task-page-dock-actions.ts`、`lib/task-draft-prompt.ts`、
`lib/task-draft-agent-launch.ts`（模型参数与"追问投同一 tab"）。

保留（评价面不变）：草稿行徽标与菜单动作（`sidebar/WorktreeContextMenuDraftAction.tsx`）、
计数/Needs you/Recent 排除（`lib/task-draft-count-exclusion.ts`）、`folder-row` 的草稿标记、
`FolderWorkspace.taskDraft` 字段与 RPC 往返。

i18n：六份 locale 同路径清理（一次 ripgrep 取引用名集合后做差集，89 个无静态引用的旧 key），
en 新增 3 个新串；`en-runtime-required.json` 按新 en.json 重新生成。

证据（2026-11-17，`orca/` 内）：

| 门 | 结果 |
| --- | --- |
| 渲染 harness（`tests/tools/task-workbench-rendered`，`--all` + 侧栏行） | 18/18 + 1/1 passed；d1/d2 换成新 `TaskDockModel`，含模型 select → `onSubmit` 断言 |
| 定向 vitest（dock / prompt / 命名 / dock-actions / 计数排除 / 草稿菜单 / folder-row / WorktreeList 草稿行） | 10 文件 85 passed；第 11 个文件（`WorktreeList.folder-workspace-rows`）在套件级失败，原因是 sparse checkout 缺 `orca/resources`，见下 |
| task-page + task-workbench + `lib/task-draft*` + dock-actions | 51 文件 494 passed |
| main IPC `task-draft-directory`(+delete)、archive sweep、`cli github` | 31 passed |
| `tsc -p config/tsconfig.tc.web.json` | rc 0 |
| 六份 oxlint 配置（改动集） | 干净 |
| `check-max-lines-ratchet.mjs`、`verify-localization-extraction.mjs`、`verify-localization-catalogs.mjs` | rc 0 |

未完成 / 未验证：

- **D17 `linked to #…` 未实现**：需要薄 CLI 动词转发 `folderWorkspace.update`，由 agent 建单后回写；
  当前 agent 只被要求在会话里回报 URL，草稿行的链接片段与 `linkedTaskSourceContext` 写入都没有。
- 没有真机端到端证据：harness 只证明 dock 的 DOM、键盘路径与模型传递，不证明真的建出草稿工作区、
  起 agent、agent 真的用 skill 建了 issue（那需要一次真实会话）。
- zh/ja/ko/es/fr 的 3 个新串尚未翻译（回退英文，`verify-localization-catalog` 的 missing 计数不阻断）。
- dock 的自由文本模型分支（无候选时）没有渲染证据。
- 本机 `WorktreeList.folder-workspace-rows` 的 lineage 套件因 sparse checkout 缺 `orca/resources` 而失败，
  与本次改动无关。

---

## 8. 关系怎么存：持久化设计

上一版只说了"渲染层投影"，没有回答关系存哪。这一节补齐，并明确**哪些关系不该存**。

### 8.1 现在这些关系实际存在哪里（事实）

| 关系 | 载体 | 写入者 | 生命周期 / GC | 性质 |
| --- | --- | --- | --- | --- |
| 工作区 → 任务（来源） | `WorktreeMeta` 上的 `linkedIssue` / `linkedLinearIssue` / `linkedGitLabMR` / `linkedGitLabIssue` / `linkedWorkItem` / `linkedTaskSourceContext` | main（创建时与用户编辑） | 随 `worktreeMeta` 行；`gcStaleWorktreeMeta` 只在本地宿主、路径不存在且 30 天不活跃时删除 | 权威 |
| 工作区 → 固定基线 | `WorktreeMeta.sparseTaskBinding`（含自摘要，严格读取） | 创建回执（M5） | 同上 | 权威 |
| 工作区 → 宿主/实例身份 | `worktreeMeta` + `worktreeMetaByIdentity` + `worktreeIdentityAliases`；路径改名留 `priorWorktreeIds` | main | 同上；别名随身份行清理 | 权威 |
| Agent 状态 | 内存 `agentStatusByPaneKey` + 侧车 `last-status.json`（hook server 的 endpoint 目录，带 version，条目 malformed 即丢弃） | hook server | 进程内 + 重启水合；不保留历史 | 权威（单一 store） |
| 会话 → 工作区 | **不存**：AI Vault 读时按 `cwd` 解析（`current/active/archived/unavailable`）；用量扫描按 `cwd` 归因 | — | 派生 | 派生 |
| 会话 → 用量 | 每 provider 一个 JSON：`orca-claude-usage.json` / `orca-codex-usage.json` / `orca-opencode-usage.json` / `orca-muse-usage.json`（userData 下），内部 `schemaVersion`（Claude=6）、`worktreeFingerprint`、`processedFiles`、`sessions`、`dailyAggregates` | 主进程扫描 worker | 指纹变化即重扫；旧 schema 直接丢弃重建 | 权威（估算） |
| 用量 → 一次运行 | `AutomationRun.usage`（`known/unavailable` + `unavailableReason` + `collectedAt`） | 主进程（`collectAutomationRunUsage`） | 随 run 保留/裁剪 | 权威快照 |
| 任务页 UI 状态 | `PersistedUIState`（`taskPageResume` 一类） | renderer → main | 随 `ui` domain | 权威（偏好） |

统一后端：**SQLite profile-state 是唯一普通可写后端**（`orca/src/main/persistence/profile-state/legacy-json/README.md`）。
`profile_state_documents` 每个 **top-level domain 一行**（`domain / payload(JSON) / domain_version / revision / content_hash`），
`revision` 是全 profile 的 CAS；`automationRuns` 之所以需要 schema v3，是因为它被拆成独立表做行级更新。
`orca-data.json` 只剩兼容导出与回退入口，不是活存储。

> 由此得到一条硬约束：**新的任务实体应该是一个新的 JSON domain，不需要 DDL，也不需要 bump
> `PROFILE_STATE_DATABASE_SCHEMA_VERSION`**（只有"拆表"才需要）。

### 8.2 三个候选位置，以及为什么不选前两个

| 位置 | 表达力 | 问题 |
| --- | --- | --- |
| A. 纯派生（零存储） | 只能表达"从工作区反推出的任务" | 手动分组/重命名/归档/验收条件/Primary 判定全无处安放；工作区被删后任务历史与已花成本一起消失；跨入口续做只能靠 worktree |
| B. 加到 `WorktreeMeta` | 每工作区一个指针（`taskId`） | `WorktreeMeta` 的语义是 "persisted user-authored fields only"；按 worktree 键存储，装不下任务级字段（目标/验收/预算/状态）；`gcStaleWorktreeMeta` 会删 30 天不活跃行，任务历史跟着没了；一任务多工作区也无处表达 |
| C. **新 domain `taskRecords`** | 任务实体 + 绑定集合 + 用户意图 + 结算快照 | 需要定义迁移、对账、GC 与写入路径（本文给出） |

**结论：走 C，并且把"任务 → 工作区"这条关系只在 C 里单向存一份**；工作区侧的
`linkedWorkItem / linkedTaskSourceContext` 保持现状（它是创建期 provenance，不是任务的镜像），
两边**不做双写同步**，读取时以任务记录为准、以工作区字段做对账证据。

### 8.3 数据形态（草案，落在 profile-state 的单行 domain）

```text
domain: "taskRecords"            // top-level key，一行 JSON，domain_version = 1
{
  "recordsVersion": 1,
  "byId": { "<taskId>": TaskRecord },
  "externalIndex": { "<externalKey>": "<taskId>" }   // 唯一性约束，防重复建任务
}

TaskRecord {
  taskId: "t_<uuid>"
  hostId: ExecutionHostId           // 绑定维度，不是身份前缀
  origin:
    | { kind: "external", provider: "github|gitlab|linear|jira",
        providerIdentity, number, url, titleSnapshot, titleSnapshotAt }
    | { kind: "workspace", primaryWorktreeId }
  bindings: TaskWorkspaceBinding[]  // 0..N
  primaryWorktreeId?: string        // D3：显式 primary；缺省用"最近活动"兜底
  intent: {                         // 只存用户意图，不存运行态
    archived?: boolean
    blocked?: { reason?: string; at: number }
    acceptance?: string
    budget?: { tokens?: number; costUsd?: number }
  }
  usageSettlement?: {               // 归档/工作区移除前结算一次
    collectedAt: number
    scope: "worktree-rollup"
    knownProviders: ("claude"|"codex"|"opencode"|"muse")[]
    totalTokens: number
    estimatedCostUsd: number | null
    unavailableReason?: "usage_not_enabled"|"remote_usage_unavailable"|"scan_failed"|"no_matching_session"
  }
  createdAt: number
  updatedAt: number
  schemaVersion: 1                  // 记录级版本，便于逐条迁移
}

TaskWorkspaceBinding {
  worktreeId: string                // 路径派生的 locator id（与 worktreesByRepo 同源）
  repoId: string
  hostId: ExecutionHostId
  boundAt: number
  boundBy: "created" | "user" | "reconciled"
  lastVerifiedAt: number | null     // 对账结果；null = 尚未核验
  resolvedVia?: "locator" | "identity" | "alias"   // worktree 改名后的解析路径
}
```

`externalKey = "<provider>|<hostId>|<repoId 或 projectId>|<number 或 identifier>"`。
它只用于唯一性，不作为任务身份；同名仓库/相似路径不构成同一任务（与
`../task-workspaces.md` 的"跨宿主副本分别核验"一致）。

### 8.4 什么不存（这是避免双写的关键）

| 不存 | 理由 | 读时怎么来 |
| --- | --- | --- |
| 运行态（needs you / working / done / idle） | Agent 状态只有 hook server 一个 store（`orca/AGENTS.md` 的 Agent Status 规则）；再存一份必然漂移 | 每次从 `agentStatusByPaneKey` / `retainedAgentsByPaneKey` 派生 |
| Agent / 子 Agent 列表 | 同上，且保留态本身有 TTL | `buildWorktreeAgentRows` + dashboard snapshot |
| 会话明细、消息内容 | 体积与隐私，且归 AI Vault 所有 | 按 `cwd → worktree` 直读 |
| 实时 token / 花费 | 用量 store 会因 `worktreeFingerprint` 变化重扫，存下来的数会立刻腐烂 | 从 `*UsageProjectBreakdown` 按 `worktree:<id>` 现算 |
| 任务列表顺序 / 分组结果 | 纯展示 | 投影现算 + `PersistedUIState` 存折叠与排序偏好 |

**唯一例外是 `usageSettlement`**：工作区删除、任务归档或用量缓存被重建后，现算就再也拿不到那份数据，
所以要在"失去读取能力之前"结算一次，并带 `collectedAt` / 归因口径 / unavailable 原因——
这和 `AutomationRun.usage` 的做法一致（未知不记 0）。

### 8.5 写入路径与并发

- 权威写入者是 **main 进程的 Store**；renderer 只发意图（`taskRecords` 的新增/绑定/归档），
  禁止在渲染进程拼好整个 domain 再覆盖写。
- 走现有 `writeProfileStateDomain({ domain, payload, expectedRevision })`：`BEGIN IMMEDIATE` +
  精确 revision 比对，双实例/双窗口下的互相覆盖会被拒绝（`ProfileStateRevisionConflictError`），
  调用方需重读重试。
- 分域写：任务记录变更只重写 `taskRecords` 一行，不触碰 `worktreeMeta` / `settings` 等大 domain；
  但注意 selective 写遇到未知 domain 会退回全量写（见 8.6）。

### 8.6 迁移、降级与回滚

| 事项 | 做法 | 依据 |
| --- | --- | --- |
| 新增 domain | 加 `PersistedState.taskRecords`，写入即产生一行；**不改** `PROFILE_STATE_DATABASE_SCHEMA_VERSION`（=3） | `profile_state_documents` 是通用 key-value |
| 记录内演进 | 每条记录带 `schemaVersion`，在 load 归一化里逐条升级（同 `folderWorkspaces` 的写法），不做一次性全量重写 | `normalizeLoadedProfileState` |
| 降级到旧 build | 旧 build 不认识 `taskRecords`：`normalizeLoadedProfileState` 用 `{...parsed}` 保留未知 top-level key，`buildStateToSave` 从 `getDurableState()` 再写出 → 数据保留；代价是它的分域写会退化为全量写 | 读代码推断，**需用例验证**（§12） |
| 导出/备份/回滚 | 复用 `orca profile state` 的 export / recovery；需确认导出快照包含未知 domain | 待验证 |
| 契约面 | 任务记录**不进 RPC**（一期只在桌面端出现），因此不触发 catalog / wire 兼容门禁；若 M4 开放给配对客户端，再按 `docs/reference/remote-wire-compatibility.md` 走 additive 字段 |  |

### 8.7 生命周期规则（必须明确，否则记录只增不减）

| 事件 | 处理 |
| --- | --- |
| 工作区被 Orca 删除 | 该 binding 标 `lastVerifiedAt = null` / 结算用量；**不删任务记录**，列表显示 unresolved |
| 工作区被外部删除（`existsSync` 失败） | 只读对账标记，不自动删、不自动清理（沿用本节 §8.7 的启动对账口径） |
| 工作区目录改名 | 用 `worktreeIdentityAliases` / `priorWorktreeIds` 解析，命中则改写 `worktreeId` 并记 `resolvedVia` |
| 仓库被移除 | `gcStaleWorktreeMeta` 会清掉 meta 行；任务记录保留，binding 变 unresolved；提供显式"清理无归属任务" |
| 任务归档 | `intent.archived = true` + 结算快照；不再参与 Needs you 计数 |
| 任务删除 | 显式用户动作；先结算再删；**不级联删工作区**（工作区生命周期独立） |
| 启动对账 | 启动后跑一次（不做后台 watcher）：解析所有 binding、标记 unresolved、必要时回填 `resolvedVia` |

### 8.8 体量与写入频率预算

- 单条记录约 0.5–1.5 KB（含 3 个绑定）；1000 个任务 ≈ 0.5–1.5 MB，作为单行 JSON domain 可接受。
- **不要**把会话明细、事件流、每轮 token 写进这个 domain——那是 AI Vault / usage / agent status 的职责；
  写进去会让每次 hook 都触发整 domain 重写。
- 运行态不写 ⇒ 任务记录只在"绑定/状态/结算"变化时写，频率与用户操作同阶。
- 副作用提醒：`getUsageWorktreeFingerprint` 的输入含 `displayName`，改工作区名会作废用量缓存并触发重扫；
  任务视图不要在工作区名上做高频编辑（重命名走显式动作）。

### 8.9 存储专项测试清单

1. 未知 domain round-trip：新 build 写 → 旧 build 读+写 → 新 build 读（证明降级不丢数据）。
2. revision CAS：两个 Store 实例并发写 `taskRecords`，后者必须收到冲突并重试。
3. 记录级迁移：`schemaVersion: 1` fixture → 升级后字段补齐、未知字段不丢。
4. 对账：外部删除 / 目录改名（`priorWorktreeIds`）/ 归档 / 仓库移除。
5. GC 解耦：30 天不活跃的 `worktreeMeta` 行被 GC 后，任务记录仍可读且标 unresolved。
6. 结算快照三态：known / unavailable（未启用、远端）/ 部分 provider 未定价。
7. domain 体量：1000 任务 × 3 绑定的序列化与读入耗时基线。

---

## 9. 分期与验收

### 9.0 路标（UI 优先，2026-11-16）

四段，每段结束时都有一屏可演示的东西；每段都可单独回滚。这个顺序把"UI 证据"放最前：两位评审都指出
"没有真机渲染"是最大返工源，而它也是成本最低的验证点。

| 路标 | 一句话 | 看得到什么 | 对应阶段 | 不做 |
| --- | --- | --- | --- | --- |
| **P1 工作台 UI** | 先把"点开任务后的那一屏"做出来 | 详情页多一个 `Orca` tab：工作区、agent 行（带所属工作区）、token、用量三态、证据摘要 | M1；明细见 [P1a 计划](p1a-ui-shell-plan.md)（1.5–2 天，harness 截图） | 列表主轴、持久化、dock |
| **P2 输入入口** | 让任务"说得出来" | 列表页底部 dock（选模型 + 输指令）+ 侧栏草稿行 + 草稿会话里的 agent 自己建单 | T2 | 任务行、分组、app 侧建单链 |
| **P3 列表主轴** | 让任务"排得开" | `Needs you / Working / Delivered(agent done)` 分组、`◇` 徽标、一任务多工作区 | M2b 的 renderer 部分 | 持久化 |
| **P4 持久化** | 让任务"记得住" | primary、归档、结算快照、意图层（目标/验收/授权） | M2a + M2b 的 main 部分 | 跨端 |

- P1 允许停在 **1a**：组件 + fixture 数据 + 全部状态与降级，产出 CDP 截图供评审（不接真实数据、不建 tab 入口）；
  **1b** 才接真实 selector。两位评审的"图 B 不能冻结"正好用 1a 的截图回答。
- 旁路：T1（Agent 派生树）可随时独立合入；M3（交付证据聚合）留在 P3 之后；M4（跨端）单独授权。
- P3 的 `Delivered` 已定为 **agent done**（D12，见 §7.2）；没有它 P3 无法开工。

下面的 M/T 表是**详细阶段与验收**（工作包粒度），路标只回答"先做哪个"；两者冲突时以路标定顺序、
以详细阶段定退出条件。

| 阶段 | 范围 | 明确不做 | 验收 |
| --- | --- | --- | --- |
| **M0 决策冻结** | 定 §6 的 D1–D6 与 `taskRecords` 字段表；不写代码 | — | 每条决策有结论或明确 `escalate-value-choice` |
| **M1 增量面板**（推荐先做） | 现有任务详情加 `Orca` tab，定位为**任务聚合视图**（§6.4，不承诺任务对象）；GitHub issue/PR → Linear → Jira/GitLab；Agent 行（逐 Agent 只 token + 所属工作区）、用量三态、指向工作区的动作、0/1/N 工作区主操作规则。**零持久化**；selector 必须可被 M2 复用 | 列表主轴、移动端、远端用量、逐 Agent 金额、任务意图层（目标/验收/授权） | 对照覆盖 **Claude + Codex + OpenCode + Muse**：面板合计 == `projectBreakdown['worktree:<id>']`；歧义显示 `ambiguous`；未启用显示空态而非 0；`key` 解析有单测；文案不出现"已完成/验收通过" |
| **T2 列表页 dock + 任务草稿行**（P2，排在 P1 之后；仍独立于 `taskRecords`） | Tasks 列表页底部 dock：一条指令 + 一个模型 → 建 `taskDraft` folder workspace 并在其中起 agent，建单由 agent 用既有 skills / CLI 动词自己完成（D14）。**零新 RPC、零新 domain、app 侧不写 tracker** | `taskRecords` 落库、一句话多任务、无盘草稿、移动端、预览卡/状态机（D16 已撤销） | dock 能选模型并发送；草稿行不计入工作区计数；agent 能被指示去建单并回报 URL；`linked to #…` 回写**未实现**（D17 待办）；i18n 与 `check:code-quality:changed` 通过 |
| **M2a 存储兼容验证** | 只读验证：指定旧 build 的新→旧→新 round-trip、`orca profile state` export/recovery 对未知 domain、备份恢复；产出判决 | 任何落盘 | 三项全绿才允许 M2b；否则范围收缩为 M1 |
| **M2b 列表主轴 + 落库** | 分组（按 §7.2 优先级，`◇` 为徽标）+ 一任务多工作区列表反查 + 新增 `taskRecords` domain（§8：记录、绑定、`externalIndex`、primary、对账、结算快照） | 跨 runtime 逻辑任务、多仓联合验收（设计文档 C 的剩余部分）、移动端 | 投影一致性；§8.9 存储专项 1–7 + 评审补充缺项全绿；1000 工作区规模下列表构建无逐行扫描 |
| **M3 交付证据聚合** | 任务级交付区：commits、PR/MR、checks、review 状态、`sparseTaskBinding` 证据 | — | 一个有 PR 与一个无 PR 的任务各有一份截图/断言；不可用状态不显示为 0 |
| **M4 跨端（可选，未估）** | 新只读 RPC（task usage/摘要）+ allowlist + 录制 golden + 移动端详情接入 | SSH 实时用量 | wire 兼容：旧客户端忽略新字段；`pnpm run verify:rpc-params-catalog` 通过；需单独授权 |

每阶段都必须：新文案进 locale catalog（`verify:localization-extraction` / `-coverage`）、
不新增 `components/ui/` 之外的样式、不触发 `max-lines` ratchet。

工作包、文件所有权、测试矩阵、回滚与阶段状态见[开发计划](development-plan.md)；本节只保留阶段划分。

**验证前提（依赖树）**：新 worktree 不含 `node_modules`，但不需要重新安装——按
[worktree-delivery 技能](../../../skills/worktree-delivery/SKILL.md) 的"Reusing a prepared dependency tree"
复用同机同一 lockfile 的已准备依赖树（软链 + `--check-only` 只读核验 + 串行测试）。
因此"要跑 tsc/vitest"**不再是**拒绝任务 sparse 模式的理由；拒绝的理由只剩"必须在创建期跑
setup 钩子"或"需要新装/重建依赖"。

---

## 10. 契约与门禁影响

| 面 | 影响 |
| --- | --- |
| RPC | M1 不涉及；**M4**（跨端）需要新 op ⇒ 重新生成 `rpc-params-catalog.generated.ts`、更新 mobile allowlist、补 wire 兼容说明（`docs/reference/remote-wire-compatibility.md`） |
| 移动端 parity | `mobile/rpc-foundation/` 的录制 golden 与 pilot scenarios 会因新 op/新字段变化 |
| 契约类型 | 若为 session 行加 `worktreeId`：`shared/*-usage-types.ts` additive 字段即可，但需要同步 main 的 report aggregation 与 renderer normalization |
| i18n | 所有新 UI 文案（含 tooltip、空态、可访问名） |
| 样式 | `pnpm run check:code-quality:changed`（禁止重写 `components/ui/`、禁止 raw 色值、禁止 computed className） |
| 性能 | 列表构建必须走 dashboard 已有的 cached pass；禁止在渲染期逐行调用 usage 扫描 |
| 持久化（M2） | 新增 `taskRecords` domain：不改 `PROFILE_STATE_DATABASE_SCHEMA_VERSION`、不改 DDL；写入必经 main Store + revision CAS；老 build 保留未知 domain（待用例验证）；不进 RPC 不触发 catalog 门禁 |
| 契约类型（T2） | `FolderWorkspace.taskDraft?: boolean`（additive optional）：随 `folderWorkspace.create/update` 参数与 `folderWorkspaces` 目录往返；不改 DDL/版本；需跑 `verify:rpc-params-catalog` 并确认旧 build 忽略未知字段 |
| 外部依赖（T2） | GitHub 主通道不依赖本机 `gh`（走 app 账号 RPC）；备通道 `gh` 依赖存在性 + 登录态，远端宿主可能没有；两条都不通时显式不可用，不做静默降级 |
| CLI 契约（T2） | 新增 `orca github create-issue` 动词（转发现有 `github.createIssue` RPC）：需补 `agent-context` schema、`--help` 文案与 CLI 帮助一致性测试；**不改 RPC catalog** |

---

## 11. 风险与不做

| 风险 | 处理 |
| --- | --- |
| 与 Agent Dashboard / Agents feed 职责重叠 | §5 分工写进 UI 文案与文档，入口互链而非功能复制 |
| 用量默认关闭导致"这个功能是空的" | 空态 + 明确 CTA；不改默认值 |
| 一任务多工作区的主次不清 | D3 显式 primary；投影期用"最近活动"兜底并标注 |
| 同名 worktree 导致会话归因串味 | 会话级归因只用 `worktreeId`（需 additive 字段），不靠 displayName 匹配 |
| 远端/SSH 显示假数据 | 统一 `unavailable` 语汇，绝不写 0 |
| 列表规模 | 复用 `agentStatusByPaneKey` 索引与 cached pass；provider 数据按既有分页 |
| 任务记录只增不减 | §8.7 的 lifecycle 规则 + 启动对账 + 显式"清理无归属任务"；不做后台 watcher |
| 降级丢数据（未验证） | 先跑 §8.9 第 1 条 round-trip 用例，再决定 M2 是否引入 domain |
| 用量重扫干扰 | 不在工作区名上做高频编辑（`worktreeFingerprint` 含 `displayName`） |

不做：跨 runtime 逻辑任务续接、多仓联合验收、写入硬隔离、把用量默认打开、SSH 实时用量。
（`taskRecords` domain 属于 M2 范围，见 §8；不是"不做"项。）

---

## 12. 未验证 / 证据缺口

- 未构建、未启动 Orca；本文所有 UI 判断来自代码阅读，**没有渲染验证**（无 CDP 截图）。
- 未实测 usage 扫描在真实多工作区下的归因准确率；`ambiguous` 出现频率未知。
- 未验证 AI Vault 历史会话在**归档**工作区下的可用性与成本（`archived` 分支仅读代码）。
- 移动端成本仅按文件数估计（206 文件），未做实现级评估。
- `projectBreakdown` 的 `worktree:<id>` key 形态是当前实现细节，属未文档化契约；若上游改动，M1 的读取需同步调整（稳妥做法：在 renderer 侧加一层解析与回退，并对 `key` 前缀做单测）。
- 未核对 `v1.4.219` 之后上游是否已有同类改动（本仓库为快照）。
- 2026-11-09 的只读评审（[记录](discussion-record.md)）把 H1–H6 全部标为未验证，并补了存储、用量、UX 三组缺项；
  这些缺项进入[开发计划](development-plan.md) §5，本文不重复。
- 评审只覆盖文档与代码阅读，没有真机渲染、没有真实用量样本、没有旧 build 实测。
- §8 的降级结论（旧 build 保留未知 domain 并写回）来自代码阅读（`normalizeLoadedProfileState` 的 `{...parsed}`、
  `buildStateToSave` 的 `getDurableState()`），**没有跑过 round-trip 用例**；§8.9 第 1、2 条尚未执行。
- 未确认 `orca profile state` 的 export/recovery 是否包含未知 domain。
- §7.9 的 dock 与草稿行：**2026-11-17 已有渲染证据**（harness 18/18 + 侧栏行 1/1，见 §7.10），但仍是 fixture
  级证据——没有真机端到端（真建草稿工作区、真起 agent、agent 真建出一条 issue）；草稿行在每种
  Group by 模式下的 lane 与激活行为也仍未实测。
- §7.10 的模型自由文本分支、`linked to #…` 回写（D17，未实现）与五份 locale 的新串翻译都是缺口。
- `gh` 的存在性、登录态、远端宿主可用性，以及 `gh issue create` 在 scratch cwd 下配合 `--repo` 的实际行为未验证。

---

## 13. 下一步（需显式授权）

1. 定 §6 的 D1/D3/D5/D6（D4 已由 R1 定）→ 决定走 M1 还是 M2 起步；D7–D12 已于 2026-11-16 定。
2. M1 只读验证：在一个真实工作区跑两段不同 Agent，核对 `projectBreakdown['worktree:<id>']` 与
   AI Vault `totalTokens` 的一致性（只读，不改代码）。
3. 若要走 M2：先在测试 fixture 里验证 §8.9 第 1–3 条（未知 domain round-trip / revision CAS / 记录级迁移），
   再拆实施清单（具体文件、domain 名、字段、测试与门禁）。
4. 路标已改为 UI 优先（§9.0）：P1（工作台 UI）→ P2（T2 dock）→ P3（列表主轴）→ P4（持久化）。
   P1a 可以先只交静态壳 + 截图，不需要真实数据或存储。
5. T2 第二刀已按 §6.5 取消（预览卡 / 状态机 / app 侧创建链不再做）；剩下的 T2 缺口是 **D17 `linked to #…`
   的薄 CLI 动词**，需单独授权。
