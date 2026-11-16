# 入口选择：任务、讨论、执行路径、领域适配与交付

本文是**路由索引**，不是模式枚举、不是协议、也不授予任何权限。每格的判断条件只用来选入口；
参数、门禁、证据和授权一律以链接文档为准，冲突时以链接文档为唯一来源。

## 1. 先定任务，再选入口

隔离单位和选路起点都是**独立修改任务**，不是 Project、Terminal、消息或 Agent 数量。
完整理念、对象模型与实现状态见[以任务为中心的工作区设计](design/task-workspaces.md)，
这里只取与“选入口”相关的部分：

1. **任意入口先识别任务。** 续做同一任务时读原绑定；入口无可信关联或有多个候选时请用户确认，
   不因名称相同、内容相似或当前目录相同就合并任务。
2. **只读阶段不建工作区。** 讨论、诊断、只读审查直接在现有工作区进行。
3. **目标仓库与入口分离，首次写入前按需隔离。** 先确认目标仓库与授权范围——切换 Project 不等于
   授权修改另一个仓库；新的独立修改任务在首次写入前创建专属 worktree，固定基线与完整 SHA，
   读回实际 ID/路径/分支/HEAD；后续新增需要改的仓库再补建绑定。
4. **一任务可绑多仓库。** 每个仓库各自 worktree，明确文件所有权；一个仓库合并不等于任务完成。
5. **续做复用，交付按仓库、验收按任务。** 补充、修正、重试和恢复沿用原绑定；交付逐仓库走
   [worktree-delivery](../skills/worktree-delivery/SKILL.md)，任务层做跨仓库联合验收。

