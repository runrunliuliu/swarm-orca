# issue-sedimentation.md 独立评审（codex-ark）

评审范围：只读阅读 `AGENTS.md`、`entry-paths.md`、本草案、`strict-bootstrap-liveness.md`、`blocking-isolation.md`、`progress-watch.md`、`coordinator-driver.md`、`policies.md`。本文件是设计评审，不表示任何运行能力已存在；未做代码修改、未跑测试、未启动服务。

## 结论

暂不应直接进入实现阶段；先把判定权闭合、归档一致性、自动修复权限边界和已实现/设计中口径修正到可验收状态后，再拆小包实现。

## 文末 6 个待讨论问题的回答

1. T1/T2/T3 的划分方向正确，但不闭合。残留区间包括：验收判据本身缺失或错误；独立审查者没有目标领域权限/证据；checker、watcher、driver 同属待怀疑系统而共同出错；`unknown`/`needs_reconcile` 只说明不可重放、不说明谁有资格定性为 bug；进程外 watcher 停止、配置 pin 失配或 `query-stop.json` latch 已触发时无人应继续判定。需要新增 T4“人工/owner 裁决或外部权威输入”以及“untriaged/no-qualified-judge”终态，禁止把无人可判的区间升级为 confirmed bug。
2. 不建议直接扩展 `events.jsonl` 作为唯一 record。`events.jsonl` 适合不可变时间线；incident record 是聚合、分类、脱敏、归档索引和后续状态，语义不同。复用事件流的优点是少一套写入和顺序源，代价是污染低层事实日志、状态追加困难、L0/L1/L2 分级难表达、补档/回读校验会与运行事件耦合。建议：incident record 作为派生索引文件，必须引用原事件 offset/hash；不得成为新的事实源，也不得覆盖原事件。
3. 自动修复必须在四层都设边界。触发层只生成候选，不授予写；提案层只产出 patch/guardrail 计划和验收命令，不改源码；审查层必须由不同上下文和固定验收判据通过；合并/部署层仍走既有 worktree-delivery/部署授权。定时循环默认只读，代码修改需要新的独立修改任务和专属 worktree；达到时间、次数、预算、证据缺口、unknown/needs_reconcile 任一边界即停。
4. `(class, typed_code, 影响面)` 不足以区分同一 bug。相同 typed code 常是共享出口，可能覆盖不同根因。聚类键还应包含触发通道、失败阶段、op/request 位置、证据对象类型、replay_class、触发前最近的 confirmed action、目标协议版本/adapter/provider、未知边界集合。聚类只能给“候选同类”，关闭或合并 issue 仍需独立审查。
5. sparse task worktree 下，issue md 的 durable 归档应落在派发指定 archive；任务工作区最多保存草稿/指针。若设计文档需要示例，只能写虚构、脱敏、非运行证据。避免双写不一致的方法：单一 canonical record 在 archive，工作区文件只保存 archive index 指针及其 SHA256；补档后必须回读比较 hash；L1/L2 未补档前标 `durable=false/archive_pending`，不能出现在“已归档”摘要。
6. “每条 postmortem 必须产出 guardrail”不应无条件采用为关闭条件。应改成“必须产出防复发处置”：代码/测试/typed code/检查器/文档规则/监控阈值/外部依赖 SLA 记录/不修复理由均可。纯环境抖动若无法由本系统修复，应要求可复核的分类、降噪规则、重试/等待边界和归档证据；没有可执行 guardrail 时保持 `open-observed` 或 `closed-external`，不得伪造测试。

## 必须修改项（按严重度）

