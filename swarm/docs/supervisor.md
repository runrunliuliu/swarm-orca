# 固定 DAG Supervisor MVP 操作手册

本页只适用于 `supervisor/` 的固定任务 DAG 和 Sidecar Watchdog。它不是 strict TUI 的
Operator monitor / scheduler，也不是独立 `goal-loop` driver；入口选择见 [Swarm README](../README.md)。

Coordinator 按已登记 DAG 派发实施、独立只读 Review 和串行 Integration；实施并发配置为
1–2，总并发和启动/时长/费用限制另行固定。不支持自动重规划、任务重试、模型升级或新 Coordinator 接管。
这些是本执行器的限制，不是原生自适应 Swarm 的通用上限。私有 SQLite 保存意图、回执、预算和证据索引，
Run / Task / Dispatch 生命周期仍以 Orca 为准；这不是代码执行沙箱或供应商计费硬上限。

主要实现：[配置校验](../supervisor/config.py)、[Coordinator 执行器](../supervisor/engine.py)、
[Watchdog](../supervisor/watchdog.py)。部署条件和实际验收须分别核实，不能从模板或离线测试推定。

## 离线配置检查

在本子模块根目录执行（不调用 Orca）：

```bash
python3 -m supervisor --config config.example.json validate
```

该示例应被拒绝，因为 ID、基线、角色和正整数限额等尚未填写；不是仅因 `enabled:false`。
普通 `validate` 允许其余字段合法的禁用配置；`validate --live` 额外检查 `enabled:true`、
六项 authorization 声明和持久路径限制，但两者都只做配置检查，不连接 Orca、不写运行状态。
即使输出 `live_authorized:true`，也只表示已按 live 模式校验声明，不能替代原始授权或真实身份核验。
行为见 [CLI 入口](../supervisor/__main__.py)。测试中的虚构 ID、金额和模型不是推荐配置。

## 配置与部署前置条件

从 [config.example.json](../config.example.json) 准备一个远端私有配置文件。逐项确认：

1. 专用 Git 试点仓库有真实非零基线 SHA；不得使用现有训练/巡检工作区。原生查询复制完整 repo/worktree ID，不能拼猜或混用桌面运行时 ID。
2. Coordinator、集成工作区、各 Worker 工作区没有其他写入者。exact 工作区必须干净、处于已批准分支与基线；程序检查仓库/工作区 ID、Git 根、基线对象存在与干净状态，但不替你批准 HEAD/分支、占用者或仓库 hooks。
3. 新工作区固定从配置的基线创建，使用 `--setup skip`；只适用于批准跳过 setup 的自包含试点。原生仓库的默认终端配置仍需人工审查，不能隐含启动有副作用的命令。需要 setup 的项目应先扩展策略和测试，不能临时绕开。
4. Supervisor、源码、配置、Orca profile、代码与产物全部在已确认的远端持久存储。独立模型/Git/数据源认证和网络不依赖 Mac 转发或续票，主机驻留及备份方案已确认。
5. 指定各角色 Agent；只有用户明确选择模型且配置校验支持该 Agent 的覆盖参数时才填写 `model`，否则保留 null，沿用该 Agent 默认配置；用户要求无法满足时停止，不静默忽略。`effort` 需显式 model。Worker 会核对回执中的 effective；初始 Coordinator 由操作者启动，实际模型需单独核验记录，本程序不替它选择或验证模型。
6. 填写 limits：`implementation_concurrency` 为 1–2，`max_task_retries`、`max_model_upgrades` 固定为 0，其余额度为正整数（费用单位为 micro-USD，1 USD = 1,000,000）；总并发不能小于实施并发，具体关系由配置校验检查。确认六个 authorization 项后才设 enabled=true。
7. 按 [启动与收尾保护](../startup-safety.md) 取得当前有效审批策略、执行工具和固定 CLI 入口的证据，并填写 `launch_contract` v2；Orca 默认使用当前沙箱及已有权限，不额外申请审批，`never` 本身不冲突。旧 v1 契约须重新核验，不静默迁移已登记配置。在任何真实启动前完成离线预检；`validate` 不代替此检查，合成值、Full Access 标签或历史启动成功均不是当前有效证据。

`state_dir` 与 `artifact_dir` 必须是互不包含的私有目录、绝对规范路径，无符号链接；live 模式拒绝临时目录。已有状态目录权限必须为 0700、数据库0600。此 Supervisor 适配器当前固定 Orca runtime 版本 1.4.219，运行时 ID/版本不匹配即停止原生操作，不回退至桌面 relay；这不是其他执行器的通用版本约束。

