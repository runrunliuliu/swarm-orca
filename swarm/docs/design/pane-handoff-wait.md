# 对端等待（pane handoff / peer wait）：用原生阻塞取代 sleep 轮询（实施方案）

状态：**P1–P5 已实现并过离线回归（§7 第 1–4 条）；P6 与 live 对照（§7 第 5–6 条）未执行**。本文只给诊断、
设计、实现包与验收判据，**不构成**部署、重启、启动 Agent、修改运行中 attempt/Run 或放宽任何 gate 的授权；
也不授权在主检出落地。等待的授权语义仍以
[strict 启动](../../coordinator-strict-start.md)、[Operator 启动](../../operator-startup.md) 与
[strict bootstrap 协议](../../strict-bootstrap-protocol.md) 为准，本文与它们冲突时以它们为准。

关联：[发布等待](publication-wait.md)（同一族的 inotify 原语）、[阻塞隔离](blocking-isolation.md)
（deadline 与探测次数口径）、[strict bootstrap liveness](strict-bootstrap-liveness.md)（D3「用模型回合
当传输层」的原始分析）、[TUI 契约](../../coordinator-tui.md)、[Operator 监视](../../operator-monitor.md)、
[swarm-orchestration skill](../../skills/swarm-orchestration/SKILL.md)。
实现位置（计划）：`swarm/wait_pane.py`（新）、`swarm/wait_for_file.py`（新）、
`swarm/wait_for_events.py`、`swarm/terminal_idle_wait.py`、`swarm/operator_monitor.py`。

## 0. 一页结论

1. **病灶不是"模型爱 sleep"，是三个对端通道里只有一个有阻塞形态，而文档只写了那一个。** 一个 agent 想
   知道"另一个 pane 那一回合干完了吗""另一个进程把 marker 写了吗""我这个命名的 mailbox 有消息吗"，
   只有第三件有处方（`check --wait`），前两件没有任何允许的形态，于是自创"sleep → 看一眼屏幕"。
2. **三件都不需要改 orca runtime。** 本机实测（2026-11-12，runtime `0adaf9a9…`）：
   `terminal wait --for tui-idle` 在忙 pane 上按 `--timeout-ms` **真阻塞**（5000 ms → 5.110 s 后
   `{"error":{"code":"timeout"}}`），空闲 pane **0.106 s** 返回 `satisfied: true`；
   `orchestration check --wait` 在**未绑 Run** 的 pane 上同样阻塞（3000 ms → 3.121 s，空批）；
   `terminal send --wait-submit` 已能给出 `input_accepted` → `turn_started`。
3. **明确不做 `--for output-change`**，见 §4.3。PTY 输出是 token/spinner 级事件，用它唤醒 = 把模型叫醒来
   干不了任何事，且部分输出不能当决策点；成本（改 runtime + 新事件语义）全花在错误的信号上。
4. **分三层，每层只有一种允许形态**（§4）：T1 mailbox（`orchestration send` + `check --wait`）→
   T2 文件发布（`wait_for_file.py`，inotify 提前唤醒 + deadline 兜底）→ T3 pane 回合边界
   （`terminal send --wait-submit` + `terminal wait --for tui-idle`）。屏幕抓取 + `sleep` 的组合在三层
   全部禁用。**但三层只覆盖“对端 handoff”，不声称覆盖全部等待**：人工决策、外部长任务、gate 协议验收、
   本地进程退出都属于其它契约（§4.1 表），拿 T3 冒充它们就是假阳性。
5. **一条协议级根因**：strict bootstrap 的角色交接目前把 TUI 当 RPC —— "在你的 pane 里执行这段命令，把
   JSON 贴回来"，返回值只能从屏幕文本里读出来。只要这句还在，T1/T2 只能覆盖一部分等待。**本文的建议是
   让命令结果走文件 + pin（T2），而不是"贴回来"**；这属于协议建议，落地需另立任务，不随本文实施。
6. **首个必须修的既有缺陷**：`wait_for_events.py` 在本机 runtime 上**无法区分超时与空批**（§3.4）。
7. **评审带来的两个硬修正**（§11）：I2 从“先有 `turn_started`”收紧为“**绑定到同一次输入**的
   `turn_started`，否则 `unverifiable`”；P3 不得把“旁观看到 bus”当 turn 证据。而且这不是理论风险：
   本机 `--wait-submit` 对 trae 只返回 `provider: "unsupported"`，**今天就拿不到 `turn_started`**（R7）。

## 1. 现场证据（live attempt，2026-11-12）

证据来源：pane `term_7704acec-…`（`π - strict-live-pi`）的会话转录
`~/.pi/agent/sessions/--mnt-…-strict-live-pi--/2026-11-12T11-19-03-093Z_*.jsonl`，只读取 `bash` 工具调用。

**全会话 19 次带 `sleep` 的调用，累计 1554 s 盲等（约 25.9 分钟）**；会话墙钟 11:19–12:04，即该 pane
超过一半的存活时间在盲等。其中 12 次 `N>=60`，合计 1445 s。下表只列前 24 分钟窗口（12 次 / 604 s）；
11:49 之后另有 7 次（130/120/150/150/150/90/160，合计 950 s），形态与表中后几行相同，不重复列举。

