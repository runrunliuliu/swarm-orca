# M4 代码评审说明（评审者用，非设计正文）

- 分支：`issue-sediment`；基线 `bc77b19b`（M3 完成，文档 v2.5）
- 被评提交：`0d9464e7`（tool_error 采集 + 归一化码 + 灰度窗口）→ `5443dcc4`（每日摘要 CLI）
- 规模：21 文件 / +1805 / −7；主要落点 `orca/src/main/incidents/incident-tool-error-*.ts`、`orca/src/main/native-chat/agent-session-wire/*`、`orca/src/cli/*`
- 设计依据：`swarm/docs/design/issue-sedimentation.md` v2.5（§7.3 tool_error、§11.4 噪声、§13 M4、§6.2.1 幂等键、§10 摘要）

## 实现者自报

1. **写点**：`structured-agent-session-event-sink.ts`（会话事件追加路径），明确**不**在 restore/backfill（`journal-store-restore.ts`）与 `replaceEpochItems` 路径计数，避免历史回填重复。
2. **归一化码**：`permission_denied` … `unknown` 的固定集合；未识别一律 `unknown`；不落原始错误文本，只用结构化证据（如退出码/工具名）分类。
3. **高危单次直通**：`HIGH_SEVERITY_TOOL_ERROR_CODES = ['permission_denied']`。
4. **窗口**：同 session + 同 tool + 同 code，`TOOL_ERROR_WINDOW_MS = 10min`、`TOOL_ERROR_THRESHOLD = 5`，进程内滑动计数，`TOOL_ERROR_WINDOW_MAX_ENTRIES = 512` 上限，重启重置。
5. **幂等**：`source_id = <sessionId>:<turn>:<code>:<windowStart>`，`facet = 'tool_error'`，走 `buildIncidentKey`。
6. **灰度**：`INCIDENT_TOOL_ERROR_WRITE === 'on'` 才写，默认 off；只读面 `orca incident tool-errors [--json]`。
7. **摘要**：`orca incident digest [--since 24h] [--json]`，输出 class/status/fingerprint 计数、unseen、dropped、shadow replay、容量。
8. 测试（外层复跑）：`src/main/incidents` + `src/main/native-chat/agent-session-wire` + CLI/IPC 共 **161 files / 1365 tests passed**。

## 请重点核对（按风险排序）

1. **写点覆盖与重复计数**：`structured-agent-session-event-sink` 是否覆盖所有 provider（claude/codex/pi/trae/omp/opencode/qoder…）的 tool result？有没有 provider 走别的路径（journal 直写、hook 解析、native chat 增量）导致漏计；反过来，fork/clone/resume/replaceEpochItems/restore 是否会**重复**计数（要给出代码证据与测试）。
2. **`windowStart` 语义**：它是"窗口内第一次事件时间"还是"写库时的时间"？前者才能让重试幂等；后者会在重复采样/重试时产生多行。请给出结论与反例。
3. **分类器的误判与安全**：例如一条构建失败输出里含 "permission denied" 字样但实际是编译错误——会不会被判成 `permission_denied` 从而单次直通写事故？分类是否只用结构化字段（退出码/工具名/错误码）而不用自由文本？`unknown` 桶会不会无限膨胀并淹没真信号。
4. **高危名单**：设计要求 permission/pin/scope/immutable 类，但代码只有 `permission_denied` 一个。这是"classification 把其余折进 permission_denied"还是"漏了"？给出证据与建议。
5. **窗口内存与生命周期**：512 上限是全局还是每 key？session 结束/切换后 key 是否清理？长期运行会不会无界；计数在重启后清零是否会让"5 次"永远达不到（例如每次重启之间只失败 4 次）。
6. **热路径成本与异常安全**：每个 tool result 都会走这段；它是否 O(1) 且绝不抛？store 不可用/DB 忙时是否只计数不阻塞会话？
7. **灰度可信性**：默认 off 是否**零** incident 写入（有测试吗）；`incident tool-errors` 输出是否会被读成"已记录事故"；打开后会不会一次性刷出大量历史窗口。
8. **digest 正确性**：`--since` 解析与时区；top N 与总数是否可能重复计数；unseen/dropped/replay 状态与 DB 是否一致；空库时的输出是否等于"没有事故"（会不会掩盖 replay 卡住）。
9. **测试真实性**：窗口测试是否用真实时钟推进（还是直接改内部数组）；分类器是否只测 happy path；重复计数测试是否真的跑了 restore/backfill 路径。

## 纪律

- 只读评审：不改仓库源码，只写自己的评审文件；可跑测试、可写临时脚本到 /tmp。
- 跑测试：`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <path> --maxWorkers=2`（native-chat 请分批）。
- 输出第一行必须是 `VERDICT: APPROVE | APPROVE-WITH-CHANGES | BLOCK`。
