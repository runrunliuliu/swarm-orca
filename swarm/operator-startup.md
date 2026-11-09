# Operator 启动生命周期与 readiness

更新：2026-11-03。新生命周期使用 **schema v2 + 显式执行模式 + runtime policy v1**。新注册的 strict
bootstrap attempt 必须在配置交付前接入；不再把 created→continuation 留给角色自行猜测。
本层复用原 bootstrap、gate、首派、continuation、monitor 和 scheduler，不创建另一套
业务执行循环，不替代角色审查或原生运行时门禁。以下是操作契约，不是部署或 live 通过记录。

历史生命周期 schema v1、未含 runtime policy 的历史 v2、已固定 request/receipt 仍按原版本读取；
新 `prepare` 不接受 v1，也不允许省略 runtime policy。
已有 Run 不自动迁移，不覆盖 pin，不因源码升级绕过原 plan 的 source hash 校验。

## 创建前固定生命周期

1. 原 Operator 完成 `strict-start-prepare` 与 `strict-config-review`。原始 config v3、
   review、request v5 和快照保持不变；此时新注册 attempt 的 plan 返回 `awaiting_lifecycle`。
2. 原 Operator 根据原始用户授权独立核验执行模式、运行期限政策及 authority pins、Worker
   适用性、固定非 Agent sender 身份与目录，准备下面
   的 v2 inputs，执行 `operator_startup.py prepare`。输出目录必须为 `BOOTSTRAP/lifecycle`。
3. `prepare` 按单向引用独占发布 `spec.json` → `activation.json` → `lifecycle.json`。
   spec 不含 strict config 或自身下游 hash；activation schema4 引用原 config 和 spec；
   lifecycle 引用 activation/spec，固定解释器和全部本地 Python 源码。原 owner 确认这些输出。
   `prepare` 不创建 Run、启动 monitor 或发送消息，但会核验原角色并通过 owner 发布文件。
4. 再执行原 `strict-config-publish`。delivery schema3 同时保留原准备/审查证据和新增
   activation/lifecycle；Coordinator 的 `strict-config-wait` 返回 activation 的 plan。
   使用返回的完整命令，不再直接执行旧 base config，不手工重算/拼接新的 wait 参数。
5. 原 Coordinator 创建 Run，返回的 `created.json` 明确 `runtime_ready=false`。它不是启动职责
   完成或可以长时间等待 Worker 的证明。**字段范围要按实际回执辨认**：绑定 `lifecycle_spec`
   时会额外给出 `lifecycle` / `lifecycle_spec` / `runtime_ready` / `next_owner` / `next_action` /
   `startup_handoff_complete`，以及 `handoff`（内含 `pull_argv` / `accept_argv` / `complete_argv` /
   `inspect_argv`）。不要依赖 `coordinator_handoff` / `operator_handoff` 这类额外键：当前实现不写，
   历史回执中即使出现也可能为 `null`。若 `created.json` **完全不存在**（waiter 被中断或 deadline
   已过），说明该 attempt 未进入创建阶段，只能按对账处理，不能重跑 waiter 或重发 create。
   `handoff` 的具体成员以 `startup_handoff.py pull` 的返回为准，不自行发明 argv。

inputs 示例（全部占位值须来自当前任务核验；`BOOTSTRAP` 只是文中代称）：

```json
{
  "schema_version": 2,
  "strict_start": {"path": "/approved/bootstrap/strict-start/start.json", "sha256": "REVIEWED_BASE_CONFIG_SHA256"},
  "bootstrap_owner": {"path": "/approved/bootstrap/control/owner.json", "sha256": "ORIGINAL_OWNER_SHA256"},
  "execution": {"mode": "autonomous", "trigger": null},
  "runtime": {
    "schema_version": 1,
    "deadline": "REVIEWED_RUNTIME_ISO8601_WITH_TIMEZONE_OR_EXPLICIT_NULL",
    "authority": [{"path": "/approved/authority.json", "sha256": "REVIEWED_AUTHORITY_SHA256"}]
  },
  "workers": "required",
  "continuation_publication": "/approved/bootstrap/continuation/continuation-ref.json",
  "sender": {"terminal": "VERIFIED_HANDLE", "incarnation": "VERIFIED_INCARNATION", "workspace": "EXPLICIT_ID"},
  "state_root": "/approved/bootstrap/operator-state/lifecycle-state",
  "monitor_state_root": "/approved/bootstrap/operator-state/monitor-state",
  "deployment_dir": "/approved/bootstrap/operator-state/deployment",
  "poll_seconds": 3,
  "bootstrap_deadline": "ABSOLUTE_ISO8601_WITH_TIMEZONE"
}
```

