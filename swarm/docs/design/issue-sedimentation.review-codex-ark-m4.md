VERDICT: BLOCK

结论：M4 不能进 M5；tool_error 的事实边界和高危判定会产生错误事故，必须先修。

已核对：brief 9 个风险面、设计 v2.5 §6.2.1/§7.3/§10/§11.4/§13 M4、M4 两个提交的源码。辅助跑了：`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/incidents/incident-tool-error-classifier.test.ts src/main/incidents/incident-tool-error-window.test.ts src/main/incidents/incident-tool-error-observer.test.ts src/main/incidents/incident-digest.test.ts --maxWorkers=2`，4 files / 23 tests passed。

## 必改项（按严重度）

1. 高危分类不能由自由文本正则直接触发单次写入。`incident-tool-error-classifier.ts:41-47,85-95` 先匹配 output 文本，再看 exitCode；`incident-tool-error-observer.ts:127-145` 又把 `permission_denied` 作为 highSeverity 单次候选。因此反例成立：一次普通构建/测试失败，结构化退出码为 2，输出含断言文本 `expected "permission denied" in stderr`，会被判成 `permission_denied` 并单次写事故。实现者自报“只用结构化证据/结构化非零优先”与源码不符。改法：高危 permission/pin/scope/immutable 只能来自 provider/工具结构化拒绝码或明确结构化 error kind；自由文本最多作为低可信聚簇注释，不能触发 highSeverity。至少应让结构化 `exitCode != 0` 优先得到 `non_zero_exit`，并补上述反例测试。

2. 窗口键遗漏 turn，违反 §6.2.1 的幂等边界。设计表明确反例是“不同 turn 的同一工具错误被合并”，修正键为 `<sessionId>:<turn>:<code>:<windowStart>`；但 `incident-tool-error-window.ts:15-19,35-36` 的窗口 key 只有 session/tool/code，`incident-tool-error-observer.ts:127-156` 计数跨 turn，写库时才用 `window.lastTurn`。结果：turn A 的 4 次 + turn B 的第 5 次会写成 turn B 的一条事故，吞掉 A/B 边界；同一 session 里两个短 turn 的噪声可互相凑阈值。改法：把 turn 纳入 `ToolErrorWindowKey` 与 markWritten key；或如要跨 turn 聚簇，必须改设计 §6.2.1 并给新的 source_id/证据语义，但这会放弃已明确的反例修正。

3. “覆盖全部 provider”证据不足，且 sink 的 resolved append 旁路会漏计可能的工具行。当前只有 `claude-structured-session-adapter.ts:56` 与 `codex-structured-session-adapter.ts:54` 实现 `StructuredAgentSessionAdapter`；未看到 pi/trae/omp/opencode/qoder 进入该 structured sink 的证据。更具体地，普通 `appendItem`/`tryAppendItem` 会经 `structured-agent-session-event-sink.ts:257-291` 调 `appendJournalItemAndNotify`，通知点在 `structured-agent-session-journaled-item.ts:53-59`；但 `structured-agent-session-resolved-append.ts:48-56,92-97` 直接 `journal.appendItem`，没有 `onItemJournaled`。而 Claude/Codex 代码确实使用 `tryAppendResolvedItem*`/`tryReviseResolvedItem*` 路径。改法：要么把 observer 接到所有 item append sink 变体，要么证明这些 resolved/revision 路径永不承载 failed tool-call/tool-result，并补 provider 级测试；同时把未接入 provider 列为 coverage gap，而不是宣称全覆盖。

4. 5 次/10 分钟的“同 session+tool+code”目前没有来源上限，unknown/non_zero_exit 可被长会话噪声填满灰度快照。`incident-tool-error-window.ts:58-80` 512 是全局 LRU，不是每 session；`incident-tool-error-report.ts:49-55` 只发布前 50 个窗口。不是 M4 入口阻断点，但若打开写入前不加 unknown/non_zero_exit 限额，会把 digest/top fingerprints 的信号质量拖低。改法：对 `unknown`/`non_zero_exit` 增加单 session 限额或延后写入策略，至少在 coverage 中暴露被截断/驱逐计数。

## 9 个风险面核对

