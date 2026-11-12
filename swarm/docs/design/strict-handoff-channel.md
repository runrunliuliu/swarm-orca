# Strict bootstrap handoff：通道选择、阶段等待与投递者溯源（设计）

状态：**阶段一只写设计，未实现、未验收**。本文给问题、证据形态、三个改动的方案与被否方案、
typed code 表、验收判据、不变量与未决决策；**不构成**部署、重启、启动 Agent、修改运行中
attempt/Run 的授权，也不授权在主检出落地。协议正文仍以
[strict-bootstrap-protocol.md](../../strict-bootstrap-protocol.md) 为准；本文与它冲突时以协议为准。
本文**没有**产生任何 live 证据：所有「现场」条目是对一份已脱敏记录的复述，原始记录在部署方私有
材料中。

关联：[liveness 与失败分类](strict-bootstrap-liveness.md)（D3「用模型回合当传输层」）、
[对端等待](pane-handoff-wait.md)（三层通道与各自不证明什么）、
[投递台账](delivery-ledger.md)（channel 必须先分开计量；本文不实现它的游标）、
[strict 启动](../../coordinator-strict-start.md)、[Operator 启动](../../operator-startup.md)、
[swarm-orchestration skill](../../skills/swarm-orchestration/SKILL.md)。

## 0. 一页结论

1. **证据模型没问题**：字节 + 固定 pin + owner 提交 + 独立复核仍然成立，本次不碰它。
   事故里 pin 全绿、字节正确，坏的是**通道**、**等待形式**、**投递者身份**这三处。
2. **① 通道选择**：handoff 的常规且唯一通道是 mailbox（`orchestration send --type handoff` →
   对端 `check --wait`）。`terminal send --enter`（steering，即 PTY 文本注入）只在两种情形合法：
   原生启动回合的短 prompt，以及发送方**持有自己那一次提交的回合边界证据**；其余一律 mailbox。
   误用后的处置是「去重 + 等一次边界」，**不是重发**（只允许 `handoff_id`/`payload_sha256`/`refs`/
   `subject` 全同的 same-handoff copy）。当前 pi/trae 都拿不到 `turn_started`，所以那个「边界证据」
   分支实际不可用（§3.1.2 R4b）。
3. **② 阶段等待入口**：新增 `strict-bootstrap-wait-stage`，把 `stage → 路径` 的解析放进代码
   （路径只能来自 `layout()`），内部复用 `wait_for_file` 的 inotify 原语与 `bootstrap_events`
   的唯一解析器；它**只是等待通道**，不连 owner、不推进、不产生新状态机。同时补上现规则的洞：
   只写了「`sleep N`，N≥60」，而现场用的是 8 秒小步循环。
4. **③ 投递者溯源**：接收侧校验投递行的 `from_handle`，与 pin 里的 `operator.terminal` 比对，
   不匹配 fail-closed（`handoff_sender_mismatch`），并把 `msg_id`/`from_handle`/时间戳/两个 sha
   写进该 attempt 的接受记录。**pin 字节断言与投递者身份断言是两个独立断言，缺一不可**；
   身份不匹配时不得退化成「pin 对就算过」。这一步是**自洽检查：防误填/防事故，不防冒充**，
   本文不把它称为安全边界（§3.3.2、§8 决策 2）。
5. **明确不做**：让 steering 唤醒 mailbox 等待（上游 native 变更）、liveness P1 的 durable
   `blocked`、P3 的 retirement 收口、`delivery-ledger.md` 的游标与 `consumed` 语义。

## 1. 问题与证据（已脱敏）

现场：一次 strict live attempt，接收方为 Coordinator，发送方为 Operator/driver 侧。
不写真实 terminal handle、Run/Task/Dispatch ID、主机名、私有路径与会话片段；一律用角色与「某 pane」。

| # | 事实形态 | 判读 |
| --- | --- | --- |
| E1 | 接收方发布完自己的 S0 证据后进入唯一被允许的等待形式：`orchestration check --wait --timeout-ms 300000 --json`（外层 `timeout 320s`）。发送方把 S0 handoff（owner.json + attempt-binding 双 pin、后续 argv 指令）用 `terminal send --enter` 打进接收方 pane | steering 只在**当前工具调用返回之后**才被提交，唤不醒正在运行的 `check --wait` |
| E2 | 接收方空转到分片超时（≈320 s，即 `check --wait` 的 300 s 分片 + 外层余量）之后才拿到那段文本，`check --wait` 本身空手返回；屏幕只显示工作计数器 | 外部看到的是「卡住」；实际是「等待通道与投递通道不同步」 |
| E3 | 同一时段发送方用 `for i in $(seq 1 N); do sleep 8; …; done` 轮询 `events/` 目录，并反复 `terminal read` 判进度 | 两种都不是协议允许的等待形式；「慢」被读成「死」，于是可能触发错误的下一步 |
| E4 | 该 attempt 的 `attempt-binding.json` 记录了 `operator.terminal` / `incarnation` / `session`，但实际把 handoff 打进 pane 的是**另一个** pane；接收侧没有任何校验，直接采信了 pin | pin 与字节没问题，**投递者身份**没有任何断言 |

结论：E1/E2 是通道选择错误，E3 是等待形式缺失（且现规则的禁用面有洞），E4 是身份断言缺失。
三者都不是「证据不够」，而是「把模型回合当传输层」的三种表现形式（liveness D3）。

本文**不声称**已复现 E1–E4、不声称 E2 的秒数是仪表化测量（它来自操作者观察，属二手证据），
也不声称修正后一定更快——收益只能在 live 对照里量（§5.2）。

## 2. 现状规则清单（锚点 + 各自缺什么）

| 位置 | 现有内容 | 缺什么 |
| --- | --- | --- |
| [coordinator-strict-start.md:516](../../coordinator-strict-start.md) | 「等待的唯一形式」：只允许 `check --wait`（或 `wait_for_events.py` 同一契约），禁 `sleep N`(N≥60)、轮询 inbox、循环重读文件 | 只有「怎么等」，没有「**该用哪个通道送 handoff**」；也没有「steering 与 mailbox 同时到达怎么办」 |
| [coordinator-strict-start.md:526](../../coordinator-strict-start.md) | 「等另一个 pane」：`terminal send --wait-submit` 取 `turn_started`，再 `wait_pane.py` 等一次边界 | 这是「怎么等对端的回合」，不是「该不该用 steering 送 handoff」；两条规则并排出现，读者容易把前者当成后者的许可 |
| [coordinator-strict-start.md:545](../../coordinator-strict-start.md) | 「等文件发布」：`wait_for_file.py --path <p>` | 只给「已知路径」，**没有 stage → 路径** 的入口；调用方必须自己拼 `events/0001-…`，拼错就退回 sleep 循环（E3 的直接成因） |
| [operator-startup.md:379](../../operator-startup.md)、[:389](../../operator-startup.md)、[:408](../../operator-startup.md) | 与上表逐字同构的三段（副本） | 同上；三份副本各自缺同样的东西，改动必须同步 |
| [SKILL.md:113](../../skills/swarm-orchestration/SKILL.md)、[:145](../../skills/swarm-orchestration/SKILL.md)、[:170](../../skills/swarm-orchestration/SKILL.md) | 三层通道（mailbox / 文件 / pane 回合边界）与不变量 | 没有「handoff 属于哪一层」；也没有「哪个 pane 发的」这一维 |
| [strict-bootstrap-protocol.md:187](../../strict-bootstrap-protocol.md) | STOP/恢复边界明确写「不另开 Operator、不做 TUI 键盘注入」 | 与 E1（用 `terminal send --enter` 投 handoff）直接冲突；协议里没有任何一句说「handoff 只能用 mailbox」 |
| [strict-bootstrap-protocol.md:191](../../strict-bootstrap-protocol.md) | 「Phase 4 选择已有 model turn 内主动工具返回，**不调用跨回合 prompt 投递**」 | 同一份协议在字段生产上已经拒绝 prompt 投递，S0 handoff 却没有对应条款——规则按阶段分裂 |
| [pane-handoff-wait.md §4.1](pane-handoff-wait.md) | 三层通道 + 「三层只覆盖对端 handoff」+ 四类非范围 | 设计里没有「handoff 交付走哪一层」，也没有「投递者身份」 |
| [wait_for_file.py](../../wait_for_file.py) | 原语已实现：inotify 提前唤醒、deadline 决定结果、父目录不可达立即 4 | 没有 stage 语义；调用方拿不到「该等哪个文件」 |
| [coordinator_launch.py](../../coordinator_launch.py) | 已有 `strict-bootstrap-state`（只读诊断）与 `strict-bootstrap`（owner RPC 客户端） | 没有第三个入口：等待 |
| [bootstrap_events.py](../../bootstrap_events.py) `binding()` | 校验 `operator` 四个字段的**形状**、非空、与 Coordinator 不同 terminal | 这些值从不与**任何一次投递**比对，因此「谁送来的」完全没被使用 |
| [bootstrap_admission.py](../../bootstrap_admission.py) `control_paths()` | `control/` 是「不属于冻结 layout 的控制记录」目录 | 没有 handoff 接收回执的位置 |

