# Swarm 测试与验收指南

标准 ID：`swarm-reliability-v2`；维护日期：2026-11-03。
本文合并原测试指南与 live 验收协议，统一维护测试范围、分层、用例、通过条件和报告口径。
这是新验收计划的标准，不是某次运行结果，也不表示测试夹具已经实现或当前版本已经通过。
文档维护不授权启动 Agent、远端修改、故障注入、重启或训练。

## 1. 范围与版本

默认验证对象是 **strict bootstrap → Coordinator TUI → Operator lifecycle / monitor / scheduler**
的核心控制链，以及真实 Worker 协作与交付。角色规则由部署方交付，见[私有政策接入](../../configuration.md#部署政策与历史材料)，
运行契约见[启动门](../../coordinator-startup.md)、[生命周期](../../operator-startup.md)、
[TUI](../../coordinator-tui.md)和 [monitor](../../operator-monitor.md)。测试标准不替代或改写运行契约。

- 本文是当前测试标准的唯一正文，不再单独维护旧协议或迁移入口文件。
  历史 Run 仍按其原归档的固定版本/hash 判定，不改 pin、不把旧结果换名为 v2 PASS；见[版本边界](#legacy-live11)。
- v2 把确定性边界放到适合的测试层，真实 Agent 验收聚焦完整交付、协作、消息唤醒和故障处理。
  新 suite 可以包含预先声明的多个 Run；单个证据闭环仍必须保持其要求的原 Run/会话/身份连续性。
- 默认 profile 的通过不证明其他 provider、driver、固定 DAG Supervisor、跨 runtime 接管、Mac 离线长驻或性能收益。
  这些能力按[专项清单](../../acceptance.md)及对应运行契约另验。RSI 研究/训练收益还需目标仓库业务验收。
- 当前进展与历史报告由部署方私有维护，只记录各次尝试；文档合并不修改其结果、授权、部署或完成状态。

<a id="validation-strategy"></a>

## 2. 分层与覆盖

先用低成本、可复现的测试定位边界，再验证原生接口，最后让真实 Agent 完成少量有代表性的闭环。
不要求每次小改动跑完整 suite，也不允许用离线 mock 冒充真实唤醒或协作。

| 层 | 验证什么 | 证据与边界 |
| --- | --- | --- |
| D：确定性回归 | 状态机、授权/身份拒绝、截止期、竞态、防重、恢复分支 | 可用 mock、受控时钟与故障夹具；保存命令、基线、逐用例结果。只能证明被测逻辑。 |
| I：原生集成 | 真实 runtime/CLI 的等待、发送、查询、回执和身份行为 | 使用隔离且获准的真实资源；脚本可控制时序，但不能 mock 被验证的原生边界，不能冒充契约要求的 Agent/owner。 |
| L：真实 Agent 闭环 | 实际角色是否理解交接、正确协作、被唤醒并持续推进到终点 | 真实 Coordinator/Worker、原生回执、provider 回合、业务产物和独立审查；helper 成功或模型自述不足以通过。 |

### 核心能力到测试的映射

下表为 v2 默认完整核心 suite 的必测范围；用例细节见后文。现有测试文件只是回归入口示例，
不表示所有子场景已实现或本次已运行。缺少夹具/证据应报告缺口，不能因有同名测试就记 PASS。

| 能力或风险 | 必测层 / 用例 | 主要判据及现有回归入口 |
| --- | --- | --- |
| bootstrap 到运行期的责任交接 | D-contract、L-flow | **旧握手已删除（2026-11-13）**：现行启动授权是 [start grant](../design/start-grant.md)，交接面只剩 Run 建好后的 continuation（`tests/core/test_startup_cli.py`、`tests/coordinator/test_coordinator_tui_continue.py`） |
| 身份、授权、模式隔离与首派时效 | D-contract、I-gate-expiry；全部 L 的准入 | 原身份/pins 不变；过期、STOP、错误角色/路径、缺 lifecycle 不产生非法副作用。[native preflight](../../tests/core/test_native_preflight.py) |
| 并发、依赖汇合、独立审查与集成 | D-control、L-collaboration | 不超上限；乱序完成不提前集成；拒绝后返工、单写入者集成并复测。[worker plan](../../tests/coordinator/test_coordinator_worker_plan.py) |
| 忙时消息、空闲原生唤醒 | I-pending-history、L-events 的三个子项 | 不丢消息；逐条处理后完整 ACK；两种 idle 唤醒独立归因。 |
| 等待、发送竞争、未知结果与防重 | D-control、I-wait-boundary、I-presend-race、I-unknown-result | 未就绪不发送；未知结果先对账；恢复不重复副作用。[scheduler](../../tests/coordinator/test_coordinator_tui_scheduler.py) |
| 自动续跑、停滞止损与恢复 | D-control、L-flow、L-safety 的三个子项 | 有真实进展和合法 checkpoint；无进展有界停止；monitor 恢复后可继续且不重复。[recovery](../../tests/operators/test_operator_monitor_recovery.py)、[STOP](../../tests/core/test_monitor_stop_signals.py) |
| 业务验收、结算、释放与用量 | 全部 I/L 的共享收尾；L-flow/collaboration 正常完成 | 独立业务判据、完整资源盘点、角色/尝试台账及归档回读；失败/安全停止也必须交代资源去向。 |

**完整核心 suite PASS** 要求：D-contract、D-control 的全部必测分支，五项 I 的全部子场景，
以及 L-flow、L-collaboration、L-events 的三个子项、L-safety 的三个子项均 PASS；
所有参与尝试完成适用的独立证据审查、资源收尾、台账和归档核验。下面各组不是“任选其一”。
任何必测项缺失均不能称完整通过；定向回归只报告所测范围。未获并发或故障注入授权时，
报告相应用例 BLOCKED 或缩小本次声明范围，不将其记为 N/A 后声称完整 PASS。

日常回归按变更影响选择：先跑相关 D，涉及原生接口补 I，涉及角色交接/行为补 L。
已验证的不可变证据可在同一 suite 中复用，但必须可追溯到同一目标基线及适用配置；
变更影响不明时补验，不能拼接历史偶然通过项。离线通过不自动升级为 I/L 通过。

## 3. 分组运行，不切换既有契约

新 suite 在启动前建立清单，固定每项对应的 profile、模式、目标基线、Run/尝试和授权范围。
无需把所有场景挤进一条长 Run；也不需要新增生产测试窗口管理器。

| 组 | 固定模式与场景 | 组合规则 |
| --- | --- | --- |
| 自主运行组 | `autonomous`：L-flow、L-collaboration、L-events.busy、L-safety.monitor-restart | 前提兼容且已授权时可复用同一 Run；正常收尾最后执行。 |
| Worker 原生唤醒组 | `native-event`，source=`worker_done`：L-events.worker-idle | 使用专用 Run；该 Run 的 scheduler、通用事实提醒和恢复发送始终禁止。 |
| 外部事实原生唤醒组 | `native-event`，source=`external_fact`：L-events.external-idle | 使用另一专用 Run；固定 sender/事实触发，不能重签上一 Run 的 source。 |
| 故障与停止组 | 按故障前提固定模式：L-safety.worker-failure、L-safety.stop，以及有干扰的 I 场景 | 默认隔离运行，避免 STOP/故障污染正常交付或唤醒归因；不能为继续测试清除停止记录。 |

这是 **v2 suite 分组**，不是允许在同 Run 内修改 execution/source。当前
[执行策略](../../startup_execution.py)中 `native-event` 窗口过期也不会开启 scheduler；
因此它不能承担自动续跑或 monitor 重启后的自动发送验收。`manual` 明确为非自主模式，不能替代 L-flow。
monitor 健康、允许发送、允许自主等待、验收通过是四个不同结论。

所有组固定同一被验源码基线和匹配的 CLI/Server/Agent profile，分别记录合理的模式/配置差异。
每个子项的“idle → 触发 → 新回合 → 处理/ACK”、首派过期链和重启链不得跨 Run/尝试拼接。
默认按组顺序执行；分组不增加用户预算、总资源授权或并发许可，不能用换 Run 绕过限制。
代码变更后的受影响项需在新目标基线复验，旧失败仍保留；suite 汇总不能混用不兼容部署。

## 4. 真实 Agent 场景

每个场景先固定可观察的业务判据、可执行触发入口、时限和停止条件。下面规定行为及证据，
不声称已有一键脚本。没有受支持的触发或合法领域检查入口时，先报告测试能力缺口。

### L-flow：完整自主交付

选择一个有真实交付物、需要多阶段推进且能客观验收的小任务。由 Operator 一次性交付目标、
权限、预算与标准；Coordinator 自行规划和推进。Operator 可以履行必须的独立门禁/授权审查，
但不得逐轮指挥业务、补提示唤醒或代替 Coordinator 消费/派发。

必须证明同一 Run/Coordinator 会话内：

1. 真实双方 strict bootstrap、owner 确认候选、创建 Run；随后 Operator 首派 gate、Coordinator 自身复查和真实派发。
2. 首派后及时发布合法领域 checkpoint、receipt 和最终 continuation 引用；不先进入长时间 Worker 等待。
   lifecycle 准确投影后续责任，固定非 Agent sender 接收观察/获准调度职责，具备部署、首 tick 和当前 readiness 证据。
3. 同一 strict 身份至少三个已完成真实回合，其中包含两次完整 scheduler 自动续跑：
   合法 checkpoint / 实际回合结束 → scheduler send → 新回合 → claim → action → settle → 整批 ACK → 后续 checkpoint。
   动作须推进真实任务，不能用改名或等价 checkpoint 凑次数。
4. 交付物通过预先固定的业务检查和独立审查；完成原生结算、全部 Worker 释放、原 owner 正常退役及退役后核验。

`run_created` 只证明创建；`runtime_ready` 只证明当前交接和运行条件；`acceptance_complete`
还要业务验收和收尾证据。helper 不能强迫模型持续运行：交接未完成就 idle 时须准确暴露
缺失项和下一责任人，无合法恢复入口则阻断；不能将其称为“正常等待”或自主交付成功。
无 Worker 分支在 D-contract 验证其明确适用性，不用它替代本项的真实 Worker 链。

### L-collaboration：多 Worker 协作、审查返工与集成

预先设计两个可并行的真实子任务及一个依赖双方结果的集成任务，使用隔离 worktree 或明确无冲突
文件所有权。需要用户已确认 `max_workers >= 2`；这是本用例前提，不是调整其他任务的默认并发。

- 真实观察至少两个 Worker 生命周期重叠，实际并发不超授权；后派的子任务先完成，未完成依赖阻止集成。
  可用获准的有界完成屏障控制乱序，不靠反复启动 Worker 碰时序。
- 独立 Reviewer 按固定标准发现真实缺陷并拒绝该版本；Coordinator 消化意见、安排有界返工，
  新版本经独立复审通过。可将含已知缺陷的隔离测试版本交独立审查后真实修复，不要求模型偶然写出 bug，
  也不伪造失败、拒绝意见或审查结论；未触发拒绝则该分支 NON_HIT。
- 单写入者串行集成获准版本，集成后重新跑业务测试；不能用各分支单测代替合并后测试。
- 保存任务依赖、派发/完成顺序、并发时间线、产物版本、审查意见、返工和集成测试回执；
  Reviewer Worker 同样占用并发额度并需结算释放。累计启动数另统计，不把 `max_workers` 当累计上限。

本项可并入 L-flow 的同一 Run，但各判据分别核验；固定 DAG Supervisor 测试不能替代 strict 原生协作证据。

### L-events.busy：忙时消息不丢

独立确认 Coordinator busy 后发送两条独立事实。逐条证明 durable enqueue、Delivery、
消费/核验、可对应的处理或线程响应，最后完整 ACK 所属 Delivery。线程回复必须先于对应 ACK；
分属不同批次则分别取证。终端 inbox 空、模型说“已处理”或事后补回复均不足以通过。

<a id="live3-idle-wakeup"></a>

### L-events.worker-idle / external-idle：分别验证原生空闲唤醒

这两个子项承接旧 live-3 的行为目标，**均使用目标 fin_verl worktree 的
`fin-verl-rsi-coordinator`**，见[角色与工作区要求](#rsi-coordinator-workspace)。
v2 在两个固定 source 的专用 Run 中分别完成，不切换模式/身份；旧 live-3 的同 Run 要求仅按旧标准执行。

每项入窗前单独保存当前 checkpoint pin、Dispatch 或外部 sender/固定消息、触发入口、
预检有效期、证据 pins、有界等待和停止条件。这是测试取证记录，不是新生产 schema。
`trigger-ready` 仅证明其实际绑定范围的预检，不能证明当前 checkpoint 对应的 idle 或真实唤醒。
重试重新核验；旧回执尚未过期不代表本窗口已经取证，不自动覆盖/续期 owner 的预检输出。

1. **准备可控触发。** Worker 子项由 Coordinator 派发真实且有交付物的任务；优先使用获准的有界完成屏障。

   屏障规则（2026-11-04 由两次真实 attempt 得出）：
   - 任务书必须给出**具体等待秒数**与起算点（写 waiting 标记的时刻），不能只写"有界等待"；
     该值须覆盖本环境的 continuation 初始化 + monitor 首 tick + turn-end 审计目标窗口，
     并小于该 attempt 的 deadline。
   - 释放前置四件套缺一不可：`continuation-ref.json` 已发布、monitor 首 tick、`turn-end`
     回执、外层独立确认 Coordinator 原生 idle。未齐不得释放。
   - Worker 因屏障超时未获释放而结束，`worker_done` 只能报 `failed`，但在验收判定中
     记 `NON_HIT`（触发时机未命中），不得记为功能 `FAIL`，也不得据此推迟其他判据。

   Worker 完成实际工作后等待释放，再走原生完成流程。其他方法也须可靠控制“idle 后触发”并取证，
   不能仅靠固定 sleep 猜时序、伪造 worker_done、挂起无关进程或拿假产物充数。
   外部子项提前固定可用 sender、事实内容和原生发送入口；两者的原 Operator 均须独立审查相应 trigger-ready。
2. **合法结束回合。** 生成真实 RSI operational checkpoint，通过适用的 `check-authorized-progress` 与
   TUI `turn-end` 审计，然后实际结束回合，由外层独立确认同 TUI/strict 身份 idle。
   `turn-end` 成功本身不结束模型回合。依赖必须已经存在，不用未来任务占位，也不把 ready 的路径伪装成 dependency_running。
3. **检查隔离后触发一次。** 保留生命周期要求的观察型 monitor，不删除 continuation 或关闭 monitor 来绕过准入。
   对未知在途发送先按原请求对账；确认没有其他可归因的待发/未处理事件。
   Worker 子项只通过已审查入口释放屏障或触发等效完成条件，由 Worker 自身原生完成；
   外部子项只发送固定事实，未知结果只对账、不补发。
   隔离窗口禁止 scheduler、额外事实提醒和恢复发送。
4. **核验完整链。** 保存 `idle → 释放/发送 → durable enqueue → 新真实回合 → 消费/核验/处理 → 适用结算 → 整批 ACK`。
   Worker 须成功交付，外部事实须有可对应的响应/处理。busy 内 inline wait 收到事件不等于 idle 唤醒。

Worker 提前完成、事实到达时仍 busy 或混入其他唤醒源，该归因记 NON_HIT；若发生禁止发送，
同时记录隔离违规 FAIL，不能用 NON_HIT 掩盖。合法前提/入口受阻记 BLOCKED；单一 trigger
的预检拒绝不能推出原生消息无法唤醒。前提命中但观察期内预期行为未发生且证据完整，才判功能 FAIL。

### L-safety：失败、停止与 monitor 恢复

以下三个子项均需独立结果；仅“服务活着”或“被安全门拦住”不能代替未测的恢复行为。

| 子项 | 必须命中及通过条件 | 最小证据 |
| --- | --- | --- |
| `worker-failure` | 一个真实 Worker 原生报告失败或获准终止；Coordinator 不误报成功、不放行依赖，根据预定政策有界重试/替换后完成，或进入可审查的安全阻塞终点。 | 原失败 outcome、已知/未知状态判定、决策与预算依据、后续 Dispatch（若有）及产物/阻塞证据；无重复在途工作。 |
| `stop` | 有未完成工作时触发适用的真实 STOP；下一危险动作边界不再新增派发/发送/业务写入，不清 STOP 自动恢复；已有在途操作先对账、按原允许路径处置。 | STOP 原件、触发/观察时间、前后动作/资源清单、拒绝回执、原操作对账和停止后的观察窗口；不宣称 STOP 能瞬时撤销已发送操作。 |
| `monitor-restart` | 自主模式下获准停止并重启同 sender/state 的真实 monitor；保留 journal/request/动作记录，恢复后完成至少一次合法自动续跑且无重复发送/执行。 | 原进程退出、相同 sender/incarnation/state/config pins、启动/首 tick、持久记录对账、后续完整续跑证据。Server/runtime 换代不属于本项。 |

失败/STOP 子项的预期终点在尝试前固定，不能看到失败后任意改成“预期停止”。
安全阻塞可使该子项 PASS，但不等于恢复成功、正常业务交付或整个 suite 完成；
资源收尾单独审查，不能强行要求正常退役而绕过安全门。长期无输出不证明 Worker 已退出，
停滞、截止期和预算的各拒绝分支见 D-control，不靠反复启动模型等待自然命中。

## 5. 原生集成与确定性边界

I 层使用真实 runtime 的受支持入口，触发者与执行者仍须满足角色契约。
可以在隔离环境由脚本制造精确时序、屏蔽测试客户端收到的回复；不能伪造原生接受回执、
编辑数据库/outbox/head、篡改时间、身份或业务记录。所需故障控制入口不存在则 BLOCKED。
每项保留原生命令/回执、身份、时序、持久状态和副作用盘点；静态分析不算 I PASS。

| ID | 必测场景与通过条件 |
| --- | --- |
| `I-gate-expiry` | 同 Run 首次成功派发前，原 gate 自然过期 → 拒绝且无 Worker/Dispatch → 新一轮合法完整门检查 → 首派成功。不得修改 TTL/旧时间戳。有效期内因剩余窗口不足提前拒绝，或此前已成功首派，均 NON_HIT。 |
| `I-wait-boundary` | 真实运行 monitor 的 terminal wait 超时按未就绪处理；同 terminal/incarnation 的 busy→idle 边界上 busy 不错误发送，之后重观察并正确处理 idle。保留原始 timeout envelope、退出码/解析及后续回执；外层命令 timeout 不替代 monitor wait。 |
| `I-presend-race` | 分别覆盖新消息、busy/新回合、head 改变三种发送前竞争：真实 intent prepared 后、实际 send 前重观察发现变化，取消确定未发送的 intent，重观察后仅执行仍合法动作。取消回执不可变，原 request 无 send、无重复副作用；未知发送不当作未发送取消。 |
| `I-pending-history` | 实际 ACK 历史超过启动前固定的受支持 `inbox_limit`；精确 Run 的 pending 查询仍发现 pending 和 delivered-unacked，阻止新续跑，原 Coordinator 完整处理/ACK 后恢复。可在新测试配置中提前选较小合法窗口，不中途缩小窗口或伪造 ACK 历史。 |
| `I-unknown-result` | 分别验证创建、派发、发送的成功副作用已发生而客户端未取得确定回复：沿原 intent/request 对账到原对象，不创建第二份、不盲重试；不能仅模拟一个本地异常就算命中。查不到/仍未知时的禁止重试分支在 D-control 同时验证。 |

以下 D 分支全部必测；每个分支须在报告映射到实际测试 ID/结果，不能仅给整目录退出码：

- **D-contract：** 双方身份及独立审查、candidate/final 的 owner 发布、过期身份重验与心跳边界；
  错误角色/路径/hash/generation、STOP/截止期拒绝；Run 已创建而 Operator gate 缺失时正确指向 Operator；
  Coordinator 提前 idle、continuation 缺失、monitor 未启动/首 tick 后退出时不得误报 runtime_ready；
  显式无 Worker 分支；autonomous 缺 lifecycle 初始化失败，native-event/manual 始终不发送且原生窗口过期不转自主。
  bootstrap 具体观测点见[附录](#bootstrap-regressions)。
- **D-control：** 并发上限、依赖未满足、审查拒绝/返工和单写入者约束；pending/ACK 顺序、历史分页、
  wait 超时和全部 pre-send 竞争；创建/派发/发送的已确认、确定未发生和仍未知分支及防重；
  Worker 失败/失联/卡住、身份变化、STOP、各适用截止期和预算耗尽，重试耗尽后停止；
  monitor 重启/锁冲突/损坏或不匹配状态不盲恢复；无新事件、无进展时有界停止新增动作/模型调用。
  平台预算硬上限等尚无真实适配器的能力不能由本地计数测试推出已生效，须披露并另做专项验证。

生产路径没有实现的能力应报告为缺口，不能借固定 DAG 的同名测试为 strict 路径背书。
测试/fixture 可以补齐，但属于另行开发任务；本次标准整理不宣称已完成这些实现。

<a id="agent-quickstart"></a>

## 6. 执行前准备

1. **确认范围与授权。** 读目标 checkout 实际提供的 `AGENTS.md` 和本文，列明完整 v2、定向子项或旧版续验。
   固定原始授权来源、目标/业务判据、写入范围、消息/故障/重启许可、预算、时限、重试/停止条件及证据目录。
   缺授权证据是核验缺口，不推导用户否决；需要扩大范围再取得明确授权。
2. **固定资源与版本。** 用户确认正整数 `max_workers`，按实际依赖安排并行、计划峰值/累计尝试及未用满原因。
   记录 runtime、CLI/Server/Agent、repo/worktree ID、规范路径、分支、主仓库/子模块基线及脏改动、
   标准原件/hash、部署/配置 pins 和各组模式。本指南不提供可直接复用的历史 ID/固定主机命令。
3. **核验环境与角色。** 按仓库索引、`orca-cli` / `orchestration` 技能及版本匹配指南核验实际入口；
   不跨 runtime 借用能力。私有远端环境说明不随公开仓库发布；公开测试应使用显式配置的本地或 CI runtime。
   检查依赖与二进制，不自动下载、改链接或切换运行时。启动前读取 AGENTS.md 指定的模型/运行配置、
   执行规则、白名单、控制循环、启动门、台账/归档规则，并交付当前一致的可读副本。
4. **预检触发与取证。** 明确操作者、实际命令/cwd、观察点、预计新增证据和有界等待。
   先验证屏障、真实消息入口、故障窗口和领域 checkpoint 链可用，再启动受其依赖的 L 场景。
   首派 TTL 必须在首次派发前规划；正常收尾放在兼容场景结束后；用量从准备时采集。
5. **绑定真实会话。** Operator 先核验独立 Coordinator，Coordinator 自身创建 Run；首派双方分别检查。
   保存 terminal/incarnation、provider session、owner/consumer generation 和 monitor sender/state。
   观察快照不替代当前 caller 检查，runtime-state 不冒充宿主进程 attestation。复用/恢复按原契约核验
   身份、未决动作和证据范围，不因续验换会话、工作区或协议 pin。

<a id="rsi-coordinator-workspace"></a>

### fin_verl RSI：Coordinator 技能与工作区

L-events 的两个 idle 子项及旧 live-3 使用 `fin-verl-rsi-coordinator`。这是当前 TUI 领域适配器
支持 RSI checkpoint 回执链所需的合法回合结束前提，不是所有原生唤醒天然依赖 RSI。
其他场景同样需要其适用的合法领域契约；不假设已有 generic adapter，不借 RSI 回执代替非 RSI 授权。

- **先核验目标 worktree。** 固定 runtime/主机、repo ID、完整 worktree ID、规范根路径、分支和基线。
  新独立修改任务按部署方交付的 worktree 规则准备；同任务续验沿用原工作区，用户指定已有 worktree 时优先核验。
- **两端实际完整读 skill。** 目标仓库角色技能优先，按[部署交接](../../configuration.md#部署政策与历史材料)，
  在目标 worktree 含隐藏目录的入口发现 `fin-verl-rsi-coordinator/SKILL.md`。Operator 在交接前完整读取，
  Coordinator 在自身上下文通过文件工具完整读取 skill 及所需引用；保存绝对路径、SHA256 和两端读取记录。
  路径/hash、“已读”自述、通用 orchestration skill 或调用 checker 均不能替代实际角色 skill；它也不是 `--agent` 启动器名。
- **独立核对授权。** 从目标 worktree 完整读取 `rsi/authority.md`，逐字段继承用户原始授权，执行适用的
  `check-authority-handoff`、`check-authorized-progress`，固定独立审查的来源及路径权限 pin；不由待验交接反推原授权。
- **启动/复用均核验归属。** Coordinator cwd、交接、文件工具实际定位及 skill 必须对应同一规范工作区，
  并有原生会话回执；Operator 的 pwd、终端标题或相邻仓库副本不能证明归属。Worker 可使用获准的隔离 worktree。
  角色不可读/不兼容或归属不符时阻断依赖路径，不自动装 skill、复制身份、换目录或新加 adapter 绕过。

## 7. 证据、停止与收尾

每条证据记录带时区时间、来源路径/SHA256，以及适用的 Run/Task/Dispatch、turn/message/Delivery/request/action ID。
分别证明入队、真实回合、处理、响应、结算与 ACK，并核对禁止发送和重复副作用。
业务判据使用可检查的产物/测试和独立审查，不用 `met`、hash 变化或 helper 成功推导通过。
只有原 Run 的真实 Coordinator 消费/ACK、执行业务及其 owner 生命周期动作；Operator 仅做获准的
触发、观察和独立审查，不借身份代办，不逐轮提供业务指令。

每次尝试记录假设及与上次的变化。前提不变、无新事件或证据时停止重复核验，不通过等价 checkpoint
和模型空转凑进展；已有在途 Worker 则用原生等待/监控，超时或无输出不等于退出。
达到预算/期限/重试边界就停止相关新增动作，报告下一责任人、解除条件及未决资源。
runtime_access_denied、权限拒绝或连接失败按 AGENTS.md 保留原始错误并停止相关操作，不换入口绕过。

### 独立审查与资源收尾

正常交付：冻结证据供独立 Reviewer 审查 → 原生结算和整批 ACK → 核验精确 Run 无 pending/未决动作
→ 释放全部 Worker（含 Reviewer）→ 原 owner 正常退役 → 外层只读核验回执、资源与归档。
退役前的审查不能证明未来发生的退役，终端 inbox 空不能代替 Run pending=0。

失败/STOP：保留原状态与证据，按原契约允许的入口对账、处置和盘点；若 STOP/期限禁止后续写入，
就只读报告未结算/未释放资源及需谁授权或处理，不清门、强制退役或伪造正常完成。
用例的安全行为可 PASS，资源收尾仍可 BLOCKED；必需收尾未完成时 suite 不得 PASS。
安全停止的收尾完成指适用资源已合法处置、无无人负责的未决项且证据经独立审查，
不要求将停止的 Run 改成正常退役；不能丢弃失败尝试资源而只汇总成功尝试。

monitor 源码升级与单纯重启不同，旧 deployment pin 不自动有效；按[升级流程](../../operator-monitor.md)
独立审查同 sender/state 的新源码链，保留旧 plan/outbox/停止证据。fresh prepare 不等于升级或恢复授权。
Server/runtime 换代按[跨 runtime 专项](../../operator-monitor-cross-runtime.md)另验。

### 所有组共享的 accounting

- 从准备阶段固定 Operator、Coordinator、每次 Worker 的角色/会话/Dispatch 和采集基线，失败/替换尝试也计入。
  记录准备、启动、Run 创建、首工具、结算/释放、最终回复及审计等待时间；只知道首回合时间不冒充进程启动时间。
- 按[部署侧台账政策](../../configuration.md#部署政策与历史材料)交付请求数、真实回合、Token 原始计数、工具/等待耗时、用户上限、实际峰值和累计尝试。
  复用会话取本轮可核验差值，累计快照不相加；原始/标准化/计费口径分开，重叠耗时不相加冒充 wall time。
  未知不记 0，不用总耗时减工具耗时猜模型延迟；没有对照实验不承诺提速倍数。
- 释放前尝试最后用量快照，无法取得则保留 gap，不另开 Worker 补旧用量。
  角色/尝试清单、采集范围、已有来源和缺口披露为必需证据；不可取得的细分 Token/计费数据如实未知。
  独立审查说明缺口是否妨碍本次行为/资源结论；披露缺口不等于证明用量完整或成本达标。
- 按[部署侧归档政策](../../configuration.md#部署政策与历史材料)保存私有原件与脱敏报告；manifest 不包含自身，
  从实际归档路径回读所有列入文件并核对 SHA256。公开摘要放入 `swarm/docs/validation/reports/`，
  仅在获准负责续验时更新 current；不把运行结果回填本指南。

<a id="result-report"></a>

## 8. 结果与报告模板

| 状态 | 判定 |
| --- | --- |
| `NOT_RUN` | 未执行。 |
| `NON_HIT` | 已尝试，但关键前提/时序未命中；不能据此判功能失败，也不能掩盖已发生的违规。 |
| `PARTIAL` | 仅部分链路成立，缺少完整取证。 |
| `BLOCKED` | 明确的授权核验、入口、契约或依赖阻断；记录原始原因、解除条件及下一责任角色。 |
| `FAIL` | 前提已命中，真实证据表明违反固定预期；包括观察期内预期行为未发生且取证完整。 |
| `PASS` | 本用例所有判据及禁止行为检查有完整证据，经独立核验成立。 |

运行前固定观察窗口和可接受时延，不在看到结果后无限延长或改预期。不同状态的原因可并存，
例如唤醒归因 NON_HIT 而发送隔离 FAIL，应分别记录。确认的同基线缺陷不能被选择性重跑隐藏；
修复/解除原因、受影响复验和独立结论明确后才能关闭该问题。

报告头至少记录：suite ID、标准 ID/原件 hash、完整或定向范围、目标基线/脏改动及部署 pins、
profile/角色 skill、原授权/预算/期限、用户 `max_workers`、观察者/审查者及带时区起止时间。
另附分组清单，绑定各 Run、执行模式/source、会话/owner/generation、monitor sender/state 和配置 pins。
未创建 Run 的 D 用例填本地测试上下文，不能编造原生 ID。

| 用例 / 子场景 | 层 / 模式 / Run / 尝试 | 状态与时间窗 | 实际命令、原生 ID、证据路径 + SHA256 | 缺口、独立结论及下一责任人 |
| --- | --- | --- | --- | --- |
| 例：L-events.worker-idle | L / native-event:worker_done / 待绑定 / 1 | NOT_RUN | — | — |

完整 suite 须逐项列出 D-contract、D-control（附全部分支到测试 ID 的映射），
I-gate-expiry、I-wait-boundary、I-presend-race（3 类竞争）、I-pending-history、I-unknown-result（创建/派发/发送），
L-flow、L-collaboration、L-events.busy/worker-idle/external-idle、L-safety.worker-failure/stop/monitor-restart。
不得只填一行“全通过”；同一证据覆盖多个判据时引用原件，不重复计算回合/用量。

报告末尾分别给出：**用例结论、suite 覆盖结论、资源收尾结论、用量覆盖及归档校验结论**。
只有第 2 节必测项和共享收尾都满足才称“v2 核心 suite PASS”；它不等于全场景、跨运行时或业务收益保证。
定向验证明确未覆盖项；重试追加，不覆盖旧失败、旧 pin 或历史结果。

<a id="legacy-live11"></a>

## 9. 旧 11 项如何迁移

以下是新计划的覆盖映射，不是旧结果转换表。旧 Run 的原始标准/hash 优先，仍须按旧版
同 Run/会话及 11 项全部 live 的条件判定；新 v2 计划另行固定范围、预算和授权，不自动启动新资源。

| 旧 ID | v2 覆盖位置 | 变化 |
| --- | --- | --- |
| live-1、live-4 | L-flow | 保留身份连续、至少 3 个真实回合和两次自动续跑，纳入完整生命周期交付。 |
| live-2 | L-events.busy | 保留两条独立事实、响应/处理及整批 ACK。 |
| live-3 | L-events.worker-idle、external-idle | 保留两个真实 idle 唤醒闭环及 RSI 角色；改为各自固定 source 的专用 Run。 |
| live-5 | L-flow/collaboration 正常收尾 + 全组共享资源审查 | 正常交付仍须正常退役；安全停止另按停止契约收尾，不冒充业务成功。 |
| accounting | 全部 I/L 的共享台账与归档 | 从启动前采集，涵盖所有组及失败尝试。 |
| first-dispatch-ttl | I-gate-expiry + D-contract | 自然过期/刷新链仍需真实原生回执，不再强制计为独立 live Agent 项。 |
| terminal-wait-boundary、presend-race、pending-history | 对应 I 项 + D-control | 用受控原生集成命中边界；全分支离线回归，不能用 mock 冒充原生证据。 |
| monitor-restart | L-safety.monitor-restart + D-control | 保留真实重启后自动续跑，放在自主组，不与 native-event 隔离要求冲突。 |
| 原清单未显式要求的覆盖 | L-collaboration、L-safety.worker-failure/stop、I-unknown-result、D 分支 | 补并发协作、拒绝返工、故障/停止及未知操作对账，不宣称旧 suite 已覆盖。 |

旧标准以对应 Run 归档的原件及固定 hash 为准；Git 历史只用于追溯，找到的版本须与该 Run 的
pin 一致才能作为续验输入。缺少匹配原件时报告证据缺口，不用本文或其他 Run 的标准替代。
上述映射不恢复一份旧规范，也不自动将旧契约升级为 v2。

## 9.1 启动凭据（start grant）的验收位置

start grant 的断言不写在这里，写在设计文档自己那一节：
[start grant §4.1](../../docs/design/start-grant.md)。原因很简单——矩阵必须和它断言的字段、拒绝码、
计数口径住在同一份文件里，否则任何一处改动都会让两份文档给出两个答案。

已实现部分的验证口径（M1–M4，全部**离线**，不是 live 验收）：

| 层 | 断言所在 | 已执行 |
| --- | --- | --- |
| 存储与记录 | `orca/src/main/runtime/orchestration/{start-grant-policy,db/schema/start-grant-schema}.test.ts` | 20 例 |
| create 绑定 | `orca/…/rpc/methods/orchestration/runs/start-grant-create.test.ts` | 11 例（含双连接幂等/冲突） |
| mint/show/revoke | 同目录 `start-grant-mint.test.ts` | 10 例 |
| spawn 计数与范围 | `orca/src/main/runtime/orchestration/start-grant-spawn.test.ts` | 12 例（两处插入点、含收养路径） |
| Python mint/hand/state | `swarm/tests/core/test_start_grant.py` | 14 例 |

**live 进展（2026-11-14，定向）**：在 `orcad buildId dc15becfaf9c` 上跑过一次 grant 切片——mint、
hand、`strict-caller-check`、grant 绑定 `run-create`、同 grant 重放（`effectsApplied:false`、同一 Run）、
一个 Worker spawn（grant 投影 `workers{active:0,max:4}`）、撤销后再 spawn 被 `start_grant_revoked` 拒绝。
报告与原始读数在部署方归档，**不是** §2 的完整核心 suite。

**仍未验收**：`START_GRANT_REQUIRED` 打开后的迁移行为、deadline 自然过期、
`phantom{intent-without-output}` 投影、上限打满时的真实进程计数。上面每一行仍是离线信号；"第 9 个
Worker 被拒且没有终端进程"这类断言在离线层只能证明"没有请求创建终端"，真实进程计数必须另做 live 观察。
本文其它章节的 strict bootstrap 观测点仍然有效，但它们描述的实现路径已被
[start grant](../../docs/design/start-grant.md) 取代（协议正文的弃用横幅写明了范围）。

<a id="bootstrap-regressions"></a>

## 附录：strict bootstrap 定向回归观测点

以下保留原指南的修复复验要求，作为 D-contract 的具体分支和受影响 L-flow 的取证提示，
不另加一套 live suite，也不授权线上故障注入。本节只作历史观测点；现行启动授权以
[start grant](../design/start-grant.md) 为准（旧协议正文已归档）。

### 心跳与身份租期

区分心跳最近响应、30s 身份快照租期、原 attempt/任务/授权截止期：缓存心跳不续租；
只有完整身份重验成功才更新租期，不延长其他截止期。保留原角色/owner generation，记录跨租期
重验的签名心跳和原生身份查询时间线，不以连续 ready 自述替代；这不是 I-gate-expiry 命中。
临时重验超时暂停新写入，允许按契约只读 pull 返回 `identity_reverification_pending`，在原预算内观察；
后续完整重验成功才恢复原 ready/awaiting_arm。身份/pin/STOP 拒绝不降级，已关闭 owner 不自动 re-arm，未知提交只对账。

### 候选提交与 owner 最终发布

- fields、contract review、readiness review 按 `pull` 的 `submission.candidate_path` 写候选；
  Coordinator probe 按 `submission.outputs` 写各候选。`result_path/final_path` 只由 owner 发布。
  fields 使用返回 `candidate_template` 的绑定字段，review 的 decision/notes/reviewed_at 由原 Operator 独立填写。
- 六个动作使用返回的完整 `complete_argv`，或按低层契约显式固定原 intent/候选双 pin；不另造路径或手拼固定字段。
  保留 pull、原 intent/request、实际文件工具调用、完整提交调用/返回、原提交记录和 owner query 的最终 pin。
  核验候选/最终路径不同、字节相同且 confirmed；文件存在/submit 成功不替代 S3 独立审查、S4 真实 probe 和 readiness 审查。
- 重复 pull 的 complete_argv 为空，仅按 inspect_argv 对账，不重写候选、不重放部分批次。
  发现直写最终槽保留原件，不删除/覆盖或 reconcile 任意文件继续；这是来源缺口，不归因于 NAS、心跳或人工审批。
- 负例覆盖：非法 fields/review 在提交前拒绝；合法 reject 保留但不推进 marker；整批 probe 后项非法时前项不发布；
  部分发布/丢回复只查原记录不补发；历史 operation/submission 不升级。
  deadline/STOP 后 inspect-action 只读、不取 role 写锁、不重新 arm/执行，confirmed 仅说明历史持久化，不证明当前可准入。
