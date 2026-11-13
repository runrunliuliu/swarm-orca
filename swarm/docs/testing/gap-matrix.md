# 现有测试资产 → 分层/场景 覆盖矩阵（缺口清单）

配套文件：[strategy.md](strategy.md)（L1–L7 分层定义与门禁）、[strategy-backlog.md](strategy-backlog.md)
（最小改法清单）、[reliability.md](reliability.md)（唯一验收口径）。

本文件只做映射与判定，不改变任何验收结论，也不表示任何子场景已实现或已运行。

## 1. 判定规则与证据规范

**状态定义**（与 reliability.md 第 8 节的状态词不同：那是**运行结果**的状态，
本文件的三个词是**静态覆盖度**，两者不可互相替代）：

| 本文件用词 | 含义 |
| --- | --- |
| 覆盖 | 有自动化用例断言该场景的**关键判据**（事件序列/状态投影/拒绝码），且断言语义与被验机制一致 |
| 部分 | 有相关用例，但只覆盖子分支、只覆盖离线类比、或只断言了弱信号（返回码/存在性） |
| 缺失 | 无任何用例针对该场景；或仅有提示文本/文档约束而无代码或测试 |

### 1.1 「缺失」不等于「代码缺失」

上面的三个词只描述**覆盖度**，不描述**成因**。同一个「缺失」可能来自三种完全不同的性质，
处置方式与成本也不同，因此本文件对每一条「部分/缺失」额外标注缺口性质：

| 标记 | 缺口性质 | 判定依据 | 后果 | 处置 |
| --- | --- | --- | --- | --- |
| **A** | 纯测试缺口 | 代码已实现且有确定语义，只是没有用例断言该判据 | 补用例即变绿 | 可直接做（backlog B1/B2） |
| **B** | 能力/工具未实现 | 生产路径或取证路径**不存在**该机制（含无 I 层取证脚本、无 L 层操作脚本） | 写了用例会**先变红**，或在真实环境无法取证 | 先定协议/实现再定测试（backlog B3-1/B3-2/B4） |
| **C** | 设计上刻意不做 | 仓库文档已自述为边界或已明确取消该限制 | 只能 PIN 现状，不能当缺陷修 | 记录并接受，或另立产品决策（backlog B3-3、第 5 节） |

**使用规则.**「—」表示该条已覆盖，不标性质。标 **C** 的条目**不得**在报告中描述为
“待修复缺陷”；标 **B** 的条目在实现前，其用例只能作为契约固化（红）而不能作为门禁。
本节不改变 reliability.md 的任何判定口径。

**证据规范.** 每条结论给 `文件:行号`。行号以本轮读取的版本为准（见文末）。
凡涉及“该机制在生产路径是否存在”的判断，均回读过实现文件；凡属推断均在句中标注「推测」。

**路径约定.** 除 `reliability.md` 与本目录两份配套文档用相对链接外，文中 `coordinator_*.py`、
`supervisor/*.py`、`tests/<area>/*.py` 均相对 `swarm-orca/swarm/`；仅 `swarm/docs/validation/*.md`
相对仓库根。

**不做的三件事.**（1）不把离线 mock 通过记作 I/L 覆盖（reliability.md:28）；
（2）不因存在同名测试就记覆盖（reliability.md 第 3 行）；
（3）不把 Supervisor MVP 的证据算作 strict 原生路径的证据（reliability.md:216–217）。

## 2. 基线核对：reliability.md 的必测项落在哪里

### 2.1 D 层（确定性回归）

