# 以任务为中心的 Tasks tab 改造：调研与 UI 设计

状态：**P1（M1，任务详情 `Orca` tab）已实现并合入 main**，实现范围是 GitHub issue/PR；
**P3（列表主轴）未开始**；**P4 的 `taskRecords` 数据面已落地**（issue #36，见 §8.10），
动作层与 M2a 存储兼容验证未做。
调研基线：本仓库的 `orca/` 层（upstream `v1.4.219` 快照，见 `orca/upstream.json`、`orca/UPSTREAM.md`）。
文中 `orca/...` 路径均相对本仓库根目录。
核对日：2026-11-18（重核：P1a/P1b/真实 `Orca` tab 已在 main；新增项目块"Open agent in `<project>`" 入口，
见 §7.9）。

本文只记录"代码里有什么 / 能怎么改"。不修改任何 schema、启动器、已装技能或既有会话；不构成实施、合并、
部署、重启或创建 worktree / Agent 的授权。文中行号与文件路径均为只读观察值，改动前需重新核对 HEAD。

本文遵守本仓库的 [public-repository boundary](../../../AGENTS.md) 与本层约定：不含组织配置、主机名、
真实 Run / Task / terminal ID、部署路径或凭据。

关联：[任务与工作区模型](../task-workspaces.md)（一个任务如何绑定 worktree、如何续做）、
[开发计划](development-plan.md)（阶段、工作包、退出条件与测试矩阵）、
[评审记录](discussion-record.md)（2026-11-09 只读 panel 的结论、缺项与失效条件）、
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

实现口径（issue #38 起，`orca/src/renderer/src/lib/task-workbench/task-workbench-identity.ts`）：
条目身份是 `TaskWorkbenchItem {type: 'issue' | 'pr', number}`，追加在 repo 级 key 之后，即
`tracker:github:acme/web-app:issue:412`；repo 段仍由 `taskProviderIdentityCachePart` 单一实现产出。
条目级 key 只用于**命名**：某任务的 workspace 集合由 `worktreeLinksTaskItem` 逐个 worktree 判定
（`linkedIssue` / `linkedPR` / `linkedWorkItem`，叠加 provider/host 校验：GitHub 用与 key 同口径的
canonical repo key，其他 provider 保持逐字段比较，不拿有损 cache key 合并），
零匹配就是零。`resolveTaskIdentity` 不再返回 matched ids——把 repo 级 key 当成集合来源正是该 bug。
没有任何现存工作区但本条目在 run ledger 里有 deleted 记录时，用该记录（而非 repo 里别人的分支）
命名这个已关闭的任务，历史条照旧（issue #31 S2）；未被条目命名时 ledger 不参与。ledger 的
读取本身按 (repoId, itemType, number) 表记作答，切换条目时旧作答在 effect 前不被采用。
已删除工作区没有条目身份（`workspace:<worktreeId>`），同一双关联工作区被删时两个任务会得到相同
workspace key；P3 分组前必须解决这一点。

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
（codex-ark / trae）。

| # | 修正 | 来源 |
| --- | --- | --- |
| R1 | `Unlinked` 从分组降为**徽标/筛选器**（`◇`）；分组只保留运行/交付状态，并定义互斥优先级 | A |
| R2 | 逐 Agent 只显示 **token**，金额只出现在工作区级与任务级；会话级归因未成立前不显示金额 | A、C |
| R3 | 图 B 默认折叠历史 Agent、次要工作区与 Delivery/Evidence | A |
| R4 | M1 的 selector 必须可被 M2 直接复用，否则暂停并重新拆包 | A、B |
| R5 | M2 拆为 `M2a 存储兼容验证` + `M2b 落库实现`；M2a 不过就只交付 M1 | B |
| R6 | M1 的对照数据要覆盖 OpenCode 与 Muse，不只 Claude/Codex | C |
| R7 | `projectBreakdown.key` 必须经解析层 + 单测，不直接散落 `split(':')` | C |

`Delivered` 的产品定义已于 2026-11-16 由产品 owner 定为 **agent done**（D12，完整规则见 §7.2）；
分组优先级（`Needs you > Working > Delivered`）与归属规则同步冻结，遗留只有"失败轮是否算"一项。
D12 是本文最后一个决策编号，空号不复用。

### 6.2 评审后修正（2026-11-16，任务工作台 UI 两轮）

对象：§7.1 IA、§7.2 列表主轴、§7.3 图 B 工作台。两轮独立评审（codex-ark / trae）；第二轮只追问 4 个能改变
决定的点，两份稿见 [评审记录](discussion-record-task-workspace-ui.md)。

**能冻结（现在定）**

| 项 | 取值 |
| --- | --- |
| IA 主轴 | "任务 → 工作区(0..N) → Agent → 用量 → 交付证据"成立，不再推翻 |
| 一期形态 | M1 = 现有 issue/PR 详情加 `Orca` tab（§7.4），零持久化 |
| 分组规则 | 按**活跃（非归档）工作区状态并集**判定，不按 primary；0 工作区 / 无 tracker / 归档见 §7.2 |
| 侧栏 | **不加任务行**；只保留工作区行 + 任务徽标（两评一致） |
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
```

列表页不承担建单：建任务仍走各 provider 的 `＋ New issue` 表单，或让 agent 在会话里用既有 tracker
skills / CLI 动词建单。

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
  - 有效 `done`：`sessionBoundary === true` 的 done **不算**（connect/resume/clear 落地，不是完成一轮）；
    `outcome === 'failure' | 'cancellation'` **不算** Delivered；`outcome` 缺失（provider 未上报）仍算 done。
  - 语义：Delivered = "agent 声明这一轮做完了"，**不等于验收通过**。UI 文案只能说 `Delivered · agent done`，
    不得写"已完成/验收通过"，测试夹具也不得把它们当作等价。
  - resume 后状态回到 working → 自动离开 Delivered（派生，不缓存）；无 agent 或 0 工作区的任务不可能是 Delivered。
- primary workspace 缺失时按"最近活动"兜底，并在 UI 显式标注为派生（不是用户选择）。

**行内活动徽标（P3 前置薄切片，issue #27）**

上面是分组规则；徽标是同一套判定的**行内**呈现，先于分组落地，不改列表主轴、不重排、不分组：

- 呈现位置：每一行在 tracker 状态 pill **之外并列**一个 Orca 活动徽标。pill 仍是 provider 的事实
  （`Open` / `Closed`），徽标是本地派生量；两者不合并、不互相覆写，pill 的编辑 popover 行为不变。
  徽标落在**标题单元格**、标题右侧：该列是 sticky 列，窄窗降级时不会被挤掉（见本节"行内优先级"），
  而状态列只有 100px，放不下第二个 pill。
- 四态：`Needs you`（blocked / waiting，或 F8 的 failed / interrupted）、`Working`、`Delivered`
  （= 上面 D12 的有效 done）、`Workspace`（灰、中性）。
- **有工作区、无 agent（本节补的空白）**：显示灰色 `Workspace`，含义是"已绑定工作区、**没有任何 agent 做出状态声明**"——涵盖没有 agent、agent `idle`、以及上报缺失/失效三种情况（dashboard 会把 `unverifiable`/`no-evidence` 折成 `idle`）。
  不得伪造成 `Working`，也不得显示 `Delivered`（没有 agent 声明完成就不可能有 done）。徽标文案也不得写"没有 agent 在跑"：那是对第三种的越界断言，tooltip 只说"已绑定工作区、没有 agent 上报任务轮次"。
  这与"0 工作区"不同：0 工作区**不渲染徽标**，也不留空占位（0 工作区的分组仍按上面的规则，属 P3）。
- 归档工作区不参与任何一格；`Needs you > Working > Delivered` 的并集规则与分组完全一致。
- glyph 复用 `AgentStateDot`（spinner=working / amber=needs you / red=blocked / emerald=done / gray=idle），
  失败 / 中断 / 未定论沿用 F8 映射，不新造状态词汇；文案（含 tooltip）全部走 locale catalog，
  `Delivered` 的文案只能是 `Delivered · agent done`。
- 行级归属按 `repoId` + `linkedIssue` / `linkedPR` / `linkedWorkItem` 反查，**不把** identity 的
  `taskKey` 当集合：identity 是**命名**（issue #38 起 key 已扩到条目粒度，
  `tracker:github:acme/web-app:issue:412`，但分组 UI 仍未实现），成员资格由 `worktreeLinksTaskItem`
  逐 worktree 判定，页面与列表共用同一份判定实现；页面带 `providerIdentity` 时两处输入一致，页面没有
  时两处都只用条目链接，不从某个 worktree 的身份反推 host。每行 O(1) 查表由一个列表页级批量 hook
  提供，不按行调用 `useTaskWorkbenchView`（那个 hook 会为每行各跑一遍用量 selector 与 dashboard
  snapshot）。
- 本切片不做：列表分组 / 重排 / 主轴切换、`◇` 徽标、一任务多工作区合并、
  Linear / Jira / GitLab 列表、写回 tracker 状态、`taskRecords` 持久化。

渲染证据（harness 的 CDP 截图，fixture 数据，非真机）：

![GitHub 列表行活动徽标：宽屏](ui/impl-github-rows-badge-wide.png)
![GitHub 列表行活动徽标：900×700，徽标仍在标题旁](ui/impl-github-rows-badge-narrow.png)

```sh
cd orca
DISPLAY=:99 ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs \
  --fixture d6_github_task_rows --width 1440 --height 900
```

两张图是同一次 fixture（`d6_github_task_rows`：working / delivered / workspace / needs-you / 无活动 五行）：
宽屏 1440×900 与窄屏 900×700。driver 逐行（按标题定位）断言 `data-row-activity` 的取值、徽标可见文案、
同一行的 tracker pill 仍是 `Open`、以及徽标矩形完整落在视口内——第五行必须没有徽标。这证明的是 DOM
与几何，不是“真机验收”：selector 规则由纯单测覆盖，store→selector 接线由 `use-task-page-github-row-activity`
的单测覆盖；没有用真实仓库数据或真实 agent 跑过。

### 7.3 图 B：任务详情（工作台）

这是**设计稿**（目标形态），不是实现截图；实现的渲染见 §7.4.1。

矢量/位图都在 `ui/`：[design-workbench.svg](ui/design-workbench.svg)（1280×860 矢量，可缩放）、
`ui/design-workbench.png`（2560×1720，2× 渲染）。一张图四格：

![任务工作台设计稿：① 宽屏基线 ② 0 工作区 ③ 降级顺序 ④ 判定规则](ui/design-workbench.png)

- ① 宽屏基线：一任务 = N 工作区 → Agent → 用量 → 交付，双列布局；
- ② 0 工作区：Workspaces 变主操作，Spend 先让位，空态独占唯一 `Create workspace`；
- ③ 降级顺序：窄窗单列 / 矮窗，牺牲顺序 `Delivery → Agent 历史 → Spend 细节`，Workspaces 不牺牲；
- ④ 判定规则：`Delivered = agent done`、用量三态、P1a 的截图矩阵。

读这张图要注意三处已过期/未落实：

1. 页脚写「依据 README §6.4」，重排后是 §6.2；② 里引用的 §7.9.5 在本文没有对应小节。
   **只有 SVG 改了这两处文字，PNG 还是 11-16 的原样**。
2. ③ 说「P1a 只实现左图（单列 + Delivery 折叠）」——已过时：P1b 落地后两列/单列/矮窗都走同一个
   `computeTaskWorkbenchLayout`。
3. ① 里的 `All agents ▾`、`⋯` 菜单、工作区卡上的 `primary` 徽标与每卡 `412k tok · $1.20`，实现里都还没有
   （Agent 区是分组 + History 折叠；徽标是 `Default`；工作区卡不带用量，详见 §7.4.1 限制第 4 条）。

P1a 的组件拆分、fixture 与截图清单见 [P1a 静态壳计划](p1a-ui-shell-plan.md)。

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
| **所属工作区** | 评审新增（`M1` 必须）：多工作区时每个 Agent 行必须带 workspace 标识（`▦ web-app · feature/x`）；只到 M2b 才可降为 secondary chip |

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
M1 阶段它的正式定位是 **任务聚合视图**（§6.2），tab 名可以是 `Orca`，但文案不得承诺完整任务对象：

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

图 C 只覆盖"详情页里看任务"；它不提供建 agent 的入口。起 agent 的入口在项目块、`tab.newAgent` 与
各 Agent 自己的快捷键上（§7.9），与详情页正交：详情页不另开对话，列表页不复制 Agent 详情。

#### 7.4.1 分区截图（harness 渲染，不是设计稿）

下面 9 张是**当前代码渲染出来的**界面，按功能区拆开，源文件在 `ui/`（`impl-*.png`）。渲染方式是仓库既有的
rendered harness，用 P1a 的 fixture 数据跑生产组件，再用 CDP 截图（`devicePixelRatio = 1`）：

> **注意**：这 9 张是**视觉返工前**（2026-11-18 之前）的版面，保留下来只作为"改之前长什么样"的历史证据；
> 表格描述的是旧版面的分区职责。返工后的真渲染在 §7.4.5（`impl-20261118-*.png`），那才是当前代码的样子。

```sh
cd orca
DISPLAY=:99 ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs \
  --fixture f1_baseline --width 1440 --height 900
