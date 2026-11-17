# T2 评审记录（2026-11-16，列表页 dock 与任务草稿行）

本轮是**只读独立 panel**（两票，互不可见），不是 debate：只有一份设计（README §7.9），不存在互相对立的
既有主张。协议来源：`swarm-orchestration/references/discussion.md`；本工作区的私有策略文件
（`skills/orchestration/references/discussion-policy.md`）不在本仓库，故本轮按共享默认值执行，
未取到策略覆盖（见 §0 偏离 3）。

本记录不授予写入、合并、部署或启动 Agent 的权限；裁定权在产品 owner（用户）。

## 0. 运行事实与偏离

| 项 | 值 |
| --- | --- |
| 目标 worktree | 本仓库 checkout（`agent-issue`，linked worktree），只读评审 |
| 执行主机 | `local`；`orca status` = app running / runtime ready |
| 参与者 | A：`codex-ark`；B：`trae` |
| 模型 / 努力度 | 未指定，两者均用 agent 默认（本轮未从策略取得 model/effort 值；属未按策略固定的一项） |
| 并发现场 | 2 个只读评审终端，未再派发、未写仓库 |
| 交换上限 | 共享默认 2；实际 **1 轮**（两者结论同向，第二轮不会改变结论） |
| 独立性四要素 | 作者隔离：是；草稿可见性：互不可见（各自 `/tmp` 输出）；上下文暴露：相同 brief；模型多样性：两个不同 agent，具体模型未记录 |
| 偏离 1 | `trae` 的 `terminal wait --for tui-idle` 两次超时；改以终端内容（输入提示符 / `permissions: YOLO mode` 可见）作为就绪证据后发送。与 2026-11-09 记录一致 |
| 偏离 2 | `trae` 的 `terminal send --wait-submit` 只回 `input_accepted`、`provider: "unsupported"`，没有 `turn_started`；改用"评审文件发布"作为完成证据（`wait_for_file.py`，inotify + 300 s 预算，实际 156 s 出现） |
| 偏离 3 | 私有 discussion-policy 不在本仓库：交换上限、并发上限、默认 model 均未从策略取值；使用共享默认并在此声明 |
| 与旧记录不一致 | 2026-11-09 记录称 `terminal create --agent codex-ark` 被本 runtime 拒绝（`Unknown TUI agent`）；本轮同一命令**成功**，说明该阻塞已随 runtime 更新消失，不是稳定结论 |
| 用量 | 未接台账采集。终端计数（`↓ ~2.5K` tokens 一类）不可当账；本轮用量记为**未知**，不记 0 |
| 终端清理 | 两个评审终端已 `terminal close --tab`；回执见 §8 |

## 1. decision and baseline

决策：是否按 `README.md` §6.2（D7–D11）+ §7.9（dock 与任务草稿行）作为 T2 实现基线。
基线：本 worktree 的 `swarm/docs/design/task-workbench/{README,development-plan}.md`（2026-11-16 状态）；
代码证据以 `orca/`（upstream `v1.4.219` 快照）为准。brief：`review-brief-t2-dock.md`。

## 2. options and evidence

| 选项 | 支持证据 |
| --- | --- |
| A 页面级 dock（卡片外，列表卡片上方保持分页条不动） | `task-page/Frame.tsx` 已是外层 `flex-col`，卡片 `flex-1`；`github/List.tsx` 的分页条注释明确它"sits outside the scroll container" |
| B 卡片内 dock（分页条上方） | 需要改每个 provider 的卡片滚动结构，且窄窗下与分页条争高度 |
| C 一期 `FolderWorkspace{taskDraft}` 投影 | `FolderWorkspace` 已有 `linkedTask / linkedTaskSourceContext / isArchived / lastActivityAt`；folder workspace 在每一种 Group by 下都有 lane，且是合法 agent launch target |
| D 直接做 `taskRecords` + 新行类型 | 语义最干净，但要动 `row-types.ts`、`virtual-row-dispatch.tsx`、分组 lane、宿主计数、激活/右键/关闭，且受 M2a 门禁约束 |

## 3. open points