| 时刻 (Z) | `sleep` | 等的东西 | 当时可用的阻塞通道 |
| --- | --- | --- | --- |
| 11:23:40 | 12 | 另一 pane 出现 hook 行 / `last-status.json` | 无（非 agent 进程写文件） |
| 11:23:55 | 8 | 另一 pane 屏幕 | 有（tui-idle 长等待） |
| 11:24:16 | 25 | agent-hooks 行 + 新 transcript 文件 | 无 |
| 11:24:57 | 30 | 同上 | 无 |
| 11:36:46 | 20 | `/proc` 里找本 pane pid | 无（自身启动，非对端） |
| 11:37:22 | **90** | `bootstrap-attempt1/coordinator/` 发布 | 有（inotify 未暴露） |
| 11:41:06 | 6 | 后台 `bootstrap_tool.py serve` 起没起来 | 有（文件发布） |
| 11:41:25 | 8 | 同上（`/tmp/slp-a1/owner.sock`） | 有（文件/套接字发布） |
| 11:41:54 | **75** | 另一 pane 屏幕（S2 observation） | 有（tui-idle 长等待） |
| 11:43:22 | **120** | 另一 pane 屏幕 + `events/` 目录 | 有（两者都有） |
| 11:45:38 | **100** | `events/` 目录 + 屏幕 | 有（两者都有） |
| 11:47:26 | **110** | 等 S2 marker | 有（文件发布 / mailbox） |

其中 **12 次 ≥60 s、共 1445 s 直接违反仓库既有规则**（含表中 5 次）
[SKILL.md:113–124](../../skills/swarm-orchestration/SKILL.md)（"`sleep N`，`N>=60` … 不是等待策略"）
与 [coordinator-strict-start.md:516](../../coordinator-strict-start.md)、
[operator-startup.md:379](../../operator-startup.md) 的同一段。规则没有拦住，因为它是文档约束，
运行时没有任何门禁（§5 P6）。

三个 pane 当时**均未绑定 Run**（`orchestration run-list` 42 条无一条 `coordinator_handle` 命中；
`terminal show` 无 `runId`）。这曾被当作"`check --wait` 不适用"的理由——**实测是错的**，
未绑 Run 的 terminal 也有 mailbox（`run_unbound`），`--peek` 与 `--wait` 都正常返回（§2）。

## 2. 能力实测（2026-11-12，本机）

| 探针 | 命令 | 结果 |
| --- | --- | --- |
| 忙 pane 的长等待 | `terminal wait --terminal <busy> --for tui-idle --timeout-ms 5000` | **5.110 s**，`ok:false`，`error.code = "timeout"` |
| 空闲 pane | 同上（`<idle>`） | **0.106 s**，`wait.satisfied = true`，`status:"running"` |
| 未绑 Run 的 mailbox 阻塞 | `orchestration check --terminal <unbound> --wait --timeout-ms 3000` | **3.121 s**，`ok:true`，`messages: []`，`count: 0` |
| 未绑 Run 的只读枚举 | `orchestration check --terminal <unbound> --peek` | `ok:true`，`count: 0` |
| 运行时自带指南 | `/opt/orca/current/cli/index.cjs` 内嵌 | 明写 `--for tui-idle --timeout-ms 60000` / `300000` |
| 提交证明 | `terminal send --help` | `--wait-submit` 分离 `input_accepted` 与 `turn_started` |

结论：**长阻塞等待在 runtime 侧早已就绪，缺口全在仓库侧**（封装、文档、门禁），不需要改 orca runtime，
也不需要新事件类型。

> 独立评审的限制：上表三行延迟与下文 §1 的 sleep 计数都是**操作者实测**，两位评阅者均只复核了
> CLI 契约与可推翻的部分（见 §11）：`run-list`/`5.110 s`/`0.106 s`/`3.121 s` 被标为“未重跑”或“无法验证”。
> 引用这些数字时要连“谁测的”一起写，不得当独立证据。

## 3. 缺口（为什么 agent 只能 sleep）

### 3.1 封装把上限钉死在 1 s

`swarm/terminal_idle_wait.py` 的 `NATIVE_WAIT_MS = 1000`（当前 21 行）；`idle_wait_args()`（当前 43–47 行）
只接受**一个精确 argv**（8 个元素、`--timeout-ms 1000`、无额外 flag），`idle_wait_target()`（当前 82–85 行）
做同一比较（以上三处行号为 P2 改动前的形态，P2 之后为 `idle_wait_args(terminal, wait_ms=…)` 与
`_idle_wait()`/`idle_wait_target()` 的结构化识别）。调用点：

- `coordinator_tui_scheduler.py:55`：调度器每 tick 一次 1 s 探测；它本身就是轮询者，不在本文范围；
- `startup_handoff.py:256`：`call(idle_wait_args(...), runtime, 20)` —— native 等待 1 s、RPC 预算 20 s；
- `operator_monitor.py` 的 `native()` 内 `idle_wait_target(args)`（当前 116 行）：**反向识别** CLI 的命令行，命中才走
  `decode_idle_wait()`；不命中退到通用 `decode_response()`（**不是静默**：两个要求
  `IdleWaitResult` 的调用方会以 `tui_idle_state_unavailable` fail-closed，见 R5）；
