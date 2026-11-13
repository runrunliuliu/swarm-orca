# M8「减法」：把判断搬出 Orca（设计草案）

- 日期：2026-11-14（Asia/Shanghai）
- 状态：**草案 v0.3：M8-1..M8-4 已实现（用户指示"继续"），尚未评审**。基线 `944e66c3`；提交与净额见 §11。
- 上位文档：[../issue-sedimentation.md](../issue-sedimentation.md)（§7/§10/§16）、[README.md](README.md)。
- 一句话：incidents 只存**事实**与**决策**；聚类、阈值、候选、归一化搬到 `incident-triage` skill，
  由 agent 在可复核的输入上判断，报告落 NAS，`decide` 仍由 R1 执行。

## 0. 已拍板（2026-11-14）与前置

1. **export 简化**：一条 `orca incident export` 输出 NDJSON（`meta/incident/pane_clock/tool_failure/end`
   五种记录），不做 `--include`、不做 DB 内容哈希、不做 `format/queryVersion` 仪式；`meta` 带 `view + exportVersion`。
2. **`mine` / `digest` 直接删**，不留 deprecated 别名；旧调用明确报"未知命令"，不静默空转。
3. **两张灰度表改成事实视图**：保留面板位置，去掉判定词汇与判定字段；IPC/CLI 同步改名为
   `paneClocks` / `toolFailures`，旧 channel/命令不保留别名。
4. **前置已补齐**：`git sparse-checkout add swarm/skills` 已执行；skill 落在 `swarm/skills/incident-triage/SKILL.md`。

## 1. 判据：什么必须留下，什么必须搬走

用户批评成立，但不能整块搬。两类东西用两个问题分开：

| 问题 | 答"是"→ | 例子 |
| --- | --- | --- |
| 这个事实只有在事件发生的那一刻、在主进程里才拿得到，事后无法从库里重建？ | **B 类：留下** | `onPtyExit` 的退出快照；provider 已翻译好的 `isError`/结构化字段；验收命令的执行时机 |
| 这个判断只需要读库 + 读上游已翻译好的结构化字段，换个上下文也能做？ | **A 类：搬走** | 聚类与阈值、候选规则、`GROUP BY` 摘要、errorCode 归一化、45 分钟阈值 |

推论（M8 的验收口径之一）：**A 类模块删除后，导出的行 + 证据指针必须足以让 skill 重现同一个判断**；
做不到的行就是 B 类，不能删。

## 2. 现状盘点（`wc -l` @ `944e66c3`）

### 2.1 A 类：判断（拟搬走；同组里的少量事实在 §4 标注保留）

| 组 | 生产模块（行） | 测试（行） | 判断内容 |
| --- | --- | --- | --- |
| mine | `incident-mine-build.ts` 589、`-rules.ts` 308、`-apply.ts` 214、`incident-mine.ts` 49、`incident-mine-test-support.ts` 104；CLI `handlers/incident-mine.ts` 202、`incident-mine-format.ts` 185（**1,651**） | 759 | 阈值 3 行/2 源、稳定来源、低信息降权、单实体排除、`--apply` target |
| digest | `incident-digest.ts` 138；CLI `handlers/incident-digest.ts` 77、`incident-digest-format.ts` 77（**292**） | 155 | 几条 `GROUP BY` + top-5 fingerprint |
| no_progress | `incident-stall-decision.ts` 189、`-evaluate.ts` 84、`-write.ts` 157、`-coverage.ts` 65、`incidents-stall-sampler.ts` 204、`-timer.ts` 142、`-samples.ts` 103、`incident-wait.ts` 170；CLI 184+81（**1,379**） | 649 | 45 分钟 + ≥2 周期 + `lastSemanticEventAt`/fallback、等待声明抑制、`wouldWrite` |
| tool_error | `incident-tool-error-classifier.ts` 166、`-window.ts` 154、`-blocks.ts` 110、`-report.ts` 150、`-observer.ts` 208、`-coverage.ts` 31；CLI 42+79（**940**） | 588 | 码表 + 文本 hint、5 次/10 分钟窗口、高危单发、`..._WRITE` 开关 |
| UI/接缝 | IPC `incident-gray-views.ts` 93、`shared/incident-gray-types.ts` 67、renderer `IncidentGrayTables.tsx` 270、`incident-gray-model.ts` 48（**478**） | 319 | 两张"灰度判定"表（stalls / tool-errors）；**改造成事实视图，不删面板** |