1. 写点覆盖与重复计数：结构化 Codex/Claude 的 live `appendItem`/`tryAppendItem` 已覆盖，证据见 `structured-agent-session-host-runtime-state.ts:68-79` mint sink、`structured-agent-session-attach-orchestration.ts:122-139,171-190,220-229` adopt/reattach、`event-sink.ts:257-291`。重复计数在同进程由 `(sessionId,itemKey,ordinal)` 去重，`incident-tool-error-observer.ts:55-69,117-119`；测试 `observer.test.ts:160-196` 覆盖重发同 item。fork/clone/resume/restore/backfill：fork/rewind 走 `replaceEpochItems('handle_forked')`（`structured-rewind-recovery.ts:156-158`）不经 sink；legacy import/clone 类历史导入走 `replaceEpochItems('legacy_import')`（`journal-legacy-import.ts:81-82`）不经 sink；restore/backfill 的 journal restore 直写 `host.journal().appendItem`（`journal-store-restore.ts:46-77`）不经 sink；resume/reattach 复用或采纳 live sink（`attach-orchestration.ts:175-190,220-229`）。这些避免历史重复，但“所有 provider”未证明，且 resolved append 旁路未排除。

2. `windowStart` 语义：已排除“写库时间”风险。`incident-tool-error-window.ts:83-94` 先过滤窗口内 timestamps，再 `windowStart = timestamps[0]`，即窗口内首次事件时间；`observer.test.ts:107-127` 断言 sourceId 尾部为第一事件时间。注意该幂等只在进程内窗口保留期间成立。

3. 分类器误判与安全：未排除，见必改 1。`incident-tool-error-blocks.ts:53-58` 的 exitCode 也是从 output 文本正则提取，不是 provider 结构化字段；message block 的 tool-result 直接 `exitCode:null`（`blocks.ts:38-45`）。测试只覆盖 phrase happy path 与“无 phrase 时 exitCode”（`classifier.test.ts:16-44`），没有“文本含 permission denied 但结构化非权限失败”的反例。

4. 高危名单：代码层只有 `HIGH_SEVERITY_TOOL_ERROR_CODES=['permission_denied']`（`classifier.ts:30-31`），但 permission 正则折叠 pin/scope/immutable/readonly/401/403（`classifier.ts:44-47`），所以“名单与设计一致”的成立前提是文本分类可信；当前不成立。修完结构化来源后，可以继续用一个 `permission_denied` 归一码承载四类高危。

5. 窗口内存与生命周期：已部分排除无界增长。全局 512 LRU 在 `window.ts:58-80`；重启清零是明示设计风险（`window.ts:6-10`、`tool-error-format.ts:49-51`）。未见 session 结束清理；这是可接受的 M4 限制，但需要 coverage/截断计数，否则读者不知道灰度快照被 LRU 裁剪。

6. 热路径成本与异常安全：基本排除。observer 外层 catch 不抛（`observer.ts:104-190`），append 后通知的 catch 不影响 journal append（`journaled-item.ts:53-64`）。但即使写入开关 off，`observer.ts:114-115` 仍先打开 runtime store 再判断 writeEnabled，并在 `176-177` 写 meta 发布窗口；这不是“零写入”，而是“零 incident 行”。若文案称零写入应改成零事故写入。

7. 灰度可信性：默认 off 不写 incident 行有真实 DB 测试（`observer.test.ts:76-99`），CLI 文案说明 wouldWrite 非已记录事故（`incident-tool-error-format.ts:41-48`）。但 off 仍会写 meta 快照，见上一条；打开后不会刷历史，因为窗口只在 live observer 内存中，restore/import 不进 sink。

8. digest 正确性：基本排除。`parseDigestWindow` 只接受 `s/m/h/d` 相对窗口（`incident-digest.ts:52-62`），无本地时区边界；聚合从 incidents join state 取有效状态（`70-89`），top fingerprints slice 5（`109-112`），dropped/replay/capacity 引用 coverage（`91-130`）。空库仍打印 coverage gap（`handlers/incident-digest.ts:28-67`），格式在 incomplete 时 warning（`incident-digest-format.ts:51-66`）。未发现重复计数。

9. 测试真实性：M4 incidents 单元测试是真 DB 层，不是全 stub；但覆盖不足集中在三个点：没有 provider 级 fork/clone/resume/restore/backfill 端到端测试，没有 resolved append 旁路测试，没有文本误判反例。现有 23 个 M4 相关测试通过不能证明上述风险不存在。

## 补充项 / 可延后

- Daily digest automation 的实际调度不应在 M4 代码里实现；当前 CLI 只读聚合符合 §10，自动化 wiring 可留 M5+。
- `unseen` 被定义为 effective status `untriaged`（`incident-digest.ts:7-9,81-88`），不是 per-actor read marker；这个语义可以接受，但文档和 CLI 帮助应继续明说。
- `tool_error_windows` 只发布 50 个窗口（`incident-tool-error-report.ts:19,54`），M4 可接受；后续若用于运营看板，应输出 truncated/total。

允许进入 M5 的最低条件：修必改 1-3，并补三类回归测试：文本含权限词但非权限失败、跨 turn 不合并、resolved append/provider 路径不漏或明确 unsupported coverage。
