# M5 代码评审说明（评审者用，非设计正文）

- 分支：`issue-sediment`；基线 `17254007`（M4 完成，文档 v2.6）
- 被评提交：`acece904`（acceptance 声明存储 + argv 执行 + 结算门）、`b2358c17`（门点接入 + 停点 + resolve）
- 规模：19 文件 / +2096 / −20；落点 `orca/src/main/incidents/{acceptance-*,dispatch-acceptance-*}.ts`、`orca/src/main/runtime/orchestration/{lifecycle-reconciliation,coordinator}.ts`、`orca/src/main/runtime/rpc/methods/orchestration/messaging/send-methods.ts`、`orca/src/cli/*`
- 设计依据：`swarm/docs/design/issue-sedimentation.md` v2.6 §8（acceptance 一等概念）、§13 M5、§11.5、§6.2.1

## 实现者自报的 5 处偏差（请逐条判定）

1. 门点只读评估：federated / legacy 入箱的 `worker_done` **不会**自动评估，会以 `not_evaluated` 进入停点（可见、可 resolve）。
2. 停点用 incidents 侧投影 + **保留未读消息**；没有给 orchestration 加 `acceptance_pending` 状态列（那会改 v44）。`dispatch.status` 仍是 `dispatched`。
3. `resolve --accept` 不直接触发结算（CLI 进程没有 orchestration db），由下一 tick 重新处理未读消息完成。
4. 多规则串行执行（非并行）。
5. `--cwd` 必填：声明方必须给出 worker worktree（`dispatch_contexts.worktree_id` 是 id，不是路径）。

## 请重点核对（按风险排序）

1. **门点覆盖与事务边界**：枚举所有会消费 worker 报告并结算 dispatch 的路径（RPC `worker_done`、federated/legacy 入箱、`settleActiveDispatchesForTask`/`completeActiveDispatchesForTask`、`failActiveDispatchForTask`、lifecycle reconciliation、coordinator 侧）。门点是否**唯一**且覆盖全部路径？是否真的在写事务之外（给出调用链证据）？有没有路径绕过门点仍直接结算。
2. **停点是否真的"可见且有人拥有"**：保留未读消息 + incidents 投影，能否回答"谁该处理、多久没处理"？重启后是否仍然可见？**保留消息是否会导致每个 tick 重新执行 acceptance 命令**（成本/副作用）——attempts 累加在哪、有没有上限、失败重试是否可观测。
3. **命令执行安全**：argv 还是 shell；`--cwd` 由声明方给定，是否可能指向任意路径（超出 worker worktree）；env 是否继承宿主；超时与 stdout 上限；`--expect-stdout` 是子串还是正则（正则注入/ReDoS）；输出是否进 incident（必须只有摘要/哈希）。
4. **幂等与重复评估**：同 `ruleId` 重复声明、同 dispatch 多规则、resolve 之后再次评估、重复 `worker_done` 重放，各自结果是什么；`source_id` 是否带 epoch（dispatch + rule + attempt/window），会不会把两次不同判定折叠成一条。
5. **跨库一致性**：acceptance 声明与 stop 存在 incidents 库、dispatch 在 orchestration 库；dispatch 被删除/归档/重建后残留行如何处理；多宿主（远端 dispatch）是否会写出错误的本地判定。
6. **失败语义**：命令不存在 / 超时 / 宿主不可达 / 无 cwd，分别落到 `not_evaluated` 还是 `acceptance_failed`；`not_evaluated` 会不会永久静默停留而无人发现。
7. **无声明时的回归**：完全没声明 acceptance 的 dispatch，行为是否与今天**逐字节一致**（有测试证明吗）；默认路径是否多了一次 DB 读/一次 await 带来延迟。
8. **CLI 语义**：`declare/list/show/resolve` 的 actor 自报、`--reject` 之后是否真的不 fail dispatch、exit code 与 `--json` 形状。
9. **测试真实性**：路径级测试是否真的跑过真实结算函数（还是直接调 gate）；内存 orchestration db 是否掩盖了事务/锁问题。

## 纪律

- 只读评审：不改仓库源码，只写自己的评审文件；可跑测试、可写临时脚本到 /tmp。
- 跑测试：`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <path> --maxWorkers=2`（orchestration 目录请分批）。
- 已知与本轮无关的既有失败：8 条 orchestration/RPC 用例（SQLite DROP COLUMN 触发器行为、mobile release prepare 计数），在 `fc011d66` 上同样失败；不要把它们算作本轮缺陷，但如果你认为本轮让它们变多，请指出。
- 输出第一行必须是 `VERDICT: APPROVE | APPROVE-WITH-CHANGES | BLOCK`。