- `supervisor/watchdog.py` 的 `tick()` 内写死 1 s argv 的 `terminal wait`（当前 47 行）：它不是 `idle_wait_args()`
  的调用方，用的是**自己的** native reader（`supervisor/orca.py` 的 `read()`，当前 57 行，带独立 runtime pin），
  **不受 P2 影响**；而且它已经在执行本文要求的 I2：当前 66–70 行的 `sent = self.op("wake:…", ["terminal", "send", …, "--wait-submit", "10"])`
  与紧随的判定要求 `turn_started` 出现在 `stages` 里，否则 `prompt_submission_unproven` 并停。
  **这是仓内已有的正确先例，P3 应直接对齐它。**


所以“仓库自己的封装”在设计上**永远不可能**等超过 1 s，agent 想长等只能绕开封装自己写 `sleep`。
修改必须同时改 `idle_wait_args()` 与 `idle_wait_target()`（§5 P2）。

### 3.2 文档只承认一种等待

`coordinator-strict-start.md:516`、`operator-startup.md:379`、`SKILL.md:113` 三处措辞一致：**只**允许
`orchestration check --wait`，并把 `sleep`、轮询 inbox、循环重读文件列为禁用。对
"另一个 pane 那一回合干完了吗"没有任何允许形态——这是文档的**空白**，不是 agent 的违抗。
写明的规则和实际可用的通道之间差了一整类等待，agent 只能自创。

### 3.3 协议把 TUI 当 RPC

live attempt 的交接是"在你的 pane 里执行 `python3 coordinator_launch.py … advance …`，把完整 JSON 贴回来"。
返回值只有屏幕文本一条路，于是**接收方唯一能做的事就是隔一段时间读一次屏幕**。这条不改，
T1/T2 只能覆盖 marker、mailbox 一类等待，覆盖不了"让对端执行命令并取回结果"。

**建议（不在本文实施）**：命令结果写到固定路径 + pin（`result.json` + sha256），交接语变成
"执行后把 `result.json` 的路径与 sha 贴回来"，接收方用 T2 阻塞等文件、再 `file_ref` 校验。
文字回传仍可保留，但不再是唯一证据来源。

### 3.4 既有缺陷：`wait_for_events.py` 在本机 runtime 上分不清超时与空批

`classify()` 在 `wait_for_events.py`（当前 154 行；`timed_out()` 当前 127–129 行，P1 新增的
`timed_out_by_elapsed()` 在 132 行）依赖 `returncode == 124` 或回包里的 `timedOut`/`timeout`。
本机实测 `check --wait --timeout-ms 3000` 超时返回 **`ok:true` + `count:0` + 无 `timedOut` 键 + exit 0**，
于是被分类为 `EMPTY(3)` 而不是 `TIMEOUT(124)`。这与该脚本自己的契约
（"`TIMEOUT` 是它自己的状态，不是'没有消息'"）矛盾：调用方无法区分"等了 300 s 什么都没来"和
"这是一批空投递"。**P1 先修这个**，否则上游任何"再等一次"的判断都建立在错误分类上。

### 3.5 观察到的形状（待确认，不作断言）

不带 `--ack` 的 `check --wait` 回包里出现了 `result.mutation.requestId`（`replayed:false`）。这不影响本文
设计，但在把 `--wait` 当纯只读等待之前，应确认该 mutation 是否产生持久副作用、以及重复调用是否应使用
`--retry-request`。**在确认前，实现只把 `check --wait` 当"枚举 + 阻塞"，不改任何写路径。**

## 4. 设计

### 4.1 三层通道与唯一形态

| 层 | 用途 | 唯一允许形态 | 覆盖 live attempt 的哪些 sleep | 用于 handoff 交付？ |
| --- | --- | --- | --- | --- |
| **T1 mailbox** | agent ↔ agent 的消息与结果回传（含未绑 Run 的 `run_unbound`） | `orchestration send` 发出；接收方 `check --wait --timeout-ms ≤300000` 单片阻塞，`--types` 只决定唤醒 | 110 s 那次（marker/结果回传） | **是，且是默认**：`--type handoff` + 接收侧 `check --peek --wait`（不消费） |
| **T2 文件发布** | 非 agent 进程（`bootstrap_tool.py serve`、gate 发布者）与命令结果落盘 | `swarm/wait_for_file.py --path <p> --timeout-ms N`：inotify 提前唤醒，deadline 兜底 | 90 / 6 / 8 / 100 / 120 中的文件部分，以及 3.3 改造后的命令结果 | 否（阶段文件走 `strict-bootstrap-wait-stage`，路径只能来自 layout） |
| **T3 pane 回合边界** | 必须经 TUI 的交互（人工 prompt、trust/update/approval 提示） | `terminal send --wait-submit N` 取得 `turn_started`，再 `terminal wait --for tui-idle --timeout-ms N` | 12 / 8 / 75 / 120 / 100 的屏幕读 | 否：只剩原生启动 prompt 与人工交互；provider 报 `unsupported` 时拿不到 `turn_started` |

