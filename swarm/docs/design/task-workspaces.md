# 以任务为中心的跨 Project 工作区模式

状态：设计理念，未实现为统一的自动创建、跨入口续接或运行时强制隔离功能。
只有“任务稀疏工作区创建契约”的 M0–M2 已合入主分支（固定基线、创建回执、树级与必需路径校验），
M4 只做了不删除失败现场与只读对账的止血部分；
逻辑任务身份、跨入口路由、启动门禁、完整可恢复创建与任务绑定持久化均未实现。
逐项对照见下文“当前实现状态”。
本文不改变既有 Run、会话、授权和固定引用，不构成启动 Agent、合并、部署或清理的授权。

## 核心理念

用户可以从任意 Project 的 Terminal 发起或继续任务。每个独立任务拥有稳定身份，
按需绑定一个或多个仓库的专属 Orca worktree。仓库修改在对应的任务 worktree 中完成；
同一任务跨入口继续时复用绑定，逐仓库执行标准交付流程，并在任务层完成联合验收。

隔离单位是独立修改任务，不是 Project、Terminal、消息或 Agent 数量。
一个任务可以跨多个 Project；一个 Project 也可以同时承载多个彼此隔离的任务。

## 对象与关系

| 对象 | 职责与边界 |
| --- | --- |
| Project | 对话入口和仓库组织视图，不决定任务身份，也不自动授予其下所有仓库的修改权限。 |
| Terminal / Agent 会话 | 参与任务的交互或执行入口。换入口不改变任务；入口关联不等于取得执行所有权。 |
| 逻辑任务 | 保存稳定任务 ID、目标、授权、负责人、验收条件和工作区绑定集合。只读阶段可以没有 worktree。 |
| 仓库 / worktree 绑定 | 固定目标 runtime、执行主机、仓库和 worktree 身份，以及分支、基线和写入范围。 |
| Run / 原生 Task / Dispatch | 具体执行与编排记录；需与逻辑任务显式关联，不能把某个 runtime 的局部 ID 当成全局任务身份。 |

这里的逻辑任务 ID 是设计概念，不是新增的 CLI 参数或现有数据库 schema。
跨 runtime 的关联与续接必须有明确适配和核验，不能混用不同 runtime 的原生 ID。

例如，一个“增加登录鉴权”任务可以有以下绑定：

```text
任务：增加登录鉴权（稳定任务 ID）
├── frontend 仓库 → worktree：增加登录鉴权-前端
├── backend 仓库  → worktree：增加登录鉴权-后端
└── docs 仓库     → 只读参考，尚不创建 worktree
```

每个目标仓库通常有一个主要任务 worktree；确需并行隔离时可增加 Worker worktree，
仍归属同一任务，并明确文件所有权、依赖和集成负责人。不按 Worker 数机械地创建工作区。

## 从对话到修改

1. **任意入口，先识别任务。** 用户可以在任意 Project 的 Terminal 中讨论、查询或发起修改。
   明确续做同一任务时读取原绑定；入口没有可信关联或存在多个候选时，请用户选择或确认。
   不能仅凭任务名称相同、内容相似或当前目录相同就合并任务。
2. **目标仓库与入口分离。** 优先采用用户明确指定的目标，否则使用已核验的会话目标。
   跨仓库需求逐一确定目标和授权范围；切换 Project 不等于授权修改另一个仓库。
   普通非 Git 文件夹不适用 Git worktree，须明确替代隔离方案，不能静默直接写入。
3. **首次修改前按需隔离。** 新的独立代码、配置或文档修改任务，在首次写入目标仓库前，
   通过 Orca 原生入口创建专属 worktree。纯讨论、诊断、只读审查不触发创建；
   后续新增需要修改的仓库，在确认范围后补建绑定，不预先为所有相关 Project 建工作区。
4. **核验基线与实际落点。** 从已确认的基线创建并记录完整 SHA，不一律假定 `main`，
   也不因对话位于另一个功能分支就继承该分支。读回实际 worktree ID、规范路径、分支和 HEAD，
   核对执行主机、仓库、setup 行为及就绪状态后再实施。
5. **短语命名，稳定身份路由。** 显示名使用简短任务描述；跨仓库时可加仓库或职责后缀。
   分支和目录采用合法、安全的派生名称，冲突时加短后缀。重命名不改变任务归属，
   后续操作依据稳定任务 ID 和精确绑定，不依赖显示名、`active` 或 `current` 猜测目标。
6. **续做复用，不搬运无关改动。** 补充、修正、重试和恢复沿用原绑定，不因换 Terminal、
   Project 或 Agent 而重复创建。用户明确指定已有 worktree 时，先核验任务归属和占用冲突，
   记录复用依据；不自动 stash、清理、覆盖或搬运其他任务的未提交修改。

多个 Project 若实际指向同一已核验仓库和执行位置，复用该任务的已有绑定。
同名仓库、相同远端 URL 或相似路径不证明是同一工作区；跨主机、跨 runtime 的副本分别核验。
涉及子模块时分别核对仓库边界、提交和父仓库 gitlink，不能仅凭目录嵌套把它们视为同一仓库。

