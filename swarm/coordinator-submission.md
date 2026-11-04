# Coordinator 提交接口（workflow-v2，显式启用）

本接口是 strict TUI scheduler 的第一阶段可靠性改动：让模型负责业务结果、整批消息证据和
下一 checkpoint，程序统一负责校验、settle、ACK、head 发布及 turn-end 审计。
不是新数据库，不是完整的原生事务提交 API，也不是业务自动验收或模型结束 hook。

## 启用与兼容性

只在**新建** schema v2 continuation/scheduler 配置中增加：

```json
{"turn_protocol": "workflow-v2"}
```

该片段不是完整配置。`coordinator_tui_prepare.py` 的输入支持同名可选字段，并将其传入生成的
配置、续跑消息 payload 和 readiness 说明。其他值及 schema v1 上的该字段均拒绝。
不设置此字段时，旧提示、`begin/finish` 回执、进展阻断时机及恢复链保持原语义。
不要改写既有 config/contract/gate/hash 或旧部署的源码 pins 来试开开关。

`workflow-v2` 下 `finish` 是 `submit` 的兼容入口，两者共享实现；显式 `submit` 拒绝旧配置。
Operator handoff 仍由原有 `operator-review-begin/finish` 独立复核，不获得重复执行授权。
普通原生消息不自动变成 scheduler 动作，仍需按其领域和 Delivery 契约处理。

现有 `operator_monitor_recovery` 同 Run／跨 runtime 恢复包只支持旧版含 turn-end 的完成回执。
对 workflow-v2，`prepare` 在写恢复提案前拒绝，workflow 也在消费/结算前拒绝 recovery 引用，
报 `recovery_workflow_v2_not_supported`；不静默降级格式或改动原 pins。
需要这些恢复包的任务暂时不要启用此开关。跨 runtime 的旧配置与入口不变。

## Coordinator 调用契约

以下均在已核验的原 Coordinator 会话内执行；示例不是启动或扩大业务授权。
绝对路径和 SHA256 必须来自当前任务的真实文件，不能照抄占位符。

```sh
python3 -B /absolute/swarm/coordinator_tui_workflow.py begin \
  --config /absolute/config.json --config-sha256 CONFIG_SHA256 \
  --action-seconds 60 --execute
```

仅 `execute_action=true` 允许执行该 action。重复 begin 返回不得执行；claim 后结果未知必须对账。
begin 会返回实际 Delivery 全批消息，不仅是 continuation 消息。模型完成业务、逐条处理整批消息，
保存真实证据和新的领域检查结果后，一次提交：

```sh
python3 -B /absolute/swarm/coordinator_tui_workflow.py submit \
  --config /absolute/config.json --config-sha256 CONFIG_SHA256 \
  --result /absolute/result.json --result-sha256 RESULT_SHA256 \
  --next /absolute/next-checkpoint.json --next-sha256 NEXT_SHA256 \
  --processed /absolute/processed.json --processed-sha256 PROCESSED_SHA256 \
  --receipt /absolute/approved/submission.json --execute
```

- `result`：原 action ID、原 checkpoint pin、`status=executed` 和非空证据列表。
- `next`：新的领域检查 projection；动作 ID 不得复用，授权、原验收范围和预算检查不放宽。
- `processed`：`delivery_id` 与整批 `messages:[{id,evidence}]`；每条证据均需有效 pin，
  continuation 消息证据必须包含本次 result pin。少处理一条都不能 settle/ACK。
- `receipt`：获准根目录内、控制状态目录之外的新不可变文件。重试必须复用同一路径及全部 pins。

程序顺序为：身份/范围/证据/状态迁移检查 → 持久化提交范围 → settle → 原生 ACK（带 `--peek`，
不消费新邮件）→ 在现有 continuation 写锁内发布 head 与不可变提交回执 → 保存回执绑定 →
只读 turn-end 审计。下一唤醒仍由现有 scheduler 在真实回合结束后登记/投递。

## 如何解释返回值

