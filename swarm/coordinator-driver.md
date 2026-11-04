# Coordinator 回合续跑器（未部署）

`coordinator_driver.py` 补齐单次 `trae_exec_capture.py` 之后的控制循环：
**模型进程退出成功，不等于原研究目标已完成。** 默认只验证离线输入；
只有已批准的私有配置 `enabled:true` 加 `--execute` 才可能启动下一回合。
示例配置保持关闭，不包含真实身份、任务正文或凭据。

这不是固定 DAG Supervisor，也不是监控进程的自动恢复逻辑。
`progress_watch.py` 仍只读；driver 不消费 Inbox、不执行 checkpoint 中的命令、
不替 Coordinator 创建/重试/释放 Worker，也不直接提交训练。

## 状态规则

| 检查结果 | Driver 行为 |
| --- | --- |
| `continue`，owner 为 `coordinator`，授权、原身份和退出证据通过 | 在同一原生 PTY、同一 session 串行执行下一回合 |
| `continue/wait`，owner 为 `outer-operator` | 固定请求，等待配置中指定的 Operator 认领和回传；不启动模型代执行 |
| Operator 回传 `executed/not_executed/failed` | 原 Coordinator 在同会话审查证据，再经原授权、转换及无进展校验续跑；回传本身不算进展 |
| Operator 回传 `submitted` + 精确 Job 绑定 | 只确认排队/运行；记录后台 Job，立即交回原 Coordinator，允许推进独立研究/审查 |
| Operator 回传 `unknown` | `operator_outcome_unknown_requires_reconciliation`，持久停止，不重提 |
| owner 为其他不支持角色 | `unsupported_action_owner`；保留原 decision，停止并要求核对执行归属 |
| `wait`，明确的原生 Dispatch 状态未变 | 只读轮询，不反复启动模型，不消耗其 Inbox |
| `wait`，依赖状态改变、已结算或原生 attention 要求处理 | 唤醒原 Coordinator 核查/处理；变化不是 retry、release 或成功证明 |
| 后台 Job 状态变化且尚未审查 | 下个安全边界固定事件，唤醒原 Coordinator；原生依赖与 Job 事件任一变化可推进；相同状态不重复唤醒 |
| `blocked` | `blocked_pending_independent_alternatives_review`，不是已证明所有替代路径穷尽 |
| `complete` | 返回 `complete_pending_independent_acceptance`，不宣称 Benchmark 提升或业务验收通过 |
| 无/错误/过期 checkpoint、身份或固定合同变化、权限/连接错误 | 停止；不切换 runtime、工具或权限绕过 |
| 退出/产物已验证且 `settlement.json` 已完整发布，仅 Journal 未结算 | 重验原身份、授权、退出、产物与转换后补写结算，不重启该回合、不重复计数 |
| 进程退出未知、非零退出、采集异常、无已准备结算记录的 `pending` | 停止并要求显式核对，不盲重发 |
| 连续缺少新的执行/产物证据达到配置阈值 | 持久停止；重启脚本不重置计数 |
| 新终止声明没有本轮执行和新产物，或未执行的独立路径被删除/降级 | 拒绝结算，保留 pending 和上一有效 checkpoint，要求核对 |

循环为：输入 checkpoint → 固定 action obligation → 持久 launch intent →
同会话执行 → 核验接受记录、直接父进程退出、产物和授权 → 验证路径转换 →
持久下一 checkpoint → 再次决策。不是“写了 continue 就认为执行完成”。

`coordinator_loop.py` 对共同字段执行结构路由：原验收集合不变、路径/阻碍引用有效、
有具体下一动作，决策符合 `continue > wait > blocked > complete`。某条路径受阻不会
覆盖其他可执行路径。该检查在领域 checker 通过之后叠加，不替代 RSI 的 schema-2
证据/边界与授权校验，也没有把 checker 的 `execution_authorized:false` 误当作撤销原用户授权；
该字段表示 checker **本身不授权执行**。

`next_action.owner` 不是执行/接收证明。Driver 只启动原 Coordinator；外层动作由
指定 Operator 认领、实际处理并回传，协议见下文。自动处理可选用
[Operator 执行器](coordinator-operator.md)及预审适配器；driver 本身不执行业务命令，
也不把消息发送视为成功交接。不支持的 owner 会留下独立 `execution_stalled` 事件，
checkpoint 的科学判断仍然是 `continue/wait`。