配置一旦首次使用（除 validate 外）会被登记并计时，之后同一 goal 的配置完全不可变；请在首次 `status/supervise/coordinator-init` 前定稿。不要先用 disabled 配置登记，再改 enabled 运行。所有 goal 共用服务状态目录，服务预算不能通过新配置/新 Run 清零；不要删除或更换状态目录规避限额。

## Trae：启动前自动登记精确工作目录

这是**逐工作区登记与审计**，不是“Trae 是否会被预信任”的开关。仅在角色的原生 Agent ID 为 `trae` 且 `trae_workspace_trust.enabled:true` 时执行本节流程；示例仍默认关闭，不影响其他 Agent 或已有配置。初始 Coordinator 由操作者启动，不在这个 Worker 启动钩子覆盖范围内。

Orca 自身也会在 fresh 启动前预写同一 `[projects."<path>"]` 条目（自包含该修复的 Orca 构建起，对所有启动来源生效，不再限于 orchestration），所以 `enabled:false` 不再意味着 Trae 会停在信任门。本节的显式登记仍是可审计的授权路径：它按已批准基线逐工作区写入、落盘回读并要求失败即停止，未登记的工作区不因原生预写而被视为已批准。真正的全局开关只有 `agentWorkspaceTrustEnabled:false`（或使用不含该预写的构建）。

在远端私有配置中填写该节的 `hostname`（远端 `hostname` 原样输出）、`username`（Worker Unix 账号）、`trae_home`（实际配置目录），并在确认下列条件后设置 `launch_context_confirmed:true` 和 `enabled:true`：

- 实际执行 Coordinator 命令的进程、Orca Server 和 Trae Worker 使用同一远端 Linux 主机/账号。Worker 启动环境的 `HOME`/`TRAE_HOME` 与登记进程一致；没有 launcher 内另设配置目录或配置覆盖。程序校验自身主机、有效 UID、账号 home 和配置目录，不能从本地 Mac 代办，也不能替操作者证明自定义 launcher 的环境。
- 信任已批准契约中的工作区内容：登记后 Trae 可以加载项目配置、hooks 和执行策略。Git 干净不代表内容安全；审核项目及仓库默认终端仍是部署前置条件。
- 登记期间没有其他 Trae 进程、编辑器或工具写入 `traecli.toml`。跨 Swarm goal 的登记使用同一非阻塞文件锁，但 Trae/编辑器不遵守该锁；不能把它当作通用并发事务锁。发现外部修改会停止，不覆盖已观察到的新内容。
- `trae_home` 已存在，目录和 Worker 工作区归该账号所有、无符号链接且不允许其他用户写入；已有 `traecli.toml` 必须为该账号所有的 0600 普通文件。配置目录及文件不会被自动 chmod。真实配置含凭据时不要复制到源码或日志。

每次 Trae Worker 派发前，控制器执行：

1. 新工作区先通过原生 `worktree create --no-parent --base-branch <已批准 SHA> --setup skip` 创建，不传 `--agent`；持久保存原生 intent/回执，使用返回的完整 ID，不猜路径。exact 工作区不另建副本。
2. 再核验当前 runtime、repo ID、工作区 ID/path、宿主 `local`（指独立 Server 本机）、本机规范路径、Git 根与干净状态；新建工作区额外核验 HEAD 等于批准基线。
3. 只向该账号的 `<trae_home>/traecli.toml` 追加如下精确条目，并解析候选 TOML、原子替换、落盘和回读。原文件字节（含注释、其他设置和 hooks 信任哈希）保留，不追加父目录或通配符。

   ```toml
   [projects."/absolute/exact/worker-workspace"]
   trust_level = "trusted"
   ```

4. 通过 `worker-start --worktree id:<原生完整 ID>` 启动新 Trae Worker。已登记 trusted 的目录不重写；登记失败则不启动。

已有明确不信任条目、已有项目表但未明确 trusted、无法无损追加的 TOML（例如 inline `projects` 表）、目录过宽、身份/权限/基线不符时均停止交由人工处理。不会把 `/`、home、配置目录或它们的祖先登记为可信。原生创建回执丢失不重试；已保存回执可用于同身份恢复，信任写入后进程崩溃可幂等回读。`workspace:<task>`、`trust:<task>` 与事件记录保留精确路径及结果，不记录配置正文。

由于创建与启动分离，原生创建可能留下 fallback shell 或仓库默认终端；本功能不自动关闭它们，也不把它们当作 Worker。信任失败时同样保留工作区供检查。是否收尾应按原生盘点另行确认。已持久登记的信任不会在 Worker 释放时自动撤销；停用该功能只停止后续登记，撤销需明确编辑对应精确项目条目，不能盲恢复旧整份配置覆盖新设置。

