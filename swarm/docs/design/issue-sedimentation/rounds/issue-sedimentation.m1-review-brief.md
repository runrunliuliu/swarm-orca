# M1 代码评审说明（评审者用，非设计正文）

- 分支：`issue-sediment`（worktree 名 `issue-sediment`）
- 基线：`fc011d66`；被评提交：`916290df`（store/key/render）→ `640d285f`（onPtyExit 接入）→ `5a04946a`（CLI）
- 规模：31 文件，+4474/−1；`orca/src/main/incidents/` 15 个实现/测试文件
- 设计依据：`swarm/docs/design/issue-sedimentation.md` **v2.2**（§6 store、§7.1 crash 写点、§12 CLI、§13 M1 范围、§14 patch 卫生、§19.1 三条拍板决策）
- 本文件是评审者的输入摘要，**不是验收结论**；不作为仓库文档提交。

## 实现者自报的 10 处设计偏差（评审请逐条判定：接受 / 改代码 / 改文档）

1. `incident_decisions.incident_id` **不加外键**：prune 要删 incident 行但保留 decision 审计；RESTRICT 会禁止唯一允许的删除，CASCADE/SET NULL 会毁掉或孤立审计。
2. DELETE 触发器：仅当 **prune 事务内先置 `prune_deleting` marker** 时放行；UPDATE 无条件拒绝。marker 与 DELETE 同事务，中断即回滚。
3. `source_kind` 增加 `tool_error`（§6.2.1 的键举例里已含该 kind，§6.2 列注释漏了）。
4. `status` 增加 `closed`（prune 规则必须能命名它）。
5. **unknown 仅在 pane 曾有 agent 绑定时写 crash**；裸 shell 的模糊 0 退出记 `unknown_without_agent_binding` 并跳过。
6. `agentSessionId` 恒为 null（退出时 PTY 记录只有 `agentSessionOwners[].claim.identityDigest`），digest 放进 evidence，不伪造 id。
7. **M1 crash 记录 `pointers: []`**（§14 禁止在函数内反查，故无 transcript 路径）；md/CLI 显式打印"未记录证据指针"并列入 unknown 边界。
8. CLI 直连 SQLite（`list/show` 只读打开、不建 WAL、不迁移；`decide/prune --apply` 读写），不走 M2 的 shared 读模型 + IPC；非本机 selector 显式拒绝。
9. 容量 latch 落新表 `incident_store_meta`。
10. `synchronous = NORMAL`（WAL），不为每次 insert 付 fsync。

## 实现者自报的未验证项

- 无 live 验证（无构建产物、无真实被 kill 的 PTY）；链路靠真实 runtime 类 + 真实 SQLite 文件的集成测试覆盖。
- 未测 `onPtyExit` 那次同步 SQLite insert 的实测延迟。
- `src/cli/skill-guide-cli-parity.test.ts` 在本 worktree 跑不了（`orca/skill-guides` 不在 sparse cone）。
- 全量 `tsc` 仍有大量 cone 外既有 error（`src/relay`、`src/renderer`）。

## 请重点核对的 5 个风险面

1. **幂等/并发**：`ON CONFLICT(source_kind, source_id, facet) DO NOTHING` + epoch 键，是否真的覆盖重复 `onPtyExit`、并发写、以及 incarnation 缺失时的 fallback 键（`runtime:<id>:<generation>` 在第二次回调是否稳定）。
2. **不可变约束的真实强度**：trigger 是否可被绕过（如 `INSERT OR REPLACE`、`prune` marker 泄漏、marker 未复位、DDL 变更绕开）。
3. **容量闸**：行/字节阈值判定是否 off-by-one、latch 是否一旦置位就持久、crash 类是否真的不受限、`incident_store_meta` 是否会被 prune 清掉。
4. **CLI 状态机与安全**：`decide` 是否允许非法迁移（如 `confirmed → untriaged`）、`confirmed` 是否强制 `--actor`、`prune --apply` 的窗口计算与 `closed` 过滤、只读打开是否真的不写盘（含 WAL 副作用）。
5. **接线正确性**：`onPtyExit` 的调用位置与参数（是否在 `retire*` 之前、`operator_close` 是否确实不写、SSH surface/unconfirmed 是否保留 unknown、`hasAgentBinding` 判定是否会把非 agent 的 pty 误判）。

## 评审纪律

- 只读评审：**不要修改源码**，只写你自己的评审文件；可以跑测试、可以写临时脚本到 /tmp。
- 跑测试：`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <path> --maxWorkers=2`（`orca/node_modules` 已是指向共享依赖树的符号链接）。
- 输出开头必须是 `VERDICT: APPROVE | APPROVE-WITH-CHANGES | BLOCK`，以便与另一份评审比对共识。
