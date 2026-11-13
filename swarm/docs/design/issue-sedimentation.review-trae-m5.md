VERDICT: BLOCK

结论：M5 当前不能进 M6。acceptance 的声明、命令执行、incident/stop 主链路基本成形，但结算门的失败边界和运维可见性还会坑人：无声明路径会创建 incident DB，store 不可用会 fail-open，`reject` 后 CLI 文案反向误导，且仍有直接 settlement 路径绕过 gate。

## 核对与测试

- 读了 M5 brief、v2.6 设计 §8、§13 M5、§11.5、§6.2.1。
- 核对提交：`acece904`、`b2358c17`。
- 测试：
  - `src/main/incidents src/cli/handlers/incident.test.ts src/cli/incident-format.test.ts src/main/ipc/incidents.test.ts --maxWorkers=2`
  - 25 files / 267 tests passed。
  - Orchestration 批次：
  - lifecycle/coordinator/delivery：3 files / 54 tests passed。
  - dispatch/task/gate DB 相关：4 files / 54 tests passed；6 files / 44 tests passed。
  - RPC messaging send 相关：4 files / 64 tests passed。

## Blocking Findings

1. 无 acceptance 声明的 `worker_done` 不是零影响。
   `send-methods.ts` 对每个本地 `worker_done` 调 `evaluateAcceptanceForDispatch`；它通过 `incidentRuntimeStore()` 打开 incidents DB，而该路径会创建 DB/schema。也就是说“无声明”仍会产生本地诊断库副作用和一次 DB 读，不是 §8/brief 声称的 no-op。

2. incidents store 不可用时 gate fail-open。
   `gateSettlement()` 在 runtime 为 null 或异常时返回 `no_rules`，`acceptancePendingResult()` 因此允许 settlement 继续。如果曾声明了 rules 但 DB 损坏/只读/userData 异常，dispatch 会绕过 acceptance 完成。这是验收门最危险的失效模式，应该区分“store 不存在且无声明”与“store 应存在但不可读”，后者必须可见停点或 fail-closed。

3. `acceptance reject` 后的列表文案误导。
   `formatAcceptanceList()` 对 gate blocked 且 stop 非 pending 的情况显示 “reviewed; settlement resumes through the existing flow”。但 rejected stop 的语义是 dispatch stays unsettled / returns to owner；测试也证明 reject 后仍 `acceptance_pending`。值班会被引导成等待自动恢复，实际永远不会 settle。

4. 仍有直接 settlement/complete path 绕过 acceptance gate。
   `updateTaskStatus(... terminalStatus)` 调 `settleActiveDispatchesForTask`；decision gate 创建也调用 `completeActiveDispatchesForTask`；底层 `completeDispatch` / `settleWorkerReportInTransaction` 仍可直接结算。若这些是受支持操作，则声明了 acceptance 的 dispatch 可被旁路完成。至少要明确哪些是 manual override，或在这些路径上检查 acceptance。

## 真实失败流程

- 本地 `worker_done` 发送时，`send-methods` 先跑 evaluation，写 verdict。
- coordinator 读 unread worker_done，`reconcileLifecycleMessage` upsert worker report，gate 发现 blocked，写 acceptance incident + pending stop，返回 `acceptance_pending`。
- dispatch 保持 `dispatched`，message 保持 unread；`orca incident acceptance list/show` 可见 rule、verdict、stop attempts。
- owner 可 `resolve --accept`，下一 tick 重读同一 unread worker_done 并 settle；`--reject` 则保持 unsettled。
- 处理者是本机操作者/owner；CLI actor 自报，不是权限。

## 长期未处理

- 命令不会被每 tick 反复执行；evaluation 只在本地 send worker_done 时跑。
- unread message 会反复过 gate；pending stop `attempts` 增长，incident 由 unique key 去重，不会无限增 incident。
- 没有超时升级；长期 pending 只靠 `acceptance list/show` 人工发现。
- federated/legacy 路径不自动 evaluate，会以 not_evaluated 停点存在；accept 后可 settle，reject 后悬挂。

## 错误声明与安全

- 命令路径错/cwd 错/超时太短：verdict 多为 `undeterminable` 或 `failed`，进入 pending stop；不会自动 fail dispatch，但可能形成永远无人处理的停点。
- `--cwd` 和 argv 由本机调用方给定；最坏可在本机用户权限下运行任意程序、继承环境。无 shell 降低注入风险，但这仍是本机 trusted operator surface。
- `--expect-stdout` 是子串 includes，不是正则，无 ReDoS。
- stdout 只存 sha256/bytes/detail，不存正文；timeout max 10min、stdout cap 512KiB。

## 5 处偏差判定

- 1 federated/legacy 不自动 evaluate：接受，但必须让 not_evaluated coverage/list 足够醒目。
- 2 不加 orchestration `acceptance_pending` 状态列：勉强接受，但 CLI/owner action 必须准确；当前 reject 文案需改。
- 3 resolve 不直接结算：接受；依赖 unread worker_done 重跑，但要提示“需要 coordinator tick”。
- 4 多规则串行：接受，低并发更稳。
- 5 `--cwd` 必填：接受；但应文档化为本机 trusted command，最好校验绝对路径/存在。

## 9 个风险面分类

- 必须改：1 gate/store unavailable fail-open；2 reject 文案与 owner action；7 无声明零影响；1/5 直接 settlement 旁路需处理或文档化 manual override。
- 补测试：无 incident store 的 worker_done 不创建 DB；store open failure 不 settle 已声明 dispatch；reject 后 `acceptance list` 不说 resumes；task-update/decision-gate 旁路行为。
- 可接受写文档：3 本机命令安全边界与 env 继承；4 resolve 后下一 tick 结算；6 not_evaluated 需要人工 resolve；8 actor 自报。

## 最小必改集（≤5）

1. `evaluateAcceptanceForDispatch` 无声明时不得创建/open-migrate incident DB；先做 non-creating lookup，或缺库直接 no_rules。
2. gate 对已存在但不可读的 incidents store fail-closed：写/显示 store_unavailable stop，不能当 no_rules。
3. 修 `acceptance list/show` 对 rejected/pending/accepted 的 owner action 文案；rejected 必须显示“unsettled, owner must retry/repair”，不能说 resumes。
4. 明确并保护直接 settlement 旁路：要么接 gate，要么只允许显式 manual override 并在文档/CLI 中标明。
5. 补对应回归测试：no-store no-side-effect、store-unavailable blocked、reject list wording、manual bypass semantics。
