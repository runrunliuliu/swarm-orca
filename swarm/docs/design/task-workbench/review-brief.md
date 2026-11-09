# Tasks 工作台评审简报（review brief）

用途：本次只读评审 panel 的**唯一输入文件**。评审者按角色回答 §5 的问题，并严格按 §6 的记录形态输出。
本文件不授予任何写入、合并、部署或启动 Agent 的权限。

## 1. 范围

| 项 | 值 |
| --- | --- |
| 决策 | 是否按 `README.md`（设计草案 v1）+ `development-plan.md` 推进 Tasks 工作台，以及 M1/M2 的取舍 |
| 基线 | 本仓库 `main` 的 `swarm/docs/design/task-workbench/` 两份文档 + `orca/` 快照（`v1.4.219`） |
| 性质 | 只读评审；不改仓库文件、不启动其它 Agent、不访问远端 |
| 结论所有者 | 用户（product owner）。评审者只出建议；分歧若属优先级，终态记 `escalate-value-choice` |
| 生效交锋上限 | 6 轮（本工作区私有策略），上限不是目标：一轮无影响结论的增量即停 |
| 裁定人 | 用户；不参与本轮论证 |

## 2. 默认方案（没人反对就按这个走）

- D1 任务身份：tracker 身份 + 工作区身份的**渲染层投影**（不落逻辑任务 ID）。
- D2 用量统计保持默认关闭；面板给空态 CTA，不改默认值。
- D3 一个任务多个工作区时，primary 用显式字段，缺省用"最近活动"并在 UI 标注。
- D4 无 tracker 的本地工作区进 `UNLINKED` 分组，不排除。
- D5 移动端一期不做；只做桌面端。
- D6 关系存储：运行态/Agent/实时用量派生不存；任务实体、绑定、用户意图、结算快照落新 domain `taskRecords`。
- 顺序：M1（只读面板，零持久化）→ 门槛用例 → M2（列表主轴 + `taskRecords`）→ M3（交付证据）→ M4（跨端，另议）。

## 3. 已有证据（读代码可复核，不是推测）

| 事实 | 位置 |
| --- | --- |
| 用量按 `worktreeId` 归因，`projectBreakdown[].key` = `worktree:<id>`（label = worktree 显示名） | `orca/src/main/usage/usage-event-attribution.ts`、`orca/src/main/claude-usage/claude-usage-report-aggregation.ts` |
| 渲染进程可读 `*UsageProjectBreakdown`（含 `estimatedCostUsd`） | `orca/src/renderer/src/components/stats/ClaudeUsagePane.tsx` 等 |
| 会话级归因：sessionId 精确 → worktree + 时间窗；多重命中 `ambiguous_session` | `orca/src/main/claude-usage/claude-usage-automation-attribution.ts` |
| 用量扫描默认关闭（`enabled: false`） | `orca/src/main/claude-usage/store.ts` |
| 用量缓存带 `worktreeFingerprint`（输入含 `displayName`），改名即重扫 | `orca/src/main/usage/usage-worktree-refs.ts`、`usage-provider-store-lifecycle.ts` |
| 对外 session 行类型无 `worktreeId` | `orca/src/shared/claude-usage-types.ts` |
| Agent 状态只有 hook server 一个 store（+ `last-status.json` 侧车） | `orca/AGENTS.md` Agent Status 段、`orca/src/main/agent-hooks/server/` |
| Agent 行可复用 dashboard 的构建与缓存 | `orca/src/renderer/src/components/dashboard/build-dashboard-snapshot.ts` |
| 历史会话按 cwd 映射回 worktree（读时解析，不落库） | `orca/src/renderer/src/components/right-sidebar/ai-vault-session-worktree.ts` |
| 工作区侧已有任务 provenance 字段 | `orca/src/shared/worktree/meta-types.ts` |
| `worktreeMeta` 30 天 GC（本地宿主、路径不存在） | `orca/src/main/persistence/tracking-repos/worktree-metadata-normalization.ts` |
| SQLite profile-state 是唯一可写后端；domain 一行 JSON；全 profile revision CAS | `orca/src/main/persistence/profile-state/` |
| 旧 build 会保留未知 top-level domain（`{...parsed}` + `getDurableState()`） | `orca/src/main/persistence/loading-store/normalize-loaded-profile-state.ts`、`state-serialization-secret-handling.ts` |

## 4. 需要被检验的假设（都是未验证的推测，请逐条给出"会/不会 + 依据"）

- H1 旧 build 的 round-trip 会保留 `taskRecords`，不会静默丢弃（M2 的前置门槛）。
- H2 `ambiguous_session` 的实际频率低到"每个 Agent 的花费"多数可用；否则面板应以 worktree 合计为主。
- H3 "一任务多工作区"在真实使用中足够常见，值得 M2 的索引与 primary 语义。
- H4 任务中心视图比现有 Agent Dashboard + 侧栏绑定带来真实增量（而不是重复入口）。
- H5 只加 additive 的会话级 `worktreeId` 不会破坏 wire/渲染契约。
- H6 M1 的数值口径（与 `projectBreakdown` 一致）在 SSH/远端工作区下能如实显示"不可用"。

## 5. 待裁决问题

- Q1 身份：A+B 投影够用，还是必须先做持久逻辑任务（C）？何时必须升级？
- Q2 顺序：M1 先行验证归因，还是直接 M2？M1 若不产生可复用代码，是否值得？
- Q3 `taskRecords` 是否值得落盘？纯投影 + 手动标签能否满足主要场景？
- Q4 降级/备份路径（H1）若无法证明，是否应直接把范围收缩为 M1？
- Q5 用量口径：三态 + 结算快照是否足够，还是需要会话级 `worktreeId`（H5）？
- Q6 入口：Tasks 与 Agent Dashboard 是否应合并入口而非新增视图？若合并，谁是主入口？
- Q7 一期排除移动端（D5）是否可接受？
- Q8 开发计划的退出条件与测试矩阵缺什么（按你角色能看出的缺项逐条列）。

## 6. 输出形态（固定，按顺序写）

1. **decision and baseline**：你评审的决策与基线（文档名 + 你读到的关键行/函数）。
2. **options and evidence**：至少两个选项，各自的证据（优先 `path:line` 或函数名）。
3. **open points**：仍未解决的、且会影响结论的点。
4. **conclusion and reasons**：逐条回答 Q1–Q8，给"同意默认 / 改为 X / 证据不足"。
5. **end state**：`decided` / `insufficient-evidence` / `escalate-value-choice` / `stopped-budget`。
6. **next-step owner and authorization**：谁来做下一步，依据哪条既有授权（不要假设新授权）。
7. **invalidation and reopen conditions**：什么变化会让你的结论失效。
8. **archival state**：你只输出文本，由 Operator 记录；不要写仓库文件。

## 7. 评审角色

| 角色 | 关注 | 额外要求 |
| --- | --- | --- |
| A 产品/UX | 入口分工（Q6）、三版线框图可用性、空态/三态文案、Q7 | 指出哪些现有组件可直接复用，哪些是新造的 |
| B 架构/存储 | §8 存储、写入路径、对账、GC、降级（H1、Q3、Q4） | 必须给出"若 H1 不成立"的收紧方案 |
| C 数据准确性/测试 | 归因口径、三态语义、性能预算、测试矩阵（H2、H5、H6、Q5、Q8） | 每条结论都要标"已验证 / 未验证" |

写作要求：中文；结论先行；不做代码修改；引用仓库内相对路径；不确定就写"未验证"，不要给 0 或"应该没问题"。
