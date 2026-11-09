# Tasks 工作台开发计划

状态：**未开始**。设计仍为草案（见 [调研与设计](README.md)），本文只是实施计划与退出条件。
本文不构成实现、部署、重启、创建 worktree 或启动 Agent 的授权；阶段状态表（§9）在实施后才填。

关联：[调研与设计](README.md)（数据链就绪度、UI、关系存储）、[任务与工作区模型](../task-workspaces.md)
（一个任务如何绑定 worktree、如何续做）、[评审记录](discussion-record.md)（2026-11-09 只读 panel）。

## 0. 前提与共识

1. **"任务"身份是产品决定，不是既有 runtime 概念。** 一期用"tracker 身份 + 工作区身份"的渲染层投影，
   不实现逻辑任务 ID、跨入口路由、跨 runtime 续接。
2. **关系分三层存储**（设计文档 §8）：运行态/Agent 列表/实时用量**派生不存**；工作区侧 provenance 沿用既有字段；
   任务实体、绑定集合、用户意图、结算快照落 `taskRecords` domain。
3. **一期不碰** Agent 状态 store、用量扫描口径、RPC 契约与移动端实现。
4. **本视图只做 join 与汇总**，不复制 Agent 控制面或事件流（分工见设计文档 §5）。
5. 工作量以"工作包"（§4）为单位评估；执行者数量与并发上限由启动操作者按既有规则给定，本计划不设。
6. **评审后的收敛**（详见[评审记录](discussion-record.md)）：M1 可以现在做；M2 冻结到 H1
   （指定旧 build 的 round-trip）与 H2（`ambiguous_session` 频率）有证据；逐 Agent 的金额在会话级归因成立前
   不展示；M2 拆成 M2a（只读兼容验证）与 M2b（落库实现）。

## 1. 目标与非目标

**目标**

- 桌面端能从两个入口打开同一种视图：tracker 条目（GitHub/GitLab/Jira/Linear）与本地工作区；
  内容是"任务 → 工作区(0..N) → Agent(活/保留/历史) → 用量 → 交付证据"。
- 用量必须有三态：可用 / 未启用 / 不可用（远端、歧义、无匹配），**未知不记 0**。
- 逐 Agent 只展示 token；金额只到工作区级与任务级（会话行无 `worktreeId`，精确归因未成立）。
- M2 之后任务实体可持久化：绑定、primary、归档、验收、结算快照，并在启动时做一次只读对账。

**非目标（明确不做）**

- 逻辑任务 ID、跨入口/跨 runtime 任务续接、一任务多仓库联合验收（`../task-workspaces.md` 的保留设计）。
- 写入硬隔离、沙箱、把用量统计默认打开。
- SSH / 远端实时用量（只能显示不可用）。
- 修改 `agentStatusByPaneKey` 单一 store、`usage-*` 的归因口径、`*UsageProjectBreakdown` 的 key 形态。
- 迁移既有 worktree 的任务归属；只对用户显式动作（"归入任务"）写入 `taskRecords`。

## 2. 复用边界（不要重造）

| 需要的东西 | 复用 | 位置 |
| --- | --- | --- |
| Agent 行（活/保留/子 Agent） | `buildWorktreeAgentRows` + `selectWorktreeAgentRowsCached` | `orca/src/renderer/src/components/dashboard/` |
| Agent 行形状 | `DashboardCard` | `orca/src/shared/dashboard-snapshot.ts` |
| 历史会话 → 工作区 | AI Vault cwd 映射 | `orca/src/renderer/src/components/right-sidebar/ai-vault-session-worktree.ts` |
| 工作区用量聚合 | `*UsageProjectBreakdown`（key = `worktree:<id>`） | `orca/src/renderer/src/store/slices/` |
| 会话级归因 | `resolveAutomationRunUsage` 的判定顺序与语汇 | `orca/src/main/claude-usage/claude-usage-automation-attribution.ts` |
| 未知/不可用语汇 | `AutomationUsageSummary`、`AutomationRunUsageUnavailableReason` | `orca/src/shared/automation-usage-summary.ts`、`automations-types.ts` |
| 任务 ⇄ 工作区反查 | 现有单条反查 + Linear 索引 | `orca/src/renderer/src/lib/github-work-item-workspace-attachment.ts`、`task-page-linear-in-orca-issues.ts` |
| 持久化 | profile-state domain 写 + revision CAS | `orca/src/main/persistence/profile-state/` |

## 3. 阶段与退出条件

### M0 决策冻结（0.5–1 天）

- 交付：设计文档 §6 的 D1–D6 逐条结论 + 失效条件；`taskRecords` 字段表与错误/不可用枚举冻结；
  用量三态的文案例句（进 catalog 前先定口径）。
- 评审遗留（设计文档 §6.1 R1–R7）在 M0 一起冻结：分组优先级与 `Delivered` 定义、`◇` 徽标语义、
  `M2a/M2b` 门槛、`projectBreakdown.key` 解析层归属。
- 退出：每条决策都有结论，或明确标为 `escalate-value-choice`（交回决策人）。
  未冻结的项不得进入 M2 编码。