实现复用模块：`coordinator_driver.py` 保留原循环与授权入口，
`coordinator_handoff.py` 只管理交接收据，`coordinator_state.py` 复用同一 Journal
并提供只读监控投影，`coordinator_io.py` 集中文件 pin、范围和持久写入校验。
可选 `coordinator_operator.py` 复用上述协议处理外层动作；没有新增研究调度器、数据库或部署常驻服务。
`coordinator_background.py` 管理不可变 Job 观察链、事件消费和未决路径保护，不提交任务。
`coordinator_loop.py` 集中 provider-independent 的阶段提示、结构路由与路径转换校验；
启动计划和 driver 的实际 prompt 共用同一 run 契约，领域/权限/身份/真实依赖门仍在 adapter。
完整角色/阶段契约见任务交付的 `skills/orchestration/references/coordinator-loop.md`。

阶段报告、状态文本、模型回合结束与进程退出不能单独证明目标完成。
精确 `continue` 必须进入动作/回执循环；不从自由文本推断决策。
Executor 的持久停止原因与 checkpoint decision 分开保留；身份错误或无进展止损
不伪造业务 blocked/complete。仅要求一个报告的任务按原验收结束，不扩大目标。

Trae 启动器通过 `input_contract` 固定片段、原正文及完整 stdin 的 hash，capture 实际
传入并私有归档，driver 回读核验；计划不会修改 `prompt_file`，也不再生成仅重定向
原 brief 的命令。bootstrap、run、replacement（recovery）提示分别生成，run 不再
携带 bootstrap 的结束指令；Codex 只增加通过既有门后的业务契约，不新增 Codex driver。
Codex 的片段仍需调用者纳入实际交接，不借用 Trae 的输入证明。
共享 closeout 提示供收尾交接使用，不代表新增自动收尾执行器。

## 已支持的执行边界

- 当前仅支持已核验的 Server 1.4.219、Trae CLI 0.210.1 或 0.211.1 `run` 阶段、
  同会话 `gpt-5.5 / xhigh / Max`。沿用原计划中的 AutoReview 或明确的历史
  `never` 策略，不修改全局配置、不把 Codex Full Access 参数套给 Trae。
- 上一计划必须与现有 `build_trae_plan` 重建结果完全一致。下一计划只替换
  任务输入文件及其 `input_contract`，保留 argv、cwd、会话、模型和可写根。
  此次阶段模板修正会改变 prompt fragment；旧固定计划不匹配即拒绝，不静默升级
  schema/配置或回填历史收据。既有任务须走获授权的恢复核验，保留旧证据并记录真实新回合。
- 必须在实际绑定的原生终端中前台运行，核对其继承的 `ORCA_TERMINAL_HANDLE`
  和 PTY 输出。禁止在另一终端复制这个环境变量或安装一个伪装终端的守护进程。
- 启动前/回合结束后读取 runtime、Run owner/generation、terminal incarnation、
  workspace 及完整分页 Worker 清单。未知资源继续占用并发名额。
- 每次依赖直接父进程 `wait()` 收据以及原始流中唯一 `thread.started` 与
  `turn.completed`；进程不存在、`agentWait:null`、超时和安静日志都不算退出证明。
- 最新实际会话上下文和 checkpoint 必须位于该次启动/退出窗口内。
  长回合不用固定“退出后 300 秒”误判，但后来的其他回合会使旧绑定失效。
  实际 effective 设置还需与前一回合一致，包括附加可写根，不能静默扩大权限。
- 原配置、任务 brief、原验收合同、原始用户授权账本、交接、路径权限目录和
  **完整 `rsi/**/*.py` 文件集合**固定 hash。
  checker 在隔离 Python 子进程中执行已验证源码字节，不导入未固定的磁盘源码
  或 `.pyc`。它验证声明一致性，不认证实验、外部权限或验收引用。
- 强制调用 `resolve_authority` 和 `check_authorized_progress`，包含精确交接核对。
  不再只运行 `check_progress`。缺少 authority checker、用户来源变化、交接冲突、
  操作映射变化或 gates 不匹配均停止；不能降级为 base-only 校验。

