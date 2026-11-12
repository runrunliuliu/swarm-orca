VERDICT: BLOCK

结论：M3 不能进入 M4。采样/等待声明/默认 off 的基本形状成立，但 `no_progress` 写入面仍有两处核心不变量未守住：年龄口径会把健康长回合误判为停滞，`status_stall` 手工拼 key 绕过 `buildIncidentKey`/`cleanPaneKey`。

验证：已读 M3 brief、设计 v2.4 §6.2.1/§7.2/§11.4/§13/§14、提交 `ca786b41`/`88a3af71` 涉及源码。运行定向 vitest：`incident-stall-decision.test.ts`、`incident-wait.test.ts`、`incidents-stall-sampler.test.ts`、`cli/handlers/incident.test.ts`、`cli/incident-format.test.ts`，5 files / 61 tests passed。

## 必改项（按严重度）

1. 必须改 no_progress 口径，不能把 `now - max(stateStartedAt, turnStartedAt)` 当“没有进展”。`incident-stall-decision.ts:112-145` 只看 state/turn 开始时间；单个长回合中持续有工具调用、stdout、token 输出或文件写入时，`stateStartedAt`/`turnStartedAt` 都不推进，45 分钟后会 `stalled`。这不是“文案问题”：一旦 `INCIDENT_STALL_WRITE=on`，会写假事故；灰度的 `wouldStall` 也会高估噪声。改法：把判据拆成 `stateAge` 与 `activityAge`，写入必须基于最后可观测活动时间（tool event、PTY output、agent status evidence timestamp 或 transcript tail，取能稳定证明的最晚时间）；M3 若暂时拿不到活动源，则默认只能叫 `state_age_exceeded` 且不得写 incident。代价：需要在采样 source row/schema/CLI 增加 lastActivityAt/unknownActivityBoundary，并补“长回合持续活动不 stall、长回合无活动才 stall”的回归。

2. `status_stall` 写入必须走 `buildIncidentKey`，当前手工拼 `source_id` 是 M1 fallback epoch 同类校验旁路。`incident-stall-write.ts:45-52` 直接 `${facts.paneKey}:${stateStartedAt}`；但 `incident-key.ts:151-171` 已有 `status_stall` 分支，会要求 paneKey 符合 `^[^\s:]+:[^\s:]+$` 且 epoch 非空/非负/不含 separator。当前反例：`paneKey='bad:too:many'`、`paneKey='tab leaf'`、`stateStartedAt=NaN` 都可变成 store 接受的 sourceId；数字/string epoch 的规范化也不由写点保证。改法：`buildStallIncidentRecord` 调 `buildIncidentKey({kind:'status_stall', paneKey, stateStartedAt})`；失败时不写 incident，计入 coverage/diagnostic（如 `stall_key_rejected`），并补非法 paneKey/NaN epoch 不落库测试。

3. 若保留当前 45min 默认，写入开关必须继续硬 off 且 CLI/coverage 明示“state-age heuristic, not no-progress proof”。这是必改 1 的降级护栏，不是替代修复；否则 M4 的摘要/后续噪声会基于错误标签扩散。

## 9 个风险面核对

1. 年龄口径：未排除，见必改 1。`stallAgeMs` 的注释称 turnStartedAt 是 latest progress signal（`incident-stall-decision.ts:108-115`），但长回合内活动不会更新 turnStartedAt。

2. `STALL_REQUIRED_CYCLES`：已使用。常量在 `incident-stall-decision.ts:22-26`，判定读取 `thresholds.requiredCycles`（`140-143`）；采样器按 `paneKey\0stateStartedAt` 递增 `cyclesByEpoch` 并传入（`incidents-stall-sampler.ts:206-220`），消失的 epoch 会清理（`242-246`）。限制：重启后计数重置，设计上可接受；纯函数未传 `cyclesObserved` 时会用 `age/sampleInterval` 推导（`140-141`），测试覆盖慢采样不足（`incident-stall-decision.test.ts:90-102`）。

