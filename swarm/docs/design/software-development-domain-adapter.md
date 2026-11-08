# Strict Swarm 软件开发领域适配：开发计划

## 状态、目标与范围

状态：已加入本地首版实现及确定性回归；独立实施审查、原生集成与 M4 真实闭环尚未完成。
接口版本与实际调用者见 [v1 schema](software-development-schema.md)。下文保留原开发计划与
完整验收标准，不将本地实现等同于全部阶段验收。本文不授权启动 Agent、部署、重启或迁移既有 Run。

目标：让 strict bootstrap → Coordinator TUI → continuation / monitor / scheduler
控制链能够推进普通软件开发任务，并依据代码、测试和独立审查证据判断进展。
首个业务接入候选是 [sparse-checkout 开发](sparse-task-workspace/history/sparse-checkout-proposal.md)，
其业务范围和验收仍以该任务单独固定的需求为准，不在适配器中硬编码。

本文所有代码与 skill 路径均相对 **`swarm-orca/` 仓库根目录**；
在嵌入式工作区中须在其前加 `swarm-orca/`。部署路径、实际模型配置、身份和运行证据
由部署方私有维护，不进入公开源码或示例。

首版仅覆盖已授权的代码、测试、文档修改及本地验证。明确不做：

- 第二套 Coordinator loop、调度器、消息消费器、权限系统或通用 shell 执行器。
- Orca Server / RPC 改造、非 strict exec driver 泛化、固定 DAG Supervisor 改造。
- 自动安装 skills、自动选择模型、自动扩大路径范围或自动创建/迁移 worktree。
- 隐含的 commit / push / 合入其他分支 / 部署 / 重启 / 删除工作区权限。
- 将非 RSI 任务包装成 RSI，或降低已有门禁以使其通过。

## 1. 现状与最小切入点

共享结构已经存在：`swarm/coordinator_loop.py` 的 `checkpoint_route()` 检查原始需求、
剩余路径、决策和下一责任人，`transition()` 检查前后进度关系。它们不认证领域证据，
也不授予权限，可以直接作为新领域的公共基础。

当前耦合点：

| 位置 | 当前行为 | 计划改动 |
| --- | --- | --- |
| `swarm/coordinator_tui_checkpoint.py` | `validate_domain()` 仅接受 RSI v1/v2，混合公共 pin/投影检查与 RSI 回执语义 | 保留公共检查；领域部分经静态适配入口分派 |
| `swarm/coordinator_tui_prepare.py` | `projection()` 固定 RSI adapter，输入仅支持现有领域绑定 | 接收已固定的领域绑定，经同一入口生成并验证投影 |
| `swarm/coordinator_tui_continue.py` | 配置白名单和 `authority_binding` 检查绑定 RSI | 增加显式版本化的领域配置；旧配置仍走原校验 |
| `swarm/coordinator_authority_bundle.py` | RSI v2 授权 bundle 与 progress 检查 | 保持 RSI 语义及历史兼容，不改名冒充软件开发授权 |
| `swarm/coordinator_tui_workflow.py`、`coordinator_tui_turn_end.py`、`coordinator_tui_scheduler.py` | 读取 source 的 `observed_at`，检查真实回合与首派时效 | 保持公共 source 外壳；审计调用链，必要时只改公共访问入口 |
| `swarm/coordinator_loop.py` 阶段提示及启动交接 | 存在 RSI 专属表述 | 仅对新软件开发契约注入适用领域说明，不重写历史 pinned prompt |

不能只放宽 adapter 名称检查：源证据、原需求、授权范围、当前回合和回执都必须有
适用的检查；也不能仅在 checkpoint 中写 adapter，让执行中的 Run 自行切换领域。

## 2. 复用优先的代码组织

首版预计只新增两个职责明确的 Python 模块，均仅使用标准库；名称为计划名称：

| 模块 | 职责 | 不承担的职责 |
| --- | --- | --- |
| `swarm/coordinator_domain.py`（新增） | 静态 adapter 注册、固定领域配置校验、公共投影/证据访问入口 | 不动态 import 任务提供的代码，不执行 checkpoint 中的命令 |
| `swarm/software_development.py`（新增） | 软件开发任务契约、progress/evidence 检查及薄 CLI 回执入口 | 不派发 Worker、不运行测试命令、不接管生命周期 |

RSI 的公共逻辑仅在确有两个调用者时提取；RSI 专属校验继续放在原模块，必要时封装函数，
不复制出第二份实现。避免为三个固定 adapter 引入插件框架、独立服务或新依赖。

必须复用的实现：

