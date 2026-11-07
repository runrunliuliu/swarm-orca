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
