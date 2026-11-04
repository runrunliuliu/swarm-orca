# 经独立审查的同 Run 恢复

状态：源码与离线故障测试；未部署，不是任何既有 Run 或 11 项 live 验收的通过凭据。
本入口不发送 Agent 消息、不启动 monitor/Worker，不接管 Coordinator，不授予执行权限。

## 适用范围

只处理 schema2/native-runtime monitor **已经退出且保留停止记录**、唯一最后续跑动作
已经发送但尚未 claim 的已知遗漏。支持的停止原因仅为
`tui_checkpoint_not_from_completed_turn`、`tui_scheduler_continuation_not_processed`。
`read=0` 是未 ACK，不代表消息未消费；已有 Delivery 由原 Coordinator 的原生 check 重放。

保持原 Run、owner/consumer generation、Coordinator TUI/session/incarnation、sender、配置、
状态根和旧停止证据。手工 STOP、scheduler 审查停止、已经 claim 的不确定动作、其他错误、
运行中的 monitor、身份/源码/证据漂移均拒绝。已有 workflow 的中断先对账，不能再创建恢复提案。
此版不支持对 schema3 已恢复计划再次恢复，也不替代独立业务验收。

**同 Run 恢复还要求同一个 runtime 实例。** `monitor-restart` 指原 sender/state 的
monitor 进程重启，不包含 Orca Server 重启。Server 重启后的新 `runtimeId` 即使仍返回相同
Run owner/generation、terminal/incarnation，也会被原生回包校验以 `runtime_mismatch`
拒绝；prepare、apply、complete 均不提供跨 runtime 重绑。持久会话映射或屏幕输入区也不能
替代当前 caller/就绪证据。不得替换旧 contract/config 的 runtime 或 hash、复用过期 review、
清 STOP 来继续。跨 runtime 恢复须另有受审查的完整协议，不能只修 monitor 一处的 pin。
独立协议及实现边界见 [跨 runtime 续接](operator-monitor-cross-runtime.md)：计划重启的 CLI、
Server 维护入口、Python prepare/review/apply/complete 与后续回合已接线并通过本地回归，
但未部署、未完成真实 Server/TUI 全链验收。这不改变本 same-runtime 入口的拒绝行为，
也不构成封存/解封生产数据库的许可。
当时的实机边界见 [2026-10-30 重启后记录](docs/validation/reports/operator-trust-validation-20261030.md#上线与重启后复验2026-10-30)。

## 流程与职责

```text
外层 prepare → 独立 review → apply（仅发布 reviewed.json）
  → 原 Coordinator begin → 获授权业务处理 → finish
  → 真实回合结束 → 外层 complete（最后发布 deployment.json）
  → 另行获准后，原 sender 启动并独立 verify
```

复用原有 strict caller、会话读取、claim/settle、checkpoint、scheduler 进度、原子文件发布、
monitor 部署和审查校验。脚本负责确定性复制、整批检查及提交顺序；业务执行和证据语义仍由
原 Coordinator/独立审查负责，不自动补 `met` 或生成通过结论。

### 外层准备与审查

在已授权维护范围内，外层准备者使用自己真实的 Orca Agent 身份；输出目录须为新的私有
空目录（0700），不得与两个状态根重叠。所有 `*-sha256` 都是 `{path,sha256}` **文件字节 pin**，
不是 authority-context 的 canonical JSON digest。沿用脚本输出引用，不手工混算两种 digest。

```sh
python3 -B /absolute/swarm/operator_monitor_recovery.py prepare \
  --plan /absolute/old/deployment.json --plan-sha256 OLD_FILE_PIN \
  --output-dir /absolute/new-private-directory
```

prepare 固定旧计划、STOP、完整 outbox/state 清单、head、源码及 30 分钟有效期。
持 monitor/continuation/workflow 非阻塞锁，复查原生 owner 和 sender；不消费、不 ACK、不恢复。
锁文件可被创建，业务状态和历史不改。原始任务授权/期限仍适用；提案时限不是扩展授权。

独立 Reviewer 不能是准备者、原 Coordinator 或 sender；审查固定提案、源码修复、原始授权及
业务风险，提供与已有 source-only upgrade 相同的回执：

```json
{
  "schema_version": 1,
  "proposal": {"path": "/absolute/proposal.json", "sha256": "FILE_PIN"},
  "approved": true,
  "reviewer": {"terminal": "review-terminal", "incarnation": "incarnation", "workspace": "worktree-id"},
  "evidence": [{"path": "/absolute/review-evidence.json", "sha256": "FILE_PIN"}],
  "reason": "审查依据与边界"
}
```

这仍是固定身份与证据的协作声明，**不是密码学签名，也不是新增业务授权**。不能由待验结果
反推原始授权，不能自填其他人的身份模拟独立审查。

```sh
python3 -B /absolute/swarm/operator_monitor_recovery.py apply \
  --proposal /absolute/proposal.json --proposal-sha256 PROPOSAL_FILE_PIN \
  --review /absolute/review.json --review-sha256 REVIEW_FILE_PIN --execute
```

apply 重新核验 Reviewer 当前真实终端及固定状态，发布 `reviewed.json`，返回其 pin。
此时状态是 `reviewed_not_resumed`，尚无可启动的新计划；重复 apply 不重放业务动作。

### 原 Coordinator 的回合封装

必须在**原真实 Coordinator 上下文**调用，不能复制它的环境变量到外层 Shell。

```sh
python3 -B /absolute/swarm/coordinator_tui_workflow.py begin \
  --config /absolute/original-continuation.json --config-sha256 CONFIG_FILE_PIN \
  --recovery /absolute/reviewed.json --recovery-sha256 REVIEWED_FILE_PIN --execute
```

begin 从固定 outbox 派生唯一 checkpoint/action/request/message，持久记录 consume intent，
原生 check 获取/重放整批 Delivery 后复用 claim。**仅 `execute_action:true` 才领取到动作**；
`already_claimed` 不允许再执行。claim 后崩溃只能对账，不能认为业务动作尚未发生。
输出 `batch` 是原生 Delivery 内容，message IDs 是处理清单；不以文件中自述代替事实。
若先得到另一批 Delivery，保留它并停下对账，不自动 ACK 或跳过。

原 Coordinator 完成原授权范围内的 action，并逐条处理同批消息。复用现有 result 格式
`{action_id,checkpoint,status:"executed",evidence:[pins]}`；另提供批处理清单：

```json
{
  "delivery_id": "delivery-id-from-begin",
  "messages": [
    {"id": "continuation-message", "evidence": [{"path": "/absolute/result.json", "sha256": "FILE_PIN"}]},
    {"id": "independent-fact-message", "evidence": [{"path": "/absolute/handled-fact.json", "sha256": "FILE_PIN"}]}
  ]
}
```

清单必须准确覆盖整批，无遗漏、重复或额外消息；续跑消息必须引用本 action result。
每条消息均须有可读、固定且位于授权范围的证据。程序检查结构和引用，不认证处理语义。
新 checkpoint 必须来自当前真实回合的领域 source/checker receipt，复用已有 projection
生成器；finish 接收新 projection pin，不接受自行填入已通过的状态。

```sh
python3 -B /absolute/swarm/coordinator_tui_workflow.py finish \
  --config /absolute/original-continuation.json --config-sha256 CONFIG_FILE_PIN \
  --recovery /absolute/reviewed.json --recovery-sha256 REVIEWED_FILE_PIN \
  --result /absolute/result.json --result-sha256 RESULT_FILE_PIN \
  --next /absolute/new-checkpoint.json --next-sha256 CHECKPOINT_FILE_PIN \
  --processed /absolute/processed.json --processed-sha256 PROCESSED_FILE_PIN \
  --receipt /absolute/new-workflow-receipt.json --execute
```

finish 先校验整批证据、当前回合、transition/下一动作防重及无进展门，再依次 settle、
`check --ack DELIVERY --peek`（不会顺便消费下一批）、原子推进 head、复用 turn-end。
完成后发布不可变 workflow receipt；只有该回执和真实 completed-turn 都成立才允许 complete。
这是有序、可对账的多个提交，**不是跨 runtime/文件系统事务**；中途失败可能已 settle 或 ACK，
必须检查 journal，不能重做 action。已固定的 finish 参数不能换；晚到消息或跨回合 checkpoint
过期会停止，需要重新对账，不能覆盖旧 finish/回执“修好”。

consume/ACK 先持久化唯一 request ID；回包丢失后只查 `request-show`。absent/pending/不匹配、
ACK 中断结果（如 `waitInterrupted:outcome_unknown`）都不视为完整成功、不盲目重放。
原生回执按 caller fingerprint 隔离：外层看不到原回执时 complete 停止，不能冒用 caller。

正常 schema2 回合也可显式使用此封装并省略 `--recovery`，但普通 continuation config 不含外层
monitor 状态根，不能证明外层无 STOP。恢复必须使用审查引用；缺引用的普通回执不能用于 complete。
封装仍是显式调用入口，**不是强制模型 turn-end hook**；模型完全不调用它时 scheduler 仍会停机。

### 发布与启动分开

原 Coordinator 真实结束当前回合后，外层调用：

```sh
python3 -B /absolute/swarm/operator_monitor_recovery.py complete \
  --permit /absolute/reviewed.json --permit-sha256 REVIEWED_FILE_PIN \
  --workflow /absolute/new-workflow-receipt.json --workflow-sha256 WORKFLOW_FILE_PIN --execute
```

complete 复查原生 consume/ACK 回执、workflow journal、全批证据、原动作唯一 claim/settle、
新 head、真实 completed-turn、pending-only mailbox 为空、无进展门以及所有未授权状态变化。
先发布 `committed.json`，最后发布 schema3 `deployment.json`，只返回 `reconciled_not_started`。
若下个 checkpoint 已进入 acceptance/alternatives/blocked 独立审查，本入口也不发布自动调度计划。

只有新的固定计划能识别**精确字节匹配**的旧 STOP 已完成对账。旧计划/直接 monitor 调用仍拒绝。
后续启动继续复用 `operator_monitor_deploy.py run/verify` 的原 sender 校验、锁与观察模式，
仍须满足实际启动授权和源码 pin；启动不会从本入口自动发生。
新故障写 `recovery-stop-<permit-file-sha256>.json`；旧 STOP 不删除、不覆盖。再次启动被新标记
阻断；手工 STOP 始终有效。不会把一次 review 变成永久忽略停止的开关。

## 验证与限制

离线回归入口：

```sh
cd /absolute/swarm
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:tests python3 -m unittest \
  test_coordinator_tui_workflow test_operator_monitor_recovery \
  test_operator_monitor_upgrade test_operator_monitor_deploy test_coordinator_tui_scheduler
```

覆盖整批漏项/重复、caller/owner/source/STOP 漂移、审查独立性、锁冲突、过期提案、claim/consume/
ACK/head/最终计划发布中断、未知 ACK、不覆盖历史、原 sender/state 重启去重和再次故障停机。
新计划按 [统一测试指南](docs/testing/reliability.md)在自主组验证 L-safety.monitor-restart 与
L-flow；两个原生 idle 唤醒子项另用各自固定 source 的 Run，不在原 Run 切换模式。
全组采集台账并完成适用的独立收尾；已有 Run 仍按其原归档的协议 pin 续验，
不能将本地 mock 结果计入原生/Agent 通过。保留原 `max_workers`、授权、时限和审查门。
