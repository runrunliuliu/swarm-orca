# 常驻 Coordinator TUI（显式试验路径）

> **部分历史（2026-11-13）**：continuation/TUI 续跑本身仍是现行路径；本文中依赖旧握手产物
> （`ready.json`、`strict-config-*`、`startup_handoff`）的部分已删除，见
> [start grant](docs/design/start-grant.md)。


本次修复的是一次性 `trae exec` 结束后留下 shell、后续文本无法进入 Coordinator 的
生命周期断点。TUI 能在模型回合结束后保留原生 Agent 进程，并通过 Orca 原生 Run
mailbox 接收消息。**常驻进程不等于任务完成，也不等于服务/崩溃恢复。**

可选 schema v2 Operator 自动调度，复用现有 monitor 循环和
continuation outbox，详见 [monitor 配置与边界](operator-monitor.md#显式开启-strict-tui-自动调度)。
旧 `trae-coordinator-runtime.json` 保持 exec，历史计划/启动门 hash 不变。新增
[TUI 配置](trae-coordinator-tui-runtime.json) 必须显式选择；不在未真实验收前改为默认。
适配目标为 POSIX Orca 1.4.219 + Trae 0.211.1；实际部署须核验具体补丁能力与配置。
此文不携带私有历史验收结果，公开代码/fixture 不等于已部署或真实闭环通过。

## 结构与启动

```text
Operator ──目标/事实──> 原生 Run mailbox ──忙碌保留/空闲唤醒──> 同一个 Coordinator TUI
                                                                  │
                            checkpoint → enqueue → claim → action → settle
```

不新增第二个业务 Coordinator：Operator monitor 可按领域 checkpoint 自动排续跑，不消费
Coordinator inbox，不决定业务下一步。Orca 负责 durable mailbox、idle delivery 和原生身份约束；helper
负责同一动作的本地 outbox/领取/结算。消息发送成功只证明入队，不证明唤醒或业务完成。

从本 worktree 的绝对入口生成计划（本命令只输出 JSON，不启动）：

```text
python3 -B /absolute/swarm/coordinator_launch.py \
  --trae /absolute/verified/traex --strict-coordinator \
  --trae-runtime-config /absolute/private/trae-coordinator-tui-runtime.json \
  --model-config /absolute/private/coordinator-model.json \
  --cwd /absolute/task-worktree --bootstrap-dir /absolute/approved/bootstrap \
  --prompt-file /absolute/reviewed-task.md
```

新 adapter 为 `trae-tui-runtime-v1`，phase 为 `strict-tui-bootstrap`。
先固定 Operator 材料清单和 Operator 身份输入，再通过现有 `strict-native-plan` 审查/核验后生成
`terminal create --agent trae --agent-args`：
不含 `exec/--json/--color`，含 `--no-daemon --no-alt-screen --strict-config`，完整绑定正文
作为一个位置参数传入，保留 16 KiB 原生参数上限。禁止 raw shell capture、resume、
replacement 和非 strict TUI 启动。权限保持 workspace-write/on-request/auto_review，
模型由已审查的显式配置确定，且必须被适配器接受；不改 Worker 或全局配置。

TUI 计划另含一条进程级目录信任覆盖：`-c 'projects={"<已解析 cwd>"={trust_level="trusted"}}'`。
Trae 对没见过的目录会先问 "Do you trust the contents of this directory?"，非 yolo 启动会停在
人工按键上。Orca 现已在**任何 fresh 启动**（含 CLI `terminal create`）前预写
`~/.trae/traecli.toml` 的 `[projects."<path>"]`，不再限于 `launch_source=orchestration`
（自包含该修复的 Orca 构建起）；本侧仍自带覆盖，因为 strict 路径不能依赖目标构建是否已含
该修复，也不能假设预写一定成功。
覆盖只作用于本进程：不写用户级配置、不改变 sandbox/approval/权限，只允许本次启动加载项目本地
配置/hook；`json.dumps` 保证含点号的绝对路径仍是单个带引号 TOML key（点分写法会被按 `.` 拆开并报错）。
未启用该覆盖的 `exec` 计划保持原 argv 不变。实测（0.214.1）：同一 cwd 无覆盖→弹 trust；有覆盖→
直接进 TUI；`-y` 本身不能跳过 trust。

继续使用原有两阶段启动门及固定文件 config/start delivery，不靠 TUI 输入替代门。
共享或隔离 profile 均可用于已授权的 `strict-v1` 任务；恢复限制不因 TUI 改动而解除。
真实测试须获准，明确隔离/共享 profile 和影响边界，不默认授权修改共享服务。

## TUI 身份和观察器

Operator 可用 [operator_prepare.py observe-session](operator-prepare.md#3-已有会话后一次读取并保存观察)
一次传入已固定 pin 的参数文件，调用同一个 `trae_tui.observe` 并保存原格式观察，stdout
只返回精简结果及引用。下述原入口保持兼容；两者都不能替代实时 caller 校验。

Coordinator 先在自身工具上下文运行 `orchestration strict-caller-check --json`，
Operator 独立固定完整回执 hash。然后使用 [trae_tui.py](trae_tui.py)：

```text
python3 -B /absolute/swarm/trae_tui.py \
  --cli /absolute/orca-server-cli --runtime <verified-runtime> \
  --terminal <terminal> --incarnation <incarnation> --workspace <worktree-id> \
  --cwd /absolute/task-worktree --profile /absolute/verified/runtime-profile \
  --caller-receipt /absolute/caller.json --caller-sha256 <sha256> \
  --log-root /absolute/verified/trae-sessions --root /absolute/approved/bootstrap \
  --trae-runtime-config /absolute/swarm/trae-coordinator-tui-runtime.json \
  --save-startup-anchor /absolute/new-tui-anchor.json
```

读取同用户私有、规范路径的 runtime discovery 和 `agent-hooks/last-status.json`，
只接受精确 `tabId:leafId` 的非 replay、非恢复未确认 Trae 记录。日志必须来自该记录的
精确 providerSession 路径，不做 latest-log 搜索、不从屏幕或用户指定 UUID 推断身份。
交叉核对 terminal/PTY/incarnation、runtime PID/start、launch-token commitment 与
原生 strict-caller fingerprint；从日志核验真实模型/effort/Max/approval/write roots。
输出不含 discovery authToken 或 launch token。不会绕过权限、不读 `/proc`。

TUI metadata 限 `originator=traex-tui`、source 为 cli/缺省、无 parent/agent_id；
版本必须 0.211.1 / 0.212.1 / 0.213.1 / 0.214.1（0.214.1 于 2026-11-09 用真实 TUI 会话核验过 metadata 与 turn_context 字段，见 [Trae Coordinator 文档](trae-coordinator.md)）。后续观察传 `--expected-thread` 和 anchor path/hash，重验原文件
inode/完整历史前缀、映射和实际配置。变化或证据缺失就停，不降级为 exec 观察器。

新 v2 startup contract 的 observation 固定为：

```json
{
  "profile": "/absolute/verified/runtime-profile",
  "caller_receipt": {"path": "/absolute/caller.json", "sha256": "<sha256>"},
  "log_root": "/absolute/verified/trae-sessions",
  "roots": ["/absolute/approved/bootstrap"],
  "startup_anchor": {"path": "/absolute/tui-anchor.json", "sha256": "<sha256>"}
}
```

没有 cursor 字段，不兼容 v1。profile/caller/anchor 都纳入跨阶段身份固定；strict-start
使用相同 caller pin。缓存 hook **不是实时进程证明**：session gate 的消费、首派
Coordinator 检查、后续 enqueue/claim/settle 都必须在原 Coordinator 上重新取得 native
strict-caller-check。`connected/writable=true` 或 `agentIdentity` 单独都不授予执行权。
同一进程中的 `/new` 改变 provider session 也会停止原续跑链。

## 同会话 continuation

有两种显式模式：schema v1 保留下面的模型主动 enqueue 协议；schema v2 固定 `scheduler`
身份后由 Operator monitor 排队，模型的 enqueue 被拒绝。v2 中模型只需保存领域检查通过、
属于本回合的不可变 checkpoint，更新 head，结算和 ACK 上轮动作，然后结束回合。
`check/claim/settle` 和业务执行时的 freshness 不变。新生成的 v2 提示要求每回合结束前
运行 `turn-end`，提前检查 checkpoint 属于当前真实回合；它仍是只读审计，不是 scheduler
触发器或 runtime 强制 hook，漏调用不会阻止外层检查真实 `task_complete`。v2 不自行 enqueue。
不自动迁移已使用的 v1 配置、不放开旧 driver 的 `strict_shell_resume_unsupported`。

[coordinator_tui_continue.py](coordinator_tui_continue.py) 由原 Coordinator 调用，
没有后台轮询，不创建 Agent，不执行具体业务动作，也不读取/ack inbox。
必须先完成两阶段启动门；所有路径都使用已授权规范目录。

### 有界回合与只读重验

在首派门通过后、每个真实模型回合开头及长工作/等待之前，由原 Coordinator 调用：

```text
python3 -B /absolute/swarm/coordinator_tui_continue.py check --action-seconds 60 \
  --config /absolute/continue.json --config-sha256 <sha256>
```

`--action-seconds` 填下一项工作或等待的有界秒数估计，不是延长授权。`check` 不接受
`--execute`、checkpoint/result 参数，不创建锁或 outbox，不发消息、
不消费 inbox、不启动 Agent。它重验现有 config、原会话/caller/owner/generation、
精确 hook 和启动锚点下的日志设置，并返回 `freshness`：

- `context_observed_at` / `context_expires_at`：真实 `turn_context` 时间及固定有效期。
- `valid_until`：上下文有效期；若配置有明确 deadline，则取两者较早值。
- `checkpoint_by` / `checkpoint_due`：为领域检查、checkpoint 和 enqueue 预留最多
  180 秒（不超过 context 有效期一半）的回合规划提示，不是延长有效期或动作执行许可。

应在 `checkpoint_by` 前完成一项有界动作或保存阶段 checkpoint，在有效期内 enqueue，
然后结束当前**模型回合**，保持 TUI 存活；不要在同一回合直接消费自己刚入队的接续，
也不要把整个窗口用在等待 Worker 上。真正依赖等待遵循已有有界原生等待/唤醒协议。
传入 `--action-seconds` 后，`check` 返回 `action_allowed` 和 `action_window_seconds`；
到达 checkpoint 预留区，或估计时长大于等于可用窗口时返回 false、CLI exit 2。
此时不开始新业务动作，应及时 checkpoint/enqueue/end-turn。`claim` 同样执行硬检查：
使用同一 `--action-seconds`（省略时兼容默认 60 秒），必须严格小于剩余工作窗口，
且真实 turn_context 必须晚于入队回执时间，不能同回合消费自己刚入队的动作。
enqueue/settle 在证据仍有效的预留区内可继续，不能把防超时措施变成无法收尾。
检查并非工具调用拦截器或强制抢占器；模型忽略检查、低估时长或已发出的长工具仍可能超时。
首派门之前也要控制 bootstrap 时长；本 helper 仅支持门通过后的 Run，不认证启动阶段续跑。

同一 TUI 的下一次**真实回合**写入新的 `turn_context` 后，重验会采用新记录，同时
保留原 contract、startup anchor、config、deadline 和 outbox，不重跑首派门或重置预算。
反复读旧日志不会刷新时间。设置/身份变化、hook 过期、改写历史、Run 退役仍然拒绝。
没有在过期前留下合法唤醒时，本版不自动救活：保留现场并报告，不造空回合、不发 raw
terminal 输入、不改 TTL/日志时间，也不启动替代 Coordinator。

错误回执现在区分 `session_context_stale`（附 age/max_age）、
`session_context_in_future`、`tui_hook_stale_or_future`、`tui_run_owner_changed`、
`tui_checkpoint_superseded` 等本地检查失败；未知异常仍返回通用错误，不输出原生
命令、stderr、凭据或私有路径。发送、领取、结算提交前都复查真实证据时间。
发送前的检查失败保留 `attempted:false`；只有通过检查并持久记录 intent 后才调用 send。
已尝试且结果不明的 send 仍只对账、不盲重发。

### 固定配置和动作

新 schema v2 可用 [coordinator_tui_prepare.py](coordinator_tui_prepare.py) 简化初始化。
Operator 前置准备 acceptance、scheduler 身份和 deadline 字段；原 Coordinator 在首派门
通过后取得真实领域 checkpoint 及成功的 `check-authorized-progress` 回执，再一次调用：

```text
python3 -B /absolute/swarm/coordinator_tui_prepare.py \
  --inputs /absolute/approved/prepare-inputs.json --inputs-sha256 <sha256> --execute
```

输入为 `schema_version: 1`，包含 `contract`、`dispatch_gate`、`acceptance`、`source`、
`receipt` 五个 path/sha256 引用，`deadline`，`scheduler`（terminal/incarnation/workspace）
和 `output_dir`。其中 source/receipt 必须是真实领域检查材料，不能使用占位值。
output_dir 必须是授权根内尚不存在的子目录，其既有父目录须为当前用户所有、模式 0700。
helper 复用既有校验器，重验当前会话及 owner，生成 checkpoint/head、schema v2 config
和独立 state，最后发布 `output_dir/continuation-ref.json`。Operator 用该引用准备 monitor；
初始化前和最终发布前还会只读核验 scheduler 是精确匹配且连接中的非 Agent 原生 shell，
按 1.4.219 可选字段契约接受省略或 null 的 `agentIdentity`，实际 Agent 身份拒绝。
共用 sender 预检不替代执行时的自身 caller 校验。
helper 同时返回固定 config pin 的 `turn_end_command`。Coordinator 处理完当前原生消息、
通过该回合结束审计后结束当前回合，由 monitor 安排下一轮，不自行 enqueue。

已有或部分初始化目录会被拒绝，失败现场保留；不得换目录来重置 deadline 或预算。
初始化成功后，Operator 应只读观察固定 publication，不重复发送初始化提醒。重复提醒或其他
外部消息可能开启新的真实回合；此时即使普通 `check` 成功，旧 checkpoint 也不属于当前
回合。Coordinator 继续使用原 config/state/deadline，处理消息，重新核验业务事实并生成新的
不可变 source/receipt/projection，只原子推进 head，然后运行 `turn-end`。不得只改时间戳、
重复初始化、清除 journal，或删除 monitor 的持久停止状态来恢复。
此入口不生成领域授权、不发送消息、不派发 Worker、不激活 monitor。新契约上下文默认
有效期为 1800 秒，首派门回执仍为 180 秒；旧契约不静默升级。
首 tick 前误绑定 sender 的已失败部署，只能经
[显式独立审查修正](operator-monitor.md#首-tick-前的-sender-绑定修正)保留原状态与失败证据；
普通配置编辑、重新初始化或删除锁/状态仍不是恢复方式。

新 v2 Run 的首派发先走 [受检派发入口](coordinator-startup.md#受检首派发入口与过期刷新)。
`dispatch_gate` 使用该次成功 `dispatched.json` 引用的新 Coordinator gate，不使用之前
已过期的观察回执。将 continuation 的目录、acceptance、checkpoint 等准备前置，首派
确认后再固定配置；不能覆盖已使用的旧配置。后续回合把 gate 当作历史阶段证据，而非
持续有效的派发许可，因此不每隔 180 秒重跑首派空清单门。

固定 config（不含凭据，首次使用后不能更换，state_root 为独立 0700 目录）：

```json
{
  "schema_version": 1,
  "contract": {"path": "/absolute/run-phase-contract.json", "sha256": "<sha256>"},
  "dispatch_gate": {"path": "/absolute/coordinator-first-dispatch.json", "sha256": "<sha256>"},
  "acceptance": {"path": "/absolute/original-acceptance.json", "sha256": "<sha256>"},
  "state_root": "/absolute/approved/continuation-state",
  "checkpoint_head": "/absolute/approved/current-projection-ref.json",
  "deadline": "2026-10-26T23:00:00+08:00"
}
```

acceptance 内容是 `{"requirements": [...]}`，由原始任务独立审查并固定，不能由新
checkpoint 反推授权。新 schema v2 配置可显式使用 `"deadline": null`，表示不设整轮
验收截止时间；初始化输入也可传 null。无用户明确总时限时使用此方式，不自创倒计时，
不填遥远日期模拟无限期。按验收结果收尾，保留单步超时、真实上下文 freshness、
首派门 TTL、原预算、无进展止损及身份/协议错误停止；null 不代表无限费用或重试授权。
有明确任务期限时 deadline 须不晚于该期限。schema v1 仍必须填时区明确的时间字符串；
v2 也不接受缺字段、空字符串或其他类型。已有显式 deadline 仍严格执行，首次绑定后
不允许换配置、改 null 或用新目录延期。取消先前助手自定时限须由用户明确决定，
保留旧尝试并独立核对新尝试继承的实际预算及限制。
运行时的预算、max_workers、重试及费用约束仍由原授权/原生控制面执行，helper 不新增额度。

接入新 [startup lifecycle](operator-startup.md) 的配置还须完全匹配原 Operator 固定的
`runtime.deadline`（包括显式 null）、模式、sender 和授权 pins。只有原 owner 在启动窗口
内确认完整 Run/admission/continuation 链，之后才按 runtime 准入继续；不自动延长旧
attempt。check 的动作窗口、claim/settle、scheduler review-clear 及最终发送边界均复核
当前 owner 控制，pending 不发新许可。原操作未知仍对账，不新增 STOP/过期后的执行例外。

先运行目标仓库的角色 skill 和 domain progress/authority checker；保留原 operational
checkpoint，不改 RSI 等业务 schema。另生成不可变投影：

```json
{
  "binding": {"runtime": "<runtime>", "id": "run_example", "generation": 1, "terminal": "<terminal>"},
  "requirements": ["这里必须填原验收的完整对象，不能使用本占位字符串"],
  "checkpoint": {"decision": "continue", "requirements": [], "paths": [], "barriers": [], "next_action": {}},
  "domain_check": {
    "adapter": "rsi-authorized-progress-v1",
    "source": {"path": "/absolute/approved/operational-checkpoint.json", "sha256": "<sha256>"},
    "receipt": {"path": "/absolute/approved/domain-check-receipt.json", "sha256": "<sha256>"}
  }
}
```

上例展示字段，不是可运行 checkpoint。共享结构以 [coordinator_loop.py](coordinator_loop.py)
的 `checkpoint_route` 为准。当前显式 adapter 为 `rsi-authorized-progress-v1`：source 必须
直接指向 schema v2 operational checkpoint，而非包含未哈希路径的 manifest；投影的五个
字段（requirements/paths/barriers/decision/next_action）须与 source 完全一致。receipt 必须是
成功的 `check-authorized-progress` 回执，顶层 authority_check 的 run_id/checkpoint_sha256
须绑定源记录，result 的 contract_sha256/decision 也须一致。文件 pin 使用原始字节 SHA256，
RSI checkpoint_sha256 使用 canonical JSON SHA256，两者不能混用。旧的间接绑定会被拒绝，
不得覆盖旧证据；新证据需重新审查并固定。这只核验绑定声明，不认证回执来源，也不是
新的 RSI 授权检查器，不能替代角色 skill、独立来源核对或 check-authorized-progress。

首次使用前，由原 live Coordinator 显式创建 config 所指的独立 0700 state_root，生成并
固定 source、领域回执和投影，再原子创建 checkpoint_head 为投影的 `{path,sha256}`，
最后运行只读 `check`。缺目录返回 `tui_continuation_state_not_initialized`，缺 head 返回
`tui_checkpoint_head_not_initialized`；check 不会代为创建目录、锁或 outbox。其他未知
文件错误仍脱敏。不要通过重建 config/目录绕过既有绑定或延长期限。

由唯一 Coordinator 原子更新 `checkpoint_head` 文件为当前投影的 `{path,sha256}`。
晚到的旧消息会因 head 不匹配被拒绝。原始投影文件不得覆盖；重复 action ID 不得代表
另一项动作。发生 superseded 未执行的 pending action 时保留 outbox、停止此自动链并
核对依赖；本版没有自动取消/接管 pending 动作的接口。

```text
python3 -B /absolute/swarm/coordinator_tui_continue.py enqueue --execute \
  --config /absolute/continue.json --config-sha256 <sha256> \
  --checkpoint /absolute/approved/projection.json --checkpoint-sha256 <sha256>
```

只对 `continue + next_action.owner=coordinator` 入队。重复调用只回读原回执；send
前持久记录 intent；timeout 后只 `request-show` 对账，即使 absent 也不盲目重发。
向自己的 `run:<id>` 发 status 消息，携带固定 config/checkpoint 引用，不使用伪造
`--from`，不向终端输入命令。Orca 忙碌保留消息、idle 时的 live delivery 负责唤醒。

同一 TUI 收到 mailbox pointer 后按原生指南 check 消息，重新验证当前 checkpoint/
领域授权，然后以同样参数改用 `claim`。仅 `execute_action=true` 可执行该动作；重复
claim 为 false。执行成功后用 `settle --result /absolute/result.json --result-sha256 ...`
保存结果 pin。结果字段：`action_id`、原 `checkpoint` pin、`status:"executed"`、非空
`evidence:[{path,sha256},...]`。所有结果证据须在已授权 roots；未知结果不能结算为 executed。
下一动作前必须结算上一项，并通过共享 checkpoint transition 结构检查。

结果文件及其直接 evidence 引用不能放在 continuation 的 `state_root` 内，也不能
引用可变的 `checkpoint_head`。否则返回 `tui_result_control_file_reference`，不写入
settlement，保留原 claim/request ID；用 `coordinator_snapshots.collect/publish/recheck`
或 `coordinator_io.publish_new` 将实际观察保存到控制目录外的新不可变文件，再提交
新的 result pin 重试 settle，不重做已执行动作、不提前 ACK。尤其不能直接 pin
`outbox.json`：settle 自身会修改它，让刚保存的证据立即失效。此检查不保证其他路径
永不变化，不递归认证任意 JSON 中嵌套的引用，也不把状态快照当业务执行证明。

本地 pin 字节失配返回脱敏的 `file_pin_changed`，不输出路径、哈希或原生错误正文；
普通外部异常仍脱敏。已经结算的错误引用**不会自动修正**，旧 result/outbox/STOP 和
部署 source pin 必须保留；本补丁不是恢复已停止 monitor 的授权或历史迁移入口。

monitor 和 Coordinator 共用 continuation 锁。仅获取该锁时遇到占用，scheduler 返回
`reobserving / tui_continuation_lock_busy`，下次 tick 重新读状态；不发送、不写永久 stop。
`enqueue/claim/settle` 则返回退出码 **75**、`state=retryable`、`committed=false` 和
`execute_action=false`，只表示本次调用未提交，不表示此前调用未提交。至少间隔 1 秒，
在原截止时间和预算内用相同命令及 pins 重试。claim 成功前不得执行；settle 重试不得
重做业务动作，成功结算前不得 ACK。重试会重新检查配置、head、身份和 outbox，复用
原 request ID。monitor 自身单实例锁仍严格互斥；锁内 I/O、权限、绑定和身份异常仍停止。
该处理不会自动删除已有 `monitor-stop.json`，也不会恢复已停机的旧验收。

领取后崩溃不会自动重做；claim 不是执行成功。结果 pin/结构检查也不证明科学进展或业务
验收，仍须审查实际增量，遵守原 no-progress 止损。wait 使用真正依赖及有界原生等待；
blocked/complete 不自发续跑。任务完成按原生结算/归档/台账流程收尾。

### 回合结束检查（新增，需匹配 Server）

Run 唤醒后不是只 check：重验 Worker/Dispatch 原生状态，处理完整 Delivery，保存证据，
continuation 先 claim、执行、settle，再 ack 整批的 deliveryId。不自动 ack 未完成或不确定动作。
更新领域 checkpoint 后，结束 post-gate 模型回合之前调用：

```text
python3 -B /absolute/swarm/coordinator_tui_continue.py turn-end \
  --config /absolute/continue.json --config-sha256 <sha256>
```

它复用当前 head/直接领域 pin/outbox 与原生 `check --run <id> --peek`，不消费 mailbox，
不创建锁/outbox、不 ack、不发提醒。Server peek 新增可选 `hasOutstandingDelivery`；
旧 Server 缺字段时返回 `tui_turn_end_mailbox_state_unavailable`，不假定 inbox 为空。
该字段来自原生 outstanding-delivery 视图，保留原有防重抑制，不改变 Delivery 生命周期。

`turn_end()` 的只读审计共用 60 秒单调时钟预算，涵盖初始/最终身份检查、mailbox、
readiness、嵌套 TUI 观察和 bootstrap owner 查询。每次 I/O 使用原调用上限与剩余预算的
较小值；嵌套检查不续期，也不延长 gate、context 或任务期限。CLI、workflow 内部审计
和跨 runtime 审计使用同一入口；不把整个有写入的 workflow 包成只读预算。

阶段开始/结束/失败以脱敏 JSON 行即时输出到 stderr（`observation_stage`），stdout
保留最终 JSON。诊断只含固定阶段名和时间，不输出命令参数、路径、原生回复或凭据。
预算耗尽或审计内 I/O 超时返回 `tui_turn_end_observation_timeout`，附 `stage`、
`timeout_kind`、`elapsed_seconds`、`budget_seconds`；CLI 返回非零退出码。
这表示**合法结束审计未完成**，不是回合已经结束，也不推翻之前已确认的提交、ACK 或释放。
保留原回执并核查阻塞阶段；不得据此重放业务或 ACK。需再次审计时仍须具备原身份、
原 pins 和当前合法 checkpoint，不自动重试或跳过最后一次身份/head/journal 复查。
非只读 owner RPC 仍按未知结果语义处理（原先那个拒绝码由 `bootstrap_tool.py` 抛出，已随旧握手删除）：
不能仅凭该错误判断失败或重试同一 mutation，owner 仍可能完成已接纳工作。

预算对文件读取是合作式检查，日志读取在分段边界检查；不能强行取消阻塞中的文件系统
调用，stderr 写入及子进程回收也不是硬实时保证。因此不承诺命令在所有操作系统故障下
严格 60 秒退出；阶段日志可定位未返回的读取。此预算不改变监控/业务状态，不生成成功回执。
共享预算模块属于部署源码依赖，会进入 `operator_monitor_deploy.sources()` 的 pins；
修复须在经审查的新源码基线上部署，不静默重签旧 deployment 或历史 Run。

schema v2 还检查 `context_observed_at <= source.observed_at <= now`，且 source 不早于成功
首派 gate。旧回合 checkpoint 返回 `tui_checkpoint_not_from_current_turn`，缺时间戳或早于
gate 也拒绝。该检查覆盖 continue/wait/blocked/complete；它不生成或认证业务事实。
普通 `check` 仍仅检查身份、绑定、时效及可选动作窗口，不代表 head 可以用于结束当前回合；
尤其 claim/settle 必须能处理上一回合已入队的合法 action，不能把它们误当成本回合待发布 head。
通过 `turn-end` 后仍需真实结束回合，scheduler 独立保留完整的 completed-turn 区间检查。

schema v2 的 turn-end 和 scheduler 共用下一动作防重检查：上一动作已 settle/ACK 后，
新 checkpoint 的 `next_action.id` 不能复用 journal 中任意已用 ID，否则返回
`tui_scheduler_checkpoint_not_advanced`。只刷新时间、source/receipt hash 不算推进；
须由原 Coordinator 根据真实结果声明下一项获授权工作及未用 ID，或有证据的终止决策，
不能仅重命名已完成工作规避无进展门。turn-end 会在模型结束前只读拒绝，使其有机会在
同一回合修正；漏调用时 scheduler 仍独立拒绝。此修复不解除已有 monitor stop、不改旧
deployment pin，也不提供恢复、业务授权或语义进展证明。

schema v2 还与 scheduler 复用 `validate_scheduler_progress`：连续 3 个已 settle 动作没有
首次新增的 `met` 时，`turn-end` 在回合结束前返回 `ok:false`、非零退出码、原因、计数/上限
和 checkpoint 引用；不写 stop、不创建 journal 或锁。尚未持久停止时，只能由真实领域证据
支持的新 source/receipt/projection 修正验收状态，原子推进 head；不自动补 `met`。
漏调用该检查时，scheduler 在真实回合结束后仍独立检查并持久停止。

检查读取原 config 绑定的 `scheduler.json`，已有 stop 返回 `scheduler_review_required`，
同时保留原停止 checkpoint/原因和 `scheduler_stop_persisted:true`；即使新 checkpoint 的
计数归零，也不能报告将继续调度。末尾复查 journal/head/outbox 和真实上下文是否变化。
正常 complete/blocked 首次仍交给 scheduler 转独立审查，不改其路由优先级。
`scheduler_state_scope` 明确只覆盖 continuation journal；该 config 不包含独立 monitor
状态根，因此不证明外层 `monitor-stop.json` 已解除或 monitor 正在运行。普通 `check`
也不等于调度就绪。任何既有停止门均不能通过换配置、重启或新 checkpoint 清除。

有 outstanding Delivery、claim 未 settle，均拒绝结束检查；schema v1 的 continue 未留下
当前回合入队且仍在原生 inbox 的唤醒也拒绝。下一真实回合仍留下同一未领取 continuation 也拒绝，不能反复
把它当“已经安排好下一轮”。没有任何自动重发/自唤醒计数器；失败需处理或明确报告执行障碍。
blocked/complete 仍须领域审查；wait 的声明本身不能证明实际依赖唤醒已登记。schema v1
会报 `tui_dependency_wakeup_requires_native_verification`，由已有原生等待协议另行核验；
schema v2 由 scheduler 在真实回合结束后独立核验固定依赖。
此检查是一次观测，不锁住未来消息到达，也不是强制的模型 turn-end hook。

需要减少逐项拼接和遗漏时，可显式使用 `coordinator_tui_workflow.py begin/finish`，复用此处的
claim/settle、整批 Delivery ACK、checkpoint/进度检查与 turn-end。详见
[回合封装与同 Run 恢复](operator-monitor-recovery.md#原-coordinator-的回合封装)。
该封装不执行业务、不自动验收；恢复引用不能代替原 Coordinator 实时 caller 身份。

新建 schema v2 scheduler 配置可显式设置 `"turn_protocol": "workflow-v2"`，改用
`begin → 业务处理 → submit`。程序接受提交后先保存不可变回执，再单独报告 turn-end 审计；
模型结束回答或仅 settle 不构成完整提交。未设置该字段的配置保留原语义，不自动迁移。
此 opt-in 暂不支持旧格式的同 Run／跨 runtime 恢复包；详见
[提交接口、恢复边界与启用方式](coordinator-submission.md)。

只影响新生成的 TUI 提示和显式调用 helper；不改旧 plan/contract/gate hash。旧计划如需升级，
须重新生成并审查，不静默替换既有会话约束。离线回归不代表真实三回合/Worker 唤醒验收通过。

## 验收与边界

新测试计划以 [Swarm 测试与验收指南](docs/testing/reliability.md)为统一标准，分层记录证据与
独立审查结论；已有 Run 仍按其原归档的协议 pin 续验。下文列出覆盖范围及安全边界，
不是当前版本的通过凭据。


离线覆盖：旧 exec 兼容、TUI 参数及 prompt pin、精确 hook→caller→log、跨三轮
session 连续性、connected shell 拒绝、token/PTY/session/history/config 变化拒绝、
启动门分流、重复 enqueue/claim、未知 send 只对账、过期/换 owner/generation、
无结果不推进、旧 checkpoint 不执行、两动作领取/结算。mock 不证明真实 PTY 行为。

完整真实验收仍至少需要以下项目；环境选择须遵循该次用户授权：

1. 真 TUI 三轮中 strict fingerprint、providerSession 和进程 incarnation 不变；实际日志设置通过观察器。
2. 忙时发两条消息，证实不写 shell、不重复执行；idle 后 mailbox 消费/动作回执完整。
3. 原生 Worker 完成及外部事实消息能唤醒同一 Coordinator；动作结算与下轮 checkpoint 有证据。
4. Agent 退出而 PTY 存活、identity/session 变化时拒绝写入；消息保留且不 launch/resume。
5. 发送结果不明、重复消息、迟到消息和领取后中断均不重复提交业务副作用。
6. 真正业务验收、资源结算和 Token/耗时覆盖分别审计；服务存活/离线测试不等于 Mac 离线自治。

已退出的 strict-v1 Run 仍无安全 rebind/adoption/crash recovery；本升级不能修复旧 Run
身份、补造 owner、降级策略或新建竞争 Run。不得因此重启服务/数据库或重复训练。

## 授权生成链（显式版本）

新任务可在 schema2 continuation 中固定 `authority_binding.protocol=generated-authority-v1`，
与 `turn_protocol=workflow-v2` 独立。使用正式 helper 生成 handoff，再运行 schema2 授权进度
检查；prepare 同时接收 generation binding 和进度 `completion` pin。每个后续 checkpoint
使用 `rsi-authorized-progress-v2` 与对应 completion，不能仅提供旧 receipt 或改回 v1。
共享运行时校验会核验生成链、精确 handoff 字节，以及 Run/scope/authority/context/验收合同/
checkpoint 的绑定。旧配置不自动升级。完整输入及中断对账规则见
[Operator 准备接口](operator-prepare.md#新生成链从-ledger-到已检查-handoff)。
