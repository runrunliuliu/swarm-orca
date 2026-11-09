# Trae Coordinator：原生 strict 启动 / 历史 exec resume

本适配器按 Trae CLI 0.210.1 / 0.211.1 的 exec、0.211.1 / 0.212.1 / 0.213.1 / 0.214.1 的 TUI 契约实现，独立于 Codex 的
`coordinator_prepare.py/js` 和 `native_preflight.py`，不冒充其验证结果。
它不改全局配置、不部署 hook、不重启 Orca，不使用 `/proc`。

2026-10-26 新增独立的[常驻 TUI 路径](coordinator-tui.md)，显式使用
`trae-coordinator-tui-runtime.json` + `--strict-coordinator`。下文仍描述历史 exec
契约；不能把 TUI 的观察器/回执与 exec 混用，旧配置和已固定 hash 不自动升级。

会话日志核验不设置固定总字节数上限。观察器逐条扫描初始 EOF 的完整前缀，只保留
metadata 和最新完整 `turn_context`，内存随最大单条记录而非全部历史增长；不完整尾行
不作为配置证据，但仍计入前缀摘要。再分块校验前缀摘要及文件身份，拒绝读取期间的
改写、截断或替换。原生启动流不再限制 32 页，读取到首次查询的末尾游标为止，仍拒绝
淘汰的启动记录和无进展游标。其他容量变更及保留边界见 [日志容量说明](log-capacity.md)。

## strict 原生连续进程路径（实验性）

`startup-gate` 的会话日志回执不是 runtime caller proof。普通 shell 内运行 capture
不会得到原生 Agent launch token；即便是原生启动，Agent 退出后同一个 PTY/UUID
也不再代表同一个有效启动身份。禁止在退出后的 shell 中代建 strict Run。

新 strict 计划使用 `coordinator_launch.py --strict-coordinator --trae ...`，其余模型、
bootstrap 和正文参数同下节。生成 `strict-bootstrap` 阶段，实际输入仍由正文和阶段
片段的 SHA256 固定；`argv=null`，不能用 capture 执行。计划同时固定
`startup_delivery.mode=continuous-native-file-v1` 和本 attempt 的请求/发布/准备目录；
`--single-turn` 与 strict 启动不兼容。旧计划不静默转换。

审查并固定整个计划 hash 后，运行以下**只读**命令生成 Orca 原生终端启动 argv：

```text
python3 -B coordinator_launch.py strict-native-plan \
  --plan /absolute/materials/bound-launch-plan.json --plan-sha256 <plan-hash> \
  --materials /absolute/materials/final-checklist.json --materials-sha256 <materials-hash> \
  --operator-input /absolute/operator/operator-identity-input.json --operator-input-sha256 <operator-input-hash> \
  --cli /absolute/orca-server-cli --runtime <verified-runtime-id> --workspace <verified-workspace-id>
```

准备器先复用 Operator 材料清单和 Operator 身份核验，再核验选定 runtime 的
`orchestration.strict-caller-check.v1` capability 和准确 workspace ID/path，缺少支持即停，
不创建终端。输出的 argv 使用已有
`terminal create --agent trae --agent-args ...`，不是 `--command`；操作者另行确认
执行主机上的 Trae launcher 对应计划中的 executable、用户授权和私有 profile 后才能执行。
准备器还执行本机已指定 Trae 的 `--version`，比较计划版本并在探测前后核对
解析路径、文件身份和 SHA256；版本不符、自动更新、读取拒绝或超时立即停止。
`executable_observation` 是启动前观察，不是可复用许可或原生进程证明。
Orca 的 `--agent trae` 仍由运行时选择二进制，不能用该观察消除检查到启动之间的竞争；
启动前须再次核对，启动后仍须通过真实 session metadata、设置和 caller 两阶段门。
当前 Python 适配器限已核验的本机 POSIX Server 环境，不提供跨 SSH/Windows 启动转换。
正文经 shell-safe argv 引用传入，含完整片段，不能退回 stdin 重定向；含 NUL 或最终
UTF-8 `agent_args` 超过原生 RPC 的 **16 KiB** 上限时，两个规划入口都拒绝而非截断。
上限包含自动注入的阶段规则、CLI 选项和 shell 引号转义，并非交接正文可独占 16 KiB。
大段材料应由操作者改为已审查的精确文件路径/hash 引用，再重新生成并审查计划；
工具不自动改写正文、扩大权限或省略完整规则读取。正文会出现在进程参数/启动记录中，不得含凭据。
创建返回未知时先核对原生终端清单，不能盲目重发。

