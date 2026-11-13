# issue-sedimentation 独立评审（trae）

结论：不建议按当前全文进入实现；可以先做最小的 incident capture / render / triage 版本，定期自动修复循环暂缓到判定权、归档单源和合并门禁写清后再实现。

## 评审口径

- 本轮只读评审 `issue-sedimentation.md` 及相邻设计/操作文档，未核代码、未跑测试、未验证运行时。
- 按已读文档区分：`progress_watch.py`、`coordinator_driver.py`、strict bootstrap P0/部分 provider 支持、blocking 隔离的若干本地能力属于周边已实现或部分实现；本草案里的 incident record、issue md 渲染、聚类、定期修复与关闭链路仍是设计中。
- 运维可用性的核心不是“能生成 md”，而是：谁能确认、谁能关闭、证据是否耐久、unknown 是否保持不可重放。

## 1. 判定权

当前 T1/T2/T3 的方向对，但缺最终裁决层，容易出现“每条通道都能触发，没人能确认”的灰区。

- T1 阈值型只能产生 `incident_candidate`，不能确认 bug。watcher/driver 的无进展、超时、退出无回执都只是观察；尤其 `unknown` / `needs_reconcile` 只能进入对账或人工核查，不能被提升为“系统 bug 已确认”。
- T2 验收型是最强触发，但“独立上下文”还不够精确。应要求验收者持有派发时固定的 acceptance contract / allowed paths / pins，并输出 `acceptance_failed` 的具体不变量，否则只是另一份意见。
- T3 自报型应默认 `unconfirmed_self_report`。执行者可以报告机制失效和最小复现，但不能确认自身实现不符合预期，也不能关闭同类 issue。
- 漏洞：系统层 bug 可能既没有 T2 验收角色，又未达到 T1 阈值，只剩 T3。这里需要一个显式的 incident triage owner，把 T3 或人工发现升级为 `confirmed` / `deferred` / `invalid`，并写明证据等级。

建议的最终判定权：

- 触发权：T1 watcher、T2 独立验收、T3 执行者均可开候选。
- 确认权：指定的 incident triage owner 或原任务验收角色；必须独立于被判定组件，且只能基于固定输入和可回读证据确认。
- 修复验收权：仍回到该问题所属域的既有交付/独立 review 门，不由 issue 系统自判。
- 关闭权：只有在 guardrail 证据、回归/审查证据、归档回读证据都存在时，由 triage owner 关闭；cron 不能关闭。

## 2. 定期修复循环边界

边界应分层设置，但硬闸必须在提案、审查、合并三处；只在触发层限流不够。

- 触发层：只做候选生成、去重、速率限制和 evidence quality 标注；禁止启动 agent、修改代码、重试 Run、清 latch。
- 提案层：可以生成 patch plan、guardrail plan、验收命令，但必须是只读产物。达到时间/数量/token 上限时输出 `proposal_incomplete`，不得自动延长。
- 审查层：独立 fresh context 审查候选是否同一问题、guardrail 是否能防复发、是否触碰授权边界。审查不通过降级为 `watch`，不是继续多试几次。
- 合并层：必须走现有 worktree delivery / 独立 review / 授权部署规则。issue 系统只能把修复候选交给交付流程，不能自带合并或部署权限。

如果要让运维敢开每日任务，第一版 cron 应只能做“读 archive、产出候选列表和提案草稿”，不能写源码、不能创建 worktree、不能启动新的执行 agent。

## 3. 聚类判据

`(class, typed_code, 影响面)` 是必要但不足够。它能粗分噪声，不能证明同一 bug。

建议把聚类指纹扩成：

- `class + typed_code + source_component + phase/stage + first_failed_invariant`
- `replay_class` / `may_replay` / `unknown_or_reconcile` 状态
- 触发通道 T1/T2/T3 与证据等级 L0/L1/L2
- operation fingerprint：固定输入 hash、契约 hash、关键对象类型、已确认最后动作
- 影响面：同一 Run、同一任务族、同一入口路径、或跨入口复发，分开记录

防噪声规则：

- L1/L2 只能进入 `needs_archive` 或 `watch`，不能参与关闭和高置信聚类；有 `dropped` / `partial` 时降低置信。
- T3 无 typed code 或无最小复现时只入 `unclassified_self_report`，不计入“同 pattern >= 2”。
- 对 expected wait、已知 platform outage、同一未闭合 unknown 的重复观测做抑制，避免把一个未对账事故刷成多个问题。
- 保留“单次高严重”通道：T2 证明违反不可重放、写入越界、pin/hash 不符时，不必等第二次复发。

## 4. 归档一致性

草案现在有双写风险：incident record、同目录 md、task md 指针、未来聚类 issue 文件都可能各自表达状态。

建议单源如下：

- canonical source：incident record JSON。外部采集器或验收器只写一次不可覆盖 record，字段含证据引用、证据等级、触发通道和未知边界。
- derived view：issue md 由 renderer 从 record 与 triage decision 渲染，带生成时间和源 record hash；md 不作为状态权威。
- index only：task md 或聚类索引只追加指针，不复述状态、原因和关闭结论。
- decision record：确认、去重、关闭、guardrail 链接写成独立 append-only decision JSON，再重新渲染 md；不要手改 md 再回填 JSON。

谁写：

- T1 外部 watcher/collector 写候选 record。
- T2 独立验收者写 acceptance incident 或 decision。
- T3 执行者只能写 self-report record，不能写 confirmed decision。
- renderer 只读 record/decision，生成 md 和索引。

写几次：

- 单个 incident 实例 record 写一次，不覆盖。
- 同类 issue md 可多次重渲染，但必须可由 record/decision 完整再生。
- 状态转移只追加 decision，不编辑旧 record。

这样才能满足 L0 归档和回读校验要求，也避免 NAS 不可用时把 L1/L2 临时诊断误写成 durable 结论。

## 5. 最小版本建议

如果只做最小可运维版本，砍到以下步骤：

1. 三通道只生成 `incident_candidate.json`，字段先覆盖 class、typed_code、trigger、expected/actual、unknowns、evidence refs、evidence grade、next_step。
2. 一个只读 renderer 把单条 candidate 渲染为 md，并生成 task/cluster 指针；md 全部由 JSON 再生。
3. 一个人工或指定 triage owner 的 decision 文件，支持 `confirmed | duplicate | invalid | watch | needs_archive`。
4. 只支持 exact-fingerprint 去重，不做智能聚类；跨 issue 合并先人工 decision。
5. 修复仍走现有开发/交付流程；issue 系统只要求关闭时链接 guardrail、审查证据和归档回读 hash。

首版应明确不做：

- 不做自动开 worktree、自动启动 agent、自动改代码、自动合并或部署。
- 不做 unknown / needs_reconcile 的自动重放。
- 不把 L1/L2 证据升级为 durable。
- 不把 T3 自报升级成已确认 bug。

这版虽然不“自动修复”，但运维可以真正用起来：能看到候选、确认责任人、证据等级、下一步和关闭条件；后续再把每日聚类和提案生成接上，不会先引入一个会自我放大的修复循环。
