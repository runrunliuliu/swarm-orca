# Sparse 任务工作区开发计划

状态：计划稿，未实施、未测试、未部署。
依据：2026-11-07 与 codex-ark 达成的四项共识（设计理念 / 设计目标 / 已实现能力 / 现场事实 分层）。
本文不构成实现、部署、重启、创建 worktree 或启动 Agent 的授权。

## 0. 共识前提

1. task 开发模式是设计理念，不是 runtime 既有强制门禁，不能当合规标准使用。
2. sparse 设计文档已规定固定 SHA、HEAD 与 sparse 状态回读、树级校验、依赖/指令存在性检查、可恢复创建；这些是**设计目标**。
3. 当前实现提供任务级 worktree/分支、复用拒绝、能力门禁、元数据留痕，属可用的性能/检出范围手段，单独不满足设计目标。
4. 现场无 sparse worktree 实例，端到端未验收。

因此本计划只做一件事：**把设计目标中与正确性相关的缺口补上**，同时保留"correctness 与 performance 分离"的原取舍。

## 1. 目标与非目标

目标：让 sparse 工作区可以作为"任务工作区"被固定、被核验、被安全续用；全量 checkout 仍是默认。

非目标（明确不做）：

- 不把 sparse 变成写权限、沙箱或授权边界。
- 不改变默认创建行为，不改变 legacy 全量路径。
- 不自动迁移既有 worktree、分支、Run、pins；不重写历史配置。
- 不新增第二套创建器、恢复服务或状态源，复用现有 Git/RPC/runtime/durable mutation 能力。
- 不自动扩大 cone，不自动回退全量 checkout，不自动清理不确定资源。
- 本计划不含部署、重启、服务改造；需要时另行授权。
- 大仓库与中断验收只在显式授权的 disposable fixture 上做，不碰活动任务 worktree。

## 2. 差距清单（对应共识第三层）

| ID | 缺口 | 现状 |
| --- | --- | --- |
| G1 | 基线未固定 | sparse 创建仍传 ref；成功后只按 path/branch 在 `worktree list` 匹配，不比对 HEAD |
| G2 | 无树级校验 | sparse 目录仅做格式校验，未按 pinned commit tree 拒绝 blob/symlink/gitlink/缺失 |
| G3 | 无依赖存在性门禁 | 启动前不检查 AGENTS.md、角色 skill、测试/构建配置是否在 cone 内 |
| G4 | 无就绪回读 | cone 与 `core.sparseCheckout` 生效状态未回读；仅在列表徽标使用 |
| G5 | 无恢复协议 | 任何异常（含超时/断连）走 catch-all 回滚 + 强删分支 |
| G6 | 副作用未分离 | sparse 可与 `--setup run` 组合，无依赖就绪前置 |
| G7 | 无任务绑定 | cone 与 pinned SHA 只进 worktree 元数据，未进任务/交接记录 |

## 3. 阶段、交付物与退出条件

### M0 冻结契约（0.5–1 天）

- 交付：请求/回执/状态字段表、错误码、能力名、兼容矩阵、旧调用者行为清单。
- 本轮冻结稿：[Sparse 任务工作区 M0 契约冻结](sparse-task-workspace-m0-contract.md)。
- 退出：审查确认默认行为不变、无第二套创建器、未知/旧 host 明确失败而不是静默降级。

### M1 基线固定与创建回执（2–3 天）

- 解析 base 一次，固定完整 SHA；固定 SHA 只作用于**新增能力协商路径**（新任务工作区）。legacy 全量创建的语义、默认值与调用者行为不变。
- 创建后回读 path/branch/HEAD 并与固定 SHA 比对；不一致不发布 ready。
- 回执字段：`baseSource`、`resolvedRef`、`pinnedSha`、`actualHead`、请求 cone 与实际生效 cone。
- 退出：本地与 SSH 路径结论一致；失败不留下 ready 工作区。

### M2 目录树与依赖校验（2–3 天）

- 每个 sparse 目录按 pinned commit tree 校验：必须是 tree entry，拒绝 blob/symlink/gitlink/缺失路径；限制数量与编码大小，超限在创建前失败。
- 新增启动前内容核验：调用方声明必需路径（AGENTS.md、角色 skill、测试/构建配置），创建后逐项验证存在；缺失则失败关闭，不自动扩 cone。
- 退出：正反例覆盖；legacy 全量路径不受影响。

### M3 就绪门禁与副作用分离（2–3 天）

