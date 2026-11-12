VERDICT: AGREE

## 1. 对合并清单的反对/范围意见

无反对。C1-C5 都可以作为“M1 内修、M2 前完成”的共同必改清单。

- C1：同意列为必改。当前 fallback 分支自称存在但实际被 key 清洗拒绝，不修会让幂等测试覆盖一个不存在的落库路径。
- C2：同意列为必改。`agentSessionOwners.identityDigest` 已在同次调用中读取，却不参与 binding 判定，留下可证明的 unknown 漏记窗口。
- C3：同意列为必改。容量 latch 是“曾经触发”，current limit 是“现在拒收”，CLI/JSON 合并表达会误导运维动作。
- C4：同意列为必改。只读安全是 M1 CLI 可放心使用的前提，应由文件级 sidecar/mtime 测试锁住，而不是只靠源码意图。
- C5：同意列为必改。无 FK 可接受的前提是 prune 审计仍可定位；`--json` 输出候选/已删 id（带上限/truncated）是最小可追溯面。
- D1-D6：同意只做文档回写，不要求本轮代码再扩大范围；它们主要是把 M1 已实现能力和明确缺口说准。

## 2. 我原评审中未被合并的项

同意降级/延后如下：

- prune marker 的“置 1 窗口不要加入其它 DELETE”风险：降级为实现约束/代码审查注意项；当前 prune 事务足够小，不单列 M1 必改。
- `incident_decisions` prune 后 `show <id>` 不可解析：已被 C5 覆盖为 prune JSON 可追溯；更完整的 tombstone/audit 查询可延后。
- acceptance 不改 dispatch 状态可能导致 running 静默停滞：M1 未实现 acceptance，降级到 M2 acceptance 设计/验收项。
- onPtyExit callback 前/写入前进程崩溃的丢失窗口：M1 无 reconcile，降级到 M2+ shadow/reconcile；本轮只要求不要夸大 M1 覆盖面。
- list/show 只读 sidecar 的“建议补测试”：已升级并合并为 C4，我同意。

## 3. C1 方案选择

我支持 (b) 用不含 separator 的稳定编码，例如 hash(runtimeId)+generation。理由：fallback 的目的就是在缺少 incarnation 时仍保留“同一 runtime lifecycle epoch”的幂等事故；改成 (a) skip 会把已接线的单一写入点退化成静默漏报，只适合作为明确放弃 fallback 的新设计，而不是 M1 修复。