| reliability.md 要求 | 现有回归入口 | 覆盖度 | 缺口性质 | 备注 |
| --- | --- | --- | --- | --- |
| D-contract：身份/授权/角色/路径/hash/generation 拒绝 | `tests/core/test_native_preflight.py`（24 项）；`tests/core/test_authority_bundle.py:128`、`:156`；`start grant` 侧见 `start-grant-create/-mint/-spawn` 三个 Orca 测试模块 | 覆盖（离线） | — | 旧握手的 `test_bootstrap_production` 已随代码删除；拒绝码逐条断言的要求不变 |
| D-contract：candidate/final 只由 owner 发布、六动作 complete_argv | **已删除**：动作表与 owner 提交面（`test_bootstrap_submission`/`_workflow`）随旧握手移除 | 无 | **A** | 现行替代：`start grant` 的不可变记录（同 id 同字节幂等、异字节冲突），断言在 `start-grant-mint.test.ts` |
| D-contract：过期身份重验与心跳边界（不续租） | `tests/core/test_startup_cli.py`、`tests/operators/test_operator_monitor*.py`（身份时效仍在这些活路径上断言） | 部分 | **A** | 旧 owner 租期用例随代码删除；`start grant` 的 deadline/撤销由服务端时钟判定（`start-grant-create/-spawn`） |
| D-contract：Operator gate 缺失/Coordinator 提前 idle/continuation 缺失 | **已删除**：`test_startup_handoff*` 与 `test_operator_startup` 随 lifecycle v2 移除 | 无 | **A** | 现行路径不再有 S5 gate；Run 建好后的 continuation 断言仍在 `test_coordinator_tui_*` 与 `test_startup_cli` |
| D-contract：无 Worker 分支、autonomous 缺 lifecycle 失败、native-event/manual 不发送 | `tests/coordinator/test_coordinator_tui_scheduler.py:980` | 部分 | **A** | lifecycle 侧用例随 v2 删除；`native-event` 窗口过期不转自主仍有断言，独立“无 Worker 显式分支”的负面用例未单列 |
| D-control：并发上限 | `coordinator_driver.py:310` + `tests/coordinator/test_coordinator_driver.py:783`；`supervisor/engine.py:339–352` + `tests/core/test_supervisor.py:531`、`:908` | 覆盖 | — | 含 unknown/owned/nested 计入 |
| D-control：依赖未满足 / 乱序完成不提前集成 | `supervisor/engine.py:345`、`:371–378`；`tests/core/test_supervisor.py:531`、`:556`、`:962` | 覆盖（Supervisor） | **B**（strict 侧） | strict 路径无声明 DAG，见 S2 |
| D-control：审查拒绝/返工/单写入者 | `supervisor/config.py:142–161`；`tests/core/test_supervisor.py:209`、`:556` | 部分 | **C** | 只校验“契约层”不变量；返工循环本身在 Supervisor MVP 中不支持（`docs/supervisor.md:6` 明确“不支持任务重试”）|
| D-control：pending/ACK 顺序与历史分页 | `tests/core/test_supervisor.py:601`、`:915`；`tests/coordinator/test_coordinator_tui_scheduler.py:442` | 覆盖 | — | |
| D-control：wait 超时与 pre-send 竞争 | `tests/coordinator/test_coordinator_tui_scheduler.py:463`、`:475`、`:488`、`:509`、`:529`；`tests/operators/test_operator_monitor.py:22`、`:45` | 覆盖（离线类比） | **B**（缺 I 层取证） | 真实 native 边界属 I 项，见 2.2 |
| D-control：已确认/未发生/仍未知三分支与防重 | `tests/coordinator/test_coordinator_first_dispatch.py:304`、`:316`、`:322`；`tests/coordinator/test_coordinator_tui_continue.py:245`、`:254` | 覆盖 | — | |
| D-control：Worker 失败/失联/卡住、STOP、截止期、预算耗尽 | `tests/core/test_supervisor.py:270`、`:871`、`:996`；`tests/core/test_monitor_stop_signals.py`（9 项）；`tests/core/test_observation_budget.py:30` | 覆盖（离线） | — | |
| D-control：monitor 重启/锁冲突/损坏状态不盲恢复 | `tests/coordinator/test_coordinator_tui_scheduler.py:263`、`:475`；`tests/operators/test_operator_monitor_recovery.py`（20 项） | 覆盖 | — | |
| D-control：无新事件/无进展时有界停止 | `tests/coordinator/test_coordinator_tui_scheduler.py:597`、`:952`；`coordinator_driver.py:678` | 覆盖 | — | 见 S5 |
| D-control：平台预算硬上限 | 无 | 缺失 | **C** | 仓库自述不可能由本地测试推出（reliability.md:214、`docs/supervisor.md:139`） |

### 2.2 I 层（原生集成五项）

| 项 | 离线类比 | I 层自动化 | 结论 | 缺口性质 |
| --- | --- | --- | --- | --- |
| `I-gate-expiry` | `tests/coordinator/test_coordinator_first_dispatch.py:93`、`:235`、`:244`、`:252`、`:284` | 无 | 缺失（离线类比不代表 I） | **B**（缺取证脚本） |
| `I-wait-boundary` | `tests/coordinator/test_coordinator_tui_scheduler.py:318`、`:450`；`tests/operators/test_operator_monitor.py:45` | 无 | 缺失 | **B** |
| `I-presend-race` | `tests/coordinator/test_coordinator_tui_scheduler.py:463`、`:509`、`:529`；`tests/coordinator/test_coordinator_tui_continue.py:229`、`:775` | 无 | 缺失 | **B** |
| `I-pending-history` | `tests/coordinator/test_coordinator_tui_scheduler.py:435`、`:442`；`tests/operators/test_operator_monitor.py:204` | 无 | 缺失 | **B** |
| `I-unknown-result` | `tests/coordinator/test_coordinator_first_dispatch.py:304`、`:452`；`tests/core/test_supervisor.py:280`、`:374`、`:924` | 无 | 缺失 | **B** |

