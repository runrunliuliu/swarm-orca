# issue-sedimentation.md v2 独立评审（codex-ark）

结论：v2 的 TS-in-orca 方向可以作为实现方向继续，但不应按当前范围直接开工；先把 M1 缩到“incident store + crash-only onPtyExit 快照 + 可重放影子”的最小闭环，并修正 §4/§17 的过度事实声明。

评审范围：只读核对 v2 草案、v1 评审，以及 §4/§17 指向的 Orca 源码子集；未跑测试、未启动服务、未修改设计原文。本评审只写本文件。

## 必须修改项（按严重度）

1. §8 “acceptance 失败不改变 dispatch/task 状态”会制造静默悬挂。把 incident 与 lifecycle 分离是对的，但“不满足 → 写 incident，状态不变”不够：若 `completeDispatch` 被拦下而 dispatch 仍是 active/running，可能永久无人推进。应进入显式 `needs_triage/blocked`、打开问题/升级，或让 dispatch 保持可见待裁决；不能既不完成/失败，也不产生调度可见状态。
2. §7.1 单一写点可行性被写得太晚。`onPtyExit` 中 pane/session 相关映射在清理前可取，源码也先 `collectAgentStatusPaneKeysForPty` 再 retirement；但尾部写入不能假设映射仍在。必须在清理前构造 incident snapshot，随后写 DB/影子。
3. §11.2 “同步崩溃安全 NDJSON sink”过度承诺。`LocalFileSink.push` 默认先入内存 buffer，32 条或 200ms 后才同步写；写错会吞、无 fsync、轮转可部分完成。若作为 crash reconcile shadow，关键记录必须 `push` 后 `flush`，并接受“best-effort shadow，不是 WAL”。
4. §7.2 no_progress 的依据不足。源码有 `stateStartedAt/turnStartedAt/receivedAt`、reaping、assistant/transcript retry，但没有看到 `wait_reason/expected_wait` 一等字段，也没有通用无进展判定器；应标为设计中，不应借 “readiness retry” 证明已实现。
5. §6 幂等键 `(source_kind, source_id, facet)` 不足以覆盖所有类。对 crash 足够（若 `source_id=pty incarnation`）；对 no_progress 若 `source_id=paneKey, facet=stall`，恢复后第二个停滞窗口会被去重吞掉；对 acceptance 若同一 dispatch 有多条规则也会冲突。需要把 turn/status epoch、window_start 或 acceptance rule id 纳入 source_id/facet。
6. §14 “改点 ≤5、重放 ≤20 分钟”不现实，应降为目标而非验收口径。实际触点会包含 store 初始化/宿主分区、onPtyExit、status、dispatch acceptance、CLI handler/spec/help、preload/IPCs、shared types、renderer/automations/测试等；第一次重放很可能超过 20 分钟。

## §4/§17 事实核对

| 项 | 结论 |
| --- | --- |
| PTY 退出原因分类 | 符合。`TerminalExitCause` 与 `operator_close/signaled/exited/unknown` 存在，unknown reason 也存在。 |
| PTY 退出汇聚点 | 基本符合。`onPtyExit` 是中心路径，含 incarnation 校验、exit cause、dispatch fail 调用；但 abnormal SSH、stale incarnation、无 pty 早退是边界。 |
| 状态归一化单入口 | 基本符合。`applyNormalizedStatus` 是主侧归一化入口之一并在 update 层实现；但 `server-state.ts` 只是抽象声明，不宜说该文件本身实现单入口。 |
| 状态回收/新鲜度 | 部分高估。reaping 存在，状态时间戳存在；`server-status-retries.ts` 是 transcript/assistant-message retry，不是通用 readiness/no-progress retry。 |
| 结构化会话状态流 | 本轮未按用户列出的源码文件逐项深核；不应作为 M1 必需事实。 |
| Dispatch 结算/失败 | 符合。`completeDispatch/failDispatch`、heartbeat/stale dispatch 存在；业务 acceptance 不存在。 |
| 升级分诊 | 符合但范围窄。`applyEscalationToDispatch` 只处理带精确 Dispatch 绑定的 escalation → fail/circuit breaker。 |
| 不可变记录 + 触发器 | 符合。有 administrative history immutable trigger 范式。 |
| 版本化迁移 | 符合。orchestration `SCHEMA_VERSION = 44`；也支持“不碰它”的独立库理由。 |
| 同步 NDJSON sink | 能力存在但被高估。同步发生在 `flushBuffer/writeSync`，不是每次 `push` 都落盘；不是 crash-proof WAL。 |
| 脱敏 | 存在但范围有限。redactor 覆盖 secret/URL/env/attribute 等，不保证私有路径、主机名和所有 evidence 摘要安全。 |
| SQLite 封装 | 本轮未完整打开封装实现；从引用看可复用，但设计应避免把封装能力说成 incident store 已存在。 |
| CLI 分组注册 | 符合。manifest 可加组；但不是“1 行完成 CLI”，handler/spec/help/格式化仍是新工作。 |
| preload API 分层/多宿主持久化/automations | 源码中有相应范式；作为可借鉴基础成立，不表示 incident UI/mining 已接通。 |
| 业务验收、incident store、自报、triage、md、挖掘、端到端验收 | 草案标为缺口/设计中是正确的；不得在实施计划外宣称已实现。 |

