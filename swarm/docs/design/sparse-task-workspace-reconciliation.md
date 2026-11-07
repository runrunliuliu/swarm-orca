# Sparse 任务工作区：创建失败的只读对账运行手册

状态：对应 M4 **最小止血**（`sparse_task_create_needs_reconciliation`）的操作侧说明。
它不是完整恢复协议：没有持久请求回执、没有 `create-status` 命令、没有自动清理、没有跨宿主接入。
执行任何写操作（prune、删除分支、删除目录、重建、重置索引）都需要单独授权。

依据：[Sparse 任务工作区开发计划](sparse-task-workspace-development-plan.md)（M4 条目）、
[M0 契约冻结](sparse-task-workspace-m0-contract.md)（错误码与兼容矩阵）、
[以任务为中心的工作区模式](task-workspaces.md)（隔离与交付边界）。

## 1. 什么时候需要这份手册

任一条件成立：

- 任务稀疏工作区创建返回错误，且 `message` 含 `[sparse_task_create_needs_reconciliation]`；
- 创建过程超时、断连、被取消，调用方只拿到 `runtime_unavailable` 一类的传输错误；
- `git worktree list` 里出现 `prunable` 登记，而目录已不存在。

标记只在**确实留有资源**时出现：创建在 Git 副作用之前被拒绝（目录格式、树校验、能力缺失等）
不会带标记，可以直接重试。带标记的错误原文会被完整保留在 message 中，`[sparse_task_*]`
内层码仍在，因此"哪一个门禁拒绝了创建"不会被掩盖。

## 2. 三个可判定状态

`sparse_task_create_needs_reconciliation` 的 message 同时给出观测结论，取值如下：

| 观测 | 含义 | 允许的下一步 |
| --- | --- | --- |
| `absent` | 目录与登记都不存在 | 不会带标记；按原错误处理，可安全重试 |
| `live` | 已登记、目录存在、HEAD 等于 pinned SHA、cone 覆盖请求、必需路径可读 | 视为已创建工作区，但仍需独立核验后才可交给 Agent 或交付 |
| `partial` | 有目录或登记，但上述任一项不成立（含"登记存在、目录缺失"的幽灵登记） | 保留现场，报告差异，等待授权处置 |
| `unverifiable` | 列登记、HEAD、cone 或必需路径无法读取（权限、I/O、断连） | 按未知处理，不推测、不清理 |

`unverifiable` 不是"没有残留"，`absent` 才是。

## 3. 只读对账命令

仓库侧（`<repo>` 是源仓库，`<path>` 是请求的工作区路径，`<branch>` 是请求的分支，
`<sha>` 是错误里报告的 pinned SHA）：

```bash
git -C <repo> worktree list --porcelain          # 登记、path、HEAD、branch、prunable/locked
git -C <repo> rev-parse --git-common-dir         # 登记来源
git -C <repo> rev-parse --verify refs/heads/<branch>
git -C <repo> for-each-ref --format='%(refname) %(objectname)' refs/heads/<branch>
```

工作区侧（仅在 `<path>` 存在时）：

```bash
git -C <path> rev-parse --is-inside-work-tree
git -C <path> rev-parse --git-dir
git -C <path> rev-parse --verify HEAD
git -C <path> status --porcelain=v1 --untracked-files=all
git -C <path> config --bool core.sparseCheckout
git -C <path> config --get core.sparseCheckoutCone
git -C <path> sparse-checkout list
```

对照 pinned 树判定必需路径（不是读工作区文件）：

```bash
git -C <repo> ls-tree -z -d <sha> -- <requiredPaths...>
```

结论按第 2 节映射；任一命令无法完成即记该维度未知，不要用"命令失败"推断"资源不存在"。

## 4. 处置矩阵

| 情形 | 处置 | 授权 |
| --- | --- | --- |
| 只有错误、目录与登记都不存在 | 按原错误修复后重试 | 无需额外授权 |
| `live` 且核验通过 | 可作为任务工作区继续使用；把 pinned SHA、cone、必需路径记入交接 | 使用/续做沿用原任务授权 |
| `live` 但必需路径或 cone 不符 | 保留现场，作为缺口报告；不得扩 cone、不得回退全量 | 修改需新授权 |
| `partial` | 保留现场，输出差异清单；不清理、不重建 | 处置需新授权 |
| 幽灵登记（登记在、目录无） | 只能按登记清理处理；先确认分支归属与是否有其他 worktree 引用它 | 清理需新授权 |
| `unverifiable` | 记录未知项，等待可读条件；不得据此删除或重建 | 无（只记录） |

清理时的最小动作与禁止项：

- 允许（获得授权后）：`git -C <repo> worktree prune --dry-run` 先看命中，再 `worktree prune`；
  它只删登记，不删目录、不删分支。
- 禁止：`git worktree prune --expire` 之类扩大范围、`git branch -D`、`rm -rf`、
  `git reset`/`git unlock`、在同一路径重建同名工作区、把 `prunable` 当成"不存在"从而直接重试。
- 若分支上存在其他 worktree 的提交或未归档证据，先归档再谈清理。

## 5. 已实现与未实现

已实现（M4 最小止血）：

- 任务模式创建失败后不自动回滚、不强删分支，保留目录、分支与部分索引；
- 失败后的只读判定（`absent`/`live`/`partial`/`unverifiable`）在错误路径上执行，不修改任何状态；
- 错误携带稳定标记与坐标（路径、分支、pinned SHA、HEAD、目录存在性、幽灵登记、缺失必需路径）。

未实现（完整 M4）：

- 客户端请求 ID、先于副作用的持久回执、阶段化状态与 `create-status` 查询；
- 重启后的三态对账与自动收养；外部创建工作区的收养或明确报错；
- 任何自动清理、自动扩 cone、自动回退全量；
- WSL/跨宿主上的必需路径与 cone 探针。

因此：本手册的结论是"当前能证明什么"，不是"当前已恢复"。

## 6. 记录与证据

每次对账保留：触发原因、错误原文（含标记与内层码）、执行的命令与工作目录、起止时间、退出码、
关键输出。未知项单列，不记 0，不用"重新创建成功"替代对残留的结论。