现规则的执行面：`sleep N`(N≥60) 是本仓策略而非 CLI 限制，**没有任何运行时门禁**；
因此「8 秒小步循环」这种形态在字面上没有被禁，是靠读者自觉——这是 E3 能发生的制度原因。

## 3. 三个改动

### 3.1 ① handoff 的通道选择

#### 3.1.1 先确定两个通道的性质（事实，不是偏好）

| 通道 | 形态 | 关键性质 |
| --- | --- | --- |
| mailbox | `orca orchestration send --type handoff …` → 对端 `check --wait` | 投递**持久**且与接收方当前位置无关：接收方正在等，它立刻被唤醒；接收方没在等，消息留在 FIFO 里等下一次 `check` |
| steering | `orca terminal send --terminal <peer> --text … --enter` | 注入的文本只在**当前工具调用返回之后**被提交。它不能中断一个正在运行的 `check --wait`，也不能抢占任何工具调用 |

于是「对端是否正处在阻塞调用里」对 mailbox 不构成约束，对 steering 构成**决定性**约束。
这一条不对称就是选择规则的全部依据，不需要推测对端状态。

#### 3.1.2 规则

- **R1（默认）**：handoff、指令、结果回传一律走 mailbox，`--type handoff`。
  mailbox 的等待形式仍是 `check --wait`（单片 ≤300 s），规则原文不变。
- **R2（steering 的合法用途，穷举）**：
  (a) **原生启动回合的短 prompt**——即 `terminal.create` 时给出的那条 launch prompt（由
  launch 契约固定、参与 plan hash），它只承担「读你的角色文件、然后在 mailbox 里等」这一件事；
  (b) 发送方**明确持有**对端「正在回合边界」的证据（定义见 R3）。**注**：当前 provider 下这一条恒不
  可满足（见 R4b）；是否直接删掉它见 §8 决策 7，删掉前它仍然是一个只能 fail-closed 的分支；
  (c) 人工决策与交互提示（`interaction_required` 一类）——这两类仍按各自契约处理，本节不授权。
- **R3（"明确处于回合边界"的可观测定义）**：三个条件同时成立才叫"明确"：
  (i) 发送方**自己**对该 pane 的最近一次提交留有 `terminal send --wait-submit` 的回执，且
  `stages` 含 `turn_started`；
  (ii) `wait_pane.py --turn-evidence <回执>` 对该回执返回 0（证明**那一次**提交启动的回合已到边界）；
  (iii) 此后发送方没有再对该 pane 提交过任何输入。
  缺任意一条 → 只能 mailbox。**没有第三种推测形式**：`terminal read` 看到「像空闲」、计数器停住、
  屏幕安静、`terminal wait --for tui-idle` 满足，**都不算**证据（`tui-idle` 在 pane 开始工作之前
  就成立，在 `check --wait` 里更是成立——这正是 E1 的误判来源）。
- **R4（推论）**：R3 的门槛是「我持有我自己那一次提交的边界证据」，而 mailbox 在任何情况下都可用，
  因此对端不是我的 pane、我从没向它提交过、或我的 `wait_pane` 刚超时 124 时，**steering 永远不合法**。
  也就是说 steering 是 mailbox 不可用时的兜底（fresh pane、无 CLI 的 provider、人工），
  不是"更快的那条路"。
- **R4b（provider 推论，已观测）**：本机两个 pane（一 pi、一 trae）上 `terminal send --wait-submit`
  都只到 `input_accepted` 并回 `provider: "unsupported"`，**拿不到 `turn_started`**（pane-handoff-wait
  R7 由假设变成观测）。于是 R3(i) 对 pi↔pi 与 trae↔trae **恒不成立**，steering 实际只剩 (a) 原生启动
  prompt 与 (c) 人工交互。**一般化表述**：provider 报 `unsupported` 时只允许 mailbox 或人工，
  不存在"等下次 provider 支持了再说"的中间态，也不允许把 `input_accepted` 当作替代证据。
- **R5（误用后的处置：只允许 same-handoff copy，不得产生新投递）**：一旦发现或怀疑 steering 是在
  对端处于 `check --wait` 时发出的：
  1. **禁止产生新的 `handoff_id` 或新的文本**。重发一份"新的"handoff 会制造第二个回合与第二份
     语义不同的 handoff——这才是真正的伤害；text 会在边界被提交一次，mailbox 副本（若也发了）也可能到达。
  2. **允许的只有 same-handoff copy**：`handoff_id`、`payload_sha256`、`refs`、`subject` 四项与原投递
     **逐字节相同**的再次投递（通常是把同一份载荷换到 mailbox 通道上）。它不是第二次投递，是同一份
     handoff 的另一次传输尝试。
  3. 先取边界：对原回执再等一次 `wait_pane.py`（≤300 s）。124 = 对端仍在长调用里 → 做同上 copy，
     **不要追加文本**。
  4. 接收侧对到达的每一份都按 same-handoff 判定（§3.3.5）：发送侧四项（`handoff_id`/
     `payload_sha256`/`refs`/`subject`）全同以外，还要比 `from_handle` 与 `sender_anchor`——
     所以**从另一个 pane 重发的“同一份”也是 conflict**（发送者变了）。全同 → duplicate（3，no-op，
     不消费）；任一项不同 → `handoff_duplicate_conflict`（5，fail-closed，不消费）。
     **冲突不是"取新的那份"**。
  5. 只有 steering 到、mailbox 没到 → 接收方接受后回报一条 mailbox `status`（同 `handoff_id` +
     `accepted`），让发送方不必靠屏幕猜。这**不是**新指令，是对端已经作出的决定回执。

#### 3.1.3 被否方案

| 否 | 方案 | 理由 |
| --- | --- | --- |
| N1 | 让 steering 唤醒 mailbox 等待（或允许注入中断正在运行的工具调用） | 需要改上游 runtime 的 PTY 注入语义 + harness 的工具调用抢占，是 native 变更；而且把模型回合进一步当传输层，与 liveness D3 的方向相反。硬约束已排除改 `orca/` |
| N2 | 继续用 steering，但发送前先 `terminal wait --for tui-idle` 确认「空闲」 | 假阳性：pane 开始工作**之前**就是 idle，「在 `check --wait` 里」也是 idle。这是 pane-handoff-wait I2/R1 已经否决过的判据 |
| N3 | 把 `--wait-submit` 的 `turn_started` 当投递成功 | 它只证明「文本被提交」，不证明对端采纳；而且 provider 报 `unsupported` 时连 `turn_started` 都没有（§3.1.2 R4b，已观测）。回执不是接受 |
| N4 | handoff 改成「写文件让对端等文件」（T2 单独用） | 文件等待没有身份维度：任何能写该目录的进程都能伪造，且要先约定共享目录。mailbox 已经带 `from_handle`。保留为无 mailbox 宿主的回退，不当默认 |

