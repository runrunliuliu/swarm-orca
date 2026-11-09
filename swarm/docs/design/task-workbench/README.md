# 以任务为中心的 Tasks tab 改造：调研与 UI 设计（草案 v1）

状态：**调研 + 设计草案**，未实现，未评审通过。
调研基线：本仓库的 `orca/` 层（upstream `v1.4.219` 快照，见 `orca/upstream.json`、`orca/UPSTREAM.md`）。
文中 `orca/...` 路径均相对本仓库根目录。
核对日：2026-11-09。

本文只记录"代码里有什么 / 能怎么改"。不修改任何 schema、启动器、已装技能或既有会话；不构成实施、合并、
部署、重启或创建 worktree / Agent 的授权。文中行号与文件路径均为只读观察值，改动前需重新核对 HEAD。

本文遵守本仓库的 [public-repository boundary](../../../../AGENTS.md) 与本层约定：不含组织配置、主机名、
真实 Run / Task / terminal ID、部署路径或凭据。

关联：[任务与工作区模型](../task-workspaces.md)（一个任务如何绑定 worktree、如何续做）、
[开发计划](development-plan.md)（阶段、工作包、退出条件与测试矩阵）、
[评审记录](discussion-record.md)（2026-11-09 只读 panel 的结论、缺项与失效条件）。

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
| D4 | 无 tracker 的本地任务进不进列表 | 进，独立分组 `UNLINKED` | 最常见的用法被排除 |
| D5 | 移动端一期做不做 | 不做，明确"桌面独有"并登记 parity 豁免 | 跨端契约门禁会持续报差异 |
| D6 | 关系存哪（§8） | 派生不存；provenance 留既有字段；任务实体进 `taskRecords` domain | 变成"只有投影"，手动组织与历史成本全丢 |

### 6.1 评审后修正（2026-11-09）

| # | 修正 | 来源 |
| --- | --- | --- |
| R1 | `Unlinked` 从分组降为**徽标/筛选器**（`◇`）；分组只保留运行/交付状态，并定义互斥优先级 | A |
| R2 | 逐 Agent 只显示 **token**，金额只出现在工作区级与任务级；会话级归因未成立前不显示金额 | A、C |
| R3 | 图 B 默认折叠历史 Agent、次要工作区与 Delivery/Evidence | A |
| R4 | M1 的 selector 必须可被 M2 直接复用，否则暂停并重新拆包 | A、B |
| R5 | M2 拆为 `M2a 存储兼容验证` + `M2b 落库实现`；M2a 不过就只交付 M1 | B |
| R6 | M1 的对照数据要覆盖 OpenCode 与 Muse，不只 Claude/Codex | C |
| R7 | `projectBreakdown.key` 必须经解析层 + 单测，不直接散落 `split(':')` | C |

`Delivered` 的产品定义（Agent done / PR merged / checks passed / 验收完成）与分组优先级仍待产品 owner 确认（§7.2）。

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
│   ├── Delivered        ← 有 merged/done 证据
│   └── Unlinked         ← 无 tracker 的本地工作区（D4）
└── 详情（点开列表行）
    ├── 头部：标题 · provider · 状态 · 主工作区/分支 · 基线 SHA · PR 缩略
    ├── 左：Agents（活 / 保留 / 历史，可折叠子 Agent）
    ├── 右：Workspaces（0..N） · Spend（用量）
    └── 底：Delivery（commits/PR/checks/review） · Evidence（binding / 会话链接）