本功能不加 `--yolo` 或 `--dangerously-bypass-hook-trust`，不批准新/变更 hooks，不处理登录。它也不修复此前 smoke 中发现的 Trae TUI idle/提示投递问题；仍以原生 `ready` 和回执为准，失败不盲重发。格式依据 [Trae 配置文件说明](https://docs.trae.cn/cli_config-file)。

这条 Worker 自动登记链路须有自己的真实远端证据，不能用手动授信或 strict Operator 准备入口的成功代替。

## 授权后的启动顺序

以下 `CONFIG` 是已批准的远端配置绝对路径，命令在远端已安装源码根目录执行。配置路径通过参数传递，不包含密钥；初始 Agent 启动、模型选择和服务安装按当前技能及审批单独进行。

```bash
python3 -m supervisor --config CONFIG validate --live
```

该命令仍是上述离线配置检查；连接、版本、真实身份与授权来源需另行核验。

由操作者在独立 Server 的专用 Coordinator 工作区启动一个真实 Agent，并交付 [coordinator-prompt.md](../coordinator-prompt.md)。必须在它原生注入的身份上下文中执行：

```bash
python3 -m supervisor --config CONFIG coordinator-init
python3 -m supervisor --config CONFIG coordinator-step
python3 -m supervisor --config CONFIG coordinator-checkpoint
```

`coordinator-init` 只为这个新目标创建一次 Run，并保存 handle、PTY incarnation、consumer generation；初始 Coordinator 也占用一次预算预留。`step` 先对账、保全/清理已结算 Worker、处理完整 Delivery，再派发就绪任务。`checkpoint` 会检查最新 peek 和缓存 Delivery：除纯心跳外，消息必须已处理或已持久化为待人工问题；发现新消息/未处理消息时拒绝休眠，应继续 step/inbox 处理。`checkpoint` 成功后 Agent 必须结束回合，由下述 Supervisor 按事件续接；回合停驻不证明目标完成。

由独立服务上下文运行（不继承 Agent 身份、不依附 Mac SSH 会话）：

```bash
python3 -m supervisor --config CONFIG supervise
```

Supervisor 先取得单实例锁；Coordinator 持有短期状态锁时跳过 tick，不退出。原生任务/Worker/非心跳消息发生变化或操作员申请新回合时，核对 Run、PTY、TUI idle，再预留费用、发送一次续接提示并检查 `turn_started`。纯 heartbeat 消息和心跳时间戳不唤醒模型，但 liveness verdict、attention、任务及 Worker 状态变化仍会唤醒。启动不确定就暂停，不能因静默重发。等待/完成期间只轮询，不请求模型；不接收未授权新目标。

## 提问、证据与暂停

Agent 使用 `coordinator-inbox` 查看未信任原文、缓存的 Delivery 和已确认收取但仍待人工决定的问题（`untrusted_human_messages`）。审查证据/问题后，在私有路径编写 [decisions 示例](../examples/decisions.example.json)，再执行：

```bash
python3 -m supervisor --config CONFIG coordinator-step --decisions DECISIONS
python3 -m supervisor --config CONFIG coordinator-checkpoint
```

- Worker 必须按实际原生 preamble 提问/汇报；有效 worker_done 自动结算，禁止重复 task-update completed。
- 证据不是 Worker 自证：Coordinator 独立核验基线、提交、实际 diff、全部验收命令与结果、风险和脱敏文件 SHA256。程序只验证声明/文件摘要及范围，不自动运行消息中的测试命令，也不验证 Git 内容等同于证据声明。
- 释放前把 commit/patch、测试日志、审查结果保存到 artifact_dir；文件不设固定字节上限，以分块 SHA256 校验完整内容。Review 的 `files` 必须为空；`commit` 指被审查基线/提交，报告需列全实际检查的实现 SHA。Integration 提示包含传递依赖的实现和审查证据。
- 所有 Delivery 消息都需要处理；纯 heartbeat 由控制器确认收取，未知类型仍需显式 reviewed。只有结算、证据确认且资源释放成功，才确认 worker_done。ack 返回下一批时保存下来，下个 step 继续处理。
- 越权问题写 `action:human`：先将原文和待决状态持久化，再允许 ack 推进 FIFO；ack 只确认收取，不回复、不批准、不解除权限限制。后续独立问题可以继续处理；待人工问题在重启后仍保留，可在后续 step 按原消息 ID 提交 reply，仍须通过原有 within_scope 校验。回复回执与 resolved 状态完成后才移出待人工队列；存在未解决人工问题时不会标记整个目标完成。
- `pending_messages` 表示本回合仍需处理的消息，`waiting_human` 单列待人工问题，`next_delivery` 表示还有缓存批次待检查。没有待处理消息、仅等待人工时可以 checkpoint 并结束回合，不反复请求模型。`within_scope:true` 是 Coordinator 的责任声明，不是新增授权机制。旧版未确认人工问题会在下次 step 时持久化原文并推进批次，无须手动改库。
- 失败证据使用 verdict=fail，阻止依赖启动；仍需保全证据并释放已结算 Worker。当前格式要求完整 SHA 和全部命令结果；提交前失败/启动失败可能无法满足，进入人工原生恢复，不伪造证据。

操作员命令（本身不启动 Agent）：

```bash
python3 -m supervisor --config CONFIG status
python3 -m supervisor --config CONFIG pause --reason "人工维护"
python3 -m supervisor --config CONFIG resume --reason "维护完成"
python3 -m supervisor --config CONFIG request-round --reason "批准范围内的答复已准备好"
python3 -m supervisor --config CONFIG export
```

resume 只解除 `operator:` 暂停，不清预算/失败数。request-round 只在 waiting 检查点可用；Supervisor 下一次核验身份和预算后唤醒。人类答复内容应放到 Coordinator 可读的私有文件，并在申请理由/后续交互中指明；不要用此命令扩大原配置范围。安全熔断、未知回执、PTY 变化和超额不提供自动解除入口。

## 预算、费用和可观察性

Token 与耗时用独立 [swarm_ledger（私有部署）](../configuration.md) 记录；每次 Run 开始、派发/结算检查点和收尾调用采集，既适用于原生编排，也可由此 MVP 的 Coordinator 调用。台账不改预留或费用结算；下述 `cost-import` 仍是另外的账单流程。

预留覆盖初始 Coordinator、每次唤醒、实施、Review、Integration，以及失败尝试。达到 Run/服务启动次数、时长或费用额度后不启动新模型回合；未知账单一直按预留计入，重启不重置。周期窗口按 Unix 时间整除 period_seconds、按启动时刻归档，**不是供应商逐请求账单周期**。

当前没有 provider 每请求 token 上限、硬账单截断或自动中止运行中模型。单回合内可发生多次模型请求；预留并不能保证真实花费不超额。请配置供应商侧独立额度、按试点数据设置保守预留，并明确接受这个差距，否则不进入无人值守验收。预算暂停不取消/释放正在运行的 Worker，也不自动花费一个额外 Coordinator 回合来清理；现有有效回合可继续回读/回复/结算清理，若已超回合时限则需要人工恢复。

从提供方获取完整、最终账单后才导入 [costs 示例](../examples/costs.example.json)：

```bash
python3 -m supervisor --config CONFIG cost-import --file COSTS
python3 -m supervisor --config CONFIG export
```

key 必须来自 status/export/私有台账，初始为 `<goal>:round:0`，Worker 为 `<goal>:worker:<task-key>`。未知 token/cache/金额保留未知，不把预留当实付；禁止用未完成的部分账单提前释放预留。相同账单重复导入幂等，冲突值拒绝；实付超过预留触发服务暂停。固定粒度的质量/成本对照实验仍需阶段 C，不预设降本比例。

status 是本地策略快照，不替代原生盘点；`heartbeat_at` 是服务 tick，`checkpoint_at` 是 Coordinator 检查点，`progress_at` 是启动/决策/唤醒/完成时间，不是模型成功或代码进展的证明。`human_decisions.resolved` 标明待决策是否已回复。export 在 `<artifact_dir>/<goal>/manifest.json` 保存契约、证据、费用和状态，不公开发布；白名单导出也不是自动脱敏，分享前人工检查文本。

## 不确定状态与恢复

每个原生变更先持久保存 intent，再调用 CLI，最后保存原始私有回执。已保存回执可恢复本地索引；intent 没有回执时不自动重发。release_pending/unknown、启动失败的 residualResources、服务/PTY 更换、未知 Task/Dispatch、清单不完整均需要检查，不能当作 Worker 死亡。

恢复前暂停试点派发，按已安装 `orchestration` skill 读取目标 runtime 版本对应的恢复与清理指南，从执行宿主查询明确 Run/Task/Dispatch 和 request-show（如有 request ID）。原生回执的恢复动作受原调用者身份约束；新终端不能复制环境/handle 接管。必要时按另行批准的原生流程处理，然后设计并审查控制器迁移；本版不提供修改 SQLite 的恢复命令。不要删除锁文件/数据库、开新 Run、terminal close 或盲用 retry-request 绕过不确定性。

Supervisor 进程重启不等于 Coordinator 崩溃接管。当前只支持原 PTY 正常回合续接和同一身份的已收回执恢复；Agent 确认退出、更换 PTY、Server/主机重启的恢复仍需人工核验和处理。Mac 可真正关闭且任务仍完整推进，必须由 [验收清单](../acceptance.md) A1/A2 的远端证据证明，不能从本手册推定已通过。
