# 投递台账（delivery ledger）开发计划

状态：**草案，未开始**。本文只是计划与退出条件，不构成实现、部署、重启、创建 worktree 或启动 Agent 的授权；
§5 的各工作包开始前仍需按既有规则取得当前任务授权与并发上限。

来源：外部项目的设计借鉴，调研与证据见父工作区的 `docs/swarmchat-20261109.md` §12（该文档不在本仓库）。
**不引入其代码、服务、依赖或身份体系**，只借"投递确认 + 已读位置回放"这一层语义；本仓库 Python 仍只用标准库。

关联：[strict Operator monitor](../../operator-monitor.md)、[Coordinator TUI 契约](../../coordinator-tui.md)、
[strict Coordinator](../../../orca/docs/reference/strict-coordinator.md)。宿主工作区另有执行规则与产物归档/台账说明
（`skills/orchestration/references/swarm-execution-policy.md`、`swarm/artifact-storage.md`、`swarm/ledger.md`），
均不在本仓库，引用时不作文档链接。

## 0. 前提与共识

1. **问题不是"没有确认"，而是"确认散落且不可查"。** 现有实现已经有：`operator_monitor.deliver()`
   的 outbox + `request-show` 对账 + `--retry-request` 幂等 + `entry["delivery"] = receipt(...)`
   （`operator_monitor.py:227-257`）；`coordinator_tui_scheduler` 的 pre-send 竞争检测与
   `incomplete_continuation`（已投递但未提交的回合只记录、不重发）；`operator-monitor.md:251-253`
   对"已投递但未 ACK 的批次"的筛选；以及 `coordinator_strict_delivery.py:132` 已写下的
   `terminal text is not delivery`。缺的是把它们合成**一份可查询的、带游标的投递结局台账**。
2. **不新建消息总线。** 台账是现有 outbox/journal/receipt 的投影与补充字段，不是第二个真相源。
   冲突时以原生回执为准，台账只记账、不仲裁。
3. **"处理"仍可以是 unknown。** 本计划不把"收到/已读"推成"已处理"；三态（是 / 否 / unknown）全程保留，
   未知不记 0、也不记 delivered。
4. **向后兼容优先于完整。** 新增字段一律可选、新目录独立；旧代码读新状态必须仍能工作，
   新代码读旧状态必须降级为 unknown 而不是失败。
5. **不改上游 `orca/`。** 需要的地方用仓库内适配层；确需上游改动时另立窄改动并单独说明。
6. 台账记录的是**投递事实**，不承担业务验收、不替代领域 checkpoint、不参与门禁判定。

## 1. 目标与非目标

**目标**

- G1 每次投递有稳定身份：`delivery_id`（幂等键派生）+ 每个 recipient 的单调 `seq`。
- G2 四段结局可区分：`intent`（已决定发）→ `accepted`（原生确认被接受）→ `consumed`（有本域证据）
  → 其间的空洞显式记 `unknown`。
- G3 断线/重启后从**最后确认游标**续传，不重放全量、不重复注入、不静默丢弃。
- G4 任意时刻 T 可查"该 recipient 已确认到哪条"，用于复盘"它当时手上有哪些已投递事实"。
- G5 复用现有 outbox / `publish_new` / `Journal` 单写者锁，不新增常驻服务与依赖。

**非目标（明确不做）**

- 不做聊天服务、频道/看板/浏览器面板，不做 agent 间自由群聊。
- 不把 `peek`、搜索、预览、线程读取等"看过"的动作记为已投递或已消费。
- 不实现"已读即已处理"的推断，也不以台账替代领域验收或门禁回执。
- 不做跨主机/跨 runtime 联邦、多租户、权限体系。
- 不做 100+ Agent 扇出优化、连接回收、消息索引等"自建 broker"才需要的工程。
- 不自动重发 `ambiguous` 的投递；对账路径仍由现有恢复规则决定。
- 不迁移既有 Run 的历史状态，不改变已固定 pin 的行为。

## 2. 术语与数据模型（schema v1，草案）

- **delivery**：一次"把一段事实/指令交给某个 recipient"的意图及其结局。recipient 类型先支持
  `run:<id>` 与 `worker:<handle>`，其它类型留枚举位。
- **channel**：投递途径，先支持 `native-orchestration-send`（现有 `orchestration send`）与
  `terminal-prompt`（注入终端提示）。两者证据强度不同，必须分开统计。
- **cursor**：`(run, recipient, channel)` 三元组上"已确认到哪条"的单调位置；按结局分三种游标：
  `accepted_cursor`、`consumed_cursor`、`ambiguous_before`（其后存在结局不明条目）。
- **事件**（只增不改，一条一个内容寻址文件）：