合计 A 类生产 **≈ 4,740 行**、测试 **≈ 2,470 行**。这是"判断"的物理体积，不是减法净额（§8.4）。

### 2.2 B 类：只有主进程能看见的事实（保留）

| 能力 | 关键文件 | 为什么不能搬 |
| --- | --- | --- |
| crash 快照 | `incident-pty-exit.ts` 191、`onPtyExit` 单调用 | pane 状态在回调后即被清理，事后读不到 |
| 幂等/不可变/去重 | `incident-key.ts` 293、`incident-store.ts` 320、`incidents-database.ts` 500 | UNIQUE + 触发器是引擎约束，不能由 skill 保证 |
| 覆盖缺口 | `incident-shadow-coverage.ts`、`incident-store-capacity.ts` | "这台机器可能漏记了"只有写者知道 |
| 验收门 | `acceptance-*.ts`、`dispatch-acceptance-*.ts`（≈1,536） | 必须在结算前、事务外执行；搬走即回到 M5 静默悬挂 |
| 自报/sanitize | `incident-report.ts` 221、`incident-sanitize.ts` 124 | 写入即脱敏，不能事后补 |
| mirror | `incident-mirror-*.ts`（≈1,394） | 远端事实的搬运，不是判断 |
| 读模型/角标 | `incident-counts.ts` 112、`incident-render.ts` 151 | 四态与"没数据≠没问题"的文案在这里 |

### 2.3 删除会碰到的既有耦合（必须一起改）

1. `IncidentCoverage.stallSample`（`incident-types.ts:203`）被 `incident-store-capacity.ts:69` 组装、
   `incident-format.ts:118` 打印、`incident-api-types.ts:101` 进 IPC、renderer coverage 横幅消费。
2. `digest` 被 `mine --json` 内嵌（`incident-mine-build.ts:542`），也读 tool-error 窗口快照
   （`incident-digest.ts:94`）：删窗口必然改 digest。
3. `incidents:stalls` / `incidents:toolErrors` 两个 IPC 与两个灰度 tab 只服务被删的判断；按决定 3
   改成事实视图（词汇与 DTO 一起换，避免"stalls"继续暗示判定）。
4. `list --json` **不足以**当 triage 输入：`incident-store.ts:272-289` 只返回 id/class/source/worktree/
   session/status/exitCause/fingerprint/summary/createdAt/decisionCount，**没有** run/task/dispatch id、
   evidence pointers、decision 原因，默认 limit 50；`list --json` 不改，export 才是机器接缝。
5. incidents DB 只允许增量迁移、新版本只读（`incidents-database.ts:21,388`）且 `incidents` 拒绝 UPDATE：
   **归档状态不能写在 incident 行上**，也不能 DROP COLUMN（旧缓存表是派生数据，才允许随迁移删除）。
6. `integration.ts` 的导出清单被 `incident-integration-boundary.test.ts` 钉死；M8 保留
   `startStallSampler` / `observeToolErrorItem` 名字，只换内部行为，边界不动。

## 3. 目标形态

```
主进程（事实）                 incidents DB（存储/管理）            agent（判断）
onPtyExit 快照      ──┐
结构化工具失败事实  ──┼─→  incidents / *_facts / decisions  ──→  orca incident export (NDJSON)
pane 事件时钟（采样）──┘        （不可变 + append-only）              │  incident-triage skill
                                                                     ├→ 报告（NAS，sha256 回读）
验收门（结算前，事实）                                               └→ 建议命令，交 R1 执行 decide
```

三种写入物：**fact row**（原始、无可判定字段）、**incident row**（不可变、有 fingerprint/证据指针）、
**decision row**（append-only）。一种判断物：**triage report**（可复核、可归档，不改库）。

## 4. 减法清单

### M8-1 mine / digest 的判断移出

- **删**：§2.1 的 mine 全组（1,651 + 759 测试）、digest 全组（292 + 155 测试）；
  `--apply`/`--target`/`--max-groups`/`--max-candidates`/`--time-budget-ms` 与 `MINE_*` 常量。
  **无 deprecated 别名**（决定 2）。
- **留**：`orca incident list --json`（人看，不变）；只读视图 `incident_triage_rows`（§7）与
  `orca incident export`（NDJSON 薄序列化，无分组、无阈值、无写路径）。
- **接管**：`swarm/skills/incident-triage/SKILL.md`（前置已补齐，决定 4）。
- **契约变化**：`mine`、`digest` 命令与 JSON 删除；automation 配方从 `incident mine --json` 改为
  "起一个会话 + skill + export"。
