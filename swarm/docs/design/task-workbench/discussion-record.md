# Tasks 工作台评审记录（2026-11-09）

本轮是**只读评审 panel**，不是 debate（只有一份草案，不存在互相对立的既有主张）。
协议来源：`swarm/skills/swarm-orchestration/references/discussion.md`；本工作区取值见
`skills/orchestration/references/discussion-policy.md`（私有策略，不在本仓库）。

本记录不授予写入、合并、部署或启动 Agent 的权限。**裁定权在产品 owner（用户）**，评审者只出建议。

## 0. 运行事实与偏离

| 项 | 值 |
| --- | --- |
| 目标 worktree | 本仓库当前 checkout（read-only 共享），执行主机 `local`，Orca 1.4.219 |
| 参与者 | A 产品/UX：`trae` + `gpt-5.6-sol`（high · max）；B 架构/存储：`trae` + `gpt-5.5`（high · max）；C 数据准确性/测试：`trae` + `gpt-5.4`（xhigh · standard） |
| 并发 | 3 个评审者，低于 `max_workers=4`；全部只读，未写仓库、未再派发、未访问远端 |
| 交锋上限 | 6（私有策略值）；实际只用了 **1 轮**，第二轮因无影响结论的增量未发起 |
| 独立性四要素 | 作者隔离：是（草案作者未参与评审）；草稿可见性：互不可见；上下文暴露：三者相同（同一 brief）；模型多样性：3 个不同模型 ID、同一 Agent |
| 偏离 1 | `codex-ark` 被本 runtime 拒绝：`terminal create --agent codex-ark` → `invalid_argument: Unknown TUI agent: codex-ark`；白名单也标注其受监督/readiness 未验收。故 B 改用 `trae/gpt-5.5`。**结论：codex-ark 在当前 runtime 不可用于本类派发** |
| 偏离 2 | `terminal wait --for tui-idle` 对 trae TUI 两次超时；改以终端内容（输入提示符可见）为就绪证据后发送。send 回执只有 `input_accepted`，无 `turn_started`（`provider: unsupported`）。属已知限制，不是任务失败 |
| 用量 | 未接入台账采集。终端计数（`↓ 3.06K / 6.41K / 14.3K` tokens）**不可当账**；本轮用量记为**未知**，不记 0 |
| 终端清理 | 3 个评审终端已 `terminal close --tab`（各回执 `ok:true`，但 `ptyKilled:false` → 收据状态为 **unverifiable**）；
  事后进程表观测无 trae 残留。同工作区其他会话（pi、codex）未触碰 |

## 1. decision and baseline

决策：是否按 `README.md`（设计草案 v1）+ `development-plan.md` 推进 Tasks 工作台，以及 M1/M2 的取舍。
基线：本仓库 `main` 上 `swarm/docs/design/task-workbench/{README,development-plan,review-brief}.md`，
代码证据以 `orca/`（upstream `v1.4.219` 快照）为准。

## 2. options and evidence

| 选项 | 支持证据 |
| --- | --- |
| A 只做 M1 只读面板 | `projectBreakdown` 已按 `worktree:<id>` 出数（`orca/src/main/usage/usage-event-attribution.ts:26-46`）；三态语汇已存在（`claude-usage-automation-attribution.ts:48-91`）；M1 零持久化、零新 RPC |
| B 直接 M2 + `taskRecords` | 读写路径"看起来"保留未知 top-level domain（`orca/src/main/persistence/loading-store/normalize-loaded-profile-state.ts:42-44`、`state-serialization-secret-handling.ts:33-39,175-253`）——但只是代码阅读，无 round-trip 证据 |
| C 一期就加会话级 `worktreeId` | 当前 session row 无该字段（`orca/src/shared/claude-usage-types.ts:51-63`）；仓库规范允许 additive 可选字段，但无混版本验证 |

## 3. open points

- H1 未解决：没有"新 build 写 → 旧 build 读写 → 新 build 再读"的 fixture 证据；`orca profile state` export/recovery 是否包含未知 domain 未验证。
- H2 未解决：仓库内没有真实样本或 telemetry 表明 `ambiguous_session` 频率足够低。
- H3/H4 未解决：一任务多工作区的真实频率、任务中心视图相对 Dashboard + 侧栏的增量收益，均无用户证据。
- 归档工作区的 AI Vault 历史会话可用性未做渲染级验证。
- `projectBreakdown.key = worktree:<id>` 是实现细节，不是文档化契约。

## 4. conclusion and reasons