```

| 功能区 | 图 | 来源（fixture · 视口） | 这张图能证明什么 |
| --- | --- | --- | --- |
| Header | `ui/impl-header.png` | f1_baseline · 1440×900 | 标题、`GitHub acme/web-app open` 身份行、`web-app feature/add-login PR #431 draft` 默认工作区行、唯一主动作 `Open workspace` |
| Agents（分组） | `ui/impl-agents-groups.png` | f3_many_workspaces_agents · 1440×1200 | `Active 4` + `Needs you 1` 两组（`History 5` 见下一张）；workspace pill 在卡片上方一行，右侧窄列只有 token；`N subagent` / `just now` 在卡片内 |
| Agents（失败轮） | `ui/impl-agents-failure.png` | f8_failure_outcome · 1440×900 | History 行带红色 `Failed` 徽标、状态点变 failed；语义上不出现 Delivered |
| Workspaces | `ui/impl-workspaces.png` | f1_baseline · 1440×900 | 工作区卡：`web-app · feature/add-login · Default`、`local` host chip、`Create workspace` |
| Spend | `ui/impl-spend.png` | f1_baseline · 1440×900 | `1.3M tokens · —`（有未定价模型）、逐 provider（`claude … est. $1.20` / `codex … —`），未知不写 0 |
| Delivery | `ui/impl-delivery.png` | f1_baseline · 1440×900 | 一行摘要 `3 commits · PR #431 draft · checks 5/6 · Review pending` + 展开后的 last commit / review state / 只读说明 |
| 0 工作区 | `ui/impl-empty-state.png` | f2a_zero_workspace_open · 1440×900 | 虚线空态独占唯一 `Create workspace`（Header 无动作）、Agents 空态文案、Spend `unavailable · no_matching_session`、Delivery 只读提示 |
| 窄窗单列 | `ui/impl-narrow-single.png` | f1_baseline · 900×700 | `<1100px` 走单列 `Workspaces → Agents → Spend → Delivery(折叠)`，Workspaces 不牺牲 |
| 矮窗 | `ui/impl-short-viewport.png` | f1_baseline · 1280×479 | `<480px` 高度时 Spend 变一行摘要、History 折叠、Delivery 折成一条 |

图（同一顺序，文件名即上表）：

**Header** · f1_baseline 1440×900

![Header：标题、provider 身份行、默认工作区行、Open workspace](ui/impl-header.png)

**Agents（分组）** · f3_many_workspaces_agents 1440×1200

![Agents：Active 4 与 Needs you 1，每行带所属工作区 pill 与 token](ui/impl-agents-groups.png)

**Agents（失败轮）** · f8_failure_outcome 1440×900

![Agents：History 行带 Failed 徽标](ui/impl-agents-failure.png)

**Workspaces** · f1_baseline 1440×900

![Workspaces：工作区卡、Default 徽标、local host chip、Create workspace](ui/impl-workspaces.png)

**Spend** · f1_baseline 1440×900

![Spend：任务级 token 与逐 provider 金额，未定价显示破折号](ui/impl-spend.png)

**Delivery** · f1_baseline 1440×900

![Delivery：commits / PR / checks / review 摘要与展开体](ui/impl-delivery.png)

**0 工作区** · f2a_zero_workspace_open 1440×900

![0 工作区：虚线空态独占 Create workspace](ui/impl-empty-state.png)

**窄窗单列** · f1_baseline 900×700

![窄窗：单列 Workspaces → Agents → Spend → 折叠的 Delivery](ui/impl-narrow-single.png)

**矮窗** · f1_baseline 1280×479

![矮窗：Spend 变一行摘要、History 折叠、Delivery 折成一条](ui/impl-short-viewport.png)

四点限制必须一起读：

1. 这些是 **fixture 数据**的渲染：不经过 store、selector、RPC、持久化，也不切 locale（`i18n.ts` 给英文默认值）。
   它证明的是"组件按这份 view 数据会画成什么样"，不是"真机打开一个任务会看到什么"。
2. agent 行的**布局缺陷已修**（2026-11-18）：原来是 `card(flex-1) + overlay，auto 宽度`，带 workspace
   pill 的行把卡片挤窄、不带的行不挤，卡片宽度因此参差，token 文本又贴着列边；现在 pill 单独一行放在
   卡片上方，右侧只留一个固定窄列（token / 状态点 / outcome 徽标），所有行卡片等宽。截图是修后的渲染，
   修前形态可从 `git show 1bfea3cc:orca/.../TaskWorkbenchAgentRow.tsx` 复看。
3. 图里的 `All agents ▾`／`⋯` 之类**不存在**于实现：Agent 区是分组 + History 折叠，Header 只有一个动作。
   `ui/design-workbench.svg/png` 仍是 2026-11-16 的设计稿，与这些截图不是同一层证据；2026-11-18 的目标形态见 §7.4.2，
   实现状态见 §7.4.3。
4. **Workspaces 卡上没有 token / 金额**：设计稿每张卡有 `1 agent · 412k tok · $1.20`，实现只渲染
   名称、分支、`local`/`remote`、`Default`、归档与动作；用量只在 Spend 区（任务级 + 分 provider）。
   这是 P1b 相对设计稿的保真度缺口，不是渲染失败。

#### 7.4.2 视觉返工目标形态（2026-11-18，设计稿）

§7.4.1 的 `impl-*` 是**当前代码**画出来的样子；本节是**目标形态**：同一份数据，去掉重复与噪声之后的版面。
两张图都是 HTML/CSS 渲染的设计稿，不是生产组件渲染、也不是真机截图，证据层级低于 §7.4.1；
图内数据为脱敏占位（`acme/web-app`、`build-host-a`），不含真实主机、任务与用量。

**窄窗单列** · 793×560

![目标形态：窄窗单列（1 工作区 / 1 智能体 / 用量未启用）](ui/design-workbench-20261118-narrow.png)

**宽屏双列** · 1180×700

![目标形态：宽屏双列（2 工作区 / 5 智能体 / 有用量与交付证据）](ui/design-workbench-20261118-wide.png)

一句话：**一屏只讲一次——标题一次、工作区一次、状态一次；每个区只画一个面，不再卡片套卡片。**

| 区 | 现状（§7.4.1 的渲染） | 目标形态 |
| --- | --- | --- |
| 工作台头部 | h2 重复页面 h1 的标题，再一行 `▦ repo · 显示名`，再加第二个 `Open workspace` | 整块去掉：嵌在详情页的 tab 里，标题与身份由页面 h1、topbar 与页头提供 |
| 页头 meta | 多一个附加工作区 chip，内容就是工作区显示名（即标题） | 去掉；同一事实不在同一屏出现两次 |
| 工作区 | `Card` 三行（身份 / `Default` 徽标 / host 行），`py-6` 且无左右内边距，徽标用伪斜体 | 每个工作区一行：`▦ repo · branch` + host chip + 状态点 + `Default`；身份用分支名，不用显示名 |
| 智能体 | `AgentKanbanCard` 的 body + footer 两层，右侧固定 80px 列（无 token 时只有一个 `—`） | 每人一行：图标 · 会话名 · 状态 · 时长 · token · 动作；token 未知不渲染，不占位 |
| 用量 / 交付 | 两张卡；用量徽标写内部状态（`unavailable · disabled`），交付用虚线框 +「不表示已交付」 | 一条两行 fact 带：`用量 [未启用] 一句原因 [设置]` / `交付 [未读取] 一句原因 [读取]`；空态是事实，不是告警 |
| 折叠 | 标题行之后另起一个 `[Collapse ⌃]` 按钮 | 折叠动作挂在节标题右侧，同一行 |
| 节标题 | `Workspaces · 1 total` / `Agents · 1` / `History · 1` 三套计数 | 统一 `名称 + 计数`；CJK 不用大写式 tracking |

样式规则（实现时照此落地，不再逐尺寸调）：

- 节标题 `12px/600` + `12px` muted 计数；区块间距 `20px`；行内 `13px`，分支与 SHA 用 `12.5px` 等宽；
- 每个区一个 `8px` 圆角面，描边用 `inset 0 0 0 1px rgb(255 255 255 / .07)`，行间用 `inset 0 1px 0` 分隔；
- 区块内动作一律 24px 高的 ghost/quiet 次级按钮；全屏只有一个白底主按钮（页头）；
- CJK 不用 `italic`、不用 `tracking-wide` 的大写标题；`Default` 用 `--accent` 实心 tag。

三处取舍要一起读：

1. **工作台不再自报身份**。代价是这套面板放到独立窗口（图 B 场景）时要另给一个 variant；
   嵌在详情页的 M1 里，页面 h1、topbar 与页头状态胶囊已经覆盖这件事。
2. **身份行用分支名，不用工作区显示名**。Orca 生成的工作区显示名默认就是任务标题，
   拿它做 `repo · X` 会让同一个标题在别的区再出现一次。
3. **未接线的主按钮要画成禁用态**。目标形态里 `Open terminal` / `New workspace` / `Read evidence`
   都画成可用样子；实现时若 P1b 尚未接线，必须渲染为禁用或明确标注，不能与可用按钮同形
   （现状的 `Open workspace` / `Create workspace` / `Turn on in Settings` 都是无 handler 的可点按钮）。

实现与验收见 issue #26。

#### 7.4.3 视觉返工实现状态（2026-11-18）

§7.4.2 的版面已按图落地（issue #26），代码全在 `orca/src/renderer/src/components/task-workbench/`：

| 目标形态的一条 | 落地位置 | 说明 |
| --- | --- | --- |
| 工作台头部整块去掉 | `TaskWorkbenchPanel.tsx`；`TaskWorkbenchHeader.tsx` 删除 | 在 GitHub issue/PR 详情这条嵌入路径上，外层标题、编号与页头状态已经说清身份，第二个 `Open workspace` 随之消失，填色主按钮只剩页头那一个。**成立范围仅限这个入口**：PR 页头提供的是「从 PR 起草工作区」而不是「打开已关联工作区」，面板也不再画 `◇ No tracker` 身份徽标；将来若加独立窗口入口，由那个入口补一块最小身份区，不要恢复重复标题与重复主操作（§7.4.2 取舍 1） |
| 节标题统一 `名称 + 计数` | `task-workbench-section-heading.tsx` | 12px/600 + 12px muted 计数，折叠控件挂在同一行右侧；CJK 不再用 `uppercase`／`tracking-wide`／`italic` |
| 工作区每工作区一行 | `TaskWorkbenchWorkspaces.tsx` | 一个 8px 圆角面 + 行间 `inset 0 1px 0`；身份改印**分支名**（`TaskWorkbenchWorkspace.branchName`，由 `use-task-workbench-view.ts` 从 `Worktree.branch` 填入），没有分支时回退显示名；`local` 主机不再占一个 chip |
| 智能体每人一行 | `TaskWorkbenchAgentRow.tsx` | 不再渲染 `AgentKanbanCard`（body + footer 两层）；图标 · 会话名 · 状态 · 时长 · token · 动作；未知 token **不渲染**，不留 `—` 空列 |
| 用量 / 交付一条两行 fact 带 | `TaskWorkbenchFacts.tsx` + 两个 section 各一行 | 用量徽标改印读者词（`未启用`），内部状态 token 只留在 tooltip；交付空态是带 `未读取` 标签的事实，不是虚线告警 |
| 未接线动作画成禁用态 | `task-workbench-pending-action.tsx` | `打开终端`／`新建工作区`／`设置`／`读取证据` 统一走这个组件：按钮 `disabled`（点不动），说明挂在**外层 span 的 `title`**——`ui/button.tsx` 带 `disabled:pointer-events-none`，写在禁用按钮上的 `title` 永远等不到 hover，而且禁用按钮也不是键盘停留点 |

文案一致性（issue #26 第 3、4 条）：

- `开放` vs `打开`：`打开` 原本是工作台自画的 tracker 状态徽标；随头部删除一起消失，issue 状态现在只由页面
  统一的 `开放` 表达，`打开` 只剩 PR 状态的 `pullRequestState.open` 一处含义。
- `不可用 · disabled`：界面印读者词（`未启用`／`未定价`／`匹配不唯一`／`未找到匹配会话`／`远程主机`／`未归属`），
  内部 token 退到同一个徽标的 `title`。§7.5 的三态规则本身没变，只是换了呈现层。
- 未翻译的 `In progress`：那是 store 里的**工作区状态标签**（用户自建数据，`WorkspaceStatusDefinition.label`），
  不是本仓库的文案。实现侧的处理是把它继续按数据原样渲染，而不是替用户数据编译文；若内置默认状态也要
  本地化，那是 seed 数据与 `WorkspaceStatusDefinition` 的改动，属于另一件事。

三处设计稿没写、实现时按"不造数据"补的取舍：

