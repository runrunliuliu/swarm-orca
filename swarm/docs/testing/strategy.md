# Swarm 分层测试策略（L1–L7）

本文件是[测试与验收指南](reliability.md)（标准 ID `swarm-reliability-v2`）的**编目补充**，
不是新标准，也不替换其 D/I/L 验收口径。它只回答一个工程问题：把仓库里已有和缺失的
测试资产，映射到一组可操作的分层，并说明每层的用例构造、跑法与门禁。

阅读顺序：先读 [reliability.md](reliability.md) 的分层与通过条件，
再用本文件决定“这次改动该补哪一层”。两者冲突时**一律以 reliability.md 为准**，
本文件中标注为「编目」的内容不产生新的通过判定。

本文只回答“该补哪一层、怎么跑、卡在哪”。每条缺口的**成因分类**（A 仅缺用例／
B 能力或工具未实现／C 已接受的设计边界）在 [gap-matrix.md](gap-matrix.md) §1.1 定义、
§4.1 汇总；分类不改变任何门禁或通过条件。

## 1. 范围与不越权

- 覆盖对象：`swarm-orca/swarm/` 下 strict bootstrap → Coordinator TUI → Operator
  lifecycle / monitor / scheduler 控制链，固定 DAG Supervisor MVP（`supervisor/`），
  以及 `swarm_ledger/` 的用量采集。私有 `swarm/` 只作为历史与冻结口径引用。
- 本文件**不授权**启动 Agent、创建 Run/Worker、远端修改、故障注入、重启或训练；
  与 reliability.md 第 6 行、第 6 节同一措辞。
- 本文件**不声称**任何子场景已实现或已运行。层内“现有入口”只表示该文件是本层
  的回归入口示例，正与 reliability.md:38「现有测试文件只是回归入口示例」
  的口径一致。

## 2. 与仓库既有三类验收口径的对齐

reliability.md 第 32–34 行定义了唯一的三类验收层。本文件的 L1–L7 是对它的**细分**，
不新增第四个验收层：

| 本文件层 | 归属验收层 | 与 reliability.md 的关系 |
| --- | --- | --- |
| L1 单元、L2 单 agent 行为、L3 契约 | D：确定性回归 | D 的内部结构；可 mock、受控时钟、故障夹具（reliability.md:32） |
| L4 编排（离线子集） | D：确定性回归（D-control 主体） | 多动作/多 Worker 的顺序与归属；离线通过不等于原生通过 |
| L4 编排（原生子集） | I：原生集成 | 即 reliability.md:191–203 的 `I-gate-expiry` / `I-wait-boundary` / `I-presend-race` / `I-pending-history` / `I-unknown-result` |
| L5 端到端 | L：真实 Agent 闭环 | 即 reliability.md 第 4 节的 L-flow / L-collaboration / L-events / L-safety，判据不改写 |
| L6 评估 | 不属 D/I/L | reliability.md:20 已把 RSI 研究/训练收益与业务收益排除在核心 suite 之外；L6 是那一侧的执行面 |
| L7 不变量 | 横切 D 为主，L 复核 | 每条不变量在 D 层有可复现回归，在 L 层有闭环复核；单独成层只因为它们跨模块 |

对照后的三条硬规则（与 reliability.md 完全一致，此处只复述以便落地）：

1. 离线 mock 通过不得升级为 I 或 L 通过（reliability.md:28、56）。
2. 完整核心 suite PASS 的门槛是 reliability.md:51–55 的必测项全集加共享收尾，
   本文件任何 L 层的“全绿”都不构成该声明。
3. 报告状态仍只用 reliability.md 第 8 节的 `NOT_RUN` / `NON_HIT` / `PARTIAL` /
   `BLOCKED` / `FAIL` / `PASS`，不新增状态词。

## 3. 分层定义

### L1 · 单元