现状：这五条是**入口约定层**，依赖执行 Agent 遵守，运行时不做检查。代码侧已完成任务 sparse 契约的
M1–M2（固定基线、回执、树级与必需路径校验）、M3 启动门禁（仅本地宿主）、M4 创建失败只读对账与
M5 最小绑定；逻辑任务 ID、跨入口路由、多仓库绑定与写入硬隔离仍未实现，
逐项以[实现状态](design/task-workspaces.md#当前实现状态)为准；契约与运维手册在
[sparse 任务工作区目录](design/sparse-task-workspace/README.md)。

## 2. 决策顺序

任务确定后，按任务特征逐行判断，命中即停，不要叠加：

| 判断条件 | 入口 | 权威文档 | 不能混用 |
| --- | --- | --- | --- |
| 一次检查、一次实验或一份权威文档就能定 | 单 Agent 直接做，不召集 | [讨论协议](../skills/swarm-orchestration/references/discussion.md) §1 | 不需要讨论、不需要 Run |
| 需要独立判断，且逐条升级理由成立（错会被漏、假设要测、更便宜的替代不够） | 只读讨论：panel；仅当已存在互相支持的对立主张才 debate | [讨论协议](../skills/swarm-orchestration/references/discussion.md) | 判定本身不建 Run、不启动 Agent、不需要 worktree 或 `max_workers`；实际召集参与者须另有明确授权，并发/预算按部署策略；结论不授权写/合并/部署 |
| 需要真实多 Agent 执行、独立监督与跨回合续跑，且要求 strict | start grant 建 Run（`start-grant-mint` → `run-create --grant`）→ Strict Coordinator TUI + Operator monitor / scheduler | [启动凭据](design/start-grant.md) → [启动准备](../operator-prepare.md) → [TUI](../coordinator-tui.md) / [monitor](../operator-monitor.md) | 三条执行路径互斥；一个 Run 固定一条，不得换路径绕过启动门。[strict 握手](../coordinator-strict-start.md) 的 S0–S5 工具**已删除**，只作历史 |
| 只要只读核验、且没有两个不同权限的角色 | 单角色（或直接命令），**不进 strict** | [strict liveness §7](design/strict-bootstrap-liveness.md#7-未决决策需要-owner-拍板本文不代替)（诊断） | strict 对单权限任务是过度武装，这是**入口选择**而不是新门；[start grant](design/start-grant.md) 已实现 M1–M4、M5 未收口（[状态表](design/start-grant.md#4-开发计划)），且 `START_GRANT_REQUIRED` 仍为 `false`，所以未绑定 grant 的 Run 不受它约束，它也不能用来跳过任何现有 gate |
| 需要“启动一个 Run 的授权”，且该授权不能由将要执行它的 Agent 自己制造 | 启动凭据（start grant）→ 再走上表任一执行路径 | [start grant](design/start-grant.md) | **M1–M4 已实现、M5 未收口**：一次 mint 写一条不可改的批准记录，`run-create --grant` 与每次 `worker-start` 在服务端事务内校验；但 `START_GRANT_REQUIRED` 仍为 `false`，未绑定 grant 的 strict Run 不会仅因缺 grant 被拒，任何文档不得把这条门写成已强制执行。凭据只向下发，不改变执行路径的选择 |
| 非 strict 的同会话回合续跑 | 独立 goal-loop driver | [回合续跑器](../coordinator-driver.md) | 代码拒绝 strict 计划与 `strict-v1` Run，不能当 strict 的恢复或兜底 |
| 任务 DAG 可预固定、不需要重规划 | 固定 DAG Supervisor MVP | [Supervisor 手册](supervisor.md) → [策略](../policies.md) | 不自动重规划、重试、升级模型或接管新 Coordinator |
| 需要独立审查、合入、可选部署或清理 | 交付流程 | [worktree-delivery](../skills/worktree-delivery/SKILL.md) | 部署与重启是单独授权动作，不因“合并完成”推导 |

三条执行路径共用 `max_workers`、独立审查与单写者集成（`max_workers` 在未受 start grant 约束的路径上仍只是
brief / 提示词里的约束：Orca 的 `createRun` 不收这个参数；[start grant](design/start-grant.md) 的 M2 把它变成
服务端计数，且只作用于已绑定 grant 的 Run）；入口说明见
[Swarm README](../README.md) 的“先找对入口”表。

## 3. 分层

```text
任务层      独立修改任务的稳定身份与仓库绑定（理念已定，路由/绑定/隔离未实现）
控制平面    本仓库 swarm/ 的协议与 helper + 选定 runtime 的原生能力
                 ├─ 讨论（只读，不建 Run）
                 └─ 三条互斥执行路径（三选一）
领域适配层  领域入口 skill + 角色 references + 领域 schema/checker + 固定引用
目标工作区  被修改或被实验的仓库 worktree（执行对象）
```

一个任务可依次或并行使用多条入口，但一个 Run 固定**一条**控制路径，最多挂**一个**领域适配；
没有领域适配时按通用协议执行。两点易误读：

- 入口不是任务身份：换 Terminal、Project 或 runtime 不改变任务，也不自动取得该任务的执行所有权。
- 领域适配不是“另一个要开发的仓库”。角色材料既可在本仓库（如
  [software-development](../skills/software-development/SKILL.md)），也可在目标 worktree 的
  隐藏技能目录；差别只是读取位置，不是多一套控制链。

## 4. 领域适配的公开接入点

新增领域适配**通常至少核对**以下接入点；目标仓库更具体的规则、私有部署策略和历史 Run 的
pins 仍以各自固定引用为准，本文不构成穷尽清单：

| 接入点 | 位置 | 要求 |
| --- | --- | --- |
| 领域入口 skill | `swarm/skills/<domain>/SKILL.md` | 一个入口 + 按角色分 `references/`，不复制通用编排正文 |
| 领域契约与检查器 | `swarm/docs/design/<domain>-schema.md` + `<domain>.py` | 只读一致性回执，不认证真实执行、不授予权限 |
| 发现导航 | `AGENTS.md` 的 Skills 表 + `swarm/README.md` 的导航 | 显式读取入口，不宣称任何 harness 自动发现 |
| 固定引用 | 路径 + raw-byte SHA256 pins | 交接与恢复沿用原 pin，不静默替换 |
| 权限声明 | 角色 skill 与回执正文 | 明确写出“不授予 commit/合并/部署/重启/启动 Agent” |

已有实现与验收边界见
[软件开发领域适配计划](design/software-development-domain-adapter.md) §4；跨仓库分发、全局安装和
自动同步不在其范围内。新增入口或领域适配时同时更新本文决策表和 `swarm/README.md` 导航，
只改一处视为未完成。

## 5. 现状口径与误用

- 设计理念、入口约定、源码落地和实机验收是四件事，不能互相推导；分级标准见
  [Swarm 测试与验收指南](testing/reliability.md)。
- 入口依赖 runtime 宣告的能力。能力缺失时不得降级发送新字段、也不得把 legacy 回执当成新契约
  成功；应报告缺口，并按[创建失败的只读对账](design/sparse-task-workspace/reconciliation.md)
  处置残留，不盲目重试或删除现场。
- 讨论结论、领域 checker 回执、启动门通过和 monitor 回传都**不**授权写入、合并、部署或重启；
  它们各自的授权仍须单独取得。
- 本文不记录私有主机、模型/profile、归档路径或真实 Run/Task/Dispatch/terminal ID；需要时以
  部署方的显式配置与固定引用为准。

已知误用，出现任一条即停止该操作：

1. 按 Project、Terminal、消息数量或 Agent 人数划分隔离单位，而不是按独立修改任务。
2. 把讨论结论当成修改许可，直接改代码、开 Run，或在只读阶段先建 worktree。
3. 看到领域 checker 或离线套件 PASS，就绕过 strict 启动门和交付流程直接合入或部署。
4. 沿用旧 Run 或旧任务的路径、模型或 pins 来解释当前状态，而不重新核验。
