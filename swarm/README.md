# Orca Swarm：使用入口与能力边界

本目录包含原生 Swarm 的启动、续跑、监控和证据辅助工具，以及独立的固定 DAG Supervisor MVP。
它们不是同一套执行器；先按 Run 类型选择入口，再读取对应操作文档。

独立巡检工具：[Release radar](release_radar/README.md) 抓取同类产品更新，准备证据化分析包和
GitHub issue 草稿；默认 dry-run，不启动 Swarm、启用定时器或自动发布。
源码、示例配置和离线测试不等于已部署或已通过实机验收。

## 先找对入口

| 路径 | 入口与用途 | 不能混用的边界 |
| --- | --- | --- |
| Strict Coordinator TUI + Operator monitor / scheduler | [启动准备](operator-prepare.md) → [strict 握手](coordinator-strict-start.md) → [TUI 续跑](coordinator-tui.md) / [monitor](operator-monitor.md)。当前 strict native 计划支持 Trae；通过原生 Run mailbox 续接真实 Coordinator。 | monitor 只有显式配置 continuation 才调用 scheduler；观察、消息入队或 Operator 结算都不等于业务完成。 |
| 独立 goal-loop driver | [回合续跑器](coordinator-driver.md)，由 `coordinator_launch.py goal-loop` 校验，显式执行后在原 Trae exec PTY/会话串行续跑；可配[指定 Operator 执行器](coordinator-operator.md)。 | 代码拒绝 strict 计划及 `strict-v1` Run；不能作为 strict TUI 的恢复或平台提交回退。 |
| 固定 DAG Supervisor MVP | [操作手册](docs/supervisor.md)与 [runit 模板](runit/README.md)：预先固定任务 DAG，Coordinator 派发，Sidecar 在等待检查点唤醒原 PTY。 | 专用 `config.example.json`、`coordinator-step/checkpoint` 协议和预算限制；不自动重规划、任务重试、升级模型或接管新 Coordinator。 |

部署方须交付角色和阶段控制循环契约，以及自己的自适应并发和模型选择政策，见[部署接入](configuration.md)。
不套用固定 DAG 的“最多两个实施 Worker”等限制；具体 Run 仍受已确认的 `max_workers`、授权和预算约束。
业务角色使用目标仓库已审核的角色 skill，辅助脚本不替代业务 Coordinator。

## Strict TUI 的标准顺序

以下是入口导航，不是可直接执行的启动命令；完整参数、固定引用及失败处理以链接协议为准。

1. **前置材料。** 按[启动准备](operator-prepare.md)固定任务、授权来源、目标 worktree/基线、角色材料和启动计划；
   strict 路径直接消费 `assemble-materials` 的 `final-checklist.json`，不要求再重复运行另一套 `prepare`。
   同时明确 continuation、monitor 与首个 checkpoint 的准备责任，Run 创建后完成真实绑定；不能将这段遗漏到需要续跑时才补。