`state_root`、`monitor_state_root`、`deployment_dir` 和 plan 输出目录预建为独立空 0700
目录；continuation 输出目录留给原 prepare 独占创建。全部路径须规范、在已授权 observation
roots 内且不得与 strict-start/control/lifecycle 目录重叠。新注册 attempt 的
`bootstrap_owner` 必须是原 `control/owner.json`，不能设为 null；仅未注册的独立 helper
场景允许 null，仍须真实原角色身份校验，不能用于绕过 bootstrap owner。

上述布局假定 `/approved/bootstrap` 已在契约的 observation roots 中；`/approved`
本身并不因示例前缀而获准。不要把状态目录放到 roots 外的相邻 `sender/`，也不要为
使示例通过而扩大 roots。`runtime.authority` 是独立固定的授权来源，不是写根。

`bootstrap_deadline` 必须为 prepare 时未来一小时内，且不超过原 attempt deadline。
它约束启动交接，不扩展业务授权、continuation deadline、上下文新鲜度或 gate TTL。
新 `runtime` 的字段恰为 `schema_version:1`、`deadline`、非空 `authority` Ref 列表。
期限来自独立审查：有总时限时固定原授权期限；确无总时限时显式写 JSON `null`，不是上例
占位字符串。不得自动填一个新的倒计时或遥远日期。continuation 必须与该字段**完全相同**，
Coordinator 不能延长、缩改或把已固定的期限改 null。null 不解除预算、freshness、单步
timeout、gate TTL、止损和原角色身份约束；authority pins 不由 checkpoint 反推。

同一原 owner 按动作检查：启动动作仍受原 attempt deadline；运行期路径须在该窗口内由
owner 确认完整的 Run 绑定、admission、continuation accepted/result/complete/publication。
此后按固定 runtime 政策核验同 owner、Run/generation、角色进程/会话、pins、STOP 和动作
有效期，不再把启动窗口当运行期限。不能到期后补建链，不能凭新字段迁移旧链或更换 owner。
runtime readiness 仍只是当前快照，不是将来持续运行或自治验收通过的证明。

```bash
python3 -B operator_startup.py prepare --inputs /approved/lifecycle-inputs.json \
  --inputs-sha256 REVIEWED_INPUT_SHA256 --output-dir /approved/bootstrap/lifecycle

python3 -B operator_startup.py check --plan /approved/bootstrap/lifecycle/lifecycle.json \
  --plan-sha256 REVIEWED_PLAN_SHA256
```

## 原角色领取、执行与完成

`startup_handoff.ACTIONS` 是动作与角色的注册表，生成 pull/accept/complete/inspect 命令。
角色在自己的原生上下文执行返回的 argv，不能借 sender 身份或另开 Agent 代审。
`pull` 返回固定输入和 `candidate_template`；模板不代填独立审查意见或业务计划。

| action | 原责任角色 | 输入与真实生产入口 |
| --- | --- | --- |
| `materials` | Coordinator | 固定精确 Run 契约候选、业务理由、非空 authority pins、Worker 参数候选；Worker 参数不得预含尚不存在的 `first_dispatch` |
| `review` | Operator | 读取已固定材料，明确 approve/notes；owner 按候选原始字节发布 `first-contract.json`，执行真实 Operator gate |
| `dispatch` | Coordinator | 无可变输入；装配已审查契约/gate，执行原 `coordinator_first_dispatch` 并核验原生接受回执，或真实 no-worker run-readiness |
| `continuation` | Coordinator | 提供合法领域 source/receipt/acceptance；调用原 `coordinator_tui_prepare`，注入固定 lifecycle/mode/admission，最后发布 continuation 引用 |

`continuation` 的输入有三处容易搞错，且失败代价很高（见下）：

