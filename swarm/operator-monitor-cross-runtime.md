# Operator monitor：计划内跨 runtime 续接

维护日期：2026-10-30。**状态：CLI、Server 维护入口和 Python 恢复适配已接通，
本地回归覆盖可重试启动、连续两次计划重启及后续回合；未部署，未完成真实 Server/TUI 全链验收。**
本文不构成执行许可。现有 [same-runtime 恢复](operator-monitor-recovery.md) 仍严格
拒绝 runtime mismatch，不增加忽略 runtime、STOP 或审查门的开关。

## 首版范围

- 仅 Linux、同 kernel boot/PID namespace、同私有 Server 数据根和数据库、计划内重启；
  原 daemon、Coordinator、preparer、sender 终端必须存活且身份精确一致。
- scheduler-only monitor 已停止；唯一续跑消息已发送，但未 claim/consume/ACK；无活跃 Worker。
  原 Run ID、owner、incarnation、consumer generation 不变，不补派 Worker。
- `serverId` 是持久身份，`runtimeId` 是单次实例；不把新 ID 写进旧配置冒充连续性。
  旧 deployment、STOP、outbox、request、checkpoint 和用量历史不覆盖。
- 不支持终端替换、跨主机/容器重建、灾备及事后补 seal。没有重启前回执的历史 Run
  不能通过此协议恢复；结束旧 Run、新建 Run 是另外的授权操作。

## 最小闭环与角色

```text
源 Operator seal（内部 prepare → 冻结 → seal，原三把锁持续持有）
  → 源独立 Reviewer review
  → 获授权的计划重启，登记 attempt → 完成启动检查 → commit/activate
  → 原 Operator transition → cross-runtime prepare
  → 独立 Reviewer 审查恢复 proposal → apply
  → 原 Coordinator begin → action/settle → finish（整批 ACK / checkpoint）
  → Operator complete（新 deployment 最后发布）
  → 原 sender run/verify → Coordinator 后续回合
```

两个审查对象不同：重启前审查固定连续性回执，重启后审查恢复 proposal；均复用已有
strict caller 和独立 Reviewer 约束，不能由 Coordinator/preparer/sender 自审。
业务判断仍由 Coordinator 完成；脚本只复制引用、计算哈希、核对状态及原子发布。

### 源端：`operator_planned_restart.py`

1. `seal --plan PATH --plan-sha256 FILE_SHA --expires-at-ms MS --output DIR --execute`。
   `DIR` 须已存在、为空且私有（0700），位于 monitor/continuation 状态根之外。
   复用原 workflow/monitor/continuation 锁，通过原生入口完成 prepare 与 seal，输出
   `source.json`、`preparation.json`、`seal.json`；拒绝或中断时保留已有证据，不自动重放。
2. 在 **Reviewer 自己已有的真实 strict 终端**调用 `review`，提供固定 plan、preparation、
   seal 文件及各自 `--*-sha256`，明确 `--decision approve|reject --reason ...`，
   用新 `--output` 文件发布回执；须 `--execute`。拒绝不会生成可消费的批准回执。
3. 运维在另行满足部署/终端安全条件后，以
   `orcad --planned-restart REVIEW_CANONICAL_SHA:PROPOSAL_CANONICAL_SHA` 启动继任实例。
   两个 canonical 值来自代码生成的 review/preparation 字段，**不是对文件做 sha256sum**。
   脚本本身不停止或重启服务，不更换 profile/runtime，不自动确认信任。
4. 原 Operator 用 `transition` 指定旧 plan/seal 的文件 pin、`--target-runtime` 和新的
   `--output`，加 `--execute`。目标 Server 从已提交 journal 确定性生成 transition。

所有 Python `--*-sha256` 文件引用均为原始字节 SHA；原生 `*CanonicalSha256` 为解析后
canonical JSON digest。代码核对并传递它们，禁止手工混用或改旧 request/config。

### 目标端：复用恢复入口

`operator_monitor_cross_runtime.py` 包装现有 recovery、workflow 和 monitor：

- `prepare` 接收 transition 文件 pin，在新目录生成 proposal；仍停在独立审查门。
- 独立 review 按 [原恢复协议](operator-monitor-recovery.md) 生成；`apply` 接收固定
  proposal/review，状态为 `reviewed_not_resumed`，不是可以发送的 monitor deployment。
- 原 Coordinator 在自身上下文 `begin → 业务处理 → finish`，复用现有 request 对账、
  claim/settle、整批 ACK、checkpoint 和 action bounds。未知结果不盲重放。
- `complete` 复核完成回合和 workflow receipt，复用 commit-last 发布新的不可变 deployment；
  中途发布失败可依原协议对账重试，不修改旧目录。
- 原 sender 通过本入口 `run / verify`；后续 Coordinator 用
  `continue-begin / continue-finish / turn-end`，不落回旧 runtime 入口。