1. **agent 行的状态词**复用看板分组词（`dashboardPopout.bucket.*`：Working / Needs You / Done / Idle），
   那四个词六种语言都已翻译；`failed` / `interrupted` / `unverifiable` 三个裁决态另有自己的词
   （`TaskWorkbenchAgentRow.state.*`）。有 `outcome` 的行印裁决词（Delivered / Failed / Cancelled），
   F8 语义不变：失败轮永远读不出 Delivered，缺 `outcome` 也不算成功。
2. **交付不自造状态词**：设计稿的 `[进行中]` 标签在 view 里没有对应字段（`DeliveryEvidence` 只有 commits /
   PR / checks / review）。实现只在"没有证据"时印 `未读取`，有证据时直接列事实，不猜一个状态。
3. **工作区折叠仍保留**：设计稿只画了 2 个工作区，没有画 3+ 与归档的取舍。契约 §4.3 的两条
   （>2 折叠、归档折叠）没有变，只是折叠按钮从独立一行挪进了同一个面里。
4. **交付的默认展开状态没改**：它仍由 `computeTaskWorkbenchLayout` 决定（宽屏有证据时默认展开），
   所以真渲染下交付行下方会多一段证据体，与设计稿图里的收起态不同。改那个默认值属于布局合同
   （issue #26 明确不碰降级阈值与双列边界），不在本轮范围内。

六种语言的覆盖面（评审后写清）：本轮把**纯格式模板**同步到了全部六语——计数只印 `{{value0}}`
（原来 es/fr/ja/ko 是 `… en total` / `au total` / `全 N 件` / `총 N개`）、agent 行 token 只印数字
（原来带 `tokens` / `jetons` / `トークン` / `토큰`）；**词级文案**只覆盖 zh/en，es/fr/ja/ko 保留既有译文，
既不回退也不在本轮调整。因此不能说"六种语言都完成了视觉收口"。

证据层级：本节先是"代码 + 定向检查"，随后按 `orca` 的依赖树补齐了可执行证据（§7.4.5 有命令与结果）。
变更点汇总：harness 期望表按新 DOM 更新（header 的 testid 整组删除，新增 `-facts`／`-row-icon`／`-row-action`／
`workspace-host-chip`／`delivery-read`，token 断言改成"只比较有数字的行"，用量断言从内部 token 改成读者词）。

#### 7.4.4 只读评审回执（codex-ark，2026-11-18）

评审原文归档在 [review-codex-ark-issue-26.md](review-codex-ark-issue-26.md)（它当时针对的是 `b98133fe`）。

写完之后起了一个 `codex-ark` 终端做只读评审（只读 diff 与文件，不改代码、不 commit）。它确认了
F8 语义、未知 token 不渲染、三个空态不出现「假 0」都没有被改坏，也确认窄窗/双列的牺牲顺序没被重排；
同时找出四处**必须改**的问题，本提交已全部修掉：

| 问题 | 位置 | 处理 |
| --- | --- | --- |
| harness 里 `tokenRows` 在声明前被读（TDZ，`ReferenceError`） | `tests/tools/task-workbench-rendered/run.mjs` | 声明移到 `expectedTestIds` 之前；顺带把 `archivedVisibleCards` 从"仅 full 布局"改成两分支都用归档行数，把 secondary toggle 期望改成组件自己的 `collapseSecondary` |
| join 单测仍期待裸 `feature/x`，新 join 返回 `repo · branch` | `lib/task-workbench/task-workbench-join.test.ts` | 更新两处字面量，并补 branchName 优先、缺 branchName 回退显示名、folder 不泄漏目录路径三个用例 |
| 禁用按钮的 `title` 实际看不到（`disabled:pointer-events-none`，且不可聚焦） | 5 处未接线动作 | 新增 `task-workbench-pending-action.tsx`：按钮保持 `disabled`，说明放到可悬停的外层 |
| 窄列里身份被挤没（身份 `flex-1`、其余 `shrink-0`、外层 `overflow-hidden`） | Workspaces 行、Agent 行 | 两行都改 `flex-wrap`，身份加 `min-w-32` 下限，次要元信息换行而不是吃掉名字 |
| 文案 | en/zh | `Ambiguous → Multiple matches / 匹配不唯一`、`No session → No matching session / 未找到匹配会话`、`尚未接线 → 此版本暂不支持`、`Read → Load evidence / 读取证据`、PR `open` 的 zh 由 `打开` 改 `开放中`；仍是"状态词"，不是内部 token |

第二轮复核（同一终端、仍只读）确认四处修复都已落地、39 个 testid 与期望表逐名对应、文案取舍认可，
并再指出三处，本提交也一并改掉：

| 二轮问题 | 处理 |
| --- | --- |
| compact 布局下 secondary toggle 的期望仍为 1，实际组件印 `+N more` 文本 | 期望改成 `layout.workspaces === 'full' && collapseSecondary` |
| folder 用例没有目录路径输入，只证明了显示名回退，没证明路径不泄漏 | 把规则从 hook 抽成纯模块 `lib/task-workbench/task-workbench-workspace-branch.ts`，单测直接喂 `/Users/someone/work/docs` 这类路径：folder / 空串 / 缺字段一律 `undefined` |
| 禁用说明只有鼠标可达，键盘与读屏仍无从得知 | `task-workbench-pending-action.tsx` 再补一条 `sr-only` 说明并用 `aria-describedby` 关联（`useId` 保证每行独立） |

评审留下、本轮**没有**改的两条：

1. **时间列**：`formatStartedAgo(now, now)` 让 fixture 渲染恒为"刚刚"。这是返工前就有的自锚定写法
   （为了让截图可复现），不是本次引入；正确做法是注入时钟或隐藏该列，属于 P1b 的行为改动。
2. **F8 与三个空态的整行渲染断言**：`TaskWorkbenchAgentRow.test.tsx` 只能挂载 dot 与投影，因为行本身
   经 `@/lib/agent-catalog` 拉 `resources/`（sparse 检出没有该目录）。真正的整行断言要靠 harness 截图，
   也就是上面那组尚未产出的真渲染图。

#### 7.4.5 返工后的真渲染与执行证据（2026-11-18）

依赖树按 `package.json` 的 pin 装好（`pnpm@12.0.0`，`pnpm install --offline --frozen-lockfile`，Electron 二进制
从 `~/.cache/electron` 解出），于是 §7.4.3 里"没有跑过"的部分现在都有结果。

**图**：下面 8 张是**当前代码**渲染的，仍走 §7.4.1 那条 harness（fixture → 生产组件 → CDP 截图，
`devicePixelRatio = 1`），文件名同样在 `ui/`：

| 面 | 图 | fixture · 视口 | 这张图能证明什么 |
| --- | --- | --- | --- |
| 宽屏双列 | `ui/impl-20261118-wide.png` | f1_baseline · 1440×900 | 左 Agents（`Working 1` + `History 1` 折叠控件在节标题右侧）、右 Workspaces + facts 带；工作区身份是 `web-app · feature/add-login`（分支名，不是显示名） |
| 窄窗单列 | `ui/impl-20261118-narrow.png` | f1_baseline · 900×700 | `<1100px` 走 Workspaces → Agents → facts，Delivery 自动折成一行 `Expand`，用量降为一行摘要 |
| 矮窗 | `ui/impl-20261118-short.png` | f1_baseline · 1280×479 | `<480px` 时 Workspaces 变紧凑行、Spend 摘要、Delivery 折叠 |
| Agents 分组 | `ui/impl-20261118-agents.png` | f3_many_workspaces_agents · 1440×900 | `Working 4` / `Needs you 1`（tinted）/ `History 5`（展开后有独立组标题）；多工作区时每行带 `▦ api · feature/jwt-verify` pill |
| 工作区归档折叠 | `ui/impl-20261118-workspaces-fold.png` | f5_archived_only · 1440×900 | 唯一工作区已归档时折叠默认展开、行带 `Archived`，且不带 `Default` 标记 |
| facts 带（不可用态） | `ui/impl-20261118-facts.png` | f4_usage_disabled · 1440×900 | 用量印读者词 `Not enabled` + 一句原因 + `Settings`，交付印 `Not loaded` + 原因 + `Load evidence`；两行同一个面，虚线告警没有了 |
| 0 工作区 | `ui/impl-20261118-empty.png` | f2a_zero_workspace_open · 1440×900 | 空态是事实 + 一个 disabled 的 `Create workspace`；用量 `No matching session`、交付 `Not loaded`，全程没有 `$0` |
| 失败轮 | `ui/impl-20261118-failure.png` | f8_failure_outcome · 1440×900 | 行里印 `Failed` 且**没有** `Delivered`，点变 failed |

**命令与结果**（都在 `orca/` 下执行；未提交 `node_modules` 与 `.bench-fixtures/`）：

```sh
node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts --maxWorkers=2 \
  src/renderer/src/components/task-workbench src/renderer/src/lib/task-workbench
#   Test Files 8 passed (8) / Tests 149 passed (149) / 3.4s

node config/scripts/run-typecheck-projects-in-parallel.mjs          # 四个 tsc 项目，无输出，exit 0
node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.tc.web.json   # exit 0
node_modules/.bin/oxlint --config .oxlintrc.json src/renderer/src/components/task-workbench   # exit 0
node_modules/.bin/oxlint --config config/oxlint-design-system.json src/renderer/src/components/task-workbench  # exit 0
node config/scripts/check-max-lines-ratchet.mjs                    # OK，无新增 bypass
node config/scripts/verify-localization-catalogs.mjs               # exit 0（zh 15046/15120，es/fr/ja/ko 各缺 250，均走既定回退）
node config/scripts/generate-runtime-required-english-catalog.mjs  # exit 0：手写的 runtime catalog 与生成器一致
node config/scripts/verify-localization-extraction.mjs             # exit 0

DISPLAY=:99 ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --all --calibrate
#   summary: 17/17 passed, 21.7s（S1–S10d + F9 + 两条降级探针）
```

**还没做**：

- `verify:localization-coverage` 在这条分支上是**红**的，但红的不是本次改动：它报
  `IncidentDetailDrawer.tsx:131`（`sha256:`）与 `IncidentGrayTables.tsx:186`（`exit`）两处，两个文件的最后一次改动
  是 `3a1469c8`，与本次提交无关。没有顺手把它们加进 allowlist——那会把一个真实缺口静音。
- 仍**没有真机核对**：图是 fixture 数据的渲染，不经过 store / selector / RPC / 持久化，也不切 locale
  （harness 用英文默认值）。"真机打开一个任务会看到什么"依然未验证。
- 真机核对要看的三件事：(1) 真实 worktree 的 `branch` 是否总被填上（folder 之外）；(2) 窄窗里长 host /
  长工作区状态是否按 `flex-wrap` 换行而不是被裁掉；(3) 未接线动作的 `aria-describedby` 在读屏里是否真的
  念出原因。

### 7.5 状态矩阵（必须逐条实现，否则会出现"假 0"）

| 场景 | 触发条件 | UI 表现 |
| --- | --- | --- |
| 用量可用 | `estimatedCostUsd !== null` | 数字 + 估算 tooltip |
| 用量统计未启用 | `scanState.enabled === false` | 徽标 `未启用` + 一句原因 + `设置` 动作（§7.4.3：徽标印读者词，`unavailable · disabled` 退到 tooltip） |
| 未定价模型 | `hasUnpricedModels` | tokens 正常、花费显示 `—` + 说明 |
| 会话归因歧义 | 时间窗内多个候选 | 徽标 `匹配不唯一`，原因句说明并列多个候选，不猜 |
| 无匹配会话 | 窗口内无会话 | 徽标 `未找到匹配会话` + 原因句 |
| 远端 / SSH 工作区 | `executionHostId` 非本地 | 工作区行带 host chip；用量徽标 `远程主机` + 原因句 |
| 无关联工作区 | 任务无绑定 | 主按钮 `Create workspace from this task` |
| 本地任务（无 tracker） | 仅在 worktree 侧存在 | 行内 `◇` 徽标 + 顶部筛选；按活跃工作区状态并入 Needs you/Working/Delivered，标题取 `displayName`（§7.4.3：工作台自身不再画身份徽标，这一列由列表页与页头承担） |
| 工作区已归档 | `isArchived` | 折叠在 `Show archived` 下，不参与"Needs you"计数 |
| 逐 Agent 成本不可归因 | 会话行无 `worktreeId` / `ambiguous_session` | 该行只显示 token；token 未知时**整列不渲染**（§7.4.3），成本只到工作区级 |
| 无 tracker 的工作区 | 无 `linkedWorkItem` 等字段 | 行内 `◇` 徽标 + 顶部筛选；不影响其状态分组 |

徽标词与内部 token 的对应（§7.4.3）：`disabled → 未启用`、`unpriced → 未定价`、
`ambiguous_session → 匹配不唯一`、`no_matching_session → 未找到匹配会话`、`remote_host → 远程主机`、
`unattributed → 未归属`。token 本身不删，仍可通过同一个徽标的 `title` 读到。

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

### 7.9 起 agent 的入口：项目块 / 快捷键 / 详情页（2026-11-18 实现）

工作台本身不建 agent。agent 从这三处起，解析链同源：