**测什么.** 无 I/O 副作用的纯逻辑：JSON 规范化与哈希、pin 校验、路径规范化、
字段白名单、时间与截止期换算、错误码映射、DAG 拓扑与所有权校验。

- 代表实现：`coordinator_io.py`（`canonical`:24 / `digest`:29 / `pinned`:88 / `file_ref`:100）、
  `coordinator_worker_profiles.py`（固定 profile 解析）、`coordinator_creation_time.py`、
  `log_io.py`、`coordinator_tui_dependencies.py`（`wait_spec`）、
  `coordinator_write_roots.py`、`supervisor/config.py`（:95–176）。

**怎么造用例.** 直接调用函数，输入用 `dict`/字节构造，非法分支用 `subTest` 枚举类型
边界（`True` vs `1`、`None` vs `""`、NUL、相对路径、前缀兄弟目录、符号链接）。
此类用例当前密度最高，例如 `tests/coordinator/test_coordinator_worker_plan.py:43` 用 6 字段 ×
4 非法值枚举，`tests/core/test_binding.py:329` 覆盖 uid/可执行位/根目录。

**跑法.**

```bash
cd swarm-orca/swarm && env -u SWARM_WORKER_PROFILES python3 -m unittest discover -s tests -v
```

**门禁 G1.** 改动任何被 L1 覆盖的模块，其所属测试文件必须全绿；新增非法分支必须
同时新增拒绝码断言（拒绝码本身就是契约，见 L3）。

### L2 · 单 agent 行为

**测什么.** 一个控制器自身的状态机与副作用边界，不涉及第二个 Agent：
Coordinator 回合的 `enqueue → claim → settle → ACK`、scheduler 单 tick 的判定、
monitor 单 tick 的观察与事件去重、driver 的回合续接与 `no_progress` 计数、
Operator 生命周期阶段、bootstrap 单侧准入。

- 代表入口：`tests/coordinator/test_coordinator_tui_continue.py`、`tests/coordinator/test_coordinator_tui_scheduler.py`、
  `tests/operators/test_operator_monitor.py`、`tests/coordinator/test_coordinator_driver.py`、
  `tests/core/test_progress_watch.py`、`tests/operators/test_operator_startup.py`、
  `tests/bootstrap/test_bootstrap_control.py`。

**怎么造用例.** 临时目录 + FakeNative/fake CLI（记录 argv 并回放固定回执）+
临时把时钟注入（例如 `Store(root, clock=lambda: ...)` 见 `tests/core/test_supervisor.py:1249`）+
显式状态文件断言（`read_json(state/"scheduler.json")`）。
关键约束来自 reliability.md:32：可以 mock 与受控时钟，**只能证明被测逻辑**。

**断言风格（本节对所有层都适用）.** 断言“事件序列 / 状态投影 / 持久记录”，
不断言“最终文本”。可用判据举例：`self.m.messages` 的条数与顺序
（`tests/coordinator/test_coordinator_tui_scheduler.py:597` 断言三次发送后不再新增）、
`stop["reason"]`、`consecutive_without_acceptance_advance`、
`execution_stalled` 事件、outbox/journal 字节不变（同文件 :606）。

**跑法.** 单文件或单测试（`tests` 在 `PYTHONPATH` 上，`offline_env` 等共享 helper 才能导入）：
`PYTHONPATH=.:tests python3 -m unittest tests.coordinator.test_coordinator_tui_scheduler -v`。

**门禁 G2.** 行为分支变更必须给出“正常 + 拒绝 + 恢复”三段序列断言；只断言最终返回码
不算通过。

### L3 · 契约

**测什么.** 跨进程/跨角色的**文件与回执契约**：schema 版本与字段集、候选/最终发布的
双 pin、原子发布与 `fsync` 语义、authority bundle 的版本与不可变、
strict-config request/ready/review 顺序、continuation-ref 与 checkpoint head 的
归属、以及“不得静默升级/回退”的拒绝面。

