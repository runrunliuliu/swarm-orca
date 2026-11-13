VERDICT: AGREE

1. 对合并清单的反对/范围意见

- 无反对项。M4-C1/M4-C2 是进入 M5 前的硬门槛：它们分别影响“什么事实可单次写事故”和“同一事故窗口的事实边界”，不是文案问题。
- M4-C3 不超出 M4：M4 的目标是 tool_error 采集，若 resolved-append 或未接入 provider 可承载 failed tool result，就会形成系统性漏采；若实现者认为不可能，给出不变量 + provider 级测试即可。
- M4-C4 同意作为 M4 内修，但可拆口径：必须立刻修“零写入”文案为“零 incident 行”，并暴露 LRU/发布截断；unknown/non_zero_exit 噪声限额若不在本轮实现，必须作为 coverage 缺口和打开写入前置条件记录。
- M4-C5 是文档层澄清，低成本且避免 digest 被误读为 per-actor unread，不反对。

2. 我原评审中未被合并的项

- 同意降级/延后 daily digest automation 的实际调度；当前只读 digest CLI 足够，调度属于后续自动化 wiring。
- 同意把 `unseen = effective status untriaged` 放入 M4-C5 文档回写，不要求代码改语义。
- 同意把 `tool_error_windows` 只发布前 50 个的运营体验问题并入 M4-C4；只要有 truncated/total 可见，不阻断 M5。
- 同意不把“session 结束清理窗口”列为必改；512 LRU 可接受，但驱逐数/截断必须可见。

3. M4-C1 结构化来源选择

- 支持 (iii) 两者都要：优先使用 provider/工具结构化拒绝码或明确 error kind 判定 permission/pin/scope/immutable；结构化 `exitCode != 0` 则判 `non_zero_exit`，不能被文本里的 permission/403/immutable 覆盖。
- “文本命中但无结构证据”时不记 `permission_denied`、不 highSeverity；若有结构化非零退出码则记 `non_zero_exit`，否则记 `unknown`（可带低可信、已脱敏的聚簇 note/coverage 说明，但不得单次直通）。