2. **先有真实 Operator，再启动 Coordinator。** 核验 Operator 会话并固定身份输入。
   `operator_prepare.py native-plan` 与 `coordinator_launch.py strict-native-plan` 复用同一个 `native_plan`：
   检查材料及 plan/workspace 绑定、Operator 身份、runtime 能力、工作区和可执行文件，全部通过才返回原生启动 argv；不自行启动。
   材料可以提前准备，真实 Operator 身份不能由静态材料替代。Coordinator 模型和权限按[显式部署配置](configuration.md)核验，不套给 Operator 会话。
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
6. **持续采集与独立收尾。** 按[部署侧用量及归档政策](configuration.md#部署政策与历史材料)在 Run 开始、派发、结算和收尾采集并保存证据；
   完成业务验收、原生结算/ACK/资源释放和归档回读后，才能作对应完成声明。

历史有效不等于现在可发送：scheduler 对精确已结算动作防重；历史合法但不够新鲜的未发送 head 可以等待新 checkpoint，
新发送仍须通过当前身份、turn、mailbox、pin 和发送前校验。失败恢复仅限现有 helper 明确支持、证据与审查齐全的路径，
不能清空 stop/outbox、重放旧 action 或换 Run 绕过阻断。
实现入口：[native plan](coordinator_strict.py)、[请求发布](coordinator_strict_request.py)、[握手](coordinator_strict_start.py)、
[monitor](operator_monitor.py)、[scheduler](coordinator_tui_scheduler.py)、[结果审查与 head 发布](coordinator_tui_workflow.py)。

## 验证状态与标准

- [公开迁移状态](../MIGRATION_STATUS.md)：源码快照与发布验证范围，不是部署或实时 Run 状态。
- [Swarm 测试与验收指南](docs/testing/reliability.md)：当前统一标准，按确定性回归、原生集成和真实 Agent 闭环分层，区分自主运行与原生唤醒组；服务 ready 和局部 PASS 不代替完整核心 suite。
- [专项验收清单](acceptance.md)覆盖固定 DAG、离线自治和经济性；当前 Run 状态及历史证据由部署方私有维护，不随公开代码发布，不能合并成当前版本 PASS。

## 配套参考

| 要查什么 | 文档 |
| --- | --- |
| 跨 Project 的任务与工作区模型 | [以任务为中心的工作区设计](docs/design/task-workspaces.md)：一个任务按需绑定多个仓库 worktree，跨入口续做复用，逐仓库交付并联合验收；仅设计理念，不代表自动化或强制隔离已实现 |
| Coordinator 模型、权限与启动适配 | [部署配置](configuration.md)、[公开 JSON 示例](coordinator-model.json)、[Trae exec](trae-coordinator.md) |
| Strict bootstrap 事件协议（Phase 1–4 本地开发） | [协议与工具契约](strict-bootstrap-protocol.md)：四 marker / 两阶段 wait / 原 builder 与 S5 同域准入，attempt-local owner 及双方候选交接工具已实现；`--check` 仍为 `ready:false`，不表示已部署常驻服务或通过 live 验收 |
| 原生派发准备 | [预检](native-preflight.md)、[准备模板](coordinator-preparation.md)、[Worker 白名单](worker-model-candidates.md) / [固定参数](worker-model-profiles.json) |
| 用量与会话证据 | [私有台账接入](configuration.md#部署政策与历史材料)、[宿主签名绑定](session-binding.md)、[runtime 文件绑定](runtime-session-binding.md)；不同证明口径不自动互相回退 |
| 观察、安全与归档 | [只读 progress watch](progress-watch.md)、[启动与收尾保护](startup-safety.md)、[私有归档接入](configuration.md#部署政策与历史材料) |
| 固定 DAG 角色与操作 | [Supervisor 手册](docs/supervisor.md)、[角色策略](policies.md)、[Coordinator 提示词](coordinator-prompt.md)、[知识入口](field-guide/index.md) |

<a id="trae启动前自动登记精确工作目录"></a>

原 README 的固定 DAG Trae 信任说明已移至 [Supervisor 手册](docs/supervisor.md#trae启动前自动登记精确工作目录)。
strict Operator 的精确工作区信任使用[自己的准备入口](operator-prepare.md#6-已授权的精确-trae-工作区自动信任)，不要混用 Worker 启动钩子。

## 离线开发与目录约定

Python helper 使用标准库；Supervisor / 台账基线为 Python 3.10+，Trae TOML 信任处理需要 Python 3.11+，
宿主签名绑定另需 OpenSSL 3。目标平台及 provider/runtime 支持范围按各入口适配器核验，不从首页推断兼容性。
从公开仓库的 `swarm/` 目录运行离线回归（不连接 Orca 或启动模型）：

```bash
tests/run_offline.sh -v
```

该脚本固定清除 `SWARM_WORKER_PROFILES` 与 `RSI_CHECKER_TEST_ROOT` 后执行
`PYTHONPATH=.:tests python3 -B -m unittest discover -s tests`，退出码即 unittest 退出码；
不要继承调用方环境里的私有策略路径（原因见[字段指南](field-guide/index.md)）。

这不替代目标环境测试。固定 DAG 配置检查与示例拒绝原因见 [Supervisor 手册](docs/supervisor.md#离线配置检查)。

本目录保留脚本、相邻协议及公开示例；`docs/` 存放通用手册和测试标准。
真实配置显式选择；历史、状态、产物与凭据不进入公开版本控制，详见[部署边界](configuration.md)。

## Software development domain

Explicit strict TUI tasks can use the [software-development skill](skills/software-development/SKILL.md)
and [versioned domain schema](docs/design/software-development-schema.md). The domain checker
reuses the existing continuation chain; it does not launch Agents or authenticate execution.
See the [implementation plan](docs/design/software-development-domain-adapter.md) for live
acceptance boundaries. Existing RSI Runs keep their original configuration and pins.
