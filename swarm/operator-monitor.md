# 原生 strict Run 的常驻 Operator monitor / TUI scheduler

`operator_monitor.py` 补齐不依赖交互式回合、旧式 shell-resume driver 的观察与回传循环。
它复用 `progress_watch.collect` 的完整 Worker 分页/Task 清单、`coordinator_operator` 的
固定 Python 适配器和响应校验，以及 `coordinator_io` 的原子持久化与单写入锁。
`progress_watch.py` 本身仍是只读工具；旧 driver 对 strict Run 的拒绝没有放宽。

有 continuation 的 monitor 及部署校验、启动交接、恢复入口，统一沿
`continuation → contract → cli:{path,sha256}` 选择原生 CLI，不要求 Shell export 或修改 `.bashrc`。
每次原生调用校验固定文件 hash、可执行权限和 runtime；若存在 `ORCA_SERVER_CLI`（含空值），
必须与契约路径精确一致，否则明确拒绝。CLI 不写入全局环境，不回退 PATH/旧 relay。
无 continuation 的历史 monitor 仍使用原显式环境变量入口；既有部署源码 pins、Run 和回执不自动迁移。

schema v2 可选启用 strict TUI 自动调度：真实模型回合结束后，由 Python 循环读取并校验
checkpoint，自动通过原生 Run mailbox 排续跑，不再依赖模型调用 enqueue/turn-end。
业务决策仍来自 Coordinator 的领域 checkpoint；调度器不替模型决定任务。

这是**本地代码和离线测试，不是部署回执**。没有改变现有 Run、启动服务或执行平台操作。
配置维护不授权部署；启动前仍须按目标 runtime 的技能、真实连接/身份和任务授权核验。

## 循环与边界

- 周期性采集 `run-show/worker-list/task-list`，核验固定 runtime、strict policy、Run owner、
  generation、Coordinator terminal incarnation、workspace 和连接状态。每次回传前再核验。
- 查询 watch list 中全部精确 Job；新登记项在下次轮询加入，历史项不会因清单遗漏而消失。
  只发 `query`，包括 Job 已终止之后的迟到证据；不会 `probe/execute`、取消或释放 Job。
- 观察声明范围内的精确 artifact/checkpoint/ledger 路径。不存在、出现、大小/mtime 改变均为事实；
  不读大 checkpoint 内容，也不把文件存在当作 loadability/评测通过。大目录请登记其 manifest
  或完成标记文件，不递归扫描目录。
- 状态或证据发生变化时，先写不可变事件及持久 outbox，再发 `status` 到同一 `run:<id>`。
  即使 Job 状态仍是 running，新 checkpoint/证据也产生事件；相同快照不重复发消息。
  静默超过 `idle_seconds` 只上报一次超时事实，有新进展时清除；静默不会退出循环。
- `status.json` 每轮更新心跳；`state.json` 保存登记项、事件和投递状态。全部是私有证据，
  启动者应保证原 Coordinator 可按已授权路径读取事件文件。未同步到该文件系统的客户端
  不能只凭消息中的路径获得证据。
- `inbox` 只读检查自己所发消息的原生 read 标记，**从不调用 `check/ack/reply`**。
  入队、原生读取和业务处理分开记录；`business_processed` 始终为 unknown，业务验收
  由 Coordinator 在自己的控制循环中完成。历史窗口内找不到回执不等于已读取，也不重发。

Operator 是 submit + monitor 角色，不是第二个业务 Coordinator。本入口实现
monitor + 事实回传，以及下方显式启用的同会话调度；[已有提交器](coordinator-operator.md)继续处理其已支持的明确委托，
保留授权、预算、持久提交意图和同键对账规则。它仍依赖旧 driver，**不能用来对 strict
Run 自动提交**。本补丁不新增 strict 平台提交授权协议或经过核验的 Merlin 适配器；
strict Run 的平台操作仍需原 Coordinator 的明确委托和独立核验的执行通路。
watch list、文件变化和 Worker 完成都不授予提交、派 Worker 或业务 complete 权限。

终端连接/PTY incarnation 核验不是模型进程仍存活的证明；没有原生进程证明时不能宣布
Coordinator 已恢复，更不能启动替代者。这个同账号协作协议不是对恶意进程的安全沙箱。

## 配置与启动

