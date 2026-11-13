VERDICT: BLOCK

结论：M2 的 report/IPC 主路径基本可保留，但 shadow/reconcile 是本阶段验收核心；当前存在可复现漏回放、replay 脱敏绕过、容量拒收阻塞后续 crash 的问题，修前不应进入 M3。

验证范围：已读 brief、设计 v2.3 §7.5/§11.2/§12/§13 M2/§14/§19.1，以及 M2 四个提交涉及的 incidents、CLI、IPC、preload 源码；运行定向 vitest：`incident-shadow.test.ts`、`incident-shadow-reconcile.test.ts`、`incident-report.test.ts`、`incidents-startup.test.ts`、`ipc/incidents.test.ts`、`preload/incident-bridge.test.ts`、`cli/handlers/incident.test.ts`，57 tests passed。另用 /tmp 简化脚本复现轮转水位问题，结果只回放首行。

## 必改项（按严重度）

1. 轮转水位不能用 basename+offset 判定文件身份，否则会跳过未回放内容。`incident-shadow-reconcile.ts:98,112,115,121-122,176-186` 按 basename 找水位；`local-file-sink.ts:106-132,300-309` 会把 base rename 为 `.1` 并新建 base。反例：base 写 a 并回放到 EOF；追加 b 未回放；轮转后 base→`.1`，新 base 写 c；下一次 findIndex 命中新 base 的 `shadow.ndjson`，从旧 offset 起读，`.1` 中 b 被整体跳过，新 base 若短于 offset 连 c 也跳过。具体改法：水位持久化必须带文件身份（dev/inode/ctime/size 指纹）并在身份不符时从最老文件重扫；更稳的是 shadow 行加单调 seq，水位记 lastSeq，按 seq>lastSeq 重放，DB UNIQUE 吸收重复。补回归：上述 a/b/rotate/c 场景必须插入 b、c 且重复 replay 不增行。

2. replay 不能信任 shadow 中的 evidence；当前可把未经 redactor 的 repro/路径/unknownBoundaries 写入 DB。`incident-shadow-line.ts:101-123` 原样重建 `line.evidence`；`incident-store.ts:145-146` 只 redacts `summary`，`JSON.stringify(record.evidence)` 原样落库；`incident-report.ts:138-143` 把 `code/repro` 放进 evidence。正常写 shadow 时 `incident-shadow.ts` 只保证 summary 路径有脱敏，不能防外部或旧版本 shadow。具体改法：抽一个 IncidentEvidence sanitize/redact 层，在 normal write、DB insert、shadow replay 共用；至少 redacts `repro` 和 evidence 内字符串数组，路径按设计边界裁剪/标记。补测试：恶意 shadow line 中 repro 含 secret，reconcile 后 DB evidence 不含原文。

3. capacity/store_refused 会让一个非 crash shadow 行永久挡住后面的 crash 行，且 stopped 不进入持久失败计数。`incident-store.ts:113-118` 非 crash 在 limited 时拒收但 crash 豁免；`incident-shadow-reconcile.ts:157-167` 遇任意 refused 立即 stop，`184-186` 只把水位写到上一好行；`incidents-startup.ts:65-83` 对 `summary.stopped` 只 warn，只有 throw 才 `recordShadowReconcileFailure`。反例：超容量时 shadow 顺序为 self_report、crash；startup 每次卡在 self_report，后续 crash 永不补回。具体改法：store_refused 应记录持久 failure/last_error；对 capacity_limited 的非 crash 要么写 durable dropped marker 后继续扫描，要么维护待重试队列但允许后续 crash 通过；补测试覆盖“非 crash 拒收后 crash 仍插入”。

## 8 个风险面结论

1. 轮转 × 水位：未排除，见必改 1。现有测试的“rotated-away watermark”只把水位指到不存在 `.9`，没有覆盖正常 base→`.1` rename 后 basename 仍命中的场景。

2. O_APPEND 并发 × partial line：已排除“越过未完整行”的主风险。`completeLines` 只产出 `\n` 结尾行（`incident-shadow-line.ts:24-34`），`readFileSlice` 先 stat 再读固定 slice（`36-54`），水位只推进到 yielded complete line（`incident-shadow-reconcile.ts:136-186`）。若 tail 没 newline，不消费也不推进。这个结论不覆盖必改 1 的轮转窗口。

3. replay 是否写入未经 redactor 内容：未排除，见必改 2。summary 在 insert 层会 redacts，但 evidence 不会。

4. 容量 latch × replay：未排除，见必改 3。crash 类写入本身有豁免，但 reconcile 的顺序 stop 会让前面的非 crash 拒收挡住后面的 crash。

5. self-report key 与 evidence：基本可接受但需补说明。`incident-report.ts:121-130` 使用 `source_kind=self_report` 的 key，不会与 pty exit key 冲突；显式 `--source-id` 是幂等键，重复上报不同内容会被 UNIQUE 静默去重，这是可接受的幂等语义但 CLI 文案要说清。`incident-report.ts:58-97` 流式 hash evidence，常量内存；但 `statSync` 跟随 symlink，且 pointer path 原样进入 evidence，隐私/归档边界需依赖必改 2 的 sanitize 策略。

6. 启动副作用：大体已排除。`incidents-startup.ts:38-58` attempt-once、无 userData/store unavailable 只 warn/return；`93-105` 用 `setImmediate`，不阻塞启动窗口；`50-53` reset cache 只在 startup reconcile 路径，不会每个 onPtyExit 重开 DB。缺口是 stopped 不持久化，见必改 3。

7. IPC/read model：已排除 M2 范围内的主要风险。`incidents.ts:120-158` 走同一 runtime store，store unavailable 返回 unavailable；`175-191` confirmed 仍要求显式 actor，其余 actor 为 `unspecified`；`preload/api/incident-bridge.ts:10-14` 暴露面很小。M3/M7 若加 UI，需要继续保持只经 preload 的白名单入口。

8. 测试真实性：多数测试用真实 SQLite/真实 shadow 文件，不是纯 stub；IPC 使用 `__configureIncidentStoreForTests`，足以测 handler 语义但不是 Electron 端到端。关键缺口：没有 base rename 后 basename 仍命中的水位测试；没有 malicious shadow evidence 脱敏测试；没有 capacity 非 crash 拦截后续 crash 的测试；startup 的 stopped 可见性只测 console，不测持久 failure counter。

## 补充项（M2 后续同批修更好）

- CLI `incident report` 在显式 `--source-id` 重复时应把“幂等去重，不代表新内容已记录”说清，避免操作者误以为修改后的 repro/evidence 已覆盖旧 incident。
- evidence pointer 当前存 path；若设计要求公共安全导出，report/detail 渲染层也要使用同一 sanitize 结果，不要把 DB 中历史 raw path 原样暴露给 renderer/Markdown。
- startup warn 应包含 stopped reason 的可机器读取计数或状态，便于 health/diagnostic 页面显示“shadow replay incomplete”。

## 可延后项

- renderer 侧更严格 channel whitelist、UI 过滤与分页交互可以留到有实际 UI 的 M3/M7，但不能绕过现有 preload API。
- 远端 SSH 宿主事实采集仍应保持 unsupported；M2 只记录本地 PTY/surface，不应扩展到远端判定。
