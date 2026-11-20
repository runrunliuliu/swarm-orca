# 固定 DAG Supervisor：退役记录

**状态：2026-11-19 退役。无控制器、无服务、无 CLI。** 本文替换原来的 160 行操作手册；原手册中的
`python3 -m supervisor …` 命令、`supervise` 常驻、`coordinator-step/checkpoint` 协议、`cost-import`
和 runit 安装步骤全部不存在了。这不是"暂时停用"，删掉的代码没有替代实现。

退役依据：控制器、守护进程与服务模板**零生产调用方**，`runit/` 模板从未在任何主机安装或注册，
[验收清单](../acceptance.md) 的实机项全部未勾选；而它们读起来像一条在跑的运行路径。

## 删了什么

| 位置 | 行数 | 原作用 |
| --- | --- | --- |
| `supervisor/engine.py` | 475 | 固定 DAG 执行器：契约、派发、证据校验、预算暂停 |
| `supervisor/watchdog.py` | 105 | 等待检查点时唤醒原 Coordinator 回合、单实例 tick |
| `supervisor/service_finish.py` | 57 | runsv `finish` 的退避/熔断记账 |
| `supervisor/__main__.py` | 156 | `validate`/`supervise`/`coordinator-*`/`status`/`pause`/`resume`/`export`/`cost-import` |
| `runit/`（`run`/`finish`/`log/run`/`log/config`/`down`/`README.md`） | 模板 | 从未安装的 runit 服务定义（`/REPLACE/...` 占位、未 chmod、遇占位符 `exit 78`） |
| `policies.md`、`coordinator-prompt.md` | 文档 | 该 MVP 的角色策略与 Coordinator 提示词 |
| `tests/core/test_supervisor.py` 的 `Engine`/`Watchdog`/`Restart`/`Command` 用例 | ≈900 | 只测上面这些代码，随代码一起删除 |

原实现可从 git 历史取出：`git show 7045b224^:swarm/supervisor/engine.py`（退役前最后一版）。

## 留下了什么（这一节最容易被误读）

`supervisor/` **还在**，但只剩被其他模块 import 的库半边与两条离线工具链：

- `config.py`/`store.py`/`orca.py`/`receipts.py`/`trae_trust.py`（877 行）——`swarm_ledger/*`、
  `operator_trust`、`pi_tui`、`evidence_archive`、`trae_tui` 等 12+ 个模块直接 import，
  删掉会断开台账、宿主签名绑定与运行时证据链；
- `launch_guard.py` + `safety.py` —— [`startup-safety.md`](../startup-safety.md) 里四条
  **离线**命令（`preflight`/`diagnose`/`derive-receipts`/`check-receipts`）的实现，用于原生自适应
  路径的启动前兼容性核验与最终回执派生，与本 MVP 无关；
- `config.example.json` —— 现在只作 `launch_contract` v2 的**形状示例**（`safety preflight` 读它）；
  不再有 `validate` 命令去校验它，校验器是 `supervisor.config.validate` 这个函数。

## 两条仍然成立的边界

这两条是平台事实，不是被删代码的属性，所以留在这里，供缺口矩阵引用：

1. **本执行器不支持任务重试。** 依赖未满足、审查拒绝或 Worker 失败都终止该分支，不自动返工；
   原实现在 `verdict=fail` 时置 `blocked:<key>` 并要求人工重新规划。删除后这一点没有变化：
   仓库里没有任何固定 DAG 执行器会重试任务。
2. **没有 provider 每请求 token 上限、硬账单截断或自动中止运行中模型。** 单回合内可发生多次模型
   请求；预留不保证真实花费不超额。请配置供应商侧独立额度、按试点数据设置保守预留，并明确接受
   这个差距，否则不进入无人值守运行。这条对现行 strict TUI / driver 路径同样成立。

## 剩下的相关问题

- 若将来重新需要"固定任务 DAG + 预算硬门"，先回答 `engine.py` 里被删掉的三件事：每次派发前的
  `launch_guard` 预检与预留顺序、未知回执不得重放、以及 Round 预算如何在进程重启后仍然有效。
  这三个语义的离线证据也随测试一起删除了。
- 预算/费用与原生台账的口径见 [`configuration.md`](../configuration.md)，
  启动前证据与回执派生见 [`startup-safety.md`](../startup-safety.md)；两者都不依赖本文。
