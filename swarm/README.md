# Orca Swarm：使用入口与能力边界

本目录包含原生 Swarm 的启动、续跑、监控和证据辅助工具，以及独立的固定 DAG Supervisor MVP。
它们不是同一套执行器；先按 Run 类型选择入口，再读取对应操作文档。
源码、示例配置和离线测试不等于已部署或已通过实机验收。

## 先找对入口

| 路径 | 入口与用途 | 不能混用的边界 |
| --- | --- | --- |
| Strict Coordinator TUI + Operator monitor / scheduler | [启动准备](operator-prepare.md) → [strict 握手](coordinator-strict-start.md) → [TUI 续跑](coordinator-tui.md) / [monitor](operator-monitor.md)。当前 strict native 计划支持 Trae；通过原生 Run mailbox 续接真实 Coordinator。 | monitor 只有显式配置 continuation 才调用 scheduler；观察、消息入队或 Operator 结算都不等于业务完成。 |
| 独立 goal-loop driver | [回合续跑器](coordinator-driver.md)，由 `coordinator_launch.py goal-loop` 校验，显式执行后在原 Trae exec PTY/会话串行续跑；可配[指定 Operator 执行器](coordinator-operator.md)。 | 代码拒绝 strict 计划及 `strict-v1` Run；不能作为 strict TUI 的恢复或平台提交回退。 |
| 固定 DAG Supervisor MVP | [操作手册](docs/supervisor.md)与 [runit 模板](runit/README.md)：预先固定任务 DAG，Coordinator 派发，Sidecar 在等待检查点唤醒原 PTY。 | 专用 `config.example.json`、`coordinator-step/checkpoint` 协议和预算限制；不自动重规划、任务重试、升级模型或接管新 Coordinator。 |

角色和阶段语义见[跨阶段控制循环契约](../skills/orchestration/references/coordinator-loop.md)。
原生 Swarm 的并发与模型选择遵循[自适应执行规则](../skills/orchestration/references/swarm-execution-policy.md)，
不套用固定 DAG 的“最多两个实施 Worker”等限制；具体 Run 仍受已确认的 `max_workers`、授权和预算约束。
业务角色使用[目标仓库的角色 skill](../skills/orchestration/references/repository-skills.md)，辅助脚本不替代业务 Coordinator。

## Strict TUI 的标准顺序

以下是入口导航，不是可直接执行的启动命令；完整参数、固定引用及失败处理以链接协议为准。

1. **前置材料。** 按[启动准备](operator-prepare.md)固定任务、授权来源、目标 worktree/基线、角色材料和启动计划；
   strict 路径直接消费 `assemble-materials` 的 `final-checklist.json`，不要求再重复运行另一套 `prepare`。
   同时明确 continuation、monitor 与首个 checkpoint 的准备责任，Run 创建后完成真实绑定；不能将这段遗漏到需要续跑时才补。
2. **先有真实 Operator，再启动 Coordinator。** 核验 Operator 会话并固定身份输入。
   `operator_prepare.py native-plan` 与 `coordinator_launch.py strict-native-plan` 复用同一个 `native_plan`：
   检查材料及 plan/workspace 绑定、Operator 身份、runtime 能力、工作区和可执行文件，全部通过才返回原生启动 argv；不自行启动。
   材料可以提前准备，真实 Operator 身份不能由静态材料替代。Coordinator 模型和权限分别按[模型配置](coordinator-model.md)及[启动配置](coordinator-runtime.md)核验，不套给 Operator 会话。
3. **由真实角色完成 strict 握手。** Coordinator 先完整读取固定提示和[启动协议](coordinator-strict-start.md)，再执行 caller-check；
   原始回执放在 `BOOTSTRAP/initial-caller.json`，`strict-start/` 必须保持不存在，由 `strict-start-prepare` 独占创建。
   `strict-config-request` 的 `--check` 只校验输入，不写文件或固定正式 deadline；`--execute` 在发布前核验真实 Coordinator caller。
   契约绑定的 Operator 在自身会话执行计划输出的 `operator_check_argv` / `operator_publish_argv`，外层普通 Shell 不代发。
   按协议阶段等待 `ready.json` / `gate-ready.json`，不用 TUI idle 代替所有阶段的就绪条件。
4. **启动门后创建 Run、首派。** Coordinator 在自身上下文验证 session gate 后创建 Run；首批 Worker 前仍须通过
   [Operator 与 Coordinator 两侧检查](coordinator-startup.md)，核对 Run owner / consumer generation，并用[Worker planner](coordinator-worker-plan.md)生成参数。
   预检不是授权，也不是直接调用原生 `terminal create` 时的全局拦截器。
5. **接入续跑并验证业务转换。** 按 [TUI 协议](coordinator-tui.md)固定 continuation、领域 checkpoint/head 与身份绑定，
   按 [monitor 指引](operator-monitor.md)准备、部署并核验。schema2 monitor 的 sender 是独立原生非 Agent shell，
   不等于前面负责 gate 的 Operator Agent；必须从 sender 自身上下文运行，不能复制身份变量。
   `continuation=null` 时只观察/回传事实，不运行 scheduler。当前 `operator_handoff` 动作有有效结算后，scheduler 可投递幂等审查请求，
   仍须真实 Coordinator 审查并发布新 head，不能把结算回执当作下一动作已经完成。
   monitor 不代替 Coordinator claim、ACK 或判定业务成功。
6. **持续采集与独立收尾。** 按[用量台账](ledger.md)在 Run 开始、派发、结算和收尾采集，按[产物归档规则](artifact-storage.md)保存证据；
   完成业务验收、原生结算/ACK/资源释放和归档回读后，才能作对应完成声明。