## 执行、交接与恢复

- 原 Terminal 可以保留为讨论和结果汇总入口，实施会话位于任务 worktree。
  不要求先实现所有 Agent 的无损会话迁移；不能把一次 `cd` 当成现有 Agent 已完整迁移。
- 每个实施 Agent 的启动目录、文件工具工作目录、测试命令和交接引用都使用对应绑定。
  Agent 必须读取目标 worktree 中适用的 `AGENTS.md` 和角色技能，不能沿用入口仓库的规则代替。
  任务允许多个仓库，不等于每个 Agent 都可写所有仓库；交接明确各自范围和文件所有权。
- 多个入口可参与同一任务，但必须保持明确的当前负责人和操作所有权。
  新入口不能自动接管仍在运行的 Agent 或 Coordinator，不能重复派发同一修改。
  现有 Coordinator 门禁、Worker 并发、预算和生命周期规则不因跨 Project 而放宽。
- 任务绑定、范围变更、交付状态及证据应持久保存，以便换入口或恢复后核验。
  持久记录不证明旧进程已退出；续接前仍需对账未决动作、执行者和文件状态。
- 创建失败或结果不明时停在准备阶段，不退回主检出目录写入，也不盲目重复创建。
  超时可能只是响应丢失；核对原操作、目录、Git 状态和原生登记，确认结果后再推进。
  恢复不通过新任务、新 worktree 或新 Run 重置原预算、尝试记录或未决操作。
- worktree 隔离不覆盖外部服务、共享缓存、符号链接目标和全部文件系统权限。
  这些共享资源需要单独的写入约束；提示词、Git hook 或工作目录不能替代执行器级权限隔离。

## 逐仓库交付，按任务验收

开发完成后进入 [worktree 标准交付流程](../../skills/worktree-delivery/SKILL.md)，
不在本文复制另一套交付协议：

1. 每个仓库分别完成相关测试、独立审查及问题修正，固定待交付提交和证据。
2. 按授权确认集成目标和方式，以单写入者执行集成，再验证合入后的结果；
   commit、push、合并、部署和删除是不同结果与权限，不能互相推导。
3. 任务层核对跨仓库接口、版本兼容、依赖顺序及联合验证。
   跨仓库合入通常不是原子操作，应记录部分完成状态和后续负责人；一个仓库合并不等于整个任务完成。
4. 任务完成须满足原验收条件，明确各仓库交付状态和仍保留的资源。
   清理前确认没有未提交工作、未归档证据、活跃执行者或其他仓库的依赖，并取得相应授权。
   部署和服务重启始终单独授权。

## 当前实现状态

核对日 2026-11-07，`swarm-orca` main @ `be2d8c14`（M4 止血在分支 `sparse-task-m4`，未合并）。本节只记录“代码里有什么”，
不是验收结论；没有跑过的用例和没有授权过的原生闭环一律记为未验证。
阶段划分与退出条件见 [Sparse 任务工作区开发计划](sparse-task-workspace-development-plan.md)
和 [M0 契约冻结](sparse-task-workspace-m0-contract.md)。

### 已实现（M1–M2，任务 sparse 创建契约）

入口：`orca/src/main/ipc/sparse-task-workspace-create.ts`，被 runtime 本地创建
（`src/main/runtime/runtime-local-git-worktree-create.ts`）与 desktop IPC 本地创建共用。
只有请求里出现 `sparseCheckout.mode: 'task-workspace-v1'` 才进入该契约，legacy 全量与
legacy sparse 的行为、默认值和回滚策略不变。

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| 能力名与协商 | host 级声明 `worktree.sparse-task-workspace.v1`；能力缺失时调用方必须在发送前失败 | `src/shared/protocol-version.ts` |
| 固定基线 | base 只解析一次并固定为完整 commit SHA，创建使用该 SHA 而非移动 ref；与“检出既有分支”互斥 | commit `19a2e0ec` |
| 创建回执 | 成功时返回 `sparseCheckoutReceipt`：`baseSource`、`resolvedRef`、`pinnedSha`、`actualHead`、请求/实际 cone、`requiredPaths`；`actualHead !== pinnedSha` 或 cone 不符即不返回成功 | commit `19a2e0ec` |
| 目录严格解析 | 拒绝空/`.`/绝对路径/盘符/UNC/`..`/NUL/控制字符/首尾空白；≤128 个目录、UTF-8 ≤16 KiB | `src/main/git/sparse-task-input-validation.ts` |
| 树级校验 | 请求目录必须按 pinned tree 是 tree entry，blob/symlink/gitlink/缺失一律在 Git 副作用前失败；探针无法证明时 fail-closed | commit `84213496`、`5f3fb91b` |
| 必需路径门禁 | 调用方声明的 `requiredPaths`（如 `AGENTS.md`、角色 skill、构建/测试配置）创建后逐项核验，缺失即失败，不扩 cone、不回退全量；≤256 项、UTF-8 ≤32 KiB | `src/main/git/sparse-task-required-paths.ts` |
| 失败处置 | 任务模式不再自动回滚或强删分支，保留现场供诊断 | commit `84213496` |
| SSH 结论 | 远程稀疏序列仍无 pin 与回读，`worktree.create` 在注册 root 和任何 Git 副作用前以 `sparse_task_capability_required` 拒绝，不静默降级 | `src/main/ipc/worktree-remote.ts` |