**「投递者身份」不属于三层通道**：三层回答「怎么等」，「这份 handoff 是谁发的」是第四个维度，由接收侧
把投递行 `from_handle` 与 pin 的 `operator.terminal` 比对（自洽检查，防误填/防事故，不防冒充），见
[handoff 通道设计](strict-handoff-channel.md)。把身份断言当成「等到了」或「等对了」是另一类假阳性。

三层**只覆盖“对端 handoff”可自动阻塞的通道**，**不**声称覆盖全部等待。以下四类**明确不属于本文范围**，
遇到时必须走各自的契约（blocked / domain status / 协议验收），**不得**用 T3 冒充完成：

| 不属于本文的等待 | 正确做法 |
| --- | --- |
| 等人工输入/审批/信任弹窗 | T3 只能检出 `blockedReason` 并转人工（`interaction_required`），不是“等待完成” |
| 等外部长任务（训练、远程 job、服务健康收敛） | 领域状态 + checklist，不得用“文件出现”代替完成 |
| 等 gate ready / strict 阶段门 | 以 `gate-ready.json` 等 pinned 产物 + 协议校验为准；`tui-idle` 不是阶段门 |
| 等本地子进程退出 | `terminal wait --for exit` 或操作系统 `wait`，不是 peer wait |

在三层内，屏幕抓取 + `sleep`、`sleep N (N>=60)`、反复 `terminal read` 轮询、循环重读同一文件全部禁用
（与既有三处文档一致，只是把禁用面扩到“等另一个 pane”）。

### 4.2 不变量

| # | 不变量 | 为什么 |
| --- | --- | --- |
| I1 | **唤醒不是回执**。任何一层返回后，仍须复核 marker/`file_ref`/原生 settle 状态 | 与 `blocking-isolation.md` 同源；tui-idle 只说明"TUI 空闲"，不说明任务对或做完 |
| I2 | `tui-idle` 必须**绑定到同一次输入的 `turn_started`**（或等价的、能绑定到目标 terminal+incarnation 的 turn-boundary 证据）才允许作为完成判据；拿不到就只输出 `unverifiable`（含“从未观察到本次回合开始”这一子情形） | 对端尚未开始工作时它本来就是 idle；旁观的 `terminal show` 轮询也不是 turn 证据（两评审独立同结论，见 §11） |
| I3 | 每个等待自带 deadline，且 deadline 由**调用方**给出并赢过任何内部兜底 | 沿用发布等待的铁律：事件只能缩短等待，不能定义等待 |
| I4 | 单次阻塞 ≤300 s（仓库策略），被唤醒/超时后重新进片，不得单次要求 900 s | 与 `check --wait` 的既有口径一致，保证"被打断"与"挂住"可区分 |
| I5 | 诊断只输出 `kind`/`events`/`timeouts`/`fallback_seconds`/`elapsed_ms`，不放路径、载荷、消息内容；**例外**：允许输出调用方自己提交的 `request_id`（用于说明等的是哪一次提交），它不是对端载荷 | 与 `observation_budget`、`publication_wait.log` 同一原则 |
| I6 | 老 host 能力缺失时 **fail closed**，不回退 `sleep`、不回退屏幕抓取 | "优雅降级到 sleep"会把今天的病灶固化进契约 |
| I7 | 本组工具只读：不 `--ack`、不 `reply`、不 `worker-*`、不改变任何运行中 attempt | 等待不是授权 |

### 4.3 明确不做：`--for output-change`

- 输出事件是 token/spinner 级，唤醒频率远高于进度频率 → 醒来无事可做，正是要消灭的失效模式；
- 部分输出不可作为决策点，最终判据仍是"回合结束"或"产物落盘"；
- 需要改 orca runtime 并引入新事件语义，成本最高、收益最低。

## 5. 实现包

顺序固定 **P1 → P2 → (P3 ∥ P4) → P5 →（可选）P6**，每包自带回退方式。

### P1 `wait_for_events.py` 超时分类（最小，先做）

- 改动：`swarm/wait_for_events.py` `classify()`/`timed_out()`。
- 判据：`returncode == 124` 或 `timedOut` 键（保持）**或**
  【`returncode == 0` ∧ 回包结构完整 ∧ 消息集为空 ∧ `monotonic` elapsed ≥ `timeout_ms - TOLERANCE_MS`】
  （新增；`TOLERANCE_MS` 建议 200，可测定）。三者任一 → `TIMEOUT(124)`。
- **边界（评审补充，必测）**：
  - 外层 `timeout N` 杀掉脚本、被信号截断、JSON 半包 → **不得**补判为 TIMEOUT，应为 transport/被杀（非 0/2）；
  - CLI 提前 10 ms 返回空批时不得被误判：容差只向“已用满”一侧放宽；
  - 调用方的 deadline 必须大于 CLI timeout，否则本脚本永远看不到完整回包（写进 `--help` 与测试）。
- 测试：`tests/core/test_wait_for_events.py` 新增回包形状（124 / `timedOut:true` / 本机实测形状 / 半包 /
  外层 SIGTERM / 提前 10 ms 返回）。
