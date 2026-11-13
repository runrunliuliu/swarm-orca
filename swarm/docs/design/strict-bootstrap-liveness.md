# Strict bootstrap：liveness、失败分类与门数收敛（修复计划）

状态：**草案；P0（失败分类闭合）已实现并保留；P1–P3 不再单独实施，由
[start grant](start-grant.md) 的 M1–M4 取代（M1–M4 未实现）**。D1–D3 与 §2 保留为诊断记录：
推进权（P1）在 start grant 里由“凭据向下流 + 只读投影”承担，门数（P2）升级为默认路径而不是可选优化，
收口（P3）并入 M4 的 `state`。本文只给诊断、修复包与
验收判据，**不构成**部署、重启、启动 Agent、迁移既有 attempt/Run 或放宽任何 gate 的授权。协议正文仍以
[strict-bootstrap-protocol.md](../../strict-bootstrap-protocol.md) 为准；本文与它冲突时以协议为准。
实现记录与偏差见 [§9](#9-实现记录p0-2026-11-10)。gate role 的 provider 已改为显式声明
（[§10](#10-实现记录gate-role-provider-声明化2026-11-10)），Pi Operator 的证据复核与已实现范围见
[§11](#11-pi-作为-gate-role证据已实现范围与剩余契约工作)；两者都不是 live 验收。

关联：[协议正文](../../strict-bootstrap-protocol.md)、[strict 启动](../../coordinator-strict-start.md)、
[Operator 启动](../../operator-startup.md)、[Operator 准备](../../operator-prepare.md)、
[入口选择](../entry-paths.md)；实现位置 `swarm/bootstrap_control.py`、`bootstrap_s5.py`、
`bootstrap_tool.py`、`bootstrap_driver.py`、`bootstrap_transport.py`。

## 0. 一页结论

1. **证据模型没问题**：字节 + 固定 pin + owner 提交 + 独立复核，是这套东西唯一的优点，直接让我们能
   准确说出"哪个槽有、哪个槽没有、为什么停"。不要动它。
2. **两处真设计错误**：
   - **D1 liveness 没有所有者**：状态机推进被交给"会主动结束自己的模型回合"，没有进程负责"必须往前走"。
   - **D2 失败分类不闭合**：核心不变量是"未知结果绝不重放"，但每次退出没有被映射到
     {未生效, 已生效, 未知} 的全集，调用方只能靠错误码猜。
3. **一处成本模型错误（D3）**：用模型回合当传输层；门数与权限不相称（只读、单权限任务也走双角色交叉复核）。
4. **净效果**：9 次 attempt、0 个 Run、0 个 Worker、0 条业务结论，且全部死在启动握手，没有一次死在业务上。
   fail-closed 而无法前进，等于活锁。

修复顺序固定为 **P0 失败分类 → P1 推进权 → P2 门数 → P3 收口**；每个包都必须自带"不新增机制"的红线。

## 1. 证据（已脱敏，无私有路径/终端/Run ID）

| attempt | 死点 | 类别 |
| --- | --- | --- |
| 2 | Operator 代写了 Coordinator 的 S0 | 角色写入权 |
| 3 | request input 传了错误 schema | 固定输入 |
| 4 | binding 的 `authorization_refs` 指向错误 Ref | 固定输入 |
| 5 | 走了 historical 分支自写 S1 槽 → 槽永久 unconfirmed | 角色写入权 |
| 6 | `strict-config-wait` 因一次瞬时失败提前中止 | 失败分类 |
| 7 | S5 review commit 遇 busy/identity-pending 后中止 | 失败分类 |
| 8 | 两个角色都结束 turn，S1 无人推进；brief 内 task 路径过期 | liveness + 固定输入 |
| 9 | S5 review：首次 `ObservationBusy`，重试后 `bootstrap_commit_requires_reconciliation`，槽 committed-but-unusable | 失败分类 |

9 次全部止步于启动握手；唯一一次业务侧动作是 0。

attempt 9 的具体形态值得单独记下（本文的主要证据）：

- 第一次提交返回裸 `ObservationBusy`（重试预算耗尽后回抛**可重试**码）；
- 第二次同命令返回 `bootstrap_commit_requires_reconciliation`（owner 的 `attempted` 守卫）；
- 结果是 S5 review 的 intent 已提交、最终输出缺失，即 `attempted ∧ ¬published` —— **该状态对外不可判别**；
- Operator 按规则写 blocker + STOP，没有重放。协议在"停"这一侧是对的，在"继续"和"说清楚"这两侧不成立。

## 2. 诊断

### D1 liveness 没有所有者

协议假设"某角色会一直 pull 到本阶段完成"。实际执行里一次 pull 只覆盖一个模型回合，回合结束即停摆；
没有进程负责"必须往前走"，也没有受支持的唤醒通道（不得向角色 pane 注入输入）。
`BootstrapMachine` / `RoleTool` 已经具备推进能力（`step()` / `pull()`），但现状是**模型在当调度器**，
工具只被逐条调用。

### D2 失败分类不闭合

需要一张**全集映射**：每次退出 → `not_admitted`（可原地重试）/ `admitted`（成功）/ `unknown`
（不可重放，只对账）/ `needs_reconcile`（不可重放，按原 pin 对账）。现在缺失的具体点：

- `ObservationBusy` 同时表示"锁没拿到（未写入）"与"重试预算花完（未知）"，两者决定相反；
- owner 侧 `attempted[target]` 先于 `publish_new` 记录，`attempted ∧ ¬published` 没有对外可判别的码；
- 超时/回复丢失的错误码区分不了"没写"和"写了但没确认"。

### D3 成本模型

一个槽 = `intent → candidate → 校验 → owner commit → confirmed`，启动链约 10 个槽，另有 lifecycle v2
与 session gate；每步在真实运行里是一个 30–60 秒的模型回合。对"只读核验"这种 payload，
门数/权限不成比例：两个角色权限相同，交叉复核等于自己审自己。

### 不是问题的地方

- `single-owner-memory-v1` 的持久化确认、固定 pin、不可覆盖槽、STOP 语义、只读 polling 边界：保留。
- `bootstrap_admission` 的 diagnostics（哪个槽未确认）、`safe_reason` 的 typed code：保留并扩展，不回收。

## 3. 目标 / 非目标

**目标**

1. 任意退出都能被归入 §2 的四类之一，并携带 `may_replay` 布尔；
2. 一条 attempt 的推进由一个进程负责，角色回合只出现在需要判断的边界；
3. 门数与任务权限相称：只读且单权限的 Run 不再要求双角色交叉复核；
4. 上述改动**不引入新机制**，只收敛既有状态机与错误码。

**非目标**

- 不删除证据模型、pin 校验、`plan == rebuilt` 相等性、STOP 语义；
- 不改 native 启动契约（`terminal.create` + short-prompt-v1）；
- 不为"能跑通"而放宽任何 fail-closed 分支；
- 不迁移、不重放既有 attempt/Run。

## 4. 修复包

### P0 失败分类闭合（先做，其他包依赖它）— **已实现**

改动点（实现见 §9；下条 1 的持久化变体被有意降级为责任者内存记录，理由在 §9）：

1. `bootstrap_control.CommitOwner`：把 `attempted` 与 `published` 写成**可原子判别的记录**（先写 intent 记录，
   成功发布后再写 published 记录；两条都带 target/sha256），使 `attempted ∧ ¬published` 成为可查状态，
   而不是只能靠 `publish_new` 抛错推断。
2. `commit` 回复新增 `state`：`not_admitted | committed | unknown`；
   `not_admitted` 只在"未取到锁 / 未进入 dispatch / 未记录 attempted"时给出。
3. `bootstrap_s5.commit_confirmed`：只对 `state == not_admitted` 重试；预算耗尽返回
   `bootstrap_commit_unknown_requires_reconciliation`（新码，**不可**回抛裸 busy）；
   `confirmed()` 用尽保留 `bootstrap_commit_confirmation_pending_requires_reconciliation`。
4. `bootstrap_transport.safe_reason` 白名单加入上述两码；
   `bootstrap_admission.ConfirmationUnavailable.diagnostics` 增加 `state`。

验收（全部为 socket 级，不接受 stub 替身）：

- busy 发生在 attempted 之前 → 重试成功，最终 exactly-once；
- 发布成功但确认回复丢失 → 返回 `confirmation_pending`，**不再 commit**；
- 记录 attempted 但目标缺失 → 返回 `needs_reconcile`，不得重放、不得覆盖；
- STOP / deadline 竞态 → 仍 fail-closed，且两码分明。

### P1 推进权收归驱动进程

改动点：

1. 把 `bootstrap_tool advance`（已落地，当前 tool-only）确认为**推荐推进入口**：
   只推进本角色 ownable 的机械动作，遇到需要本角色 authored candidate / review 判断即停。
2. launcher/驱动按真实依赖排序：**Coordinator 先写 S0 → 等 S0 → 起 Operator → 等 `owner.json`**。
   （"先起 Operator 等 owner"会死锁：Operator 必须先核验 S0。）
3. 新增 `blocked` 落盘语义：两个注册角色都 idle 且仍有 actionable 阶段时，
   由驱动进程写 durable `blocked`（带阶段、缺失槽、最后确认心跳），**不得**向 pane 注入输入。
4. 角色启动/brief 指令在 P0 的 socket 回归通过前**不得**把 `advance` 写成默认路径（沿用当前 tool-only 状态）。

验收：

- 双角色 idle + actionable 阶段 → 驱动写 `blocked`，不重放、不猜；
- 机械阶段（caller/observe）由一次 `advance` 完成，产出与手工 `pull/complete` **字节与 sha256 逐字节相同**；
- 需要判断的 submit/review 阶段 `advance` 停在 `needs_role_judgement` 并给出 `candidate_path`。

### P2 门数与权限相称

改动点：

1. 在 request/plan 增加**显式 pinned** 的任务类别字段（`read-only` / `write`），不推断、不默认。
2. `read-only` 类别下取消跨角色复核阶段（S3 fields/contract 的独立复核、S4 readiness 的独立复核），
   保留：身份门、任务范围门、单一 readiness、request/owner 提交、STOP。
3. 协议正文需要新增一节说明"哪些阶段被跳过、为什么证据模型仍成立、哪些 gate 反而必须保留"；
   跳过必须是**显式字段 + 显式拒绝**（字段缺失即拒绝），不能靠"没有就跑"。

验收：

- `read-only` 任务的槽位集合是 `write` 的真子集，且每个保留槽仍由 owner 提交；
- 字段缺失 / 取值未知 → fail-closed，报明确码；
- 同一 payload 在两种类别下的证据链差异可逐条对照。

### P3 收口与观测

1. 每次 attempt 结束（成功/失败/退役）都写 retirement 记录：outcome、furthest progress、
   `no_effect_audit`、证据 sha256、以及**本次命中的失败类别**（§2 四类之一）。
2. 把 P0 的四条 socket 回归纳入离线套件的慢组，并在 `run_offline.sh` 的 SLOW 注释里同步说明
   （慢的理由是真实签名/fsync，不是 sleep）。
3. 记录一次**只读 payload 的短链路**端到端通过作为验收（见 §7 决策）。

## 5. 本次修复不得引入（红线）

- 不得在"未知结果"后重放 commit、覆盖固定槽或生成新 bytes；
- 不得用 mock/进程内对象替代 owner 进程、签名或 fsync 来"加速验收"；
- 不得放宽 `plan == rebuilt` 相等性、pin 校验、`blocked`/STOP 语义；
- 不得为兼容旧 plan 而接受 short-prompt/pin 漂移；
- 不得让驱动进程写任何 owner 槽或代替角色做判断（它只能推进、只能记 blocked）。

## 6. 验收矩阵

| 包 | 判据 | 证据形式 |
| --- | --- | --- |
| P0 | 四类退出各有独立码 + `may_replay`；无重放 | 真实 owner socket 回归 + 一份 attempt 的 blocker 对照 |
| P1 | 推进不再依赖模型回合；双 idle → `blocked` | 驱动进程日志 + `blocked` 记录 + 等价性测试 |
| P2 | `read-only` 槽位集合是真子集且全部 owner 提交 | 两类任务的槽位清单对照 + 显式拒绝用例 |
| P3 | 每次 attempt 有 retirement 与失败类别 | retirement 记录清单（脱敏） |

P0 行已由离线 socket 回归覆盖（见 [§9](#9-实现记录p0-2026-11-10)）；P1–P3 行未实现，也没有任何 live
attempt 证据。

## 7. 未决决策（需要 owner 拍板，本文不代替）

1. **只读核验是否继续走 strict**：本文建议只读、单权限任务用单角色完成；strict 仅保留给
   "多角色会改同一份东西"的场景。若采纳，P2 从"可选优化"升级为"必须实现"。
2. **attempt 9 的处置**：它是一次协议发现，不是业务结果；业务核验仍未完成，是否先走简单路径交付。
3. **是否冻结新机制**：P0–P2 落地后停止在协议里新增机制，只允许修缺陷；需要 owner 明确一句
   "冻结"才具有约束力，本文不能自我授权。
4. **基线/输入的复位**：新增"登记式 attempt 必须有静态 prepare pin"后，每次 attempt 的输入都要重新
   prepare 并被 plan pin；准备顺序与谁负责重生成 brief/plan，需要写进部署流程而不是 brief 的自由文本。

## 8. 与现有文档的关系

- [协议正文](../../strict-bootstrap-protocol.md) 仍是规范；本文只补它缺的**失败分类全集**与**推进责任**。
- `#2 launcher 排序`（S0 → Operator）与 `advance` 的 tool-only 状态已实现，本文把它们从"临时做法"
  提升为待验收的正式路径。
- 本文不改变 [entry-paths](../entry-paths.md) 的入口选择结论：strict 仍是三条互斥执行路径之一，
  不是默认路径。

## 9. 实现记录（P0，2026-11-10）

范围：只做 §4 的 P0。P1（推进权收归驱动进程）、P2（门数与权限相称）、P3（收口与观测）与
§7 的四项决策**均未实现**，本文其余部分仍是草案。

### 9.1 改动

| 位置 | 改动 |
| --- | --- |
| `bootstrap_protocol.py` | `Confirmation` 新增可选 `state`；新增 `COMMIT_STATES`（`not_admitted`/`committed`/`needs_reconcile`/`unknown`）与 `COMMIT_OPS` |
| `bootstrap_control.CommitOwner` | 记录 `attempted`（intent）与 `published` 两个阶段；`commit_new` 拆出 `admit()`（只做 `attempted` 之前的检查）；所有准入前失败标 `not_admitted`，已记录 intent 标 `needs_reconcile`，发布失败/回复丢失标 `unknown`；`query` 返回 `state_of()` |
| `bootstrap_control.OwnerServer` | `commit`/`settle`/runtime 发布类回执的错误体带 `state`/`may_replay`；dispatch 前 busy、refresh/认证失败按 `not_admitted` 分类 |
| `bootstrap_control.AuthorityClient` | `commit_new` 要求 `state == committed`；`query` 透传 `state`；`needs_reconcile`/`unknown` 分别映射为 `bootstrap_commit_requires_reconciliation` / `bootstrap_commit_unknown_requires_reconciliation`；超时标 `unknown` |
| `bootstrap_s5.py` | 重试只看 `may_replay`（`not_admitted`）；预算用尽返回 `bootstrap_commit_unknown_requires_reconciliation`（新增），确认查询用尽仍是 `bootstrap_commit_confirmation_pending_requires_reconciliation` |
| `bootstrap_admission.py` | `ConfirmationUnavailable.diagnostics` 增加 `state` |
| `bootstrap_tool.py` | CLI 失败输出带 `state`/`may_replay`（路由用，不授权） |
| `strict-bootstrap-protocol.md` §5/§7 | 把四类回执与 `may_replay`、新码和客户端映射写进规范正文 |

记录的意图优先于后续任何拒绝：已因发布失败而 disarm 的责任者对同一 target 的再次提交
报 `needs_reconcile`，不会再退化成“未 arm，可重试”。

### 9.2 与本文原始写法的偏差（需要复核）

1. **P0.1 的“持久化记录”降级为责任者内存记录。** `attempted`/`published` 仍在同一串行区内
   先记 intent 后记 published，但因为 (a) 代次不会被 arm 到前任文件上，(b) owner 死亡本身
   就是 fail-closed，(c) 新增写入会把一个新失败模式放进提交临界区，所以没有新增
   `control/` 下的 journal 文件。代价：责任者存活期间可判别；责任者死亡后只能靠
   `durability_unverified` + 显式 reconcile，不能追认哪个 intent 曾经存在。若要求跨进程可
   判别，必须另开一项设计，而不是偷偷加文件。
2. **state 集合是四个而不是三个。** 本文 §4 P0.2 写 `not_admitted|committed|unknown`，
   但验收要求“记录 attempted 但目标缺失 → 返回 needs_reconcile”。`needs_reconcile` 现在
   是一等状态，`unknown` 只覆盖“记录存在但字节/意图不一致或结果无法判定”。
3. **超时码未改名。** `bootstrap_tool_timeout_requires_reconciliation` 保留（已有 pin 测试），
   只是现在同样带 `state=unknown`、`may_replay=false`。

### 9.3 验证（离线；**不是** live 验收）

- 新增 `tests/bootstrap/test_bootstrap_commit_states.py`（7 例，真实 owner socket/签名/fsync）：
  `not_admitted` 不写字节、`committed` 查询状态、发布失败 → `unknown` 且查询
  `needs_reconcile`、重放被 owner 拒绝、busy 在 attempted 之前重试到 exactly-once、
  busy 预算耗尽 → 新码且零发布、确认回复丢失 → `confirmation_pending` 且不二次 commit、
  commit 回复丢失 → `unknown` 且不重试。
- 既有用例按新分类更新两处：`test_bootstrap_production.test_fsync_gap_*`（原断言
  `rpc_rejected`，现断言 `unknown`+`needs_reconcile`）、`tests/bootstrap/test_bootstrap_admission.py`
  （diagnostics 增加 `state`，并新增一条状态路由用例）。
- 执行（均为离线）：
  - `tests/run_offline.sh --full`（提交 `f796c001` 的代码，最终代码）→ 2478 tests，OK，18 skipped，
    1290 s；这是本次唯一可报作 **offline PASS（full）** 的结果。
  - 迭代期 `tests/run_offline.sh --fast`（同一代码）→ 2335 tests，OK，18 skipped；
  - 慢模块单跑：`test_bootstrap_production` + `test_bootstrap_admission` + 新增模块（62 OK）、
    `test_bootstrap_workflow` + `test_bootstrap_failures` + `test_bootstrap_submission`（64 OK）、
    `test_bootstrap_startup_handoff`（40 OK）。
- 未执行：任何 live attempt、部署、重启、Owner 拍板项。`--full` 不证明目标文件系统、原生
  runtime 或真实 Agent 可用。

### 9.4 仍待处理

- P1：`blocked` 落盘语义与驱动进程的推进责任（本文 §4 P1）；`advance` 仍是 tool-only。
- P2：`read-only`/`write` 类别字段与跳过规则，依赖 §7.1 决策。
- P3：retirement 记录与四类失败类别的落盘观测。
- §7 的四个决策一个都没有被这次实现替代或预判。

## 10. 实现记录（gate role provider 声明化，2026-11-10）

范围：只做“provider 是被声明、被核验的属性，而不是读取器里的常量”。P1–P3 与 §7 的四项决策
仍然未实现；本文仍是草案，本节不构成 live 验收、部署或放宽任何 gate 的授权。

### 10.1 改动

| 位置 | 改动 |
| --- | --- |
| `provider_capability.py`（新增） | 唯一的 provider → 证据能力表：`evidence_format`、必须 identity 字段、必须 transcript 记录、TUI adapter、已知缺口通道。三类消费者需求 `BOOTSTRAP_ROLE` / `OPERATOR_IDENTITY` / `TUI_OBSERVATION`；`require()` 对缺失/空白声明、未知名、已知但证据不可读分别给出调用方的码，并把缺失通道放进 `missing_evidence`。模块无依赖，避免把 native 读取器拖进两个门 |
| `bootstrap_identity.NativeIdentity` | registration 升到 schema v2，每个 role 必须自带 `provider`；`__init__` 在任何 `/proc`/native 探测前解析能力，`_refresh` 用该能力构造 capture 选项（原来的 `provider="trae"` 字面量已删除）并在每次刷新用**实际 observation** 复核声明字段 |
| `operator_session.py` | 删掉 `provider == "trae"` / `!= "pi"` 的字面量判断，改用能力表；capture 的 `format` 也来自表；capture 后再用 observation 复核。既有码保持：`operator_session_pi_operator_unverifiable`、`operator_session_provider_unsupported` |
| `bootstrap_tool.RoleTool` | S2 观察与 `fields` 模板不再是 `"trae-tui-runtime-v1"` 字面量：先解析 coordinator 的已声明 provider，adapter 取自表 |
| `coordinator_tui_errors.failure` / `bootstrap_tool` CLI | typed 拒绝时额外输出 `missing_evidence`（路由诊断，不是权限） |
| `strict-bootstrap-protocol.md` §5.1/§12.2 | 写入 provider 契约、能力表规则与全部拒绝码；registration schema v2 |

### 10.2 provider 契约

1. 只接受表中逐字列出的 provider 名；不折叠大小写、不去空格、不做别名，未知名字拒绝而不是
   默认 trae。
2. 已知但本版本读不到某条证据的 provider 由能力表拒绝，并逐条给出缺失通道。§10 当时的例子是
   pi；§11 记录了对 pi 证据的复核与随之实现的 pi 支持，以 §11 为准。
3. 表是声明不是证明：observation 必须实际带有所需字段，否则同样拒绝。
4. 身份、进程树独立性、incarnation、launch token、pin、STOP 门全部保留；能力检查只回答
   “这个 provider 能不能被核验”，不替代任何既有断言。

### 10.3 验证（离线；**不是** live 验收）

新增：`tests/core/test_provider_capability.py`（8 例，纯表）、`tests/bootstrap/test_bootstrap_provider.py`
（8 例，真实 pin 文件 + 生产 `NativeIdentity`）、`tests/operators/test_operator_session.py` 新增 6 例
（pi 拒绝的 `missing_evidence`、未知 provider、缺失 hook 行、缺失 `session_meta`、缺失
`turn_context`、observation 缺字段）。既有用例只做 schema/字段适配：
`test_bootstrap_production` 的 registration 改为 schema v2 带 `provider`，fake capture 返回
`transcript_path`；未放宽任何断言。

执行（均为离线，最终代码）：

- `tests/run_offline.sh --full` → 2501 tests，OK，18 skipped，1356 s；这是本次唯一可报作
  **offline PASS（full）** 的结果。
- 迭代期 `tests/run_offline.sh --fast` 与单模块（`test_bootstrap_production` 50 OK）均为迭代反馈。

未执行：live attempt、部署、重启、真实 pi/Trae 会话核验。本记录不证明目标宿主上的 provider
证据可用。

### 10.4 仍待处理

- **S5 启动适配器仍是 Trae-only**：`operator_startup.py` / `coordinator_strict_start.py` 只接受
  `trae-tui-runtime-v1`，`trae_tui.py` 本身是 Trae 读取器。本次只把 bootstrap 两个 gate role 与
  Operator 观察的 provider 变成显式声明；一个未来 provider 要真正跑完 S5，还需要它的 TUI/
  exec adapter 与对应契约值，否则会在 S5 契约校验处停止——这是已知边界，不是本次能完成的迁移。
- 新增 provider 需要真实可核验通道 + adapter + 离线回归，不能只加表项（pi 见 §11）。
- P1–P3 与 §7 四项决策不变。

## 11. Pi 作为 gate role：证据、已实现范围与剩余契约工作

状态：**Pi Operator、bootstrap 双角色身份与 Pi Coordinator（S2 观察 + S5 契约）已实现并离线回归**；
Live 验证、Run 之后的 continuation/scheduler 与 materials 的 launch-plan 生成器仍待处理。
本节只记录已核验的事实与剩余工作，不构成 live 验收或部署授权。

### 11.1 已核验的证据（2026-11-10）

| 事实 | 出处 |
| --- | --- |
| Orca 给经它启动的 pi pane 装托管状态扩展，POST `session_id`/`session_file`/`launchToken` 到 `/hook/pi` | `orca/src/main/pi/agent-status-extension-source.ts`、`agent-status-handler-source.ts` |
| 服务端把 pi 的 `session_id`+`session_file` 规范成 `providerSession{key:'session_id',id,transcriptPath}` | `orca/src/shared/agent-session-resume.ts:243-250` |
| `launchTokenHash` 与 `evidenceObservedAt` 对 pi 行同样写入（provider 无关） | `server-persistence.ts:50-58`、`server-status-application.ts:165`、`server-persistence-validation.ts:181` |
| pi transcript 根为 `{"type":"session","id":<uuid>,"cwd":…,"version":3}`，记录带 `id`/`parentId` 链与 ISO `timestamp`，assistant 消息带 `model`/`provider`/`thinkingLevel` | 本机 pi 会话日志的实际记录形状（只读取记录类型/键，未导出内容）；对照 `orca/.../session-scanner-graph-parsers.ts:233-260` |

结论：pi 的身份与设置证据与 Trae 同源同强度（pane hook 行 + 根记录 + 每轮设置 + 启动 token），
差别只在记录词汇与可证明的设置集合——不是“pi 不可核验”。

### 11.2 已实现

| 位置 | 改动 |
| --- | --- |
| `provider_capability.py` | 能力表增加 `records`（语义 → provider 记录类型）与 `settings_fields`；`pi` 变为可核验（`session` 根、`message` 设置、`PI_SETTINGS`），仍未给 `tui_adapter` |
| `pi_transcript.py`（新增） | 读 pi transcript：根 id 必须是 UUID、`version>=3`、`cwd` 必填、`id`/`parentId` 链不得悬空/断裂、时间不减、assistant 设置齐全；返回前缀 pin、inode、`observed_at` |
| `swarm_ledger/runtime_binding.py` | pi 行：拒绝 `providerSessionOnly`/`toolAgentId`；`require_launch_commitment` 选项（gate 角色为 true，usage 记账不要求）；capture 根记录按 provider 校验（trae `session_meta` / pi `session` 且 id 相等） |
| `operator_session.py` | 设置读取按 provider 分派：trae `turn_context`（含 reviewer 别名）、pi 用 `pi_transcript`；`expected_effective` 只允许该 provider 的 `settings_fields`，其余键 → `operator_session_expected_effective_provider_unsupported` |
| `bootstrap_identity.py` | 两个 gate role 的 capture 传 `require_launch_commitment=True`，provider 来自 registration |
| docs | 协议 §5.1、operator-prepare、coordinator-strict-start/startup 的 provider 文本 |

离线回归（本次）：`test_provider_capability` 11 例（含 pi 能力与 `settings_fields` 边界）、
`test_bootstrap_provider` 10 例（pi 双角色解析、缺 launch commitment、Coordinator 缺 adapter）、
`test_operator_session` 29 例（新增 pi 绑定/设置收窄/缺 hook/缺 turn 设置/CLI typed code）、
`test_operator_startup_identity` 16 例（新增 pi 证据通过 session gate、Trae 转录拒绝、缺 launch
commitment 拒绝）、`test_runtime_binding` 26 例（新增 pi 根记录与 gate/记账的 launch commitment
区分）。既有 trae 断言未放宽；`test_runtime_binding` 的 pi 用例从“codex 式 `session_meta`”改为
pi 真实的 `{"type":"session"}` 根记录（旧断言编码的是错误格式）。

### 11.3 Pi Coordinator（owner 选择 (a)：pinned pi runtime policy）

| 位置 | 改动 |
| --- | --- |
| `pi_policy.py`（新增） | 审查过的 pi runtime policy：精确字段 `schema_version,scope,provider,model,thinking_level`（`model` 为 `{provider,id}`），`read()` 只读同用户普通文件并返回可核对的三个设置。示例见 `examples/pi-runtime-policy.example.json` |
| `tui_adapter.py`（新增） | 唯一的 adapter 名 → （观察器、policy 关键字、policy 校验）映射；未知 adapter 拒绝。`trae_tui`/`pi_tui` 懒加载，避免环 |
| `pi_tui.py`（新增） | 等价 `trae_tui.observe` 的观察器：同一 `runtime_binding` capture（含 `require_launch_commitment`）、同一 strict-caller 指纹、`pi_transcript` 根/链/设置校验、anchor 前缀与 hook 单调、`ContextFreshnessError`；产出同样的 `binding`/`thread_id`/`effective`/`kind` 形状，`thread_id` 为 pi uuid |
| `pi_transcript.py` 的严格性 | 线性链（单一 null 起点，其后逐条相连）→ `pi_session_chain_broken`；freshness 取**被采纳 assistant 记录**的时间戳，另给 `activity_at` 仅作诊断；policy 用 pinned Ref，读取前后与观察末尾各重验 |
| `coordinator_startup.py` | `validate`/`identity`/`run_gate` 改用 adapter 注册表：pi 契约校验 pi policy，观察器按 adapter 选择；tui 分支不再固定 Trae |
| `coordinator_strict_request.observed_coordinator` | 由 `kind` 反查 adapter，接受 `pi_tui_*`，adapter 与 kind 不一致即拒绝 |
| `coordinator_strict.py`、`coordinator_strict_start.py`、`operator_startup.py` | 调用者 pin 与契约校验接受任一已审查 TUI adapter |
| `bootstrap_tool.py` | S2 观察与 fields 模板都从能力表取 adapter，再经注册表取观察器/policy 关键字 |
| `provider_capability.py` | pi 的 `tui_adapter` 为 `pi-tui-runtime-v1` |

pi 与 Trae 的**显式差异**（写进协议 §5.1，不在代码里假装等价）：`expected_effective` 只允许
`PI_SETTINGS`；`observation.roots` 对 pi 只是审查输入（pi 无 sandbox 面，观察器不声称已核实）；
anchor 要求同一 runtime id。

离线回归（本节）：`test_pi_tui.py` 32 例——policy 形状/路径、真实字节的 pi 观察（绑定/设置/anchor
前缀/陈旧/缺 hook/换 policy）、陈旧设置 + 新追加记录仍判陈旧、第二条 null 起点链被拒、policy Ref
被替换即 `file_pin_changed`、`pi-tui-runtime-v1` 契约通过 session gate、Trae execution 配置被拒、
S5 过期上下文被拒、`observed_coordinator` 接受 pi kind 且拒绝伪造 adapter；
`test_coordinator_startup`/`test_coordinator_strict*`/`test_operator_startup*`/`test_bootstrap_workflow`
共 374 例回归通过。

独立 review（codex-ark，同 worktree 只读）：首轮给出 3 条问题（freshness 取最后一条而非设置记录、
非 root 记录可另起 `parentId: null` 链、pi policy 以裸路径传入），全部按上述改动修复并被复检为
RESOLVED；trae 分支仍收路径、仍用 `read_trae_execution`，未发现新的 fail-open。

仍未完成：live 验证（需要一台经 Orca 启动且存在 `source=pi` hook 行的宿主）；Run 之后的
`coordinator_tui_continue.py`/`coordinator_tui_scheduler.py` 仍按 Trae 读；`coordinator_launch.py` /
`trae_coordinator.build_trae_plan` 的 launch-plan 仍是 Trae 形状（Pi 的 S0 materials 需单独迁移）。
