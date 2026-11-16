# 任务工作台 UI 评审记录（2026-11-16，两轮）

对象：§7.1 信息架构、§7.2 列表主轴、§7.3 图 B 工作台。
两轮均为只读独立 panel（codex-ark / trae，互不可见）；第一轮独立成稿，第二轮只追问 4 个能改变决定的点。
协议：`swarm-orchestration/references/discussion.md`；私有讨论策略不在本仓库，本轮用共享默认值并在此声明。
本记录不授予写入、合并、部署或启动 Agent 的权限；裁定权在产品 owner（用户）。

## 0. 运行事实与偏离

| 项 | 值 |
| --- | --- |
| 基线 | 本 worktree 的 `README.md`（2026-11-16 增补版）+ `task-workspaces.md` + `orca/` v1.4.219 快照（只读） |
| 参与者 | A：`codex-ark`；B：`trae`；模型/努力度未指定（agent 默认） |
| 交换轮次 | 2 轮（用户明确放开了 2 轮上限） |
| 独立性 | 作者隔离：是；草稿可见性：互不可见（各自 `/tmp` 输出）；上下文：同一 brief；模型多样性：两个不同 agent |
| 偏离 1 | `trae` 的 `tui-idle` 仍超时，以输入提示符为就绪证据（与前两轮一致） |
| 偏离 2 | `trae` 的 `send` 仍只回 `input_accepted`（`provider: unsupported`），以评审文件发布为完成证据 |
| 偏离 3 | 未做真机渲染；两份评审的布局结论都建立在代码阅读与文档线框上 |
| 用量 | 未接台账；本轮记为**未知**，不记 0 |
| brief | `review-brief-task-workspace-ui.md`（第 1 轮）、`review-followup-task-workspace-ui-r2.md`（第 2 轮） |

## 1. decision and baseline

决策：任务工作台的 UI 能否、以及在什么范围内现在冻结；本期先做 M1（详情页 `Orca` tab）还是直接做图 B。

## 2. options and evidence

| 选项 | 支持证据 |
| --- | --- |
| A 先做 §7.4 Orca tab（tracker 身份主轴） | 详情页已有 `repoId/number/type`；`find*Attachment` 已在手；用量可从 `*UsageProjectBreakdown` 按 `worktree:<id>` 直读；零新 RPC / 零 scan |
| B 直接以 `taskRecords` 为主轴做图 B | §8.3 形态完整；但被 M2a（旧 build round-trip）冻结，无判决前引 domain 是裸奔 |
| C 工作区驱动反投影（不引入逻辑任务） | 零存储；代价是跨窗口/跨入口不共享，跨入口续做仍读 worktree 绑定 |
| D Agent-first（Dashboard 行反聚合） | Dashboard 行模型与折叠现成（含已实现的 lineage）；但"哪个任务"的 join 键仍是 render-only |

## 3. open points（两轮结束仍开放）

- `Delivered` 的产品定义（PR merged / Agent done + checks / 显式验收）——需产品 owner 拍。
- 任务意图层（目标/验收/授权/owner）无法从现有数据取到，M1 只能部分表达。
- 图 B 三区在任何窗口尺寸下都无真机渲染证据。
- `projectBreakdown` 的 `worktree:<id>` 是未文档化契约，解析层尚未实现（R7）。
- M2a 未判决。

## 4. conclusion and reasons

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 工作台是不是基础 | **是**，但"现在冻结图 B"不是。基础是 IA 主轴 + selector 合同 + 状态词汇；图 B 的像素与折叠规则不是基础 | 两评同向 |
| 一期做什么 | M1（Orca tab），零持久化；selector 必须可被 M2b 复用 | 两评同向；与 2026-11-09 结论一致 |
| IA 是否漏层 | 漏了"任务目标/验收/授权/owner"；M1 取不到，只能做聚合视图 | 两评同向（B 更严格：直接改名） |
| 分组归属 | 按**活跃工作区状态并集**，不按 primary；primary 只决定默认打开哪个 | 两评同向 |
| 0 工作区 / 无 tracker | 有 tracker open → Working；closed/merged → Delivered；既无 tracker 也无工作区 → 不成列表项 | A 的写法与 R1（`◇` 是徽标）自洽；B 写"0 工作区 → Unlinked"，与其自己指出的 R1 冲突，未采纳 |
| 已归档工作区 | 不参与 Needs you/Working；只剩归档且有完成证据时进 Delivered 的 `Show archived` | 两评同向 |
| 侧栏 | 不加任务行，只保留工作区/草稿行 + 徽标 | 两评同向 |
| 降级顺序 | Delivery → Agent 历史 → Spend 细节；Workspaces 身份与 CTA 不牺牲 | 两评同向（具体形态略有差异，已合成 §7.3.1） |
| 入口误选 | 会在 Tasks 与 Dashboard 之间误选；最小修法是 Dashboard 卡片加"View task"反向入口 | 两评同向 |
| 若只做一版 | M1 Orca tab，不做列表主轴、不做图 B、不做 taskRecords | 两评同向 |

### 4.1 两人的分歧（共 2 处，均已处理）

1. **命名**：A 认为可保留"工作台"名称、只缩文案；B 认为 M1 必须叫"任务聚合视图"。已取保守口径（B）：
   tab 名可以是 `Orca`，文档定位为"任务聚合视图"，M2b 有 `taskRecords` 后再叫工作台。