- 回退：单文件，行为收紧，回退等于恢复旧分类。
- 依赖：无。**这一包独立于其余包，可先单独合入。**

### P2 `terminal_idle_wait.py` 参数化

- 改动：`idle_wait_args(terminal, wait_ms=NATIVE_WAIT_MS)`；`NATIVE_WAIT_MS` 保留为默认值（1 s，调度器语义
  不变）；新增上限常量 `MAX_NATIVE_WAIT_MS`（建议 300000，与 I4 同值）与
  `MIN_RPC_TIMEOUT_SECONDS` 的公式化（`ceil(wait_ms/1000) + 11`，沿用现有注释里的
  "+5000 原生、+6000 CLI" 预算）。
- 联动：`operator_monitor.py` 的 `native()` 内 `idle_wait_target(args)`（当前 116 行）改为按 argv 结构识别并**读出** `--timeout-ms`，
  不再要求等于 1000；识别不出即 `None`（维持“不是等待命令”的现有分支），不得放宽成“像就认”。
- 边界（评审补充）：`supervisor/watchdog.py` 的 `tick()` 内写死 1 s argv 的 `terminal wait`（当前 47 行）
  走自己的 reader（`supervisor/orca.py` 的 `read()`，当前 57 行），**不得**被本包改到；它已有的 `turn_started`
  纪律（当前 66–70 行）是 P3 的参照。
- 测试：`tests/operators/test_operator_monitor*.py`（1000/30000/300000、非法值、参数顺序、额外 flag）、
  `tests/coordinator/test_coordinator_tui*.py`（调度器仍用 1 s 默认值，行为不变）。
- 回退：`startup_handoff.py:256`、`coordinator_tui_scheduler.py:55` 均不传参 → 行为与今天逐字节一致。

### P3 `swarm/wait_pane.py`（新，agent 直接可调）

职责：把 T3 的一次交接做成**一次**工具调用；但**它不是完成判据**，只负责“有边界地等一个回合边界”。

```
wait_pane.py --terminal H [--turn-evidence F] [--idle-timeout 300] [--json]
```

- 阶段 A（turn 证据，**必须是强证据**）：接受 `terminal send --wait-submit` 的 receipt（`--turn-evidence`），
  要求 `stages` 含 `turn_started`、`requestId`，且回执必须**绑定到目标 terminal**：一次 `terminal show`
  （身份读取，不是进度探测）给出 `ptyId`/`incarnationId`，回执的 `processIncarnation` 必须指向同一个
  活进程。**两种拼法都认**：`terminal send` 回执今天写的是裸 `incarnationId`
  （`getTerminalPromptRequestBinding().processIncarnation`），编排侧记录写的是 `ptyId:incarnationId`
  （`getTerminalProcessIncarnation`）——同名字段两种形状，只认一种会让这个通道对真实 pane 永久
  不可用（2026-11-13 实测：组合式比较 vs 裸 id，每次 `exit 4 turn_evidence_incarnation_mismatch`）。
  回执没有点名 pane（`send.handle`/`prompt.terminalHandle` 都为空）而只带裸 id → `turn_evidence_unbound`，
  因为裸 id 单独不能证明它来自我们要等的那个 pane；组合式自带 `ptyId`，可以单独绑定。
  `runtimeId:ptyId:generation` 这种降级形**永不接受**（generation 不是 incarnation）。
  没有这个文件 → 退出码 4 `unverifiable`。**不把“轮询 `terminal show` 看到工作中”当成 turn 证据**
  （那是旁观者的猜测；两评审均指出这一点）。对齐仓内先例 `supervisor/watchdog.py` 的 `tick()` 内
  `--wait-submit` + `turn_started` 判定（当前 66–70 行）。
- 阶段 B（回合结束）：一次 `terminal wait --for tui-idle --timeout-ms <idle>`；超时 → 124；
  出现 `blockedReason`（现成的 `BLOCKED_REASONS`）→ 5 并**只**输出 reason 枚举，不输出屏幕内容。
- 不变量：无论返回什么，调用方仍须复核产物（I1）。工具不发送输入、不 `ack`、不写文件。
- 测试：`tests/core/test_wait_pane.py`（假 CLI 夹具）：turn_started→idle；**无 evidence → 4**；
  evidence 但 incarnation 不符 → 4；blocked → 5；timeout → 124。夹具的回执默认必须是**真实形状**
  （`send.handle` + 裸 `incarnationId`），否则“夹具两侧自己拼成一致”会把这个分歧藏起来——这正是
  2026-11-13 修的那条缺陷的成因。
- 回退：新文件，删除即无影响。

### P4 `swarm/wait_for_file.py`（新，T2 出口）

职责：把 `publication_wait` 的 inotify 原语暴露给 shell 调用方。

```
wait_for_file.py --path P [--mode appear|change] [--timeout-ms N] [--json]
```

- 直接复用 `publication_wait.Watcher` / `watch()` / `idle()` / `log()`：**不新增原语**，
  兜底周期沿用 `FALLBACK_SECONDS = 1.5`（无 inotify 时为 `POLL_SECONDS = 0.25`，即等于改动前）。