- **预估净删除**：−1,940 生产 / −910 测试；新增 export ≈ +110、视图 ≈ +20。

### M8-2 no_progress 降级为事实（含 UI 事实视图）

- **删**：`incident-stall-decision.ts`、`-evaluate.ts`、`-write.ts`（阈值、周期、`wouldWrite`、
  写 incident 的分支）；`STALL_*` 常量；`IncidentStallSampleCoverage` 的判定字段。
- **留**：采样器（60s，事实行）与 `incident_wait.ts`——现在只声明"该 pane 预期安静"，
  **不再"抑制"任何判定**。事实行字段固定为：`paneKey, state, stateStartedAt, turnStartedAt,
  lastSemanticEventAt, ageBasis('event'|'state_fallback'), observedAt`。年龄由读时计算。
- **接管**：阈值只在 skill 文档里（默认 45 分钟是**建议**，不是代码常量）；"是不是卡死"由 agent 判断。
- **视图**：CLI `incident stalls` → `incident pane-clocks`；IPC `incidents:stalls` → `incidents:paneClocks`；
  tab 改"Pane clocks (facts)"，去掉 `wouldWrite/threshold/reason` 与判定配色；`IncidentCoverage.stallSample`
  → `paneClock`（只报最后采样、panes、errors、legacy 行数）。
- **表策略**：**新增** `incident_pane_clocks` 并**删除**旧 `incident_stall_samples`（它本来就是每 tick
  重建的派生缓存，不是历史事实）；不做表重建，也不留 `legacy` 行。
- **预估净删除**：−700 生产 / −400 测试（保留采样/等待/视图测试）。

### M8-3 tool_error 降级为事实（含 UI 事实视图）

- **删**：`classifier`（归一化码表 + 文本 hint 正则）、`window`（5 次/10 分钟）、`blocks`、
  `report`（incident 行构造 + meta 窗口快照 + `INCIDENT_TOOL_ERROR_WRITE`）；**不存任何原始输出文本**。
- **留**：`observeToolErrorItem` 这一个写点（结构化 journal 路径不变），把
  `session, turn, itemKey, ordinal, toolName, errorKind|null, exitCode|null, isError, observedAt, hostId`
  写入新表 `incident_tool_failures`，`UNIQUE(session_id,item_key,ordinal)` 去重；行数/时间上限与
  `dropped` 计数可见。`incident-tool-error-coverage.ts`（provider 覆盖声明）保留并进 export。
- **接管**：按 `errorKind`/`exitCode` 聚簇、跨 turn 窗口、高危判断都交给 triage skill。
- **视图**：CLI `incident tool-errors` → `incident tool-failures`；IPC `incidents:toolErrors` →
  `incidents:toolFailures`；tab 改"Tool failures (facts)"，去掉归一化码、窗口与
  `wouldWrite/writeEnabled/highSeverity`，保留 provider 覆盖声明与 `dropped`。
- **契约变化**：`INCIDENT_TOOL_ERROR_WRITE` 删除；已有 `class=tool_error` 的历史 incident 行
  **保留可读**（`INCIDENT_CLASSES` 不删值）。
- **预估净删除**：−700 生产 / −560 测试；新增事实表 + 记录器 ≈ +150。

### M8-4 证据外置（不阻塞写路径）

- **DB 侧不变**：evidence 仍是指针 `path + sha256 + offset + size (+lineWindow/truncated)`；新增
  `sourcePath`（JSON 内增量字段）记住原始位置。**不把正文写进 SQLite。**
- **NAS 侧**：新增归档根（部署提供，默认未配置=不归档），布局 `swarm-artifacts/<run>/incidents/<id>/`；
  无 `run_id` 的行（裸终端）落到 `_unattributed/<host_id>/`（§9.1）。
- **状态机**（append-only，**不 UPDATE incident 行**）：`incident_evidence_archive_events`
  记录 `staged → archive_pending → archived | archive_incomplete`，视图取最新一条；
  `archived` 必须有 NAS 回读的 sha256 与原件相等。
- **不阻塞**：写入只落本地 staging（有界、小），主进程异步 drain；PTY 退出与结算路径**从不等待 NAS**。
- **失败语义**：NAS 不可达/超时 → `durable=false, archive_pending`，读模型明示"未归档"，
  **不得**计入"已归档"；回读不符 → `archive_incomplete`，保留原件与错误，不写成功标记；
  crash 路径本就没有 transcript 指针 → 保持空指针 + `unknownBoundaries`，不伪造证据。
