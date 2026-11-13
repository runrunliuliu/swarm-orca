VERDICT: AGREE

## 1. 对合并清单的异议

无异议。M4-C1 到 M4-C5 都应在 M4 内完成，修完再进 M5：

- M4-C1：同意，高危单次写入不能由自由文本正则触发。
- M4-C2：同意，窗口阈值必须以 turn 为边界；跨 turn 只能进后续 mining/摘要维度。
- M4-C3：同意，provider 覆盖不能靠假设；未覆盖路径必须显式列为 coverage gap。
- M4-C4：同意，灰度 meta 写入、窗口截断/LRU、unknown/non_zero 噪声边界都要可见或明确延后。
- M4-C5：同意，digest 的 `unseen` 语义必须写清是 effective status = untriaged，不是按人已读。

文档回写项也同意，尤其 §7.3 必须说明结构化高危来源和 turn 进窗口。

## 2. 原评审未被合并项

同意降级/延后。

- 我只读 classifier/window 得出的最小三项已被 C1/C2 覆盖。
- provider 级 coverage、resolved append 旁路、LRU 截断可见性是 codex 补充的有效问题，我同意升入合并清单。
- digest 可读性中更细的 UI/日报调度可以延后；M4 只需保证 CLI/文档语义不误导。

## 3. M4-C1 结构化来源选择

我支持 (iii) 两者都要：provider 结构化拒绝码/error kind 用于 permission/pin/scope/immutable 高危；结构化 exit code 用于 `non_zero_exit`，可结合工具名白名单提升置信，但不能把文本命中升级为高危。

当文本命中但无结构化证据时，应记为普通低可信 code，例如 `permission_text_match` 或降级为 `unknown`/普通 `permission_denied` 且 `highSeverity=false`，只参与同 turn 窗口阈值，不允许单次直通。