1. 关闭“无人有资格判定”的缺口。当前 T1/T2/T3 都假设至少一个观察者可信且有判据；这与 strict liveness 的 D3 教训冲突。必须显式支持 `no_qualified_judge/untriaged`，并说明何时需要 owner/外部权威输入。
2. 把“自动修复”降级为“定时只读挖掘 + 提案”，写入、合并、部署全部另行授权。否则与 `entry-paths.md`、`policies.md` 的“不自动扩大范围/不自动 retry/不自动接管”冲突。
3. 重写归档与证据等级。草案写 `swarm-artifacts/<run_id>/...`，但 AGENTS 要求工作目录与 archive 分离，blocking-isolation 要求 L0/L1/L2 不得越级。必须改成“archive 为权威，task/worktree 仅指针”，并加入回读 SHA256、`durable=false`、`archive_pending` 规则。
4. 明确已实现/设计中边界。草案把 progress watcher、driver、事故快照、证据分级、P1–P3 相关能力串成“触发信号齐全”，容易被读成已可端到端使用。应逐项标注：哪些已实现、哪些只是草案、哪些未部署/未 live 验收。
5. incident schema 不能记录真实私有身份字段。`run_id/task_id/dispatch_id` 等在公共设计中只能是字段名或虚构示例；真实值不得进仓库。schema 还要有脱敏级别、证据等级、权限来源、判定者资格、archive index hash。
6. “一个故障类只维护一份 issue”过早。未知或证据不足时合并会掩盖不同根因；应先一 incident 一 record，issue 聚类是可审查的派生视图。
7. 自报 T3 的 typed code 要降权。执行者自报可触发沉淀，但不能作为 bug 确认或同类聚类的强证据；缺最小复现时应是 `reported-unconfirmed`。

## 建议删除或收缩的过度设计

- §3.4 重新定义大量字段，重复了 `blocking-isolation.md` 的 wait-record/op-trace/snapshot、`coordinator-driver.md` 的 events/Journals 和 strict 的 replay_class。建议保留最小派生索引：分类、触发、证据引用、未知边界、下一步。
- §3.5 的 postmortem 模板可以保留，但“机制分析/防复发项”不应在生成阶段强制填满；自动渲染只能写事实，分析属于审查阶段。
- §3.6 “每日自动生成 patch 提案”是重复造一个开发调度器。已有 entry-paths、goal-loop driver、worktree isolation 和 delivery 流程；这里只需要产生候选任务，不要设计新的自动改代码循环。
- §3.7 度量可保留最小闭环指标；token/耗时如果无 ledger 覆盖必须是 unknown，不能让本设计再造费用账本。
- “一个故障类一份 issue，按 attempt 追加”建议删除，改为 record 不可变、cluster 可变、合并需审查。

## 遗漏的失败模式

- 系统 bug 导致验收判据本身错误，T2 无法发现，因为它按错误判据执行。
- watcher/driver/checker 的配置 pin 或 runtime identity 失配，正确行为是 unknown/latch，而不是继续沉淀 confirmed issue。
- 进程外采集器也卡住、权限不足或只拿到 L1/L2；此时只能报告证据等级不足。
- 独立审查者与执行者共享同一错误上下文、同一 provider adapter 或同一过期文档，形成“看似独立”的自审。
- unknown/needs_reconcile 期间发现同名文件或部分输出，被误聚类为成功/失败。
- sparse worktree 缺少 `swarm/tests`、`swarm/skills` 时，设计评审不能声称 checker/skill 行为已验证。
- 误报抑制依赖 `wait_reason/expected_wait_until`，但该声明本身可能陈旧、过宽或由出 bug 的组件生成。
- 自动聚类把同一 typed code 下的环境抖动、权限拒绝、协议 bug 合并，导致错误 guardrail。

## 风险与前置条件

- 权限：沉淀 issue 不授予重试、重启、部署、修改代码、创建 agent 或清理 evidence；修复必须另走独立修改任务、专属 worktree 和交付授权。
- 证据：L0 才能作为归档证据；L1/L2 只能定位，不能证明提交、取消、释放或验收。所有证据引用需 path+sha256+回读校验和脱敏策略。
- 误报：`wait_reason/expected_wait_until` 只能抑制无进展告警，不能证明等待合理；阈值型触发必须输出 unknown_boundaries 而非根因断言。
- 归档一致性：canonical record 只应有一个；工作区指针必须能回读校验 archive 副本，失败则 `archive_incomplete`。
- 判定资格：每个 confirmed bug 需要记录判定者、判据来源、与执行者的独立性；资格缺失时只能是 untriaged。
- 数据边界：公共仓库不得包含真实 Run/Task/Dispatch/terminal ID、私有路径、主机名、凭据、原始远端错误正文或 session 摘录。

## 可进入实现前的最低改稿清单

1. 加入 `untriaged/no-qualified-judge` 状态和 T4 owner/外部裁决通道。
2. 将定期循环改为只读候选生成；所有写入另行授权。
3. 明确 archive canonical、worktree pointer、L0/L1/L2 与回读 SHA256。
4. 将 schema 缩成派生索引并引用原事件/snapshot，不替代它们。
5. 给出一条虚构端到端示例，且逐段标注“已实现/设计中/缺口”。