**结论：五项 I 全部没有可执行脚本或自动化取证入口。** `swarm/docs/validation/current.md:60`
的记录也印证这一点（`terminal-wait-boundary`、`presend-race` 在该 Run 记
`BLOCKED_NOT_PASS`）。仓库里唯一接近“真实原生输入”的自动化是
`tests/core/test_tui_rsi_integration.py`，但它被 `RSI_CHECKER_TEST_ROOT` 门控（:21），
且自我限定为只读投影、无 native 写入（:3–5），属 D 层夹具而非 I 项。

### 2.3 L 层（真实 Agent 闭环）

| 用例 | 是否有可执行夹具/脚本 | 结论 | 缺口性质 |
| --- | --- | --- | --- |
| L-flow / L-collaboration / L-events.busy | 无脚本，只有协议文本（reliability.md 第 4 节自述“不声称已有一键脚本”） | 缺失 | **B**（缺操作脚本与执行记录） |
| L-events.worker-idle / external-idle | 有受控屏障的**协议**（reliability.md 屏障规则）与历史尝试记录，无脚本 | 缺失 | **B** |
| L-safety.worker-failure / stop / monitor-restart | 有离线故障夹具（`tests/core/test_monitor_stop_signals.py`、`tests/operators/test_operator_monitor_recovery.py`），无真实闭环 | 缺失（真实侧） | **B** |

按 `swarm/docs/validation/current.md`，最近一次 Run `run_70dcf6e13fcd` 的完整 suite
是 `NOT_CLAIMED`，其中 live-1/4、TTL、monitor-restart 仍“未重新评定”（:38–50 的表）。

## 3. 七个 Swarm 专属场景矩阵

### S1 跨域升级（domain mismatch → escalation）

**先澄清命名（重要）.** 本仓库中 “domain” 不是“专业领域”，而是**领域适配器 /
domain-checked checkpoint**（如 `coordinator_loop.py:37`、`coordinator_tui_errors.py:33–36`
的 `revalidate_domain`）。因此“跨域升级”在本仓库对应两个不同机制，本文件按下列口径判定
（该映射属**推测**，非仓库既有术语）：

- S1a：Worker 的提问/请求**越出原授权域**，必须升级到人类/Operator，且升级不自动授予新权限。
- S1b：角色/路径/身份域不匹配时拒绝（属 D-contract，不是 agent 间升级）。

| 子项 | 代码机制 | 现有证据 | 状态 | 缺口性质 |
| --- | --- | --- | --- | --- |
| S1a 越域升级路由（Supervisor） | `supervisor/engine.py:260–285`：`question`/`escalation` 只允许 `action=reply` + `within_scope is True`；否则写 `human:<id>` 与 `human_messages` 并在 ACK 前提交；注释明确“acknowledgment 与 human authorization 是两个状态”（:233–235） | `tests/core/test_supervisor.py:611`（人工门持久化、不绕过权限）、`:623`（一个人工问题不阻塞后续独立问题）、`:639`（重启后仍需授权）、`:661`（ACK 前持久化）、`:701`（不重复/不部分解决）、`:741`（不连带 ACK 同批未知消息）、`:755`（未解决人工问题阻止整体完成）、`:953`（已解决记录） | 覆盖（Supervisor） | — |
| S1a 越域升级（strict 原生路径） | `coordinator_loop.py:22` 仅在提示文本里声明“Operator owns … escalation”；`coordinator_tui_scheduler.py` / `coordinator_tui_continue.py` 中检索无 `question`/`escalation` 处理分支 | 无 | 缺失 | **B**（代码未实现） |
| S1b 域不匹配拒绝 | `tests/bootstrap/test_bootstrap_production.py:393`（错误角色与路径）、`:555`（只读域阻止写入并恢复截止期）；`tests/coordinator/test_coordinator_handoff.py:226`（outside_scope 先拒绝再读内容） | 同上 | 覆盖（离线） | — |

**缺口.** strict 路径没有把 Worker 的 `question`/`escalation` 与 `within_scope` 判定
落成代码或测试；该路径完全依赖模型与 Operator 自觉（`coordinator_loop.py:22` 只是提示文本），
也没有“越域请求不得被 Coordinator 自行答复”的负面用例。**这是 S1 的主要风险点。**

### S2 循环委托（cyclic / repeated delegation）