- sparse 首版只允许 `--setup skip`；`--setup run` 需依赖就绪门禁通过。
- 就绪判定 = M2 已校验的 cone 在 pinned tree 中成立 + `core.sparseCheckout` 生效 + HEAD 与固定 SHA 匹配 + 声明的必需路径可读。
- 目录存在本身不是就绪证据：空目录、或只有间接依赖的目录不得作为通过条件。
- 未就绪的工作区不得被 Agent/终端启动路径接受。
- 退出：partial worktree 在启动入口被拒绝，而不是靠提示词提醒。

### M4 可恢复创建（4–6 天）

- 客户端生成请求 ID，持久回执先于副作用；阶段化状态与 `create-status`。
- 歧义/超时保留资源并标记 `needs_reconciliation`；取消 catch-all 回滚与强删分支，只做只读诊断。
- 重启后对账：live / unverifiable / exited 三态，不擅自重建。
- 退出：中断各窗口用例通过；无重复资源；歧义场景不自动清理。

### M5 任务绑定与交接（1–2 天）

- cone、pinned SHA、必需路径写入任务/交接记录（planner 侧），与 worktree 元数据双向可核验。
- 退出：交接可被独立复核；既有 Run 的 pins 不变。

## 4. 测试矩阵（实施时逐项记录结果）

| 范围 | 要点 |
| --- | --- |
| 解析 | 去重/顺序、绝对路径、`..`、点目录、空格/Unicode、数量与大小上限 |
| 树校验 | tree / blob / symlink / gitlink / 缺失；旧 host 在副作用前拒绝 |
| 基线 | pinned SHA 不受 ref 移动影响；HEAD 不符即失败 |
| 隔离 | 主工作区 + 两个 linked worktree 的 sparse/full 设置互不影响；失败不改变同仓库其他 checkout |
| 就绪 | 未就绪不可启动；setup/启动失败保留 checkout 且结果分开记录 |
| 副作用 | 不隐式执行 hooks/filters/LFS/子模块；缺失依赖阻断启动 |
| 恢复 | 各阶段中断、响应丢失、重放；不产生重复资源 |
| 兼容 | 真实 Git 基线/现代版本、native/WSL/SSH 路由、旧客户端、folder workspace 拒绝 |
| 性能 | 同 pinned fixture 下全量 vs 稀疏的物化文件数/字节/耗时，附重复次数与缓存条件。**仅作观测记录，不计入正确性验收门槛** |

## 5. 验收与证据

- 确定性回归：`orca` 侧 vitest 定向用例；`swarm` 侧离线 unittest。
- 原生集成与真实 Agent 闭环：需单独授权，会计费；未授权时单列"未验证"。
- 每项证据保留：命令、cwd、起止时间、退出码、快照 hash；未知不记 0。
- 交付口径：已实现能力与设计目标差额分别列出，不用部署成功替代功能验收。

## 6. 顺序、依赖与风险

- 顺序：M0 → M1 → M2 → M3 → M4 → M5。M1/M2 可先合并；M4 不得绕过 M1/M2。
- 风险：`extensions.worktreeConfig` 属共享配置迁移；外部 Git 写入无法被 Orca 互斥；SSH 断连只能判 unverifiable；任何部署/重启单独授权。
- 回滚：新增能力按能力名协商，旧 host 失败关闭；不改变 legacy 默认路径即可回退。

## 7. M0–M2 交付状态与已知缺口（2026-11-07）

已交付并合并进 `main`：M0 契约冻结、M1 固定基线 + 创建回执、M2 树级校验与必需路径核验
（desktop IPC 本地 create 与 runtime 本地 create 共用同一编排 helper；legacy 全量与 legacy sparse 行为不变）。

已知缺口，作为 M3/M4 的输入：

- **SSH 任务模式仍 fail-closed**：远程 sparse 序列没有固定 SHA 与回读，v1 未接入；能力名是 host 级，只覆盖本地路径，SSH 明确拒绝而不降级。
- **requiredPaths 仅本机 stat**：WSL/跨宿主未验证，已有可注入 probe 但无宿主适配，假缺失时 fail-closed。
- **Git 版本**：只在 2.39.5 实测；2.25 基线与 `:(literal)` 兼容性未验证，被拒会 fail-closed 为 `sparse_task_tree_probe_invalid`。
- **覆盖缺口**：IPC 侧未重复「legacy 零额外 Git 调用」断言（由 runtime 入口测试覆盖同一段共享代码）；无真实 sparse 创建端到端验收，无 live Agent 闭环。
- **失败清理**：task 模式已改为保留现场、不自动回滚；完整恢复协议仍归 M4。

现场发现（2026-11-07，与本计划直接相关）：