复制[默认关闭的示例](operator-monitor.example.json)，独立核验并填写真实绑定，创建专用的
现存 0700 `state_root`。全部路径为绝对规范路径，不允许符号链接；状态目录与 artifact
范围必须互不包含。`operator_id` 是 `operator-monitor:` 开头的审计标签，不是 Coordinator
或 Worker 的 handle，不能传给 `send --from` 冒充原生身份。schema v2 的 `sender`
固定独立 Operator **shell** 的 `terminal/incarnation/workspace`；启动命令必须实际运行在
该 Orca 终端，继承它自己的 `ORCA_TERMINAL_HANDLE/ORCA_PANE_KEY`。每次投递前核验
终端、pane、连接及非 Agent 状态；发送不带 `--from`，回执必须匹配自己的真实 handle。
不复制 Coordinator 身份或清除其身份变量绕过检查。schema v1 仍可离线读/校验，
但因缺少合法发送者绑定而拒绝执行；不自动改写历史配置/状态。
配置固定后计算原始字节 SHA256；一个目录只允许一个配置和一个进程。

默认仅校验文件，不查询、不发送、不创建运行状态：

```bash
python3 -B operator_monitor.py --config /absolute/private/monitor.json \
  --config-sha256 REVIEWED_CONFIG_SHA256
```

已获部署授权、读取必需角色技能并完成核验后，才启用 `enabled:true`，重新固定 hash 并执行：

```bash
python3 -B operator_monitor.py --config /absolute/private/monitor.json \
  --config-sha256 REVIEWED_CONFIG_SHA256 --execute --confirm-skill-read
```

不带 `--once` 就常驻；带该参数只做一轮。每次 RPC 有超时，轮询间隔 1–60 秒；整轮耗时
随 Job 数及 Worker 页数增长。SIGTERM/SIGINT 在当前轮结束后退出，轮间等待可即时中断。
monitor 的 CLI／查询适配器子进程使用独立信号会话，避免前台 Ctrl-C 截断响应；当前轮仍按
原有单次调用超时完成查询、发送回执落盘及退出记录，不提高超时、不忽略真实错误，也不启动
下一轮。重启复用原状态。当前应在已核验的独立 Orca Operator shell 中运行这个**同一前台命令**，
不需要 Operator 模型。不是无身份 runit/systemd 服务：普通服务环境没有原生发送者；
也不支持 PTY/Server 丢失后的身份恢复。客户端离线时终端是否存活、邮箱是否唤醒仍须实测。
本补丁不创建该终端、不部署服务；这些操作需要另行授权。

`STOP` 或 `monitor-stop.json` 是持久停止门。一般权限/原生查询失败、身份变化、协议异常
会落停止证据，不重启 Agent、不切 runtime、不自动清除。服务管理器的自动重启不能解除门。
停止不取消既有 Job；配置修订或恢复须先保全证据并独立对账，不能删除状态来绕过防重。