没有引入研究总时长、总 Token 或累计 Worker 尝试上限。
`max_no_progress_turns` 仅为失败续跑止损，示例中的 3 不是用户总预算。
示例 `max_workers:8` 是最大并发 Worker 数（不含 Coordinator），不是必须启动 8 个；
此 driver 不改既有 Run 的其他限制。
配置中的并发/单训练上限必须不大于完整授权重放的上限。

`max_training_trials:1` 保留在每次交接中，但 **driver 不提供训练平台准入锁**。
Coordinator 仍必须用 fin_verl 既有技能/预检查询真实训练占用：排队、启动中、
运行中都计入，未知不记为零。该约束不能仅靠本脚本验收。

## 配置与验证

从 [关闭的示例](coordinator-driver.example.json) 准备私有配置。
不要把真实配置或原始流放进 Git。启动操作者仍须完成工作区 AGENTS、
orca-cli/orchestration 技能要求的授权、策略交接、身份、写入探针和台账准备。
这份代码/文档不自动授予启动、部署、扩大可写根或接管 Run 的权限。

RSI 的规划、初始交接与恢复均遵循工作区的
[目标仓库 skill 优先规则（部署方提供）](configuration.md#部署政策与历史材料)。
Driver 复用文件 pin 和接受收据，不另建 skill 服务：

- `repository_skills` 是 `{角色:{path,sha256}}`，从原启动计划的 `cwd` 发现，
  不从可独立存放的 `checker.root` 或全局技能目录取业务 skill。
  `discover_repository_skills(root)` 是可复用只读 helper，检查 `.agents/skills`、
  `.codex/skills`、`.claude/skills`、`.trae/skills`、`skills` 下的
  `*-rsi-{coordinator,researcher,reviewer,paper-scout}/SKILL.md`。
  Coordinator 必须存在；其他发现的角色也须列入交接目录，**不要求启动或加载全部角色**。
  同角色多份候选由操作者显式选定，不自动选第一份。
- 每次配置复核检查选定文件的路径和原始字节 hash。缺失、跨 checkout、符号链接或
  内容变化停止本驱动，保留原 checkpoint；不宣称研究已 blocked 或用户未授权。
  自定义目录/名称和外置 skill 暂无适配，须显式扩展并审查，不能用全局副本冒充目标文件。
- 每轮 prompt 带精确角色引用，要求 Coordinator 在动作前读取适用 AGENTS、完整 skill、
  按 skill 执行目标定位检查并读取必需引用；给 Worker 传对应角色引用，要求各自读取。
  复用 `action-accepted.json.skills_read` 核验 Coordinator 的声明与固定引用一致。
  发现文件、计算 hash、执行 checker 都不能替代读取声明；读取声明也不是完整阅读或
  行为合规的证明，引用依赖和 Worker 阅读仍需工具/原生任务日志审查。
- 这是**续跑入口**的校验，不追认上一回合已经使用技能，不拦截绕过 driver 的初次启动。
  不增加授权或写入范围，不替代业务技能、授权 checker、训练准入或 iterator loop。

配置需填入：

1. 当前原生 runtime / Run / generation / Coordinator handle / incarnation /
   workspace，以及原始 stream 实际观察到的 session UUID。
2. **确实执行过且直接观察到退出**的 `previous_plan`，旁边必须有其
   `.process-intent.json`、`.process.json`、`.stdout.jsonl` 和实际输入 `.stdin.md`。
   未使用 capture 的旧回合不能用“进程不在了”生成替代收据。
3. 该回合内生成的 `initial_checkpoint` 与独立固定的原验收 `contract`。
   contract hash 使用 UTF-8、`ensure_ascii=False`、`sort_keys=True`、
   `separators=(",", ":")`、有限 JSON 数值的规范序列化；authority 下三个 JSON pin
   也采用此规则，其余文件使用原始字节 SHA256。
   不从新 checkpoint 反向选择/修改验收合同。
4. 批准的 `brief`，包含目标/基线/写入范围/验收、并发与单训练限制、当前一致的规则。
   `checker.files` 必须列出指定 root 下所有 `rsi/**/*.py` 及各自原始 hash；
   不仅仅列出示例中的三个文件。允许使用单独已审查的只读 checker 副本，
   不能在活动循环中更新固定 checker 来通过新声明。
5. 已验证的精确 session log（不是 latest/glob 搜索）；允许产物目录
   `progress_roots` 必须在原任务 cwd/已授权 write roots 以内。
6. 如初始 checkpoint 为 `wait` 且 owner 为 `coordinator`，`initial_waiting_dispatches` 必须覆盖其所有
   原生依赖。不可用无关 Dispatch 假装覆盖外部等待；该路径使用 `outer-operator`
   交接。Operator 可实际等待并回传，或使用[可选执行器](coordinator-operator.md)
   的 query 协议；真实训练平台适配器尚未接入，不能仅配置一条路由就视为已支持平台。
7. `authority` 含 independently pinned `ledger`、原用户证据 `source_root`、
   `scope_id`、完整重放 `handoff` 和预先审查的 `path_catalog`。
   catalog 采用 `rsi.authority` context 的结构（schema/run/scope/authority hash/
   contract hash/paths），paths 每行是 `{id,operation,permissions}`。
   各 checkpoint 的剩余路径 context 由 driver 从已固定 catalog 按 ID 确定性投影，
   并校验 operation 完全相同。context hash 由可信输入推导，**不从模型的新交接反推授权**。
   新路径不能自行添加权限映射，需要操作者独立审查；不要在运行中修改固定配置。
8. `initial_gates` 是与初始 checkpoint 一一对应的原始字节固定文件，格式为
   `{schema_version:1,paths:[{id,technical,platform,evidence_refs}]}`。
   后续每回合写出新的 `gates.json`，由全量 checker 校验；这些仍是门禁声明，
   不替代实际平台访问或训练准入检查。用户授权、技术状态、平台权限三者独立。
9. `repository_skills` 按上述规则列出目标仓库角色文件，hash 复用普通文件原始字节口径。
   文件存在和 hash 通过不是技能兼容性、完整阅读或业务验收通过。
10. 必填 `outer_operator:{"id":"submit-operator"}`，指定外层动作的唯一受信操作者。
    缺省、`null` 或附带执行命令均拒绝；ID 不是凭据或用户认证。

本版配置为 **schema 5**，Journal 为 **schema 3**，固定包含 `operator_requests` 与 `background_jobs`。
回合接受记录与动作结果均为 schema 2。旧配置及 Journal 格式显式拒绝；
不静默补默认授权或技能、不自动迁移活动状态。已有 pending/outcome 的 Run 必须保全证据，
显式完成生命周期核对与迁移审查；不能删除 journal 来绕过恢复门禁。

在本子仓库执行下列离线验证（不启动 Agent、不查询 Orca、不创建状态目录）：

```bash
python3 -B coordinator_launch.py goal-loop --config /absolute/private/driver.json \
  --config-sha256 <operator-pinned-raw-config-sha256>
```

该入口输出经过初始交接验证的 driver 命令；直接运行 `coordinator_driver.py` 的离线验证
仍支持。goal-loop 复用同一个 driver，不包装第二套重试器。它要求原 Coordinator 已
完成真实的 run 阶段 seed 交接、合法 checkpoint 和上述独立固定配置；不自动生成 seed。
普通 Trae resume CLI 现在须显式 `--single-turn` 才能生成单轮计划，用于 seed 交接或
原定单次交付；它不是目标型任务的长期执行入口。

校验 hash 必须来自操作者审查的原配置，不能接受 Agent 自报的新 hash。
已有授权且所有上线门禁完成后，在**原 Coordinator 的原生 PTY**执行同样命令
并加 `--execute`。不要从监控服务调用，不另起 Run，不与人工 resume 并发。
除该 driver 外的启动者不共享此锁，因此外部串行操作是必要前提。

## 提交端 Operator 的显式交接

这里的 Operator 是发起 RSI 任务的操作者，**不是** `fin-verl-job-submit`，也不是第二个
研究 Coordinator。配置时须明确由谁处理外层动作，沿用原授权及单一执行者约束。
不能在活动 Run 中修改固定配置、删除 journal 或另建 Run 绕过已有停止状态。

```text
Coordinator checkpoint (owner=outer-operator)
  → driver 固定 request → 指定 Operator 认领 → 在原授权内处理/核查并回传
  → driver 校验收据和证据 → 同一个 Coordinator 审查 → 原 RSI 循环
                            └─ unknown → 持久停止，人工对账
```

每项动作使用 `<driver root>/operator-<action_sha256>/` 下三个不可覆盖的文件：
`request.json` 固定配置、原身份、输入 checkpoint、动作 ID/hash 和指定 Operator；
`accepted.json` 固定请求、认领者、时间和 Coordinator skill 读取声明；
`result.json` 固定请求、认领收据和报告文件。收据使用完整临时文件加原子独占发布，
并发认领只有一次成功；driver 是 Journal 的唯一写入者，Operator 不抢占其长持锁。

先只读查看当前请求及 driver 的 outcome/pending/STOP；输出不是 driver 存活证明：

```bash
python3 -B coordinator_driver.py --config /absolute/private/driver.json \
  --config-sha256 REVIEWED_CONFIG_SHA256 --handoff-status
```

Operator 回读固定请求、原始输入和授权来源，完整读取目标 Coordinator skill 及必需引用。
核验当前外部任务/未决提交，确认仍在原授权内后，认领**精确请求 hash**：

```bash
python3 -B coordinator_driver.py --config /absolute/private/driver.json \
  --config-sha256 REVIEWED_CONFIG_SHA256 --accept-handoff REQUEST_SHA256 \
  --operator-id submit-operator --confirm-skill-read
```

认领复用原 checkpoint/授权和只读原生身份校验，拒绝 STOP、pending、outcome 或观察窗口内的状态变化。
不要求也不允许借用 `ORCA_TERMINAL_HANDLE`；命令只写认领收据，不执行业务或授予权限。
成功后由该 Operator 使用原获准工具处理动作，再把证据归档为**不可变文件**并编写报告：

```json
{
  "status": "executed",
  "evidence": [{"path": "/absolute/authorized/archive/action-evidence.json", "sha256": "RAW_FILE_SHA256"}]
}
```

终态/未知报告只接受 `status` 和 `evidence`，状态为 `executed/not_executed/failed/unknown`；
`executed`、`failed` 必须有非空、在 `progress_roots` 内且不是控制文件的固定证据。
它们是操作者报告，不是独立的执行或业务验收证明。未操作可报 `not_executed`；
请求是否生效、外部提交是否成功等无法确定时必须报 `unknown`，不能用 `failed` 暗示可安全重试。
长任务可使用下节的 `submitted`，它必须额外绑定精确 Job，不得用它掩盖未知提交。

```bash
python3 -B coordinator_driver.py --config /absolute/private/driver.json \
  --config-sha256 REVIEWED_CONFIG_SHA256 --return-handoff REQUEST_SHA256 \
  --operator-id submit-operator --acceptance-sha256 ACCEPTANCE_SHA256 \
  --result /absolute/private/operator-report.json --result-sha256 REPORT_SHA256
```

回传只归档收据，不查询原生状态、启动模型或清除 STOP。故而已认领动作在断线/STOP 后仍可
回传真实结果，但恢复仍需原有核对。报告和证据在 driver 消费前重新校验；后续审查同一动作
也会复核，不能覆盖证据文件来更新结果。

同一 `next_action` 内容 hash 在此 Run 中复用原请求和结果，重启或只有计划的审查不触发再次执行。
真正的新操作需要新的、经原授权检查的动作；改名不能替代外部平台对账或制造重试授权。
等待认领/结果时只轮询，不启动模型，也不清无进展计数。非未知结果由原 Coordinator 以
`review_operator_result` 审查，prompt 明确禁止重做原外层动作；其接受、执行、产物、授权和
checkpoint 转换仍走原来的验证链。该提示约束及本地防重不等于平台级 exactly-once 保证。

## 后台 Job 与业务并行

Coordinator 是跨阶段的唯一业务规划者；正常续跑由 Coordinator 与本 driver 接续，
Operator 负责启动/恢复门、交付证据及执行精确委托，
不能因为“已获准训练”或缺 Worker-start 回执而自行代派发。恢复/adoption 仍遵循
[全阶段业务归属规则（部署方提供）](configuration.md#部署政策与历史材料)。

`submitted` 报告示例：

```json
{
  "status": "submitted",
  "evidence": [{"path": "/absolute/authorized/progress/submission.json", "sha256": "RAW_FILE_SHA256"}],
  "background": {
    "operation_key": "SHA256_OF_CANONICAL_DRIVER_PIN_AND_ACTION_HASH",
    "job": "EXACT_JOB_ID",
    "status": "queued"
  }
}
```

`operation_key = SHA256(canonical({"driver": driver_config_sha256, "action": action_sha256}))`。
初态仅 queued/running，必须有作用域内非空固定证据。它仍使用 request/acceptance/result 链，
只证明操作者确认了提交，**不是 executed、资源释放或业务完成**。

1. Driver 收到 submitted 后登记 `background_jobs[action_sha256]` 并交回同一 Coordinator。
   Coordinator 保留训练等待路径、未满足要求和冻结的代码/config/data，实际推进独立研究。
   Worker 并发与训练 Job 并发分别核算；模型回合始终串行，不另开业务 Coordinator。
2. Operator 通过预审适配器只读查询历史已提交 Jobs，即使当前动作已改成研究或模型正运行。
   每次状态变化生成固定 `background-<file_sha256>.json`，原子更新 `background-head.json`；
   事件绑定原 request/result、操作键、Job、顺序、前驱、时间及证据。终态 succeeded/failed
   不再查询，原 result.json 从不覆盖。相同状态的轮询只保存证据，不生成新的唤醒事件。
3. Driver 仅在没有 pending 的回合边界采集 head，绑定精确
   `action.background_events:{action_sha256:cursor_ref}`，prompt 同时提供全部 Job 视图。
   首次 cursor 为 submitted result，之后为事件文件。一个回合同时收到多个变化时合并交付，
   完整链保留在证据中，不为每次轮询单开模型回合。
4. Coordinator 回合的 executed + 实际工具/新产物声明同时处理了原动作及绑定事件；只有
   验证并结算成功才原子推进 consumed。no_progress 不消费事件，仍受原有无进展止损约束。
   事件覆盖的路径允许一起审查转换，不因此删除其他无关路径；这仍非语义审查证明。
5. 运行/排队/unknown 的 Job 不得从 checkpoint 消失、满足对应要求或宣称 complete。
   终态也必须经上述审查消费才能 complete。等待可同时引用原生 Dispatch 与后台 Job；
   只有已有活动/unknown Job 时才允许空 waiting_dispatches，任意外部 ID 或初始空等待不放行。

事件在模型运行期间到达时，Operator 不改 Journal；该回合结算仍校验原固定 frontier，
新事件留到下个边界。完整 settlement 中断可按原流程重验结算，不重放模型、不重复消费。
提交确认前的 unknown 保持原全局对账门；提交后的 unknown 保留资源/路径，仅停止该 Job 的
有界查询，不阻止独立研究。没有新证据不能靠重启恢复查询或重新提交。

此协议不自动采用外层手工创建的既有 Jobs。手工 submitted 的后续事件采集须另经明确交接；
自动执行器不接管无自身认领记录的动作。没有后台采集者/已核验平台适配器时，报告缺口，
不能宣称训练期间已实现自动推进。未回传的短操作或未知提交仍占据交接等待，不支持任意抢占。

## 每回合产物与“进展”的精确定义

Driver 自动生成续跑输入，要求 Coordinator 在本回合精确目录中写出：

- `checkpoint.json`：原 `rsi.progress` schema 2，保留全部原验收要求。
- `action-accepted.json`：`schema_version:2`、本次精确 `action`、`accepted_at`、
  `skills_read:[{path,sha256}]`（精确的 Coordinator skill 引用）；
  要求完整读取后、执行动作前写出，时间必须处于真实启动至 checkpoint 之间。
- `gates.json`：本回合所有剩余路径的授权门禁声明，schema 1。
- `action-result.json`：`schema_version:2`、本次精确 `action`、
  `status:executed|no_progress|waiting`、
  `artifacts:[{kind,path,sha256}]` 和 `waiting_dispatches:[]`。
  `kind` 支持 source/test/measurement/runtime/analysis；仅承诺未来工作时 artifacts 留空。
  已完成且针对具体不确定性的设计、来源核证或可行性分析可用 analysis；需引用实际
  核查证据，不能重复既有规格或把它当成候选有效性/实验完成的证明。
  不要求模型知道执行流内部的 item ID，Driver 自行提取真实工具事件。

每轮还给出可直接调用的 `checkpoint_validation_argv`，通过 `--check-draft` / `--gates`
校验该 pending 回合的精确输出。Coordinator 在退出前执行并原地修正 schema、decision
或授权声明错误，不因此重做已经执行的业务动作。检查器回读固定配置、pending/action、
实际输入及启动意图，执行共享结构校验与完整仓库授权 checker；不获取 Journal 锁、
不写状态、不启动模型、不结算动作。返回值明确为草稿一致性，非实际执行或业务验收。
最终仍在子进程退出后核验工具/产物、真实依赖和路径转换；草稿通过不替代这些门。
退出后坏 checkpoint 仍保留 pending 等待对账，不自动生成修复回合或伪造 continue。

`action` 同时绑定 Run/generation、原生终端/incarnation/workspace/session、回合号、
输入 checkpoint 文件 hash、动作 ID/内容 hash 和 executor；旧回合收据不能复用。
有待审后台事件时额外绑定 `background_events` 的精确 cursor 引用。
接受与启动证据在子进程退出后统一回读核验，事件显式标注 observed-after-exit，
不是实时独立观察模型接受的证明；模型自写的时间也不是签名证明。

Driver 复读允许目录内的普通、无符号链接产物并核验原始 hash；
只有 `status:executed`、真实成功工具事件和此前未见的产物内容，
才重置无进展计数。重命名相同内容、换 action 标题、只有助手文字、
更新 driver 自身 checkpoint/收据不算新的产物证据。
无关原生 Task completed 不再计入这次动作的进展。
固定的授权/合同/来源/配置、角色 skill 与 checker 文件也不能被当作进展产物。

空产物/无执行的回合记为 `execution_stalled`，`continue` 会在原止损阈值内
进入下一回合，不把记录本身当执行。无进展的 `continue` 必须保留原 next_action，
不能通过换一个计划丢掉未执行动作。
新 `complete/blocked` 或新 requirement-met
声明必须伴随执行和新产物；归档不能靠删掉独立路径提前结束。
完成的目标路径可带执行证据从下一 checkpoint 移除，剩余其他路径继续；
未被本次动作覆盖的路径不能悄悄删除、从 actionable 降为 waiting/blocked，或
从 waiting 降为 blocked。此类变化需单独 review 动作或操作者核对。

**这只是活动/内容证据，非语义进展认证。** 工具成功不等于修复正确；
首次引用已存在但此前未登记的文件、产物中改变时间戳等仍可能产生新 hash；
只读检查已有产物也可能被保守记作无新进展。不能据此宣称杜绝一切空转、数据泄漏或
Benchmark 刷分，最终仍要求原业务合同的独立审查、对照与可复现实验。

## 持久化与故障处理

状态固定在 `<原 Run archive>/coordinator-driver/`，目录0700、文件0600：

- `driver.lock`：非阻塞排他锁。
- `state.json`：配置绑定、累计回合数、无进展计数、历史内容摘要、current、pending、outcome，
  以及按动作 hash 记录的必备 `operator_requests`、`background_jobs`（收据链、latest、consumed）。
- `events.jsonl`：初始化、启动意图、接受/启动证据、结果核验/执行停滞、结算与停止事件。
- `turn-NNNNNN/`：prompt、计划、capture 原始证据、checkpoint、action-result、
  driver 回读生成的 `action-receipt.json` 及原子发布的 `settlement.json`。
- `operator-<action_sha256>/`：上述请求、认领与回传收据；不因超时、重启或重复命令而覆盖。
  后台事件链及原子 head 也在此目录；控制链不算科研进展证据。

先持久写 `pending`，再启动进程。进程、验证或持久化中断后**不自动重放**。
唯一自动结算恢复是已完整发布 `settlement.json` 的 pending：它固定结算前状态 hash、
下一 checkpoint/收据和计数；正常路径与重启路径共用 `settle_prepared()`，重新校验
原身份、授权、真实退出、产物及转换后才更新 Journal。同一结算不会累计两次。
尚未发布该记录、`state.next.json`、孤立回合目录或配置变化仍要求显式核对；即使看起来
产物齐全，也不拼凑启动成功证明。已有 outcome/STOP 优先，不由自动恢复清除。
不要删除/换名状态目录或删 pending 规避；这不是未知提交的自动重放或 Coordinator 接管。
故障处理需保全证据，核实旧子进程退出及最新身份，再由操作者决定后续修复。

在该精确状态目录放置 `STOP` 可阻止下一次启动；不强杀正在执行的子进程。
停止 outcome 持久保存，移除 STOP 或重启脚本不会恢复或清零。
收到断线/权限拒绝不会扩大白名单、换 runtime 或重新启动服务。

这是同一账号受信操作者的防重入协议，不是与 Full Access Agent 隔离的安全边界；
同一账号仍能改文件，文件 hash/父进程收据也不是密码学进程证明。
验证读取不再设置固定的单文件字节上限；读取初始 EOF 的完整前缀，
不改为只读最新部分，也不跳过身份、授权 pin 或完整性检查。原始 stream/prompt 可能含敏感数据，
只留私有归档；终端仅转发原始身份事件和简短退出/状态信息。

## 验收与现有监控边界

回归测试使用内存 native 快照、隔离 fixture checker 和真正的**假子进程**，
可验证连续两回合、防重入、崩溃 pending、身份/合同变化、等待和无进展止损。
覆盖外层动作认领/回传/审查、不支持 owner 的停止、旧配置/Journal 拒绝、等待不唤醒、
结果重放/未知停止、只读监控跟随与回退防护、动作/输入绑定、接受记录缺失/重放、空计划终止、
独立路径保留、无关 Task 不计进展、授权来源/交接/权限映射/上限和真实 checker 接入。
`test_coordinator_loop.py` 用软件修复与数据审计两类契约验证相同路由/转换，不依赖 RSI。
Driver 回归另验证阶段报告后实际执行下一动作、只有状态文本而无 checkpoint 时
停止且不重放、局部阻碍下继续独立工作，以及旧阶段模板不被静默回写。
包括证据缺口下继续已授权 analysis、重复规格不重置计数、假等待拒绝、草稿本回合修正
且不重复动作，以及 goal-loop 入口驱动两个真实本地假子进程并在进程内校验草稿。
`test_trae_coordinator.py` 验证 bootstrap/run/recovery 提示隔离，且计划不修改原交接文件；
`test_trae_exec_capture.py` 通过真实本地子进程核验三种阶段完整 stdin 的实际传入与 hash。
`test_coordinator_background.py` 另覆盖训练持续运行时两项研究的并行派发/审查、同会话
事件审查、重复状态不唤醒、后台查询与 pending 并行、提交与结算崩溃、未知资源保留及回退拒绝。
它们不启动真实模型、不更改 FIN 工作区/运行时、不调用训练或 Merlin。

```bash
python3 -B -m unittest discover -s tests -p 'test_coordinator_*.py' -v
python3 -B -m unittest discover -s tests -p test_trae_coordinator.py -v
python3 -B -m unittest discover -s tests -p test_progress_watch.py -v
# 可选：只读复制目标已核验 checkout 的完整 rsi 源码到临时 fixture，运行同一组集成测试。
RSI_CHECKER_TEST_ROOT=/absolute/verified/fin-verl-checkout \
  python3 -B -m unittest discover -s tests -p test_coordinator_driver.py -v
```

每回合收据保留 capture 的起止时间及原始 `turn.completed.usage`（若提供）。
它不是账单审计或完整 Swarm 台账；缺失 usage 保留 null，不填 0。
真实上线仍须按 [ledger.md（私有部署）](configuration.md) 采集 Coordinator、全部 Worker/失败尝试的
Token/耗时、统计覆盖和缺口，以及归档 hash 回读证明。

`progress_watch` 必须通过 `driver_binding` 跟随已固定 driver 的
`pending/current`、计划和回执，见 [监控接入](progress-watch.md#driver-binding)。
缺失、回退或不一致均报 unknown，不回退到旧退出收据。监控不写 driver 状态、不驱动 loop，
也不证明独立 driver 进程存活。本次不修改运行中的配置或安装服务。

尚需独立代码审查、真实原生同 PTY 续跑/权限探针、单训练准入与完整业务验收。
源码完成不代表已部署，不表示当前 RSI 恢复运行，更不表示无人值守已验收。