- **`acceptance` 必须恰好是 `{"requirements": [...]}`**，不是完整 RSI 合同。完整合同
  （含 `run_id` / `objective_ref` / `authorization_ref` / `schema_version`）继续只用于
  `check-authorized-progress`。正确做法是从已固定的完整合同**逐字派生** requirements 投影，
  两个文件同时 pin，并在输入旁记录派生关系（contract sha → projection sha），不要人工维护两份。
- **`source` / `receipt`** 是领域检查的原始材料；`contract` / `dispatch_gate` 必须与该 Run 的
  admitted 证据一致。
- **确定性输入错误在取执行屏障前失败**：lifecycle 现在会在写 `*-executing.json` 之前校验
  continuation 输入（schema、acceptance 形状、pin、输出目录、lifecycle 绑定）。若仍出现
  `*-executing.json` 而没有 `*-complete.json`，说明不是输入格式问题，按对账处理，
  不重放、不删除标记、不换目录重试。

每个动作分别发布不可变 `*-task.json`、`*-accepted.json`、`*-executing.json` 和
`*-complete.json`，结果独立 pin。**待办已发布不等于角色已接收，gate 已通过不等于派发已被
接受。** 原 owner 确认最终输出；模型文件工具只准备候选，不直接写 owner 最终槽位。
生命周期记录引用原 intent/receipt/journal，不复制业务 outbox。

例如第一步（后续完整命令以返回的 argv 为准）：

```bash
python3 -B startup_handoff.py pull --plan /approved/bootstrap/lifecycle/lifecycle.json \
  --plan-sha256 REVIEWED_PLAN_SHA256 --actor coordinator --execute
```

先执行 `accept_argv`，再用当前 `candidate_template` 准备候选并执行 `complete_argv`。
`inspect_argv` 是只读诊断。pending 的 `ok=false`/非零退出不表示需要重做 bootstrap；
读取 `state/next_owner/missing/responsibility_accepted`。完成首派后立即领取 continuation，
不要先长时间等 Worker。Operator 缺 gate 时返回 Operator 待办，不再统一标为等 Coordinator。

`workers: "not-applicable"` 必须在创建前明确固定。Coordinator 仍提供业务理由、Run 与
authority pins，但 `worker: null`；两角色真实执行 `startup-gate --phase run-readiness`。
admission 为 `no-worker-readiness`，continuation 的 `dispatch_gate: null` 仅由此分支接纳，
不生成假 dispatch。它不适用于要求真实 Worker 的 worker_done-only 验收。

gate 过期或剩余窗口不足 Worker timeout +15 秒时，inspect 路由原 Operator，并给出
`refresh-review` 命令和独立审查模板。刷新使用原契约/session receipt、重新核验真实身份，
独占保存 `review-refresh-N-{intent,gate,receipt}.json`；只在没有任何 dispatch intent、
`dispatch-executing.json` 或 admission 时允许。新的未派发请求使用受控编号目录，旧链不改。
已存在原生 intent 时禁止刷新/换目录重派，沿原 request ID 对账。心跳不自动重签或续期。

## 三种模式和 monitor

| execution | 当前 readiness 条件 | 本生命周期的自动发送 |
| --- | --- | --- |
| `{"mode":"autonomous","trigger":null}` | 合法 continuation、原 monitor 部署/首 tick/当前锁与身份、当前 scheduler readiness | 仅按原授权、sender、STOP 与防重规则允许 |
| `{"mode":"native-event","trigger":{"source":"worker_done","readiness":"/approved/bootstrap/operator-state/lifecycle-state/trigger-ready.json"}}` | 合法 continuation、观察型 monitor、指定触发源的独立预检回执 | 始终禁止 scheduler、通用事实提醒和恢复发送；窗口过期也不开放 |
| `{"mode":"manual","trigger":null}` | 合法 continuation、观察型 monitor；明确非自主交还执行 | 不自动发送 |

native-event 的 `source` 可为 `worker_done` 或 `external_fact`；readiness 路径必须恰为
`state_root/trigger-ready.json`。新模式缺 lifecycle/mode 在初始化写入前拒绝，不能删除
continuation 或新配置字段把 monitor 退化为旧通用提醒发送器。

在 prepare 绑定的**非 Agent sender 自己的原生 shell**中，执行返回的前台命令一次：

