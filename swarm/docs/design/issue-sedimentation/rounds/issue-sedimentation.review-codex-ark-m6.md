VERDICT: BLOCK

结论：M6 不能进 M7。mine/digest 的只读面和 bounded 输出基本成立，但两个核心语义会让自动 triage 候选不可信：`distinct_source_ids` 把 epoch 当 source，且 `--apply` 在竞态下能覆盖人已做的 confirmed/watch 判断。

已核对：读 M6 brief、v2.7 §10/§11.4/§11.5/§13 M6 与提交 `6c08ce4f..c6097d32` 源码。执行 `cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/incidents/incident-mine.test.ts src/cli/handlers/incident.test.ts --maxWorkers=2`，2 files / 62 tests passed。另尝试把反例放 `/tmp` 跑，现有 vitest include 只收仓库内测试，未被收集；未改仓库源码。

必须修改（按严重度）：

1. `≥2 个不同 source_id` 在 epoched key 下形同虚设，会把单点重复误判成跨源复现。
   - 证据：规则直接 `new Set(rows.map(row => row.sourceId))`（`orca/src/main/incidents/incident-mine.ts:248-252`），cluster 也直接报告完整 `sourceId` 去重数（:282-286）。但 key 设计明确 `sourceId` 含 epoch（`incident-types.ts:128-132`），具体 writer 包括 `status_stall` 的 `<paneKey>:<stateStartedAt>`（`incident-key.ts:151-171`）、`tool_error` 的 `<session>:<turn>:<code>:<windowStart>`（:174-198）、`acceptance` 的 `<dispatch>:<attempt>`（:200-223）。
   - 反例：同一 pane 三次静默，若 state/threshold 相同，fingerprint 相同（`incident-stall-write.ts:75-80`），sourceId 分别含三个 `stateStartedAt`，会满足 `repeat_fingerprint`。同一 session/同一工具同 code 的两个 turn/窗口也会被当成不同 source。
   - 改法：新增 `stableSourceKey`/`distinctEvidenceSources`，按 sourceKind 去掉 epoch 或改用更可靠维度：status_stall 至少按 paneKey，tool_error 至少按 session+tool/code 或 session，acceptance 按 dispatch/rule，pty_exit 用 agentSession/worktree/run 等可得实体；候选阈值用该字段，并在输出中同时显示 epoch rows 与 stable sources。补回归：同一 pane 三个 epoch 不触发，两个不同 pane/session/worktree 才触发。

2. miner 可在 apply 竞态中推翻人的判断（尤其 confirmed → duplicate）。
   - 证据：candidate 生成只选择当时的 untriaged 行（`incident-mine.ts:379-395`），但 apply 只跳过 terminal 与 already target（:532-555），随后直接 `appendDecision`（:557-563）。状态机允许 `confirmed -> duplicate/invalid/watch/needs_archive`、`watch -> duplicate/invalid/needs_archive`（`incident-types.ts:76-82`），`appendDecision` 事务内只按 `canTransition` 判断（`incident-store.ts:185-199`）。
   - 结果：mine 之后、append 之前，R1 把候选设为 confirmed；miner 若 `--target duplicate`，会追加 duplicate，`incident_state` 取最新 decision（`incidents-database.ts:109-119`），人的 confirmed 被投影层覆盖。
   - 改法：自动 miner apply 只能从当前 `untriaged` 且最好仍等于 `candidate.fromStatus` 的状态写入；其他状态一律 `skipped_status_changed` / `skipped_human_decided`，不得依赖通用 R1 transition 表。补测试：mine 后人工 confirmed/watch，再 apply duplicate/needs_archive 不追加，effective status 不变。

逐项风险核对：

1. distinct source：未排除，见必改 1。现有测试只测相同字符串 sourceId 不触发（`incident-mine.test.ts:143-150`），没有 epoched 同实体反例。