- GitHub 写通道的最终形态：主通道走 RPC + 新 CLI 动词，还是保留 `gh`（两者对幂等与远端宿主能力不同）。
- 部分成功（issue 已建、`linkedTask` 未写回）的对账协议：回执里用什么键回查，谁在何时重试。
- 30 天归档的 sweep 归属与 `lastActivityAt` 是否真的会被 agent 运行更新（本轮只读代码，未实测）。
- 跨入口防重（dock 与 `＋ New issue`）的反查接口是否存在、代价多大。
- 中文指令的草稿名 fallback 规则（`slugifyForWorkspaceName` 只保留 ASCII）。

## 4. conclusion and reasons

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| Q1 dock 形态 | 两者的结论一致：**A 正确**，不要卡片内 | 布局与分页条证据；窄窗 |
| Q2 载体 | 一致：**一期投影成立**；代价与 M2b 工作包重叠，不能顺手做 | 行类型/计数/激活五处改动 |
| Q3 会话宿主 | 方向对，但**必须显式 `folderPath`**：`folderWorkspaces:create` 缺省会回落到 `projectGroup.parentPath` | A 指出，代码已核对 |
| Q4 人工确认 | 预览 + 确认是必要门槛，但**不够**：要补\"已建未链接\"的对账与重试 | A、B 同 |
| Q5 生命周期 | 保留折叠 / 30 天归档可作默认，但**归属与活动信号未写**；\"一行一任务\"要说明多意图输入怎么办 | A、B 同 |
| Q6 状态矩阵 | 两人都判\"不齐\"：缺空态、未授权、加载、部分成功、远端、agent 崩溃；要求写成状态机 | A 给了 11 项，B 独立列出同类缺项 |
| Q7 演化 | \"只换数据源、UI 不变\"**不成立**（点击行为要变）；成立的是行外观；必须提前保证 `linkedTask + linkedTaskSourceContext` 都写 | A、B 同 |
| Q8 命名 | `getWorkspaceIntentName` 对纯中文返回 `null`；英文可用，但要多 repo / 重名 fallback | B 指出，代码已核对 |
| Q9 入口分工 | 边界清楚，**防重机制缺失**：同一任务可能被 dock 与 `＋` 各建一次 | A、B 同 |

两人的 must-fix 合并后即 README §6.3 的 R8–R15；没有一项互相冲突，差异只在措辞与展开程度
（A 更偏数据/事务，B 更偏状态与命名）。

## 5. end state

**`decided`（对方向），但实现前必须落地 R8–R15。**

- 两位评审各自的 `end-state` 都是 `insufficient-evidence`：他们指的不是方向不明，而是**实现前缺事实**
  （GitHub 通道、部分成功、`gh` 探测、归档归属、防重）。
- 这些缺口中 R8/R10/R11 已在代码层核对完毕（`rpc-params-catalog.generated.ts`、
  `folder-workspace-handlers.ts`、`workspace-name.ts`），R9/R12–R15 已写入设计文档。
- 因此方向可以冻结为 T2 基线；**不以评审结论作为开工授权**。

## 6. next-step owner and authorization

- **产品 owner（用户）**：确认 R8 的取舍（GitHub 主通道用 app RPC + 新 CLI 动词，`gh` 只作备通道）
  与 R14 的归档默认值。其余 R9–R13、R15 属实现约束，无需产品决策。
- **Operator（本轮）**：已把修正写入设计文档与开发计划；未改任何代码、未合并、未部署。
- 实现、测试 fixture、真机渲染、合并、部署、启动 Agent：**均未从本记录获得授权**。

## 7. invalidation and reopen conditions

- `github.createIssue` RPC 或 CLI 动词的实现成本被证明高于 `gh` 方案（则 R8 回退）。
- 实测 `folderWorkspaces:create` 可安全使用默认 `folderPath`（则 R10 可放松，但需在非仓库目录验证）。
- 中文命名的 `slugify` 规则被上游修改（R11 重开）。
- M2a 判决失败（T2 停投影形态，R15 的迁移价值下降但不失效）。
- 上游改变 folder workspace 行模型、lane 或计数实现（§7.9.4/§7.9.14 重开）。

## 8. archival state

**pending archival**：本记录已写入本文件；两位评审者的原始输出位于各自终端与临时目录
（未入库，属一次性证据）。两个评审终端均已 `terminal close --tab` 关闭，回执 `ptyKilled: false`，
按规则记为 `unverifiable`；句柄与路径不入库（public-repository boundary）。