- 代表实现：`coordinator_strict_delivery.py`、`coordinator_strict_request.py`、
  `coordinator_strict_start.py`、`bootstrap_submission.py` 对应的
  `tests/bootstrap/test_bootstrap_submission.py`、`coordinator_authority_bundle.py`、
  `coordinator_tui_prepare.py`、`operator_startup.py`。
- 代表用例：`tests/bootstrap/test_bootstrap_submission.py:47`（禁止直写最终槽）、
  `:104`（候选 SHA 与发布前复检）、`tests/core/test_authority_bundle.py:307`（配置降级拒绝）、
  `:354`（两个合法 bundle 不可混用）、`tests/coordinator/test_coordinator_strict_delivery.py`（24 项）。

**怎么造用例.** 先生成合法 pin，再逐项破坏：字节改写、canonical 重排、
symlink/hardlink、时间戳伪造、schema 降级、跨 owner 复用回执、重复 pull。
这类用例的价值在**拒绝码**而非返回码，因此必须断言具体错误字符串
（如 `file_pin_changed`、`strict_start_max_workers_required`、
`tui_wait_dependencies_required`）。

**跑法.** 同 L2。

**门禁 G3.** 任何契约字段集变化，必须同时改动（a）实现（b）L3 用例（c）对应
`.md` 契约文档（如 `coordinator-strict-start.md`、`strict-bootstrap-protocol.md`）。
只改实现的提交视为未通过门禁。

### L4 · 编排

**测什么.** 两个以上动作或 Worker 之间的顺序、归属与终止条件：
并发上限、依赖未满足、乱序完成、审查拒绝与返工、单写入者集成、唤醒去重、
ACK 顺序与批次、STOP/失败向后续动作的传播、无进展时的有界停止。

L4 有两个不可互换的子集：

- **L4-offline（属 D）**：用夹具驱动的多动作编排。
  Supervisor MVP 的 FakeNative 双 Worker wave → 独立 Review → 串行 Integration
  （`tests/core/test_supervisor.py:531`、`:556`）；scheduler 的两个完整自动续跑
  （`tests/coordinator/test_coordinator_tui_scheduler.py:153`、`:173`）；driver 的多回合
  （`tests/coordinator/test_coordinator_driver.py:332`）。
- **L4-native（属 I）**：真实 runtime/CLI 的受控时序，即 reliability.md:191–203 的
  五项目。当前仓库**没有任何自动化脚本**对应这五项（见 [gap-matrix.md](gap-matrix.md)），
  只能按 reliability.md 第 5 节人工取证。

**怎么造用例.** 离线侧：FakeNative 记录 argv 与回执序列，用“第 n 次轮询返回不同状态”
模拟乱序；用 `patch.dict(os.environ, ...)` 注入身份变化；用真实文件锁制造竞争。
原生侧：必须在隔离且获准的真实资源上，脚本可控制时序但不得伪造原生接受回执
（reliability.md:33、191）。

**跑法.** 离线同 L2；原生按 reliability.md 第 5 节（:191–203 的表），逐项留存原生命令与回执。

**门禁 G4（离线）.** 编排改动至少覆盖四类：正常顺序、乱序完成、拒绝/失败、
崩溃后恢复。缺任一类只能声明“定向通过”。

**门禁 G5（原生）.** 只有命令、原生 ID、时序与副作用盘点齐全才算 I PASS；
静态分析或离线复现不算（reliability.md:193）。

### L5 · 端到端（真实 Agent）

**测什么.** 真实 Coordinator/Worker 是否理解交接、正确协作、被唤醒并推进到终点。
判据、分组、证据与状态词**完全沿用** reliability.md 第 3、4、7、8 节：
L-flow、L-collaboration、L-events.busy / worker-idle / external-idle、
L-safety.worker-failure / stop / monitor-restart。

**怎么造用例.** 不新造夹具。按 reliability.md 第 6 节固定资源与授权，按第 3 节分组，
按第 7 节采集证据与收尾。