#### 3.1.4 落地位置（本阶段只改文字）

`coordinator-strict-start.md:516ff`、`operator-startup.md:379ff`、
`skills/swarm-orchestration/SKILL.md:113ff` 三处**追加**「handoff 的通道选择」小节；
`pane-handoff-wait.md §4.1` 表补一列「用于 handoff 交付？」，并加一行「投递者身份不属于三层通道」。
三处 `check --wait` 的原文**不改**（避免把已有纪律改写成模糊表述）。

### 3.2 ② `strict-bootstrap-wait-stage`（阶段等待入口）

#### 3.2.1 形态

```
coordinator_launch.py strict-bootstrap-wait-stage \
  --bootstrap <BOOTSTRAP> --expect-attempt <attempt_id> \
  --attempt-binding-sha256 <64 hex> --stage <1..4> \
  [--timeout-ms 300000] [--json]
```

- 作为 `coordinator_launch.py` 的**同级 verb**，与 `strict-bootstrap-state` 并列。
  （brief 建议写成 `strict-bootstrap wait-stage --stage N`；见 §8 决策 4，两者语义与退出码相同，
  差别只在 dispatch 一行。）
- **不连 owner**：不读 `owner.json`、不查询确认、不取锁、不写任何槽。
- `stage N` 的路径只能来自 `layout()` 的第 N 个固定 marker：
  `binding["paths"][EVENTS[N-1]]`。不拼字符串、不 glob、不扫 `events/` 目录。
- 实现落点（阶段二）：新模块 `swarm/bootstrap_stage_wait.py`，复用而不新造：
  `wait_for_file.wait()`（inotify 提前唤醒 + deadline 兜底 + 父目录不可达立即返回）、
  `bootstrap_events.binding()`/`_check()`（唯一解析器，返回 `validated_markers`/`state`/`pending_stage`）、
  `bootstrap_protocol.layout/EVENTS`（唯一路径表）。

#### 3.2.2 语义与退出码

表的「来源」栏区分两类码（这一栏不是分类癖好）：**原语既有码**是 `wait_for_file`/`bootstrap_events`
已经定义、本工具只透传的状态；**本工具新增码**是 `wait-stage` 自己引入的语义。混在一起写会让
读者以为「5」在 `wait_for_file` 里就有过（它没有：原语只有 0/124/4/2）。

| 退出 | 来源 | 含义 | 说明 |
| --- | --- | --- | --- |
| 0 | 本工具 | 该 stage 的 marker 在**本次读取时**存在，且整条链校验到该 stage 通过 | 只表示「等了、看到了、验过了」。`--json` 同时给 `already_satisfied: true\|false` 与 `validated_count`（=`len(validated_markers)`） |
| 124 | 原语既有（`wait_for_file`） | 窗口用完，什么都没出现 | deadline 说了算；允许再等，**不**授权任何推进 |
| 4 | 原语既有（`wait_for_file`） | attempt 目录 / binding 父目录不可达 | 立即返回，绝不退化成轮询到超时 |
| 2 | 原语既有（用法/传输类） | 用法/传输失败，或 binding 的 sha256 / `attempt_id` / layout 与参数不符 | 既有码原样透传（`attempt_mismatch`、`file_pin_changed`、`fixed_layout_mismatch`、`invalid_binding`…） |
| 5 | **本工具新增** | 路径在，但链校验不过（含透传的 `marker_sequence_gap`、`consumed` 不符、时间序不符） | fail-closed，**不重读、不重等**。`wait_for_file` 没有这个码 |

**没有退出 3**：`len(validated_markers) >= N`（stage 已过）与「刚好等到 N」是**同一个 0**，只用
`already_satisfied` / `validated_count` 区分（一道状态两个退出码会让调用方分叉出两套处理）。
3 在本文里只用于 handoff 侧的 `handoff_absent_no_effect` / `handoff_duplicate_no_effect`（§4.2）。

返回 0 的**三层含义**必须同时写进文档，不许省略任何一层：

1. **是等待结果，不是授权**：0 不授予推进、不授权 start/release/abandon/retry、不写入任何槽。
2. **evidence Ref 由工具给出**：0 时输出工具自己读到的 `{path, sha256}`，称为 **evidence Ref**；
   调用方必须**原样**把它带进下一次调用；不得自己再算一个 sha（自算的 sha 就是「重读同一文件」的
   另一条路径），**也不得因为 `already_satisfied: true` 或 `validated_count > N` 就跳过携带**——
   「早就到了」不是「不用交接 pin」的理由。
3. **仍须 owner 确认**：0 ≠ confirmed。需要确认的槽仍按协议查询 owner；需要本角色判断的 stage 仍停在
   `needs_role_judgement`。确认是**另一个**断言，不是这份等待的延伸。

#### 3.2.3 为什么「在、但解析不过」不重试

注册式 attempt 的固定槽由 owner 经 `coordinator_io.publish_new()`（`os.link`）发布——**字节完整才可见**。
所以「路径在、解析不过」不可能是半写，只能是真失败（跳序、`consumed` 不符、时间序错），重读不会自己变好。
历史路径（非注册 attempt 的自写槽）没有这个保证，因此 `wait-stage` **要求**能读到并校验 binding，
即只服务注册式 attempt：这不是降级，是拒绝。

#### 3.2.4 与既有三个入口的边界

| 入口 | 断言 | 写？ | 连 owner？ |
| --- | --- | --- | --- |
| `strict-bootstrap-state --check` | 「现在在哪、缺哪个槽」（诊断） | 否 | 否 |
| `strict-bootstrap-wait-stage` | 「等到 stage N，且链校验通过」（等待） | 否 | 否 |
| `strict-bootstrap pull/produce/submit/complete/advance` | 「推进本角色 ownable 的机械动作」（推进） | 是 | 是（`--execute`） |

三者可组合，谁都不能替代谁：诊断能立刻回答「为什么没到」，等待能从「没到」变成「到了」，
推进会写字节。把三者压进一个 0 是本设计**明确拒绝**的（§6 红线）。

#### 3.2.5 规则侧同时要补的洞

`coordinator-strict-start.md:545`、`operator-startup.md:408`、`SKILL.md:170` 三处「等文件发布」小节补：

- 阶段文件**不许自己拼路径、不许 sleep 循环、不许扫 `events/` 目录**；唯一形式是
  `strict-bootstrap-wait-stage`（已知单路径时才用 `wait_for_file.py`）。
- **「`sleep` 小步循环」明确列为禁用**（`for i in …; do sleep M; …; done`，与 M 取值无关）。
  现规则只写了 `N≥60`，E3 的 8 秒循环字面上不合规性不足；新措辞按「形态」禁，不按「单次时长」禁。

#### 3.2.6 被否方案

