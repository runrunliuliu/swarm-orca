VERDICT: AGREE

## 1. 对合并清单的异议

无异议。M3-C1 到 M3-C6 都应在 M3 内修完，M4 不应建立在当前 `stateStartedAt/turnStartedAt` 年龄口径上：

- M3-C1：同意外层判断，PTY 字节流不能作为活动信号；状态行最后一次语义事件时间是更合适的来源。当前字段名/原因也会误导值班人员。
- M3-C2：同意，`status_stall` 必须复用 `buildIncidentKey`/同等校验，避免手工 key 再次绕过约束。
- M3-C3：同意，sampler 错误必须进入 coverage，否则旧样本会被误读成健康。
- M3-C4：同意，`--clear` 是清整个 pane，应与声明参数互斥并写清楚。
- M3-C5：同意，help/文档要把 wait 声明、灰度含义和 “非已记录事故” 讲明白。
- M3-C6：同意，新增测试都是这轮风险面的最小证据。

## 2. 我原评审未被合并项的处理

同意降级/延后。

- 我原先只要求改标签/文案，现在同意升级为改实现口径；默认 off 不足以保护后续 M4/M5 的派生判断。
- 无 deadline wait 的 age cap / 自动清理可以延后；本轮只需 help 建议 `--until`，并固定 `--clear` 语义。
- 真 60s interval 端到端测试可延后，M3-C6 覆盖默认 off、非法 key、sampler error 和活动事件即可。
- UI/IPC 展示细节可后续随 UI 做，但 coverage 字段必须现在同步。

## 3. 年龄来源选择

我支持 (i) 状态行 `lastSemanticEventAt`。

理由：它不受 TUI spinner/字节流重绘污染，又能反映 hook 上报的语义活动；缺失时可回退 `stateStartedAt` 并标注 fallback。

若 45 分钟内“有事件但无实质进展”（例如反复重试同一失败），这套 no_progress 判据不会触发；那应交给 M4 `tool_error`/后续重复错误聚类处理，而不是让 no_progress 同时承担“有活动但无质量进展”的语义判断。