| 入口 | 行为 | 证据 |
| --- | --- | --- |
| 项目块菜单 `Open agent in <project>` | 定位该 repo 的 **main worktree**（`isMainWorktree`，即仓库自己的 checkout），先 `activateAndRevealWorktree` 切过去，再 `launchAgentInNewTab`（`launchSource: 'sidebar'`）；**不建分支、不建 worktree** | `renderer/src/lib/repo-checkout-worktree.ts`、`renderer/src/lib/start-agent-in-repo-checkout.ts`、`sidebar/worktree-list/rows/repo-header-project-actions.tsx`（只有 git 项目显示该项） |
| `tab.newAgent` 及每个 agent 自己的 new-tab chord | 同一个默认 agent 解析 | `renderer/src/lib/agent-tab-shortcuts.ts` |
| 任务详情 `Orca` tab（P1/M1） | **只读**：不提供建 agent / 建工作区的按钮，只有 `[ Open workspace ]` 一类跳转 | `github-item-dialog/open-dialog/github-item-dialog-orca-tab.tsx` |

解析规则（1 处实现，两个入口共用）：

```text
resolveDefaultAgentForNewTab({ defaultTuiAgent, detectedAgentIds, disabledTuiAgents })
  → pickTuiAgent: 默认值须"已检测且未禁用"才生效，否则按 TUI_AGENT_AUTO_PICK_ORDER 取第一个可用
```

- 远端 checkout 用该 host 的检测列表（`remoteDetectedAgentIds[connectionId]`）；`getConnectionId` 返回
  `undefined`（repo 还没 hydrate）时会退回**客户端本机**的 `detectedAgentIds`——这是当前实现的一个边角，
  观察到"远端工作区却起了本机才装的 agent"时先查这里。
- 模型不在这条链上：Orca 只追加 `settings.agentDefaultArgs.<agent>`，模型是各 agent CLI 自己的配置
  （例如 TRAE CLI 读 `~/.trae/traecli.toml`）。因此"这次起的 agent 用哪个模型"不是 Orca 的设置项。
- 没有 checkout 或没有可用 agent 时 toast 报出，不静默失败、不退化到"列表第一条 worktree"。

与隔离的关系：该入口在仓库自己的 checkout 上开 tab，**不产生** sparse 任务绑定，也不受稀疏任务启动门禁
保护；要在 checkout 里改代码，就是绕过 [任务工作区设计](../task-workspaces.md) 的隔离约定，由使用者自己负责。

明确不做：在详情页内嵌对话。

> 唯一的受控例外是 **§7.11 交付入口**：一次带必填输入的交接，不是通用"起 agent"按钮；
> 它不选 agent、不建分支与工作区，只在既有工作区上开一个 tab。那条边界与退化形态（未采用）写在 §7.11.4。

---

### 7.10 已完成任务的历史：三态与 S1 落地（issue #31）

状态：**S1（渲染层）+「第 0 步止血」+ S2（`issue → worktreeId` 持久映射）已实现**；S3（session-search
事实条、`orca history task` 出口）**未开始**。S4（真快照）不在范围。

「没有工作区」不再是唯一空态，三种状态分开：

| 状态 | 判据 | 界面 |
| --- | --- | --- |
| 从未开始 | 无工作区，且无历史记录 | 保留 `Create workspace` 空态（f2a/f2b） |
| 跑过 + 工作区已归档 | `history.trace === 'archived'` | `Run history` 事实条 + 归档注 + Workspaces 折叠区；归档 agent 行进 History 折叠区（f2c） |
| 跑过 + 工作区已删除 | `history.trace === 'deleted'` | 事实条自给自足（自带 run 列表），无 Agents / Workspaces 段，明确写 trace 不可达（f2d）；真实删除任务的 agent / wall / token 为未知，run 列表等 S3 |

落地位置：

| 改动 | 文件 | 关键规则 |
| --- | --- | --- |
| 事实条与 run 列表 | `orca/src/renderer/src/components/task-workbench/TaskWorkbenchHistory.tsx` | 未知不写 0：`agents: null → agents unknown`、token 不可用 → `tokens unknown`；墙钟带 `measured / partial / unknown` 来源 |
| 空态分流 | `TaskWorkbenchPanel.tsx` | `hasHistory`（`trace !== 'none'` 或有记录）时不渲染 `task-workbench-empty-state`；`deleted` 时不渲染 Agents / Workspaces |
| 归档 agent 行 | `task-workbench-join.ts`、`task-workbench-row-projection.ts` | 归档工作树的行带 `archivedWorkspace`，`rowBucket` 一律归 History；不参与 Active / Needs you / 默认工作区 / 交付 |
| 保留记录不再被剪 | `useRetainedAgents.ts` | prune allowlist 收录归档工作区 id；归档不再等于删除历史。被**删除**的工作区仍不在 allowlist（无记录可保） |
| 归档身份 | `task-workbench-identity.ts` | 无 live 工作区时，归档 provenance 作为 `archived-worktree` 回退，关闭任务不再掉到「无标识」 |
| 归档行投影 | `use-task-workbench-view.ts`、`build-dashboard-snapshot.ts`、`dashboard-snapshot-workspaces.ts` | 新增 `includeArchivedWorktreeIds`：看板仍只看活跃工作区，工作台只为**本任务**的归档工作区取卡片 |
| 删除后仍保留的映射（S2，已被 P4 取代） | `shared/task-run-history.ts` | `taskRunHistory` 曾落在 profile-state 顶层 JSON；P4 之后**只读**：加载时一次性播种 `taskRecords`，不再写入（见 §8.10）；行保留 1500 条上限只为让旧 build 仍能读 |
| 归档/恢复入口 | `worktree archive` / `unarchive`、sidebar 右键、`WorktreeVisibilityDialog` 的 `ArchivedWorktreeList` | 只改 `isArchived`，不动物理工作区；恢复是同一个元数据写 |

口径（沿用 §7.5）：墙钟 = 首个 `startedAt` → 末个 `finishedAt`；缺任一端的行让整体降为 `partial`，不拿「现在」补。
Token 只有在每一行都可归属时才是合计；否则保持 `unavailable`（原因沿用 `SpendReason`）。`trace` 只给位置与
「复制恢复命令」的占位动作，不内联 transcript。

归档入口已补：`orca worktree archive` 只把工作区从列表隐藏（保留 checkout / Git 注册 / meta / trace），
`orca worktree unarchive` 恢复，`worktree rm` 仍是唯一物理删除。这给上表的「归档」形态一个真实来源，
也是 `swarm/skills/worktree-delivery` 把清理默认动作从删除改成归档的依据。

**剩余证据缺口（明说）**：S2 存的是身份映射，不是 agent 运行记录。真实删除任务现在能进入 `deleted`
形态（不再谎称「从未开始」），但 `agents / wall / tokens` 是未知、run 列表为空——这些要等 S3 用记录里的
`path` 去 session-search / usage 里反查。f2d 的完整 run 列表仍只证明渲染形态，不证明真实数据。

验收证据：`tests/tools/task-workbench-rendered/run.mjs --all`（F2c / F2c-narrow / F2d 三个新用例，
20/20 通过）与 `task-workbench-join` / `task-workbench-identity` / `useRetainedAgentsSync` /
`build-dashboard-snapshot` 单测。

### 7.11 交付入口：把「先交付、再归档」做成一个显式动作（2026-11-19，已实现）

状态：**已在分支 `feat-task-workbench-7.11` 实现**。生产实现是 renderer 代码 + 六语 i18n；验证与设计
落在 `orca/tests/tools/task-workbench-rendered/`、本文档及六张实现图（完整清单见 §7.11.5）。没有新增
持久化、RPC/IPC 或 schema，没有 merge / push / deploy。D1 按主形态落地——真实按钮 + 真实启动，
退化形态 `[ 复制交付命令 ]` 未采用（§7.11.4）。§7.11.2 的三张图仍是与 §7.4.2 同层的 HTML/CSS 渲染稿
（源文件与渲染脚本在 `ui/src/`；重渲染需要已准备好 `orca/node_modules` 的主机、CJK 字体和一个 X display，
脚本不下载也不安装任何东西），不是生产组件渲染、也不是真机截图；图内数据为脱敏占位（`acme/web-app`、
`feat/task-431`），不含真实主机、会话与用量。实现后的六张 fixture 渲染图、命令与它们证明不了的事见 §7.11.6。

#### 7.11.1 要解决的问题

实现之前，工作台上没有"交付"的入口：`swarm/skills/worktree-delivery` 是给 agent 的流程文档，只能由操作者在会话里
自己发起；工作台当时能做的只有 `[ 打开终端 ]`。而**归档不是那个信号**：`worktree archive` 是交付之后的保留动作
（`worktree-delivery` §5），也可能只是把一个任务暂时 park 住。

被否掉的做法：**在归档时自动开一个 agent 走 worktree 流程**。三条理由，留在这里以免有人重新提议：

| 理由 | 依据 |
| --- | --- |
| 方向反了 | 归档是交付完成后的保留动作；auto-deliver 会让交付发生在交付之后，且每次 park 都会开一个会 merge 的 agent |
| 授权反了 | 归档点击不携带目标分支、模型、预算、`max_workers`、runtime；`AGENTS.md` 要求启动 agent 是单独授权动作 |
| 挂不上 | `orca.yaml` 的 `scripts.archive` 是 120s 死线的 shell hook（`orca/src/main/hooks.ts` 的 `HOOK_TIMEOUT`），超时会被判失败并拦住 `worktree rm`（`worktree-archive-hook-gate.ts`）；SSH 路径根本跑不了 hook（`gateRemovalWhereArchiveHookCannotRun`）；多选批量归档会一次起 N 个 |

结论：改成**显式 `[ 交付… ]` 动作**，其最后一步才是归档。

#### 7.11.2 三张设计稿

**D1 入口** · 1180×556（`ui/design-deliver-20261119-entry-wide.png`）
![交付入口：宽屏工作台上的交付事实行](ui/design-deliver-20261119-entry-wide.png)

**D2 确认面** · 660×545（`ui/design-deliver-20261119-confirm.png`）
![交付确认面：目标分支 / 集成方式 / 交付后归档](ui/design-deliver-20261119-confirm.png)

**D3 启动之后** · 900×365（`ui/design-deliver-20261119-after-launch.png`）
![交付启动之后：动作换成打开终端，菜单按生命周期排序](ui/design-deliver-20261119-after-launch.png)

#### 7.11.3 落地规则（逐条可验收）

