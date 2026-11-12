VERDICT: APPROVE-WITH-CHANGES

结论：M1 的 store/onPtyExit/CLI 主路径基本可用，但不能“无条件进入 M2”；先修复 fallback epoch 不落库和 agent binding 误判两个代码点，再继续 M2。

验证范围：已读 brief、v2.2 设计 §6/§7.1/§12/§13/§14/§19.1，以及 `orca/src/main/incidents/`、`orca/src/main/runtime/orca-runtime-on-pty-exit.ts`、`orca/src/cli/{handlers,specs,incident-format.ts}`。执行：`node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/incidents/incident-key.test.ts src/main/incidents/incident-store.test.ts src/main/incidents/incidents-database.test.ts src/main/runtime/on-pty-exit-incident-write.test.ts src/cli/handlers/incident.test.ts --maxWorkers=2`，结果 5 files / 59 tests passed。

## 必须改（按严重度）

1. `runtime:<id>:<generation>` fallback 实际不会落库，破坏要求核实的幂等分支。`orca-runtime-on-pty-exit.ts:57-60` 生成带 `:` 的 fallback；`incident-key.ts:117-119` 禁止 separator，`buildPtyExitIncidentRecord` 会返回 `incident_key_invalid_epoch`（`incident-pty-exit.ts:139-142`）。改法：要么把 fallback 改成不含 separator 的稳定 epoch（例如对 runtime id 做 hash/escape 后拼接 generation），要么扩展 `cleanEpoch` 的合法格式；补一条“无 exitIncarnationId、无 pty.incarnationId，同一 pty 二次 onPtyExit 只产生一行”的回归测试。
2. `hasAgentBinding` 有 false negative 风险，会漏记 unknown。`onPtyExit` 已读取 `agentSessionOwners[0].claim.identityDigest`（`orca-runtime-on-pty-exit.ts:65`），但 binding 判定只看 launch/foreground/paneKeys（`:71`）；`assessPtyExit` 对 unknown 且无 binding 直接跳过（`incident-pty-exit.ts:69-70`）。改法：把 `agentSessionOwners`/identityDigest 纳入 binding，或用测试证明该状态不可能出现并在代码注释说明不变量。

## brief 10 处偏差逐条结论

1. `incident_decisions.incident_id` 无 FK：接受。DDL 注释与实现一致（`incidents-database.ts:39-42,71-81`），prune 后 decision 可保留；但 incident 删除后 `show <id>` 不再能解析该审计，需要 M2+ 若要人类可读审计则加 tombstone/audit 查询。
2. DELETE trigger + prune marker：接受。非 prune 删除被 trigger 拦截（`incidents-database.ts:108-114`），prune 在事务中置 1、删除、finally 置 0（`incident-store-prune.ts:56-70`）。这是误操作护栏，不是本地攻击防线。
3. `source_kind` 增加 `tool_error`：接受。类型表把它列为保留词（`incident-types.ts:44-58`），与 §6.2.1 的 tool_error key 一致。
4. `status` 增加 `closed`：接受。状态表和可 prune 状态包含 closed（`incident-types.ts:25-41,81-82`），否则 prune/关闭语义无法表达。
5. unknown 仅在有 agent binding 时写：原则接受，但当前代码需改。降噪逻辑合理（`incident-pty-exit.ts:53-57,69-72`），但 binding 证据没覆盖 identityDigest，见必须改 #2。
6. `agentSessionId=null`、只保留 digest：接受。`onPtyExit` 明确没有 session id，只取 digest（`orca-runtime-on-pty-exit.ts:63-65`），避免伪造 session 指针。
7. M1 `pointers: []`：接受。record builder 默认空 pointers（`incident-pty-exit.ts:143-147`），unknownBoundaries 明说 M1 不读 transcript（`:88-107`）。
8. CLI 直连 SQLite：接受为 M1。list/show 只读打开（`incident.ts:114,134`；`incidents-database.ts:163-171`），write 命令才打开可写；建议补 sidecar 文件回归测试。
9. capacity latch 放 `incident_store_meta`：接受。容量闸写 latch（`incident-store-capacity.ts:65-80`），prune 只删 incidents，不删 meta（`incident-store-prune.ts:62-66`）。
10. WAL + `synchronous=NORMAL`：接受为 incident 诊断库。写路径设置 WAL/NORMAL（`incidents-database.ts:212-220`）；它不能被当作 acceptance/归档收据的耐久性承诺。

