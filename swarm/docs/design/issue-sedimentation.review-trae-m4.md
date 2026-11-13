VERDICT: BLOCK

结论：只看 `incident-tool-error-classifier.ts` 与 `incident-tool-error-window.ts`，M4 还不应进入 M5。两个核心问题都在 tool_error 的判定核心里：高危单次写入由自由文本触发，窗口键缺 turn 会跨回合凑阈值。

## 1. 高危单次写入是否由自由文本触发

是。`classifyToolError()` 先对 `signal.output` 做 `sanitizeText(..., 2000)`，然后按正则匹配；`permission_denied` 是第一组正则，匹配 `permission denied`、`EACCES`、`403`、`unauthorized`、`read-only file system`、`out of scope`、`immutable` 等自由文本。`HIGH_SEVERITY_TOOL_ERROR_CODES` 只含 `permission_denied`，`isHighSeverityToolError()` 因此会把这类文本命中的失败变成高危。

这会带来误报：如果 observer 把构建/测试/命令输出中的普通文本作为 failed tool output 送进 classifier，日志里出现 “permission denied”、“403”、“not permitted” 就可能单次成为高危候选。分类器注释说“text only used to pick code, write decision is code + threshold, high-severity fixed set”，但实际 high-severity 就是由文本分类得来的 code 驱动。

`path_not_found`、`command_not_found` 等不是高危单次；它们仍要按窗口阈值累计。风险最大的是 `permission_denied` 家族。

## 2. 窗口键缺 turn 是否会跨 turn 凑阈值

会。`ToolErrorWindowKey` 只有 `sessionId + toolName + code`；`windowKey()` 也只拼这三项。`record()` 接收 `turn`，但只把它保存为 `lastTurn`，没有纳入 key，也没有在 turn 变化时重置 timestamps。

结果是：同一 session、同一 tool、同一 code 在 10 分钟内，跨多个 turn 的失败会累加到同一个窗口。比如 turn A 失败 3 次，turn B 失败 2 次，就能达到默认阈值 5，生成一条看起来像“连续失败”的事故。

危害：值班看到的是一个聚簇事故，但它可能不是单个回合卡死，而是多个独立回合里同类错误的混合。`lastTurn` 只保留最后一个 turn，还会丢掉前面 turn 的定位信息，导致 triage 追错上下文。

## 最小必改集

1. 高危单次写入不能只靠自由文本。至少要求结构化错误来源或 provider/tool 明确标记为 policy/scope/pin 类错误；普通 command output 命中文本只能进入普通窗口阈值。

2. 窗口 key 纳入 `turn`，或在 `turn` 变化时开启新窗口；同时保留跨 turn 聚类只能作为后续 mining 维度，不应作为同一窗口阈值。

3. 补回归测试：一条普通构建输出含 `permission denied` 不触发高危单次；两个 turn 的 3+2 次同 code 不触发同一窗口事故；同一 turn 的 5 次仍触发。