| 否 | 方案 | 理由 |
| --- | --- | --- |
| N5 | 让调用方自己 `wait_for_file.py --path <拼出来的路径>` | 这就是现状：路径表（`layout()`）已经存在，却让调用方复制它；拼错就从「等错了文件」退化成 sleep 循环 |
| N6 | wait-stage 顺便做 owner 确认，或直接推进到下一 stage | 三种断言混进一个 0，任何一次 0 都会被读成「可以走了」；也违反 liveness §5 红线 |
| N7 | 内部用 `--mode change` 反复重读直到有效 | 见 §3.2.3：真需要就是写入方没走 `publish_new`，应修写入方而不是让读者轮询 |
| N8 | 接受 `--stage 0`（等 binding 出现） | binding 是本次等待的**参数**（sha 在 argv 上），不是 stage；等它等价于一次 `wait_for_file --mode appear`，不该长在这里。见 §8 决策 5 |

### 3.3 ③ 投递者溯源（接收侧校验 `from_handle`）

#### 3.3.1 两个独立断言

| 断言 | 内容 | 失败码 |
| --- | --- | --- |
| **A 字节** | handoff 载荷里的 `Ref`（owner.json / attempt-binding / 后续 argv 的 pin）与接收方**读到**的字节一致 | `handoff_pin_mismatch` |
| **B 身份** | 投递行的 `from_handle` 与 pin 中的 `operator.terminal` 一致 | `handoff_sender_mismatch` |

**为什么必须分开**：E4 里 A 全绿、B 全红（pin 与字节正确，投递者是另一个 pane）。任何
「pin 对就算过」的短路都会原样复现事故；反过来，B 对而 A 错是 pin 漂移，也不能过。
二者是与关系，不是替代关系——这是本节最重要的一句话。

#### 3.3.2 `from_handle` 到底是什么（诚实边界，必须写进文档）

- 投递行由 runtime 的 messages 行投影而来；`check --json` 的每行带 `id`、`type`、`subject`、
  `body`、`payload`、`from_handle`、`to_handle` 等（见 `orca/src/shared/orchestration-check-output.ts`
  的 `OrchestrationMessageSummary`，投影删列见
  `orca/src/main/runtime/rpc/methods/orchestration/messaging/mailbox-message-receipt.ts`）。
- **`from_handle` 是谁解析出来的，要分层说**：
  - **CLI 层**（本设计依赖的就是这一层）：`params.from` 来自 `--from`；未给时按注入的 agent 会话地址、
    该进程的 `ORCA_TERMINAL_HANDLE`、或被推断的隐式发送方依次解析
    （`orca/src/cli/handlers/orchestration/terminal-identity.ts`）。
  - **runtime 方法层**（本设计**不**依赖）：`orchestration.send` 只做 `params.from ?? 'unknown'`
    （`orca/src/main/runtime/rpc/methods/orchestration/messaging/send-methods.ts`）。也就是说，绕过 CLI
    直接发 RPC 而没带 `from` 时，记下来的是字面量 `unknown`。一个 `from_handle` 等于 `unknown` 的 handoff
    必定 `handoff_sender_unanchored`/`handoff_sender_mismatch`，不得被当成匹配。
- 因此它证明**声明身份**，不是密码学签名：结构化 agent 会话里 CLI 入口会拒绝 `--from` 指向别的
  会话（`orca/src/cli/session-caller-flags.ts`），但普通 PTY pane 的 `--from <别的 handle>` 不被拒；
  `sender_pane_key` 被刻意从回执里删掉，所以接收侧也看不到 sender pane key。
- **结论（逐字写进协议与入口文档，不许模糊）**：B 断言（D-b 形态）**这是自洽检查，防误填/防事故，
  不防冒充**。它能抓住 E4（另一个 pane 发、没有冒充），抓不住蓄意冒充。全文（包括 §0 第 4 条、
  §4.2 码表、§5 验收口径）**不得**把它称为「安全边界」或「认证」；要一条真正的安全边界，那是
  §8 决策 2 的问题，不归本文解决。
- D-b 形态的输出必须带 `sender_anchor: "binding-operator"`，让每一个读者（和每一份下游证据）都能
  看出这个身份断言用的锚点只是 binding 里的字段，而不是启动契约里的独立固定值。

#### 3.3.3 锚点（circularity 问题）

若唯一可比的 `operator.terminal` 来自消息自带的 binding，则「冒充者用自己的 handle 造一份 binding」
也能通过 B——那是自洽检查，不是独立校验。三个选项：

| 选项 | 内容 | 代价 / 强度 |
| --- | --- | --- |
| **D-a（推荐，待批）** | 把「预期投递者」固定在 Coordinator **自己的 pinned 启动契约**里（launch plan 的 `startup_delivery` 子字段，参与 plan hash 与 `stdin_sha256`） | 锚点不依赖消息内容；代价是契约多一个字段、plan hash 变、既有 plan 不可复用（协议变更，需 owner 批准） |
| **D-b（brief 的最低形态，本阶段建议实现）** | 只比 `binding.operator.terminal`，并在输出里**显式标注** `sender_anchor: "binding-operator"` = 自洽检查 | 零协议改动、可离线判定、覆盖 E4 这一类事故；**不防冒充** |
| D-c（否） | 比 native 记录（Run 的 coordinator/operator、terminal 注册表） | S0 时 Run 还不存在，operator pane 的注册表项也没有 attempt 归属 → 不能作锚点 |

锚点缺失时输出 `handoff_sender_unanchored` 并 fail-closed，**不静默降级为「通过」**。

#### 3.3.4 接受记录（最小的落盘）

- 位置：`<BOOTSTRAP>/control/handoff/<handoff_id>.json`。`control/` 已经是「不属于冻结 layout 的控制
  记录」目录（`bootstrap_admission.control_paths()` 的 docstring），新增子目录**不改变 `layout()`**，
  因此不影响 `fixed_layout_mismatch` 与既有 pin。
- 目录：由**接收方**创建 `control/handoff/`，权限 `0700`（与既有 `control/` 同级同权限）；已存在则用，
  但不接受它是一个符号链接或非常规目录（遇到就 fail-closed，不跟随）。
- 内容（最小集合，不允许扩成第二条真相源）：`handoff_id`、`from_handle`、`msg_id`、`created_at`
  （消息时间，回执未带则记 `null` 并标注 `timestamp: "unknown"`——未知绝不写成 0）、`subject`、
  `payload_sha256`、`refs`（校验通过的 Ref 列表）、`sender_anchor`、`accepted_at`、
  `execution_authorized: false`。**不记 `body`**（I5：诊断不落载荷）。
- 写入顺序（定死，不留解释空间）：
  1. `publish_new`（`O_EXCL`）到临时目标的同一目录，字节完整才可见；
  2. 对父目录 `fsync`（`coordinator_io.publish_new` 已经做 `fsync_dir`，本设计不另写一套）；
  3. **读回**该路径，与刚写的字节逐字节比较（同 `handoff_record_conflict` 的判定）；
  4. 只有读回相同才算 `accepted`。同名已存在 → 不写、转 §3.3.5 的 duplicate 比较。
- 生命周期：**不清理、不可覆盖**，至少保留到该 attempt 的 retirement 完成（这与 liveness P3 的落盘
  时机相容，但不依赖它）；本文不定义清理窗口，也不允许任何人手改已有记录。
- **不进任何 gate 输入**（`execution_authorized: false`，也就没有"确认"语义）；任何 validator、
  `bootstrap_admission` 确认链、strict 启动门都不读它。
- 它证明什么：本 pane 在 `accepted_at` 读到过这条投递并做过 A/B 两项断言。
  它**不**证明发送方诚信、**不**证明 handoff 内容被采纳。
- 它与 [delivery-ledger.md](delivery-ledger.md) 的关系：不实现游标、不实现 `consumed`、不跨 recipient
  汇总、不新增常驻服务。只有「一条 handoff 的接收回执」。（该草案要求
  「`native-orchestration-send` 与 `terminal-prompt` 两种 channel 证据强度不同，必须分开统计」——
  本节正是这条要求的**通道侧**最小落地，但台账本身仍未开始。）

