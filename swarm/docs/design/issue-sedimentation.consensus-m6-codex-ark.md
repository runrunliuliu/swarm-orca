VERDICT: AGREE-WITH-EDITS

1. 反对/范围：
- 不反对 M6-C1..C8；都属于 M6 候选可信度、自动写入安全和 automation 前置条件。
- 编辑 C1：stable source key 需要同时输出 `epochRows` 与 `stableSources`，并在无法解析 stable key 时把该行计入 `unknown_stable_source`，不得默认当作一个新来源。
- 编辑 C2：single-entity recurrence 可以保留为报告项，但不得进入默认 candidates，也不得被 `--apply` 处理。
- 编辑 C4：若短期不把 SQL scan 纳入 time budget，至少必须有硬行数上限 + `scan_truncated/scanRows/scanMs`；只改文案不够。

2. 原评审未合并项：
- fingerprint 版本/解释字段、self_report 按 code 聚类的长期形态：同意并入 C5 后可分阶段做；M6 先固定是否参与挖掘与低信息限额。
- 两个真实连接并发 apply 测试：同意降级为补充项；C3 的“apply 时重读且只允许 untriaged”修好后，同 target 重复追加风险已由事务重读基本覆盖。
- 无库 dry-run 文件级零写入测试：同意降级/顺手补；不作为阻塞 C1-C6 的核心语义项。
- 真正 scheduler、repair task、issue md 批量视图：同意延后到 M7+。

3. M6-C6 选择：
- 倾向 (a)：`--apply` 必须显式 `--target`，取消默认 `watch`。
- 理由：`watch` 会把 untriaged 从 unseen 队列移走；即使不是 confirmed，也是在替人改变 triage 队列。显式 target 能让操作者承认这是一次写入策略选择。
- 对 automation 配方的影响：scheduled automation 只能跑 dry-run（建议 `incident mine --since <window> --json`），不得带 `--apply`；若未来要自动 apply，必须是另一个有授权的人工/机器人 triage 流程，带显式 target、actor/理由和变更摘要。