- **历史行**：不补档；export 里标 `archive: none`（诚实表达"当时没有归档"）。

### M8-5 保留不动（明确列出，防止误删）

crash 捕获（fallback epoch / owner-claim binding / unknown 门槛）、验收门（声明 + 事务外执行 +
可见停点 + override 留痕）、幂等键/不可变触发器/prune marker/覆盖缺口/merging 的 mirror、角标四态与
"没数据≠没问题"的全部文案、自报入口与统一 sanitize、`integration.ts` 的十个上游接缝。

## 5. export 的简化契约（决定 1）

```console
orca incident export [--since 24h|7d] [--limit <n>] [--json]   # NDJSON，一行一条
{"kind":"meta","view":"incident_triage_rows","exportVersion":1,"since":…,"generatedAt":…,"coverage":{…}}
{"kind":"incident","id":…,"sourceKind":…,"sourceId":…,"class":…,"effectiveStatus":…,"runId":…,"taskId":…,
 "dispatchId":…,"worktreeId":…,"agentSessionId":…,"exitCause":…,"fingerprint":…,"evidence":{…},"archive":{…}}
{"kind":"pane_clock","paneKey":…,"state":…,"lastSemanticEventAt":…,"ageMs":…,"ageBasis":…,"observedAt":…,"declaredWait":…}
{"kind":"tool_failure","sessionId":…,"turn":…,"toolName":…,"errorKind":…,"exitCode":…,"observedAt":…}
{"kind":"end","counts":{…},"total":{…},"truncated":{…},"dropped":{"tool_failure":…}}
```

- 一种命令、一根流：`meta` 先出、`end` 后出，`--limit` 按 kind 生效且截断在 `end` 显式。
- 无 `--include`/`--hash`/DB 内容哈希：可复现靠 `view + exportVersion + since + coverage` 与报告的 `rowsUsed`。
- `coverage` 强制出现（shadowReplay / capacity / mirror / tool provider / paneClock），**空行 + 缺口不得读成"没有事故"**。

## 6. 迁移与回滚

| 面 | 改动 | 迁移说明 |
| --- | --- | --- |
| CLI | 删 `mine`、`digest`；`stalls`/`tool-errors` 改名 `pane-clocks`/`tool-failures` | 旧命令报"未知命令"（明确失败，不静默空转）；无别名 |
| automation | 定时任务改为"会话 + skill + export"，仍然只读 | 配方不在仓库内，属私有部署配置，需人工改一次 |
| IPC/UI | `incidents:stalls`/`incidents:toolErrors` → `incidents:paneClocks`/`incidents:toolFailures`；DTO 去判定字段；tab 改事实文案 | 旧 renderer 打新 main 会拿到 `ok:false` 而不是空数据 |
| CLI | 新增 `incident archive [--drain]`（状态 + 手动补档） | 无归档根时只读报告，写明 NOT CONFIGURED |
| DB | `user_version 6 → 8`，**只加**表/视图（不重建、不 DROP 业务行） | 旧构建见版本更高走既有只读路径（`incidents-database.ts:388`）；回滚=旧版可读不可写 |
| 代码 | 单 worktree 顺序提交 M8-1→M8-4 | 删除面互相重叠，不做 M7 式并行分支 |

## 7. 可复现性契约（triage 的输入与产出）

- **输入**：`orca incident export` 的五种记录（§5）。skill 必须记录 `view/exportVersion/since/coverage` 与 `end.truncated`；缺 coverage 或截断未声明，报告视为不可复核。
- **产出** report（Markdown + JSON 双份）：`exportVersion`、`window`、`rowsUsed:[id...]`、
  `sourceKeys`、`clusters`（依据写明）、`proposed:[{id,to,why}]`、`unknowns`、`coverage` 摘要。
- **执行权**：skill 只产出报告与命令建议；`confirmed` 只能由 R1 用 `orca incident decide` 显式执行
  （`--actor` 仍自报）；报告进档案时写 sha256 并回读。
- **可选**：`decide --report <path>` 存报告指针（可空列），或用 `--reason` 带 `report:<sha256>`（§9.3）。

## 8. 验收

### 8.1 保留行为的不变项（用现有测试证明没退化）