#### 3.3.5 消费、ack 与 duplicate 的比较

- 接收侧的顺序：`check --peek --wait --types handoff --timeout-ms ≤300000`（peek = 取未读但**不**标记
  已读；`consumeUnread` 在 `peek` 下为 false，`--wait` 仍生效）→ A/B 校验 → 写接受记录 → 之后由调用方
  按需消费。
- 这消灭了 D2 里最讨厌的一类：**「CLI 已把消息标成已读、进程死在写记录之前」**。等待路径从不消费，
  所以「读了但没记下」不存在；写记录失败 → 消息仍未读 → 下一次 peek 还能看到它。
- **duplicate 判定不是只看 `handoff_id`**。`handoff_id` 相同只代表「声称是同一份」，所以 duplicate
  分支必须**读回既有接受记录**并逐项比较：`payload_sha256`、`refs`（逐项 path+sha256、保持顺序）、
  `from_handle`、`subject`、`sender_anchor`。
  - 五项**全同** → `handoff_duplicate_no_effect`（退出 3）：no-op，**不消费消息**，不产生新回合，
    不写第二份记录。
  - 任一项**不同** → `handoff_duplicate_conflict`（退出 5，`may_replay: false`，**不消费**，也不覆盖
    既有记录）。理由是：同一个 `handoff_id` 对应两套字节或两个发送者，意味着“ID 复用”或“有人重写
    了同一份 handoff”——两种都不允许由接收方自行裁决（不得“取新的那份”）。
- 如果连接的是老 runtime（不支持 `--peek` 与 `--wait` 同用），CLI 自己会以 `peek_wait_unsupported`
  失败；按 I6 fail-closed，**不**回退成「消费式等待」。
- 与 `wait_for_events.py`（默认消费）的这处**刻意不同**必须写进文档：等待不是接收。
  `--ack <delivery_id>` 只适用于有 delivery 的 run/dispatch mailbox；direct/未绑 Run 的消费方式是
  一次普通的（非 peek）`check`。设计不要求必须消费。
- **本机实测依据（2026-11-12，本次两个 pane）：超时不是 124，而是空批 rc 0。**
  `orca orchestration check --peek --wait --timeout-ms 2000` 阻塞 **2.12 s** 后返回
  `{"messages": [], "count": 0}` 且进程 **rc 0**（无 `timedOut` 键）。因此：
  - **不得用退出码区分「没消息」与「传输失败」**：两者分别是 rc 0 与（非 0 或不可解析）。
  - 判定超时只能用结构 + 自测耗时：完整空批 ∧ 无 `timedOut`/`timeout` 键 ∧ 单调耗时 ≥ 窗口 − 容差
    （即 `wait_for_events.py` 已经实现的 P1 口径，`TOLERANCE_MS` 200）。这条要作为接收侧的硬前提，
    而不是各调用方自己推断。
  - 外层 `timeout` 必须大于 `--timeout-ms`，否则永远看不到完整回包。

#### 3.3.6 被否方案

| 否 | 方案 | 理由 |
| --- | --- | --- |
| N9 | 改比 `sender_pane_key` | `check --json` 刻意不暴露它（内部列被删）；要用就得上游暴露 runtime 内部字段 |
| N10 | 要求 handoff 带签名 | 没有既有 key/身份体系，等于新机制；上游也未提供。列为 §8 决策 2 |
| N11 | 身份不符就重发到「正确的 pane」 | 你不知道对端是否已在处理错的那份副本；重发把「接受」变成两次。见 R5 |
| N12 | 身份不符但仍采纳 pin（"字节对就行"） | 这正是 E4 的形状；明令禁止（§6 I8） |

## 4. typed code 表

`may_replay` 沿用 P0 的口径：**只有 `not_admitted` 允许原地重试**；等待类失败里「再等一次」不算重放
（没有效果），但要单独标注为 `may_replay: true (wait-only)`，避免被读成「可以推进」。

### 4.1 `strict-bootstrap-wait-stage`

「来源」栏与 §3.2.2 同义：**原语既有** = `wait_for_file`/`bootstrap_events` 已定义、本工具只透传；
**本工具新增** = `wait-stage` 自己的语义。

| code | 退出 | 来源 | 场景 | fail-closed | may_replay |
| --- | --- | --- | --- | --- | --- |
| `bootstrap_wait_stage_invalid` | 2 | 本工具新增 | `--stage` 越界/非整数、`--timeout-ms` ≤0 或 >300000 | 是 | false |
| `attempt_mismatch` / `file_pin_changed` / `fixed_layout_mismatch` / `invalid_binding`（复用） | 2 | 原语既有 | binding 的 attempt / sha256 / layout / 字段不符 | 是 | false |
| `bootstrap_wait_stage_unreachable` | 4 | 原语既有语义（`wait_for_file` 的 4） | attempt 目录或 binding 父目录不可达 | 是 | false |
| `bootstrap_wait_stage_timeout` | 124 | 原语既有语义（`wait_for_file` 的 124） | 窗口用完，路径未出现 | 是 | true（仅「再等」） |
| `bootstrap_wait_stage_present_unvalidated` | 5 | **本工具新增**（`wait_for_file` 没有 5） | 路径在，链校验不过（含透传的 `marker_sequence_gap`、`upstream_pin_mismatch`、`marker_time_mismatch`） | 是 | false |

**没有退出 3**：`validated_count >= N` 一律走 0（`already_satisfied: true`）。**调用方不得因
`already_satisfied` 或 `validated_count > N` 而跳过携带 evidence Ref**，也不得据此跳过 owner 确认——
「早就到了」不是「不用交接 pin」的理由。

### 4.2 handoff 接受

| code | 退出 | 场景 | fail-closed | may_replay |
| --- | --- | --- | --- | --- |
| `handoff_sender_mismatch` | 5 | `from_handle` ≠ pin 的 `operator.terminal` | 是 | false（需**另一个** pane 重新投递，那是新投递，不是重放） |
| `handoff_sender_unanchored` | 5 | 无独立锚点（D-a 未落地且 D-b 也被判不足时） | 是 | false |
| `handoff_pin_mismatch` | 5 | 载荷 Ref 与读到的字节不符 | 是 | false |
| `handoff_payload_invalid` | 5 | 载荷 schema/未知字段/`attempt_id` 不符 | 是 | false |
| `handoff_absent_no_effect` | 3 | 批次里没有本 attempt 的 handoff 行 | 否（没东西可做） | true（可再等） |
| `handoff_duplicate_no_effect` | 3 | 同 `handoff_id` 的接受记录已存在，且 `payload_sha256`/`refs`/`from_handle`/`subject`/`sender_anchor` **逐项全同** | 否 | **false**（no-op：不产生新回合、不消费，重放同一条未消费消息不是进展） |
| `handoff_duplicate_conflict` | 5 | 同 `handoff_id` 但上述五项**任一项不同**（ID 复用或同一份被重写） | 是 | false（不覆盖既有记录、不消费、**不得“取新的那份”**） |
| `handoff_delivery_unreadable` | 2 | CLI 回执半包/被杀/非 0 退出（`state=not_admitted`：未消费任何投递） | 是 | true（未消费，可再等） |
| `handoff_record_conflict` | 5 | ① `publish_new` 之后读回字节不同；② link 已落地但父目录 fsync 未证实（字节可见、durability 未知）——两种都是 `state=needs_reconcile` | 是 | false（绝不写第二份） |

实现时补上的四行（设计表原本没覆盖这三种情形，实现不能自己选一个近似码）：