### 未实现（M3–M5 与本文其余理念）

| 设计要素 | 现状 |
| --- | --- |
| 逻辑任务 ID、稳定身份路由 | 不存在。无 CLI 参数、无 schema、无持久记录；仍是设计概念 |
| 一任务多仓库绑定 | 不存在。`software-development-v1` 任务记录只有单值 `repository: {root, worktree, branch, base_commit}` |
| 跨入口 / 跨 runtime 续接 | 不存在。入口与任务无关联，也没有“同任务复用原绑定”的运行时校验 |
| 就绪门禁与副作用分离（M3） | 最小版已实现：带 `sparseTaskBinding` 的工作区在 runtime 后台终端、桌面终端与 Agent 会话创建前校验绑定/基线祖先/cone/必需路径，失败即拒绝（`sparse_task_start_gate_failed`）。仍未实现：移动端会话创建接入、跨宿主探针、拒绝结果的只读状态展示；`--setup run` 与就绪判定的组合未收紧 |
| 可恢复创建（M4） | 仅止血。任务模式失败后不再删除/回滚，并在失败路径上做只读判定（`absent`/`live`/`partial`/`unverifiable`）与 `[sparse_task_create_needs_reconciliation]` 标记；仍无客户端请求 ID、无持久回执、无 `create-status`、无重启后对账。响应丢失后不会删除，但残留需要人工按[对账手册](sparse-task-workspace-reconciliation.md)处理 |
| 任务绑定与交接（M5） | 未实现。worktree 元数据只存 `sparseDirectories`；`pinnedSha`、`actualHead`、`requiredPaths` 仅存在于单次创建回执，返回给调用方后不进任务/交接记录，交接无法被独立复核 |
| 写入硬隔离 | 未实现。cone 只是检出范围，不是写权限或授权边界；`cd`、提示词和 Git hook 都不构成隔离 |
| Swarm 侧接入 | 未接入任务模式。`swarm` 仍生成 legacy `--sparse-dir`（依赖原生 `orchestration.worker-sparse-checkout.v1`），不发送 `mode`，因此拿不到本契约的 pin 与回执 |

### 已文档化的约定层（非运行时强制）

第一层已经落地：`AGENTS.md` 要求新的独立修改任务从已确认基线创建专属 worktree，
`worktree-delivery` 技能规定逐仓库交付与清理，`swarm-orchestration` / 执行策略规定绑定与并发。
这些是入口 Agent 需要遵守的规则；任意 Project 的入口是否加载、是否照做，运行时不做检查。

### 未验证与已知缺口

- 无 sparse worktree 端到端创建实例，无 live Agent 闭环；本次更新也未执行任何用例，
  只有 `sparse-task-workspace-create.test.ts`、`runtime-local-git-worktree-task-sparse-entry.test.ts`、
  `sparse-task-required-paths.test.ts` 等定向用例存在。
- 只有本地创建路径受契约覆盖；WSL 与跨宿主的必需路径探针未接入，假缺失按 fail-closed 处理。
- Git 只在 2.39.5 实测；pinned tree 探针用 fatal UTF-8 解码，非 UTF-8 路径仓库会失败关闭。
- task 模式保留现场后仍没有恢复协议：只读判定与标记已实现，清理、重建与收养仍需人工按
  [对账手册](sparse-task-workspace-reconciliation.md)处置，且写操作需单独授权（完整 M4 未做）。

## 分层落地方向与当前边界

第一层是开发约定：通过入口 Agent 可读取的规则和技能，统一识别任务、准备 worktree、
固定绑定与执行交付。它依赖 Agent 遵守；仅在某个仓库放置规则，不能保证任意 Project 的入口都会加载。

第二层是 Orca 原生能力：在核验现有实现后复用工作区创建和 Agent 启动入口，补充逻辑任务的
持久绑定、跨入口路由、创建防重、启动/续接校验与聚合交付状态，不另造并行的执行事实来源。
若需要“禁止写到任务目录外”的硬保证，还须覆盖工具、Shell 和外部进程的实际权限边界。

Orca 已有 worktree 与工作区内终端的基础模型，见 [Worktrees](../../../orca/docs/site/content/docs/model/worktrees.mdx)。
这些基础能力不证明本文的自动意图识别、跨 Project 任务绑定、跨 runtime 续接或写入强制隔离已实现；
第二层目前只完成了创建期正确性（M1–M2），其余按上文“未实现”表逐项缺口推进。
本文只同步设计理念与实现状态；不修改原生 schema、启动器、已安装技能、现有会话或既有 Run，
也不迁移它们的 pins、验收标准及授权。后续实现与实际验收需分别记录。