```

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
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

行内信息优先级（窄宽度降级顺序）：状态 → 标题 → provider → workspaces → agents → 时间 → 花费。
花费列在 D2 未解决前允许整体隐藏（设置项），不做 `$0` 占位。

分组规则（评审后补充，待产品确认最后一项）：

- 单一归属，优先级 `Needs you` > `Working` > `Delivered`；一条任务只出现在一个分组里。
- `◇` 是**属性徽标**（无 tracker 的工作区），与分组正交：一个无 tracker 但正在跑的任务出现在 `Working` 里并带 `◇`；
  顶部 `◇ No tracker 5` 是筛选入口，不是第 4 个分组。
- `Delivered` 当前按"有合并/完成证据"派生（PR merged、或 Agent done + 无未完成 checks）；
  是否等价于"验收完成"**未定义**，需产品确认，未确认前 UI 文案不得写"已完成"。
- primary workspace 缺失时按"最近活动"兜底，并在 UI 显式标注为派生（不是用户选择）。

### 7.3 图 B：任务详情（工作台）

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

花费口径提示（tooltip 文案要点）：估算值、按 provider 计价、未启用统计/远端工作区/歧义会话不计入 0。

### 7.4 图 C：增量方案（现有详情加一个 Orca 面板）

不改列表主轴，只在既有详情里加一个 tab（`ItemDialogTab` 增加 `'orca'`，PR 与 issue 共用）：

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
| 本地任务（无 tracker） | 仅在 worktree 侧存在 | 分组 `UNLINKED`，标题取 `displayName` |
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

### 7.8 Agent 派生树（可先做，独立于 M1/M2）

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

**待你确认一件事**：你说的"项目区的 TUI"指哪一层——侧栏/工作台里的 Agent 行列表，还是顶部 tab bar
（或者两者都要）？我按"行列表为主、tab bar 只加父子小徽标"写的；如果实际是 tab bar 为主，本节的
展示与折叠段落需要改写。

### 7.7 交互

- `⌘F` 聚焦搜索（与既有 Tasks / Agents feed 一致）；`↑/↓` 在列表内移动；`↵` 打开详情；`esc` 回列表。
- 行 hover 出 `[ Open workspace ]`，不改变点击语义（点击=详情）。
- Agent 行点击 = 打开该 Agent 的终端/会话；`[ resume ]` 仅在存在可恢复 provider session 时出现。
- 分组折叠状态持久化（沿用 `taskPageResume` 一类既有 UI 状态通道，不新建存储）。

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
| 契约面 | 任务记录**不进 RPC**（一期只在桌面端出现），因此不触发 catalog / wire 兼容门禁；若 M3 开放给配对客户端，再按 `docs/reference/remote-wire-compatibility.md` 走 additive 字段 |  |

### 8.7 生命周期规则（必须明确，否则记录只增不减）

| 事件 | 处理 |
| --- | --- |
| 工作区被 Orca 删除 | 该 binding 标 `lastVerifiedAt = null` / 结算用量；**不删任务记录**，列表显示 unresolved |
| 工作区被外部删除（`existsSync` 失败） | 只读对账标记，不自动删、不自动清理（沿用 M4 的对账思路） |
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

| 阶段 | 范围 | 明确不做 | 验收 |
| --- | --- | --- | --- |
| **M0 决策冻结** | 定 §6 的 D1–D6 与 `taskRecords` 字段表；不写代码 | — | 每条决策有结论或明确 `escalate-value-choice` |
| **M1 增量面板**（推荐先做） | 现有任务详情加 `Orca` tab；GitHub issue/PR → Linear → Jira/GitLab；Agent 行（逐 Agent 只 token）、用量三态、指向工作区的动作。**零持久化**；selector 必须可被 M2 复用 | 列表主轴、移动端、远端用量、逐 Agent 金额 | 对照覆盖 **Claude + Codex + OpenCode + Muse**：面板合计 == `projectBreakdown['worktree:<id>']`；歧义显示 `ambiguous`；未启用显示空态而非 0；`key` 解析有单测 |
| **M2a 存储兼容验证** | 只读验证：指定旧 build 的新→旧→新 round-trip、`orca profile state` export/recovery 对未知 domain、备份恢复；产出判决 | 任何落盘 | 三项全绿才允许 M2b；否则范围收缩为 M1 |
| **M2b 列表主轴 + 落库** | 分组（按 §7.2 优先级，`◇` 为徽标）+ 一任务多工作区列表反查 + 新增 `taskRecords` domain（§8：记录、绑定、`externalIndex`、primary、对账、结算快照） | 跨 runtime 逻辑任务、多仓联合验收（设计文档 C 的剩余部分）、移动端 | 投影一致性；§8.9 存储专项 1–7 + 评审补充缺项全绿；1000 工作区规模下列表构建无逐行扫描 |
| **M3 跨端（可选）** | 新 RPC（task usage 只读）+ allowlist + 录制 golden + 移动端详情接入 | SSH 实时用量 | wire 兼容：旧客户端忽略新字段；`pnpm run verify:rpc-params-catalog` 通过 |

每阶段都必须：新文案进 locale catalog（`verify:localization-extraction` / `-coverage`）、
不新增 `components/ui/` 之外的样式、不触发 `max-lines` ratchet。

工作包、文件所有权、测试矩阵、回滚与阶段状态见[开发计划](development-plan.md)；本节只保留阶段划分。

---

## 10. 契约与门禁影响

| 面 | 影响 |
| --- | --- |
| RPC | M1 不涉及；M3 需要新 op ⇒ 重新生成 `rpc-params-catalog.generated.ts`、更新 mobile allowlist、补 wire 兼容说明（`docs/reference/remote-wire-compatibility.md`） |
| 移动端 parity | `mobile/rpc-foundation/` 的录制 golden 与 pilot scenarios 会因新 op/新字段变化 |
| 契约类型 | 若为 session 行加 `worktreeId`：`shared/*-usage-types.ts` additive 字段即可，但需要同步 main 的 report aggregation 与 renderer normalization |
| i18n | 所有新 UI 文案（含 tooltip、空态、可访问名） |
| 样式 | `pnpm run check:code-quality:changed`（禁止重写 `components/ui/`、禁止 raw 色值、禁止 computed className） |
| 性能 | 列表构建必须走 dashboard 已有的 cached pass；禁止在渲染期逐行调用 usage 扫描 |
| 持久化（M2） | 新增 `taskRecords` domain：不改 `PROFILE_STATE_DATABASE_SCHEMA_VERSION`、不改 DDL；写入必经 main Store + revision CAS；老 build 保留未知 domain（待用例验证）；不进 RPC 不触发 catalog 门禁 |

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

---

## 13. 下一步（需显式授权）

1. 定 §6 的 D1/D4/D5/D6 → 决定走 M1 还是 M2 起步。
2. M1 只读验证：在一个真实工作区跑两段不同 Agent，核对 `projectBreakdown['worktree:<id>']` 与
   AI Vault `totalTokens` 的一致性（只读，不改代码）。
3. 若要走 M2：先在测试 fixture 里验证 §8.9 第 1–3 条（未知 domain round-trip / revision CAS / 记录级迁移），
   再拆实施清单（具体文件、domain 名、字段、测试与门禁）。
