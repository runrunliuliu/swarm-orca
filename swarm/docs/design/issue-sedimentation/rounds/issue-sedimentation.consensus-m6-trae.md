VERDICT: AGREE

## 1. 对合并清单的异议

无异议。M6-C1 到 M6-C8 都属于 M6 内必须收敛的问题，修完再进 M7：

- C1/C2：候选必须基于 stable source，不应把 epoch 当跨源复现；small-cluster 也不能默认单实体。
- C3：miner apply 只能从当前 untriaged 出发，不能用通用 transition 覆盖 R1/human 决策。
- C4：扫描成本要有上界或可观察成本，否则自动化周会命令不可运营。
- C5：低信息簇和 self_report 必须明确降权/边界，避免候选榜被泛噪声占满。
- C6：apply 策略必须防止无人值守把队列从 untriaged 中清掉。
- C7/C8：输出字段和回归测试是本轮能否支撑 triage 会议的最低证据。

文档回写项同意，尤其 §10 的 stable source 规则、scan 上限和 automation dry-run 政策。

## 2. 原评审未被合并项

同意降级/延后。

- 我提到的候选短 summary / latest decision / owner action 已纳入 C7；更完整的会议视图可到 UI/M7 再做。
- 50k 行性能只需先给 scan 上限与 rows/ms，可不在本轮做复杂索引/分页重构。
- digest/mine 共享 DTO 已可接受，后续形状漂移靠测试维持。
- 真正 scheduled automation wiring 可延后；M6 只需给可靠 CLI 配方。

## 3. M6-C6 选择

我倾向 (a)：`--apply` 必须显式 `--target`。

理由：miner 的默认行为应是 dry-run 生成会议材料；一旦写 decision，就必须让操作者明确选择分流目标。保留默认 `watch` 即使加 `--yes`，也容易在自动化脚本里变成“无人值守清空 untriaged”。

对 automation 配方的影响：计划任务只能跑 `orca incident mine --since ... --json` dry-run；任何 `--apply --target ...` 都应是人工 triage 后的单独命令，带明确 actor/reason 或等价审计字段。