1. Coordinator 在自身工具上下文先执行 `orchestration strict-caller-check --json`。
   保存完整 CLI JSON 为初始 caller 回执，Operator 独立固定原始 hash；历史 result-only
   仍可读取，但新回执无需手工提取 `result`。没有 proof 即停止，
   不用 `--from`、环境变量复制或旧日志补证。
2. 大段规则输出前，Operator 用观察器 `--save-startup-anchor` 固定原生启动证据；
   新 v2 契约可在 observation 引用其 path/hash，后续仍重查实时身份和实际配置。
   完成 bootstrap 规则、原生 thread.started/实际配置和工具核验后发布 readiness；
   **保持同一个 exec 进程运行**，按授权期限有界等待 Operator 的 session gate，不结束进程。
3. 新启动按 [确定性启动握手](coordinator-strict-start.md) 准备固定配置与完整绝对命令：
   Coordinator 固定自己的期望请求，用 `strict-config-plan` / `strict-config-wait`
   在原 exec 进程内等待。Operator 只传 request pin 执行 `strict-start-prepare`，
   独立审查产物并记录 `strict-config-review` approve 后用
   `strict-config-publish --execute` 原子发布准确配置 pin。接收器验证源→快照映射和
   原请求绑定，返回配置和计划供 Coordinator 审查；不要求源路径等于快照路径，不创建 Run。
   不自写目录扫描器，也不结束 exec 回合等待终端输入；终端文本不是可靠 follow-up 通道。
   Coordinator 审查后进入 `strict-start-wait --execute`，Operator 审查并固定其 ready 后才
   `strict-start-publish --execute`。新契约默认 v2/1800s/180s，旧契约不改写；waiter 连续校验/创建/读回，
   不在 gate TTL 内插入模型轮次。以下只读诊断命令保留，不再作为模型分步创建的推荐路径：

   ```text
   python3 -B coordinator_launch.py strict-session-check --contract /absolute/contract.json --contract-sha256 <hash> --receipt /absolute/operator-session.json --receipt-sha256 <hash> --caller-receipt /absolute/initial-caller.json --caller-sha256 <hash>
   ```

   此检查比较初始与当前启动身份，前后两次实时校验 caller，并检查 Operator 回执仍有效；
   不创建 Run，不是可转移凭据。新握手由同一个 Coordinator 的助手直接调用 strict run-create。
   runtime 在创建时仍重新校验真实 caller，不能复用检查结果替代 proof。
4. 使用已授权写根中的精确 Run 归档。原进程不能靠 resume 增加写根；需要其他写根就
   停止并报告，不能扩大权限。首派发前仍完成既有 Operator/Coordinator 两道归属门，
   并再次检查 live caller。过程持续执行到业务检查点，不接旧 shell goal-loop。

capture 显式拒绝 strict 计划，driver 的实时 fence 也拒绝 strict-v1 Run。
本修复不提供崩溃接管或自动 resume。共享或隔离 profile 均可用于已授权任务，
启动前仍核验运行时能力、身份与影响范围。单元测试通过不等于已部署/实机验收。

## 历史非 strict 启动计划

`coordinator_launch.py --trae /absolute/traex --cwd /canonical/worktree
--bootstrap-dir /canonical/task-preparation --prompt-file /absolute/brief.md
--trae-runtime-config /absolute/task-trae-runtime.json` 只生成计划。
模型仍读取 Coordinator 选型文件，当前唯一支持组合为
`trae / gpt-5.5 / xhigh / Max=true`。2026-10-18 用户要求新配置使用 Auto-Review；
持久偏好见 [trae-coordinator-runtime.json](trae-coordinator-runtime.json)。后续获准启动时
显式通过 `--trae-runtime-config` 传入此文件或当前一致的任务副本：

```json
{
  "schema_version": 1,
  "scope": "swarm_coordinator_only",
  "provider": "trae",
  "cli_version": "0.211.1",
  "execution": {
    "sandbox_mode": "workspace-write",
    "approval_policy": "on-request",
    "approvals_reviewer": "auto_review",
    "launch_mode": "exec",
    "network_access": true
  }
}
```

这里使用已核验的 Trae 原生参数，并非继承 Codex 的 Full Access。
`exec --json` 将真实 `thread.started` 输出到同一个 Orca 终端，输入为固定阶段片段与
显式任务文件的组合，由 capture 传入而不是直接 shell 重定向原 brief。
不使用 ephemeral、忽略规则或 hook trust bypass。
受支持 Trae CLI 的 `--no-daemon` 只支持交互会话，不能传给 `exec`；本适配器
不声称验证了 exec 内部 daemon 行为。`approval_policy="on-request"`、
`approvals_reviewer="auto_review"` 和 `sandbox_workspace_write.network_access=true`
以原生 `-c` 设置。Auto-Review 是 AI 风险评审，不是无条件批准或 Full Access。
用户级 `~/.trae/traecli.toml` 的认证目录 writable roots 仍可继承；更高优先级的
权限配置可能覆盖它，启动后必须核验实际配置及工具访问。