| 现有能力 | 复用方式 |
| --- | --- |
| `coordinator_loop.checkpoint_route / transition` | 统一结构路由及进度转换检查，领域 checker 追加证据约束 |
| `coordinator_io.py` | 严格 JSON、规范路径、范围内引用、raw/canonical hash、不可覆盖发布及既有锁工具；不再实现一套文件协议 |
| `coordinator_tui_checkpoint.validate_record` | prepare 发布前和后续读取时复用同一检查入口 |
| `coordinator_tui_prepare.py` | 保留独占初始化、重验及最后发布 continuation 引用的顺序 |
| TUI workflow / continuation / scheduler / turn-end | 复用 claim → action → settle → 整批 ACK 和当前回合检查，不另建软件开发专用续跑器 |
| strict bootstrap / startup / Operator lifecycle / monitor | 身份、owner/generation、首派门、STOP、截止期、发送防重及恢复边界不变 |
| Worker planner 与原生 Task / Dispatch | 复用并发及依赖管理；领域契约不再建另一份 Worker 调度状态 |
| 现有 unittest fixtures 与回归文件 | 参数化公共用例，补软件开发正反例；不复制整个 RSI 测试套件 |

实现前先列出新增逻辑对应的现有调用者。若某项修改需要重写上述控制链，应暂停并审查
抽象边界，而不是顺手扩大为框架重构。

## 3. 领域契约和证据

### 3.1 启动时固定的输入

新 adapter ID 拟定为 `software-development-v1`。新任务显式固定：

- adapter ID / 版本、checker 源码引用和适用角色 skill / reference 的路径与 hash。
- 原始目标、不可变验收条目、任务授权来源及外层独立核对记录。
- 已核验的 repo/worktree、分支、基线、初始 tracked/untracked 脏改动清单。
- 可读证据根、可写路径、排除路径、文件所有权及允许的操作类别。
- 已批准的预算、时限、重试/停止政策；未知额度不补成零或无限。

原始验收文档继续使用现有 `{"requirements": [...]}` 外壳；领域专属 scope、基线和
证据规则放在单独 pinned 契约中，不把领域字段塞进通用 acceptance schema。
同一分支有未提交修改时，必须同时固定相关文件内容/差异和未跟踪文件，不能只记录 HEAD。
初始脏改动不自动归本任务所有；重叠写入需明确归属，不覆盖或清理无关改动。

领域选择必须绑定到启动交接和 continuation 配置，checkpoint 中的选择只允许与之相等。
M0 冻结新输入/config 的 schema 版本及字段表；不通过删除字段回退历史模式。
旧 RSI 配置、回执、Run pins 按原版本读取；不自动迁移或重新解释。

### 3.2 公共外壳与软件开发证据

保持 source 中的公共字段：`requirements`、`paths`、`barriers`、`decision`、
`next_action`，以及当前回合所需的 `observed_at` 和 Run 绑定。
领域证据单独表达代码快照、验证结果及审查，不能让 scheduler 学习软件测试报告格式。

每项完成证据至少可追溯到：

- **产物：** 基线和被测代码快照、变更清单、实际文件内容 hash、适用需求 ID。
- **验证：** 实际命令、cwd、起止时间、退出码、输出/报告引用、被测快照及执行者来源。
- **审查：** 独立 Reviewer 身份/Dispatch、审查对象快照、发现、返工及复审结论。
- **行动：** 对应 action / Task / Dispatch 和输入、输出引用；只使用真实存在的原生对象。

checker 不执行命令，也不把退出码 0 自动等同于需求满足。无适用自动测试的条目应在
原验收中明确替代验证方法。代码在测试或审查后发生相关变化，旧证据不能证明新产物通过。
早期 checkpoint 可以合法表示未完成需求，不要求首回合就具备最终测试和审查结果。

### 3.3 检查顺序与边界

1. 检查固定配置、路径范围和引用，再读取文件；覆盖 traversal、符号链接逃逸、hash 漂移。
2. 检查原始需求、任务/Run 绑定和软件开发 scope 一致，不从待验回执反推授权。
3. 调用共享结构路由与适用的前后转换检查，拒绝遗漏需求、虚构等待或等价 checkpoint 冒充进展。
4. 检查证据绑定、相关快照、测试/审查覆盖、越界变更和已知未决操作。
5. 生成不可覆盖、绑定输入和 checker 版本的检查回执；消费端重验 pins 和必要的一致性。