| 子项 | 代码机制 | 现有证据 | 状态 | 缺口性质 |
| --- | --- | --- | --- | --- |
| S2a 声明式依赖环（Supervisor DAG） | `supervisor/config.py:110–113`：要求拓扑序，错误串含 `missing dependency or cycle` | `tests/core/test_supervisor.py:209`（`depends_on=["b"]` 反向依赖被拒，:217） | 覆盖 | — |
| S2b 运行期“空转环”（换名字/换 id 反复委派同一工作） | `coordinator_tui_scheduler.py` 的 `consecutive_without_acceptance_advance`；`coordinator_driver.py:678` `no_progress_recovery_exhausted` | `tests/coordinator/test_coordinator_tui_scheduler.py:597`（3 次后 `tui_scheduler_no_acceptance_progress`，且要求人工 `scheduler_review_clear`）、`:952`（复用执行证据停止）、`:911`（重新声明不重置计数）；`tests/coordinator/test_coordinator_driver.py:852`、`:913`、`:1056`、`:1064` | 覆盖（离线） | — |
| S2c 嵌套/自派发（Worker 再启动 Worker 形成委派链） | `coordinator_driver.py:310` 上限、`:489` 文本“Workers (including unknown/remote/nested) share max_workers” | `tests/coordinator/test_coordinator_driver.py:783`（17 个未知 owned worker 触发 `worker_limit_exceeded`） | 部分 | **A** |
| S2d 语义环的事前拒绝 | 无。strict 路径没有声明的委派图 | 无 | 缺失 | **B**（无该机制） |

**缺口.** 事前无法区分“合法的迭代返工”与“A→B→A 的语义环”，只能在无进展计数触发后停止；
代价是已经发生的回合与费用。也没有“Worker 反向委派回 Coordinator/自身”的用例。

### S3 上下文饱和（context saturation）

| 子项 | 代码机制 | 现有证据 | 状态 | 缺口性质 |
| --- | --- | --- | --- | --- |
| S3a 启动参数饱和 | `coordinator_strict.py:23` `MAX_AGENT_ARGS_BYTES = 16 KiB`、`:27` `MAX_PINNED_INPUT_BYTES = 256 KiB`、`:171–179` 拒绝而不截断、`:183` `prompt_delivery = "pinned-files-short-prompt-v1"` | `tests/coordinator/test_coordinator_strict.py:121`（无截断拒绝）、`:136`（10 万字符交接仍保持 argv 有界） | 覆盖 | — |
| S3b 读取侧容量 | 刻意为**取消**固定字节上限：`log-capacity.md` 的整张表（trae_coordinator 16 MiB→无、native_preflight 4 MiB→无、progress_watch 8 MiB→无、swarm_ledger 128 MiB→无、Supervisor receipt 16 MiB→无） | `tests/core/test_capacity_io.py:33`（17 MiB 证据全文读取）、`tests/core/test_supervisor.py:849`（>10 MB artifact）、`tests/core/test_binding.py:425`、`:433` | 覆盖（“能读得动”） | **C**（已按设计覆盖） |
| S3c 回合/上下文总量饱和 | 无。`trae_coordinator.ContextFreshnessError`（:40–47）只管新鲜度与“是否未来”，不管大小；`bootstrap_events.py:99` 的 `context_max_age_seconds` 同样是时间 | 无 | 缺失 | **B**（无该机制） |
| S3d 饱和后的降级行为（压缩/交接/拒绝） | 无定义 | 无 | 缺失 | **B**（无该机制） |

**这是本矩阵最明确的缺口.** 仓库主动移除了所有读取字节门槛，`log-capacity.md` 末段自己写明
“超大输入仍可能遇到内存、磁盘、操作系统、原生 API 或既有执行时限，发生时应报告真实错误，
不伪称完整覆盖”。也就是说：容量风险被**显式接受**，但没有任何用例验证“饱和时的行为”。

### S4 共享状态并发冲突

| 子项 | 代码机制 | 现有证据 | 状态 | 缺口性质 |
| --- | --- | --- | --- | --- |
| S4a 单写入者文件锁 / CAS | `coordinator_io.py`（`exclusive`/`pinned`/`publish_new`）；`bootstrap_control` 的 owner 锁 | `tests/coordinator/test_coordinator_io.py:38`、`:43`、`:52`、`:72`、`:81`、`:95`；`tests/bootstrap/test_bootstrap_control.py:192`（固定 owner 锁排除第二 authority）、`:96`、`:127` | 覆盖 | — |
| S4b 并发认领/单实例 | `tests/core/test_authority_bundle.py:282`（并发认领失败者不发布失败）、`tests/core/test_supervisor.py:299`（单实例锁）、`:1069`（锁争用跳过不算失败） | 同上 | 覆盖 | — |
| S4c monitor/scheduler 多写者 | `tests/operators/test_operator_monitor.py:395`（配置变更与多写者拒绝）、`:404`（第二 monitor 拒绝）；`tests/coordinator/test_coordinator_tui_scheduler.py:263`（真实锁忙 + 重启） | 同上 | 覆盖 | — |
| S4d 计划层所有权不重叠 | `supervisor/config.py:157–161`（共享 exact 工作区必须有序；并行任务路径必须不重叠） | `tests/core/test_supervisor.py:209`；`tests/coordinator/test_coordinator_worker_plan.py:160`、`:178` | 覆盖 | — |
| S4e 运行期跨 Agent 共享状态冲突 | 无。strict 路径的 `max_workers` 只是数量上限（`coordinator_driver.py:310`），`progress_watch.py:451` 在占用超限时只报警；路径所有权依赖提示与 Operator 判断 | 无 | 缺失 | **B**（无该机制） |