- 不做：任何代码、任何 schema。

### M1 只读面板（3–5 天）

- 在既有 issue/PR 详情新增 `Orca` tab；顺序 GitHub issue/PR → Linear → GitLab → Jira。
- 面板内容：工作区（0..N）、Agent 行（含历史）、用量三态、`[ Open workspace ]` / `[ resume ]` 动作。
- 数据全部走 §2 的既有来源；**零持久化、零新增 RPC**。
- 退出：
  - 对照覆盖 **Claude + Codex + OpenCode + Muse**：面板合计 == `projectBreakdown['worktree:<id>']`；
  - 三态与空态各有用例（未启用、远端、歧义、无工作区）；逐 Agent 只出现 token，不出现金额；
  - `projectBreakdown.key` 走解析层且有单测；
  - identity/join/usage selector 可被 M2 直接引用（不是页面内拼装）；
  - `pnpm tc`、定向 `pnpm test`、i18n 抽取与覆盖、`check:code-quality:changed` 通过。
- 不做：列表主轴、分组、任务归档、移动端、逐 Agent 金额。

### M2a 存储兼容验证（1–2 天，只读）

- 指定**旧 build** 做 新→旧→新 round-trip；断言未知 top-level domain 被读入、保留、写回。
- 断言 `orca profile state` export / recovery / 备份恢复包含未知 domain。
- 产出判决：通过 → 进入 M2b；不通过 → 范围收缩为 M1，并在设计文档 §8.2 记录原因。
- 退出：三项断言各有一条可复现命令与结果；不写任何生产数据。

### M2b 列表主轴 + 落库（5–8 天）

- 新增 `taskRecords` domain（字段见设计文档 §8.3）：记录、绑定、`externalIndex`、primary、`intent`、`usageSettlement`。
- main 侧：load 归一化（逐条 `schemaVersion`）、唯一性校验、写入走 `writeProfileStateDomain` + revision CAS、
  启动一次有界对账（绑定解析 / 标记 unresolved / 回填 `resolvedVia`）。
- renderer 侧：列表分组（Needs you / Working / Delivered / Unlinked）、`[ primary workspace ]`、
  "归入任务 / 从任务移除 / 归档"动作。
- 反查升级：`find*Attachment` → 列表版；GitLab/Jira 补同构 collector。
- 前置门槛：**M2a 判决通过**，且设计文档 §8.9 的第 2–3 条（revision CAS、记录级迁移）跑通；
  不通过则不引入 domain，退回纯投影。
- 退出：§8.9 的 1–7 全绿；投影一致性用例；1000 工作区规模下列表构建复用缓存 pass、无逐行扫描；
  任务归档时结算快照三态正确。
- 不做：跨 runtime、跨仓库联合验收、移动端。

### M3 交付证据聚合（2–3 天，可与 M2 并行收尾）

- 任务级交付区：commits、PR/MR、checks、review 状态、`sparseTaskBinding` 证据（base/cone/requiredPaths）。
- 退出：一个有 PR 的任务与一个无 PR 的任务各有一份截图/断言；不可用状态不显示为 0。

### M4 跨端（可选，未估）

- 新只读 RPC（task usage/摘要）+ mobile allowlist + 录制 golden + 移动端详情接入。
- 需要单独授权与 wire 兼容评审；不在本计划默认范围内。

## 4. 工作包与文件所有权

| WP | 内容 | 主要落点 | 依赖 | 可并行 |
| --- | --- | --- | --- | --- |
| WP1 | 任务投影（`taskKey`、分组、一任务多工作区） | `orca/src/renderer/src/components/task-workbench/*`、`orca/src/renderer/src/lib/` | M0 | 与 WP2 并行 |
| WP2 | 用量聚合与三态收敛 | 同上 + `orca/src/shared/task-workbench-*.ts` | M0 | 与 WP1 并行 |
| WP3 | UI（面板 / 列表 / 空态 / 动作） | `task-workbench/` 组件与 `use-task-workbench-*` | WP1、WP2 | 否（串行收口） |
| WP4 | `taskRecords` 持久化与对账（main） | `orca/src/main/task-records/*`、`orca/src/main/persistence/loading-store/normalize-loaded-task-records.ts` | M0 + §8.9 前置用例 | 与 WP1/WP2 并行 |
| WP5 | 反查索引升级（四 provider） | 现有 `*workspace-attachment*`、`task-page-linear-in-orca-issues.ts` | WP4 字段表 | 是 |
| WP0 | M2a 存储兼容验证（只读 fixture，不写生产库） | 独立 fixture + 手写旧 build 快照 | M0 | 是 |
| WP6 | 测试与基准 | 与各项同目录 `*.test.ts` | 全程 | 是 |

约束：

- 新文件按职责命名，不用 `helpers`/`utils`；不新增 `max-lines` 豁免，触发 ratchet 就拆文件。
- 并行写入必须文件所有权不重叠：WP4 只写 main 与 shared，WP1–WP3 只写 renderer；共享类型先由 WP4 冻结。
- 不修改 `mobile/`、`agent-status-*`、`*/usage/*` 的归因实现（只读消费）。