| 问题 | 结论 | 主要理由（按评审者） |
| --- | --- | --- |
| Q1 身份 | 一致同意 A+B 渲染层投影先行；C 的触发条件是"需要持久 primary/归档/验收/预算，或工作区删除后仍要历史与结算快照" | A/B |
| Q2 顺序 | 一致同意 M1 先行；**附加硬条件：identity/join/usage 三个 selector 必须可被 M2 直接复用**，页面内一次性拼装不算里程碑 | A/B 强调复用，C 认为即使复用少也值得（归因证据是本轮最缺的） |
| Q3 `taskRecords` | 改为"一期不落盘；二期在 H1 通过 + H3/H4 有产品证据后再落" | A/C 明确，B 同（且补充：不得退化为塞进 `WorktreeMeta`，那里有 30 天 GC） |
| Q4 H1 不成立时 | 一致：范围收缩为 M1；B 给出可执行形态——M2 拆 `M2a 存储兼容验证` + `M2b 落库实现` | A/B/C |
| Q5 用量口径 | 一致：工作区/任务级三态 + 结算快照足够；会话级 `worktreeId` **不作前置**。A 更进一步：逐 Agent 金额在归因成立前**不显示**，只显示 token 或"不可用"，禁止按工作区合计拆分或猜测 | A/B/C |
| Q6 入口 | A/B：不合并 Tasks 与 Dashboard（对象与时间尺度不同），互链不复制。C：一期就把面板并进现有任务详情，先不新增任务主视图 | A/B/C（措辞不同，方向一致） |
| Q7 移动端 | 同意一期排除；须标注 desktop-only 并登记 parity 豁免，不把移动端现有能力表述为已支持工作台 | A/C |
| Q8 缺项 | 见 §4.1 | A/B/C |

### 4.1 合并后的缺项（进入测试矩阵）

存储/兼容（B）：指定**旧 build** 的新→旧→新 round-trip；`orca profile state` export/recovery 对未知 domain 的断言；`usageSettlement` 在删除/归档/扫描失败/未启用/远端不可用下的失败注入；`taskRecords` malformed/未知字段的加载降级；revision CAS 冲突后的重读重试；`worktreeMeta` GC 后 binding unresolved 而记录仍可读的端到端；跨 `hostId`/`repoId` 同名 `externalKey` 防串；旧 build 的 selective 与 full write 两条路径都保留。

用量（C）：`ambiguous_session` 真实频率门槛；若加 session `worktreeId` 必须先做 mixed-version/wire 验证；M1 的对照数据要覆盖 **OpenCode 与 Muse**，不只 Claude/Codex；`projectBreakdown.key` 解析层 + 单测 + 归档历史会话可用性。

产品/UX（A）：分组状态互斥与优先级；`Delivered` 的产品定义；loading/未授权/部分 provider 失败/数据过期/scan failed 等态；三态文案不被读成 0；`[Open workspace]`/resume/Create 在不可执行、已归档、会话不可恢复时的禁用与说明；迁移后 `conversation/checks/files` 的可发现性；键盘全流程与焦点返回；屏幕阅读器名称与"状态不只靠颜色"；窄桌面/长标题/大数字/多工作区/多 Agent/无 PR 的布局边界；primary fallback 的可见标识与改选流程；Agent 消息/成本隐私遮蔽；Tasks 与 Dashboard 的任务成功率与入口误选率；M1/M2 的 CDP 截图基线。

## 5. end state

**`escalate-value-choice`。**

- 证据侧已收敛：M1 现在可做，M2 冻结到 H1/H2 有证据。
- B、C 的记录态是 `decided`（批准 M1、不批准直接进 M2），A 是 `escalate-value-choice`。
- 差异不在证据，而在"是否为任务历史/多工作区语义承担 M2 成本"属优先级与用户价值判断，归产品 owner。

## 6. next-step owner and authorization

- **产品 owner（用户）**：裁定 D1–D6，重点是"M1 之后是否进入 M2"和"接受 Tasks=任务主入口、Dashboard=实时 Agent 入口"的分工。
- **Operator**：仅依据本轮只读授权记录本评审与合并缺项；可以据此更新设计/计划文档（本轮已做），不改结论性证据。
- 实现、测试 fixture、真机渲染、远端/计费验证、合并、部署、启动 Agent：**均未从本任务获得授权**，需要新的显式授权。

## 7. invalidation and reopen conditions

以下任一变化应重开本轮结论：

- 旧 build round-trip 或 export/recovery 断言失败（则任何 `taskRecords` 落盘建议回退）。
- 真实样本显示 `ambiguous_session` 频率高到逐 Agent 用量多数不可用。
- 真实使用显示一任务多工作区极少，或 Tasks 与 Dashboard 被普遍认为重复。
- 上游改变 `projectBreakdown.key` 形态、Agent Dashboard 行模型或 Tasks 详情架构。
- 产品要求一期支持跨入口/跨 runtime/移动端/多仓联合验收。
- 移动端 parity 门禁不接受 desktop-only 豁免。
- 真机渲染显示图 C 仍过载，或图 A 分组无法形成稳定、可解释的唯一归属。

## 8. archival state

**pending archival**：本条记录已写入本文件并随本次提交入库；评审原文仅存在于各自终端（未落盘为独立证据文件）。
如需独立归档原始输出，需另行授权。