| 不变项 | 现有测试（不修改即须通过） |
| --- | --- |
| 幂等键/epoch、不可变触发器、prune 留痕 | `incidents/incident-store.test.ts`、`incident-key.test.ts` |
| crash 快照/unknown 门槛/operator_close 不写 | `incident-pty-exit.test.ts` |
| 覆盖缺口、容量 latch、counts gap 语义 | `incident-counts.test.ts`、`incident-store-capacity` 相关 |
| 验收门唯一门点、可见停点、override | `acceptance-gate.test.ts`、`dispatch-acceptance-*.test.ts` |
| mirror 原子性/游标/gap reason | `incident-mirror-sync.test.ts` |
| shadow 水位/有界重放 | `incident-shadow*.test.ts` |
| 角标四态与"没数据≠没问题" | renderer `IncidentPanel.test.tsx`、`IncidentCoverageBanner.test.tsx` |
| 上游边界只经 `integration.ts` | `incident-integration-boundary.test.ts`（导出清单不变） |

### 8.2 新增测试

- 迁移 6→8 增量、旧库只读、重复迁移幂等；export 五种记录齐全、截断在 `end` 可见、覆盖块必现。
- 事实表/视图：去重键、上限与 `dropped`；两个 DTO 不含判定字段；`panes=0`、`dropped>0` 不得渲染成"健康"。
- 归档状态机：staging→pending→archived、无归档根保持 pending、回读不符 `archive_incomplete`、
  写入抛错保持 pending（`incident-archive.test.ts` 用注入写者覆盖三种）。
- 删除断言：CLI help 快照无 `mine`/`digest`/`--apply`；IPC 无旧两个 channel。
- **skill 的测试 = 输入契约**：`contract.example.json` + report 模板；断言 export 通过 schema、
  模板含 `rowsUsed`/`exportVersion`/coverage。判断质量不可单测，明确记为不测项。

### 8.3 跑法

`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <分批路径> --maxWorkers=2`；
批次：`src/main/incidents` / `src/cli` / `src/main/ipc`+`src/shared` / renderer `right-sidebar`。不跑全量；
不跑 live NAS（用注入失败模拟），live 端到端仍是缺口。

### 8.4 减法度量

总量以 §11 的实测为准；原 ±15% 估算不再保留两套数字。判据仍是"删掉的每一行都能指到谁接管"，
指不到就应归入 §2.2（B 类），不得删除。

## 9. 未决（需用户拍板）

1. **归档根与范围**：`ORCA_INCIDENT_ARCHIVE_ROOT`、无 run 落 `_unattributed/<host>`、5 分钟 unref
   drain + `incident archive --drain` 兜底；证据按 64 KiB/条截断、历史不补档。请确认或要求改名/整文件复制。
3. **decision 的报告指针**：是否加可空 `report_pointer` 列，还是只把 `report:<sha256>` 写进 `--reason`。
4. **`incident wait` 去留**：作为"操作者声明"事实保留（推荐）还是随判定一起删？
5. **triage 是否能直接 `decide`**：建议否（只出报告 + 命令建议）；`watch`/`duplicate` 也不自动 apply。
6. **工具失败保留期**（已实现 7 天 + 20k 行上限）与 `dropped` 预算；是否接受 `--min-age` 查询过滤。

## 10. 不做与红线

- 不动 B 类：crash 捕获（fallback epoch / owner-claim binding / unknown 门槛）、验收门时机、幂等键与
  不可变触发器、prune marker、覆盖缺口、merging/mirror、角标四态与全部"没数据≠没问题"文案。
- 不把 `unknown` 归一化成失败；不让 skill 产出 `confirmed`；不在 renderer 做判定；不改上游文件
  （`integration.ts` 导出名不变）。
- 不新增第三方依赖；不改 orchestration `SCHEMA_VERSION`；不保留 `mine`/`digest` 兼容层（决定 2）。

## 11. 实施记录（M8-1..M8-4，均在 `issue-sediment`）

- 提交：`7be087bc` M8-1（−2,446）、`7472ebb0` M8-2（−960）、`1428767b` M8-3（−1,174）；
  本提交 M8-4（staging、append-only 状态、异步 drain、`incident archive`）是净新增。

- `user_version 6 → 8`（增量表/视图）；orchestration `SCHEMA_VERSION` 未动，0 新依赖。
- 测试：`src/main/incidents` + `src/main/ipc` + `src/cli` + preload bridge + renderer right-sidebar，
  6,820 passed / 5 failed；5 条与基线一致（local-network 1、worktree-git-common-polling 1、
  register-core-handlers 2、orchestration-session-caller-cli 1），无新增失败。未做：skill 本体
  （待评审）、live NAS 演练、live 崩溃→triage→关闭闭环。
