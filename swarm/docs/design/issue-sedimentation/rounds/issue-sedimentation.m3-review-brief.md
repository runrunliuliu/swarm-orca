# M3 代码评审说明（评审者用，非设计正文）

- 分支：`issue-sediment`；基线 `52315f44`（M1+M2 完成）
- 被评提交：`ca786b41`（等待声明 + 停滞判定）→ `88a3af71`（采样器、`stalls`/`wait` CLI、灰度写入）
- 设计依据：`swarm/docs/design/issue-sedimentation.md` v2.4（§7.2 no_progress、§11.4 噪声、§13 M3、§14 patch 预算、§6.2.1 幂等键）
- M3 的目标是**能力完整 + 默认不写 incident**（灰度）：默认只产出"可观测年龄 + 判定结果"。

## 实现者自报

1. 阈值常量：`STALL_THRESHOLD_MS = 45min`、`STALL_REQUIRED_CYCLES = 2`、`STALL_SAMPLE_INTERVAL_MS = 60s`（`incident-stall-decision.ts:22-26`）。
2. 年龄口径：`stallAgeMs = now − max(stateStartedAt, turnStartedAt)`（`incident-stall-decision.ts:112-115`）。
3. 采样器：单个 `setInterval(60s)` + `unref()`（`incidents-stall-sampler.ts:9-14` 说明为何这是唯一新增定时器：状态应用是事件驱动、reaping 是一次性扫描、hook server 只有 OpenCode binder 的 provider 专用 interval）。
4. 写入开关：`INCIDENT_STALL_WRITE === 'on'` 才写，默认 off（`incident-stall-write.ts:20-22`）。
5. 写入键：`source_id = <paneKey>:<stateStartedAt>`，`facet='stall'`，`class='no_progress'`（`incident-stall-write.ts:49-52`）。
6. 等待声明：CLI `orca incident wait --terminal ... --reason ... [--until] / --clear`；判定要求声明的 `epoch === String(stateStartedAt)` 且未过期（`incident-stall-decision.ts:129-136`）。
7. 只读面：`orca incident stalls [--json]` 输出各 pane 的 state/age/阈值/声明/`wouldStall`/reason。
8. 测试（外层复跑）：`src/main/incidents` + `src/main/startup` + CLI/IPC/preload 共 92 files（90 passed / 2 skipped），824 passed / 10 skipped。

## 请重点核对（按风险排序）

1. **年龄口径是否等于"没有进展"**：`max(stateStartedAt, turnStartedAt)` 在"单个长回合、期间持续有工具调用与输出"的任务里不会推进。45 分钟后会不会把健康长任务判成 `stalled`？这是 false positive 还是符合 §7.2 的"无状态进展"？若符合字面但违背"跑不下去"的意图，请给出你认为正确的口径（例如引入 lastActivity/last tool event）与代价。
2. **`STALL_REQUIRED_CYCLES = 2` 到底如何满足**：判定函数里是否真的用到了 cycle 计数？重启/采样间隔变化/节流后，这个条件会不会永远不满足或形同虚设？给出代码证据。
3. **等待声明的生命周期**：声明以 `paneKey + epoch` 取值，pane 复活（同 paneKey、新 incarnation）后旧声明是否会误续；`--until` 过期后是否清理、表是否无界增长；`--clear` 是否只清当前 epoch。
4. **采样器的运行时契约**：会不会被重复启动（重复 interval）？shutdown/reload 是否停止？`unref()` 是否真能让进程可退出？store 不可用/DB 忙/磁盘满时是否零工作且不抛？timer 内异常是否会导致进程崩溃或静默停摆？
5. **幂等键一致性与校验旁路**：`incident-stall-write.ts:51` **手工拼** `source_id`，没有走 `buildIncidentKey`/`cleanPaneKey`。这是否是一处校验旁路（非法 paneKey、缺 epoch 都会被放过）？`stateStartedAt` 为数字 vs 字符串时是否可能生成两行？paneKey 自身含 `:` 时复合键是否仍唯一？请给出反例或证明安全（参考 M1 的 fallback epoch 事故：同一类问题换了个位置）。
6. **灰度是否真的可灰度**：默认 off 时是否**零** incident 写入（有测试吗）？计数器/覆盖缺口是否能让灰度观察者判断"本来会写多少条"？`stalls` 在没有写入时输出 `wouldStall=true` 是否会被误读为"已记录事故"？
7. **写入面是否复用既有不变量**：`no_progress` 行是否同样走 shadow、统一 sanitize、不可变触发器；重复采样是否只落一条；恢复后新 epoch 是否另起一条。
8. **CLI 语义**：`wait --until` 的时区/格式/过去时间、`--clear` 与 `--until` 互斥、`stalls` 在 store 不存在时的输出、`--json` 形状与 CLI/共享 DTO 是否一致。
9. **测试真实性**：假时钟是否真的驱动了采样器（还是直接调纯函数）；有没有把 interval 替换成 stub 而实际未覆盖重复启动/停止。

## 纪律

- 只读评审：不改仓库源码，只写自己的评审文件；可跑测试、可写临时脚本到 /tmp（可复制 worktree 的模块到 /tmp 做反例）。
- 跑测试：`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <path> --maxWorkers=2`。
- 输出第一行必须是 `VERDICT: APPROVE | APPROVE-WITH-CHANGES | BLOCK`。