历史有效不等于现在可发送：scheduler 对精确已结算动作防重；历史合法但不够新鲜的未发送 head 可以等待新 checkpoint，
新发送仍须通过当前身份、turn、mailbox、pin 和发送前校验。失败恢复仅限现有 helper 明确支持、证据与审查齐全的路径，
不能清空 stop/outbox、重放旧 action 或换 Run 绕过阻断。
实现入口：[native plan](coordinator_strict.py)、[请求发布](coordinator_strict_request.py)、[握手](coordinator_strict_start.py)、
[monitor](operator_monitor.py)、[scheduler](coordinator_tui_scheduler.py)、[结果审查与 head 发布](coordinator_tui_workflow.py)。

## 验证状态与标准

- [当前进展与 TODO](docs/validation/current.md)：唯一维护当前 Run 状态的入口，包含证据截止时间、分项结果、缺口和下一步；不是实时查询。
- [Swarm 测试与验收指南](docs/testing/reliability.md)：当前统一标准，按确定性回归、原生集成和真实 Agent 闭环分层，区分自主运行与原生唤醒组；服务 ready 和局部 PASS 不代替完整核心 suite。
- [历史 Run 记录](docs/validation/history/live11-20261031-20261102.md)：只用于追溯，不合并为当前 Run 的通过结果。
- [历史验收清单](acceptance.md)：固定 DAG、离线自治、长驻及经济性等范围，仍需各自的专项验收证据。

历史专题报告统一归档到 `docs/validation/reports/`；日期、版本、结论及待办只适用于对应尝试，不代表当前状态：

- 2026-10-14：[失败 Run 修复](docs/validation/reports/verification-20261014.md)、[原生 Worker 启动链路](docs/validation/reports/verification-native-20261014.md)。
- 2026-10-17：[Trae Coordinator](docs/validation/reports/trae-coordinator-verification-20261017.md)。
- 2026-10-27：[Continuation 锁竞争](docs/validation/reports/coordinator-tui-lock-validation-20261027.md)、[strict TUI 调度器](docs/validation/reports/coordinator-tui-scheduler-validation-20261027.md)。
- 2026-10-30：[计划重启与续验来源](docs/validation/reports/operator-planned-restart-validation-20261030.md#post-deploy-plan)、[Operator 工作区信任](docs/validation/reports/operator-trust-validation-20261030.md)、[NFS 发布](docs/validation/reports/strict-start-nfs-validation-20261030.md)、[request-only 阻塞](docs/validation/reports/strict-start-validation-20261030.md)。

## 配套参考

| 要查什么 | 文档 |
| --- | --- |
| Coordinator 模型、权限与启动适配 | [模型选择](coordinator-model.md) / [固定 JSON](coordinator-model.json)、[运行权限与路径](coordinator-runtime.md)、[Trae exec](trae-coordinator.md) |
| Strict bootstrap 事件协议（Phase 1–4 本地开发） | [协议与工具契约](strict-bootstrap-protocol.md)：四 marker / 两阶段 wait / 原 builder 与 S5 同域准入，attempt-local owner 及双方候选交接工具已实现；`--check` 仍为 `ready:false`，不表示已部署常驻服务或通过 live 验收 |
| 原生派发准备 | [预检](native-preflight.md)、[准备模板](coordinator-preparation.md)、[Worker 白名单](worker-model-candidates.md) / [固定参数](worker-model-profiles.json) |
| 用量与会话证据 | [台账](ledger.md)、[宿主签名绑定](session-binding.md)、[runtime 文件绑定](runtime-session-binding.md)；不同证明口径不自动互相回退 |
| 观察、安全与归档 | [只读 progress watch](progress-watch.md)、[启动与收尾保护](startup-safety.md)、[产物归档](artifact-storage.md) |
| 固定 DAG 角色与操作 | [Supervisor 手册](docs/supervisor.md)、[角色策略](policies.md)、[Coordinator 提示词](coordinator-prompt.md)、[知识入口](field-guide/index.md) |

<a id="trae启动前自动登记精确工作目录"></a>

原 README 的固定 DAG Trae 信任说明已移至 [Supervisor 手册](docs/supervisor.md#trae启动前自动登记精确工作目录)。
strict Operator 的精确工作区信任使用[自己的准备入口](operator-prepare.md#6-已授权的精确-trae-工作区自动信任)，不要混用 Worker 启动钩子。

## 离线开发与目录约定

Python helper 使用标准库；Supervisor / 台账基线为 Python 3.10+，Trae TOML 信任处理需要 Python 3.11+，
宿主签名绑定另需 OpenSSL 3。目标平台及 provider/runtime 支持范围按各入口适配器核验，不从首页推断兼容性。
从本子模块根目录运行离线回归（不连接 Orca 或启动模型）：

```bash
python3 -m unittest discover -s tests -v
python3 -m compileall -q supervisor swarm_ledger tests
```

这不替代目标环境测试。固定 DAG 配置检查与示例拒绝原因见 [Supervisor 手册](docs/supervisor.md#离线配置检查)。

根目录保留脚本和它们按相邻路径加载的协议/配置；`docs/` 存放入口手册和验证文档。
`docs/validation/current.md` 维护当前进展，`docs/validation/history/` 保存旧 Run，单次报告归档到 `docs/validation/reports/`。
私有 `trials/`、真实配置、状态、产物与凭据不入版本控制，真实证据按[归档规则](artifact-storage.md)存放，不迁入文档目录。