文件 hash 与自报的成功 JSON 不认证真实执行。测试、原生身份和独立审查仍须有可回读的
工具/运行记录及外层审计；checker 只声明其实际验证的范围，并明确不授予权限。
不为软件开发伪造 RSI `authority_check`、`authority_sha256` 或 `context_sha256`。

`complete` 表示业务需求证据满足、可进入独立收尾审查，不等于资源已经退役。
最终交付仍通过现有生命周期核验结算、pending/未决操作、Worker 释放、用量和归档。
没有独立就位的真实 Operator/Coordinator、profile 未获准或门禁缺失，仍应阻断启动；
领域适配器不解决或绕过这些独立前置条件。

## 4. Skills：明确位置与读取方式

### 4.1 唯一源码位置

只新增 **一个** 软件开发领域 skill，以角色 references 区分职责；不先为三个角色各造
一套重复编排规则。下列“新增”文件均为后续开发产物，本计划提交不创建它们。

| 路径（相对 `swarm-orca/`） | 状态 | 内容 / 读取者 |
| --- | --- | --- |
| `swarm/skills/software-development/SKILL.md` | 新增 | 领域入口、任务契约、角色路由、证据和 checker 使用规则；Operator、Coordinator、开发 Worker、Reviewer 均完整读取 |
| `swarm/skills/software-development/references/coordinator.md` | 新增 | 需求拆解、文件所有权、依赖、checkpoint、返工及完成判断；Operator 和 Coordinator 读取 |
| `swarm/skills/software-development/references/implementation.md` | 新增 | 范围内修改、复用优先、测试和证据交付；开发 Worker 读取 |
| `swarm/skills/software-development/references/review.md` | 新增 | 独立审查、被审快照、拒绝/复审和验收证据；Reviewer 读取 |
| `swarm/skills/swarm-orchestration/SKILL.md` | 复用 | 通用身份、启动、派发、续跑、恢复及记账规则 |
| `swarm/skills/worktree-delivery/SKILL.md` | 复用 | 通用审查、单写入者整合、整合后复测、单独授权的发布和清理 |
| `orca/skills/orca-cli/SKILL.md`、`orca/skills/orchestration/SKILL.md` | 复用，不改 | 版本匹配的原生 CLI、任务、消息与生命周期入口 |

不放到 `orca/skills/` 上游快照，不放到嵌入式工作区的私有 `swarm/` 目录，
不复制到 `.agents/skills`、`.pi/` 或用户全局目录维护第二份源码。
新领域 skill 通过相对链接引用通用 skills 和协议，不复制它们的命令/schema 正文。
创建 skill 时按可用的 skill-creator 流程执行；本轮只是约定文件布局。

### 4.2 发现、交接和加载

- 在仓库根 `AGENTS.md` 的 Skills 表新增上述领域入口；在 `swarm/README.md` 增加导航。
  这些是明确的仓库读取入口，不宣称 Pi、Trae 或其他 harness 自动发现它们。
- Operator 在已核验目标 checkout 中发现并完整读取 skill 和所需 references，
  固定规范绝对路径及 raw-byte SHA256；Coordinator 在自身上下文再次读取。
  Worker 交接固定同一 `SKILL.md` 和该角色 reference，不以“已读”自述替代工具证据。
- 若目标仓库有更具体的领域技能，先遵守其 AGENTS.md 和角色发现规则，再明确选择兼容入口；
  多候选不取第一个、不从相邻 worktree 借文件。
- strict 交接沿现有角色材料/读取证据链传递引用。若现有 schema 不能表达共享 skill +
  角色 references，仅扩展该读取入口；不能借此改造非 strict `coordinator_driver.py`。
  后者当前的 RSI 专属发现逻辑不是通用软件开发 skill 已自动加载的证明。
- 第一版以本仓库作为目标。跨仓库分发、全局安装和自动同步不在本计划内；
  稀疏工作区必须在启动前确认所需 skill、引用及测试依赖均存在，不自动扩大 checkout。

## 5. 开发顺序和职责划分

| 阶段 | 交付物 | 进入下一阶段的条件 |
| --- | --- | --- |
| M0：冻结契约与复用清单 | 输入/输出/schema 版本、RSI 兼容表、实际调用链、公共与领域检查边界；先补拒绝用例 | 审查确认无第二套控制链、无隐式降级；证据与 skill 绑定方案明确 |
| M1：提取最小适配入口 | `coordinator_domain.py`，原 RSI 检查的薄封装及调用方接入 | RSI 历史用例行为保持；未知/冲突 adapter 拒绝；旧 pins 不重写 |
| M2：软件开发领域实现 | `software_development.py`、prepare/config 接入、领域 skill 和三份角色 reference | 初始/中途/完成 checkpoint 正反例通过；实际来源缺失不可冒充验收 |
| M3：整条控制链定向回归 | prepare → workflow → turn-end → scheduler 的软件开发用例、文档和独立审查 | 无时效/身份/防重退化；单写入者整合后重新测试 |
| M4：获准后的真实验收 | 一个小型真实软件开发任务的 strict 闭环，再接 sparse-checkout 原任务 | 对应业务证据、续跑、独立审查和收尾通过；未测部分单列 |