| # | 规则 | 为什么 | 落地位置 · 证明 |
| --- | --- | --- | --- |
| 1 | 一个动作两个入口：交付事实行右端 + sidebar 右键（`交付…` 在 `归档` 上方），同一命令 | 读者在想"交付"的地方和"归档"本来所在的地方都要能到；菜单次序＝生命周期次序 | 事实行：`TaskWorkbenchDelivery.tsx` 的 `DeliverEntry`（`data-testid="task-workbench-deliver-action"`，行右端、折叠按钮之后）；sidebar：`WorktreeContextMenuView.tsx`（`data-testid="worktree-context-menu-deliver"`，紧邻 `Archive workspace` 之上）；两处读同一个 `projectTaskWorkbenchDeliver`，启动都走 `lib/task-workbench/task-workbench-deliver-launch.ts`。证明：`TaskWorkbenchDelivery.deliver.test.tsx` › *renders a live entry at the row's right end when the workspace may be delivered*；`WorktreeContextMenu.deliver-order.test.tsx` › *renders Deliver… directly above Archive workspace, with Delete last* |
| 2 | 确认面是 inline popover，不是模态框；主按钮是 outline | §7.4.2：全屏只有一个白底主按钮（页头）。模态框会造出第二个 | `task-workbench-deliver-confirm.tsx`：根节点 `data-testid="task-workbench-deliver-confirm"`，无 `Dialog` / `role="dialog"` / 遮罩，submit `variant="outline"`；两个宿主 import 同一个组件（`TaskWorkbenchDelivery.tsx`、`WorktreeContextMenuOverlays.tsx`），未复制实现。证明：`task-workbench-deliver-confirm.test.tsx` › *renders the panel without a dialog role or an overlay*、› *adds no solid primary: submit is outline and nothing is filled*；`TaskWorkbenchDelivery.deliver.test.tsx` › *opens the inline popover, not a dialog, with an outline submit* |
| 3 | 必填三项：目标分支 / 集成方式 / 交付后归档；默认分支标 `默认值 · 需确认` | `worktree-delivery` §1「main branch 不一定叫 main」、§3「一个写者」；归档勾选把"自动归档"变成人看见的勾 | `task-workbench-deliver-confirm.tsx`：分支输入、`role="radiogroup"` 三选一、归档 `Checkbox`；默认值来自 `use-task-workbench-view.ts` 的 `targetBranchDefault`（主工作区分支，去掉 `refs/heads/`；detached 则 absent，不猜 `main`）与 `task-workbench-view.ts` 的 `targetBranchDefault?`；sidebar 侧从既有 `allWorktrees` 取主工作区分支，没有就留空。证明：confirm › *pre-fills the default branch and labels it as a default that needs confirmation*、› *drops the default label once the reader types their own branch*、› *blocks submit on an empty branch and says why*；`use-task-workbench-view.test.tsx` › *fills targetBranchDefault from the repo main worktree branch*；`WorktreeContextMenu.deliver-order.test.tsx` › *blocks submit when no main worktree branch is known, and launches nothing* |
| 4 | 幂等：已有 `DELIVER` 会话时两个入口的同一位置都换成 `[ 打开终端 ]`，不再开第二个；目标工作区有 Working agent 时 `[ 交付… ]` 禁用，理由挂在 `title` + `sr-only` | §3 一个写者；确认面打开期间状态仍会变化，所以“打开时可交付”不是“提交时仍可交付” | 判定：`task-workbench-deliver-state.ts` 先认 marker（`open-terminal`）再认 one-writer；两个宿主都在 submit 时用最新输入重新投影，Working / archived / no-workspace 不启动，期间出现 marker 则 reveal；启动器再同步重查 live store 防连点。事实行禁用态复用 `TaskWorkbenchPendingAction`；sidebar 用可聚焦的 `aria-disabled` item，`title` + `aria-describedby` 指向 `sr-only` 理由，`onSelect.preventDefault()` 阻止激活（不是 Radix `disabled`）。证明：launch › *does not launch when a marker tab already exists (zero calls)*、› *launches exactly once across two activations, because the first publish is synchronous*；fact row › *refuses a submit after the view turned one-writer, and states the reason*、› *closes without launching when the view turns archived while the panel is open*；sidebar › *shows Open terminal for an existing DELIVER session and reveals it without launching*、› *keeps the one-writer item keyboard-focusable and refuses keyboard activation*、› *launches nothing when a working agent appears after the confirmation opened*、› *launches nothing when the workspace is archived after the confirmation opened*、› *reveals a session that appeared after the confirmation opened, and launches nothing* |
| 5 | 不造状态词：运行态复用 `dashboardPopout.bucket.*`（Working/Done）与 `outcome`（Delivered）；未知字段整行不渲染 | §7.4.3「交付不自造状态词」、§7.5 三态规则 | 投影只读既有字段（`bucket` / `conversationName` / `delivery`），不引入新词（`task-workbench-deliver-state.ts`）；事实行原有证据词未改。证明：`TaskWorkbenchDelivery.deliver.test.tsx` › *keeps the evidence row's counts untouched when evidence is present*；`task-workbench-deliver-state.test.ts` › *emits only { key, fallback } copy, no count and no status word, for every fixture* |
| 6 | `注意` 行（未提交 / 未推送）只陈述，不染色、不拦截 | 它是事实不是告警；`worktree-delivery` 也禁止自动 stash/reset/clean | `task-workbench-deliver-state.ts` 的 `attention` 今天恒为 `[]`；confirm 只在非空时渲染，且不 disabled / 不 gate（`task-workbench-deliver-confirm.tsx`）；启动指令里的 attention 也只作事实陈述（`task-workbench-deliver-launch.ts`）。证明：confirm › *states each notice when one exists, without disabling the submit*；`TaskWorkbenchDelivery.deliver.test.tsx` › *renders no attention row, because the projection has no such fact today*；`task-workbench-deliver-state.test.ts` › *projects the identical state and action for every fixture whatever 注意 carries* |
| 7 | agent 宿主＝被交付的专用 git worktree；主检出与 folder workspace 都不是目标；每一种集成模式都必须经 PR，不写主检出、不直推目标分支 | §1/§2 就地核验与跑测试、复用已准备的 `node_modules`；主检出对修改型工作只读；mode 只决定 PR 携带的历史形状 | `task-workbench-deliver-state.ts` 的 `isDeliverableTarget` 同时供 task page 选目标，sidebar 沿用 `archivableWorktrees` 排除同两类；若只有主检出/folder，入口不出现。启动器在目标 `worktreeId` 上 activate + launch；固定指令无条件要求 PR，任何 mode 无法在此约束内完成时 stop/report。证明：state › *linked-main-only: the repository’s own checkout gets no entry (A9)*、› *main + a dedicated worktree: the dedicated worktree is chosen*、› *a folder workspace is skipped and never selected explicitly*；launch › *requires a pull request against the target branch in `<mode>` mode*（pr/local-merge/squash）、› *launches exactly once for the target worktree and passes the frozen marker*；sidebar › *launches exactly once with source sidebar and the clicked workspace id* |
| 8 | 勾选「交付后归档」时，归档是交付 agent 的最后一步：**先报告、后归档**；未勾选时 agent 不归档 | 归档只把行移进 `Show archived`，不杀 PTY（§7.10）；让 agent 自己执行，才不依赖某个面板挂着、也不怕 renderer 重启丢意图（issue #49 替换了 §7.12 D2 的 renderer 内存意图） | 指令第 8 步 `orca worktree archive --worktree <self> --json`，排在报告段之后（`task-workbench-deliver-launch.ts`）；归档失败只写进报告，不重试、不判交付失败。证明：`task-workbench-deliver-launch.test.ts` › *adds the archive step after the report when archiveAfter is set, plus the workspace label*、› *A4: includes the archive step only when the tick is set, in any combination of ticks*、› *carries the three inputs and the archive-by-human rule when the tick is off* |

#### 7.11.4 与 §7.9 的关系（必须一起读）

§7.9 立过规矩：**工作台不建 agent**，任务详情 `Orca` tab 是只读的。§7.11 是它的一个**受控例外**，边界写死：

- 不是通用"起 agent"入口，是一次带必填输入的交接；它不选 agent（沿用 `resolveDefaultAgentForNewTab`，
  `task-workbench-deliver-launch.ts`），不建分支、不建 worktree，只在**既有**工作区上开一个 tab
  （`launchAgentInNewTab({ worktreeId })`）；
- `launchAgentInNewTab` 已支持初始 prompt（`renderer/src/components/tab-bar/QuickLaunchButton.tsx` 把初始
  prompt 转发给它），所以"发固定交付指令"不需要新 RPC；本次也没有新增 RPC/IPC、持久化或 schema；
- **D1 已按主形态落地**：真实按钮 + 真实启动（`launchTaskWorkbenchDeliver`），不是退化的
  `[ 复制交付命令 ]`。退化形态未采用，只作为评审若否决这条例外时的退路保留：它保留"归档是终点"的
  正确顺序，代价是回到手工。

#### 7.11.5 实现清单（已落地）

| 改动 | 位置 | 做什么 |
| --- | --- | --- |
| 状态投影 | `components/task-workbench/task-workbench-deliver-state.ts` | 六个验收状态（外加第七种 `has-evidence`）从既有字段推出；输出一个动作描述符（`none` / `deliver` enabled / `deliver` disabled + reason / `open-terminal`）；选目标时排除主检出与 folder workspace，不新增存储 |
| 会话标记 | `components/task-workbench/task-workbench-deliver-session.ts` | `TASK_WORKBENCH_DELIVER_SESSION_LABEL = 'DELIVER'` 与精确匹配；投影和启动器共用这一处 |
| 启动路径 | `lib/task-workbench/task-workbench-deliver-launch.ts` | `buildTaskWorkbenchDeliverInstruction` + `launchTaskWorkbenchDeliver` + `findTaskWorkbenchDeliverTabId` / `revealTaskWorkbenchDeliverTab`；指令对三种 mode 都强制 PR，无法遵守就 stop/report；复用 `resolveDefaultAgentForNewTab` / `launchAgentInNewTab`，启动前同步重查 marker；两个宿主共用导出的 `TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE` |
| 确认面 | `components/task-workbench/task-workbench-deliver-confirm.tsx` | 唯一确认组件：目标分支 / 集成方式 / 交付后归档 + 政策句 + 归档提示 + 可选 `注意`；无模态、submit `outline` |
| 事实行入口 | `components/task-workbench/TaskWorkbenchDelivery.tsx` | 行右端 `DeliverEntry`；`delivery === undefined` 与有证据两个分支都渲染；唯一启动点 `submitDeliver` 在提交时重新投影资格；name-only `DELIVER` 无 marker 时 reveal 失败后回确认面。`读取证据` 控件仍是 `Not wired`（P1b） |
| 视图字段 | `components/task-workbench/task-workbench-view.ts`、`hooks/use-task-workbench-view.ts` | additive 可选字段 `targetBranchDefault?`（主工作区分支，去 `refs/heads/`；detached 则 absent）与 `TaskWorkbenchWorkspace.isMainWorktree?`（既有 store 事实，供投影排除主检出） |
| sidebar 入口 | `components/sidebar/WorktreeContextMenuView.tsx`、`use-worktree-context-menu-model.tsx`、`WorktreeContextMenuOverlays.tsx`、`worktree-context-menu-deliver.ts` | `交付…` 在 `归档` 之上；已有会话同位置显示 `打开终端`；同一投影、确认组件、启动函数（`source: 'sidebar'`）；禁用 item 可聚焦但阻止激活；提交时用最新 row/worktree 重新投影资格 |
| 文案 | 六个 `i18n/locales/*.json` | 冻结的 18 个 `TaskWorkbenchDeliver.*` + `sidebar.WorktreeContextMenu.deliver`；zh/en 词级，es/fr/ja/ko 本轮为英文回退（§7.4.3 口径，见 §7.11.6） |

冻结 test id（两个入口共用）：`task-workbench-deliver-action`、`worktree-context-menu-deliver`、
`task-workbench-deliver-confirm`、`task-workbench-deliver-target-branch`、`task-workbench-deliver-integration`、
`task-workbench-deliver-archive-after`、`task-workbench-deliver-submit`、`task-workbench-deliver-cancel`。
组件另有四个只服务自身断言的 id（`task-workbench-deliver-close`、
`task-workbench-deliver-target-branch-default`、`task-workbench-deliver-target-branch-required`、
`task-workbench-deliver-confirm-attention`），不在冻结表内。

**D2（会话判据）**：`DELIVER` 会话用**既有字段** `quickCommandLabel` 标记
（`task-workbench-deliver-session.ts`），再经 `shared/agent-row-conversation-name.ts` 解析进
`DashboardCard.conversationName`，工作台从自己的 agent 行读回。三个必须成立的条件与证据：

| 条件 | 结论 | 证据（file:line / 测试） |
| --- | --- | --- |
| 重载后仍在 | 成立 | 写入 `store/terminals/terminal-tab-creation.ts:97,126` 并原子发布 unified tab（`:203-205`）；持久化 `lib/workspace-session-unified-tabs.ts:91,96`；schema `shared/workspace-session-schema.ts:99,149`；读回 `store/slices/tabs-hydration.ts:90-94,109-116`、`terminal-session-row-hydration.ts:143-145,203-208`。测试：`task-workbench-deliver-launch.test.ts` › *(a) quickCommandLabel survives persist, schema parse and hydration* |
| 能从工作台自己的行数据读到 | 在终端路由上成立；另两条路由有界（见 §7.11.6） | 启动把 label 交给 `createTab`（`lib/launch-agent-in-new-tab.ts:303`）；`DashboardCard.conversationName = rowConversationName(...)`（`components/dashboard/build-dashboard-snapshot.ts:262-269` → `dashboard-card-labels.ts:52` → `shared/agent-row-conversation-name.ts:130-133`）；投影读同字段（`task-workbench-deliver-state.ts:187-193`）。测试：› *(b) the row conversation name resolves the marker, and a rename outranks it* |
| 第二次激活不会再建一个会话 | 成立（终端路由） | 投影先给 `open-terminal`（`task-workbench-deliver-state.ts:187-193`）；启动器再同步重查 live store（`task-workbench-deliver-launch.ts:173-175`，unified tabs 优先、legacy rows 兜底 `:137-144`）。测试：› *does not launch when a marker tab already exists (zero calls)*、› *launches exactly once across two activations, because the first publish is synchronous*、› *also finds a marker on a legacy terminal row* |

第二条的边界不是空话：`structured-native-chat` 路由与 `host-published` 路由都不携带
`quickCommandLabel`，因此在那两条路由上「已有会话」读不出来，第二次激活会再次启动；这正是
§7.11.6 记录的两个 bound，不是把成立条件悄悄放宽。

**D3（分层）**：本切片的生产实现只改 `orca/` 的 renderer 代码 + 六语 i18n；验证与设计证据另列在下。启动链路全在 renderer
（`lib/launch-agent-in-new-tab.ts`、`lib/agent-tab-shortcuts.ts`、store 的 `createTab`），
`quickCommandLabel` 是既有 tab 字段；因此**不需要任何 main / preload 改动**，也没有新增 IPC、
持久化或 schema。本切片的生产代码、相邻单测与六语 i18n 在 `orca/src/renderer/`；fixture 渲染
harness 还改了 `orca/tests/tools/task-workbench-rendered/`，设计记录与六张 PNG 在
`swarm/docs/design/task-workbench/`。这是完整的落地面，不把 harness 或证据文件排除在 diff 之外。

#### 7.11.6 证据缺口

**已知边界（实现接受了它们，而不是修掉了它们）**：

1. ~~`structured-native-chat` 路由（三个实验开关全开）创建 provisional tab 时不写 `quickCommandLabel`~~
   **§7.12 S5 已关闭**：`openStructuredAgentSessionProvisionalTab` 现在把标记交给 `createUnifiedTab`。