**跑法.** 人工驱动 + 原生回执；本轮未执行任何一项（见文末声明）。

**门禁 G6.** 只有 reliability.md:51–55 的必测项全集加共享收尾都满足，才可写
“v2 核心 suite PASS”。单个 L 分支通过只写分支结论。

### L6 · 评估

**测什么.** 不是“系统是否按契约行为”，而是“产出是否值得”：
业务产物的可检查判据、独立审查结论、Token/耗时/费用、以及相对基线的收益对照。
RSI 场景还要目标仓库的业务验收（reliability.md:20）。

**现状（据本次阅读）：** 仓库内只有台账与报告口径，没有评估基线或对照实验框架：
`swarm_ledger/`（`ledger.py`、`report.py`、`raw_usage.py`）负责计量；
`supervisor/` 的 `cost-import` 与预留见 `docs/supervisor.md`；
`docs/supervisor.md:139` 明确“当前没有 provider 每请求 token 上限、硬账单截断或自动
中止运行中模型”，且“没有对照实验不承诺提速倍数”（reliability.md 第 7 节 accounting）。

**怎么造用例.** 先固定一个可客观验收的小交付物、一个基线与一个对照口径，
再用 L5 的同一 Run 产出业务证据；费用与 Token 按台账政策取原始计数。
不得用“预留额”当实付，未知不记 0。

**跑法.** 不进核心 suite，单独计划、单独授权、单独预算。

**门禁 G7.** L6 结论不得用于替代 L5 的行为判据；反之 L5 全绿也不构成 L6 的收益结论。
这一条与 reliability.md:20 和 `docs/supervisor.md:139` 一致。

### L7 · 不变量

横切层。每条不变量都有“D 层可复现回归 + L 层闭环复核”两份证据才算落实，
当前只统计 D 层。

| ID | 不变量 | D 层现有证据（示例） |
| --- | --- | --- |
| I-1 | 同一动作的副作用至多一次（含崩溃与丢回执） | `tests/coordinator/test_coordinator_tui_continue.py:180`、`:245`、`:254`；`tests/core/test_supervisor.py:280`、`:374` |
| I-2 | 未知结果只对账、不重放 | `tests/coordinator/test_coordinator_first_dispatch.py:304`、`:316`；`tests/bootstrap/test_bootstrap_failures.py:176` |
| I-3 | 身份/owner/generation/incarnation 变化即停止 | `tests/coordinator/test_coordinator_tui_continue.py:274`、`:932`；`tests/core/test_supervisor.py:865`、`:1076` |
| I-4 | pin 不可被改写、覆盖或降级 | `tests/core/test_authority_bundle.py:319`、`:368`；`tests/coordinator/test_coordinator_strict_delivery.py`（`old_intent_is_not_rewritten`） |
| I-5 | STOP 不可被自动清除或清除后恢复 | `tests/bootstrap/test_bootstrap_control.py:160`、`:172`；`tests/core/test_monitor_stop_signals.py` |
| I-6 | 预算预留幂等，未知费用不记 0 | `tests/core/test_supervisor.py:240`、`:270`、`:336` |
| I-7 | 证据不可变、摘要核验、越界文件拒绝 | `tests/core/test_supervisor.py:836`、`:849`；`tests/core/test_safety.py:158`（ReceiptTests） |
| I-8 | 失败/替换尝试同样计入台账与收尾 | `tests/core/test_ledger.py`、`tests/core/test_ledger_binding_coverage.py`；`tests/core/test_supervisor.py:317` |
| I-9 | 无进展时有界停止，不靠空转凑次数 | `tests/coordinator/test_coordinator_tui_scheduler.py:597`、`:952`；`coordinator_driver.py:678`（`no_progress_recovery_exhausted`） |
| I-10 | 并发写入隔离或明确所有权 | `supervisor/config.py:157–161`（共享 worktree 必须有序、并行任务路径不重叠）+ `tests/core/test_supervisor.py:209`（`allowed_paths` 重叠拒绝）；`tests/coordinator/test_coordinator_worker_plan.py:160`、`:178` |
| I-11 | 跨 runtime/身份不借用、不回退 | `tests/core/test_supervisor.py:1149`、`:1173`；`tests/operators/test_operator_monitor_cross_runtime.py` |
| I-12 | 外部输入的正文不作为指令或授权 | 部分：见 [gap-matrix.md](gap-matrix.md) 场景 S6 |