| code | 退出 | 场景 | fail-closed | may_replay |
| --- | --- | --- | --- | --- |
| `handoff_wait_timeout` | 124 | `check --peek --wait` 的窗口用完（形状+自测耗时判为超时，见 §3.3.5/B11） | 是 | true（未消费，可再等） |
| `handoff_record_unwritable` | 2 | 回执根本没落盘（`publish_new` 失败且读回不存在，`state=not_admitted`） | 是 | true（未消费、未写，可重试） |
| `handoff_record_dir_unsafe` | 5 | `control/` 或 `control/handoff/` 是符号链接、不是目录，或已存在但 mode ≠ `0700`（不改权限、不跟随链接） | 是 | false |
| `handoff_record_dir_unproven` | 5 | 目录准备中 `mkdir`/`chmod`/`fsync_dir` 失败（目录可能已建、durability 未证实，`state=needs_reconcile`） | 是 | false（重试必须重新 fsync 两层 parent） |
| `handoff_attempt_unreachable` | 4 | attempt 目录或 binding 不可达 | 是 | false |

写记录后的失败分类（沿用 P0 纪律）：`link` 成功后任何错误都先**读回**——字节相同 → `admitted`；
不存在 → `not_admitted`；不同 → `needs_reconcile`。不允许「再写一次」。

## 5. 证据与验收判据

### 5.1 离线可判定（阶段二必须全绿；**不是** live 验收）

| 模块（新增） | 用例要点 |
| --- | --- |
| `tests/bootstrap/test_bootstrap_stage_wait.py` | stage→路径只经 `layout()`（改 `PATHS` 即红）；stage 已过 → 立即 0 且 `already_satisfied: true`、`validated_count >= N`、不花窗口（**无退出 3**）；缺 stage → deadline 124（用 `tests/publication_wait_fixture.py` 的 `PollingWatcher` 控制时间，不用 sleep）；attempt 目录 / binding 缺失 → 4 且立即返回（**`events/` 父目录缺失是等待，不是 4**：第一个 marker 之前它本来还不存在，判 4 会拒掉协议里第一次等待）；路径在但解析不过 → 5 且只读一次；`marker_sequence_gap` 透传；binding sha/attempt 不符 → 既有码且退出 2；0 时输出的 **evidence Ref** 与磁盘字节 sha 一致；**携带 evidence Ref 是调用方义务，当前没有下游消费者做强制**（规则约束，不是运行门禁）；全程不连 owner（夹具断言没有 socket 调用） |
| `tests/bootstrap/test_bootstrap_handoff.py` | A/B 断言 2×2 矩阵（pin 对/错 × sender 对/错），只有「双对」才 accepted；同 `handoff_id` 五项全同 → duplicate（3）且不写第二份；**同 `handoff_id` 但 `payload_sha256`（或 `refs`）不同 → `handoff_duplicate_conflict`（5）且不覆盖、不消费**；`--peek` 出现在 CLI argv 且不消费（假 CLI 夹具）；写记录失败 → 未消费、消息仍可再取；`link` 后读回不同 → `handoff_record_conflict` 且不二次写；`created_at` 缺失 → 记 `unknown` 而不是 0；`from_handle == "unknown"` → `handoff_sender_unanchored` |
| `tests/bootstrap/test_bootstrap_handoff.py`（已落） | **老 runtime 触发 `peek_wait_unsupported` 时 fail-closed**（不退化成消费式等待，也不把已读掉的消息当已完成）；结构+耗时口径下「空批 rc 0」被判定为超时，而不是空批 |
| 无测试（**规则约束**） | 「provider 报 `unsupported` 时 R3 不成立」只在三处入口文档里约束发送方：`--wait-submit` 只回 `input_accepted` 时不得当回合证据、不得据此用 steering 送 handoff。它没有运行侧门禁，也没有消费者可以强制；把它写成测试等于给一个不存在的校验发合格证 |
| `tests/coordinator/test_coordinator_launch.py`（扩） | 新 verb 的 dispatch 与参数校验；既有 `strict-bootstrap` / `strict-bootstrap-state` 的 argv 面**逐字节不变**（回归） |

文档一致性：三处入口文档出现新小节标题（与 README 注册行一起检查，避免「文档写了但没人读」）。

### 5.2 仍需 live 的部分（另获授权后才做，且必须分开写）

1. 一次 strict attempt 的 S0 handoff 走 mailbox：接收方在被唤醒后的**同一分片内**拿到（不是等分片超时），
   且该会话 `sleep` 计数为 0、`terminal read` 轮询为 0（可由转录直接计数，不依赖自述）。
2. 一份脱敏的接受记录（`msg_id`/`from_handle`/`sender_anchor`/两个 sha）。
3. 一次**受控**的错 pane 投递被 `handoff_sender_mismatch` 拒绝，且**没有**退化成「pin 对就算过」——
   这条只能在夹具或人工受控环境做，不许拿真 attempt 试验。
4. 等待对端成功的正面证据：`wait-stage` 从调用到返回的墙钟 ≈ 对端实际工作时长 ±1 s。

**不得**把 5.1 的结果表述为 live 验收；也不得用 5.1 声称「E1 不会再现」。

## 6. 不变量与红线

沿用 [liveness §5](strict-bootstrap-liveness.md) 的红线，另加通道相关条目：

| # | 不变量 | 反例即失败 |
| --- | --- | --- |
| I1 | 唤醒不是回执：任何一层返回后仍须复核产物 | 「`wait_stage` 返回 0 所以可以推进」 |
| I2 | `tui-idle` 必须绑定**同一次**提交的 `turn_started`；拿不到只允许 `unverifiable` | 用 `terminal read` 的观感代替回合证据 |
| I3 | 每个等待自带 deadline，由调用方给出并赢过任何内部兜底 | 内部兜底决定结果 |
| I4 | 单片阻塞 ≤300 s，被唤醒或超时后重新进片 | 一次要 900 s |
| I5 | 诊断与统计只输出 kind/计数/耗时，不输出路径、载荷、消息内容；接受记录只记 id/身份/时间/两个 sha | 把 `body` 或屏幕文本写进记录 |
| I5a | **例外（仅限一个）：** 等待结果为 0 时携带的 **evidence Ref**（path+sha256）属于等待结果本身，不受 I5 的「不输出路径」约束；它只走这一条通道，不得被拿去做诊断日志 | 把 Ref 写进 `wait_for_file` 式的统计行，或反过来以 I5 为由丢掉 Ref |
| I6 | 能力缺失 fail-closed，不回退 `sleep`、不回退屏幕抓取、不回退消费式等待 | 老 runtime 上「先把消息读掉再想办法」 |
| I7 | 等待工具只读：不 `ack`、不 `reply`、不写 owner 槽、不改运行中 attempt | `wait-stage` 顺手做了确认 |
| **I8** | **pin 字节断言与投递者身份断言是两个独立断言，缺一不可，不得互相替代** | 「pin 对就算过」（= E4） |
| **I9** | steering 不得替代 mailbox 的默认路径；误用只允许 same-handoff copy（四项全同）或「等一次边界」，**不得产生新的 `handoff_id` 或新文本** | 发现投错 pane 后重发一份"新的" handoff |
| **I10** | 等待不消费投递（`--peek --wait`）；消费是调用方的显式动作 | 等待工具在内部把消息标成已读 |
| **I11** | stage 路径只能来自 `layout()`；不得自己拼路径、扫目录或 glob | `glob("events/*.json")[-1]` |

**本次不得引入**：不新增 stage 状态机、不改 `layout()`/`PATHS`、不新增常驻服务、
不在 `orca/` 上游加字段、不把接受记录当 gate 输入、不放宽 pin/STOP/`blocked` 语义、
不把「等待」与「推进」合并成一个返回值。

## 7. 与 liveness P1、P3 的关系

