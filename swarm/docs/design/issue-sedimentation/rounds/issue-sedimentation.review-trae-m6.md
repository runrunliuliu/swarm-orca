VERDICT: BLOCK

结论：M6 当前不应进入 M7。`mine` 的只读/有界/append-only 形状基本成立，测试也通过；但候选规则把 epoch 型 `source_id` 当成“不同来源”，会把同一 pane/session 的重复事件升级成 triage 候选。这个会直接污染值班会/周会清单，先修再做 UI/远端聚合。

## 核对与测试

- 读了 M6 brief、v2.7 设计 §10、§11.4、§11.5、§13 M6。
- 核对提交：`6c08ce4f`、`da7adf4f`、`c6097d32`。
- 测试：
  - `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/incidents src/cli/handlers/incident.test.ts src/cli/incident-format.test.ts --maxWorkers=2`
  - 结果：26 files / 300 tests passed。

## Blocking Findings

1. `distinctSourceIds` 不是跨源复现。
   `buildCluster()` 用 `new Set(rows.map(row => row.sourceId)).size`，而 source_id 对 `status_stall` 是 `<paneKey>:<stateStartedAt>`、对 `tool_error` 是 `<sessionId>:<turn>:<code>:<windowStart>`。同一个 pane 停三次、同一个 session 三个 turn 同类错误，都能满足“≥2 source_id”。这不是“跨 worktree / session / dispatch / host”复现，而是同一实体多 epoch。周会会把单点重复误读成跨源模式。

2. small-cluster 规则不要求 distinct source。
   `crash_signaled` 只要两条 crash 且其中有 signaled；`acceptance_invariant` 只要两条同 facet acceptance_failed。两条来自同一个 dispatch/rule 或同一个 pane 的重复事件也可能变成候选。强信号可以低阈值，但至少应要求两个稳定实体或明确输出“single-entity recurrence”。

3. time budget 不覆盖全表扫描和聚合。
   `readRows()` 先把窗口内所有 rows 读进内存，再 group/sort；`timeBudgetMs` 只在生成 candidates 时检查。50k 行时大概率可接受，但 `timeBudget` 不能保护慢磁盘/大窗口的 query/group 成本。若输出写 “time budget ran out”，也只说明候选截断，不说明扫描成本已受限。

4. `--apply --target watch` 容易稀释人工 triage 队列。
   miner 只对 untriaged rows append decision，且不会改 confirmed/terminal，append-only 是对的。但一旦 scheduled automation 使用 `--apply` 默认 target=watch，所有候选会从 unseen/untriaged 消失；真正要紧的候选可能被“miner 已看过”淹没。默认 dry-run 降低风险，但文档/automation recipe 必须禁止无人工复核的 apply。

## 值班/周会可用性

- `incident mine` 输出 count、distinct source ids、class/source kind、first/last、worktrees/runs、representative id、candidate ids，并嵌入 digest/coverage。它能支撑“先看哪些簇”的会议。
- 缺字段：稳定来源维度（distinct pane/session/dispatch/worktree/run）、每个候选的短 summary/cause、最新 decision/owner action。当前需要再 `incident show <id>` 才能判断内容。
- `unknown` / `non_zero_exit` 这类低信息 fingerprint 没有降权或限额，可能占据 top candidates；需要在 mine 输出里标低信息簇或默认排在强规则后。

## 噪声 / 误伤

- 同一 pane 两次停顿不会因 general rule 直接候选（需要 3 rows），但三次会；同一会话两个 turn 不够，三个 turn 会。
- `watch` 自动标记不会覆盖人的 terminal decision，也不会改 confirmed；但它会改变 effective status，从后续 candidates/unseen 中移除，可能让人误以为已经处理。
- miner 不会 set `confirmed`，这点正确。

## 成本与有界性

- 50k active rows：一次 SQL read + JS Map group + sort，内存 O(rows)。这个量级能跑，但不是严格 bounded by `timeBudgetMs`。
- `maxGroups/maxCandidates` 只限制输出/decision 数；`totals` 仍描述全窗口，这是好事。
- `truncated` 文案清楚，说明 totals 是全窗口，不会让人以为“只有这些”。

## Automation 前置

- scheduled automation 需要在拥有本机 userData 的宿主上运行 CLI，不能用 `--host` 远程查询。
- 建议命令只用 dry-run：`orca incident mine --since 24h --json`，cwd 不重要但应固定到 Orca CLI 可解析 userData 的环境。
- actor 只有 `--apply` 时才写 decision；dry-run 无 actor。
- 退出码应作为 automation 成败；空库是成功且带 coverage gap，不是故障。

## 9 个风险面分类

- 必须改：1 source diversity 语义；2 small-cluster 单实体候选；3 time budget/成本口径；4 automation apply 文档或防误用。
- 补测试：同 pane 三次停顿不应被标“跨源复现”；同 session 三 turn tool_error 的 mine 行为；两条同 dispatch acceptance 不触发 small-cluster；50k rows mine 耗时/内存基本回归；watch apply 后 digest/unseen 语义。
- 可接受写文档：terminal rows 排除；append-only/idempotent apply；dry-run 零写入；digest/mine 共用 DTO；truncated semantics。

## 最小必改集（≤5）

1. 将候选阈值从 `distinctSourceIds` 改为稳定来源多样性：按 source kind 计算 pane/session/dispatch/worktree/run，至少在输出中拆分 `distinctEpochs` 与 `distinctStableSources`。
2. small-cluster 规则要求两个稳定来源，或把单实体重复标成单独规则 `single_source_recurrence` 且不默认进入 top candidate。
3. 对低信息簇（`unknown`、泛 `non_zero_exit`）降权/限额，避免占满候选榜。
4. 让 time budget 覆盖或明确不覆盖 query/group；若不覆盖，输出 `scanRows/scanMs/groupMs`，便于值班判断成本。
5. 文档/CLI help 明确 scheduled automation 默认 dry-run，不建议无人值守 `--apply`；如支持 apply，要求显式 target/actor/理由。
