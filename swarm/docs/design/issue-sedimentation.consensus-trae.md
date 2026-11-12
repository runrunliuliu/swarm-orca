VERDICT: AGREE

## 1. 对合并清单的异议

无异议。C1-C5 都属于 M1 内必须收紧的运维可用性和证据完整性问题，不应推到 M2：

- C1 fallback epoch 当前实际不落库，属于代码行为与设计自报不一致，必须修。
- C2 `hasAgentBinding` 漏掉已读取的 identityDigest，会造成 unknown 事故 false negative，必须修或证明不可能。
- C3 容量 latch 文案会误导运维“仍在拒收”，必须拆字段或改输出。
- C4 只读安全是 CLI triage 的信任前提，必须有文件级回归。
- C5 prune 保留审计但不给追溯入口，会让 retained decisions 只剩手写 SQL，必须补可定位 id。

D1-D6 都是正确的文档回写项，不进代码即可。

## 2. 我原评审未被合并项的处理

同意降级/延后。

- `operator_close` 不写导致“人工止血”不可见：可延后到 M2 `incident report` 或后续 operator-close audit，不阻塞 M1。
- 库损坏、磁盘满、userData 修复后需重启这类失败模式：D4 已覆盖 store open failure 缓存；更完整的持久告警可等 M2 shadow/reconcile。
- `prune --apply --keep-days 0` 风险：C5 补候选/删除 id 后已足够，保留为操作纪律，不单列必改。
- `confirmed -> watch/invalid/duplicate` 这类状态降级：接受为 M1 人工 triage 修正能力，不再要求改状态机。

## 3. C1 方案选择

我支持 (b)：用不含 separator 的稳定编码（例如 `sha256(runtimeId).slice(...) + "-" + generation`）。

理由：这保留了“确实发生了 PTY exit 但 incarnation 缺失”的 M1 可观测性，同时满足同一 fallback epoch 幂等；(a) 直接 skip 会扩大 crash 漏报面，和“同一 pty 连续两次只产生一行”的回归目标不匹配。
