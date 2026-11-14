# 独立 Coordinator 启动门（Operator 负责，本地实现）

> **历史（2026-11-13）**：本文的两阶段启动门读取的是旧握手的 `ready.json` / `gate-ready.json`，这些
> 生产者已删除。现行路径是 [start grant](docs/design/start-grant.md)（mint → `run-create --grant` →
> `worker-start`），本文只作历史。


适用于外层 Operator 与独立 Coordinator 协作的**新 Run**。不能先由 Operator
创建 Run/派发研究 Worker，再把名为 Coordinator 的汇总 Worker 当作已完成身份交接。
Run owner 必须是事先独立核验的 Coordinator，而不是两个都填成 Operator 的相等字段。

本文件只定义启动门；角色与 bootstrap/run/recovery 的衔接遵循
[跨阶段控制循环契约（部署方提供）](configuration.md#部署政策与历史材料)。
启动就位后由 Coordinator 自主执行业务循环，不由 Operator 逐轮指定下一任务。

`coordinator_launch.py startup-gate` 是只读、失败即停止的核验入口，不创建或恢复会话、
Run、Task、Worker，不修改 owner，不授予权限。当前实现复用 `trae-exec-stream-v1`
观察器，也显式支持 [Trae TUI](coordinator-tui.md) 的 runtime-state 适配；仅支持 Orca 1.4.219，
exec 为本机 Trae 0.210.1 或 0.211.1，TUI 接受 0.211.1 / 0.212.1 / 0.213.1 / 0.214.1 且须使用对应版本的独立配置；其他 Agent 明确拒绝，不能回退到
Codex。Codex `native-preflight` 仍是另一条检查路径，**不因此获得独立 Operator 启动门**。

这是本地工作流门，不是 runtime 拦截器。直接调用原生派发仍可能绕过它；只有把所有派发
接入强制准入入口，或在 runtime 内增加校验并部署验证，才能宣称不可绕过。本次没有部署。

对于 strict-v1，新启动必须使用 [Trae 原生连续进程路径](trae-coordinator.md)：
先在 Coordinator 内取得 runtime `strict-caller-check` 结果，Operator 固定初始 caller
回执；Coordinator 保持存活等待 session gate，再用 `strict-session-check` 检查该回执
与当前启动身份一致。此附加检查不改写旧 v1/v2 契约。日志门通过不代表 caller proof
通过，shell/PTY 存活和 provider UUID 相同也不能替代原生 Agent 的存活身份。

现行启动授权是一次 [start grant](docs/design/start-grant.md) 的 mint：`run-create` 与每次
`worker-start` 在服务端事务内校验。本文其余部分只作历史与边界说明。

这里的 **v2 是启动契约 schema**，不是原生 Run 的 `coordinatorPolicy` 版本；当前
严格创建仍要求 `strict-v1`。放宽新契约 TTL 不增加进程退出后的 resume/takeover 能力。

## CLI 启动契约

启动契约已有的 `cli:{path,sha256}` 是下游原生 CLI 的唯一来源：`path` 为已核验、
绝对且无符号链接的可执行文件路径，`sha256` 固定其原始字节。部署方在生成契约时选择
入口，不在公共代码中硬编码主机路径，也不依赖 `.bashrc`。

| 消费入口 | CLI 引用链 |
| --- | --- |
| Operator 启动生命周期 / 交接 | strict-start plan → startup contract → cli |
| TUI monitor、部署检查和恢复 | continuation → contract → cli |
| exec/stream driver（新 schema 6） | startup_contract → cli |
| progress watcher | driver_binding → startup_contract → cli |

这些下游入口无需额外 export。若进程已有 `ORCA_SERVER_CLI`，它只是兼容性断言：
必须精确等于契约路径，空值或不同路径都拒绝。原生调用前复核 CLI pin 和可执行权限，
保留原命令白名单及响应 runtime 校验；不按 PATH 自动发现、不回退旧 relay、不修改全局环境。
已审批的 planned-restart runtime 路由仍按原连续性协议执行，不能用 CLI 选择绕过。

无契约引用的历史 schema-5 driver / 无 continuation monitor 继续按原显式环境变量读取。
不修改已有启动契约版本、hash、Run 或部署源码 pins；旧部署使用新代码仍须按既有升级流程审查。
契约固定入口不代表启动门通过、部署完成或获得 Agent 启动授权。

## 两阶段顺序

1. **Run 创建前，Operator 检查独立会话。** 按任务授权与 worktree 准备规则启动独立
   Coordinator 的 bootstrap。Operator 从真实启动流取得唯一 session、完整核对角色
   skill 的交接及实际读取证据，固定自身与 Coordinator 的身份来源，再执行 `session`
   门。bootstrap 在此门通过前不得创建 Run；通过后只能由 Coordinator 从自身原生身份
   在回执有效期内创建获准 Run，尚不得派发 Worker。此阶段不要求一个尚未存在的 Run ID。
2. **首批派发前，Operator 检查 Run 归属。** 按 [Trae 归档路径](trae-coordinator.md)
   完成精确 Run 归档。strict 保持同一个原生进程，不退出/resume；只有历史非 strict
   路径使用正向退出核验及串行 resume。生成新的派发契约，填写
   实际 Run/generation、新 cursor 和精确 write roots，保留原参与者、角色交接、配置及
   freshness policy pin。
   Operator 执行 `first-dispatch`，引用第一阶段回执的原始字节 SHA256。检查真实 owner、
   generation、创建时间及包含远端的完整 Worker 清单；只接受从未派发过 Worker 的 Run。
3. **Coordinator 紧接着复查。** 在自身原生上下文，用完全相同的派发契约运行
   `first-dispatch --actor coordinator`，引用 Operator 的第二阶段回执。重查实际会话、
   owner/generation、空 Worker 清单及自身 `run-current`。实际文件工具验证、原授权、
   预算/并发及其他必需门均通过后，立即派发首批 Worker。不要增加一次模型代办的用户确认。

新 v2 派发使用下文的 `first-dispatch --execute`，在同一次工具调用内完成第 3 步和首个
Worker 的原生请求；不要先输出 Coordinator gate，再等下一轮模型执行裸 `worker-start`。

Operator 只读查询使用 `run-show`；不借用 Coordinator 的 `--from` 或复制身份环境。
Coordinator 的调用需原生 `ORCA_TERMINAL_HANDLE` 与核验目标相符，但环境变量本身不是
身份凭证，仍须真实 stream/session log 和原生归属检查。bootstrap 成功回执可保留为历史
顺序证据，每次派发检查仍重新观察；派发回执不能作为长期许可。

### 受检首派发入口与过期刷新

新链优先使用**准备包 → READY → fresh gate → 执行**，避免把模型规划、材料修订和独立审查
放入 180 秒窗口。旧链仍可在 Worker 请求中加入 `first_dispatch`（见
[Worker 参数计划](coordinator-worker-plan.md)）并执行 `worker-plan` 返回的 helper argv；不自动迁移。
两条路径都必须先完成授权/预算/文件工具/工作区所有权审查，并复用同一个
`coordinator_first_dispatch.py` 执行器、`startup-gate` 和参数生成器，不另建身份检查器：

1. 无 fresh gate 时先固定普通 Worker 请求（不得含 `first_dispatch`）及 package。package 精确包含
   `schema_version:1`、`kind:"coordinator_first_dispatch_package"`、派发契约 pin、Worker 请求 pin、
   原始固定 `state_root`，以及从契约逐字派生的 `slot:{runtime,run,generation}`。
2. `first-dispatch-prepare` 只读校验 package、契约、Worker 参数、CLI/profile/file pins、固定目录和
   slot，输出确定性 READY。它不创建文件、锁、intent、Task、Dispatch 或 Worker；操作者独占保存
   stdout、审查最终字节并固定 SHA256。READY 不授予执行权限，也不替代独立审查；它也不检查
   `state_root` 内是否已有派发证据，该判定只在执行入口完成。
3. package 和 READY 冻结且接收路径就绪后，原 Operator 才生成 fresh first-dispatch gate。刷新只替换
   Operator gate envelope；不得编辑 package、READY、Worker 请求、slot 或 state root。
4. 原 Coordinator 在一次 `first-dispatch --execute` 调用中 pin package、READY 和 fresh gate，实时重跑
   Coordinator 首派门，重查 owner/generation、STOP、完整清单及动态授权边界；变化时停止，不在窗口内
   返工材料。
5. 独占保存新的 Coordinator gate；校验剩余窗口覆盖 native timeout 和 15 秒传输余量。在固定私有
   `state_root` 留下 `dispatch-intent.json`，最后再次校验时间，再使用唯一原生 request ID 调用派发一次。
6. 保存原生 `dispatch-response.json`，只有明确 `ready/input_accepted` 且在门内返回才保存
   `dispatched.json`。这证明请求被接受，不代表 Worker 完成任务。其中 `gate` 可供审查后建立
   continuation 配置；已绑定的旧配置/历史 gate 不覆盖，不能用旧 gate 代替本次派发证据。

准备包示例（所有 `{path,sha256}` 都是已审查的原始字节 pin）：

```json
{
  "schema_version": 1,
  "kind": "coordinator_first_dispatch_package",
  "contract": {"path": "/absolute/dispatch-contract.json", "sha256": "..."},
  "worker": {"path": "/absolute/worker-request.json", "sha256": "..."},
  "state_root": "/absolute/private/first-dispatch",
  "slot": {"runtime": "runtime-id", "run": "run-id", "generation": 1}
}
```

```bash
python3 -B coordinator_launch.py first-dispatch-prepare \
  --package /absolute/first-dispatch-package.json --package-sha256 PACKAGE_SHA256 \
  > /absolute/new-ready.json

# 仅在原 Coordinator 的真实原生上下文执行；Operator gate 必须在 READY 审查后新建：
python3 -B coordinator_launch.py first-dispatch \
  --package /absolute/first-dispatch-package.json --package-sha256 PACKAGE_SHA256 \
  --ready /absolute/new-ready.json --ready-sha256 READY_SHA256 \
  --operator-gate /absolute/fresh-operator-gate.json --operator-gate-sha256 GATE_SHA256 \
  --execute
```

`slot` 把 package、Run/generation 和 intent 绑定到同一业务操作身份，但仍只是本地工作流 fence；
它不是服务端分布式锁。不同状态目录、直接原生调用或丢失回包不能仅凭 package 自证 exactly-once。
出现 intent 后结果统一按 `outcome_unknown` 对账；成功回执为 `outcome:accepted`，intent 前拒绝为
`not_attempted`。不得用 lease/PID 超时、`request-show=absent` 或空清单自动取得重派资格。
intent 写入本身若在原子链接后失败，同样按 `outcome_unknown` 对账，不降级为 `not_attempted`。

成功回执的 `timeline` 只记录实际观察到的时钟读数（Coordinator gate 完成时间、检查时间、请求/
回包时间、`valid_until`）及其导出的窗口与原生耗时；准备阶段是确定性且无副作用的，因此
`prepare_seconds` 明确为 `null` 并列入 `unknown`，不把未知时间写成 0。prepared 回执同时 pin
本次使用的 fresh Operator gate，验收要求 intent 与回执在该 pin 上一致：字节相同的另一份回执
不能替代原证据。

Operator 回执超过 180 秒，或不足以覆盖动作窗口时，**不派发**：Operator 用原 dispatch
contract 和原 session receipt 重新执行 `startup-gate --phase first-dispatch --actor operator`，
独占保存新的回执；历史独立首派入口的 Coordinator 在新的请求文件引用新 pin，仍使用同一固定 `state_root`，
再走上述入口。旧回执保留原始字节。身份、设置、授权仍一致时复用原会话/Run/契约及有效材料；
仅 TTL 到期不要求重启、新建 Run 或重新申请业务授权。不需要每 180 秒定时轮询。
配置观察也过期时须有同会话真实新回合的有效观察，不能改时间戳或自动唤醒来制造证据。

出现 `dispatch-intent.json` 后，成功、超时、崩溃、回包不明或在请求后才发现过期，都不得自动
重试或换 state_root。保留原 request ID，按原生 `request-show`、Worker/Dispatch 清单对账；
它不是刷新 gate 就能重放的业务动作。确认首派成功后，后续波次省略 `first_dispatch`，继续
实时身份/生命周期/容量/预算检查，不再要求空 Worker 清单。已释放的 Worker 也不算从未派发。

`first-dispatch-N` / `refresh-review` 这类 lifecycle v2 原语已随旧握手删除：现行做法是 mint 一次
start grant，再按§“首派”的原生对账规则确认首派，没有 gate receipt 需要刷新。

显式 `workers:not-applicable` 的新生命周期使用 `startup-gate --phase run-readiness`：
仍由 Operator 引用原 session receipt 独立检查，再由 Coordinator 引用该 Operator gate
复查真实身份、Run owner/generation 与空派发清单。它不调用 worker-start，不能当作首派成功；
continuation 只经 reviewed no-worker admission 接受 `dispatch_gate:null`。

本入口仍是本机工作流 fence，不是 runtime 原子租约：独立原生调用可绕过，网络/服务端延迟
可能越过截止时间，晚回包必须作为未确认结果保留。不能声称服务端已部署不可绕过的门禁。

首次 Worker 派发后不再运行这道“首批”门；后续各波次沿用实时身份/生命周期/预算检查。
旧 Run、身份变更、接管或缺失启动证据走显式对账与恢复流程，保留偏差记录。即使所有
Worker 已完成/释放，也不能补写本门通过；它不自动重开 Run 或迁移 assignments。

## 契约与调用

契约是私有 JSON，字段如下；`{path,sha256}` 均为规范绝对路径及原始字节 hash。
从独立来源核对后固定契约 hash，不从待验回执反推正确身份或原始授权。

| 字段 | 要求 |
| --- | --- |
| `schema_version`, `adapter` | 新契约默认固定 `2`、`trae-exec-stream-v1`；校验器兼容旧版 `1`，不自动升级 |
| `freshness` | v2 必填 `{context_max_age_seconds,gate_receipt_ttl_seconds}`；生成器固定 `1800`（30 分钟）、`180`。校验器仍要求整数（不接受布尔值），范围分别为 `1..3600`、`1..300` 秒，以兼容已固定的 v2 时限。v1 不允许此字段 |
| `cli` | 已选 runtime 的固定 CLI 文件引用 |
| `runtime` | 实时核验的 runtime ID |
| `workspace` | `{id,path}`，目标 worktree 完整 ID 与规范路径 |
| `operator` | `{terminal,incarnation,provider,session}`，启动操作者自身的已独立核验身份。`provider` 是显式声明，经 `provider_capability.py` 能力表解析后再由 native 证据核验：`trae` 与 `pi` 都可核验（各自证据见 [协议 §5.1](strict-bootstrap-protocol.md#51-provider-能力与拒绝码)），未知名是 `operator_session_provider_unsupported`，缺证据是 `operator_session_<provider>_operator_unverifiable` 附 `missing_evidence`，不猜另一日志根或回退另一 provider；Pi Operator 的 `expected_effective` 只允许 `model`/`model_provider`/`thinking_level`/`cwd`。Operator 清单与前提见 [支持范围](operator-prepare.md#agent--adapter-支持范围) |
| `coordinator` | `{terminal,incarnation,session}`，独立会话（Trae 或 Pi），不能与 Operator 同 terminal 或同 provider/session |
| `runtime_config` | 本任务明确的 provider 输入引用：Trae 为 execution 配置，Pi 为 pi runtime policy（`provider/model/thinking_level`），与观察器核验的实际设置一致 |
| `role_skill` | 目标 worktree 内适用 Coordinator `SKILL.md` 的固定引用 |
| `handoff` | 原 bootstrap 交接文件固定引用，包含角色与已核验授权来源；Run 尚未分配时不伪造 ID |
| `skill_read_evidence` | Coordinator 实际完整读取角色 skill/必需引用的工具记录引用，须由 Operator 审查 |
| `observation` | `{cursor,log_root,roots}`，实际启动输入前 cursor、规范 provider 会话日志根、非空精确 writable roots 列表；v2 可增加已独立固定的 `startup_anchor:{path,sha256}`，纳入跨阶段身份 pin，不适用于 v1 |
| `run` | session 阶段为 `null`；派发阶段为 `{id,generation}`，generation 为正整数 |

程序校验 role 文件位于目标工作区及上述引用未变，**不解析或认证完整阅读、理解和授权**。
Operator 的 provider/session 仍须独立审查。历史 exec/stream 路径只实时检查
terminal/incarnation；TUI 路径额外复用 `runtime_binding.capture`：原生 terminal →
tab:leaf → hooks.entries[pane] → provider session → 日志首行 `session_meta.id`，
并在观察 Coordinator 前后核对 session、incarnation、hook 时间及日志不可改写前缀。
`turn_id` 即使也是合法 UUID 也不能替代 session。此 Operator 适配只支持同 profile、
显式 provider log_root 下的 runtime-state；`trae` 与 `pi` 各有自己的 hook/transcript 证据，未知 provider 停止，不猜测其日志目录。
回执仅增加观察摘要和 `runtime-state-not-process-attested` 可信度，不导出原始日志或凭据，
不替代 Coordinator 实时 caller 校验。旧契约身份 pin 不修改，不提供同 Run 身份纠正/回填。

TUI 的 Operator 必须在自身原生终端上下文发门；在 session / first-dispatch 两阶段开始
及结束前分别执行自身 inbox 的 `check --terminal <operator> --peek`，任何未读消息、
错误响应或权限拒绝均停止。脚本不消费/ACK，不查询 Coordinator Run inbox；Coordinator
复查也不代查 Operator inbox。Operator 须自行完整处理事实/停止消息，再在原授权内重验。
“无未读”不是审计通过：已读取但未履行的停止要求仍有效；两次 peek 也不是服务端原子锁，
最终检查后到达的新消息仍需要原生控制循环处理。不能用手填 JSON、自报“读过”、模型标题
或 cwd 替代实际审查。信任边界仍是受信操作者、原生接口与精确日志，不是密码学/进程证明。

新契约统一由 `startup-contract` 生成，不再逐次选择版本。输入为上表中除
`schema_version`、`freshness` 外的已审查字段；`run` 可省略或为 `null`，其他字段均必填。
生成器只读核对本地文件 pin 并输出完整契约，不查询 Orca、不生成身份或授权、不写文件。
它固定写入 v2 和 1800/180 秒；拒绝带版本/时限的旧契约输入及非空 Run，不能充当迁移命令。
旧 v2 契约（包括 900/60 秒）仍按其中已固定的值校验，不能更换默认值来延长旧回执。

```bash
python3 -B coordinator_launch.py startup-contract \
  --input /absolute/private/session-fields.json --input-sha256 REVIEWED_FIELDS_SHA256
```

成功退出 `0`，stdout 为完整契约，不是 gate 通过回执；失败退出 `2`、`ok:false`，不得
作为契约使用。将成功输出独占保存为新的私有契约文件，审查最终字节并固定 SHA256 后，
再运行下述 `startup-gate`。既有文件不会被工具覆盖，也不读取环境变量来改写默认值。

生成结果中的版本与时限片段如下。默认值在生成时落入文件；校验器不会为缺失字段补值。
两个阶段必须使用相同 schema 和时限，它们纳入 v2 的 `identity_sha256`，不能在续接时放宽。
派发契约由已固定的 session 契约保留绑定字段、填写真实 Run/cursor/roots 后重新审查固定，
不重新调用新建生成器：

```json
{
  "schema_version": 2,
  "freshness": {
    "context_max_age_seconds": 1800,
    "gate_receipt_ttl_seconds": 180
  }
}
```

以下命令只输出回执。由操作者将每次成功或失败输出独占保存到获准的私有 bootstrap/Run
证据目录，计算原始字节 SHA256 后交接；不覆盖旧尝试。示例占位符不能直接运行：

```bash
python3 -B coordinator_launch.py startup-gate \
  --contract /absolute/private/session-contract.json --contract-sha256 REVIEWED_SHA256 \
  --phase session --actor operator

python3 -B coordinator_launch.py startup-gate \
  --contract /absolute/private/dispatch-contract.json --contract-sha256 REVIEWED_SHA256 \
  --phase first-dispatch --actor operator \
  --previous-receipt /absolute/private/session-receipt.json --previous-sha256 RECEIPT_SHA256

# 仅在原 Coordinator 的真实原生上下文执行：
python3 -B coordinator_launch.py startup-gate \
  --contract /absolute/private/dispatch-contract.json --contract-sha256 SAME_REVIEWED_SHA256 \
  --phase first-dispatch --actor coordinator \
  --previous-receipt /absolute/private/operator-dispatch-receipt.json --previous-sha256 RECEIPT_SHA256
```

任一步失败退出 `2`、`decision:stop`；不能用 `ok:false` 回执继续，也不自动刷新、重试或
更换适配器。CLI 不导出原生错误正文；保留私有调用记录排查固定错误码。成功退出 `0`，
记录参与者/输入摘要、前序摘要、起止时间、Run owner/generation 与会话观察摘要。
`execution_authorized:false` 表示本工具不授予权限，不表示用户否决。

### 分离配置记录年龄与回执有效期

Trae 的 `turn_context` 是一轮开始时记录的实际模型/权限配置，不是心跳。读取规则、
调用工具、写出 readiness 或再次观察日志，都不会刷新它的时间戳。bootstrap 超过
300 秒不必然意味着进程或配置失效；也不能仅凭最近有工具输出认定配置记录仍然新鲜。

v2 将两个时限分开并固定到契约：

- `context_max_age_seconds`：最新完整 `turn_context` 的最大年龄；新建默认固定 1800 秒以容纳
  bootstrap 规则读取。只改变年龄约束，仍完整核验 session、terminal/incarnation、
  实际模型/权限、write roots 和文件 pin。观察时与整个 gate 结束时都不得过期。
- `gate_receipt_ttl_seconds`：本次核验完成后的短期使用窗口；新建默认固定 180 秒。
  `valid_until = min(context_observed_at + context_max_age_seconds,
  completed_at + gate_receipt_ttl_seconds)`。临近配置记录过期时，实际剩余时间可能短于 180 秒。

这两个值均不同于 strict 握手配置 `start.json.deadline` 的绝对启动截止时间。
prepare/plan/wait 要求该截止时间的剩余量大于 0、且不超过 900 秒；过期报
`strict_start_deadline_expired`，过长才报 `strict_start_wait_must_be_bounded_to_900_seconds`。
调整 gate TTL 不会延长这个截止时间，也不会刷新 `turn_context`。

v2 成功回执记录 `freshness`、`context_observed_at`、`context_age_seconds`（gate 结束时）
及 `context_expires_at`。Coordinator 回执的有效期还受前序 Operator 派发回执上限约束，
不能借复查续期；过期须由 Operator 重新核验并产生新的回执。

Operator 的 v2 首批派发检查会核对 Run `created_at` **整个精度区间**不晚于 session
回执的 `valid_until`，而不是仅比较截断后的秒数。秒级回包代表 `[t,t+1秒)`；带小数回包
按其精度处理，不猜测丢失的小数。新 strict waiter 会在 gate 完成后的安全秒边界再创建，
详见[时间边界规则](coordinator-strict-start.md#原生秒级时间戳与严格截止边界)。
只要 Run 在窗口内创建，session 回执可在后续作为已过期的历史顺序证据使用；派发阶段
仍须重新观察当前配置与身份。它不是 runtime 对 Run-create 的同步拦截，不能撤销一个
已经迟建的 Run；不满足时停止派发并显式对账。

旧 v1 契约保留原始 identity hash 和 `turn_context + 300 秒` 的回执期限，不增加
v2 的 Run 创建期限检查；直接调用 Trae 观察器也保留 300 秒默认值。新行为只由完整
v2 契约显式启用，禁止混用 v1/v2 成功回执链。失败回执继续使用固定的 v1 错误封套，
不作为可续接的成功回执。

两次原生快照前后复核 pin 和空清单，仍非原子快照或分布式锁。终端 `connected` 不等于
Coordinator 进程存活证明；前述正向退出核验、同终端同会话串行 resume 要求保持不变。
环境变化或交接延迟须重新检查，不得用旧回执规避。工具不检查文件探针、科学验收或所有
费用/权限边界。

### 固定错误与启动时序

已识别的本地时间错误不再统一折叠为 `startup_gate_failed`：

| 错误码 | 含义 |
| --- | --- |
| `session_context_stale` | 观察到的配置记录超过契约最大年龄；附 `age_seconds`、`max_age_seconds` |
| `session_context_in_future` | 配置记录时间晚于观察器时钟；附上述数值，须排查时钟或证据 |
| `session_context_expired_during_gate` | v2 配置记录在检查过程中到期；附上述数值；v1 保留 `session_evidence_expired_during_gate` |
| `gate_clock_moved_backwards` | gate 结束时间早于开始时间 |
| `run_created_after_session_gate_expired` | v2 Run 未在 session 回执有效期内创建 |
| `operator_dispatch_gate_stale_or_changed` | 前序派发契约变化或 Operator 回执已过期 |
| `operator_dispatch_gate_expired_during_gate` | Coordinator 复查期间 Operator 派发回执到期 |

只导出已知本地错误及年龄/上限数值；未知 native/provider 错误仍返回
`startup_gate_failed`，不向 stdout 输出路径、模型正文或原始错误内容。

操作者应将不依赖 readiness 的索引、规则和契约准备前置；bootstrap 期间完成独立来源
核验，readiness 出现后立即审查完整读取证据、固定最终 hash 并执行 session gate。不得
省略必需审查；非关键汇报延后。通过后先在 `valid_until` 前交给原 Coordinator 创建
Run，再完成后续归档与派发检查，减少门前门后的无关等待。

若仍过期，保留失败回执与年龄数值，核对耗时和原会话生命周期。不得篡改日志时间戳、
以文件 mtime/工具活动充当配置更新时间，或自动重启/唤醒 Coordinator 来刷新窗口。
确需重新检查或恢复时，遵循原授权与生命周期流程；新建契约/回执文件，不覆盖旧尝试。
v1 失败不构成在已有链上放宽时限的理由；采用 v2 须在新核验链开始前审查并固定，
不能追补迁移现有 Run。

`coordinator_operator.py` 的既有提交/查询循环不负责本门，也不在循环里创建 Coordinator。
历史启动计划和回执保留原始字节，不表示新生成器仍逐字兼容。模板更新导致固定计划不匹配时
应拒绝续用，按获准恢复流程重新核验，不修改旧证据或回填本门通过。现有 Run 不自动迁移。

离线回归（不调用真实 Orca/模型）：

```bash
python3 -B -m unittest discover -s tests -p test_coordinator_startup.py -v
```