```bash
python3 -B operator_startup.py run --plan /approved/bootstrap/lifecycle/lifecycle.json \
  --plan-sha256 REVIEWED_PLAN_SHA256 --execute --confirm-skill-read

# 检查者只读观察，不借用 sender 身份。
python3 -B operator_startup.py status --plan /approved/bootstrap/lifecycle/lifecycle.json \
  --plan-sha256 REVIEWED_PLAN_SHA256
```

同一前台 helper 先观察生命周期缺项，再调用原 monitor prepare→run→verify；不另启
后台子进程、不向 shell 注入命令、不替模型执行业务。发送边界在写 attempted 前和实际
native send 前复查模式/STOP/原 owner 当前健康。新策略使用只读签名 `runtime-observe`，
固定 lifecycle/continuation pins；历史无 runtime 策略仍使用原 `observe`。历史 confirmed
不代表当前仍可准入；sender 观察健康不获得 arm/commit/审查权限，也不能传 `scope=runtime`
绕过启动检查。Coordinator 的 check/claim/settle 等入口也核验当前运行准入；这不新增
STOP/期限后的执行或结算例外，未知原操作仍按其原受支持入口对账。
manual/native-event 保留 tick 与观察，scheduler 返回 `observation_only`。

monitor 在原独占锁内核验运行准入和 sender，把接收证据写入既有不可变 `launch-*.json`，
绑定 lifecycle、continuation、deployment、Run/generation、sender、runtime/execution 和
原 owner，责任仅为 `observe_and_authorized_schedule_only`。它不是 owner/业务接管。
接收先于首 tick；当前 `deployment-status.json`、原 launch receipt、锁、首 tick 和当前
健康必须同时匹配才可能 ready，不能把 ready 反过来作为启动前置条件。

`--once` 只运行一轮有界诊断。退出后 `monitor_ready/runtime_ready=false`；历史首 tick
或 milestone 不能当作当前常驻证明。原生 idle/退出但交接未完成时返回准确阻塞，helper
不能阻止模型自行结束回合，也不自动唤醒或恢复角色。

### 原生事件验收的预检回执

continuation 发布后，原 Operator 独立审查指定触发源预检，用 `startup_handoff.py
trigger-ready --actor operator --input ... --input-sha256 ... --execute`，同时传原 plan pins。
`--input` 是**独立审查文档**，不是下述原始预检，也不是最终 `trigger-ready.json`。
可先只读获取待填写模板（不查询原生身份、不发布回执、不自动批准）：

```bash
python3 -B startup_handoff.py trigger-template --actor operator \
  --plan /approved/bootstrap/lifecycle/lifecycle.json --plan-sha256 REVIEWED_PLAN_SHA256
```

其 `candidate_template` 的 decision 为 null，需原 Operator 审查后另存候选，再固定原始字节 hash。
`trigger-template` 有意仅接受 `--actor operator`：它属于原 Operator 独立审查工作流，
不是通用 schema 自查入口；该参数也不构成原 Operator 身份证明，真正发布仍核验身份。
Coordinator 可阅读此结构说明；将来若增加其自查入口，应保持只读且不替代 Operator 审查，
不要通过放宽此入口的 actor 约束来兼任审查角色。
默认兼容候选字段**恰好**为：

```json
{
  "decision": "ready",
  "notes": "原 Operator 对指定触发入口和证据的独立审查结论",
  "evidence": [{"path": "ABSOLUTE_HARNESS_EVIDENCE_PATH", "sha256": "EVIDENCE_SHA256"}],
  "valid_until": "ISO8601_WITH_TIMEZONE",
  "trigger": {"path": "ABSOLUTE_PREFLIGHT_PATH", "sha256": "PREFLIGHT_SHA256"}
}
```

新验收建议在模板命令中加 `--with-release-window`，审查后额外固定以下字段（不填完不能发布）：

```json
"release_window": {
  "deadline": "EXACT_WORKER_BARRIER_DEADLINE_WITH_TIMEZONE",
  "publish_budget_seconds": 30,
  "reserve_seconds": 120
}
```