## 5 个风险面核验

1. 幂等/并发：正常 incarnation 下 `UNIQUE(source_kind,source_id,facet)`（`incidents-database.ts:46-65`）+ `ON CONFLICT ... DO NOTHING`（`incident-store.ts:121-128`）成立，同 key 重复会返回 existing id（`:159-162`）。反例是 fallback epoch，当前因冒号被拒而不是幂等落库，必须改。
2. 不可变/删除窗口：UPDATE 和 decision UPDATE/DELETE 均被 trigger 禁止（`incidents-database.ts:103-122`）。prune marker 没发现泄漏：事务内置 1，finally 置 0；crash 中断应由 SQLite 回滚。但 marker=1 时 trigger 不区分 DELETE 语句，未来不要在同一事务窗口加入其它可变 SQL。
3. 容量闸：边界用 `>=`，rows/bytes 到阈值即限制下一条非 crash（`incident-store-capacity.ts:53-63`）；bytes 口径含 db、wal、shm（`incidents-database.ts:141-150`）；crash 绕过容量（`incident-store.ts:113-118`）；latch 持久在 meta（`incident-store-capacity.ts:65-80`）。
4. CLI：非法迁移由 `canTransition` 拒绝（`incident-store.ts:181-191`）；`--to confirmed` 强制 `--actor`（`incident.ts:174-182`），其它状态默认 `unspecified`（`:183`）；`prune --apply` 默认 90 天、只删 closed/invalid/duplicate 且过滤 created_at（`incident.ts:217-229`，`incident-store-prune.ts:34-45,62-66`）。
5. onPtyExit 接线：写点在清理/retire 前，能读到 pty、pane、worktree、digest（`orca-runtime-on-pty-exit.ts:49-72`）；operator_close 不写（`incident-pty-exit.ts:59-62`）；SSH 未确认会保留 unknown 边界（`:101-103`）并在 runtime 保持 unverifiable（`orca-runtime-on-pty-exit.ts:73-82`）。主要缺口是 fallback epoch 和 binding 判定。

## 其它具体点

- acceptance 判定未涉及 M1 代码；本轮只确认 M1 未把 acceptance 写入 dispatch 状态。M2 做 acceptance 时仍应保持“不改 dispatch 状态”的取舍，但必须有可见 incident/decision 推进入口，避免 running 静默停滞。
- `incident_decisions` prune 后会成为“incident 表不可解析”的审计行；当前 `list` 走 `incident_state` view（`incidents-database.ts:90-101`），`show` 找不到 incident 时在渲染前报 not found（`incident.ts:131-146`），md 不会崩。
- list/show 只读路径不会主动迁移或设置 WAL（`incidents-database.ts:163-171`）；本轮源码证据支持“不应创建 WAL/-shm”，但现有测试只断言 readOnly/可读，建议补文件级 sidecar 断言。
- M1 的“单一写入点”总体可行：写点在 lifecycle generation advance 和状态删除前（`orca-runtime-on-pty-exit.ts:55-92`）。剩余丢失窗口是进程在 callback 前/写入前崩溃；M1 没有 reconcile，不能宣称覆盖该窗口。

## 是否允许进入 M2

允许在修复上述两个代码项并补回归测试后进入 M2；若不修，M2 会继承一个“自报存在但实际不落库”的 fallback 分支，以及 unknown 事故的可证明漏记窗口。
