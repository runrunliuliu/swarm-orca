VERDICT: BLOCK

结论：M5 不能进入 M6；acceptance 的主干雏形已在本地 worker_done 路径接上，但门点覆盖、停点保留、命令 cwd 边界和 gate 失败语义仍会让声明被绕过或停点丢失。

已核对/执行：阅读 brief、v2.6 §8/§13/§6.2.1/§11.5 与提交代码；运行 `cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/incidents/dispatch-acceptance-run.test.ts src/main/incidents/dispatch-acceptance-store.test.ts src/main/incidents/acceptance-gate.test.ts src/cli/handlers/incident.test.ts --maxWorkers=2`，结果 3 文件通过、`dispatch-acceptance-run.test.ts` 1 例失败（真实 argv runner 期望 passed，实际 failed，见该文件:133）。

必须修改（按严重度）：
1. 结算门点不唯一，federation/legacy worker_report 绕过 acceptance gate。
   - 证据：本地 `worker_done` 在 `lifecycle-reconciliation.ts:285` 调 `acceptancePendingResult` 后才 `settleWorkerReport`（:289）；但 federation import 直接 `settleWorkerReportInTransaction`（`db/federation/federation-relay-import.ts:93`），legacy lifecycle 也直接调用（`db/legacy/legacy-lifecycle-operation.ts:153`）。这不是“not_evaluated visible stop”，而是直接结算。
   - 改法：所有 worker_report 结算入口统一进入一个 gate 包装函数；无法执行命令的入口必须产生 not_evaluated/pending stop，不得 settle。

2. 保留未读消息只覆盖 coordinator tick，`orchestration.check` 会消费 acceptance_pending 的 worker_done，导致 `resolve --accept` 后无消息可恢复结算。
   - 证据：coordinator 对 pending 保留 unread（`coordinator.ts:173`、:181）；但 check 路径先 `reconcileLifecycleMessage`（`messaging/check-direct.ts:41`、:43），随后无条件 `markAsRead`（:48），未检查 `acceptance_pending`。
   - 改法：所有消费 unread worker_done 的路径都要识别 acceptance_pending 并保留 unread，或改为显式 resume 队列，不能依赖仅 coordinator 的 keep-set。

3. `--cwd` 可指向 worker worktree 之外，acceptance 命令会在任意本地路径执行。
   - 证据：CLI 只要求 `--cwd` 存在（`incident-acceptance.ts:72`），store 只 trim/非空校验（`dispatch-acceptance-store.ts:127`、:132、:145），runner 直接传给 `runProcess`（`dispatch-acceptance-run.ts:43`、:46）。
   - 改法：声明时从 dispatch/worktree 解析授权根并要求 realpath(cwd) 在根内；若无法解析 worker worktree，拒绝声明或只允许 no-command/not_evaluated 声明。

4. gate 异常 fail-open，声明存在但 incident store/写 stop 出错时会按 no_rules 结算。
   - 证据：`gateSettlement` catch 任意错误返回 `no_rules`（`acceptance-runtime.ts:101`、:111-114）；`acceptancePendingResult` 只在 `'blocked'` 时阻断（:129），否则 settle。
   - 改法：区分“store 不存在且无声明能力”的 no_rules 与“读/写 gate 失败”；后者必须产生可见 coverage/stop 或至少 fail-closed 为 acceptance_pending，不得静默放行。

5. pending stop 的 `attempts` 不是 acceptance 尝试次数，而是每次 gate refresh/tick 递增，无上限、无节流。
   - 证据：`openAcceptanceStop` on conflict 每次 `attempts + 1`（`dispatch-acceptance-stops.ts:54-62`）；coordinator 每 tick 重跑 unread worker_done 的 gate（`coordinator.ts:159-164`、:178-183）。外部命令不会每 tick 重跑，但 attempts 会无限增长并污染可观测性。
   - 改法：attempts 改为 evaluation_attempts 或 gate_seen_count 分开；pending refresh 不应无限计入“尝试”，并增加上限/lastSeen/lastError 可见字段。