2. ~~`host-published`（web-runtime / paired）启动没有 `quickCommandLabel` 参数~~
   **§7.12 S5 已收窄**：启动参数把标记带到运行时的创建请求，由 `setTabQuickCommandLabel` 写到镜像的本地
   tab 行；host wire 仍无此字段，所以对端设备/重连后的 host 快照读不到它。该路由上
   `launchTaskWorkbenchDeliver` 仍返回 `ok: true, tabId: ''`，调用方必须把空 id 当作「本地没有可 reveal 的 tab」。
3. 空启动计划被报成 `no-agent`：没有会话被启动，冻结的结果类型没有单独的 reason。
4. 用户重命名交付 tab 后，投影（读 `conversationName`，`customTitle` 优先）会显示 `[ 交付… ]`，而启动器
   仍回答 `already-delivering`。这是 D2 写明的 reopen condition，不是可以掩盖的缺陷。反方向的 name-only
   collision 已做可恢复处理：普通 tab 只有 `customTitle = 'DELIVER'` 时，两个宿主 reveal 失败后回到确认面；
   提交再由 marker-aware launcher 决定 reveal 真实会话或启动新会话。
5. `注意` 行在 `DeliveryEvidence` 里**没有来源**：`DeliveryEvidence` 只有 commits / PR / checks / review，
   所以 `attention` 在每个状态下都是 `[]`，界面上这一行今天不出现——这是正确的不猜；只证明了它永不拦截
   （confirm 只在非空时渲染，且不 disabled / 不 gate）。要真正显示它，需要未来给证据模型加字段，不是在这里猜一句。

**证据层级与未验证项**：

- **六张 fixture 渲染图**是本节指名的证据，由
  `cd orca && ORCA_BACKGROUND_LAUNCH=1 DISPLAY=:99 node tests/tools/task-workbench-rendered/run.mjs --all`
  产出，视口 **1440×900**、`devicePixelRatio = 1`：
  `ui/impl-20261119-deliver-no-workspace.png`、`ui/impl-20261119-deliver-archived.png`、
  `ui/impl-20261119-deliver-one-writer.png`、`ui/impl-20261119-deliver-existing-session.png`、
  `ui/impl-20261119-deliver-evidence-not-read.png`、`ui/impl-20261119-deliver-zero-evidence.png`。
  它们是 **fixture 渲染，不是真机截图**（与 §7.4.5 同一证据层级）：只经过 fixture → 生产组件，
  不经过 live store / selector / RPC / 持久化，也不切 locale（harness 用英文默认值）。
- **打开的确认面没有被截图证明**：harness 没有点击路径，popover 自身的渲染由
  `task-workbench-deliver-confirm.test.tsx` / `TaskWorkbenchDelivery.deliver.test.tsx` 的 vitest 证明，
  不是真机截图。
- **没有真机核对真实启动**：没有任何真实 agent 被这条链路在本轮启动过；`launchAgentInNewTab` 带初始 prompt
  在远端 checkout / SSH 工作区上的行为、以及真实 agent CLI 的 ready 判定，均未验证。
- **fixture 产生不出的状态**：`structured-native-chat` 与 `host-published` 两条路由（上面 bound 1/2）、
  用户重命名后的投影/启动器分歧（bound 4）、以及任何依赖 live store 时序的竞态（例如渲染与点击之间出现
  第二个会话）都不在六张图里；`注意` 行也因没有来源而无法用 fixture 产出。
- 未核对 `v1.4.219` 之后上游是否已有同类交付入口（本仓库为快照）。
- `ui/` 里只有 `design-deliver-*` 这组设计稿带源文件；2026-11-18 那批 `design-workbench-*.png` 没有提交
  源文件，因此**不可复现**，只能作为当时的观察结果读，不能当作当前版面的定义。2026-11-19 的六张
  `impl-20261119-deliver-*.png` 是 harness 产物（命令见上），不是设计稿。
- 六语的词级覆盖：zh/en 按冻结表；es/fr/ja/ko 的 19 个新键本轮写的是**英文回退**（`Deliver…` 等），
  不是已核对的翻译，因此不能说「六种语言都完成了这组文案」。纯模板 `confirmHeading` 六语都保留
  `{{value0}}`，没有额外粘连词。
- `en-runtime-required.json` 在本切片前已缺 23 个 `TaskWorkbenchHistory.*` 动态键（issue #31 遗留，
  与本切片无关）；本切片只补了自己的 18 个 `TaskWorkbenchDeliver.*`，所以
  `verify-localization-catalogs.mjs` 仍为红。`--fix` 生成器会在 `integrationMode` 的「标签 + 子键」
  形状上抛 `TypeError`，这 18 个是手写进同一文件的。
- `WorktreeContextMenu.copy-worktree-name.test.tsx` 的既有 store mock 没有 `folderWorkspaces`，因此
  仍有 2 个用例在 `use-worktree-context-menu-model.tsx` 读 `.find` 时失败；该文件与失败行都不在本切片。

---

### 7.12 交付完成：合并 / 关 issue / 状态化（2026-11-20，已实现）

§7.11 的交付入口只有起点没有终点：它开一个 agent 就结束，不合并、不关 issue、不写状态，
界面也读不出交付证据（`deliveryByWorktree` 恒为 `undefined`）。§7.12 补的是终点，方案与验收口径
在 [delivery-completion-plan.md](delivery-completion-plan.md)，本节记结论、落地清单与证据缺口。

![已交付：issue 详情 Orca tab](ui/design-deliver-20261120-complete.png)

三条结论：

1. **完成事实不新增存储**：交付 agent 用既有 `orca worktree set --workspace-status completed`
   写入完成状态（`cli/specs/core.ts:158-181`），工作区行已能渲染该标签（`TaskWorkbenchWorkspaces.tsx:155`）；
   勾选归档时，归档是它之后的一步。
2. **「已交付」是投影而不是新词**：`workspaceStatusId === 'completed'` ∧ `review.state === 'merged'`；
   issue 关闭只作事实项（本地任务没有 tracker，PR 页的 tracker 指的是 PR 自己），无证据仍是 `未读取`。
3. **勾选「完成后归档」时归档由交付 agent 自己执行**（先报告、后归档，issue #49）：
   原先由 Orca 在观察到完成事实后执行的内存意图已删除——它只挂在 issue 详情 Orca tab 上、重启即丢、
   从 sidebar 发起的交付根本没有消费者，等于勾了不生效。未勾选时 agent 仍不归档。

本方案同时关闭 §7.11.6 的 bound 1/2（结构化与 host-published 路由补 `quickCommandLabel`），
保留 bound 3/4/5。设计稿三张（已交付 / 确认面 / 交付行五态）见
[delivery-completion-plan.md](delivery-completion-plan.md)；
它们与 §7.11.2 同层，是 HTML/CSS 渲染稿，不是生产组件渲染，也不是真机截图。

#### 7.12.1 落地清单（分支 `feat-task-workbench-pr-issue-7.12`）

| 片 | 改动 | 位置 |
| --- | --- | --- |
| S1 投影 | 新增 `completed`（已交付）状态、`facts`（PR 事实 + issue 事实）、`open-session` 动作；判定 = `workspaceStatusId === 'completed'` ∧ `review.state === 'merged'`；`DeliveryEvidence.commits` 改为可选，`pullRequest.title/url` 改为可选（无来源即整项不渲染） | `task-workbench-deliver-state.ts`、`task-workbench-view.ts` |
| S2 指令 | 六阶段指令：读 skill → 验证/评审 → 经 PR 集成 →（勾选）合并（`gh pr merge`）→（勾选）关 issue（`gh issue close <n>`）→ 标记 `workspace-status completed` → 三段报告；未勾选的动作明确要求 stop 并写「未授权」；勾选归档时追加第 8 步 `orca worktree archive`（排在报告之后，失败只报告、不重试），未勾选时不含任何归档动作；`--force` / 改分支保护 / stash-reset-clean 全部禁止 | `lib/task-workbench/task-workbench-deliver-launch.ts` |
| S2 确认面 | 新增「交付范围」：创建 PR（固定勾选、禁用）/ 合并 PR（默认开）/ 关闭 issue #n（有编号时默认开，无编号禁用并说明）/ 完成后归档（默认关）。提交值新增 `mergePullRequest` / `closeIssue` | `task-workbench-deliver-confirm.tsx`、六个 `locales/*.json` |
| S3 证据接线 | 每个工作区自己的 `review`（number + state）成为唯一的 PR 证据来源，经 `deliveryByWorktree` 进入 join；tracker 增加可选 `number`（只从 issue 页取，PR 页不冒充 issue）；交付行渲染状态签 + 事实项 | `hooks/use-task-workbench-view.ts`、`TaskWorkbenchDelivery.tsx`、`github-item-dialog-orca-tab.tsx` |
| S4 归档执行 | **issue #49 已改**：勾选归档时由交付 agent 在报告后自己执行 `orca worktree archive --worktree <self> --json`（失败只写进报告），renderer 侧的意图集合与观察 hook 已删除；未勾选时 agent 不归档，人仍可从工作区行一键归档 | `lib/task-workbench/task-workbench-deliver-launch.ts`（指令）；已删除 `lib/task-workbench/task-workbench-deliver-archive-intent.ts`、`hooks/use-task-workbench-deliver-archive.ts` |
| S5 路由标记 | 结构化 provisional tab 携带 `quickCommandLabel`；host-published 路由把标记写到镜像的本地 tab 行（host wire 无此字段，见缺口），并在 host RPC 期间用 20s 的 in-flight 窗口挡住同一 tick 的第二次点击 | `structured-agent-session-provisional-tab.ts`、`launch-agent-in-new-tab-structured.ts`、`launch-agent-web-host-tab.ts`、`web-runtime-terminal-create-operation.ts`、store 的 `setTabQuickCommandLabel` |

没有新增 storage domain、RPC/IPC 或 schema：完成事实走既有 `orca worktree set --workspace-status completed`，
归档走既有工作区元数据写入，交付标记走既有 `quickCommandLabel` 字段。

#### 7.12.2 证据与缺口

**渲染证据（本次新增，html/CSS 设计稿之外的第一层真实组件渲染）**：

![已交付：宽屏](ui/impl-20261120-delivered.png)
![已交付：窄屏](ui/impl-20261120-delivered-narrow.png)
![已交付后归档](ui/impl-20261120-delivered-archived.png)
![确认面：交付范围](ui/impl-20261120-deliver-confirm.png)

命令（本机 `DISPLAY=:99`，Electron 隐藏窗口 + CDP 截图）：

```bash
cd orca
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --fixture f15_delivered --width 1440 --height 900
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --fixture f15_delivered --width 900 --height 700
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --fixture f16_delivered_archived --width 1440 --height 900
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --fixture deliver_confirm --width 720 --height 660
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/task-workbench-rendered/run.mjs --all   # 26/26 passed
```

新增两个 fixture（`f15_delivered` = completed ∧ merged + 关闭的 issue；`f16_delivered_archived` = 上述事实的归档形态）
与一个直接渲染 `TaskWorkbenchDeliverConfirm` 的 `deliver_confirm` fixture；驱动按投影断言状态签的
`data-state`/文字、事实行文本、四条勾选项的选中/禁用、`outline` 提交与「无 dialog / 无 aria-modal」。
渲染结果已核对：宽屏交付行显示 `Delivered · Issue #412 closed · 3 commits · PR #431 merged · checks 6/6` +
`Open session`，工作区行显示 `● Done`；归档形态显示 `Archived` 且入口消失；确认面显示「交付范围」四项，
创建 PR 固定勾选且禁用、合并/关 #412 默认勾选、归档默认不勾。

**单测已执行**（`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <路径> --maxWorkers=2`）：
`src/renderer/src/components/task-workbench`、`src/renderer/src/lib/task-workbench`、
`src/renderer/src/hooks/use-task-workbench-view.test.tsx`、
`src/renderer/src/hooks/use-task-workbench-deliver-archive.test.tsx`（该文件已在 issue #49 中删除，见 §7.12.3）、
`src/renderer/src/components/sidebar/WorktreeContextMenu.deliver-order.test.tsx`、
`src/renderer/src/components/github-item-dialog`、`src/renderer/src/lib/launch-agent-in-new-tab.test.ts`、
两个新 marker 用例、`src/renderer/src/store/slices/tabs*`、
`src/renderer/src/runtime/web-runtime-terminal-creation*`、`src/renderer/src/runtime/web-session-tabs-sync`
（21 个文件 / 354 个用例，另有 store tabs 与 web-session-sync 批 51 文件 / 425 用例）。
`tsc --noEmit -p config/tsconfig.web.json` 通过；`verify-localization-catalogs.mjs` 退出 0（13 个新键手写进
`en-runtime-required.json`，因为 `sync:localization-runtime-catalog --fix` 仍在 `integrationMode` 的
「标签 + 子键」形状上抛 `TypeError`，见 §7.11.6）。全量 vitest 未跑。

**没有证明的事**：