**缺口.** reliability.md 的 L-collaboration 要求“隔离 worktree 或明确无冲突文件所有权”，
但没有任何自动化检查“两个 Worker 是否真的写了同一文件/同一工作区”。冲突只能在
L 层人工观察，或事后由 `do_not_touch` 证据校验发现（Supervisor `engine.py:161–163`）。

### S5 token 失控与无终止

| 子项 | 代码机制 | 现有证据 | 状态 | 缺口性质 |
| --- | --- | --- | --- | --- |
| S5a 准入式预算（每次启动预留） | `supervisor/store.py:127–160`：`admission` + `_reserve`，run/service/period 三个上限，micro-USD 预留，幂等 | `tests/core/test_supervisor.py:240`、`:261`、`:270`、`:336`、`:871`、`:908`、`:1103`、`:1215` | 覆盖 | — |
| S5b 截止期与有界等待 | `coordinator_driver.py:93`（`max_no_progress_turns` 等）、`supervisor/engine.py:422`（`max_round_seconds`）、`observation_budget.py:21`（`TURN_END_SECONDS = 60`） | `tests/core/test_observation_budget.py:30`、`:59`、`:155`；`tests/coordinator/test_coordinator_tui_continue.py:466` | 覆盖 | — |
| S5c 无进展停止 | 见 S2b | 同上 | 覆盖 | — |
| S5d 单回合内 token 暴涨的硬停止 | 无。`docs/supervisor.md:139`：“当前没有 provider 每请求 token 上限、硬账单截断或自动中止运行中模型……预留并不能保证真实花费不超额”；`reliability.md:214`：平台预算硬上限“不能由本地计数测试推出已生效” | 无 | 缺失 | **C**（已自述边界） |
| S5e 预算暂停对在途 Worker 的语义 | `docs/supervisor.md:139`：“预算暂停不取消/释放正在运行的 Worker” | `tests/core/test_supervisor.py:871`（预算阻止新启动但允许清理） | 覆盖（语义）／缺失（真实在途） | **C**（缺失侧） |

**缺口.** 本仓库的“防失控”是**准入式**的：每次启动前预留、超限不启动。它对
“一次启动内跑爆”没有防线，且这一点是文档自述的设计边界，不是实现缺陷。
测试策略不能假装覆盖了它，只能标注为外部额度依赖。

### S6 跨 agent 提示注入

| 子项 | 代码机制 | 现有证据 | 状态 | 缺口性质 |
| --- | --- | --- | --- | --- |
| S6a 不可信正文与决策分离 | `supervisor/__main__.py:137–141`：只有 `coordinator-inbox` 才输出 `untrusted_saved_delivery` / `untrusted_human_messages` / `untrusted_native_messages` / `untrusted_native_tasks` | `tests/core/test_supervisor.py:1248`（`status` 输出不含私有正文原文） | 覆盖 | — |
| S6b 跨 agent 传递面收敛 | `supervisor/engine.py:186–187`：evidence 只保留白名单字段；`supervisor/config.py:196` “Pass only this contract plus immutable upstream evidence, never chat history” | `tests/core/test_supervisor.py:232`（contract 只含 scope 不含对话）、`:836`（证据范围与保留） | 覆盖（结构） | — |
| S6c 外域/只读消息不参与决策 | `supervisor/engine.py:242`（foreign/read-only message 拒绝）、`:291`（未知类型不静默消失） | `tests/core/test_supervisor.py:827`（native completion 不是验收）、`:578`（foreign tasks fail closed） | 覆盖 | — |
| S6d 输出侧脱敏 | `tests/core/test_safety.py:169`、`:195`；`tests/core/test_progress_watch.py:399` | 同上 | 覆盖 | — |
| S6e “正文当数据、不当指令”的语义测试 | 无。白名单字段里的 `risks` 是**自由文本**（`supervisor/engine.py:187` 的 clean 集合含 `risks`），会原样进入下游 `prerequisites`（`engine.py:374–378` → `config.py:196–217`） | 无 | 缺失 | **A**（代码行为确定） |
| S6f strict 路径的注入面 | 完全靠提示约束；`coordinator-strict-start.md:298` 自述“结构化 flag 检查并不证明任意正文没有冲突指令” | 无 | 缺失 | **C**（已自述边界） |