```json
{"schema_version": 1,
 "delivery_id": "<uuid4，由 idempotency_key 派生，重发复用>",
 "seq": 42,
 "run": "<run id>", "recipient": "worker:<handle>", "channel": "terminal-prompt",
 "created_at": "<RFC3339 UTC>",
 "intent": {"payload_sha256": "<sha256>", "idempotency_key": "<sha256>"},
 "state": "accepted",
 "evidence": [{"kind": "native_request_id", "value": "<requestId>"}],
 "unknown_reason": null}
```

- **证据种类（`evidence.kind`）**：`native_request_id`、`turn_started`、`checkpoint`（带 `sha256` pin）、
  `worker_done`、`reconciliation_absent`（对账后确认不存在）、`not_supported`（该 channel 无法取证）。
- **落盘**：`<state_root>/delivery/events/<sha256>.json`（`publish_new` 写入，不可覆盖）+
  `<state_root>/delivery/cursor.json`（单写者摘要，`Journal` 语义）。目录 0700、文件 0600。
- **游标落盘频率与代价**：`cursor.json` 每 1 秒 flush 一次，SIGTERM/正常退出时再存一次。崩溃最多回退 1 秒的
  确认位置，后果是**可能重复**（已投递条目被重放）而不是**丢失**；因此重放必须幂等（I1），不得靠游标精度保正确性。
  不采用"每次确认都 fsync"：那是拿写入放大量换 1 秒精度，与既有单写者模型不成比例。

## 3. 不变量（每条都要有确定性测试）

| 编号 | 不变量 | 反例即失败 |
| --- | --- | --- |
| I1 | 同一 `idempotency_key` 至多产生一次 `accepted`；重发只追加"重试观察"事件 | 两次 accepted |
| I2 | 写 `consumed` 必须携带至少一条 `evidence`，否则拒绝写入 | 空证据的 consumed |
| I3 | 崩溃后 `accepted` 无 `consumed` 的条目保持 `ambiguous`，**不自动重发** | 恢复时静默重发 |
| I4 | 游标单调不回退；`since=cursor` 查询不漏不重（对已知集合做双向比对） | 少一条或来两次 |
| I5 | `unknown`、`false`、`true` 三态分离，序列化后仍可区分 | 把未知写成 0/false |
| I6 | 事件文件只增不改；任何"修正"都是新事件 | 原地改写事件 |
| I7 | **读后重验**：对算出的待投递集合再做一次 recipient/权限校验，期间已失去资格的条目必须丢弃而不是投递 | 越权后仍投递 |

## 4. 阶段与退出条件

工作量按工作包估，取决于受理人的熟悉度；执行者数量与并发上限由启动操作者按既有规则给定，本计划不设。

### M0 决策冻结（0.5–1 天）

- 冻结"什么算一次投递"：列出所有会跨 Agent 传送事实的调用点（`orchestration send`、终端提示注入、
  outbox 重放），逐条判定 in/out scope，产出术语表与 recipient 枚举。
- 产出：§2 定稿（字段可再议，语义冻结）、§3 不变量清单。
- **退出**：评审通过；对"哪些 channel 能取证"达成一致；§8 未决输入至少回答第 1、4 项。

### M1 只读重建（2–3 天，不改写入路径）

- 从现有 outbox、journal、`request-show` 回执**离线重建**台账，提供 `delivery-show --since` 只读查询。
- 输出：一份差异报告（重建结果 vs 现有对账结论），不一致处标 `unknown` 并列原因。
- **退出**：对至少一次历史 Run 能在不写入、不唤醒、不重启的前提下完成重建；
  差异报告逐条解释；旧状态文件零修改（用 hash 前后比对证明）。

### M2 写入接入（3–5 天）

- 两条路径接入 `delivery_id` 与 `accepted` 记录：`operator_monitor.deliver()`（现有 outbox 循环内加字段，
  不改变发送顺序与重试语义）与 `coordinator_tui_scheduler` 的 send 前后（沿用既有 pre-send 竞争检测）。
- 明确不改变：重发策略、对账规则、门禁、pin 校验。
- **退出**：I1/I2/I3/I6 的确定性测试通过；旧 state 可读、新 state 对旧代码可读（双向兼容各一条测试）；
  `unknown` 统计可输出。

### M3 消费证据与复盘查询（3–5 天）

- 把 `turn_started` / 领域 checkpoint / `worker_done` 接成 `consumed` 证据；`terminal-prompt` 通道在无证据时
  记 `not_supported`，不得推断。
- 提供 `cursor-at --time T --recipient`，回答"该时刻它已确认到哪条"。
- **退出**：在一次真实小波次运行中，三态在一次注入上可被区分并留有命令级证据；
  `cursor-at` 的结果与人工抽样核对一致；未取证比例被明确报告（不是 0 也不是 100% 猜测）。

## 5. 工作包与文件所有权

