VERDICT: AGREE

## 1. 对合并清单的异议

无异议。M2-C1 到 M2-C6 都应在 M2 内修完，不能带入 M3：

- M2-C1 是 shadow/replay 的正确性核心；现状会真实漏放，必须修。
- M2-C2 是诊断库的泄露面；normal write、DB insert、shadow replay 必须共用同一 sanitize 层。
- M2-C3 是长期运行可用性问题；低优先级噪声不能永久挡住后续 crash。
- M2-C4 是运维可见性问题；空列表不能掩盖 replay 卡住。
- M2-C5 是 `incident report` 的操作者语义与资源边界；不说明会让重复上报和 evidence 成本失控。
- M2-C6 是冷启动/长期运行边界；shadow 最多约 100MB，同步 replay 必须有上界、可续跑、可观察。

文档回写项也同意，尤其 §11.2 与 §12 必须反映修后的 replay 水位、失败可见字段和成本上界。

## 2. 我原评审未被合并项的处理

同意降级/延后。

- renderer 更严格 channel whitelist / UI 权限边界：M2 只有 preload API，无 UI，可留到 UI/M7 前处理。
- evidence path 的隐私显示策略：M2-C5 已要求文档写明路径可能敏感；更细的相对路径/脱敏显示可后续做。
- 影子文件删除或外部轮转的完整恢复能力：无法完全恢复已丢文件，作为覆盖缺口和文档边界即可。
- `incident report` 默认随机 source-id 导致大量重复自报：保留为 T3 特性，靠 M2-C5 文案和后续 triage/mining 控制。

## 3. M2-C1 方案选择

我支持 (a) shadow 行加单调 `seq`，水位只记 `lastSeq`。

理由：seq 水位与文件名/rename/inode 完全解耦，可以安全重扫现存轮转族并让 DB UNIQUE 吸收重复；文件身份方案在 copy、external rotation、跨平台 inode/ctime 语义上更脆。