## 5. 测试矩阵

| 范围 | 要点 |
| --- | --- |
| 投影 | 同 issue 两个工作区；同名分支不同仓库；归档工作区不计入 Needs you；无 tracker 工作区进 `UNLINKED` |
| 用量三态 | 可用 / 未启用 / 远端 / `ambiguous_session` / `no_matching_session` / 未定价模型 |
| 归因 | 会话级只用 `worktreeId`；时间窗歧义不猜；与 `projectBreakdown` 数值一致 |
| 持久化 | **指定旧 build** 的 新→旧→新 round-trip；旧 build 的 selective 与 full write 两条路径都保留；revision CAS 冲突后重读重试；记录级 `schemaVersion` 迁移；malformed/未知字段加载降级 |
| 导出/恢复 | `orca profile state` export / recovery / 备份恢复包含未知 domain |
| 结算快照 | `usageSettlement` 在删除、归档、扫描失败、未启用、远端不可用下的失败注入 |
| 归属防串 | 跨 `hostId`/`repoId` 的同名 `externalKey` 不串任务 |
| 对账 | 工作区外部删除、目录改名（`priorWorktreeIds`/别名）、仓库移除、归档后再打开 |
| GC 解耦 | `worktreeMeta` 行被 30 天 GC 后任务记录仍可读且标 unresolved |
| 性能 | 1000 工作区列表构建、面板打开耗时、domain 序列化/读入基线 |
| i18n / 样式 | 全部新文案进 catalog；只用 `components/ui/` primitive；无 raw 色值 |
| UX 验收 | 分组优先级与 `Delivered` 定义；loading/未授权/部分失败/过期/scan failed 态；三态文案不被读成 0；动作在已归档/不可恢复时禁用并有说明；迁移后 `conversation/checks/files` 可发现；键盘与焦点返回；屏幕阅读器名称与非颜色表达；窄桌面/长标题/大数字布局边界；primary fallback 标识；Agent 内容隐私遮蔽 |

命令：`pnpm tc`、`pnpm test <path>`、`pnpm run check:code-quality:changed`、
`pnpm run verify:rpc-params-catalog`（仅若动契约）、`pnpm run verify:localization-extraction`。
按 `AGENTS.md` 的批量规则跑 vitest（小批、`--maxWorkers=2`）。

## 6. 验收与证据口径

- 每个验收项记录：命令、cwd、起止时间、退出码、相关快照 hash；未知不记 0。
- 真机渲染校验需 CDP 截图（`ORCA_BACKGROUND_LAUNCH=1`，不抢焦点）；没有截图不算通过。
- 远端/SSH 与需要计费的场景单列"未验证"，不作为通过证据。
- 面板能打开、类型检查通过，都不构成功能验收；必须有对照数字。

## 7. 顺序、依赖与风险

顺序：M0 → M1 → M2（前置用例通过才落地 domain）→ M3；M4 单独授权。

| 风险 | 处理 |
| --- | --- |
| `projectBreakdown.key = worktree:<id>` 是未文档化实现细节 | renderer 侧加解析 + 回退层，对前缀做单测；上游变化只改一处 |
| 降级 round-trip 未实测 | 作为 M2 前置门槛；不通过就退回纯投影（仅 M1） |
| 任务记录只增不减 | §8.7 lifecycle + 启动对账 + 显式"清理无归属任务"，不做后台 watcher |
| 用量缓存因改名重扫（`worktreeFingerprint` 含 `displayName`） | 不做高频重命名；重命名走显式动作 |
| 与 Agent Dashboard / Agents feed 入口打架 | 分工写进文案与文档，互链不复制 |
| 双写漂移（Agent 状态 / 用量） | 坚持"派生不存"；`usageSettlement` 只在失去读取能力前写入 |
| 逐 Agent 金额被当成事实 | 只显示 token；金额仅任务/工作区级；会话级归因（H5）通过后才放开 |
| M2a 结论被跳过 | M2b 的开工条件写成"M2a 判决通过"，没有判决不得写 `taskRecords` |
| 并行工作包互相踩文件 | §4 的所有权划分 + 共享类型先冻结 |

回滚：

- M1 是纯 UI + 只读 hook，可整体 revert，无数据残留。
- M2 落地后回滚 = 停止写入并保留 domain 行（旧 build 保留未知 domain），**不删数据**；
  清理需单独授权。

## 8. 未决输入

- D1–D6（设计文档 §6）尚未拍板。
- 移动端是否在一期之后做（D5）未知。
- 是否允许真机渲染验收与远端/计费场景验证，需单独授权。

## 9. 阶段状态

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| M0 决策冻结 | 未开始 | — |
| M1 只读面板 | 未开始 | — |
| M2a 存储兼容验证 | 未开始 | — |
| M2b 列表主轴 + 落库 | 未开始 | — |
| M3 交付证据聚合 | 未开始 | — |
| M4 跨端 | 未开始（未估） | — |
