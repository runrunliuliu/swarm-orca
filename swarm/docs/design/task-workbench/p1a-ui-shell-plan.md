# P1a 工作台 UI 静态壳：组件拆分、fixture 与截图清单

状态：**已实现（2026-11-18 复核：1a 与 1b 均已合入 main；本文保留为实施计划与 fixture/截图清单）**。
P1a 只做"能看、能评"的壳：不接真实数据、不建数据路径、不落库。
本文是 P1（README §9.0）的第一小步。v1 的评审结论与修正见 §0。

## 0. 评审修正（2026-11-16，R16–R21）

两位独立评审（codex-ark / trae）都给了"接受但需改"，并各自指出同一批事实问题。v2 的改动：

| # | 修正 | 依据 |
| --- | --- | --- |
| R16 | **不新增 DEV 预览入口**。预览与截图走仓库既有的 rendered-harness 模式（`orca/tests/tools/*-rendered/{fixture.tsx,index.html,run.mjs}`，CDP `Page.captureScreenshot`）。生产面为零，不需要 tree-shake 断言 | 评审 A 与 B 都指出 DEV 入口有残留/宽度不代表两层风险；探针确认既有 harness 存在（`tests/tools/omp-remote-sidebar-rendered/run.mjs`） |
| R17 | **view 类型收窄**：`taskKey` 自由字符串 → `TaskProviderIdentity \| { kind: 'workspace'; primaryWorktreeId }`；token 裸数字 → tagged union；workspace → `DashboardWorkspace` 全量；spend → 原因枚举 | 评审 A、B 同向；`shared/task-source-context.ts`、`shared/dashboard-snapshot.ts` |
| R18 | **agent 行不新造**：以 `DashboardCard` 为 base 的 renderer overlay（不改进 `shared/`），token/outcome/source 放 overlay；只有要进 popout / 移动端时才提升为 shared additive | A 主张 renderer 投影，B 主张 shared additive；取 A 的最小改动，并把提升条件写死 |
| R19 | **layout 输入补全**：`{ containerWidth, containerHeight, counts, mode }`；阈值 1100/480 只是设计假设，必须由截图校准；live 组件用 `ResizeObserver` 取容器宽度（CSS `@container` 在仓库已有先例，可后置） | 两位都指出阈值无代码依据；`src/renderer/src/assets/markdown-preview.css:229` 有 `@container` 先例 |
| R20 | **fixture 补 §7.5 缺口**：`ambiguous_session`、`no_matching_session`、1 工作区 0 agent、混合计价（一个有价一个未定价）、0 工作区 tracker open/closed | B 逐条列出，A 独立指出同类缺口 |
| R21 | **估时拆开**：P1a 单独 1.5–2 天；1b（接真实 selector）另估。截图 harness 与阈值校准是最可能超时的两块 | 两位都认为 2–4 天含 1b 偏乐观 |

## 1. 范围与边界

| 做 | 不做 |
| --- | --- |
| 组件与布局、全部状态与降级规则 | 真实 selector（identity / join / usage） |
| fixture 数据 + rendered harness（`tests/tools/`，不发布生产） | `Orca` tab 的正式入口、列表主轴 |
| 文案全部走 locale catalog | 任何持久化、任何新 RPC |
| CDP 截图（宽 / 窄 / 矮 / 空态）与报告 JSON | 移动端 / 配对端 |

P1a 存在的唯一理由：2026-11-16 两轮评审把"图 B 没有真机渲染证据"列为最大返工源。先用 fixture 把布局与
降级钉死，再接线；接线阶段不再改版式。

## 2. 组件拆分（8 个组件 + 4 个模块 + 1 个 harness）

全部落 `orca/src/renderer/src/components/task-workbench/`，只读 `view`，不 import store / RPC。

| 条目 | 职责 | 依赖 / 复用 |
| --- | --- | --- |
| `TaskWorkbenchPanel.tsx` | 编排；**顶层空态（0 工作区）在这里** | 下面全部 |
| `TaskWorkbenchHeader.tsx` | 标题、provider/状态、base→branch、PR 缩略、0/1/N 主操作 | `components/ui/button` |
| `TaskWorkbenchAgents.tsx` | Active/Needs you 常显 + History 折叠；**子区空态（无历史/无 agent）在这里** | `DashboardAgentChildDisclosure`、`useAgentBucketCounts` |
| `TaskWorkbenchAgentRow.tsx` | 在 `DashboardAgentRow` 之上叠加 workspace pill / token / outcome 标注 | `DashboardAgentRow`、`AgentStateDot` |
| `TaskWorkbenchWorkspaces.tsx` | 0..N 卡 + `Create workspace` + default 标记 | `components/ui/card` |
| `TaskWorkbenchSpend.tsx` | 任务级 token/金额 + 原因枚举 badge + provider 明细 + unattributed | `components/ui/tooltip` |
| `TaskWorkbenchDelivery.tsx` | 折叠条：commits / PR / checks / review + `[expand]` | `components/ui/collapsible` |
| `task-workbench-view.ts` | 纯输入类型（§2.1） | 无 |
| `task-workbench-layout.ts` | 纯函数：`(input) → 决策`（单/双列、折叠集合） | 无（单测） |
| `task-workbench-usage-status.ts` | 用量状态词汇：`available / disabled / unpriced / ambiguous_session / no_matching_session / remote_host / unattributed` | 复用 `automation-usage-summary` 语汇 |
| `task-workbench-row-projection.ts` | `DashboardCard` + overlay → 行视图（token / source / outcome / workspace pill） | 见 §2.1 |
| `task-workbench-fixtures.ts` | 12 组 fixture（§3），**只被 harness 引用** | 无 |