**怎么造用例.** 每新增一条不变量，先写一个必然违反它的最小夹具（例如“发出后kill，
再重启，看是否重发”），断言“第二次尝试次数为 0 / 状态文件字节不变”。

**门禁 G8.** I-1…I-11 任一项被改动的提交若没有对应回归，视为未通过门禁；
I-12 尚无 D 层正例，见缺口矩阵。

## 4. 夹具与故障注入点清单

本文件只登记**已存在**的注入点，不新增生产代码：

| 能力 | 位置 | 用途 | 边界 |
| --- | --- | --- | --- |
| FakeNative / fake CLI | `tests/bootstrap_role_fixture.py`、`tests/bootstrap_flow_fixture.py`、`tests/core/test_supervisor.py` 的 `Base` | 记录 argv、回放固定回执 | 只能证明被测逻辑 |
| 受控时钟 | `Store(root, clock=...)`（`tests/core/test_supervisor.py:179`、`:245`）、`bootstrap_control` 的显式时间参数 | 租期、TTL、截止期 | 不得用于伪造原生时间戳（reliability.md 第 5 节） |
| 真实文件锁竞争 | `tests/coordinator/test_coordinator_io.py:43`、`:72`；`tests/coordinator/test_coordinator_tui_scheduler.py:263` | 单写入者、busy 跳过 | 本地文件系统，不等于跨主机锁 |
| 密钥/签名夹具 | `tests/core/test_binding.py:212`、`tests/bootstrap/test_bootstrap_transport.py:25` | 篡改、重放、错 key | 不证明真实 host 认证 |
| Unix socket 端到端 | `tests/core/test_binding.py:455`、`:472` | 本地进程间签名回执 | 非网络、非远端 |
| 大文件/大输入 | `tests/core/test_capacity_io.py:33`（17 MiB）、`tests/core/test_supervisor.py:849`（>10 MB） | 容量与完整性 | 见 S3 缺口：无总上下文上限 |
| 有界观测预算 | `observation_budget.py:21` + `tests/core/test_observation_budget.py:30`、`:155` | 观测超时即停 | 只覆盖配合式本地 I/O |
| 跳过式真实集成 | `tests/core/test_tui_rsi_integration.py:21`（`RSI_CHECKER_TEST_ROOT`） | 真实 RSI checker 投影 | 未设变量即 skip，不算通过 |

## 5. 跑法与门禁地图

**唯一基线命令**（`field-guide/index.md` 引用同一入口）：

```bash
cd swarm-orca/swarm && tests/run_offline.sh -v
# 等价于 env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
#   PYTHONPATH=.:tests python3 -B -m unittest discover -s tests -v
```

**默认跑子集；全量是可选的整包信号。** 同一入口提供两种选择模式（清环境规则相同）：

```bash
tests/run_offline.sh --fast   # 99 个模块中的 92 个，≈2.5 分钟
tests/run_offline.sh          # 全量 99 个模块，默认 4 路并行
tests/run_offline.sh --jobs 1 # 全量，单进程（可复现形式，出结论时须写明 job 数）
tests/run_offline.sh --jobs 8 # 全量，8 路并行：仅在实测过的主机上启用（见下）
tests/run_offline.sh --list   # 只列当前模式会跑哪些模块，不执行
```