2. **0 工作区的归属**：A 给"有 tracker→Working/Delivered"；B 给"→Unlinked"。B 的写法与它自己指出的
   "`Unlinked` 只能是徽标（R1）"相矛盾，未采纳 A/B 之一而是采纳 A（与 R1 自洽）。

## 5. end state

- A：`escalate-value-choice`（`Delivered` 定义需产品 owner）。
- B：`insufficient-evidence`（缺真机渲染、缺 `Delivered` 判据、缺 `projectBreakdown` 解析层）。
- 合并后：**冻结范围 `decided`（§6.4）；开放项保留**。两者并不冲突：A 指向"谁有权定"，B 指向"证据不足"。

## 6. next-step owner and authorization

- **产品 owner（用户）**：定 `Delivered` 的定义；决定是否现在开工 M1。
- **Operator（本轮）**：已把 §6.4 冻结项、§7.2 分组规则、§7.3.1 降级顺序写进设计文档；改了 §7.1 的
  `Unlinked` 与 R1 的冲突；未改代码、未合并、未部署。
- 实现、真机渲染、合并、部署：**均未从本记录获得授权**。

## 7. invalidation and reopen conditions

- 真机渲染显示 §7.3.1 的降级顺序在窄窗/矮窗下不成立。
- 产品 owner 给出 `Delivered` 判据（则该条解除开放，重新判定分组优先级）。
- M2a 判决失败（M2b 无法落库，则任务身份层永远停在投影，命名保持"聚合视图"）。
- 上游改变 `projectBreakdown` 键形态、Agent 行模型或 folder workspace 行语义。

## 8. archival state

**pending archival**：本记录已入库；两轮原始输出在 `/tmp/ws-ui-review-r{1,2}-{codex-ark,trae}.md`（未入库）。
评审终端已 `terminal close --tab`（`ptyKilled` 见本轮会话输出，属 `unverifiable`）。

## 9. 评审后的产品决定（2026-11-16，owner 直接给出）

| # | 决定 | 影响 |
| --- | --- | --- |
| D12 | **`Delivered` = agent done** | 解除 §6.4 的开放项；§7.2 的分组谓词变为可实现的规则（忽略 `sessionBoundary`，`failure/cancellation` 不计入，`outcome` 缺失仍算 done）。语义仍是"这一轮做完了"，不等于验收通过 |
| — | **路标改为 UI 优先**：P1 工作台 UI（1a 静态壳 + 截图 → 1b 接线）→ P2 输入入口（T2）→ P3 列表主轴 → P4 持久化 | 实现顺序不再是 M0→T1/T2/M1 并列，而是单线四段；T2 从"可先做"改为 P2；旧标签映射见开发计划 §0.5 |

D12 的唯一遗留：失败的 agent 轮是否算 Delivered。当前取"不算"（保守），产品若要"任何一轮结束都算"，只需改谓词，不影响 IA。

## 10. 第三轮：P1a 静态壳计划（2026-11-16）

对象：`p1a-ui-shell-plan.md` v1（组件拆分 / fixture / 截图 / 退出条件）。独立成稿，1 轮。

| 项 | A（codex-ark） | B（trae） |
| --- | --- | --- |
| decision | 接受但需改 | 接受但需改 |
| end-state | `decided` | `insufficient-evidence` |
| 必交 3 张截图 | S1 / S2 / S4 | S1 / S2 / S4（独立重合） |

共同 must-fix（已进 v2 的 R16–R21）：

1. **不新增 DEV 生产入口**：改用 `orca/tests/tools/*-rendered/` 的既有 harness（fixture.tsx + run.mjs + CDP）。
   探针确认该模式存在（`tests/tools/omp-remote-sidebar-rendered/run.mjs`），且窗口尺寸由 fixture host 的
   `BrowserWindow({show:false})` 控制；`ORCA_BACKGROUND_LAUNCH=1` 只是必要条件。
2. **view 类型收窄**：identity 用 union（A 指出 primary 应改成 `defaultWorkspace.source`；B 指出 taskKey 应用
   `TaskProviderIdentity`）、token 用 tagged union（两人都指出裸数字会被 AI Vault / usage rollup 两种来源推翻）、
   workspace 用 `DashboardWorkspace` 全量、spend 用原因枚举。
3. **layout 输入补全**：`containerWidth/containerHeight/counts/mode`；1100/480 只是设计假设，需截图校准；
   仓库无"内容断点"通道，live 用 `ResizeObserver`（`@container` 有先例但不作为 P1a 前提）。
4. **fixture 补缺口**：`ambiguous_session`、`no_matching_session`、1 工作区 0 agent、混合计价、0 工作区 tracker
   open/closed。
5. **退出条件改成第三方可验证**：expected table 独立于 fixture；DOM 断言 + harness 报告；生产面断言改为
   "生产路径零命中"（不是 grep 文案 key）。

唯一分歧：token/outcome 字段落 `shared/dashboard-snapshot.ts`（B）还是 renderer overlay（A）。取 A（最小改动、
不扩上游面），并把"提升到 shared 的条件"写死为"进 popout 或移动端/wire"。

A 的 end-state 是 `decided`（缺口均为可探针验证的事实），B 是 `insufficient-evidence`（同上，但强调先跑探针）。
记录按 `insufficient-evidence` 归档：v2 已把两项探针结果写进计划（harness 路径、无内容断点），剩下阈值校准
必须在 1a 内部完成，不再阻塞动工。