观察器同时传入与启动相同的 `--trae-runtime-config`，检查实际 turn_context 的
`on-request` 和 `approvals_reviewer`（接受原生内部别名 `guardian_subagent`）；
缺失或不符即停止，不能仅凭 config/read 宣称真实会话已生效。
历史逐任务 `never` 契约仍显式支持，省略观察器配置参数仅用于旧 `never` 记录。
不改写旧启动计划、归档或既有会话，不改变 Codex 专用 runtime 配置。
这份 Coordinator 配置不改变 Orca 原生 Worker 启动器；后者若显式指定 `never`，
仍会覆盖用户默认审批。修改或部署 Worker 启动器属于独立变更，不能称已全量切换。

## 历史非 strict 两阶段归档

阶段语义遵循[共享契约（部署方提供）](configuration.md#部署政策与历史材料)。计划中的
`prompt_fragment` 与原 `prompt_file` 在只读规划时绑定为 `input_contract`，固定原正文、
片段及实际 stdin 的原始字节 SHA256。capture 传入两者组合，原正文不改写。操作者仍
须检查交接中是否含其他阶段的冲突指令。`replacement` 字段的语义为 recovery。
计划的 `command` 为 null；保存审查过的 JSON 后使用 capture，不再生成漏掉片段的
`< brief` 命令。计划/正文/片段改变须重新审查，旧计划不会静默补 pin。

新监督式 Run 同时遵循 [Operator 两阶段启动门](coordinator-startup.md)：步骤 2 创建
Run 前取得独立会话核验回执，步骤 4 首批派发前取得 Operator 归属回执并由 Coordinator
从自身上下文复查。现有观察器成功只证明其核验范围，不单独证明独立角色已就位。

1. 操作者准备本任务私有 bootstrap 目录，记录新终端的 handle、incarnation 和输入前
   cursor。启动已授权的 bootstrap 就位回合，不开始业务派发；这是显式模型启动，
   不是只读证据采集器自行发起模型回合。
2. 从该终端新 cursor 的原生 stream 提取唯一 `thread.started`，只查此 UUID 的日志。
   在实际上下文核验模型/effort/Max/权限后，先等待 Operator session gate；本回合不创建 Run。
   bootstrap 不允许 Worker 或训练，并以明确的回合完成结束。
3. 正向确认该进程结束及没有 Worker 后，另行交接给同会话 Coordinator 创建普通 Run，
   再建立真实 Run 精确归档。PTY/UUID 连续不代表 strict 启动身份连续。
   用 `--archive-dir <run_directory> --resume-session <exact_uuid> --single-turn` 替代 bootstrap 参数，
   把精确目录传入 `--add-dir`。在同一原生 shell/PTY 串行 resume 同一会话。
   不使用 `--last`、不换 Run、不把退出推断为 settlement，也不重复派发。
4. 对 resume 再次采集新 stream 及实际上下文，检查同一 UUID、新权限、Run 归属。
   Coordinator 使用实际编辑/读取/重命名工具探针，按正式 schema 形成交接 checkpoint。
   目标型任务还须接入下节 goal-loop；这个显式单轮交接本身不会跨回合续跑。

此流程解决 Run ID 尚未分配时的精确目录问题，不授予共享 archive 父目录。
配置缺失、权限拒绝、恢复失败、会话不符均停止并留证；不自动降级或更换方案。

## 核验边界

### 已授权的 Coordinator 更换（保留既有 Run）

`--replacement-run <exact_run_id> --archive-dir <existing_run_archive>` 是显式的新会话
计划，与 bootstrap/同会话 resume 互斥。计划不查询运行时、不证明旧进程退出，
也不执行交接或提供接管能力。

**先核验能力，再决定是否启动替代会话。** 只有所选 runtime 和该 Run 的模式明确支持
安全恢复，且版本匹配的原生恢复流程可验证，才适用下面的核验顺序。当前实验性
`strict-v1` 不支持安全 rebind/adoption 或崩溃接管，须在创建替代终端/会话前停止，
保留证据并报告；不能通过普通 `run-use`、去掉 strict 或手写 adoption 回执绕过。
完整边界见 [strict 恢复规则（部署方提供）](configuration.md#部署政策与历史材料)。

1. 取得旧 Coordinator 的正向进程退出证据，核验当前 Run/consumer generation、
   旧终端和完整 Worker 清单。保留失败记录和未知 Worker；未知者仍占并发名额。
2. 在相同 runtime/明确 workspace 新建一个原生终端，先观察 shell 就绪，再记录
   输入前 cursor，单次启动新会话。不得在新 PTY resume 旧 UUID 或复制旧身份环境。
3. 保持原观察器严格检查唯一新 `thread.started`、精确日志和实际配置。首次观察
   不传 `--run`；成功后只按已验证的原生恢复协议绑定原 Run 并留存 ownership/adoption
   回执。没有该能力就不执行绑定；不使用 `run-create`、`--takeover-legacy` 或直接改库。
4. 核对 consumer generation 前进、旧消费者已被 fence、原 Worker assignments 未变，
   再带 `--run` 重验。真实文件工具探针通过后才能继续已授权工作；独立审查可由
   未参与实现的新 Coordinator 完成，但不能自审其随后编写的修复。
5. 记录旧/新终端、session、交接和用量边界。一次恢复失败即停止该次启动，不因
   新 Coordinator 清零 Run 的并发、累计尝试、失败或预算，不盲重发。

该分支只扩展启动计划，不放宽原观察器，不部署 Server，不等于新会话的真实验收。

`trae_coordinator.py` 是只读观察器，重复核验 native runtime/worktree/terminal/
incarnation 和可选 Run 归属；分页读取从操作者记录的新 cursor 开始的原生 stream；
按它实际输出的 UUID 定位唯一日志，读取精确的 session_meta 和最后 turn_context。
检查 Trae 版本、实际模型、effort、Max、sandbox、approval、cwd 和所需可写根。
过期上下文、丢失 stream、重复 thread.started、符号链接日志和未知版本拒绝。

输出仅含 allowlist 的身份、设置、inode 和摘要，不导出原始 prompt、工具输出或凭据。
可信度标为 `native-terminal-stream-and-session-log-not-process-attested`：
这是受信原生输出/日志的关联，不是密码学 attestation、后端模型路由或费用证明。
不接受模型文本自行声称的 ID，也不把 config/read/目录/default/requested 当实际会话。
该观察器不启动模型、Run、Worker、不写文件、不检查业务验收，也不能替代真实文件工具
探针、fin_verl skills、独立审查、原生生命周期和归档回读校验。

当前实现的离线回归不是端到端验收；真实结果须另存本次私有准备/Run 证据。

## 大输出隔离

可用 `python3 -B trae_exec_capture.py <reviewed-plan.json>` 执行一次已审查计划。
它先验证输入 pin，独占保存私有 `.stdin.md`（0600），把同一文件描述符作为子进程输入；
启动意图和退出收据都固定 `stdin_sha256`。它保留私有原始 stdout/stderr 文件，只把原样 `thread.started`
送往原生 PTY，避免工具输出挤掉启动 cursor。重复身份不会去重；无效、超长或
不完整记录会产生有界错误标记，严格观察器拒绝。它不生成身份、不放宽 cursor
丢失检查，也不替代原生生命周期或真实会话核验。

`.process-intent.json` 阻止同一计划重复执行；`.process.json` 仅在直接父进程
wait 成功后记录实际退出码。采集异常记录 exit unknown，不授权重发。原始日志
可能含任务正文，只留私有归档，不能当作脱敏回执公开。

## 已授权任务的跨回合续跑

单次 capture 不负责业务循环。[coordinator_driver.py](coordinator-driver.md)
可在独立固定的原验收合同下，根据当前 checkpoint 在同一原生 PTY 串行 resume；
每次重新核对 Run/generation、session、实际设置和直接退出收据。只有显式启用才运行，
崩溃 pending 不自动重放，`complete` 仍待独立验收。它不是更换会话的工具，不会从
监控服务唤醒 Agent，也不会自动更新历史监控的单次启动绑定。详见其上线前置条件。

`coordinator_launch.py goal-loop --config /absolute/private/driver.json
--config-sha256 REVIEWED_CONFIG_SHA256` 只读验证并生成 driver 入口计划；已有授权、完整
初始交接和原生门禁通过后，在原 Coordinator PTY 加 `--execute` 进入续跑器。
普通 resume CLI 必须显式 `--single-turn`，仅用于交接或原本就要求单轮交付的任务。
goal-loop 不自动生成初始 checkpoint，不恢复损坏 Journal，不追认历史运行，也未部署到远端。