**缺口.** 结构性隔离（谁能看到什么）已覆盖；**语义抗注入（看到之后不被说服）完全没有覆盖**。
唯一的跨 agent 自由文本通道 `risks` 既是必要交付物，也是天然注入面，需要单独的
“当作数据”的负例。该判断为分析结论，仓库中无对应测试可引用。

### S7 下游错误传播

| 子项 | 代码机制 | 现有证据 | 状态 | 缺口性质 |
| --- | --- | --- | --- | --- |
| S7a 审查失败阻断下游（Supervisor） | `supervisor/engine.py:193–195`：`verdict=fail` → `blocked:<key>`（`acceptance_failed; manual re-plan required`）；`:345` 派发要求所有依赖 `verdict == "pass"` | `tests/core/test_supervisor.py:556`（失败验收阻断依赖但释放资源）、`:962`（冲突阻断唤醒、不重试、不预留）、`:827`（原生完成不是验收） | 覆盖 | — |
| S7b 失败不放行依赖（strict） | `coordinator_loop.py:203`（本地阻塞不得掩盖独立授权工作）、`:212–213`（blocked 需边界与替代方案证据） | `tests/coordinator/test_coordinator_loop.py:77`、`:86`、`:95`、`:101`、`:160`；`tests/coordinator/test_coordinator_tui_scheduler.py:971`（wait 依赖缺失即停并转复核） | 覆盖（离线） | — |
| S7c 失败不被误报为成功/不可重试 | `tests/coordinator/test_coordinator_first_dispatch.py:452`（失败原生回执不是成功且不可重试）；`tests/coordinator/test_coordinator_handoff.py:163`、`:185` | 同上 | 覆盖 | — |
| S7d 通过产物携带的语义错误向下游传播 | 只有静态校验：`supervisor/engine.py:161–183`（路径必须在 allowed_paths、`do_not_touch` 未被动、SHA 必须匹配、测试退出码必须为 0）；`engine.py:185` 只校验“pass 必须建立在成功且有 0 退出码的测试之上” | 无 | 缺失 | **A**（静态面外的语义面无用例；其中“验证 Git 内容等同证据声明”本身属 C，见 §7） |
| S7e 上游中途崩溃留下的脏工作区是否阻断下游 | `supervisor/` 启动前检查基线干净（`tests/core/test_supervisor.py:1124`、`:1183`） | 同上 | 部分 | **A** |

**缺口.** 现有防线是“回执层面的 verdict 级联”，不是“产物语义级联”：
上游通过验收但产物在语义上错误（例如只改了测试、或覆盖范围绕开了 `do_not_touch` 的等价文件），
下游会照常消费。这类风险只能在 L 层用真实缺陷版本验证（reliability.md:117 的
“可将含已知缺陷的隔离测试版本交独立审查”正是为此设计），而 L 层本轮未执行。

## 4. 覆盖统计

整包：82 个测试模块 / 1889 个 `def test_`；`unittest` 展开 subTest 后报 **2225 项**
（实测，见第 6 节；差额来自 subTest 与动态生成用例，因此下文计数以模块为单位，不做整包加总）。按主层归类（一个模块只记一次，不重复计数）：

| 层 | 代表模块与用例数 | 小计 | 该层判定 |
| --- | --- | --- | --- |
| L1 | `coordinator_io` 11、`worker_plan` 19、`write_roots` 4、`creation_time` 3、`log_io` 3、`capacity_io` 2、`observation_budget` 12、`worker_profiles_external` 5、`safety` 29、`runtime_binding` 24、`worker_usage_preserve` 7 | 119 | 覆盖 |
| L2 | `tui_continue` 55、`tui_scheduler` 55、`operator_monitor` 27、`coordinator_driver` 89、`progress_watch` 72、`operator_startup` 33、`monitor_recovery` 20、`monitor_upgrade` 24、`monitor_deploy` 27 | 402 | 覆盖 |
| L3 | `strict_start` 42、`strict_request` 31、`strict_delivery` 24、`strict_prepare` 18、`strict` 23、`startup_handoff` 38、`coordinator_handoff` 22、`authority_bundle` 19、`native_preflight` 24、`bootstrap_*` 157、`operator_prepare` 21、`operator_materials` 6 | 445 | 覆盖 |
| L4-offline | `supervisor` 103、`coordinator_loop` 20、`coordinator_background` 16、`monitor_stop_signals` 9、`evidence_archive` 9 | 157 | 部分（缺原生侧与真实协作） |
| L4-native | 无自动化 | 0 | 缺失 |
| L5 | 无自动化；`tui_rsi_integration` 3 项被 `RSI_CHECKER_TEST_ROOT` 门控且非 L 层 | 0 | 缺失 |
| L6 | 无 | 0 | 缺失 |
| L7 | 分散在 L1–L4（I-1…I-11 见 strategy.md 第 3 节），无独立套件 | — | 部分（I-12 无正例） |