适配器尚未实现时，可在另行确认的执行范围内用普通开发 Agent 完成 M0–M3，
不能将该前置开发描述为新适配器已支持的 strict Swarm 验收。

需要并行时，先冻结接口，再分检查器、控制链接入、测试/文档三块，独立 Reviewer 按需加入。
实际模型、并发和预算取任务批准的私有配置。Reviewer、集成及嵌套 Worker 均计入同一
`max_workers`，不要求始终满员。用户选择同一分支时按文件划分写入所有权，
公共入口由单写入者串行整合，不能让多个 Worker 同时改相同模块。

## 6. 测试与验收

遵循 [Swarm 测试与验收指南](../testing/reliability.md)，区分确定性回归、原生集成
和真实 Agent 闭环。以下是计划，不是已执行结果。

### 确定性回归

新增 `swarm/tests/test_coordinator_domain.py`、`swarm/tests/test_software_development.py`，
并扩展现有 `test_coordinator_tui_*.py`、相应 startup/handoff 回归。优先复用 fixtures。

必测分支：

- RSI v1/v2 原行为、软件开发显式选择、未知 adapter、绑定冲突、删除字段降级、历史配置不迁移。
- 原需求遗漏/改写；首回合合法未完成；无实际依赖的 wait；有可行路径却报 blocked；虚假 complete。
- 越界读写、符号链接逃逸、输入/skill/checker pin 漂移、初始脏改动保护、缺失的未跟踪文件快照。
- 测试失败/未运行/日志缺失、证据不属于本任务、代码在测试或审查后变化、非独立审查、拒绝后未复审。
- source 投影不一致、旧回合/未来时间、不同 Run/generation、未检查证据直接交给 prepare。
- 初始化中断保留现场、最后发布引用、重复 claim 不重复执行、未知发送只对账、settle/ACK 顺序不变。
- STOP、截止期、缺 lifecycle/monitor、并发与依赖约束不因新 adapter 放松；已有测试覆盖不等于此次已运行。
- skill 入口/reference 可解析、角色材料与实际引用一致；结构检查不冒充完整阅读或行为验收。

从 `swarm-orca/swarm/` 执行仓库标准离线回归（实施时记录逐项覆盖与结果）：

```bash
env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
  PYTHONPATH=.:tests python3 -B -m unittest discover -s tests -q
```

### 原生集成与真实 Agent

仅在明确授权、输入齐备且版本匹配后运行。先验证新领域配置和真实身份/回执接入；
再按指南 L-flow 选择有真实产物的小任务，证明同一 Run/Coordinator 至少三个完成回合、
两次完整自动续跑、真实 Worker 交付、独立审查及合法资源收尾。不能用手工逐轮提示凑续跑。

本轮适配器验收只声明软件开发的定向范围。不将新领域结果替换指南中现有 RSI 专属
idle 唤醒用例，也不未经版本化修订就宣称整个 v2 suite PASS。
服务 ready、helper 成功、模型自述或离线测试通过都不是上述真实闭环的替代证据。

## 7. 完成标准与交付边界

- 公共控制链只有一份；新增逻辑限于显式领域选择、软件开发契约/证据及必要交接。
- 旧 RSI 固定配置和受影响回归保持兼容，软件开发不能通过伪造 RSI 回执进入流程。
- 新 skill 和 references 位于第 4 节唯一位置，AGENTS/README 入口和相对链接有效，
  实际交接保留精确文件 pin 与角色读取证据。
- 原需求、权限范围、测试快照与独立审查贯通；业务完成和生命周期收尾分别报告。
- 提供独立审查、整合后测试、真实验收范围、资源去向、用量与证据缺口。
- 第一版不以修改或重启 Orca Server 为默认步骤；若原生集成发现必须修复的 runtime 缺陷，
  另列窄范围方案及测试，部署/重启仍单独授权。

适配器实现和验收完成后，才把它用于 sparse-checkout 原任务；不将适配器交付计作
sparse-checkout 功能已经实现，也不借本计划扩大原任务授权。