3. 等待声明生命周期：大体已排除 respawn 误续。声明 keyed by `(pane_key, epoch)`（`incident-wait.ts:89-104`），判定要求 epoch 等于当前 `stateStartedAt` 且未过期（`incident-stall-decision.ts:129-136`）；过期行被 sampler prune（`incident-wait.ts:126-133`、`incidents-stall-sampler.ts:191`）。缺口：无 `--until` 的旧 epoch 会一直留到 clear，`wait --clear` 实际清整个 pane（`incident-stall.ts:90-92`），不是“只清当前 epoch”；建议文案保持当前语义，并在 coverage 中避免把 stale no-deadline wait 误读为当前抑制。

4. 采样器契约：主要已排除。`startStallSampler` 防重复 interval（`incidents-stall-sampler.ts:116-145`）、`unref`、`stop`（`147-152`）；timer body catch 并写 sampler error meta（`122-140`）；store 不可用返回 null，并 5 分钟节流重试（`305-315`）。测试只覆盖 start/stop/idempotent（`incidents-stall-sampler.test.ts:258-266`），未真实驱动 interval tick 或 DB busy/disk full。

5. 幂等键一致性：未排除，见必改 2。重复采样同一合法 epoch 只落一行由 DB UNIQUE 兜住（`incidents-stall-sampler.test.ts:155-172`），但非法 key 被放过的路径未测。

6. 灰度默认 off：核心分支已排除。`stallWriteEnabled` 只有 env 精确等于 `on` 才 true（`incident-stall-write.ts:19-24`）；采样器仅在 `writeEnabled` 时调用 writer（`incidents-stall-sampler.ts:251-270`）；测试证明 `writeEnabled:false` 时 `wouldStall=true` 但 store count 0、coverage writes 0（`incidents-stall-sampler.test.ts:75-105`）。缺口：没有覆盖 options 缺省时 env 未设置的端到端测试。

7. 写入面复用不变量：部分已排除。`writeStallIncident` 走 `persistIncidentRecord`（`incident-stall-write.ts:107-116`），而 `persistIncidentRecord` 是 shadow first + insert（`incident-writer.ts:143-164`），所以 sanitize/immutable/shadow 路径复用；同 epoch duplicate、新 epoch 新行有测试（`incidents-stall-sampler.test.ts:155-200`）。未排除 key 构造，见必改 2。

8. CLI 语义：基本可接受。`--until` 用 Date.parse 且拒过去时间（`incident-stall.ts:28-44`）；未知 terminal 拒绝，声明绑定最后 sample epoch（`61-75,117-124`）；`stalls` read-only，store 不存在时 rows/declarations 为空并打印 coverage（`153-168`）。但 `--clear` 清全 pane 与 risk 提问的“只清当前 epoch”不一致，需文案/测试固定。

9. 测试真实性：多数是 real SQLite + 直接调 `sampleStallState`，不是纯 stub；默认 off、写入 on、wait、format 都有覆盖。缺口是关键反例：长回合持续活动、非法 stall key、env 默认 off 集成、真实 interval tick/异常路径、DB busy/disk full。

## 补充项

- `incident-stall-coverage.ts:20-21` 定义 sampler error meta，但 `readStallSampleCoverage` 不输出 errors/lastError（`28-40`）；建议加入 coverage，否则 timer 异常只写 meta，CLI/IPC 看不到。
- `formatIncidentStalls` 已写 “Writing incidents: off”（`incident-format.ts:261-266`），建议同时说明 `would=yes` 是灰度判定，不代表已记录 incident。

## 可延后项

- 真正 UI 的 channel/renderer 展示可延后；M3 CLI/coverage 形状先稳定即可。
- no-deadline wait 的老 epoch 垃圾回收可后续做 age cap，但 M3 至少要把 `--clear` 清全 pane 的语义写死。