模块数与耗时来自 2026-11-09 本机一次空闲实测（模块数随 2026-11-10 的 handoff 拆分更新；
2026-11-10 NAS 复测：99 个模块 / 2577 项，单进程 363 s、`--jobs 4` 115 s，两者均 99/99 OK）；
**测试项数不写进文档**（它随套件增长，
以每次输出为准）。`--fast` 排除的 7 个模块（`bootstrap.test_bootstrap_production`、
`bootstrap.test_bootstrap_workflow`、`core.test_startup_handoff` 及其
`_prepare`/`_trigger`/`_monitor` 三份、`bootstrap.test_bootstrap_failures`）合计 301 s，
占全量 65%；成本来自真实 owner-socket RPC（约 2000 次往返，每次一个子进程做签名校验）、
`fsync` 与 JSON 规范化，不是 sleep。它们是 bootstrap/strict 生产路径的行为证据，
**不得为提速删除或削弱断言**。

> **为什么要拆，而不是删.** `--jobs` 以模块为调度单位，所以并行门禁的下限是“最慢单模块”
> 而不是总时长。`core.test_startup_handoff` 原是 40 项一个模块：本机 ext4 上 66 s，
> 而 NAS 工作区挂载上 **577 s**（8.7×；profile 显示 694,875 次 `read_bytes`、
> 2,807,417 次 `lstat`，**零** RPC、零 openssl——慢在源码重读，不在签名）。
> 按主题拆成 gate/dispatch、prepare/schema、trigger/send、monitor/turn-end 四个模块后，
> 40 项与断言一句未改，ext4 上最大单模块 22 s（实测 17.4/4.0/20.9/21.8 s）。
> 拆分不改变任何通过条件，只是把同一批证据放进更细的调度单位。
>
> **默认并发为 4 的依据.** 同一批“源码重读”现在由 `coordinator_io` 按进程内身份复用，
> NAS 挂载上 99 个模块 / 2577 项：单进程 363 s、`--jobs 4` 115 s，均 99/99 OK；
> 2026-11-10 那次 `--jobs 4` 全量 892 s 且两个模块 deadline 假失败（deploy 700 s、
> monitor 788 s）的形态已不再复现，两者在 4 路负载下为 13.4 s / 22.0 s。
> `--jobs 8` 相对 4 收益很小（受 `bootstrap.test_bootstrap_production` 约 74 s 封顶），
> 所以默认取 4；单进程形式仍保留为可复现口径。

按变更范围选择测试（`swarm/<module>.py` → `tests/<area>/test_<module>.py`，映射与边界见
`AGENTS.md` 的 Tests 一节），**不需要每次跑全量，也不需要为了合并或交付补一次全量**；这与
reliability.md:57「日常回归按变更影响选择、变更影响不明时补验」一致。结论必须写明实际跑了
哪些模块（或 `-p` 模式）、哪种模式与 job 数；`--fast` 与定向跑都只是迭代证据，只有真正
跑完整包才能叫「离线 PASS」。模块清单的选取契约由
`tests/core/test_offline_baseline.py` 的 `OfflineRunnerModeTests` 固定：它用 unittest 自己的
discovery 结果（而不是脚本用的同一个 glob）做期望值，所以脚本漏掉某个 `tests/<area>/`
（例如再深一层嵌套目录）会报红，而不是静默少跑。模块名即相对 `tests/` 的点号路径。

> **两个变量都必须清除，脚本已固化这一点。** 实测：在本工作区的环境下
> （`SWARM_WORKER_PROFILES` 指向私有 `swarm/worker-model-profiles.json`），
> 不清除时整包会出现 39 项 `FAIL/ERROR`，全部集中在 `tests/coordinator/test_coordinator_worker_plan.py`；
> 现已被两层修正：该模块 `setUp` 显式清除 override，`coordinator_worker_profiles` 则把
> “pin 来源不一致”与“文件真的变了”区分为 `worker_profiles_pin_source_mismatch` /
> `file_pin_changed`。详见 [gap-matrix.md](gap-matrix.md) 第 6 节与
> [strategy-backlog.md](strategy-backlog.md) 第 8 节。

