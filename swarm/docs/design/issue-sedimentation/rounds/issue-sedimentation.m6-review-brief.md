# M6 代码评审说明（评审者用，非设计正文）

- 分支：`issue-sediment`；基线 `98445966`（M5 完成，文档 v2.7）
- 被评提交：`6c08ce4f`（聚类 + 候选）、`da7adf4f`（miner 决策：有界/只追加/幂等/永不做 confirmed）、`c6097d32`（digest 与 mine 共用一套口径）
- 规模：9 文件 / +1688 / −26；落点 `orca/src/main/incidents/incident-mine.ts`、`orca/src/cli/*`、`orca/src/shared/incident-api-types.ts`
- 设计依据：`swarm/docs/design/issue-sedimentation.md` v2.7 §10（定期挖掘与修复）、§11.4 噪声、§11.5 容量、§13 M6

## 实现者自报

1. 按 `fingerprint` 聚合；候选规则：7 天内同 fingerprint ≥3 条且 ≥2 个不同 `source_id`；`crash+signaled` 与同 invariant 的 `acceptance_failed` 允许 2 条进候选。
2. 终态行（`duplicate`/`invalid`/`closed`）不计入簇计数，输出里说明被排除数量。
3. `--apply` 只能写 `watch` / `duplicate` / `needs_archive`；`confirmed` 在常量里被排除。
4. 幂等：目标状态或终态时跳过（`skipped_terminal` 等 outcome），重复运行不追加第二次 decision。
5. 上限：`DEFAULT_MINE_MAX_GROUPS = 20`、`DEFAULT_MINE_MAX_CANDIDATES = 20`，超出给 `truncated` 与总数。
6. 默认 dry-run；`digest` 与 `mine` 共用同一套 DTO/format 词汇。
7. 测试（外层复跑）：incidents + CLI + IPC：27 files / **307 tests passed**。

## 请重点核对（按风险排序）

1. **`≥2 个不同 source_id` 是否会被轻易满足**：`source_id` 含 epoch（例如 `paneKey:stateStartedAt`、`session:turn:code:windowStart`）。同一个 pane 停顿两次、或同一会话两个 turn，就算两个 source 吗？这样的规则会不会把"单点重复"误判成"跨源复现"？请给出代码证据与你的判定（若成立，给出应改成什么，例如 distinct worktree/session）。
2. **fingerprint 的语义边界**：它由哪些分量构成（class/sourceKind/facet/signature）？signature 里是否包含 windowStart/threshold/turn 这类会**分裂**同一类错误的量？会不会两个不同 bug 撞同一 fingerprint（过聚合）？
3. **miner 与人的决策冲突**：miner 能否把 `confirmed` 或 `watch` 改成 `duplicate`？`canTransition` 允许哪些？一条已 `confirmed` 的 incident 被 miner 标 duplicate 会不会抹掉人的判断（append-only 但状态投影变了）。
4. **幂等与并发**：同一 incident 两条 miner 决策并发（两个 CLI 进程）会不会都写入？`--apply` 重跑的结果是否稳定；watch→watch 是否被跳过。
5. **有界与确定性**：`maxGroups` 与 `maxCandidates` 的相互作用；排序（count？first seen？）是否确定；`truncated` 是否可能让"没候选"看起来像"没数据"。
6. **dry-run 是否真的零写入**：会不会仍写 meta / 计数器；`--json` 里是否出现尚未发生的写入。
7. **digest 与 mine 是否真的共用**：是共享 DTO/格式化函数，还是复制了两份（后续会分叉）。
8. **成本**：50k 行走一次全表扫描 + 聚合的实现方式；`--since` 解析与索引使用；是否会在主进程或 CLI 造成明显停顿。
9. **测试真实性**：边界（刚好 3 条/2 个 source）是否真的构造了；终态排除是否是真实库；并发幂等是否真的两个连接。

## 纪律

- 只读评审：不改仓库源码，只写自己的评审文件；可跑测试、可写临时脚本到 /tmp。
- 跑测试：`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <path> --maxWorkers=2`。
- 已知既有失败：`worker-release-mobile-report.test.ts` 的 2 条（mobile unary/stream）在基线 `fc011d66` 同样失败，不算本轮缺陷。
- 输出第一行必须是 `VERDICT: APPROVE | APPROVE-WITH-CHANGES | BLOCK`。