未计入上表、跨层归属的模块（约 700 项）：`trae_*`（`trae_jsonl` 57、`trae_coordinator` 38、
`trae_ledger` 34 等）、`binding` 33、`ledger` 38 + `ledger_binding_coverage` 9 + `report` 8、
`operator_session` 18、`operator_trust` 14、`operator_continuity_source` 24、
`terminal_idle_*` 39、`coordinator_prepare` 31、`coordinator_state` 19、`startup_cli` 17 等。
它们主要服务 L1/L2 与 L7 的 I-6/I-8/I-11，不改变上表结论。

### 4.1 按缺口性质汇总（回答“是不是代码缺失”）

上表与第 2、3 节共标出 **25 条**「部分/缺失」，按 §1.1 的性质分布如下：

| 性质 | 条数 | 条目 | 含义与处置 |
| --- | --- | --- | --- |
| **A 纯测试缺口** | 6 | 2.1「Operator gate 缺失/提前 idle」；2.1「无 Worker 分支」；S2c 嵌套委派；S6e `risks` 语义；S7d 语义级联；S7e 脏工作区 | 代码已就位，补用例即变绿（backlog B1/B2） |
| **B 能力/工具未实现** | 14 | S1a strict 越域升级；S2d 语义环；S3c 上下文总量；S3d 饱和降级；S4e 运行期冲突；2.1「依赖/乱序 strict 侧」；I 层五项；L 层三项 | **这部分才是真正的代码/工具缺失**；用例会先变红（backlog B3-1/B3-2/B4） |
| **C 设计边界** | 5 | 2.1「审查拒绝/返工」（MVP 不支持）；2.1「平台预算硬上限」；S5d 单回合 token 停止；S5e 在途 Worker 语义；S6f strict 注入面 | 文档已自述为边界，只能 PIN 现状；不得在报告里描述为待修缺陷（backlog B3-3、第 5 节） |
| **C（已覆盖）** | 1 | S3b 读取容量取向（已按设计覆盖） | 不产生缺口 |

**一句话结论.** 25 条里只有 **14 条属于“代码/工具没写”**（主要是 strict 路径的五项编排机制、
I 层取证脚本、L 层操作脚本），**6 条只是“没写用例”**，**5 条是仓库已经接受的边界**。
将这三类混称“代码缺失”会同时导致两种错误：把 C 类当成待修缺陷，
或把 A 类当成需要设计变更。

## 5. 场景 × 层 总表

| 场景 | L1 | L2 | L3 | L4-off | L4-nat | L5 | L6 | L7 | 主缺口性质 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 跨域升级 | — | — | 部分（域不匹配拒绝） | 部分（仅 Supervisor） | 缺失 | 缺失 | — | 部分（I-12） | **B** |
| S2 循环委托 | 覆盖（DAG 无环） | 覆盖（无进展停止） | 部分 | 部分 | 缺失 | 缺失 | — | 覆盖（I-9） | **A + B** |
| S3 上下文饱和 | 部分（启动参数） | 部分（读取无上限） | — | — | 缺失 | 缺失 | — | 缺失 | **B**（＋C 取向） |
| S4 共享状态并发 | 覆盖（锁/CAS） | 覆盖（单写者） | 部分 | 部分（静态所有权） | 缺失 | 缺失 | — | 部分（I-10） | **B** |
| S5 token/无终止 | 部分（预算语义） | 覆盖（有界等待） | — | 部分（准入） | 缺失 | 缺失 | 缺失（外部额度） | 部分（I-6） | **C** |
| S6 提示注入 | — | 部分（脱敏） | 部分（正文隔离） | 部分（字段白名单） | 缺失 | 缺失 | — | 缺失（I-12） | **A + C** |
| S7 下游错误传播 | — | 覆盖（失败不放行） | 部分 | 覆盖（verdict 级联） | 缺失 | 缺失 | — | 部分 | **A** |

**总计 7 个场景里，0 个达到“全层覆盖”，3 个（S2、S4、S7）在离线编排层基本成立，
S1/S3/S6 存在结构性缺口，S5 的缺口是文档自述的设计边界。**

按性质看（§4.1）：**S7 基本只是缺用例（A）**；**S2 是 A+B 混合**（DAG 与无进展停止已实现，
差语义环）；**S1、S3、S4 的主要缺口是机制未实现（B）**；**S5 完全是已接受的设计边界（C）**；
**S6 是 A+C**（结构隔离已实现且已测，语义抗注入既是缺用例也受“靠提示约束”的边界限制）。

## 6. 本轮实跑记录（离线基线）

唯一执行的命令（`field-guide/index.md:8` 的同一命令），2026-11-05 +08:00：