| 结果 | 已处理当前 Delivery？ | 接下来 |
| --- | --- | --- |
| `submitted`，`submission_accepted=true`，`turn_end.ok=true` | 已验证 settle/ACK 和提交回执 | 结束回合；scheduler 独立观察实际结束、邮箱及调度条件 |
| `submitted_followup_required`，`submission_accepted=true`，`ok=false` | 已接受，不能重做业务 | 检查 `turn_end`：可能有新邮件、独立审查、readiness 或上下文问题 |
| `submission_already_accepted`，`turn_end=null` | 历史提交已接受，head 已向后推进 | 查看当前 head；不回退 head，不把旧回执当作新回合审计 |
| `retryable=true`，退出码 75 | 此步骤需重试；可能已有部分持久化效果 | 至少间隔 1 秒，在原预算/截止时间内重试同一命令及 pins；不重做业务 |
| `tui_workflow_native_outcome_unknown` 等拒绝 | 无法由本调用证明完整提交 | 保留状态与请求 ID，只对账；不盲目重发 ACK、consume 或业务 action |

接受回执 `kind=coordinator-delivery-submission`、`schema_version=2` 不含可变 turn-end 结论。
现有 workflow journal 单独保存 `accepted_receipt`、`submission_audit`；只有审计成功才有
`completed_receipt`。审计失败不会撤销已接受的提交，也不会把 receipt 内容改成新版本。
`ok=false`（退出码 2）不能简单理解为“业务没执行，可以重做”。

连续三个已 settle 动作无新增 `met` 的保守门限**没有放宽**。新协议允许先确认有效结果、
结清当前 Delivery，再持久停在独立审查状态；不能因为需要审查而丢失当前提交的完成事实。
“提交被接受”仍不等于“原始要求验收通过”，也不是自动授权下一 action。

## 未完成回合与故障边界

scheduler 对已投递消息进行带身份 fence 的两次稳定 completed-turn 观察；只有真实回合上下文
晚于该消息投递时，才记录 `continuation_incomplete`。旧回合、busy、交互等待或变化中的观察
不能据此认定遗漏。诊断写入现有 state_root 的不可变 `incomplete-turn-*.json`，重复观察保留
首份证据，即使 hook 计数更新也不覆盖。

诊断区分 `not_claimed`、`unknown`（已 claim）与 `settled_submission_missing`。仅 settle、
手工发布新鲜 head，或在 ACK/head/receipt 写入之间中断，都不能替代提交回执绑定并推进下一动作。
此诊断不会自动 ACK、重发、重做动作或写 STOP；原 Coordinator 可在原约束内对账/补交。

ACK 回包丢失但请求已记录为 attempted 时，只查询原 request-show。只有匹配的完成回执才可
继续同一提交；没有回执或中断 ACK 不自动重发。ACK 前的中断仍要求当前真实上下文证据，
不伪造时间戳或放宽时效。新的 scheduler stop 在 native I/O 期间出现时，发布 head 前再次核验。

本实现仍跨本地文件和原生调用，**不是同一数据库事务**；写锁不等于原生单写入口。
物理损坏、身份更换、过期且尚未 ACK、异常外部效果等仍可能需要受控人工对账，不能承诺全自动恢复。
原生生命周期事务内登记 effects、可核验业务进展模型、DomainPolicy/SessionAdapter 均未在本批实现。

## 验证与性能口径

定向离线用例见 `tests/test_coordinator_tui_submission.py`，并需回归既有 TUI workflow/scheduler、
monitor/recovery、terminal-idle 管道。报告见
[本次离线验证记录](docs/validation/reports/coordinator-submit-reliability-20261102.md)。
离线 fixtures 不证明真实消息唤醒、长期自治或 11 项 live 验收通过。本批未部署、未启动新 Agent、
未修改运行中的 Run。预期收益是减少模型编排步骤和漏提交的不确定性；没有测量或宣称 Agent
冷启动、Provider 会话初始化、首次 dispatch 的耗时改善。