## 独立 DB vs 塞进 orchestration DB

建议独立 DB。技术理由不是“少改迁移”本身，而是写入域不同：incident 由 PTY/status/CLI/dispatch 多入口产生，可能没有 Run/Task；写入频率和保留期与调度状态不同；不可变 append-only + decision 投影与 orchestration 的任务状态机不同；主进程崩溃 reconcile 需要能在 orchestration DB 未打开或迁移失败时记录最低限事实。orchestration DB 只应通过 run/task/dispatch id 被引用，不能成为 incident 的唯一归属域。

## 单一写入点与丢失窗口

crash 的单一写点可行，但实现条件是：在 `onPtyExit` 进入后、清理/retire 之前取 pty incarnation、paneKey、session/handle、exit cause 和 surface 快照；再用该快照写影子/DB。仍有窗口：主进程在 callback 入口到 shadow flush 前崩；stale incarnation 被丢弃；abnormal SSH preservation 不走 dispatch fail；`exitCause` 为 unreported/unknown；DB 写成功但 shadow 未写或反之。幂等 replay 能处理重复，不能补救“事实从未落 shadow/DB”。

## 幂等键反例

`(source_kind, source_id, facet)` 对“同一 pty incarnation 的 exit”足够；对状态停滞不足。反例：同一 pane 先停滞一次、恢复工作、再停滞一次；若 key 是 `(status_stall, paneKey, stall)`，第二次会被吞。另一个反例：同一 dispatch 有 `tests` 与 `archive_hash` 两个 acceptance 规则，若 facet 只有 `verdict`，会相互覆盖。建议 source_id/facet 包含稳定 epoch：pty incarnation、turn/session id、status stateStartedAt/window_start、acceptance rule id、tool+turn+threshold window。

## acceptance 状态取舍

不让 acceptance 误判直接 `failDispatch` 是正确取舍；但完全不改 dispatch/task 状态是错误取舍。应把“业务未验收”从“运行失败”中分离，同时给调度系统一个可见停点：pending triage、blocked question、或 non-terminal dispatch settlement hold。否则系统可能显示 running/active，实际无人再拥有下一步。

## crash reconcile shadow 是否足够

不够作为唯一保证，够作为 best-effort replay hints。需要：关键 incident shadow 每条显式 flush；记录单调序号/幂等键；启动时扫描轮转文件、容忍尾行截断；DB transaction 与 shadow 顺序有明确策略。剩余失败窗口包括 buffer 未 flush、write 被吞、无 fsync 掉电、轮转中崩溃、磁盘满、redaction/JSON 序列化失败、DB 与 shadow 只成功一边。

## §13 实施顺序

顺序方向合理，但第 1 步仍太大。第一步应砍到：新增 incident store schema、immutable triggers、`insertIncident` 幂等 API、最小 redacted summary/evidence 指针、单元测试；不要同时做 shadow reconcile。第二步做 shadow + startup replay。第三步才接 `onPtyExit` crash-only，且先不做 no_progress、acceptance、CLI/UI/mining。

## §14 成本口径

“新增文件为主”是正确工程约束；“改点 ≤5、重放 ≤20 分钟”当前不现实。把它改成 patch hygiene 指标：M1 生产接入只允许 1 个事实写点（`onPtyExit`）+ 1 个 store 初始化点 + 测试；后续每类触发单独提交。等抽象稳定并有重放清单后，才评估 20 分钟是否可达。

## 风险与前置条件

- 权限：incident 记录不授予重启、重试、修改、部署、关闭任务或 confirmed 裁决权限。
- 证据：record 只存脱敏摘要与指针；路径/主机名/真实 ID 不能进入公共设计或 md 示例。
- 误报：no_progress 依赖等待声明和阈值，等待声明本身也可能错误；默认应进入 untriaged/watch。
- 归档一致性：issue md 是派生视图，durable 仍需按既有 archive/hash/readback 规则，incident DB 不是归档完成证明。
- 上游重放：fork 内改动必须最小化、分提交；每个“已实现”只能指 Orca 现有能力，不能指本设计已接通。