6. 重新声明同一 rule 不失效旧 verdict/stop，规则内容变了但 gate 仍可使用旧 verdict。
   - 证据：rule upsert 更新 program/expect/digest（`dispatch-acceptance-store.ts:165-173`），verdict 表按 `(dispatch_id, rule_id)` upsert（:216-226），`acceptanceGateState` 只按 ruleId 取 verdict（`dispatch-acceptance-stops.ts:116-134`），不比较 rule digest/evaluated generation。
   - 改法：verdict 记录 rule_digest/declared_at，gate 只接受与当前 rule digest 匹配的 verdict；重声明时清空旧 stop 或转为 not_evaluated。

风险面核对：
1. 结算路径清单/覆盖：本地 send/check/coordinator 读 worker_done 均会走 `reconcileLifecycleMessage`，但 federation import 与 legacy lifecycle 直接 settle，覆盖不全；`completeDispatch`/`failDispatch`/decision gate 是非 worker_report 结算，需在文档明确不受 acceptance 约束。
2. 门点事务边界：命令执行在 local send 中发生于 `sendPointToPointMessage` 之前（`send-methods.ts:200-205`），不在 `commitWorkerDoneMessageMutation` 包裹的 message+settlement 事务内（`send-point-to-point.ts:142-148`）；gate 读写 incident stop 则发生在 reconciliation 内、settle 前（`lifecycle-reconciliation.ts:285-289`）。慢命令边界满足，但 gate 本身不是纯读。
3. 保留未读/重跑：不会每 tick 重跑 acceptance 命令；命令只在 `evaluateAcceptanceForDispatch` 调用处执行（`acceptance-runtime.ts:55-75`）且 local send 触发一次（`send-methods.ts:203-204`）。但 check 会读掉消息，coordinator 会无限刷新 attempts。
4. 命令安全：argv/no shell 基本成立（`dispatch-acceptance-run.ts:40-49`），输出正文不入 verdict，仅 digest/bytes（:100-141）。缺口是 cwd 任意路径与继承环境未隔离。
5. idempotency：incident key 用 acceptance attempt+rule（`acceptance-gate.ts:56-60`），但 attempt 是常量 1（`acceptance-runtime.ts:35-36`）；若 dispatch id 真是一 attempt，可接受，但应补不变量测试。rule digest 未参与 verdict，重声明反例未覆盖。
6. 跨 DB 一致性：orchestration DB 与 incidents DB 无原子性；最危险的是 gate 写 incident/stop 失败会被 catch 成 no_rules 放行，见必改 4。
7. 失败语义：failed/undeterminable/not_evaluated 都能阻断并开 stop（`acceptance-gate.ts:131-145`），accept 手工放行、reject 继续阻断（`dispatch-acceptance-stops.ts:109-114`）；但绕行路径与 check 消费路径破坏该语义。
8. 无声明路径：有回归测试覆盖 no store/no rules 继续结算（`acceptance-gate.test.ts:79-98`，`dispatch-acceptance-store.test.ts:107-110`）。本次小批运行中这些文件通过，但整体批次因 runner 用例失败不是全绿。
9. CLI 语义：`--expect-stdout` 是子串不是正则（实现 `includes`，`dispatch-acceptance-run.ts:93`；帮助写 `<substr>`，`specs/incident.ts:140-142`），已排除 ReDoS；`resolve --accept` 不直接 settle（`incident-acceptance.ts:218-232`），但依赖 unread 恢复，见必改 2。

补充项：
- `acceptance list` 每个 dispatch row 塞入全量 rules（`incident-acceptance.ts:140-145`），文本 rule 数和明细会串入其他 dispatch；需按 dispatch 过滤，避免 triage 混淆。
- incident evidence 的 `repro` 固定为 show 命令（`acceptance-gate.ts:85-94`），M5 可接受；M6 前若要归档证据，应补规则摘要/dispatch 状态指针。

可延后：
- 规则串行执行（自报偏差 4）可延后；M5 先保证安全与可见性，性能可等 M6 后再调。
- `resolve --accept` 不直接 settle（自报偏差 3）可接受，前提是必改 2 修好，使 resume 可靠。