有写入/执行的阶段要求显式 `--execute`；`run` 还要求 `--confirm-skill-read`。
这些标志表示调用意图，不授予权限。原生维护入口不支持或拒绝时停止，无换入口重试。

## Server 实现边界

源码及细节见 [Server 计划重启](../source-v1.4.219/docs/reference/strict-runtime-continuity.md)。
沿用实例锁、lineage journal、DB seal、现有文件 inventory 和恢复锁；不扩展灾备或克隆防御。

- Server 从 plan→config→continuation→contract 推导核心 scope，再核验原生 Run、sender、
  唯一 pending request、payload、outbox、checkpoint head 及文件/源码 pin。
- seal 冻结普通 RPC、排空并冻结 daemon 控制写入和共同 PTY 输入点、冻结 profile，再复查
  Coordinator idle 与状态；DB 封存后设 query-only，并写独立 journal。失败保持停止。
- 继任仅连接固定 daemon，不启动替代进程；在实例锁下登记不可变启动 attempt，DB 保持
  query-only。恢复精确终端身份并复用 hook server 证明/撤销回调；PTY、RPC/push、pairing
  构造完成后，顺序提交 journal、释放 daemon、激活 DB，最后解除启动 RPC fence。
- 启动失败可用新 runtime 重试，但须原 review/proposal、seal、inventory 不变且未过期，
  daemon 仍可证明 frozen、未接纳实际 effect。journal commit 或 release 回执丢失也遵守此
  条件；无 effect 时断开会回到 frozen，清理用 `shutdownIfIdle` 不得消耗该窗口。首次 effect
  后禁止复用旧凭据；不自动延长 TTL、不删 seal、不自动重启服务。
- 前一轮恢复完成并提交 deployment 后，可生成新 proposal/seal 并独立审查下一周期。
  journal 按 cycle/stage/attempt 留存；Python 读取完整不可变链并使用每轮独立 STOP 路径，
  不覆盖旧 config、旧失败或旧 runtime。**普通/非计划启动仍被历史 seal 拒绝。**
- 启动不自动重发旧 mailbox pointer、不启动 federation redrive；唯一旧动作由恢复流程对账。
- 目标 `boundary` 检查已消费 transition、当前 runtime 和阶段 caller，**只绑定 transport**；
  不把其成功当业务授权。独立 Python review/permit、实时 caller 和 strict Run 检查仍保留。

## 已知限制与验证缺口

本地原生集成使用真实磁盘 SQLite、实例锁/journal 和 DaemonServer socket；PTY 子进程、
实时身份、idle 与 hook attestation 使用 fixture。另有真实 `startOrcad` 函数的依赖接线测试，
其中 RuntimeService/admission 是替身，注入 browser/profile/PTY/RPC/pairing 失败及提交后
health/readiness 上报失败。连接级测试覆盖 journal commit/release 回执丢失后的重试。
Python 回归覆盖 CLI envelope、持锁 seal、review、两周期恢复、第二轮源观察、后续回合、
重复 ACK、commit-last 发布中断重试；原生业务响应仍是 fixture。
两侧测试不等于 Python→完整 Server→真实 TUI 的端到端重启。

当前仍须明确的限制：

- 两周期及失败重试目前只有本地证据；超出未过期、状态未变、frozen/no-effect 边界仍拒绝。
- 兼容原 base-only journal；先前未发布的 stage-only continuity 表拒绝启动，不静默迁移。
- 全库/daemon 冻结影响其他工作负载；任意 structured session、automation、federation、
  远端或其他后台 writer 的停写未全部实机证明。冻结控制输入不等于暂停 PTY 进程。
- Server 不独立证明 Python 持有文件锁，不解释所有授权证据，也不原生验证恢复 permit。
  本次不新增此类通用框架，不能据现有测试宣称全局写入排他或生产就绪。

早期实机核验的 Electron / CLI 缺口已在 2026-10-30 20:08 +08:00 的正式部署中更新：
服务切到 standalone `orcad`，匹配 CLI 的 `planned-restart` 入口可用；存量旧 daemon 为
保留会话而被接纳、未升级，所需重启能力仍须实测核验。部署不证明完整恢复已通过，
也不能追补旧 Run 的重启前回执。

当前验证顺序及出口以[当前 TODO](docs/validation/current.md#validation-priorities)为准。
[2026-10-30 正式部署后的续验计划](docs/validation/reports/operator-planned-restart-validation-20261030.md#post-deploy-plan)
仅保留为历史来源，不作为现在新建 Run 的指令。连续两个计划 Server 重启周期须在独立
验收窗口验证；它是 [核心测试标准](docs/testing/reliability.md)之外的专项能力，
不替代同 runtime、同 sender/state 的 monitor 重启验收，也不能由部署记录推定通过。

当时的测试和构建缺口见 [两周期验证记录](docs/validation/reports/operator-planned-restart-validation-20261030.md)。