- **不实现 P1 的 durable `blocked`**。`blocked` 的前提是「驱动进程拥有推进权 + 落盘语义 +
  能识别双角色 idle」，那是 P1 的内容；本文的 ①② 只是它的两个前提（角色等待时不占着模型回合去 sleep；
  一个 pane 的闲置不再靠屏幕判断），③ 与它无关（记录的是投递接收，不是推进权）。
- **不实现 P3 的 retirement 收口**。③ 的接受记录粒度是「一条投递」，P3 的粒度是「一次 attempt 的
  outcome / furthest progress / `no_effect_audit`」。将来 P3 可以消费 `control/handoff/` 得到
  「这次 attempt 的 handoff 有几条、谁送的」，但本文**不承诺**那个 schema，也不把它写进 retirement。
- **不替 liveness §7 的四项决策拍板**：只读 payload 是否继续走 strict、attempt 9 的处置、
  是否冻结新机制、prepare pin 的复位——本文一个都不预判，也不改变 strict 的适用范围
  （[entry-paths](../entry-paths.md) 的结论不变：strict 仍是三条互斥路径之一，不是默认路径）。

## 8. 未决决策（需要 owner 拍板，本文不代替）

「建议」栏是本文的倾向，不是决定；「owner-blocking」= 未定就不应进入实现。

| # | 决策 | 建议 | owner-blocking |
| --- | --- | --- | --- |
| 1 | **锚点**：是否采纳 D-a（把预期投递者写进 Coordinator 的 pinned 启动契约，使 B 断言从自洽升级为独立）。代价是契约字段与 plan hash 变更；收益是能挡住冒充 | 先落地 D-b（标注 `sender_anchor: "binding-operator"`），D-a 交 owner 决定 | **是** |
| 2 | **`from_handle` 的证据等级**：接受「声明身份、防误填/防事故，不防冒充」，还是要求上游提供可核验的投递者身份（native 变更，本次不做） | 接受 B7 的措辞上限（不叫安全边界），native 改动另立任务 | **是** |
| 3 | **接受记录的位置与生命周期**：`control/handoff/` 是否符合 owner 对 `control/` 的语义理解；是否长期保留（不可覆盖、不清理），以及 P3 是否允许引用它 | 接受，但受 §3.3.4 的 B6 约束（0700、`publish_new`+读回、不清理、不进 gate） | 否 |
| 4 | **CLI 面**：`strict-bootstrap-wait-stage` 同级 verb，还是 brief 字面的 `strict-bootstrap wait-stage`（语义、参数、退出码完全相同） | 同级 verb | 否 |
| 5 | **是否接受 `--stage 0`**（等 binding 出现） | 拒绝 | 否 |
| 6 | **禁用面口径**：是否把「`sleep` 小步循环」按**形态**写进三处入口文档（现规则只写 `N≥60`），以及是否与 pane-handoff-wait P6 的 30 s 门禁对齐 | 按形态禁；阈值另议，不与 P6 绑定 | 否 |
| 7 | **steering 的用例 (b) 是否保留**：若删掉，handoff 通道只剩 mailbox + 原生启动 prompt + 人工交互 | 删除 (b)：R4b 已证明当前 provider 拿不到 `turn_started`，保留一个恒不可用的分支只会让读者以为有第二条快路 | **是** |
| 8 | **handoff 载荷 schema 的归属**：payload 形状进 `strict-bootstrap-protocol.md` 做规范化（成为协议字段），还是留在 `swarm/` 文档里 | 最小信封进协议正文（只有 `handoff_id`/`refs`/`subject`/`payload_sha256` 这四项被判定的字段规范化，不做通用消息格式） | 否 |

第 1、2、7 条未定前，本文的 ③ 只能按 D-b 实现且必须在输出与文档里写明「自洽检查」；
本文不代替任何一条拍板。

## 9. 影响面（阶段二）

| 类别 | 内容 |
| --- | --- |
| 新增模块 | `swarm/bootstrap_stage_wait.py`、`swarm/bootstrap_handoff.py`（basename 与被测模块一致 → `tests/bootstrap/test_bootstrap_stage_wait.py`、`tests/bootstrap/test_bootstrap_handoff.py`） |
| 改动模块 | `swarm/coordinator_launch.py`（两条 dispatch 行）；`swarm/bootstrap_protocol.py` 可能加一个纯 `stage_path(binding, n)` 函数（**不动** `PATHS`/`layout()`）；若 ③ 需要 envelope 校验，`swarm/bootstrap_events.py` 增加一个只读入口（不改既有 `binding()`/`_check()`） |
| 文档 | `coordinator-strict-start.md`、`operator-startup.md`、`skills/swarm-orchestration/SKILL.md`（各追加一节）、`docs/design/pane-handoff-wait.md`（补一列）、`swarm/README.md`（注册行）、按 §8 决策 8 可能还有 `strict-bootstrap-protocol.md` |
| 生成的索引 | 新增协议符号后需 `python3 swarm/generate_orientation.py` 重生成（`--check` 会拦）；`operator-runbook.md` 不受影响（它只读 `bootstrap_actions.ACTIONS`） |
| 交付前门禁（文档 + 代码） | 阶段二必须跑：`python3 swarm/generate_orientation.py --check`（新增协议符号会让索引漂移）、`git -C <repo> status --porcelain`（确认只动了声明的文件）；若改了 `tests/run_offline.sh`/SLOW 表/套件布局，另跑 `tests/core/test_offline_baseline.py` |
| 不改 | `orca/`、owner 提交路径、`layout()`/`PATHS`、`publish_new`、任何 gate 判定 |

预计 blast radius（用 `tests/blast_radius.py` 的固定规则在同一 pin 上实测，2026-11-12）：

| 改动对象 | 选中模块数 | 备注 |
| --- | --- | --- |
| 纯文档改动 | 0（exit 2） | 实测 `fc011d66~1..fc011d66` → `0/107` 模块；「什么都没选中」不是通过 |
| `swarm/coordinator_launch.py` | 28 | 1 个同 basename（a）+ 17 个直接 importer（b）+ 10 个一跳（b2） |
| `swarm/bootstrap_events.py` | 27 | 1 个同 basename + 2 个直接 importer + 24 个一跳（`bootstrap.test_bootstrap_*` 全套在内） |
| `swarm/wait_for_file.py` | 1 | `core.test_wait_for_file` |
| 新模块（示例） | ≥1 | 同 basename 各命中 1 个，另加一条 `b`/`b2` 扩张；落地时以 `--dry-run` 为准 |

要跑的形式（阶段二交付报告里必须写清选中数与模式）：

```bash
tests/run_blast.sh --range main --dry-run     # 先看选中集合
tests/run_blast.sh --range main               # 再跑选中集合（explicit 模式，TARGETED OK）
```

`run_blast.sh` 看不到的耦合（动态导入、子进程 argv、纯夹具耦合）按脚本 `--help` 的自述处理：
不明时补 `tests/run_offline.sh --modules <点名>`，仍不明才跑全量。本文**不**预先声称任何测试已运行。

## 10. 与起草 brief 的不一致（明列）

1. **verb 形态**：brief 建议 `strict-bootstrap wait-stage --stage N`；本文建议同级 verb
   `strict-bootstrap-wait-stage`。理由：`strict-bootstrap` 是 `bootstrap_tool` 的 owner-RPC 客户端，
   带 `--execute` 契约与必填 `--owner/--owner-sha256`；一个不连 owner 的等待塞进去会把两种契约混在
   一个 argv 面里。语义/参数/退出码与 brief 相同（§8 决策 4 交 owner 定）。