- **前置检查（评审补充）**：父目录或路径不可达时立即退出 4，不得退化成“watch() 返回 None → 轮询到超时”。
- `--mode change`：以 `st_mtime_ns + st_size` 为判据；**已知边界**：不捕获“同尺寸同 mtime 精度的内容改写”，
  对 socket/目录不适用，对非原子写入（partial write）会提前返回 → 返回后仍须 `file_ref`/schema 校验（I1）。
  写者应使用 write-then-rename 或 close-write 发布。
- 退出码与 `wait_for_events.py` 对齐：0 出现/变化，124 超时，2 用法/传输失败，4 路径不存在且父目录不存在。
- 测试：`tests/core/test_wait_for_file.py`，复用 `tests/publication_wait_fixture.py` 的
  `PollingWatcher`（该夹具的 250 ms 假周期保证断言与既有样例一致）。
- 回退：新文件。

### P5 文档同步（三处 + 一处注册）

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `swarm/skills/swarm-orchestration/SKILL.md` | §"Waiting: one blocking call, never a blind sleep"（113–140） | 把"唯一形式"改成**按层选形态**的三行表（T1/T2/T3）；补 I2（先 `turn_started` 再 `tui-idle`）；明确 `--for output-change` 不是本仓选项 |
| `swarm/coordinator-strict-start.md` | §"等待的唯一形式"（516–525） | 同上，指向本文 |
| `swarm/operator-startup.md` | §"等待的唯一形式"（379–388） | 同上 |
| `swarm/README.md` | 「配套参考」表（71 行 `publication-wait` 行之后） | 新增一行：对端等待的设计，**开头就写`草案、未实现`**，否则读者会去调用尚不存在的 `wait_pane.py` / `wait_for_file.py` |

三处现有文字**保留**（`check --wait` 的规则不变），只在其后追加"对端 pane 与文件发布"两小节；
避免把已有纪律改写成模糊表述。

### P6（可选）运行时门禁

pi pre-tool hook 拒绝 `sleep N` 且 `N>=30` 的 `bash` 调用，回显三层替代形态。前置条件：P3/P4 已可用
（否则只是把 sleep 换成报错）。

- **阈值与现有纪律的关系**（评审要求写清）：仓内文档的禁用线是 `N>=60`，本包取 30 是**更严**的运行侧选择，
  理由是把“又快又没用的唤醒”也算进去；因此它**必须**：只作用在 agent 交接场景（交互式 pane 会话），
  不影响脚本内 backoff、`service_finish.py`、`bootstrap_s5.py` 等进程内轮询，并提供显式 allowlist。
- 实现位置属 agent 运行侧（`~/.pi/agent/extensions/`），**不进本仓**；本仓只记录“该门禁存在时，禁用清单与
  文档一致”的对应关系。

## 6. 契约汇总

| 工具 | 0 | 3 | 4 | 5 | 124 | 2 |
| --- | --- | --- | --- | --- | --- | --- |
| `wait_for_events.py`（既有，P1 修） | 有消息 | 空批 | — | — | 超时 | 用法/传输 |
| `wait_for_file.py`（新） | 出现/变化 | — | 目标不可达 | — | 超时 | 用法/传输 |
| `wait_pane.py`（新） | 回合结束 | — | `unverifiable`（无 turn 证据） | 需要人工交互 | 超时 | 用法/传输 |

三者共用：单行 JSON 到 stdout、诊断到 stderr、无 shell 侧副作用（I7）。

## 7. 验收

**离线（必须全绿）**

1. `bash swarm/tests/run_offline.sh` 全量；
2. 新增 `tests/core/test_wait_pane.py`、`test_wait_for_file.py`，扩 `test_wait_for_events.py`；
3. `operator_monitor` argv 识别：1000/30000/300000 三档都识别，非法 argv 一律 `None`；
4. `coordinator_tui_scheduler` 与 `startup_handoff` 的调用参数**未变**（用现有夹具断言 argv 逐字节相同）。

**live（另获授权后）**

5. 在真实 strict-bootstrap attempt 上取一组对照：同一交接，旧形态（`sleep 110` → 读屏幕）与新形态
   （`wait_pane.py --idle-timeout 300`）各一次，记录墙钟与探测次数；
6. 通过标准（本文的收益口径，不是全局 KPI）：
   - 单次交接的**模型往返**：旧 3 次（send / sleep / read）→ 新 ≤2 次；
   - 单次交接的**盲等**：旧 ≥110 s → 新 = 对端实际工作时长 ±1 s；
   - 会话级 `sleep>=60` 从 **12 次（1445 s）**降到 0（可由转录直接计数，不依赖自述）；
   - 无任何新机制、无新持久状态、无 `ack`/`reply`/`worker-*` 调用。

**本次评审自带的一组真实观测（2026-11-12 20:00，非构造场景）**

起草后立即执行了一次两评审并发派发，过程本身就是 T3 的一次 live 演练：