- Orca `worktree create` 在约 31k 文件、网络存储的仓库上稳定失败：RPC 约 60–90 秒返回 `runtime_unavailable`，而完整检出需约 3.5 分钟；随后自动回滚删除仍在写入的目录，并留下孤儿分支。这正是 M4「响应丢失即回滚 / 保留 `needs_reconciliation`」要解决的场景。
- 用 `git worktree add` 手工创建的工作区在原生 `worktree list` 可见，但缺 `createdAt` / `lastActivityAt`，项目区不一定显示。外部创建的工作区应被正常收养或明确报错，不能停在半注册状态，列入 M4 待定项。

## 8. M4 最小止血交付状态（分支 `sparse-task-m4`，未合并、未部署）

只做了讨论中确认的「止血」部分，不是完整 M4。

已实现：

- 任务模式创建失败后**不删除、不回滚**（沿用 M2 的 `retainPartialWorktreeOnFailure`），
  新增失败后的只读判定：`absent` / `live` / `partial` / `unverifiable`，
  `partial` 包含「登记在、目录无」的幽灵登记；判定不改 cone、不修复、不清理。
- 失败带稳定标记 `[sparse_task_create_needs_reconciliation]` 与坐标（路径、分支、pinned SHA、
  HEAD、目录存在性、幽灵登记、缺失必需路径），内层 `[sparse_task_*]` 码保留。
- 只有**确实留有资源**时才加标记：创建在副作用前被拒绝的错误保持原样，可安全重试。
- 代码位置：`orca/src/main/ipc/sparse-task-create-reconciliation.ts`，在
  `createSparseTaskWorkspace` 的失败路径上调用（两条本地创建入口共用）。
- 操作侧说明：[创建失败的只读对账运行手册](sparse-task-workspace-reconciliation.md)。

仍未实现：客户端请求 ID 与先于副作用的持久回执、阶段化状态与 `create-status`、重启后三态对账、
自动收养外部工作区、任何自动清理。这些仍按 M4 原条目推进。

现场残留（已清理，2026-11-07）：`swarm-orca` 的 `git worktree list` 曾残留一个 `prunable` 登记
`.orca-preparing/3131242-…`（目录已不存在、无孤儿分支）；按授权只执行了 `git worktree prune`，
未动分支、未动 `release-radar`，父仓库无对应登记。

## 9.5 M4 最小持久化（意图记录，分支 `task-binding-start-gate`）

创建前写意图、成功后落 `created`、失败按有无残留落 `failed` / `needs_reconciliation`，
每仓库保留最近 50 条；写不出来则不创建。查询已实现：`orca worktree create-status`（RPC `worktree.createStatus`）列出未结算尝试的
记录态与现场态。观测分类（live/exited/unverifiable）在查询时写回记录，与记录自身状态分开。启动清扫、外部工作区收养（方案 A：列表投影时补元数据，`orcaCreationSource: 'external'`）均已实现。

## 9. M3 最小版交付状态（分支 `task-binding-start-gate`）

已实现：启动门禁 `assertTaskWorkspaceLaunchableFor`，接入 runtime 后台终端、桌面终端与 Agent
会话创建三条 launch 路径；判定为 "binding 有效 + pinnedSha 是 HEAD 祖先 + cone 覆盖 + 必需路径可读"，
失败以 `sparse_task_start_gate_failed:<reason>` 拒绝，无绑定的工作区一律放行。

只读状态（`worktree show` 的 `taskWorkspace`）同样已实现：`unbound/ready/drifted/unverified/
binding_invalid/not_probed` + reasons，不抛错、不写；放行集合与门禁一致。
未实现：跨宿主/WSL（**短期不做，按已接受边界处理**）、缓存策略与 live Agent 闭环验收。
移动端会话创建与终端分屏已接入。契约见 [M3 启动就绪门禁](sparse-task-workspace-m3-start-gate.md)。

## 10. 能力与前提的对应（2026-11-08）

本计划实现的 9 类能力并非概念必需，而是两类部署约束的产物，写在这里以免后来人把前提当理念：

| 约束 | 必需能力 | 换环境后可去掉 |
| --- | --- | --- |
| 约 3 万文件、worktree 在网络盘、全量检出约 3.5 分钟、并行多 Worker | 稀疏检出、M2 目录/树/必需路径校验、M3 启动时 cone 复核、CLI `--sparse-task-*` 入口 | 仓库小、检出快时全部可以不要 |
| 创建会超时（RPC 60–90 秒 vs 检出数分钟）、失败会回滚删目录并留孤儿分支 | M4：失败保留现场、只读判定、意图记录、`create-status`、启动清扫 | 本机毫秒级创建时，意图记录的价值基本消失，只留一次只读核对 |

任务模型本身的必需项只有：稳定任务身份、从已确认基线创建的绑定、复用绑定与逐仓库交付。
外部工作区收养属于 catalog 缺口，与任务绑定只是偶然相关。