```bash
cd swarm-orca/swarm
# 1) 直接用当前 shell 环境
python3 -m unittest discover -s tests
# → Ran 2225 tests in 1199.844s
#   FAILED (failures=31, errors=8, skipped=18)

# 2) 清除环境中的 SWARM_WORKER_PROFILES
env -u SWARM_WORKER_PROFILES python3 -m unittest discover -s tests
# → Ran 2225 tests in 1244.329s
#   OK (skipped=18)
```

**结论与操作含义.**

1. 39 项 `FAIL/ERROR` 全部落在 `tests/coordinator/test_coordinator_worker_plan.py`，根因是该模块用
   `file_ref(PROFILES)` 计算 pin，而 `coordinator_worker_profiles.resolve()`（:20–24）优先读
   环境变量 `SWARM_WORKER_PROFILES`；本工作区该变量指向私有
   `swarm/worker-model-profiles.json`，与 bundled 文件不同字节，于是 `coordinator_io.pinned`
   （:88–97）抛 `file_pin_changed`。**这不是被测逻辑缺陷**：`tests/coordinator/test_coordinator_worker_plan.py`
   单模块在清除该变量后 19 项全过（实测）。
2. 该行为与 AGENTS.md 第 5 行的要求一致（新入口必须**显式**选择模型/runtime 配置和
   `SWARM_WORKER_PROFILES`），但 `field-guide/index.md:8` 只写了命令、未写环境前提，
   这是**文档与可复现性的冲突**，已在 strategy.md 第 5 节显式标注。
3. 18 项 skip 全部是显式门控，不是失败：`tests/operators/test_operator_authority.py:22`（15 项，
   需 `RSI_CHECKER_TEST_ROOT`）+ `tests/core/test_tui_rsi_integration.py:21`（3 项，同）。
   即真实 RSI checker 的真实输入投影在本环境**未被执行**，属证据缺口。

**未执行的事.** 未启动任何 Run/Worker/terminal，未部署、未重启、未注入故障、未发消息、
未跑远端命令；除上述两条离线命令外只做了只读文件读取。

## 7. 与既有口径的冲突/澄清

1. **`field-guide/index.md:8` 说“无联网测试”，但未说明环境变量前提。** 实测证明该命令的
   可复现性依赖 `SWARM_WORKER_PROFILES` 的取值。以仓库既有口径（AGENTS.md 第 5 行、
   `configuration.md`）为准：显式选择配置是要求，不是可选项；因此文档应补前提，而非取消隔离。
2. **`log-capacity.md` 与“容量测试”的取向冲突（已由仓库自身说明）。** 该文件取消了固定
   字节上限并明确“不设固定字节门槛不意味着资源无限”。本矩阵因此把“容量”判为 S3b 覆盖、
   S3c/S3d 缺失，而不是判“已覆盖”。
3. **Supervisor 的“不支持任务重试”（`docs/supervisor.md:6`）与 reliability.md D-control
   要求的“拒绝后返工”不是同一能力。** Supervisor 用 `blocked:<key>` + 人工重新规划替代自动返工
   （`supervisor/engine.py:193–195`）；strict 路径的返工只在 L 层验证。不得用 Supervisor
   的阻断用例为 strict 返工背书（reliability.md:216–217）。
4. **`current.md` 的 `PASS_CURRENT_RUN` 不等于本文件的“覆盖”。** 前者是某次 Run 的结果状态，
   后者是静态资产映射；两者不可互换。
5. **本文件的「缺失」不是“代码缺失”的同义词。** 它只说明“该场景的判据无自动化断言”；
   成因分 A（仅缺用例）/B（能力或工具未实现）/C（仓库已接受的设计边界），见 §1.1 与 §4.1。
   在报告、backlog 或需求描述中把三者混称“代码缺失”，会造成把 C 当缺陷修、
   或把 A 当成需要设计变更的误判。

---

**版本与时间.** 本轮基于以下版本读取与撰写（只读）：

- 主仓库 `swarm-testing-research` 分支：`4aea12aa57fcf4ddcde23d0f6d3dfc8edb6ea955`
  （基于 `dev_liuliu`），工作区无未提交改动。
- 子模块 `swarm`：`59701600e43a140a82fb3b744ee725fc9740cdac`（`remotes/origin/dev_liuliu`）。
- 子模块 `swarm-orca`：`e0dfc6810d5a9079cfa0bb733426e8b6723c249f`（`heads/main`）。
- 读取时间：2026-11-05 11:0x–12:5x +08:00（Asia/Shanghai）。
- 本轮只做分析与文档：未运行任何真实 Swarm Run，未创建 Run/Worker/terminal，
  未部署、未注入故障、未执行远端命令，未改代码（未修改任何 `.py` 或既有测试文件）。
  唯一执行的是离线 `unittest` 基线命令，结果见第 6 节。
