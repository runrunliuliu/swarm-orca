# issue-sedimentation：设计、实施与评审记录

这个目录收纳 `incident sedimentation`（故障沉淀 + 定期修复）这件事的**过程材料**。设计正文仍在上一级
[`../issue-sedimentation.md`](../issue-sedimentation.md)，本目录只回答"为什么是这样、谁反对过什么"。

## 阅读顺序（新人）

1. [`../issue-sedimentation.md`](../issue-sedimentation.md) §1–§3：问题、结论、为什么选 TS-in-orca。
2. 同文 §6（store）、§7（触发）、§8（acceptance）、§10（挖掘）：当前行为。
3. 同文 §11–§13：硬问题、交付面、里程碑与 patch 预算。
4. [`example.md`](example.md)：一条虚构事故从信号走到 guardrail。
5. 本 README 的轮次表：想知道"这个字段为什么存在"时，按轮次查原始评审。

## 轮次索引

原始记录（6 份 brief、14 份 review、16 份共识、3 份精简审计，逐字保留）**不随仓库分发**，
归档在私有产物区 `swarm-artifacts/issue-sedimentation-rounds-20261113/`（带 `INDEX.md` 与逐文件
sha256，写入后已回读校验）。要读原文时按下表的轮次定位；本仓库只保留结论与索引。

| 轮次 | 对象 | 结论 | 关键必改 |
| --- | --- | --- | --- |
| R1 | 设计 v1（Python 适配层 + 文件轮询） | 方向否决 | 信号只在主进程完整、判定权不能自审 |
| R2 | 设计 v2（TS-in-orca） | APPROVE-WITH-CHANGES | 事实高估、幂等键缺 epoch、acceptance 静默悬挂、shadow 非 WAL、M1 过大 |
| R3 | M1 代码（store / crash / CLI） | 双方 APPROVE-WITH-CHANGES → AGREE | fallback epoch 从不落库、owner-claim binding、容量语义、只读创建 WAL、prune 不可追溯 |
| R4 | M2 代码（shadow / report / IPC） | **双方 BLOCK** → AGREE | 轮转水位跳行、replay 绕过脱敏、容量拒收挡住 crash、replay 状态不可见 |
| R5 | M3 代码（no_progress 灰度） | BLOCK / APPROVE-WITH-CHANGES → 分歧 → AGREE | 年龄口径必须是语义事件（PTY 字节=TUI spinner 噪声）、手工拼 key、sampler 错误不可见 |
| R6 | M4 代码（tool_error / digest） | **双方 BLOCK** → AGREE | 自由文本触发高危、窗口键缺 turn、resolved-append 旁路、provider 覆盖被默认宣称 |
| R7 | M5 代码（acceptance 门） | **双方 BLOCK** → AGREE + 二次折中 | 门点不唯一、keep-unread 被 check 消费、fail-open、cwd 无边界、verdict 未绑规则版本 |
| R8 | M6 代码（mining / triage 候选） | **双方 BLOCK** → AGREE | `source_id` 含 epoch 被当成跨源、apply 可覆盖人工判断、默认 target 稀释队列 |
| R9 | M7 前精简审计 | 双方一致：只做收敛，不砍语义 | 过程材料下沉、`pad()`×6、meta helper ×2、`incident-mine.ts` 三分、CLI 帮助分组 |

## 六轮代码评审反复命中的同一类问题

首版每轮都"测试全绿"，但评审每次都挖到语义级错误。模式是：

| 轮次 | 测试覆盖了什么 | 漏掉了什么 |
| --- | --- | --- |
| M1 | 我实现了 fallback 分支 | 该分支的 key 含 `:` 会被自己拒绝 → 永不落库 |
| M2 | 重放能补回记录 | 轮转把 base 改名后，水位指向了不同文件 |
| M3 | 45 分钟无状态变化算停滞 | 长回合里状态本来就不变 |
| M4 | 错误被归一化成 code | 自由文本能触发单次直报 |
| M5 | 命令能被执行并阻断结算 | 联邦/legacy 路径绕过门点 |
| M6 | 同一 fingerprint 聚成簇 | `source_id` 含 epoch，同一实体被算成多个来源 |

结论（也是后续里程碑的做法）：**每个新能力先写"什么不算"的测试**，再写"什么算"。

## 维护约定

- 新里程碑的 brief / review / consensus 归档到私有产物区（同一 `swarm-artifacts/` 目录族），
  文件名沿用 `issue-sedimentation.<kind>-<agent>[-<round>].md`；归档时写 `INDEX.md` + sha256 并回读。
- 本 README 的轮次表在里程碑收口时补一行；正文 §19.x 只留 3–5 行摘要 + 指向这里。
- 原始记录不编辑、不改写结论；后续若判断有误，新增一轮记录而不是回改。