- 没有一次真实交付演练：`gh pr merge` / `gh issue close` 的权限、分支保护、目标分支 HEAD 核验、
  agent 实际按六阶段执行，全部只有单测（A1/A9 的「真机手工」条目未做，属单独授权动作）。
- host-published 路由的标记只写在本客户端的镜像 tab 行上；host wire 仍不携带它，因此另一端
  （另一台设备或重连后的 host 快照）读不到这个标记。这条是「把 bound 2 修到可用」而不是「修到对端可见」。
  in-flight 窗口（20s）只挡住 window 内的重复点击；超时后若 host 仍未回镜像，第二次点击仍会再启动一次。
- S4 的归档意图不跨应用重启；重启后只有工作区行的一键归档，界面上没有「曾经想要自动归档」的提示。
  **issue #49 已把这个缺口连同实现一起删除**（见 §7.12.3）：现在归档由交付 agent 自己在报告后执行。
- item 详情缓存未在关闭 issue 后主动失效（计划 S3 的一项）：页面刷新/重开才会读到新状态。
- 渲染图是 **fixture → 生产组件** 的证据（与 §7.11.6 同层），不经过 live store / selector / RPC / 持久化，也不切 locale；
  它证明不了真实 `gh pr merge`/`gh issue close`、真实归档 hook、真实 agent 的第一条消息，也不能替代 A1/A9 的真机演练。
- `ui/design-deliver-20261120-*.png` 仍是 HTML/CSS 设计稿；本次新增的是 `ui/impl-20261120-*.png`（真实组件渲染）。
- es/fr/ja/ko 本轮新增文案是英文回退，未做词级翻译。
- oxlint 的 `max-lines` 在四个被本切片触及的文件上仍是红的（括号内为工作树 HEAD 上的实测值 → 现在）：
  `hooks/use-task-workbench-view.ts`（330→331）、`lib/launch-agent-in-new-tab.ts`（317→319）、
  `runtime/web-runtime-terminal-create-operation.ts`（303→311）、
  `tests/tools/task-workbench-rendered/run.mjs`（888→1121，渲染驱动新增了交付行/确认面的断言）。
  它们在本切片前就超预算，本切片没有顺手拆文件；拆它们属于独立的重构。
  `WorktreeContextMenu.copy-worktree-name.test.tsx` 的 2 个用例仍因既有 store mock 缺
  `folderWorkspaces` 失败（§7.11.6 已记录）。

#### 7.12.3 「交付后归档」改为交给交付 agent 执行（issue #49，2026-11-20）

§7.12 的 D2 把归档搬到了 renderer：勾选后记一个内存意图，由挂在 **issue 详情 → Orca tab** 的
`useTaskWorkbenchDeliverArchive` 在观察到 `completed` ∧ merged 后执行一次。实测（PR #48 那次交付）
勾了归档却没有归档：交付会话正常跑完、指令里的归档提醒也在，但意图只活在渲染进程内存里，
消费者只在那个弹窗挂着时存在，而 agent 跑完时弹窗早已关闭；从 sidebar 发起的交付更是**没有任何消费者**。
结论是“勾了等于没勾，且丢弃时无提示”。

**改法**：删掉 renderer 侧意图与消费者，把归档写成指令自身的第 8 步——**先报告、后归档**：

| 片 | 改动 | 位置 |
| --- | --- | --- |
| 指令 | `archiveAfter=true` 时在报告段之后追加第 8 步：`orca worktree archive --worktree <self> --json`；归档失败只写进报告，不重试、不判交付失败；`archiveAfter=false` 保持原有“不归档、由人点”的句子 | `lib/task-workbench/task-workbench-deliver-launch.ts` |
| 删除 | 意图集合、观察 hook、Orca tab 挂载点、启动时的 `recordTaskWorkbenchArchiveIntent`、`TaskWorkbenchDelivery.archiveFailed` 文案与 import-boundary 条目 | 已删 `lib/task-workbench/task-workbench-deliver-archive-intent.ts`、`hooks/use-task-workbench-deliver-archive.ts`（及其测试）；`components/github-item-dialog/open-dialog/github-item-dialog-orca-tab.tsx`、六个 `locales/*.json`、`en-runtime-required.json`、`task-workbench-import-boundary.test.ts` |
| 文案 | 勾选提示改为“交付 agent 会在报告后自行归档，可在 Show archived 找回” | `task-workbench-deliver-confirm.tsx` 的 `archiveAfterHint` + 七个目录文件 |

副作用：两个交付入口（事实行、sidebar 右键）共用同一个启动函数，所以 sidebar 入口
“勾了也无效”的缺口同一次改动一起消失。边界没变：archive 接口本身、`scripts.archive` hook、
`worktree rm`、持久化字段都不动；“归档”仍不是交付完成信号（完成事实仍是 `workspace-status completed`
∧ merged review）。

**验收映射**（以下 A 编号是 issue #49 的，不是 plan §8 的）：A1/A2/A3 = 改写后的 `task-workbench-deliver-launch.test.ts`（归档命令行出现在报告段之后；
未勾选不含任何归档命令；失败只提示、不重试、不判失败）；A5 = sidebar 用例断言勾选后 `archiveAfter: true`
真的交给共享启动函数，启动函数用例断言它就是交给 agent 的 prompt 里的那一行；A6 = 四个反向 pin 改写后
单测全绿（已跑，见下）；A4 需真机：归档后工作区行消失、`worktree unarchive` 能恢复、PTY 不被杀。

**只读评审**（codex-ark，`codex exec -s read-only`，2026-11-20，HEAD `a1dbb15b`）：结论“通过，无必修项”，
4 条建议已全部处理——“`<self>` 不是 CLI 别名，指令必须明说替换成完整 `id:<repoId>::<path>`”（已写进指令）；
`worktree-delivery` SKILL §5 的通用“先归档后报告”加了 Task Workbench 限定；
sidebar 勾选透传缺回归用例（已补两条）；README 的 A4/A6 编号与两处“最后一步”措辞（已改）。
原文归档在 [review-codex-ark-issue-49.md](review-codex-ark-issue-49.md)（路径已换为仓库相对形式，其余未改写）。

**已执行**（`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts … --maxWorkers=2`）：
`src/renderer/src/lib/task-workbench`、`src/renderer/src/components/task-workbench`、
`src/renderer/src/components/github-item-dialog`、`src/renderer/src/components/sidebar/WorktreeContextMenu.deliver-order.test.tsx`、
`src/renderer/src/hooks/use-task-workbench-view.test.tsx`、`src/renderer/src/i18n/runtime-required-catalog.test.ts`
（21 个文件 / 382 个用例，全绿）。`tsc --noEmit -p config/tsconfig.tc.web.json` 退出 0；
`verify-localization-catalogs.mjs` 退出 0。渲染驱动与真机交付未重跑。

**仍未证明**：没有一次“勾选归档 → agent 真的执行 → 行消失 → Restore 恢复”的真机演练；
归档现在依赖交付会话按指令走到第 8 步，agent 中途停止或被 kill 时工作区仍保留（可人工归档，与之前一致）。

---

## 8. 关系怎么存：持久化设计

上一版只说了"渲染层投影"，没有回答关系存哪。这一节补齐，并明确**哪些关系不该存**。

### 8.1 现在这些关系实际存在哪里（事实）

| 关系 | 载体 | 写入者 | 生命周期 / GC | 性质 |
| --- | --- | --- | --- | --- |
| 工作区 → 任务（来源） | `WorktreeMeta` 上的 `linkedIssue` / `linkedLinearIssue` / `linkedGitLabMR` / `linkedGitLabIssue` / `linkedWorkItem` / `linkedTaskSourceContext` | main（创建时与用户编辑） | 随 `worktreeMeta` 行；`gcStaleWorktreeMeta` 只在本地宿主、路径不存在且 30 天不活跃时删除 | 权威 |
| 工作区 → 固定基线 | `WorktreeMeta.sparseTaskBinding`（含自摘要，严格读取） | 创建回执（M5） | 同上 | 权威 |
| 工作区 → 宿主/实例身份 | `worktreeMeta` + `worktreeMetaByIdentity` + `worktreeIdentityAliases`；路径改名留 `priorWorktreeIds` | main | 同上；别名随身份行清理 | 权威 |
| 工作区 → 任务（删除后） | `taskRecords`：profile-state 顶层 JSON（`recordsVersion` / `byId` / `externalIndex`），每条记录含 origin、bindings（含已结算用量与 session 引用） | main（`setWorktreeMeta` / `setWorktreeMetaForHost` 写入绑定，`removeWorktreeMeta` 前结算） | 只增不删：工作区消失只影响读取时的 presence 投影，不删记录；单任务 ≤64 绑定、单记录 ≤8 KiB、domain ≤8 MiB | 权威（身份 + 用户意图 + 结算快照，不含运行态） |
| 工作区 → 任务（旧账本） | `taskRunHistory`（legacy） | 无（已停止写入） | 只在无 `taskRecords` 时被一次性迁移；原键保留供降级读取 | 历史输入 |
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

### 8.10 P4 已落地切片（issue #36，2026-11-19）

实现分支：`feat-task-workbench-p4-taskrecords`。范围是**数据侧**：domain、写入时机、结算、读取投影与降级。
不是完整的 M2b（动作层与对账见下表"未做"）。

已落地：

| 项 | 落点 | 规则 |
| --- | --- | --- |
| domain | `shared/task-records-types.ts`、`shared/task-records.ts`、`shared/task-records-normalize.ts` | 顶层 `{ recordsVersion: 1, byId, externalIndex }`；**不加 DDL、不 bump `PROFILE_STATE_DATABASE_SCHEMA_VERSION`**；`schemaVersion` 逐条比较，更新的记录不加载 |
| 失败关闭 | `isReadableTaskRecords` + `persistence/loading-store/task-records-persistence.ts` | 未知 `recordsVersion`：加载时**保留原 payload 原样**（条件展开，不覆盖），所有写入直接返回；损坏的单条记录丢弃并计数，其余照常加载 |
| 身份 | `taskRecordTaskId` | `task:<provider>:<repoId>:<itemType>:<number>`；`repoId` 已是"某一主机上的一次仓库登记"，故键不含 `hostId`；含 `itemType`（issue #31 与 PR #31 是两个任务）与 `provider`（同仓库的 GitHub #31 与 Linear #31 也是两个任务）。不带 provider 的查询只在"恰有一个 provider 命中"时回答，命中多个返回 `null` |
| 绑定集合 | `shared/task-records-worktree-links.ts` + `task-records-metadata-hooks.ts` | 写点只有 `setWorktreeMeta` / `setWorktreeMetaForHost`（与元数据同一次写）；来源 `linkedWorkItem`（四 provider）+ GitHub `linkedIssue`/`linkedPR`；无任何链接的工作区成为 workspace-origin 任务 |
| 结算 | `main/task-records/task-records-worktree-usage.ts` + `task-records-persistence.ts` | 只在**工作区移除前**结算该 binding；读四个 `*UsageProjectBreakdown` 的 `worktree:<id>` 行；未启用 / 远端 / 无匹配行 → `unavailable`；任一 provider 未定价 → `estimatedCostUsd: null`；不强制重扫；结算抛错只记日志，不阻塞删除 |
| session | 同上 + `AgentHookProviderSessionIdentity.key` | 结算时从 hook 的 provider-session 快照取本工作区条目，`provider` 取 tab 的 `launchAgent`（只映射四个有 usage store 的 provider，其余保持"未知"）；没有 `key` 的条目不记录（不猜字段名） |
| 读取/降级 | `ipc/task-records.ts`、`hooks/use-task-records.ts`、`lib/task-workbench/task-workbench-history-merge.ts`、`TaskWorkbenchHistory.tsx` | `taskRecords:get` 只读、畸形查询返回 `null`；历史区补 `workspaces`（`Removed` / `Archived` 徽标、`未核验`）与 `sessions`（"无法继续：其工作区已被删除"），`settled` 标记结算值，未知仍是未知 |
| 旧账本迁移 | `persistence/loading-store/task-records-legacy-migration.ts` | 只有在**没有** `taskRecords` 时把 `taskRunHistory` 播种一次；deleted 行迁成 `lastVerifiedAt: null`（迁移不是核验证据）；旧键保留不删 |

与 §8.3 草案的偏离（有意，写在这里而不是悄悄改）：

1. `usageSettlement` 落在 **binding** 上而不是 record 上。计划 §M2b C 要求"只结算被移除 binding 对应的工作区
   聚合"，两条 binding 先后被移除会产生两份快照；record 级单字段只能保住最后一份。
2. `totalTokens` 不是字段，而是 `kind: 'known'` 的 `providers[]` 求和（`taskUsageSettlementTokens`）。草案里
   `totalTokens: number` 会在 unavailable 时逼出一个 `0`，与"未知不记 0"冲突。
3. 单记录上限取 **32 KiB** 而不是表里的 8 KiB：同表又要求单任务 ≤64 个绑定，而一个绑定
   （worktreeId / repoId / host / path / 时间戳）就有 150–250 B，8 KiB 装不下自己的 64 条，两条规则不可能同时成立。
   32 KiB 让两条规则都可达，domain 的 8 MiB 仍是最外层闸门。写入与加载共用同一组界限
   （`grown()` 校验 record + domain；session 合并与结算写同一路径），所以"写成功、重载丢弃"不会发生。