约定：一个区一个文件；`TaskWorkbenchPanel.tsx` 只编排不写业务判断；空态归属见上表（顶层 vs 子区），
不许两个组件各写一份。

**2026-11-18 后记（issue #26，见 README §7.4.3）**：上表的 `TaskWorkbenchHeader.tsx` 已删除——嵌在详情页的
M1 不需要工作台再自报一次身份；新增 `TaskWorkbenchFacts.tsx`（用量 + 交付共用一条 fact 带）与
`task-workbench-section-heading.tsx`（统一的 `名称 + 计数` 节标题）；`TaskWorkbenchAgentRow.tsx` 不再以
`AgentKanbanCard` 为底座，改为自画一行。本表其余条目不变。

## 2.1 输入形状（P1b 由 selector 填充，R17/R18）

```ts
type TaskWorkbenchView = {
  identity:
    | { kind: 'tracker'; provider: TaskProviderIdentity }      // 六维：provider/projectId/hostId/repoId/…
    | { kind: 'workspace'; primaryWorktreeId: string }          // 无 tracker 时
  title: string
  tracker?: { state: 'open' | 'closed'; url: string }
  defaultWorkspace: { workspaceId: string; source: 'explicit' | 'recent-activity' | 'none' }
  agents: AgentRowView[]              // Active / Needs you / History 三桶由投影层给
  workspaces: DashboardWorkspace[]    // 直接复用全量形状，不留白
  spend: SpendView                    // 见下
  delivery?: DeliveryEvidence         // 无则整区降级
}

type AgentRowView = {
  base: DashboardCard                 // 不改进 shared/：状态、model、时间都在这
  tokens: { kind: 'rollup'; tokens: number }
        | { kind: 'ai-vault'; tokens: number; caveat?: string }
        | { kind: 'unavailable'; reason: SpendReason }
  outcome?: 'success' | 'failure' | 'cancellation'   // D12：failure/cancellation ≠ Delivered
  workspaceLabel?: string             // 多工作区时必填
}

type SpendView =
  | { kind: 'available'; tokens: number; costUsd: number | null; byProvider: ProviderSpend[]; unattributedSessions: number }
  | { kind: 'unavailable'; reason: SpendReason }
```

规则：
- `tokens` **不许**是裸数字：来源与可用性跟着数字走，否则 P1b 接 AI Vault 与 usage rollup 两种来源时必然改类型。
- `defaultWorkspace.source` 必须显式：投影期没有 primary，不能把"最近活动"冒充成用户选择。
- `workspace` 直接用 `DashboardWorkspace`（`repoId/worktreeId/repoName/worktreeName/hostKind/executionHostId` 齐全），
  渲染时再挑字段；避免 P1b 为补齐六维反查而改类型。
- 提升到 `shared/` 的条件只有两条：进入 popout，或进入移动端 / wire。否则保持在 renderer overlay。

## 3. Fixture 矩阵（12 组）

| # | 场景 | 关键断言 |
| --- | --- | --- |
| F1 | 1 工作区 · 2 agent（working + done）· **混合计价**（一个有价、一个未定价） | 双列基线；逐 agent 只 token；未定价显示 `—` 而非 0 |
| F2a | 0 工作区 · tracker open | 主操作 `Create workspace`；Spend 不可用；Agent 空态 |
| F2b | 0 工作区 · tracker closed | 同上，但 **不**进 Delivered 的演示态（0 工作区 ≠ 交付） |
| F3 | 3 工作区 · 10 agent（含子 agent） | 次要工作区折叠；History 折叠计数；行内 workspace pill |
| F4 | 用量未启用（`disabled`） | 空态 + CTA；不显示 `$0` |
| F5 | 只剩归档工作区 | 不进 Needs you/Working；归档卡在 `Show archived` 下 |
| F6 | 无 tracker（本地任务） | `◇` 徽标；标题取 `displayName`；无 PR 证据 |
| F7 | 远端 / SSH 工作区 | 用量 `remote_host`；动作可点但标注不可用 |
| F8 | `done` + `outcome: failure` / `sessionBoundary` | **不**显示 Delivered；状态点用失败/边界语义 |
| F9 | 长标题 / 大数字 / 多标签 | 截断与换行；不撑破右栏 |
| F10 | `ambiguous_session` | Spend 显示 `unavailable · ambiguous_session`，不猜 |
| F11 | `no_matching_session` | 同上，语汇不同 |
| F12 | 1 工作区 · **0 agent**（刚建好） | Agents 空态；Spend `no_matching_session`；Workspaces 正常 |

