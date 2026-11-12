# issue-sedimentation v2 独立评审（trae）

结论：v2 的“Orca 主进程事实产生处写入”方向可以进入实现，但不能按 §13 现在的顺序交付；第一步必须变成“本机 crash 写入 + 最小 CLI 可读 + 容量上限”的垂直切片，否则运维人员拿到 store 也做不了事。

## 源码核对摘要

- `terminal-exit-cause.ts` 支持 v2 的 unknown 语义：`operator_close/signaled/exited/unknown` 分明，`stop_unverified` 不会被猜成失败。
- `orca-runtime-on-pty-exit.ts` 是强接点：它在 `retirePtyAgentLaunchAuthority` 前收集 pane key，之后写 `lastExitCause` 并 fail active dispatch。这里适合写 crash incident，但也是最容易和上游生命周期清理冲突的改点。
- `server-state.ts` 只是共享状态与 abstract 声明；实际 `applyNormalizedStatus` 在 `server-status-update.ts`。设计中的“单一入口”成立，但依据应改得更精确。
- `server-status-application.ts` 有 `stateStartedAt/turnStartedAt/evidenceObservedAt`，可支撑停滞窗口；但 `server-reaping.ts` 主要是恢复态 Claude 行清理，不是通用 freshness tick，停滞判定要小心找真正周期触发点。
- `dispatch-completion.ts` 的 `completeDispatch` 很窄，接 acceptance 前置可行；但不能在 lifecycle 写事务里跑外部命令，否则会把长命令/卡死带进结算路径。
- `local-file-sink.ts` 已有同步 NDJSON、默认 10MB x 10 轮转、oversize marker；适合影子日志，不等于 incident DB 的保留策略。
- `handler-group-manifest.ts` 的 CLI 接入清晰，但不是纯“一行”：需要 group keys、handler 模块、manifest drift 测试一起维护。

## 噪声与默认阈值

当前默认值偏激进，会在真实使用里淹没信号：15 分钟工作态很常见，连续 3 次工具错误也常见，同 fingerprint 2 次很容易被同一故障刷出来。

我建议默认：

- 停滞：45 分钟无状态进展，且至少跨过 2 次独立状态观察/回收周期；有有效 `wait_reason` 或显式长任务标记时不写 incident，只更新可观测年龄。
- 工具错误：同一 session、同一 tool、同一 normalized code 连续 5 次或 10 分钟内 5 次才写；`permission/pin/scope/immutable` 类高危错误可单次写候选。
- 聚类候选：7 天窗口内同 fingerprint 至少 3 条，且来自至少 2 个不同 source_id/session；`signaled crash`、`acceptance_failed` 的同一 invariant 可以 2 条进候选。
- 同一未闭合 unknown 只记 occurrence，不生成新 incident；恢复或新 source_id 后才开新记录。

默认策略应宁可漏掉一部分低价值噪声，也不要让 triage 队列第一周就变成“所有长回合都像事故”。

## 人机回路

如果没人看，incident store 等于没做；它只是把没人读的日志换成没人读的 DB。

最小可用回路：

1. 第一批支持 `orca incident list --status untriaged --since 24h --json`。
2. 支持 `orca incident show <id> --md`，能看到 exit cause、source、证据指针、unknown 边界。
3. 支持 `orca incident decide <id> --to watch|invalid|duplicate|needs_archive|confirmed --reason ...`；`confirmed` 只允许显式 R1 actor。
4. 每日 scheduled automation 只产出摘要：新增数、未看数、重复 fingerprint、需要归档数。没有外部通知时，至少要能在 CLI/automation runs 里被运维巡检看到。

因此 §13 步 1 不能单独作为“交付给运维”的里程碑。store 交付后，运维人员最多手工翻 SQLite/影子 NDJSON，这不是受支持操作。应把步 1、步 2 的本机 crash 写点、步 5 的只读 `list/show` 合成第一个可用切片。

## 清理与容量

需要两套策略，不要混在一起：

- 影子 NDJSON：沿用 `local-file-sink` 轮转即可，默认 10MB x 10 可以接受；若 incident 影子独立成族，建议仍从 100MB 总量起步，并保留 oversize marker。
- incident DB：不能只靠不可变触发器无限增长。建议默认 active 上限 50k incidents 或 500MB，二者先到先停写低优先级噪声并报 `incident_store_capacity_limited`，高危 crash 仍可写 shadow。
- 删除权：只有 `orca incident prune` 可做，且默认只能删 `closed|invalid|duplicate` 且 older-than 90 天、已有导出/归档确认的记录；`untriaged/confirmed/needs_archive` 不自动删。
- decision 不应被物理删，除非整库归档后做受控 compaction；否则关闭链路会丢。

## 远程宿主与多机

v1 只做本机可以接受，但必须在设计里写成产品边界，而不是“以后再说”：

- 持有 PTY 的宿主写自己的 incident；客户端只能记录 `remote_connection_lost` 这类本地事实，不能替远端写 crash。
- 对 SSH/WSL 未接通的首版，应明确显示 `remote_incident_capture: unsupported/not_probed`，否则运维会误以为没有事故。
- 远端事故避免丢失的最小路径是远端主进程写本地 shadow + DB，客户端重连后 mirror 摘要；mirror 失败保留远端未同步计数。
- 多机聚合不要进首版；先保证每台宿主本地可查、可导出、可说明覆盖缺口。

## 上游 patch 风险

压到 ≤5 处改点是对的。下次上游重新导入最可能出问题的是 `onPtyExit`：

- 它是高 churn 生命周期清理函数，包含 authority、mobile surface、liveness verdict、dispatch failure 多条顺序约束。
- incident 写入若放在清理前后错误位置，会丢 pane/session 映射，或把 `operator_close` / abnormal SSH surface 误记为 crash。
- 建议把接入做成单个 `recordPtyExitIncident({...})` 调用，参数在清理前一次性收集，函数内部不得再反查会被清掉的 runtime map。

`dispatch-completion.ts` 的 acceptance 是语义风险最大的一处，但更像新能力设计风险；纯 rebase 冲突概率我认为低于 `onPtyExit`。

## 两周可用版砍掉清单

必须砍：

- acceptance 一等概念与自动验收执行；这是大设计，不应塞进两周首版。
- no_progress 自动 incident；先不做停滞阈值，避免噪声先把系统名声打坏。
- tool_error 自动聚合。
- automations mining、fingerprint 候选提案。
- renderer/preload/UI。
- 远端 mirror 与多机聚合。
- 一 fingerprint 一 md 的长期视图；首版 `show --md` 单 incident 足够。

必须保留：

- incident DB、唯一键、不可变 record/decision。
- shadow NDJSON 与启动 reconcile。
- `onPtyExit` 本机 crash 写入，严格保留 unknown。
- 最小 CLI `list/show/decide/prune --dry-run`。
- 容量上限与覆盖缺口显示。

这个切片两周内有运维价值：杀掉/崩掉一个本机 agent 后，运维能列出事故、看退出原因与证据指针、标记 watch/invalid/needs_archive，并知道 store 有没有因容量或远端 unsupported 产生覆盖缺口。