| 观测 | 值 | 含义 |
| --- | --- | --- |
| codex-ark 的 `terminal wait --for tui-idle --timeout-ms 300000` | 单次阻塞 **2m46s** 返回 | 一次调用完成等待，零 `sleep` |
| trae 的同一命令 | 单次阻塞 **1m12s** 返回 | 同上 |
| `terminal send --wait-submit 30` → trae | `stages: [input_accepted]`，`provider: "unsupported"`，`observation: "unsupported"` | **该 provider 在本机拿不到 `turn_started`** → I2 不可满足，P3 必须返回 `unverifiable`，不得当完成 |
| 两仓库交付后核对 | `swarm-orca` 0 行变更；`orca_src` 仅本次之前就存在的 3 项脏数据 | 只读边界成立 |

第三行是本次评审最有价值的意外收获：它把 R7 从“假设风险”变成了**已观测事实**。

## 8. 风险与已接受的代价

- **R1 `tui-idle` 不是“干完了”**。一个提前结束回合的 pane 看起来同样空闲（live attempt 里就有
  “预检并回报缺失输入”这类即时回合）。接受理由：它是**调度**原语，不是验收原语；I1 + I2 保证必须先有
  **同一次**的 `turn_started`，唤醒后仍校验产物。代价是每次唤醒后多一次校验读。
- **R2 长阻塞占用一个模型回合**。300 s 的阻塞期间该 pane 无法做别的事，且被打断时与“挂住”难分。
  接受理由：I4 把单片压到 300 s；需要并行时用多个 pane，而不是把等待拆成 sleep。
- **R3 未绑 Run 的 mailbox 形态未在文档中出现过**。实测可用（§2），但 `run_unbound` 的语义、
  空闲唤醒是否与绑 Run 一致、`mutation.requestId`（§3.5）都**未确认**。因此 T1 在 P1–P5 中**不作为强制
  路径**，只作为“比屏幕更好”的选项；确认前不改任何写路径。
- **R4 老 host 能力缺失**。`idle_wait` 长超时、`--wait-submit` 的 `turn_started` 都在新 host 才有；
  老 host 报 `old-host`/拒绝。按 I6 **fail closed**：报错并停，不回退 sleep。代价是旧环境下交接必须
  人工介入。
- **R5 `operator_monitor` 的耦合**。它靠 CLI 命令行反向识别调度命令，P2 放宽 argv 后若识别写错，
  后果**不是“静默丢目标”**（评审分歧已裁决）：`monitor` 自身会退到通用 `decode_response()`，而两个
  要求 `IdleWaitResult` 的调用方（`coordinator_tui_scheduler.py:55`、`startup_handoff.py:256`）会以
  `tui_idle_state_unavailable` **fail-closed**；真正的损失是“专用解码不再执行”，属于可观察的行为变化
  而非静默。`supervisor/watchdog.py` 另有独立 reader，不受影响。缓解：P2 单测必须覆盖
  “识别不出 → `None`”与既有分支的等价性。
- **R6 本文是方案，不是收益证明**。§7 的“1554 s → 实际工作时长”是**推算**；只有 §7 第 5–6 条 live 对照
  才是证据。在此之前不得向任何 Run/报告声称“等待已优化”。
- **R7 provider/agent 不提供可绑定的 `turn_started`**（**已观测，非假设**）。本机 `--wait-submit` 对 trae 返回
  `provider: "unsupported"` / `observation: "unsupported"`，只有 `input_accepted`。此时 T3 **不能**给出完成
  判据，只能 `unverifiable`；把 `tui-idle` 当完成会直接退化成“屏幕 sleep + 看一眼”的假阳性。
  **这一项足以推翻“任何 pane 交接都能换成 wait_pane 成功判定”的强结论。**
- **R8 runtime/入口漂移**。评审期间，一个评审者用 `/home/tiger/.local/bin/orca-server-cli` 看到
  `run-list` 返回 `runtime_unavailable`，另一个用 `orca` 看到 42 条 Run；同一会话里 shim 又报
  `stale_bootstrap`。方案不改 runtime 仍成立，但**证据与验收命令必须固定入口、环境与失败口径**，
  否则“未绑 Run / mailbox 可用”这类结论不可重放。

## 9. 不做 / 不授权

- 不改 orca runtime，不加 `terminal wait --for output-change`；
- 不修改、不重启、不迁移任何运行中的 attempt/Run/pane；本文的实测只做只读 RPC（`wait`/`check --peek`/
  `--wait` 不 `ack`）；
- 不改 scheduler 的 1 s 默认值与 `startup_handoff` 的 20 s RPC 预算；
- 不把 `sleep` 从既有 helper 里删除（`coordinator_driver.py:689/698` 的 `wait_poll_seconds ≤ 60`、
  `service_finish.py`、`bootstrap_s5.py` 属于**进程内**轮询，不是 agent 回合等待，另立任务）；
- 不部署、不重启、不更新远端副本。

## 10. 顺序、体量与依赖