此时发布 schema v2 回执；默认模板及既有 schema v1 回执不变，不补写旧 attempt。
发布前要求 `min(valid_until, release_window.deadline) - now > publish_budget_seconds + reserve_seconds`，
等号也拒绝；发布预算为 30–3600 秒整数，余量为 120–3600 秒整数。
`publish_budget_seconds` 是准入预留量，不调整 helper 的 30 秒调用等待预算。
消费回执在慢证据读取后再次要求 `min(valid_until, deadline) - now > reserve_seconds`，
为 turn-end 与释放保留至少 120 秒（等号拒绝）；不足时报
`startup_trigger_window_insufficient`，过期报 `startup_trigger_readiness_expired`。
deadline 必须由 Operator 从实际屏障契约核对固定，不是 helper 自动推算的值。
这是可选的准入/消费保护，不代替 Worker 释放端的完整校验，不自动延长 TTL 或屏障。
使用带时区的墙钟检查，尚未实现跨时钟回拨保护。

notes/evidence 必须非空；结构、时间格式和 pin 在原生查询/owner RPC 前检查，发布边界仍重新校验
身份、时效、Run/Dispatch 和发送隔离，不接受将原始预检自动转换为批准。trigger 文件最少包含：

```json
{
  "kind": "native_event_trigger_preflight",
  "ready": true,
  "run": {"id": "EXACT_RUN_ID", "generation": 1},
  "source": "worker_done",
  "trigger_id": "EXACT_ACCEPTED_DISPATCH_ID",
  "checked_at": "ISO8601_WITH_TIMEZONE",
  "valid_until": "ISO8601_WITH_TIMEZONE"
}
```

owner RPC 复用 30 秒传输预算，connect/send/分片回复共享截止期，不因持续小片回复重置。
超时返回 `bootstrap_tool_timeout_requires_reconciliation`，`retry_allowed:false`；先核对原
readiness 文件及 owner 确认。出现该错误码时，不得重试同一 mutation，也不得仅凭它判断
动作失败：owner 仍可能完成已接纳工作。该传输预算不是 owner 端取消机制。
另有 `blocking_io` 的 30 秒单调调用等待预算，从 trigger-ready 第一次候选读取前开始，
覆盖本地读取、锁获取与 RPC 前后处理。超时返回
`bootstrap_io_timeout_requires_reconciliation`，附 `outcome:unknown`、
`execution_cancelled:false`、`retry_allowed:false` 和非持久化阶段诊断。
`operator_startup.py status/check`、`coordinator_tui_continue.py check` 也有 30 秒调用等待隔离，
观察超时为 `bootstrap_io_observation_timeout`。这些边界不覆盖解释器启动、模块加载或最终 stdout。
会话显示 working 不证明正在此 RPC 内；记录实际命令、起止时间
和返回码。`operator_startup.py run` 是另一个预期持续运行的前台 monitor，不能与 trigger-ready 混为一谈。

worker_done 必须匹配实际接受的 dispatchId；external_fact 的 trigger_id 和就绪事实由
独立 Operator 对固定 harness 证据审查，本 helper 不自动证明外部触发器可用。
生效期不超过 trigger 自身及已审查 runtime deadline（null 时只按 trigger 自身期限）；
历史无 runtime policy 的链仍受原 bootstrap deadline。新链可在启动窗口关闭后由原 Operator
通过具名 `runtime-attest-trigger` owner 入口审查，不重走过期启动动作。入窗前检查 continuation、scheduler review
与 monitor outbox 的未知发送。原 owner 独占发布预检回执，过期失败关闭，不自动覆盖续期。
缺回执时允许 `monitor_ready=true`、`runtime_ready=false` 同时存在。
**这只证明验收前提，不证明发生了真实 idle、唤醒或业务成功。**

### 阻塞诊断与文件锁边界

NAS 仍是权威持久化存储。调用等待用同进程 daemon 线程隔离，以保留原 peer PID/身份；
最多四个隔离任务，超时任务返回前一直占槽，耗尽时报 `bootstrap_io_capacity_exhausted`。
这只是每进程上限，不是跨 CLI 进程的资源治理。超时不 join、不重发，也不能中断 hard NFS 的 D 状态；
CLI 退出不证明底层操作已取消。不得因超时新启 owner、重试 mutation 或删除锁文件。