## 4. 截图（harness + CDP）

路径（复用既有模式，R16）：

```text
orca/tests/tools/task-workbench-rendered/
  fixture.tsx        # 挂 TaskWorkbenchPanel，按 ?fixture=&w=&h= 选择
  index.html
  run.mjs            # electron.launch + page.goto + CDP Page.captureScreenshot
  README.md
```

- 窗口尺寸：由 harness 的 fixture host 设定 `BrowserWindow({ width, height, show: false })`；每次运行一个尺寸，
  输出到 `.bench-fixtures/task-workbench-<fixture>-<w>x<h>/`。断言窗口 `visible===false && focused===false`。
- `ORCA_BACKGROUND_LAUNCH=1` 是**必要条件，不是完整路径**——既有 harness 还会 esbuild 打包 fixture host、
  Vite 打包 renderer，并断言页面无 `pageerror`。

| # | 尺寸 | fixture | 证明什么 |
| --- | --- | --- | --- |
| S1 | 1440×900 | F1 | 双列基线（**必交**） |
| S2 | 1100×800 | F1 | 双列布局的**闭区间下界**：恰好 1100 仍是双列（**必交**）；单列分支由 900×700 校准探针证明 |
| S3 | 1280×480 | F1 | 矮窗布局的**闭区间上界**：恰好 480 尚未变矮；矮窗分支由 1280×479 校准探针证明 |
| S4 | 1440×900 | F2a | 0 工作区主操作（**必交**） |
| S5 | 1440×900 | F2b | 0 工作区 + closed tracker |
| S6 | 1440×900 | F3 | 3 工作区 + 10 agent 折叠与计数 |
| S7 | 1440×900 | F4 | 用量未启用 |
| S8 | 1440×900 | F7 | 远端不可用 |
| S9 | 1440×900 | F10 / F11 | 两个归因不可用（两张小图） |
| S10 | 1440×900 | F5 / F6 / F8 / F12 | 归档 / 无 tracker / 失败轮 / 0 agent |

只交 3 张时选 **S1、S2、S4**（两位评审独立给出同一组）。其余状态用 DOM 断言 + harness 报告覆盖，不强行截图。

S1–S3 与两张校准探针合起来才是完整的边界证据：降级分支由 `900×700`（单列）与 `1280×479`（矮窗）两张
校准探针证明，S2/S3 证明的是**闭区间边界仍然成立**。P1a 实测后没有改动任何常量；`README.md`
§7.3.1（`窄窗 < 1100px`、`矮窗 480px`，即恰好 1100 仍属双列）是规范规则，本次裁定以它为准。裁定来源：
P1a 记录 `swarm-artifacts/task-workbench-p1a-20261116/p1a.md` §2.3 与 §9 Decision 2。

## 5. 退出条件（第三方可验证）

1. `task-workbench-layout.ts` 单测：**独立 expected table**（不读 fixture 元数据反推），逐条对应 §7.3.1；
   12 fixture × 4 尺寸的判定写死在测试里。
2. harness 报告 JSON：每个 fixture 的 `data-testid` 断言集合 + 窗口 hidden/unfocused + 无 `pageerror`。
3. 截图文件命名 `task-workbench-<fixture>-<w>x<h>.png`，存 `.bench-fixtures/`；PR 描述列出编号。
4. 文案 100% 走 catalog，`verify:localization-extraction` 无新增漏项。
5. 生产面为零：`task-workbench-*` 只出现在 `tests/tools/` 与 `components/task-workbench/`；
   `rg "taskWorkbench" src/renderer/src` 的命中不包含新预览入口（不需要 tree-shake 断言）。
6. 组件不 import store / RPC：一条 import 边界测试（模块依赖列表断言）或既有 ESLint restricted-imports 规则。
7. `pnpm tc`、定向 `pnpm test`、`check:code-quality:changed` 通过。

## 6. 风险

| 风险 | 处理 |
| --- | --- |
| 阈值 1100/480 没有依据 | 已由 S1–S3 加两张校准探针（900×700、1280×479）实测校准；常量保持命名常量不变，`README.md` §7.3.1 未改 |
| harness 是一次性脚本，P1b 不能复用 | 接受：它的产出是评审证据；P1b 用同一 harness 换 fixture 来源即可复用骨架 |
| view 类型在 P1b 被推翻 | 按 R17/R18 收窄；提升到 `shared/` 只在 popout/移动端时发生 |
| 行组件与 Dashboard 漂移 | 直接复用 `DashboardAgentRow` + overlay，不复制渲染逻辑 |
| 截图只证明"静态壳好看" | DOM 断言与 expected table 才是判定；截图只证明布局 |

## 7. 估时

| 项 | 估时 |
| --- | --- |
| 组件 + fixture + layout 单测 | 1–1.5 天 |
| harness（fixture host 尺寸参数 + 截图 + 报告） | 0.5 天 |
| 阈值校准（S1–S3 实测后调常量） | 0.25–0.5 天 |
| **P1a 合计** | **1.5–2 天** |
| P1b（接 identity/join/usage selector） | 另估，不在本计划内 |