| 包 | 内容 | 允许改动 | 禁止改动 |
| --- | --- | --- | --- |
| W1 | 数据模型、校验、fold | 新增 `delivery_ledger.py` | 既有模块的公开行为 |
| W2 | 落盘、游标、单写者 | 新增 `delivery_store.py`；复用 `coordinator_io.publish_new/pinned`、`coordinator_state.Journal` | `coordinator_io` 的既有函数签名、`Journal.validate` 的必填集合 |
| W3 | 发送路径接线 | `operator_monitor.py`、`coordinator_tui_scheduler.py` 的最小插入 | 重试/对账语义、发送顺序、门禁判断 |
| W4 | 只读查询 | 新增 `delivery_cli.py`（`show` / `since` / `cursor-at`） | 任何写入路径 |
| W7 | 观察者只读模式 | `delivery_cli.py` 增加 `--read-only` 入口：同一实现以只读模式启动，不写事件与游标、不生成回执 | 写路径；不得以只读模式伪造 `accepted` |
| W5 | 测试 | 新增 `tests/test_delivery_ledger.py`、`tests/test_delivery_compat.py` | 改动既有测试以迁就新实现 |
| W6 | 文档 | `operator-monitor.md`、`coordinator-tui.md` 各增一节"投递台账" | 改写既有语义段落 |

落地顺序：W1 → W2 → W5(确定性) → M1 只读 → W3 → W5(兼容) → W4 → W7 → W6。

## 6. 测试矩阵

- **确定性（离线，默认门）**：I1–I7 各一条；双写者被 `flock` 拒绝；`publish_new` 冲突不覆盖；
  crash 注入（在 accepted 之后、consumed 之前中断）后重启只产生 ambiguous 不重发；
  I7 用"取得待投递集合后撤销资格"的顺序测试，验证条目被丢弃而非记录为已投递。
- **原生集成（需要真实 runtime）**：用真实 `request-show` / `turn_started` 回执验证 `accepted` 与 `consumed`
  的对应关系，不 mock 原生响应；判据是"台账与原生回执逐条一致"。
- **真实 Agent 验收（需单独授权）**：一次小波次（1 个 Coordinator + 1–2 个 Worker），人为制造一次
  注入后中断，验证恢复续传位置正确、未重复注入、`unknown` 如实记录。**运行诊断不等于通过验收**。
- 不做的：100 Agent 压测、跨主机、跨 runtime 联邦；也不把"离线测试全过"当作验收结论。

## 7. 验收与证据口径

- 每条验收写命令 + 原始输出；不接受"助手说成功""文件存在"当作证据。
- `unknown`、`not_supported`、`reconciliation_absent` 必须显式出现在报告里；未知不记 0。
- 分别报告"新增测试数"与"实际执行测试数"，并写明未跑的部分与原因（含 runtime 不匹配、缺依赖等）。
- 台账本身不参与门禁；它只提供事实，判定仍由既有领域规则做出。

## 8. 未决输入

1. 目标 runtime 与是否需要在真实 Run 上做验收（当前未获授权）。
2. 是否允许在 `operator_monitor.deliver()` 主路径加字段——涉及既有部署 pin，改动需单独评估。
3. 事件保留期与归档位置（需与宿主工作区的产物归档规则对齐后再定）。
4. 是否扩展到 Worker 侧：当前只有 Operator→Run 有原生回执，`terminal-prompt` 通道取证能力有限。
5. 与宿主工作区 Token/耗时台账的关系：投递台账是否计入同一份成本/耗时统计口径，需先明确不重复计数。

## 9. 风险与回滚

| 风险 | 表现 | 缓解 |
| --- | --- | --- |
| 语义膨胀 | 台账被当成业务真相，冲突时被用来仲裁 | §0.6 写死"只记账不仲裁"；查询 CLI 只读 |
| 重复计数 | 与既有 outbox 各记一遍，统计翻倍 | M1 先只读重建并出差异报告；口径在 §8.5 前不合并 |
| accepted 假阳性 | 发送返回成功但未被接受 | I2 只认原生 `requestId`；无回执记 unknown |
| 兼容回退 | 旧代码读新状态失败 | 新字段全部可选；兼容测试双向各一条 |
| 收益落空 | 真的只有"送到"没有"处理"证据 | M3 允许结论为"该 channel 不可取证"，并如实报告比例 |

**回滚**：新目录独立，删除/停用不影响既有状态；既有模块只加可选字段，回退即停止写入并保留台账只读。

## 10. 阶段状态

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| M0 决策冻结 | 未开始 | — |
| M1 只读重建 | 未开始 | — |
| M2 写入接入 | 未开始 | — |
| M3 消费证据与复盘 | 未开始 | — |

本表在实施后按实际执行填写；未执行不填"完成"。