- `owner.lock` 保持全生命周期单例；非阻塞 `flock` 竞争仍报 `bound_lock_busy`，与 I/O 超时区分。
  保留 inode 校验，不换锁文件；迟到 open/flock 返回后会关闭本次 fd，不进入受保护业务体。
- 正式协议只有一个执行通道。owner 忙时新请求直接拒绝为
  `bootstrap_rpc_rejected:bootstrap_owner_busy_not_executed`，不新增无界队列；
  签名验证通过的只读请求将它分类为 `ObservationBusy` / 不可观察，不走身份刷新路径；
  pull 返回 owner-busy pending，monitor 单次退出且不新增 STOP，mutation 不自动重试。
- `CommitOwner.serial` 中的最终路径、身份、STOP、generation 校验与原子发布/fsync 保留。
  正式 reconcile 会修改确认状态，仍须等原请求结束后由原 owner 串行处理。
  请求未结束时 close 报 `bootstrap_owner_busy_requires_reconciliation`，不提前释放 owner.lock。
  CLI 不再通过外层 finally 绕过该拒绝。关闭拒绝时最多等待 250ms，尽力在独立私有目录
  `/tmp/swarm-owner-close-*/owner-close-rejected.json` 暂存 L1 诊断，并在错误结果中返回记录。
  该文件是可选诊断暂存，不是 lifecycle state；NAS 权威存储不迁移。它始终标注
  `durable=false/archive_pending=true`，写出失败或超时保持 unavailable/unknown。
  NAS 恢复后需人工归档并回读；CLI 返回或诊断标记均不证明进程已经退出，也不授权接管。

`check` 从首次文件读取前使用单个总预算：最多 15 个原生 RPC × 15 秒、两个 owner 查询
× 30 秒，再加 30 秒文件访问余量，当前合计 315 秒；不续期、不改变协议 freshness。
continuation 配置没有 `rpc_timeout_seconds` 字段；此值是 monitor 配置而非 check 配置。
`--action-seconds` 只用于窗口建议，不是实际等待时长，也不延长检查预算。

已持有原注册 endpoint 时，可用独立诊断入口（不为找 endpoint 先遍历阻塞 NAS）：

```bash
python3 -B bootstrap_diagnostics.py --endpoint /EXACT/ORIGINAL/OWNER.sock
```

它只通过同 UID Unix socket 获取内存中的 busy/idle 和在途请求阶段（idle 时 operation 为 null），绕过 NAS、/proc、
身份刷新和提交锁；连接预算 2 秒，CLI 外层等待 3 秒。最多八个接入处理器共享容量，
饱和、进程失调度或解释器启动阻塞时不能保证诊断可用；失败仍为 unknown。
阶段环形缓冲最多 64 条，CPython 下单写者以 deque 原子 append/copy 记录与快照，
诊断读取不丢弃 begin；仅溢出标注 dropped/partial，不同步写 NAS 日志。
溢出后的 end-only 片段不得作为完成证据。
`diagnostic_only:true`、`durable:false`：未签名、不是 generation 身份证明；idle 仅表示执行通道空闲，
不是 Coordinator idle，更不是确认、健康或屏障释放证据。正式对账仍使用原 owner 和原 pins。
当前 helper 与 owner 的 op_id 各自独立，尚无跨进程 trace 关联或自动 /proc/mountstats 归档。

## 运行期输入与暂时性复核

运行期 Operator 邮箱非空不是身份变更，但也不自动视为已处理。当前只支持以下精确的
**授权不变审查**协议；其他消息继续交原 Operator 处理，不能自动忽略、消费、ACK、改授权
或唤醒。启动阶段仍执行无竞争输入要求。

- 原生消息必须有唯一非空 `id`，`run_id` 为精确 Run，`from_handle` 为原 Coordinator，
  `to_handle` 为原 Operator；payload 恰为 `{"kind":"operator_runtime_review_v1","request":Ref}`。
- request 文件恰含 `request_id`、`run:{id,generation}`、`source`（原 Coordinator terminal）、
  `input:Ref`。所有引用按原始字节核验；正文自称可信不构成证据。