2. fingerprint 边界：分量是 class/sourceKind/facet/signature（`incident-key.ts:247-263`）。未包含 turn/windowStart，因此 tool_error 不会因窗口分裂；但 tool_error 只按 code+tool 聚合（`incident-tool-error-report.ts:123-128`），crash 只按 exit signature+surface（`incident-pty-exit.ts:180-185`），有过聚合风险。status_stall 包含 threshold（`incident-stall-write.ts:75-80`），默认变化会分裂同类静默；self_report fingerprint 含 request id（`incident-key.ts:225-242`，`incident-report.ts:179-184`），几乎不能聚类同 code 报告。建议 M6 后补 fingerprint 版本/解释字段，至少把自报改按 code 聚类或文档声明不挖掘 self_report。

3. confirmed/人工决策冲突：fresh mine 不会把已 confirmed 行列为 candidate，因为 candidate 只取 untriaged（`incident-mine.ts:379-395`）；但 stale/racing apply 可覆盖 confirmed/watch，见必改 2，未排除。

4. 幂等与并发：同 target 两个 CLI `--apply` 基本已排除重复追加。`appendDecision` 在 `BEGIN IMMEDIATE` 内重读 effective status（`incident-store.ts:66-75`、:185-199）；第二个 writer 会看到第一条 decision 后返回 unchanged/terminal。不同 target 或人工决策竞态仍需用必改 2 收口。

5. 有界与确定性：排序确定（count desc、firstSeen asc、fingerprint；`incident-mine.ts:357-365`），输出 truncation 显式（:426-433；formatter `incident-mine-format.ts:41-57`）。但 `timeBudgetMs` 只在候选循环检查（`incident-mine.ts:373-389`），SQL scan、digest scan、group/sort 已经完成；它不是全 pass 成本上界。

6. dry-run 零写入：已排除。CLI dry-run 用 readOnly store（`cli/handlers/incident-mine.ts:77-83`）；无库时返回 stub 不创建（`cli/incident-store-access.ts:109-115`）；存在库 read-only open 避免迁移/sidecar 创建（`incidents-database.ts:264-307`）。测试覆盖 dry-run 不写 decision（`cli/handlers/incident.test.ts:653-662`），但建议补“无库不创建文件”的断言。

7. digest 与 mine 共用：有实际共用。`buildIncidentMine` 嵌入 `buildIncidentDigest(...)` 返回对象（`incident-mine.ts:406-412`），text 也共用 `formatDigestCoverage`（`incident-mine-format.ts:7-8`、:128-134）。CLI 测试比对 digest/mine numbers 与共享 markers（`cli/handlers/incident.test.ts:664-710`）。空库分支手工构造同 shape（`cli/handlers/incident-mine.ts:94-141`），可接受但需随 DTO 变更保持测试。

8. 成本：`readRows` 拉取窗口内全量 rows 并在 JS 中聚合（`incident-mine.ts:191-217`、:335-365），另 digest 再扫窗口并 count 全表（`incident-digest.ts:70-97`）。有 `idx_incidents_created_at`（`incidents-database.ts:86-88`），50k 量级可接受；但 time budget 不保护 scan/group，M7 自动化前应记录耗时/rows 或加硬上限。

9. 测试真实性：核心 SQL/effective status 测试是真库（`incident-mine.test.ts:36-44`），边界 3 rows/2 source、终态排除、caps、dry-run、CLI apply/digest 都覆盖。但缺少 epoched same-entity source、confirmed/watch between mine/apply、两个真实连接并发 apply、无库 dry-run 文件级零写入。

补充项：
- `MINE_SMALL_CLUSTER_MIN_ROWS` 的 `crash_signaled` 不要求 distinct source（`incident-mine.ts:254-260`，测试同一 source 两行通过 `incident-mine.test.ts:152-158`）；这可能是刻意“强信号”规则，但输出需标明可能来自同一实体反复崩溃。
- `--apply` 默认 target=watch 较安全；`duplicate`/`needs_archive` 风险更高，建议 CLI 文案强调 miner 是候选分流，不是事实确认。

可延后：
- 真正 scheduler/automation 类型、repair task 创建、issue md 批量视图仍可留到 M7+；本轮只需把候选和 append-only triage 的安全边界修好。