具名例外仅为原 owner 签名且精确识别的只读身份复核 pending，以及原 Operator 输入待审：
原循环写 `revalidation_pending`，暂停发送/新准入，最多连续复核 3 次；耗尽返回 3，
不写新的持久 STOP，不自动重启/清 STOP。已有未知发送不能进入重试。详见
[运行期准入和输入边界](operator-startup.md#运行期输入与暂时性复核)；普通错误和 mutation
unknown 不能伪装成 pending。

发送前固定 UUID 并传给原生 `--retry-request`，要求返回匹配的持久 mutation 回执。
若进程在发送后、保存回执前崩溃，重启只用 `request-show` 读取该 UUID 的 completed 回执；
pending/absent/错配均停止等待对账，**不自动重发**。absent 可能是回执已被清理，不证明未发送。
原生错误触发停止门的情况仍需人工核验，不因重启而恢复。此行为不是平台 exactly-once 保证。

## 显式开启 strict TUI 自动调度

测试统一按 [Swarm 测试与验收指南](docs/testing/reliability.md)分层：自动续跑与同 sender/state
重启在自主 live 组验证，发送竞争、ACK 长历史和等待边界做原生集成；原生唤醒另设观察型组。
离线回归不代替原生/Agent 证据；已有 Run 仍按其原归档的协议 pin 续验。

### 确定性部署入口

新注册 strict bootstrap attempt 必须通过 schema v2
[Operator 启动生命周期](operator-startup.md) 串联角色交接、发布观察、部署执行和 readiness。
它显式调用本节原部署入口；`prepare` 仍不启动。
旧 continuation 不自动加入新流程。`verify` 新增 `scheduler_readiness`，部署观测成功不代表
内部 scheduler 可以自主等待，也不代表真实两轮续跑验收通过。

新生命周期显式选择 autonomous/native-event/manual，mode 与 lifecycle pin 同时传入本节
入口。后两者只观察，scheduler 为 `observation_only`，排队 outbox 及实际发送入口同样禁发；
隔离窗口结束不自动开送。autonomous 发送仍重验原 owner 当前健康、STOP 与原有防重规则。
native-event 指定触发源预检缺失/过期时可有 monitor 首 tick，但没有 runtime_ready。
历史 owner confirmed 和心跳不替代当前准入，原 owner 期限及身份限制也没有自动延长。

`operator_monitor_deploy.py` 复用原 `Config`、原生身份 fence、单写入锁及同一个 `run/tick`
循环，不另写 scheduler。它把“准备完成”和“运行中”分开，避免只创建 shell 就误报部署。
仅适用于本机 Linux Server；不是远程进程证明或 PTY/Server 崩溃后的恢复机制。

先由真实 Coordinator/Operator 完成原启动门，产生合法的 schema2 continuation、领域
checkpoint 和 head，绑定已核验的独立非 Agent sender shell。helper 不生成门禁回执、
不替模型编写业务 checkpoint、不创建或恢复 Run。新部署准备两个**不同的空0700目录**：

```bash
python3 -B operator_monitor_deploy.py prepare \
  --continuation /absolute/continuation.json --continuation-sha256 REVIEWED_SHA256 \
  --state-root /absolute/monitor-state --output-dir /absolute/deployment
```

输出 `prepared_not_started`、不可变 plan pin 和 `native_sender_command`。它从 continuation
推导全部绑定，生成 scheduler-only 配置（poll3秒、RPC20秒），复用加载器校验后原子发布，
固定本目录全部 Python 源码及解释器路径；不覆盖已有配置/状态。Job watch adapter 的复杂
配置继续使用原入口，此薄封装不自动迁移已运行的 monitor。

在该 sender 的原生 shell 内执行输出的**同一前台命令**。不能把 shell/Agent 创建回执
当作启动成功；不能复制 ORCA 身份环境。正常停止后在**同一 shell**重启相同命令，
沿用原 config、continuation、锁、outbox 和防重状态，不再运行 prepare、不清除 stop。

```bash
python3 -B operator_monitor_deploy.py check --plan /absolute/deployment/deployment.json \
  --plan-sha256 REVIEWED_PLAN_SHA256
python3 -B operator_monitor_deploy.py verify --plan /absolute/deployment/deployment.json \
  --plan-sha256 REVIEWED_PLAN_SHA256
```

`prepare` 会在配置发布前和 deployment 最终发布前只读查询原生 sender：精确 handle、
incarnation、workspace、connected/non-orphaned、非空 tab/leaf；按 1.4.219 可选字段契约接受
省略或 null 的 `agentIdentity`，任何实际 Agent 身份均拒绝。此观察不证明调用者身份；
字段省略仅表示原生未报告已识别 Agent，不单独证明它是 shell；
`run` 仍须从 sender 自身继承的上下文复查。

`check` 只校验本地固定输入，没有原生调用。`run` 必须有 `--execute --confirm-skill-read`；
`--once` 仅做单轮诊断，结束后状态是 exited，不能当作常驻成功。锁内保存不可变
`launch-*.json` 和当前 `deployment-status.json`；只有原 monitor 完成首轮 tick 才标
monitoring。新 `prepare` 默认固定 schema2 `native-runtime` 模式：`run` 在自身原生 shell
内核验并保存继承的 sender/pane 绑定；`verify` 只读核验当前 Orca Run/终端、120秒内心跳、
持有中的原锁、config/source pins，并前后复核状态未变化。此模式不读取 `/proc`，不复制
身份到检查者环境，返回 `monitor_runtime_observed`、`runtime-state-not-process-attested`
和 `process_attested:false`；锁与心跳不是宿主进程身份或进程存活证明。
同账号协作信任边界不变；停止/身份变化拒绝规则不变，不以心跳推断可重启。

新 lifecycle runtime policy 下，launch receipt 还包含 `acceptance`，在首 tick 之前固定
精确 Run/generation、lifecycle、continuation、deployment、sender、runtime/execution 和
原 owner，仅接收观察及获准调度责任。verify 比较该字段和原不可变 launch receipt，
接收不是 ready，也不接管业务/独立审查。尚未接收即 pending/拒绝时没有 launch receipt；
生命周期保存已知退出码，不能据无 receipt 盲目重启。

显式 `prepare --verification-mode host-process` 保留 schema1 的旧证明路径（不得在
用户禁止 `/proc` 时使用）：`verify` 核验 Linux boot ID/PID/start ticks、exe、argv摘要、
120秒内心跳、config/source pins，以及从该进程 `/proc` 读出的原生 sender/pane 绑定；
不导出原始环境、不采用检查者身份。随后重新查询 Run 和终端，并复核进程未被替换。
身份/权限/进程不明严格拒绝；心跳过期不意味着进程退出，也不允许自动重启。
tick 正在发布状态时可能返回 `monitor_deployment_tick_in_progress`，稍后只读复查即可。

`monitor_active` 仅证明代码正在运行，正常 busy 可表现为 awaiting_real_turn_end；
interaction_required、review_required 等 scheduler 子状态仍需如实报告。
它不证明两轮 continuation、Worker-only 唤醒或业务验收通过。部署回归见
`tests/operators/test_operator_monitor_deploy.py`；native fixture 仍与真实实机证据分开。

### 首 tick 前的 sender 绑定修正

`operator_sender_correct.py` 是显式恢复入口，不改变正常配置的不可变规则。仅支持 schema2
native-runtime 部署已退出、`first_tick_at/status=null`，且两处状态只有原锁、绑定与部署失败
快照的情形。任何 STOP、launch、outbox、claim、运行状态或未知文件均拒绝；不用于已运行
monitor、更换 Coordinator、延长时限或解除熔断。

1. `prepare --plan PATH --plan-sha256 SHA --sender PATH --sender-sha256 SHA --output-dir DIR`
   接收固定的新 sender 三字段 JSON 和空0700输出目录。持有原 monitor/continuation 两把锁，
   快照旧绑定与失败状态；生成仅修改 sender/scheduler 和引用的新配置、当前源码 pin 及 proposal。
   不替换旧绑定、不启动 monitor，旧源码计划只用于核对原状，不视为可执行计划。
2. 独立 Agent 审查确切 proposal 及证据，提供 schema1 review：`proposal` path/sha256、
   `approved:true`、`reviewer` terminal/incarnation/workspace、非空 `evidence` 引用数组及 `reason`。
   reviewer 必须区别于 Coordinator 和 sender；这是外层审查声明，不是作者认证或执行授权。
3. `apply --proposal PATH --proposal-sha256 SHA --review PATH --review-sha256 SHA --execute`
   重新核验原失败快照、当前状态、源码、checkpoint 和原生身份。在两把原锁内先发布两处
   correction marker，再原子替换两个绑定，最后发布 `committed.json`。中途崩溃时相关新配置
   不可运行；使用相同 proposal/review 可继续提交。不同审查、未知状态或内容漂移拒绝。

旧配置在 marker 发布后拒绝运行；新配置须完整提交才通过，提交后重复 apply 只核验回执。
失败快照、旧配置、原状态目录及锁 inode 全部保留。不得手改绑定、删 marker/STOP 或用新
目录规避该协议。启动前仍要在同一 Coordinator 新回合刷新合法 checkpoint，再从新 sender
自身上下文执行 deployment 命令；手工恢复回合不属于自动 scheduler 验收。

使用独立的、尚未绑定的 continuation 状态目录。continuation 配置保留全部原字段，
改为 `schema_version:2` 并增加 `scheduler`，其内容精确等于 monitor 的 `sender`。
先审查固定 continuation 文件的原始字节 hash，再将 monitor 的 `continuation:null`
替换为该文件的 `{path,sha256}` pin，最后固定 monitor hash。不能改写已使用配置或
通过新目录清除既有动作/回执；既有 Run 的迁移需要独立对账，不属于自动升级。

```text
monitor 的 while 循环
  → 原生 tui-idle + 同会话日志 task_started/turn_context/task_complete
  → 领域 checkpoint、授权检查回执及真实回合时间绑定
  → 路由 continue / wait / review
  → 共用 continuation outbox → Operator 身份 send → Orca 原生唤醒
  → Coordinator 在新回合 check → claim → action → settle → ACK → 新 checkpoint
```

- `continue/coordinator`：无需模型 enqueue，自动安排该动作；模型主动 enqueue 被拒绝。
- `wait/coordinator`：复用 RSI 已有 `next_action.prerequisites`，在领域 source 和检查回执中
  固定 `"orca-dispatch:精确 Dispatch ID"` / `"orca-job:精确 operation key"` 引用（至少一个）。
  不向 RSI 增加 `dependencies` 字段；历史 dependencies 对象只读兼容，不能混用两种编码、
  修改旧 source 或虚构未来 Dispatch。只比较这些依赖，
  不因无关 Task/文件变化唤醒；依赖已完成/失败也会唤醒，避免首次采样遗漏。Job 必须先登记
  到已有 query-only watch list。唤醒动作是重新检查等待条件，仍须 claim/settle。
- `complete/blocked/outer-operator/unsupported`：持久停止调度并转独立验收/阻碍/执行者审查，
  不宣布任务成功、不代为执行 Operator 动作。
- source 的真实 `observed_at` 必须落在已完成回合的 context 和 completion 之间；缺失、
  错误、旧 checkpoint 或同一完成回合改换 head 均停止。模型仍必须生成合法 checkpoint，
  外层循环不会猜业务状态。每个 checkpoint、source、receipt、result 均为不可变文件；仅 head
  是原子更新的 pin 指针，不能覆盖历史文件。
- 历史观察重用 startup anchor、文件 inode/前缀、native hook 映射和模型配置校验。历史
  context 可超过 900 秒，但仅用于证明回合结束；hook 仍有 24 小时观察上限。**不延长业务
  context 或 180 秒首派门禁**：新回合 claim、执行和首派仍用各自原有检查。
- 发出一次后等待处理，不循环催促。同一动作和完成回合持久防重；未结算 claim、处理后不推进
  checkpoint、重复使用全部旧执行证据、未知发送结果均停止，不通过重启复位。新的内容 hash
  不是语义进展/业务通过证明，仍需要领域审查。连续 3 个已 settle 动作没有首次新增的
  `met` 验收项，持久转 `review_required / tui_scheduler_no_acceptance_progress`；改 action 名、
  新 hash 或重复声明同一 `met` 不复位。计数从固定 outbox checkpoint 重建，等待/tick 不计数。
  这是保守的声明级止损，不是语义验收，可能暂停合法多步任务；重启不会解除审查门。
  若 continuation 有显式 deadline，严格
  沿用；新 schema2 可用 `deadline:null` 取消整轮倒计时，按验收结果收尾，不豁免单步
  超时、上下文有效期、原预算或无进展/故障止损。不得改写已绑定配置或重置状态延期。
- scheduler 模式不再投递通用变化/idle 消息，避免两个生产者互相唤醒；原生外部消息和
  Worker 完成消息仍由 Orca 唤醒。只读 `inbox --pending --terminal run:<id>` 在数据库中
  先筛选未 ACK 的 current-delivery 消息，再取 `inbox_limit` 条；已投递但未 ACK 的批次
  仍包含在内。非空就等待原生处理，空才允许续跑；ACK 历史数量不再影响判断。不会代
  Coordinator `check/ACK`，不改写历史。CLI/Server 必须支持该参数和 filter 回执；缺少
  筛选能力或 scope 错配明确停止，不能降级成旧版截断历史查询。
- 发送前再次检查 owner/退休、Operator 身份、完成回合和 head。Python 观察与原生 send
  不是跨系统原子事务；最后瞬间到来的外部消息可能和 continuation 同批交付，Coordinator
  仍必须用原生 caller、新回合校验、claim 防重和整批 ACK 处理。发送成功不证明业务执行。
- 发送前发现同会话新回合、busy、head 改变或新邮件时，返回 `reobserving`，下轮重新观察，
  不写 `monitor-stop.json`。只对严格 `attempted:false` 且无 delivery/claim/result 的意图，
  先原子发布 `cancelled-<request-hash>.json` 审计记录，再从活跃 outbox 移除；不算动作完成。
  重启也先回收这样的未发送意图，归档后、移除前崩溃可幂等恢复。已经 attempted 的条目绝不
  撤销或重发，仍走原回执对账；会话身份变化、读取/发送错误仍为严格停止。

其中 pending-only 收件箱修复需要同步更新 Swarm、原生 CLI 和所属 Server；仅更新 Python 不足。
本地修复不会自动清除旧版本遗留的 `monitor-stop.json`。恢复前须保全旧停止记录和 outbox，
核验是否曾 attempted、真实回执及当前身份，再单独批准恢复；不得删除整个状态目录。
部署计划固定 Python 源文件 hash；代码修复后旧计划会报 `monitor_deployment_source_changed`。
不得覆盖旧计划或停止证据以继续运行，须在获准恢复时重新审查源码 pin 与同一 sender/state 的恢复链。

`operator_monitor_upgrade.py` 为已运行后干净退出的 schema2/native-runtime monitor
提供**仅源码计划升级**：复用配置、sender、Python 和两个状态根，不迁移或清除历史。
`prepare --plan <旧计划> --plan-sha256 <旧pin> --output-dir <新私有空目录>`
持原有双锁检查 exited/first-tick、状态和 head pins、完整 settled outbox；遇到 STOP、
monitor-stop、scheduler 审查停止、未结算动作或漂移拒绝。只发布 proposal，不生成可执行计划。

独立外层 Reviewer 审查固定 proposal、源码变更和原状态后提供 JSON：
`schema_version:1, proposal:{path,sha256}, approved:true,
reviewer:{terminal,incarnation,workspace}, evidence:[{path,sha256}], reason:...`。
`apply --proposal <文件> --proposal-sha256 <pin> --review <文件> --review-sha256 <pin> --execute`
重新核验身份、双锁、状态及源码，先发布 reviewed 回执，最后发布 deployment.json。
重复 apply 不启动或重放；发布中断可继续同一提案，审查后漂移必须重新审查。
旧计划、原状态不改；随后仍须在原 sender 启动并独立 verify。此入口不解除无进展门，
不自动恢复 Agent，不替代 caller 核验；审查 JSON 是协作声明，并非密码学身份认证或执行授权。
测试 `tests/operators/test_operator_monitor_upgrade.py` 为离线故障注入，不代表真实恢复验收。

对于已停机且唯一续跑消息已送达、尚未 claim 的已知回合遗漏，另见
[经独立审查的同 Run 恢复](operator-monitor-recovery.md)。它复用已有检查，保留旧 STOP，
在原 Coordinator 完成整批处理/ACK/新 checkpoint 后才发布恢复计划；不放宽 source-only
upgrade 的干净退出要求，也不自动启动 monitor。schema3 仅是该显式恢复入口的部署计划版本。

### 原生 `tui-idle` 等待边界

`terminal_idle_wait.py` 只解析 monitor 的固定命令：显式 terminal、`--for tui-idle`、
`--timeout-ms 1000`，不全局放宽退出码 1，也不吞掉一般查询错误。先核验 JSON envelope
及 runtime；结构化 wait 还须匹配 handle、condition、字段类型和 running 状态。

| 回执 | scheduler 行为 |
| --- | --- |
| `ok:true / satisfied:true / exit 0` | 继续读取并核验同会话真实 `task_complete`；仅 idle 不够 |
| `ok:false / error.code:timeout / exit 1` | 未取得 idle 证据；首次检查等待，后两次检查重新观察，不发送、不写持久 stop |
| `ok:true / satisfied:false / exit 1`，已知交互阻塞原因 | `interaction_required`，保留原生 reason 和检查 phase；暂停发送，继续只读轮询，不代为确认 |
| transport `runtime_timeout`、子进程 deadline、断连、非法响应或绑定不匹配 | 严格停止；不视作普通 busy |

首次观察、二次复核和发送前复核都走同一解析层，phase 分别为 `initial`、`recheck`、
`pre_send`。等待返回后再次 fence Run owner/generation/退休状态及两个终端的 incarnation，
因此没有 handle 的 timeout envelope 不会遮蔽等待期间的身份改变。发送前遇到可恢复等待
沿用未发送 intent 的安全归档；`attempted:true` 的未知发送仍只对账，不撤销、不重发。
交互阻塞解除后必须重新完成全套检查，不因为上一轮曾 idle 或人工提示消失就直接发送。

scheduler 配置的 `rpc_timeout_seconds` 必须至少 **12 秒**：原生等待 1 秒，CLI 为 RPC
附加 5 秒，再留 6 秒启动/连接/返回余量。过短配置在输入校验阶段拒绝，不生成持久 stop；
实际外层超时仍是故障。没有 continuation 的观察模式不新增此下限。
本次 wait adapter 是 Swarm Python 修复，不需改动原生 wait 协议；仍要求已部署支持
pending inbox 的 CLI/Server。重启不会自动清除旧 stop。

回归见 `tests/core/test_terminal_idle_wait.py` 与 `tests/core/test_terminal_idle_pipeline.py`：保存真实
timeout 回执，经过生产 `main → tick → scheduler → native → decoder` 重放，模拟底层
I/O 和完成日志证据，不替换 scheduler。覆盖三处等待、阻塞、身份竞争、未知发送对账、
重启防重及两轮 claim/settle/ACK；这不代替真实 Agent 的闭环与 Worker-only 唤醒验收。

`scheduler.json` 与 `outbox.json` 共用 continuation 锁，记录完成回合 pins、依赖基线、
审查停止原因和动作。monitor 状态目录另存心跳/采样及 `monitor-stop.json`。
schema v2 要求模型结束前调用 `turn-end`，但它不是 scheduler 必需触发器或强制结束钩子。
它复用相同进度检查，在连续 3 次未推进时提前只读拒绝并返回原因、计数和证据引用；
已有绑定 scheduler stop 也返回拒绝，不能以新 checkpoint 或重启解除。检查不创建或修改
任何调度状态，末尾复查 journal/head/outbox；漏调用时 scheduler 仍独立检查。
只有未触发门时才返回 `scheduler_will_check_real_turn_end`，且不证明可发送：真实回合完成、
实时身份、mailbox、依赖和发送前竞争仍由 scheduler 检查。该配置未绑定独立 monitor
状态根，`turn-end` 的停止观测范围仅是 continuation journal，不能证明 monitor 无故障。
离线测试见 `tests/coordinator/test_coordinator_tui_scheduler.py`、`tests/trae/test_trae_tui_completed_turn.py`。
实机仍需验收：独立 Operator 原生发送、漏调 enqueue/turn-end 的两次连续闭环、Worker
完成/外部消息空闲唤醒、重复 tick/重启防重、过期首派拒绝及客户端离线。


## 动态 watch list

`watch_file:null` 时只观察 Orca；也可固定一个现存 watch 文件路径，允许 Coordinator 在
已授权范围内用原子替换更新内容。顶层 schema 为：

```json
{
  "schema_version": 1,
  "binding": {"runtime":"…","run":"…","workspace":"…","terminal":"…","incarnation":"…","generation":1},
  "jobs": {
    "64_CHAR_OPERATION_KEY": {"adapter":"reviewed-platform","request":{"path":"/absolute/query.json","sha256":"RAW_SHA256"}}
  },
  "artifacts": ["/absolute/approved-artifacts/checkpoint.ready"]
}
```

`binding` 必须精确等于配置。`adapters` 在固定配置中登记已审查的 `{path,sha256}` Python
程序；watch 文件不能选择未登记代码。Job request 为不可变的已有 Operator JSON 请求，
`method` 必须是 query，`binding` 覆盖上述所有字段，operation_key 为该字典的 64 位十六进制
键，`job` 为精确非空平台 ID；保留平台适配器所需的原 action/authority/budget 等固定字段。
同一个 key 不能换请求或 adapter。尚不清楚 Job ID 的提交结果必须先走原提交端对账，不能
由 monitor 猜测 latest Job 或再提交一次。

响应复用提交器的 `operation_key/status/job/evidence` 契约。evidence 应只包含稳定、脱敏的
业务事实/产物版本，避免每轮无意义地加入查询时间导致消息洪泛。超时作为 unknown 回传且
后续继续只读查询；权限失败/畸形响应不能伪装成 unknown。适配器必须遵守 query 只读约定，
固定 Python 字节并不隔离它所调用的程序，也不认证外部依赖或业务权限。

验收至少检查：持续空闲、Worker/Job/artifact 变化、Coordinator 未读消息、提交回执丢失、
Operator 重启、身份变化停止和客户端离线。`tests/operators/test_operator_monitor.py` 覆盖离线协议；
真实运行时、平台和客户端离线验收仍须在另行授权的部署中完成。