4. 结算按**provider 的 worktree 汇总行**累加，不做会话级去重：会话级归因本身尚未成立（§8.4 与开发计划
   §1 的非目标），能证明的只有"该 provider 在该 worktree 下的汇总"。同一 `sessionId` 被两个 provider
   声明时的歧义规则只作用在逐 Agent 的归因路径（`task-workbench-session-totals.ts`），不会被当成任务级
   去重证据；这一点在 §8.4 的"不存会话明细"下仍然成立。

降级与非对称升级（评审补充）：

- `taskRecords` 的 preload 接口**不是 additive**：`window.api.taskRecords` 替换了 `window.api.taskRunHistory`。
  桌面端 renderer/preload/main 同进程同版本发布，因此不保留旧调用方；跨版本只保证**存储**兼容
  （旧 build 读到 `taskRecords` 会原样保留，见 §8.6）。
- hook 只在查询身份或**该仓库的工作区列表**变化时重读记录；纯 domain 写（例如未来"显式重新结算"）不会推送，
  需要重挂载才可见。这是当前唯一的刷新缺口，写在这里而不是让面板假装实时。

未做（明确不在本切片，也没有第二个写者）：

- 动作层：`归入任务 / 从任务移除 / 改 primary / 归档任务 / 显式重新结算` 的 IPC 意图与 renderer 入口；
  因此 `intent` 目前只有读侧语义，revision CAS 重试也没有调用方（写点走既有 `scheduleSave`）。
- 启动对账（§8.7 / §M2b D）：本切片只在**读取时**把 binding 与当前工作区列表比对（存在性投影），
  不写 `lastVerifiedAt`。理由：一次未加载完的工作区扫描不能作为"未解析"的证据，写下去会把临时缺页固化成事实。
- 别名/改名解析（`priorWorktreeIds` / `worktreeIdentityAliases`）与 GC 解耦的显式用例。
- M2a 的旧 build round-trip 实测（§8.9-1）与 domain 体量基线（§8.9-7）。

评审回执：codex-ark 对修复前版本（分支第一个提交 `c7d77fbd`，修复后已 amend）的只读评审原文见
[review-codex-ark-issue-36.md](review-codex-ark-issue-36.md)（结论"需要返工"）。已修的处理：

| 评审结论 | 处理 |
| --- | --- |
| 写入端允许超过单记录上限，加载端会丢弃整条 → 重启丢历史 | `grown()` 同时校验单记录与 domain；session 合并与结算写共用该路径；超过 per-binding session 上限改为可报告的 `dropped`，不静默截断 |
| 旧账本迁移先读原始 payload，畸形输入会让 profile 加载抛错 | 先在 `normalize-loaded-profile-state.ts` 归一化旧账本再迁移；迁移本身也做数组守卫；补 `{records:[null]}` 用例 |
| `origin.providerIdentity` 与 domain 级未知字段重载后丢失 | 归一化保留 `providerIdentity`（经 `normalizeTaskProviderIdentity`）与 domain 顶层扩展字段；补往返用例 |
| `taskId` 不含 provider，GitHub #31 与 Linear #31 合并成一条 | 身份键加入 provider；不带 provider 的查询只在单一命中时回答 |
| 存活 + 已删除混合时把"仅已删除部分"当成 `Total: every run` | 两侧都已知才相加，否则整任务保持未知原因；补混合/未知用例 |
| 记录只在查询身份变化时读取，页面常驻看不到删除后的结算 | hook 增加 `revision`（该仓库工作区列表），删除/归档会触发重读；纯 domain 写仍是已知缺口（见上） |
| 用"本任务匹配集合"当作"工作区是否存在"，改绑后被误标 `Removed` | 存在性改用整仓库工作区列表；列表未加载（`undefined`）时不投影，保留 join 的答案 |
| session 列表 key 不含 provider，可重复 | key 改为 `provider|key:id` |
| 结算未做会话级去重（歧义） | 按第 4 条偏离写入边界；不伪造去重 |

---

## 9. 分期与验收

### 9.0 路标（UI 优先，2026-11-16）

三段，每段结束时都有一屏可演示的东西；每段都可单独回滚。这个顺序把"UI 证据"放最前：两位评审都指出
"没有真机渲染"是最大返工源，而它也是成本最低的验证点。

| 路标 | 一句话 | 看得到什么 | 对应阶段 | 不做 |
| --- | --- | --- | --- | --- |
| **P1 工作台 UI**（**已实现**） | 先把"点开任务后的那一屏"做出来 | 详情页多一个 `Orca` tab：工作区、agent 行（带所属工作区）、token、用量三态、证据摘要 | M1；明细见 [P1a 计划](p1a-ui-shell-plan.md)。已落在 GitHub issue/PR；Linear/Jira/GitLab 未接 | 列表主轴、持久化 |
| **P3 列表主轴** | 让任务"排得开" | `Needs you / Working / Delivered(agent done)` 分组、`◇` 徽标、一任务多工作区 | M2b 的 renderer 部分 | 持久化 |
| **P4 持久化** | 让任务"记得住" | primary、归档、结算快照、意图层（目标/验收/授权） | M2a + M2b 的 main 部分 | 跨端 |

- P1 已走完 1a → 1b：1a 交组件 + fixture + 全部状态与降级（harness 截图），1b 接 `identity/join/usage`
  三件套与真实 store（`use-task-workbench-view`）。缺口是真机交互验收，见 §12。
- 旁路：T1（Agent 派生树）可随时独立合入；M3（交付证据聚合）留在 P3 之后；M4（跨端）单独授权。
- P3 的 `Delivered` 已定为 **agent done**（D12，见 §7.2）；没有它 P3 无法开工。

下面的 M/T 表是**详细阶段与验收**（工作包粒度），路标只回答"先做哪个"；两者冲突时以路标定顺序、
以详细阶段定退出条件。

| 阶段 | 范围 | 明确不做 | 验收 |
| --- | --- | --- | --- |
| **M0 决策冻结** | 定 §6 的 D1–D6 与 `taskRecords` 字段表；不写代码 | — | 每条决策有结论或明确 `escalate-value-choice` |
| **M1 增量面板**（推荐先做） | 现有任务详情加 `Orca` tab，定位为**任务聚合视图**（§6.2，不承诺任务对象）；GitHub issue/PR → Linear → Jira/GitLab；Agent 行（逐 Agent 只 token + 所属工作区）、用量三态、指向工作区的动作、0/1/N 工作区主操作规则。**零持久化**；selector 必须可被 M2 复用 | 列表主轴、移动端、远端用量、逐 Agent 金额、任务意图层（目标/验收/授权） | 对照覆盖 **Claude + Codex + OpenCode + Muse**：面板合计 == `projectBreakdown['worktree:<id>']`；歧义显示 `ambiguous`；未启用显示空态而非 0；`key` 解析有单测；文案不出现"已完成/验收通过" |
| **M2a 存储兼容验证** | 只读验证：指定旧 build 的新→旧→新 round-trip、`orca profile state` export/recovery 对未知 domain、备份恢复；产出判决 | 任何落盘 | 三项全绿才允许 M2b；否则范围收缩为 M1 |
| **M2b 列表主轴 + 落库** | 分组（按 §7.2 优先级，`◇` 为徽标）+ 一任务多工作区列表反查 + 新增 `taskRecords` domain（§8：记录、绑定、`externalIndex`、primary、对账、结算快照） | 跨 runtime 逻辑任务、多仓联合验收（设计文档 C 的剩余部分）、移动端 | 投影一致性；§8.9 存储专项 1–7 + 评审补充缺项全绿；1000 工作区规模下列表构建无逐行扫描 |
| **M3 交付证据聚合** | 任务级交付区：commits、PR/MR、checks、review 状态、`sparseTaskBinding` 证据 | — | 一个有 PR 与一个无 PR 的任务各有一份截图/断言；不可用状态不显示为 0 |
| **M4 跨端（可选，未估）** | 新只读 RPC（task usage/摘要）+ allowlist + 录制 golden + 移动端详情接入 | SSH 实时用量 | wire 兼容：旧客户端忽略新字段；`pnpm run verify:rpc-params-catalog` 通过；需单独授权 |

每阶段都必须：新文案进 locale catalog（`verify:localization-extraction` / `-coverage`）、
不新增 `components/ui/` 之外的样式、不触发 `max-lines` ratchet。

工作包、文件所有权、测试矩阵、回滚与阶段状态见[开发计划](development-plan.md)；本节只保留阶段划分。

**当前状态**：M1 已实现（仅 GitHub issue/PR，`Orca` tab）；M0 部分冻结（D1/D3/D5/D6 未定）；
M2a、M2b、M3、M4 未开始。

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
| 不可达残留（待清理） | `FolderWorkspace.taskDraft` 字段与其持久化/规范化、`app:getTaskDraftDirectory` IPC、`task-draft-archive-sweep`、侧栏草稿徽标与菜单、计数排除、渲染 harness 的 `d5_sidebar_draft_row` 仍在代码里，但 renderer 已无 `taskDraft: true` 生产者；删除属独立一刀，要动持久化与 RPC 校验 |
| CLI 契约（保留） | `orca github create-issue`（转发现有 `github.createIssue` RPC）与 `orca linear create` 已实现并保留，作为任何 agent 会话可用的建单动词；**不改 RPC catalog** |

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

- 本文的 UI 判断以代码阅读为主；P1a 有 `tests/tools/task-workbench-rendered` 的 harness 渲染证据，
  但**没有真机 CDP 截图**，`ui/design-workbench.png` 是设计图而不是实现截图。
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
- agent 行的卡片宽度参差 + token 贴列边已修（§7.4.1 限制第 2 条），修后只重跑了 f1/f3/f8 与两个降级尺寸，
  没有真机复核。
- P1 只有 harness 与单测证据：`tests/tools/task-workbench-rendered` 覆盖组件与降级态，`tc:web` 通过；
  **没有真机交互验收**（打开详情 → 切换 tab → 点 `[ Open workspace ]` / `[ resume ]` 的实际行为未实测），
  也没有 P1b 的独立评审回执。
- §7.2 的行内活动徽标（P3 前置薄切片）有 harness 的 CDP 截图（fixture `d6_github_task_rows`，G1/G2，
  见 `ui/impl-github-rows-badge-*.png`）与纯单测，但**没有真机验收**：没有用真实仓库/真实 agent 跑过，
  也没有实际点击行内徽标或 tracker pill。
- P1 只接了 GitHub issue/PR 详情；Linear / GitLab / Jira 的 `Orca` tab 未实现，因此"面板合计 ==
  `projectBreakdown['worktree:<id>']`"这条对照只在 GitHub 侧成立。
- §7.4.2 的两张目标形态图是 HTML/CSS 渲染的设计稿，不是生产组件渲染；该版面已在 §7.4.3 实现，返工后的
  真渲染与执行结果在 §7.4.5（8 张 `impl-20261118-*.png`、vitest 8/8 文件 149 用例、四个 tsc 项目、
  harness 17/17）。仍缺 **真机核对**（图是 fixture 渲染，不经过 store / selector / RPC，也不切 locale），
  以及 `verify:localization-coverage` 的两处既有红灯（`IncidentDetailDrawer` / `IncidentGrayTables`，与本次无关）。
- §7.11 的交付入口、六个验收状态与 `DELIVER` 判据已经实现；当前仍受证据约束的路由边界、真机启动、
  fixture 截图层级、locale 回退与两个既有红灯统一见 §7.11.6，本节不再重复旧状态。
- `orca github create-issue` 只在单测里被验证过转发；`gh` 备通道的存在性、登录态与 `--repo` 实际行为未验证
  （只影响 agent 侧建单能力）。

---

## 13. 下一步（需显式授权）

1. 定 §6 的 D1/D3/D5/D6（D4 已由 R1 定）。M1 已实现，不再需要"先做还是后做"的决定；
   要扩 `Orca` tab 到 Linear/Jira/GitLab 需单独授权。
2. P1 只读验证：在一个真实工作区跑两段不同 Agent，核对 `projectBreakdown['worktree:<id>']` 与
   AI Vault `totalTokens` 的一致性（只读，不改代码）；补一次真机交互验收。
3. 若要走 M2：先在测试 fixture 里验证 §8.9 第 1–3 条（未知 domain round-trip / revision CAS / 记录级迁移），
   再拆实施清单（具体文件、domain 名、字段、测试与门禁）。
4. 路标是 P1（已实现）→ P3（列表主轴）→ P4（持久化）。
5. agent 侧建单动词（`orca github create-issue`、`orca linear create`）与列表页无关，作为任何 agent 会话
   都可用的能力保留（§10）。
6. §7.11 的 D1–D3、`DELIVER` 判据与真实启动入口已经落地，不再是待决项；下一步只按 §7.11.6 补
   evidence-gated 验证（真机启动与两条 route bound 等）。任何 main / preload / wire 扩张仍需单独授权。