| 包 | 内容 | 体量 | 依赖 | 合入后即可用的收益 |
| --- | --- | --- | --- | --- |
| P1 | 超时分类 | S（1 文件 + 测试） | 无 | 上游"再等一次"的判断不再建在错误分类上 |
| P2 | idle 参数化 | S/M（1 文件 + monitor 联动 + 测试） | 无 | 长等可用，且不改调度器语义 |
| P3 | `wait_pane.py` | M（新文件 + 夹具） | P2 | 75/120/100 那三次屏幕读变为 1 次阻塞调用 |
| P4 | `wait_for_file.py` | M（新文件 + 测试） | 无（复用 `publication_wait`） | 90/100/120 的文件部分、serve 启动探测 |
| P5 | 文档三处 + 注册 | S | P3/P4 契约定稿 | 规则不再留空白，agent 不需要自创 |
| P6 | hook 门禁 | S（不进本仓） | P3/P4 | 违规转成"报错 + 正确形态提示" |

P1 与 P4 彼此独立，可先行；P3 依赖 P2 的上限常量保持一致。全部为 Python 辅助脚本 + 文档，
**不修改 Server 服务包，不需要重启 Orca 服务**；只有后续调用更新后脚本的会话采用新形态，
运行中进程与既有 Run 不热更新。

## 11. 评审记录（2026-11-12，两评审独立并行，一次交换）

固定形状记录（[Discussion 协议](../../skills/swarm-orchestration/references/discussion.md) §7）。

1. **决策与基线**：是否按本文的三层设计 + P1–P6 落地；基线为本文件起草时的 `swarm-orca`
   `main@ca0756b8`（该 ref 在创建交付 worktree 时已前进到 `main@1e826a9d`，含 `pi-provider-channel`
   合入；落地 worktree 的 pin 为 `1e826a9d`，本文所有 `file:line` 已在 `1e826a9d` 上重校）。
2. **选项与证据**：`A 维持现状（sleep 轮询）` / `B 三层设计（本文）` / `C 只做 A 层文件等待`。
   证据：§1 转录（19 次 / 1554 s）、§2 CLI 契约与实测、仓内先例 `supervisor/watchdog.py:66-70`。
3. **未决点**：R3（`run_unbound` 语义与 `mutation.requestId`）、R7（`turn_started` 可得性）、
   R8（runtime 入口漂移）。
4. **结论与理由**：`approve-with-changes`（两评审一致）。三条硬修正：
   - I2/P3 必须绑定**同一次**输入对应的 `turn_started`；拿不到只允许 `unverifiable`；
   - “三层之外不存在第四种形态”收窄为“只覆盖对端 handoff”，并列明四类非范围（§4.1）；
   - P1 的 elapsed 补判必须带容差，并明确外层超时/信号/半包**不得**被判为 TIMEOUT。
   另有 4 处行号漂移与 3 处边界补充（P4 父目录与 partial write、P6 阈值口径、P5 注册行标注草案）。
5. **结束状态**：`decided`（已按上述修正改写本文；修正项见上）。
6. **下一步 owner 与依据**：原决策 owner（用户）持有落地授权；本文的修正不扩大任何权限，
   落地仍需指定 repo/base/worktree。
7. **失效与重开条件**：R7 若在某 provider 上被证明可取到 `turn_started`，T3 可用范围需要重评；
   R3 若证明 `run_unbound` 唤醒与绑 Run 不等价，T1 降级为“仅枚举”；
   `terminal wait --for` 若新增条件（例如 `output-change`），§4.3 的结论需要重开。
8. **归档状态**：`pending archival`（正文在本次回答与草稿文件中；尚未进仓库）。

**独立性四要素**

| 事实 | 观测 |
| --- | --- |
| 作者隔离 | 两评审均非本文作者，未参与起草 |
| 草稿可见性 | 并行启动、同一 brief、互相不可见；明确禁止读 `/tmp/slp-draft/review-*.md` |
| 上下文暴露 | 同一 brief、同一仓库、同一草稿；**live 数字两者都只有二手信息**（均标"未重跑/无法验证"） |
| 模型多样性 | **弱**：两者均为 GPT-5.5 家族（codex v0.163 `gpt-5-5/260423` medium；Trae CLI 0.214.1 `GPT-5.5 (MAX)` xhigh）。差异来自 harness、effort 与工具集，不构成跨模型佐证 |

**两评审的分歧与裁决**（已在本文件中就地改掉，无需第二轮交换）

| 分歧 | codex-ark | trae | 裁决（读代码后确定） |
| --- | --- | --- | --- |
| P2 漏改识别逻辑的后果 | 监控**静默**失去目标 | 不一定静默，会 fail-closed 或形状不符 | trae 更接近：`operator_monitor.native()` 退到通用 `decode_response()`；两个要求 `IdleWaitResult` 的调用方以 `tui_idle_state_unavailable` fail-closed；`supervisor/watchdog.py` 有自己的 reader，不受影响。改法见 R5 |
| 三层覆盖面 | “覆盖全部”过强 | 同 | 采纳：收窄为 peer handoff 三类通道 + 四类非范围表 |

**两评审共同未验证的事项**（继承为本文的未验证项）：§2 的 5.110 s / 0.106 s / 3.121 s 延迟；
`run-list` 42 条无命中的实时复核（一方因 `runtime_unavailable` 未能执行）；老 host 能力；
live 对照验收。这些都是本文**不得**声称已证明的部分。