2. **「返回 0 后仍须按 schema 复核字节」**：本文把 schema 复核放进工具内部（0 只在链校验通过时给出），
   把调用方的剩余义务改成两条更窄的：(a) 原样携带工具返回的 **evidence Ref**（包括 `already_satisfied`
   的情形），(b) 需要确认时仍走 owner 查询。
   理由：让 0 与「字节对不对」解耦，就会有人拿 0 当「可以走」，而这正是 brief 要防的东西。
3. **③ 的锚点**：brief 只要求比 `operator.terminal`。本文指出这是**自洽检查**（冒充者可用自己的
   handle 造一份 binding），因此给出 D-a/D-b 两个选项，建议本阶段实现 D-b 并显式标注强度，
   D-a 交 owner 拍板——否则文档会把「防事故」写成「防冒充」。
4. **禁 sleep 的范围**：brief 说「禁 sleep 轮询」。本文指出这是现规则的**洞**（只禁了 `N≥60`，
   E3 用的是 8 s 循环），因此把禁令改成按形态（§3.2.5），并把阈值口径交 owner（§8 决策 6）。

## 11. 修订记录

### v2（2026-11-12）

v2 依据**两份独立评审**（均为 `accept-with-changes`）合并出的 blocking 项修订：退出码 0/3 重叠、
R5 自相矛盾、duplicate 判定只看 `handoff_id`、provider 推论缺失、退出码归属写错、接受记录落盘语义
未定死、`from_handle` 证据等级措辞过宽、evidence Ref 与 I5 的冲突（B1–B8），以及四条建议项（B9–B12）。
逐条落点：B1 §3.2.2 + §4.1（去 3、`already_satisfied`/`validated_count`）；B2 §3.1.2 R5（只允许
same-handoff copy）；B3 §3.3.5 + §4.2（`handoff_duplicate_conflict`）；B4 §3.1.2 R4b + N3 + §0.2；
B5 §3.2.2 + §4.1（「来源」栏）；B6 §3.3.4；B7 §3.3.2 + §0.4 + §8.2；B8 §3.2.2 + §6 I5a；
B9 §9 门禁行；B10 §5.1（三条用例）；B11 §3.3.5（本机实测依据）；B12 §8（「建议」栏 +
owner-blocking）。

评审记录本体在本地私有材料中，不进仓库。本节的修订**不是**「评审通过」：本文仍是**未实现、未验收**的
设计草案，评审结论只说明本轮改动被接受为下一步的依据，不构成任何实现、部署或 live 验收的授权。

### v3（2026-11-12，阶段二实现回填）

阶段二按 `impl-brief.md` 落地，§8 的决策按「建议」栏采用（1/2 → D-b、7 → 删除 steering 用例 (b)）。
实现过程中遇到设计 §4.2 未覆盖的三种情形，按「不得自己选一个近似码」的原则新增四条（已回填到 §4.2
末表）：`handoff_wait_timeout`（124，B11 要求把超时与空批分开，就必须有自己的码）、
`handoff_record_unwritable`（2，回执没落盘 ≠ 回执冲突：前者可重试、后者不可）、`handoff_record_dir_unsafe`
（5，`control/handoff/` 被换成符号链接/文件）、`handoff_attempt_unreachable`（4，与 `wait-stage` 的 4 同义）。
另有两处实现层面的细化，不改变本文任何断言：`stage_path()`（纯函数，只读 `EVENTS`/binding 的 `paths`，
不动 `PATHS`）住在 `bootstrap_protocol.py`；`wait-stage` 的「不可达」判据不做在 marker 的父目录上——
`events/` 在第一个 marker 之前本来就不存在，在那儿返 4 会拒绝等待 S1（见§3.2.2 的 4 行）。
状态仍是**离线实现完成、live 未验收**；本文不因实现完成而变成「已验收」。

### v3.1（2026-11-12，代码评审整改回填）

两份独立代码评审对 `838f2a32` 均为 reject；整改（`review fixes` 提交）改了四处行为，相应收紧本文：

1. **§3.3.5 的 duplicate 判定扩到「同一批多行」**：同一 attempt 的一个批次里，同一 `handoff_id` 的多行
   必须先按五项字段聚合比较，任一项不同就是 `handoff_duplicate_conflict`（不写记录、不消费、不代选）。
   原实现只拒「多个不同 id」，同 id 多行直接取第一条，等于把冲突吞成成功。
2. **§3.3.4 的目录语义落实到 mode 与 fsync**：`control/` 与 `control/handoff/` 都要求非 symlink、`0700`；
   新建每一层都 fsync 上一层；已存在但 mode 不符 → `handoff_record_dir_unsafe`（不修权限）。
3. **§3.3.4 的「写后读回」不足以保证成功**：`publish_new` 在 link **之后**才 fsync 父目录，所以
   「link 成功 + 字节相同」仍可能是「目录 durability 未证实」。该情形归 `handoff_record_conflict`
   （`state=needs_reconcile`，`may_replay:false`），不因字节相同而 accepted。
4. **§3.2.2 的 0 字段不被借用**：`already_satisfied`/`validated_count` 只属于退出 0；124/5/4/2 的 payload
   不带 `validated_count`（它不是可携带的进度信号，进度诊断归 `strict-bootstrap-state --check`）。

另补两句与实现逐字对齐的文档（不改变断言）：任何一条 handoff 行的信封不可解析都阻断整批（含标了
另一个 attempt 的行）；`from_handle` 为缺失/空串/纯空白/`unknown` 一律 `handoff_sender_unanchored`。

### v3.2（2026-11-12，复审 blocking 回填）

复审仍 reject 的两条都只有一个原因：**同一个属性被两处各自推导**。本次只收敛这两处，不新增机制：

1. **`may_replay` 改由拒绝码决定**（实现里是一张模块级表，未知名默认 false），不再由“退出码 3”推导——
   `ABSENT` 同时代表“什么都没来”与“重复件”，于是 `handoff_duplicate_no_effect` 曾错误地拿到 `may_replay:true`。
   本表已同步：`handoff_duplicate_no_effect` 为 **false**；只有未写/未消费的四个码为 true。
2. **目录准备的失败成为结构化拒绝，且每次调用都 fsync 两层 parent**：`handoff_record_dir_unproven`（5 /
   `needs_reconcile` / 不可重放）取代原先会逃逸的 `OSError`；`if level.exists(): continue` 被删除——
   否则“上次创建成功、父目录 fsync 失败”的重试会跳过那次 fsync，把未证实 durable 的目录项当基础。`_verify()`
   的“mode 漂移只拒绝不修复”不变，协议里也写明了这句。

状态仍是**离线实现完成、live 未验收**。

### v3.3（2026-11-12，验收表回填）

§5.1 有 3 行与实现不符，本版只改这三行，不动代码与其它章节：

1. **「父目录缺失 → 4」改成「attempt 目录 / binding 缺失 → 4」**。实现（与 §3.2.2 表）一直如此：`events/`
   在第一个 marker 之前不存在，判 4 会拒掉协议里的第一次等待；测试
   `test_unreachable_attempt_answers_four_immediately` / `test_missing_binding_file_is_unreachable_not_a_wait`
   就是这两个判据。原文那句是实现之前的草稿，未随实现回写。
2. **evidence Ref「下游少带必须拒绝」降为规则约束**：当前没有下游消费者能强制，写成验收项等于给不存在的
   校验发合格证；改为「携带是调用方义务，无运行门禁」。
3. **原 `tests/core/test_wait_for_events.py`（扩）一行拆分**：`peek_wait_unsupported` 与「空批 rc 0 判超时」
   实际落在 `tests/bootstrap/test_bootstrap_handoff.py`；「provider unsupported 时 R3 不成立」只有文档规则，
   没有测试也不应有测试。

三处都是**把验收表对齐到已提交的实现**，没有放宽任何判据；离线结果（42/109 模块、1097 tests、
TARGETED OK）不受影响，live 仍未验收。