**没有 CI 流水线。** 本仓库（含 `swarm-orca/swarm/`）不含 `.github/workflows`
或等价的流水线配置，因此“能否进 CI”在本文与 [strategy-backlog.md](strategy-backlog.md)
中一律解释为“能否并入上述离线基线命令并被门禁机器判定”，而不是“已有 CI 会跑”。

**门禁分级.** 与 reliability.md:57 的“日常回归按变更影响选择”一致：

| 门禁 | 触发条件 | 必跑 |
| --- | --- | --- |
| G1 快 | 改 L1 模块 | 该文件单元 + 依赖它的 L3 拒绝码 |
| G2 行为 | 改 L2 控制器 | L2 三段序列 + 相关 L4-offline |
| G3 契约 | 改 schema/字段/路径 | L3 全集 + 契约文档同步 |
| G4 编排 | 改调度/依赖/并发/停止 | L4-offline 四类 |
| G5 原生 | 改原生边界或发布前 | 受影响的 I 项（人工） |
| G6 端到端 | 声明验收 | reliability.md:51 全项 |
| G7 评估 | 声明收益 | 单独计划 |
| G8 不变量 | 触及 I-1…I-12 | 对应回归必须存在 |

## 6. 与既有口径的冲突与澄清（显式）

1. **“L4 全绿”不等于编排已验收。** reliability.md:28 与 :56 明确离线通过不升级为 I/L；
   本文件的 L4-offline 属 D，不得用于声明并发协作已验收。
2. **L6 不是新的验收层。** reliability.md 把业务验收放在“全部 I/L 的共享收尾”
   （第 2 节表格末行），未单列评估层。本文件单列只为编目成本/收益类工作，
   不改变核心 suite 的 PASS 规则；若与 reliability.md 表述冲突，以 reliability.md 为准。
3. **不新增 suite 分组。** reliability.md 第 3 节的四组（自主运行 / Worker 原生唤醒 /
   外部事实原生唤醒 / 故障与停止）是唯一分组方式，本文件不引入第五组。
4. **不新增状态词。** 只有 reliability.md 第 8 节的六个状态。
5. **`test_tui_rsi_integration.py` 不算 L4-native。** 它通过
   `RSI_CHECKER_TEST_ROOT` 读取真实 RSI checker 的只读投影，但明确“无 mock domain
   receipts、无 model 调用、无 runtime 写入”，属 D 层真实输入夹具，不构成 I 项证据。
6. **Supervisor MVP 证据不能为 strict 原生路径背书。** 与 reliability.md:216–217 一致：
   生产路径没有实现的能力报告为缺口，不借同名的固定 DAG 测试为 strict 路径背书。

## 7. 本轮结论的边界

- 本轮只做分析与文档：未运行任何真实 Swarm Run，未创建 Run/Worker/terminal，
  未部署、未注入故障、未执行远端命令，未修改任何 `.py` 或既有测试文件。
- 唯一执行的命令是离线回归基线（`python3 -m unittest discover -s tests`），
  以及只读文件检查；离线回归结果记录在 [gap-matrix.md](gap-matrix.md) 第 6 节。
- 本文引用结论均给文件与行号；凡属推断均在句中标注「推测」。

---

**版本与时间.** 本轮基于以下版本读取与撰写（只读）：

- 主仓库 `swarm-testing-research` 分支：`4aea12aa57fcf4ddcde23d0f6d3dfc8edb6ea955`
  （基于 `dev_liuliu`），工作区无未提交改动。
- 子模块 `swarm`：`59701600e43a140a82fb3b744ee725fc9740cdac`（`remotes/origin/dev_liuliu`）。
- 子模块 `swarm-orca`：`e0dfc6810d5a9079cfa0bb733426e8b6723c249f`（`heads/main`）。
- 读取时间：2026-11-05 12:0x +08:00（Asia/Shanghai）。