- 每条 handled Ref 的文件恰含 `kind:"operator_runtime_input_handled"`、`request:Ref`、
  `message_sha256`（规范 JSON 原生消息的 SHA256）、精确 `run`、原 `operator` 对象、
  `decision:"no-authority-change"`、非空 `notes`、非空 `evidence:[Ref,...]`。
- candidate 恰含 `lifecycle:Ref`、`mailbox:Ref`（原生 terminal `check --peek` 完整快照）、
  `handled:[Ref,...]`，逐条按原消息顺序对应，不能只处理部分输入。

原 Operator 独立审查并固定候选后，在自己的原上下文执行：

```bash
python3 -B startup_runtime.py review-input \
  --lifecycle /approved/bootstrap/lifecycle/lifecycle.json --lifecycle-sha256 REVIEWED_PLAN_SHA256 \
  --candidate /approved/operator/runtime-review.json --candidate-sha256 REVIEWED_CANDIDATE_SHA256 --execute
```

owner 的具名 `runtime-review-input` 入口重新读取原生邮箱、核验身份/请求/处理回执，并在
提交边界复核，选择 `state_root/runtime-input-<完整邮箱规范 JSON SHA256>.json` 独占发布。
这不是通用 runtime commit，不允许调用方选择输出路径；sender 无权执行。相同目标再次
提交须对账原确认，不重放；新消息/快照漂移重新 pending。消息仍在邮箱，本动作不 ACK，
也不代替业务处理、授权变更审批或最终精确 Run 清空。

只有经原 owner 签名、请求绑定的精确只读身份 timeout/lease-expiry 或上述输入待审状态
进入 `revalidation_pending`。monitor 原循环暂停发送/新准入，沿原 poll 间隔最多连续复核
3 次，成功后继续；`--once` 一次后退出，耗尽返回 3，不制造持久 STOP、不自动续权。
已有 STOP 或未知发送时不重试。一般连接失败、权限拒绝、身份/pin 漂移与 mutation unknown
不走该路径，保留原停止/对账规则。初始接收尚未产生时无 launch receipt，也绝不 ready；
lifecycle 保存已知退出码和空 receipt。耗尽后的 lifecycle 重启仍须人工审查，不自动恢复。

## 完成条件、恢复与限制

- `run_created`、`runtime_ready`、`acceptance_complete` 独立；本 helper 不自动授予业务
  acceptance，返回 `acceptance_complete=false`。readiness 是当前快照，不是未来执行租约。
- 自主模式保留 `awaiting_real_turn_end` 作为首次合法 yield 前的 bootstrap readiness，
  避免“必须先唤醒才能第一次结束”的循环；它不是实际 turn-end/自治通过。
- create/dispatch/send/launch 结果未知一律保存原 intent，查询原操作，不重放、不换 request
  ID、不清 STOP。动作 `executing` 后没有 complete 属于需对账；当前不提供通用的部分结果
  自动采纳、补 complete 或生产重跑入口。即使只读查到原生成功，也不自动生成缺失交接回执。
- monitor 静态准备仅沿原规则接续完整一致的已知发布；未知启动不再次 run。已知正常退出
  且退出回执未变、没有 STOP 时，可显式重跑同一原 plan，仍须通过全部 source/身份检查。
- 原 owner 保持控制，不在 created 或 runtime_ready 时自动退出/disarm；不提供跨 owner
  takeover、授权变化自动接纳、任意类型 Operator 输入自动处理或 pending 耗尽后的自动恢复。
- 新模式的 source upgrade、sender correction、跨 runtime 恢复由旧 continuity helper
  显式拒绝（`startup_lifecycle_recovery_requires_separate_review`），不静默解绑。
- 真实 checkpoint/checker、处理/settle/精确 Run ACK/pending 清零/退役/归档仍按原规范。
  本层不修复 runtime ACK/retire API，也不把终端 inbox 空视作精确 Run 清空。

验证与尚未完成项见 运行期边界开发报告（部署方私有历史材料，不随公开仓库分发）
及前序生命周期交接报告（部署方私有历史材料，不随公开仓库分发）。
回归入口为 `tests/core/test_startup_handoff.py`、`tests/operators/test_operator_startup.py` 和
`tests/bootstrap/test_bootstrap_production.py`；生产 helpers 的离线纵向测试不替代真实 provider、
NAS 新链实测、独立审查或 live 验收。
