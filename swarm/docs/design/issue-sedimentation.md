# 多 Agent 运行故障沉淀与定期修复（Orca 一等能力 · 设计 v2）

- 日期：2026-11-12（Asia/Shanghai）
- 状态：**设计（v2.5，M1–M3 已实现并通过评审共识）**。不构成部署、启动、重试、写入、合并或权限授权。
- 修订：v2 初稿 → v2.1（两轮评审）→ v2.2（§19.1 三条决策）→ v2.3（M1 评审修正）→ v2.4（M2 BLOCK → 修复）→ v2.5（M3 评审分歧 → 共识 → 语义事件时钟 → §19.5）。
- 落地位置：本 fork 的 `orca/`（TypeScript，主进程），不是适配层、不等上游。
- 评审输入（同目录）：`issue-sedimentation.review-codex-ark.md`、`issue-sedimentation.review-trae.md`
  （v1 评审，针对"Python 适配层 + 文件轮询"版本）；v2 评审另见
  `issue-sedimentation.review-codex-ark-v2.md`、`issue-sedimentation.review-trae-v2.md`。
- 端到端示例：`issue-sedimentation.example.md`（v1，虚构 ID；v2 落地后按实现更新）。

## 0. v1 → v2 的方向变更

| 项 | v1（已否决） | v2（本文） |
| --- | --- | --- |
| 实现语言/位置 | Python，`swarm/` 适配层 | TypeScript，`orca/` 主进程 |
| 信号采集 | 只读轮询 `events.jsonl` / `status.json` / `alerts.jsonl` | 事实产生处直接写入（进程内） |
| 判定时机 | 分钟级（观察者 cadence） | 事件级（同一 tick） |
| 崩溃证据 | 靠外部观察者推断 | `onPtyExit` 的 `TerminalExitCause` 直接落盘 |
| 「结果不符预期」 | 无来源，只能自报 | dispatch 声明 `acceptance`，结算时判定 |
| 定期执行 | 自建 cron 包装 | 复用 Orca automations |

否决 v1 的理由只有一条技术性的：**Orca 主进程是唯一同时看见全部信号的进程**，而文件轮询必然
漏掉两个窗口——`retirePtyAgentLaunchAuthority` 清理 pane 状态之后，以及 hook 归一化时被丢弃的
中间态。v1 的判定权设计仍有价值，本文保留（§5）。

## 1. 问题与范围

多 agent 系统失败的方式至少四类，全部要能沉淀成**可读、可归档、可复现、可防复发**的记录：

1. **跑不下去**：空转、死锁、任务无进展，进程还活着；
2. **结果不符合预期**：验收不通过、越界、产物为空；
3. **崩溃/被杀**：进程已死，退出原因可能不可知；
4. **执行者自报**：机制失效、工具行为与文档不符，只有当事人看得见。

范围之外：不改 Run/Task/Dispatch 协议语义，不改既有交付流程，不自动合并部署，不让系统给自己
签验收。

## 2. 结论摘要

1. **写入在事实产生处**，不在定时器里。崩溃 → `onPtyExit`；停滞 → 状态行 + reaping；结算 →
   `dispatch-completion`；自报 → CLI。
2. **独立 incident 库**，不塞进 orchestration DB、不动 `SCHEMA_VERSION = 44`。
3. **幂等键在 DB 层**：`UNIQUE(source_kind, source_id, facet)`；不可篡改用触发器写成引擎约束。
4. **`acceptance` 必须在 Orca 里长成一等概念**，否则"结果不符预期"永远只能靠模型自述。
5. **issue md 是派生视图**，可随时从 record 重建，不作为存储格式。
6. **定期挖掘用 automations**，只读，产出写 triage decision，不自动改代码。
7. **`untriaged` 是合法终态**：无人有资格判定时保留，不伪造 `confirmed`。
8. **unknown 是一等值**：退出原因不可知就存 `unknown`，不猜 `failed`。

## 3. 为什么是 TS-in-orca（技术论证）

| 判据 | orca/TS | 适配层/Python |
| --- | --- | --- |
| 退出原因 | `onPtyExit` 直接持有 `TerminalExitCause`（`operator_close` / `signaled` / `exited` / `unknown`，见 `src/shared/terminal-exit-cause.ts`），并已有 `stop_unverified` 语义 | 只能事后读文件或 `terminal wait`，拿到的是合成后的数字 |
| 中间态 | `agent-hooks/server/server-state.ts` 的 `applyNormalizedStatus` 是唯一收敛点 | 轮询 cadence 之间的事件不可见 |
| 停滞 | `agent-hooks/server/server-status-application.ts`、`server-reaping.ts` 已有 freshness/回收周期 | 需要另建 cadence 并与真实状态竞争 |
| 结算 | `orchestration/db/dispatch-context/dispatch-completion.ts` 的 `completeDispatch` / `failDispatch` 是唯一结算路径 | 只能读 `events.jsonl`，晚一个周期且可能丢失 |
| 崩溃后的自查 | 主进程自己崩时才需要影子日志（`observability/local-file-sink.ts` 同步写盘） | 需要自己实现同样的东西 |
| 展示面 | CLI（`src/cli/handler-group-manifest.ts`）+ preload/IPC + renderer 三层现成 | 只能出文件 |
| 定期执行 | automations（`scheduled`）现成 | 自建 cron + 包装 |

代价（如实记录）：`orca/` 是快照导入，改动要在下次重新导入时重放。§14 用"新增文件为主 + 改点
≤5"把它压到可接受范围。

不做的事：不在主进程里加定时轮询去"发现"状态；不复制一份 `events.jsonl`。

## 4. 现状事实清单（本设计依赖的既有能力）

逐项已在本 worktree 的 `orca/` 源码中核对存在；**括号内是实现依据，不是承诺**。

| 能力 | 现状 | 依据 |
| --- | --- | --- |
| PTY 退出唯一汇聚点 | 有，含 incarnation 校验、异常 SSH surface 保留、liveness verdict | `src/main/runtime/orca-runtime-on-pty-exit.ts` |
| 退出原因分类 | 有，四类 + 不可知原因 | `src/shared/terminal-exit-cause.ts` |
| Agent 状态归一化 | 有，单一 ingress（实现在 update 层，`server-state.ts` 只声明抽象方法） | `server-state.ts`（abstract + ingress 注释）、`server-status-update.ts`（`applyNormalizedStatus`） |
| 状态时间戳 | 有（`stateStartedAt` / `turnStartedAt` / 观测时间） | `server-status-application.ts` |
| 状态回收 | 有但**范围窄**：恢复态 Claude subagent 行与滞留 claim 的清理，不是通用 freshness tick | `server-reaping.ts` |
| 转录轮询重试 | 有，但是 transcript/assistant-message 重试，**不是** readiness 或无进展判定 | `server-status-retries.ts` |
| **通用无进展判定器** | **没有**（无一流字段的 `wait_reason`/`expected_wait`，需新建） | 无 |
| 结构化会话状态流 | 有 | `src/main/native-chat/agent-session-wire/*` |
| Dispatch 结算/失败 | 有（含按 task 批量结算） | `orchestration/db/dispatch-context/dispatch-completion.ts` |
| 升级/宕机升级分诊 | 有（escalation → dispatch failure + 熔断） | `orchestration/coordinator-escalation-triage.ts` |
| 不可变记录 + 触发器 | 有范式 | `orchestration/db/schema/administrative-history-schema.ts` |
| 版本化迁移 | 有，`SCHEMA_VERSION = 44` | `orchestration/db/contract-constants.ts`、`db/schema/migrate.ts` |
| NDJSON sink | 有（10MB × 10 轮转，`writeSync`）；但 `push` 先进内存缓冲（32 条或 200ms 才刷），**必须显式 `flush()`**，无 fsync，不是 WAL | `src/main/observability/local-file-sink.ts` |
| 脱敏 | 有（5 条规则族，三处复用），覆盖凭据/URL/env；**不保证**私有路径与主机名 | `src/main/observability/redactor.ts` |
| SQLite 封装 | 有（bun/node 双实现 + 端口） | `src/main/sqlite/sync-database.ts`、`bun-sqlite-database.ts` |
| CLI 分组注册 | 有 manifest，但新增一组仍要 handler/spec/help/格式化 + manifest drift 测试，不是一行 | `src/cli/handler-group-manifest.ts`、`src/cli/*-format.ts` |
| preload API 分层 | 有（`preload/api/*-api.ts`） | `src/preload/api/` |
| 多宿主分区持久化 | 有范式 | `src/main/persistence/profile-state/*`、`persistence-host-partitioned-*` |
| 定期任务 | 有（`trigger: 'scheduled'`，cron 方言与预检） | `src/shared/automations-types.ts`、`src/shared/automation-cron-*.ts`、`src/shared/automation-precheck.ts` |
| **业务验收** | **没有**（只有 mutation receipt 的幂等 acceptance） | `db/schema/*`、`db/worker-dispatch/worker-dispatch-start.ts` |

最后一行是唯一必须新增的一等概念，见 §8。

## 5. 分层与判定权

```
写入点（事实） → 触发分类（T1/T2/T3，只能"开候选"） → 裁决（R1/R2，唯一能 confirmed/关闭）
              → incident record（不可变） → triage decision（append-only） → issue md（派生）
              → 定期挖掘（只读） → guardrail / 处置（关闭条件之一）
```

| 通道 | 判定者 | 判据 | 误报防护 |
| --- | --- | --- | --- |
| **T1 阈值型** | 主进程自身（进程内计数器 + reaping） | 无进展回合超阈、状态超过 freshness 窗口、退出无回执、latch 置位 | 显式等待声明优先：`wait_reason` 有效期内不计无进展；`stop_unverified` 记 unknown 不记失败 |
| **T2 验收型** | 独立执行（主进程跑 `acceptance` 命令 / 独立 reviewer 会话） | 命令/谓词不满足、写入范围越界、pin/hash 不符、产物为空 | 判据在 dispatch 时固定，事后不可改写 |
| **T3 自报型** | 执行者（`orca incident report`） | 机制失效、行为与文档不符 | 必须带 `class` + `code` + 最小复现；无 code 一律进 `untriaged` |

裁决权：
- **R1 triage owner**：人，或一个与出事会话不同上下文的 agent 会话；只能由它把
  `untriaged → confirmed / duplicate / invalid / watch`。
- **R2 外部权威**：真实 owner / 交付方，用于 `needs_archive` 与最终关闭。
- T2 与 R1 不得是同一个上下文；T3 不得直接产出 `confirmed`。

**禁止的失败模式**：让写入点同时做判定（`onPtyExit` 不判断"这是不是 bug"）；让执行者给自己的
验收签字；把 `unknown` 归一化成 `failed`。

## 6. incident store

### 6.1 为什么独立库

1. 事故不都是 Run 作用域的（裸终端、普通会话也会崩），塞进 orchestration 会让 `run_id` 变成空洞；
2. 免去协调 `SCHEMA_VERSION` 与既有迁移测试；
3. 可独立轮转/清理/重建，与 Run 数据生命周期解耦；
4. 天然按宿主分区，符合"执行宿主拥有自己观察到的状态"的既有边界。

实现：`src/main/incidents/incidents-database.ts`（复用 `sqlite/sync-database.ts`），
`user_version` 自管，`migrate` 同构 `orchestration/db/schema/migrate.ts`（事务内建表 + 成功后置版本）。

### 6.2 表

```sql
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,   -- pty_exit | status_stall | dispatch_settle | acceptance | self_report
  source_id   TEXT NOT NULL,   -- 稳定实体 + epoch（下详）
  facet       TEXT NOT NULL,   -- 同一 source 的不同侧面（exit | stall | verdict | rule:<id>）
  host_id     TEXT NOT NULL,
  worktree_id TEXT, run_id TEXT, task_id TEXT, dispatch_id TEXT,
  agent_session_id TEXT, pty_incarnation_id TEXT,
  class       TEXT NOT NULL,   -- crash | no_progress | tool_error | acceptance_failed | unknown_state
  status      TEXT NOT NULL DEFAULT 'untriaged', -- untriaged | confirmed | duplicate | invalid | watch | needs_archive | closed
  exit_cause  TEXT,            -- TerminalExitCause 原样序列化
  fingerprint TEXT NOT NULL,   -- 聚类用，不参与唯一键
  evidence    TEXT NOT NULL,   -- JSON：transcript 路径+offset+sha256+窗口行数；不含正文
  summary     TEXT NOT NULL,   -- 已过 redactor 的短摘要
  created_at  INTEGER NOT NULL,
  UNIQUE(source_kind, source_id, facet)
);
CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents(fingerprint, created_at);

CREATE TABLE IF NOT EXISTS incident_decisions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,  -- 故意不加 FK：prune 删 incident 后审计行必须保留
  from_status TEXT NOT NULL, to_status TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

不可变性抄 `administrative-history-schema.ts` 的触发器等价物：

```sql
-- UPDATE 无条件拒绝
CREATE TRIGGER IF NOT EXISTS trg_incident_update BEFORE UPDATE ON incidents
BEGIN SELECT RAISE(ABORT, 'incident_immutable'); END;
-- DELETE 只允许在 prune 事务内放行：先置 incident_store_meta.prune_deleting='1'，删除，finally 复位；
-- marker 与 DELETE 同事务，进程中断即回滚，不会留下“可任意删除”的窗口。
CREATE TRIGGER IF NOT EXISTS trg_incident_delete BEFORE DELETE ON incidents
WHEN COALESCE((SELECT value FROM incident_store_meta WHERE key = 'prune_deleting'), '0') <> '1'
BEGIN SELECT RAISE(ABORT, 'incident_immutable'); END;
-- decisions 的 UPDATE/DELETE 无条件拒绝
```

状态只能通过 `incident_decisions` 追加 + 一张 `incident_state` 投影表更新（或视图），
incident 本身不改。`decisions` 同样禁 UPDATE/DELETE。

### 6.2.1 幂等键必须带 epoch（评审修正）

`(source_kind, source_id, facet)` 只有在 `source_id` 已内含 epoch 时才成立。裸实体 id 会造成两类
真实丢失：

| 反例 | 后果 | 修正 |
| --- | --- | --- |
| `(status_stall, paneKey, stall)` | 同一 pane 停滞→恢复→再停滞，第二次被唯一键吞掉 | `source_id = <paneKey>:<stateStartedAt>`；`facet = 'stall'` |
| `(acceptance, dispatchId, verdict)` | 同一 dispatch 有 `tests` 与 `archive_hash` 两条规则时互相覆盖 | `facet = 'rule:<ruleId>'`，`source_id = <dispatchId>:<attempt>` |
| `(tool_error, sessionId, tool)` | 不同 turn 的同一工具错误被合并 | `source_id = <sessionId>:<turn>:<code>:<windowStart>` |
| `(pty_exit, incarnation, 'exit')` | 已足够（incarnation 唯一） | 保持 |

epoch 一律取**上游已有且单调**的字段（incarnation id、`stateStartedAt`、turn id、attempt），
不自造计数器。写入方必须在调用前构造完整 key，store 不做"智能去重"。

### 6.3 evidence 只存指针

transcript 可能 GB 级。record 存 `{path, inode/sha256, startOffset, endOffset, lineWindow}`，
渲染时才读窗口。窗口大小有上限（默认前后各 50 行），超限记 `truncated: true`。
凭据/路径脱敏在写入前过 `observability/redactor.ts`，不留原文。

### 6.4 耐久度口径（M1 实现确认）

写路径用 `journal_mode=WAL` + `synchronous=NORMAL`：不为每次 insert 付 fsync，避免给 PTY 拆除加
磁盘抖动，代价是**掉电可能丢掉最后几条诊断行**。因此：

- incident 库**不是**归档或验收收据；不得用它声称“提交已持久化”或“任务已完成”。
- 需要耐久时仍走既有归档/回读（hash 校验）路径，incident 只提供指针。
- M1 没有 shadow/reconcile；主进程崩在两处（callback 前、insert 前）会直接丢事实，不得声称已覆盖。

## 7. 触发实现（逐类）

### 7.1 crash（进程已死）

- **写点**：`onPtyExit`，但**必须在 `retirePtyAgentLaunchAuthority` 之前收集快照**。源码已经先
  `collectAgentStatusPaneKeysForPty` 再 retirement，尾部的 runtime map 已不可靠。
- **形态**：只允许一个调用——`recordPtyExitIncident({ ptyId, incarnationId, paneKey, agentSessionId,
  worktreeId, exitCause, hostExitConfirmed, providerExitObserved, surface })`；函数内部**不得**再反查
  会被清掉的 runtime map。
- **判据**：`exitCause.kind` 为 `signaled` / `exited(non-zero)` / `unknown`；`operator_close` 不写；
  abnormal SSH surface（未确认退出）写 `unknown`，不写 crash-failed。
- **unknown 的门槛**：`unknown` 只在 pane **曾有 agent 绑定**时写 crash（`launchAgent` /
  `foregroundAgent` / 状态 paneKey / `agentSessionOwners.identityDigest` 任一存在）。裸 shell 的
  歧义 0 退出与用户手敲 exit 无法区分，全写会把真崩溃埋掉；这些跳过必须计入覆盖缺口（
  `unknown_without_agent_binding`），不能静默丢弃。
- **incarnation 回退**：两个 incarnation id 都缺失时，epoch 用**不含 separator 的稳定编码**：
  `runtime-<sha256(runtimeId \0 ptyId)[0..32]>`。不得生成含 `:` 的 `runtime:<id>:<g>`（幂等键拒绝
  含 separator 的 epoch，会静默丢弃）；也不得用 lifecycle generation（它会推进并在清理时被删，
  第二次回调会生成不同 epoch 而重复）。已知代价：同一 `ptyId` 重新拉起无法与重复回调区分，会
  折叠到同一行——已作为 unknown 边界写进记录。
- **unknown**：`stop_unverified` 与 SSH 未确认退出写 `class: crash` + `exit_cause.kind: unknown`，
  状态仍是 `untriaged`，不写 `failed`。
- **幂等**：`source_id` = pty incarnation id，`facet = 'exit'`。同一 incarnation 重复回调只落一条。
- **已知丢失窗口**（不可消除，只能减小）：callback 入口到 shadow flush 之间主进程崩；stale
  incarnation 被丢弃；DB 与 shadow 只成功一边。

### 7.2 no_progress（跑不下去但活着）——M3 已实现（默认不写）

**年龄口径（关键）**：年龄 = `now − lastSemanticEventAt`，即状态行上**最近一次语义事件/观测**的
时间戳。不得用 PTY 字节流（pi/codex/trae 都是 TUI，spinner 每秒重绘，"有输出"与"有进展"脱钩），
也不得用 `stateStartedAt`/`turnStartedAt` 当进展（单个长回合里它们不推进）。缺该时间戳时回退
`stateStartedAt`，且必须在行、JSON、文本与 coverage 里标 `ageBasis: 'state_fallback'`，不得静默
伪装成语义判据。epoch 仍用 `stateStartedAt`，但它**只**作幂等键。

- **判据**：工作态、无有效等待声明、`no_event_for_threshold`（45 分钟无语义事件且跨 ≥2 个独立
  采样周期）。判定结果为 `wouldWriteIfEnabled`，不是"已确认卡死"。
- **不写**：`idle`、`done`、有有效等待声明、状态 `unknown`、key 校验失败（计 `stall_key_rejected`）。
- **写点**：一个 60s `unref()` 采样 interval（唯一新增定时器；理由：状态应用是事件驱动、reaping 是
  一次性扫描、hook server 只有 provider 专用 interval）。store 不可用时零工作，timer 内异常只记
  `stall_sampler_errors` / `lastError` 并进 coverage，绝不抛。
- **等待声明**：`orca incident wait --terminal <handle> --reason <text> [--until <rfc3339>]` /
  `--clear`。按 `(paneKey, epoch)` 取值，pane 复活不继承；过期自动失效并由采样器清理。
  `--clear` 清**整个 pane**（所有 epoch），与 `--reason/--until/--actor` 互斥；长等待应带 `--until`。
- **幂等**：`source_id` 由 `buildIncidentKey({kind:'status_stall', paneKey, stateStartedAt})` 生成
  （**不得手工拼字符串**，否则重演 M1 fallback epoch 的校验旁路），`facet='stall'`。
- **灰度**：`INCIDENT_STALL_WRITE=on` 才写，默认 off；只读面 `orca incident stalls [--json]` 输出
  `state / ageMs / ageBasis / threshold / declaration / wouldWriteIfEnabled / reason`，并明示
  "灰度判定，不写 incident"。
- **判据边界**："45 分钟内持续有事件但无实质进展"（例如反复重试同一失败）**不**由本判据处理，
  归 M4 的 `tool_error` 聚簇。

### 7.3 tool_error（工具/回合错误）——设计中

- **写点**：transcript 适配器解析出的 tool result 错误与 turn end 错误（各 CLI adapter 已有解析）。
- **判据（提议默认，待拍板）**：同 session、同 tool、同 normalized code 在 10 分钟内连续 **5 次**；
  `permission` / `pin` / `scope` / `immutable` 类高危错误可单次直通候选。
- **幂等**：`source_id = <sessionId>:<turn>:<code>:<windowStart>`。

### 7.4 acceptance_failed（结果不符预期）

见 §8。

### 7.5 self_report（执行者自报）

- **入口**：`orca incident report --class --code --evidence --repro`。
- **写点**：CLI handler → incident store（同库，`source_kind = 'self_report'`，`source_id` = 请求 id）。
- **强制**：必须 `class` + `code`；无 `code` 记 `untriaged` + `invalid_class` 提示，不拒收。
- **幂等语义**：`--source-id` 相同即去重，且**不覆盖**旧记录的内容——CLI 必须明确提示“同键内容不会
  覆盖旧记录”，否则操作者会以为改过的 evidence 已写入。
- **evidence 边界**（M2-C2/C5）：单文件上限 64 MiB（超限 typed 错误，不静默跳过），一次最多 8 条；
  repro / 字符串数组 / 路径字段统一过同一 sanitize+redact 层；路径本身可能含敏感项目名，属于已知边界。
- **统一 sanitize**：normal write、DB insert、shadow replay 三处共用同一层，避免 replay 成为脱敏旁路。

## 8. acceptance：Orca 缺失的一等概念

现状：orchestration 只有"mutation receipt 幂等 acceptance"，没有业务验收。因此：

```ts
// 随 dispatch 持久化（新增列或独立表 worker_dispatch_acceptance）
type Acceptance = {
  command: string                    // 在 worker 工作区执行
  expect: { exitCode?: number; stdoutMatches?: string }  // 至少一项
  timeoutMs: number
}
```

判定位置与禁止事项：

- **不得**在 lifecycle 写事务里跑外部命令（长命令/卡死会被带进结算路径）。前置检查必须在
  `completeDispatch` 调用**之前**完成，结果以值的形式传入。
- 满足 → 正常结算。
- **不满足 → 必须停在一个可见停点**：写 incident + 把 dispatch 置为显式 `acceptance_pending`
  （非终态、在列表/CLI 可见、带 owner 待处理），**不是**"状态不变地继续 running"。
  评审指出的真实风险：既不完成也不失败、又不变状态 = 静默悬挂，无人拥有下一步。
- 无法判定（命令不存在、超时、宿主不可达）→ `class: acceptance_failed` + `unknown` 语义，仍
  `untriaged`，并同样进入 `acceptance_pending`。
- 不允许 acceptance 结果直接触发 `failDispatch`：判定与状态转移分离，避免一次误判把任务判死。

这样"结果不符合预期"第一次有了自动化、可复核的来源，而不是模型自述；同时不会把失败的验收变成
没人管的悬挂任务。

## 9. issue md：派生视图

生成器 `src/main/incidents/incident-render.ts`：`incidents + incident_decisions + evidence 窗口` → markdown。
不落库、可随时重建、可被 `orca incident show --md` 直接输出。

必含段落：摘要（30 秒可读）/ 背景与预期（dispatch 契约原文）/ 时间线（仅已确认事实，
`begin/end` 成对）/ 机制分析 / unknown 边界 / 证据与 pin / 防复发项。

v1 只做**单条** `orca incident show <id> --md`（可重建），不做"一 fingerprint 一 md"的长期视图；
后者需要稳定的 fingerprint 语义，与聚类一起放到后续里程碑。

## 10. 定期挖掘与修复（非首版）

用 automations（`trigger: 'scheduled'`），不新建调度器。
人机回路前置：**没人看就等于没做**。所以挖掘之前先有 §12 的 `list / show / decide`，否则这只是把
没人读的日志换成没人读的 DB。

1. 定时跑一个**只读**摘要会话（或直接 CLI）：新增数 / 未看数 / 拓扑 fingerprint / 需归档数。
2. 候选阈值（提议）：7 天内同 fingerprint ≥3 条且来自 ≥2 个不同 `source_id`；`signaled` crash
   与同一 invariant 的 `acceptance_failed` 可 2 条进候选。
3. 产出落 `incident_decisions`（`actor = 'miner'`），只允许 `watch` / `duplicate` /
   `needs_archive`；**不允许** `confirmed`（那需要 R1 的人类/独立上下文）。
4. 修复动作回到既有独立修改任务与交付授权，不在挖掘器里自动发生；有界（条数/时间/token）。

## 11. 硬问题与容量

**11.1 远程执行宿主**
incident 必须由持有 PTY 的宿主写；客户端只 mirror（对齐既有 host-partitioned 持久化）。
SSH relay 断线时，不能把服务端事故记到客户端；客户端只允许记录"连接不可用"这类**自身**事实。
首版只做本机，且必须在读模型里显式输出 `remote_incident_capture: unsupported`，
否则运维会把"没记录"误认为"没事故"。

准确的边界（M1 实现口径）：本机记录的是**这台宿主观察到的本地 PTY 事实**，包括由 SSH relay 拥有的
pane（`surface=ssh`）；它**从不**记录远端宿主内部发生的事实。所以 `unsupported` 的含义是“远端宿主
内的故障不在本机库中”，不是“SSH 会话的退出不记”。

**11.2 主进程自己崩**

影子 NDJSON 是 **best-effort replay hints，不是 WAL**。事实：`push` 先落内存缓冲（默认 32 条 /
200ms）、无 `fsync`、轮转可能部分完成。因此：

- 每条关键记录 `push` 后**立即 `flush()`**（`flushBufferThreshold: 1`），写入顺序 **shadow 先、DB 后**；
- **水位用单调 `seq`，不用文件名/偏移**（M2 评审 C1）：轮转把 base 改名成 `.1` 并新建 base，
  basename + offset 会把旧偏移套到新内容上并跳过 `.1` 里未回放的行。行携带 `seq`（shadow 体
  `v: 2`），水位记 `lastSeq`，replay 扫全部现存文件、只处理 `seq > lastSeq`，重复由 DB UNIQUE 吸收；
- 旧版本行（`v: 1`）按 unsupported 停止并可见，不猜测、不修复；
- **容量拒收不得挡住后续行**（C3）：被容量闸拒收的低优先级行写 durable dropped 计数后推进
  `lastSeq`，crash 类照常插入，不得让一行噪声永久阻塞后续 crash；
- **有界且可续跑**（C6）：每进程有字节/行数预算，超出即停并保持水位可续，记录本次 `lastRun`
  （lines/bytes/ms）；
- **失败与不完整必须可见**（C4）：`shadowReplay` 暴露 `lastSeq / incomplete / lastStopReason /
  failures / lastError / dropped / lastDroppedReason / lastRun`，`incident list|show` 与 IPC 都输出，
  空列表不得读成“没有事故”；
- 仍然存在的窗口：缓冲未 flush、`writeSync` 被吞、掉电无 fsync、轮转中崩、磁盘满、序列化/脱敏
  失败。这些只能缩小，不能承诺“零丢失”。

**11.3 去重**
只靠 DB 唯一键（且键内带 epoch，§6.2.1），不靠相似度。同一事实会被 5 个入口看到（hook、OSC 133、
structured wire、liveness verdict、pty exit）→ 规定**只有 pty exit / dispatch settle / 状态停滞
各自唯一写点**，其余入口不写 incident。指纹只做聚类展示。

**11.4 噪声**
- 等待声明优先（`waitReason` / `expectedDoneAt`）；
- 同一未闭合 unknown 只累加 `occurrences`，不生成新 incident；恢复或新 epoch 才开新记录；
- 阈值可配，默认保守（§7.2 / §7.3 / §10 的提议值）；
- `invalid` 与 `duplicate` 是合法处置，允许沉默，但必须留 decision。

**11.5 容量与保留**
两套策略，不要混：

| 对象 | 默认 | 上限行为 |
| --- | --- | --- |
| 影子 NDJSON | 沿用 sink 的 10MB × 10（总量 ~100MB） | 轮转；超限记录 oversize marker |
| incidents DB | active 上限 50k 行或 500MB | 先到先停写低优先级噪声；`crash` 仍可写 |
| 容量表达 | **拆分两个字段**：`capacity_latch_set`（曾限流，持久）与 `currently_limited`（此刻拒收） | 只把后者说成“正在拒收”；latch 表示“曾经用过去式” |
| 删除 | 仅 `orca incident prune`（默认 `--dry-run`），且 `--json` 必须输出候选/已删 id（有限、可标 truncated） | 只允许删 `closed / invalid / duplicate` 且 older-than 90 天；`untriaged / confirmed / needs_archive` 不得自动删 |
| `incident_decisions` | 不物理删 | 只能在整库归档后受控 compaction，否则关闭链路丢证据 |

## 12. 交付面与最小人机回路

| 面 | 内容 | 里程碑 | 位置 |
| --- | --- | --- | --- |
| CLI | `incident list` / `show <id> [--md]` | **M1（必须）** | `src/cli/handler-group-manifest.ts` + `src/cli/incident-*.ts` |
| CLI | `incident decide --to <status> --reason`（`confirmed` 只允许显式 R1 actor） | **M1（必须）** | 同上 |
| CLI | `incident report --class --code ...`（自报） | M2 | 同上 |
| CLI | `incident stalls [--json]`（灰度只读：state/ageMs/ageBasis/声明/wouldWriteIfEnabled/reason） | **M3** | `src/main/incidents/incidents-stall-sampler.ts` |
| CLI | `incident wait --terminal <h> --reason <t> [--until]` / `--clear`（整 pane，互斥） | **M3** | 同上 |
| CLI | `incident prune --dry-run`（`--json` 带候选/已删 id） | **M1（必须）** | 同上 |
| 覆盖缺口 | `list/show` 输出 `remote_incident_capture`、`capacity_latch_set`、`currently_limited`、`shadow_replay`（`lastSeq/incomplete/lastStopReason/failures/lastError/dropped/lastRun`） | **M1 + M2（必须）** | 读模型 |
| 读模型 | shared 类型 + IPC | M2 | `src/shared/incident-*.ts`、`src/preload/api/incident-api.ts` |
| 每日摘要 | scheduled automation 只出数字摘要 | M4 | automations |
| UI | 列表 + 详情 + triage | 最后 | `src/renderer/src/...` |

M1 的判定标准是：**杀掉一个本机 agent 后，运维能列出事故、看到退出原因与 unknown 边界、标
watch/invalid/needs_archive，并知道 store 是否有覆盖缺口。** 做不到就不算交付。

M1 明确**不**包含：证据指针（`pointers: []`，md/CLI 显式列出该缺口，M2 补）、shadow/reconcile、
`no_progress`、`tool_error` 写入、acceptance、自报入口、IPC/UI、远端。

M1 的 CLI 实现口径：直连 SQLite（`list/show` 只读打开、不建 WAL、不迁移；`decide/prune --apply`
读写），不走 IPC——因为桌面未运行时仍需能 triage；非本机 selector（`--host`）显式拒绝，不静默按
本机回答。store 打开失败会被进程内缓存为不可用（避免每次 PTY 退出都打文件系统），修复目录后需重启
或等 M2 的 reconcile。

## 13. 实施顺序（按垂直切片）

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| **M1** | incidents store（schema + immutable triggers + `insertIncident` 幂等 API + 容量上限）+ `onPtyExit` crash-only 接入（快照在清理前） + 最小 CLI `list/show/decide/prune --dry-run` | 重复/并发写只落一条；UPDATE/DELETE 被拒；迁移幂等；杀掉本机 agent → 一条 crash + 可读可 triage |
| M2 | 影子 NDJSON（每条 flush）+ 启动 reconcile + `incident report` + 读模型/IPC | 强杀主进程后重启能补回 crash 记录；重复重放不产生重复行 |
| M3 | `no_progress`：等待声明字段 + 判定函数 + 先灰度只记年龄 | 伪造成停滞 → 一条；有等待声明 → 零条 |
| M4 | `tool_error` 聚簇 + 每日摘要 automation | 同 code 达阈值 → 一条；摘要计数与 DB 一致 |
| M5 | acceptance 声明 + 可见停点（`acceptance_pending`） | 不满足 → incident + 可见停点；dispatch 不被静默悬挂 |
| M6 | automations mining + triage 候选 | 产出决策、无 `confirmed`、有界停止 |
| M7 | 远端 mirror / 多机聚合 / UI | 每台宿主本地可查；缺口可见 |

每步独立提交、独立测试；不合并成大包。M1 的取舍：**先不做** 影子、停滞、acceptance、UI、远端——
它们的噪声或复杂度会在首版把系统名声打坏。

## 14. 上游 patch 卫生（目标，不是验收口径）

原定“改点 ≤5、重放 ≤20 分钟”不现实（评审结论）——真实触点还包括 store 初始化/宿主分区、
CLI handler/spec/help/format 与 manifest drift 测试、acceptance 表迁移、preload/IPC、shared 类型、
测试。因此改成**按里程碑给出 patch 预算**的卫生指标：

| 里程碑 | 允许的生产代码改点 |
| --- | --- |
| **M1** | 1 处事实写点（`onPtyExit`，单个 `recordPtyExitIncident(...)` 调用）+ 1 处 store 初始化/注册 + CLI manifest + 新文件 |
| M2 | 同上 + 启动 reconcile 挂载点（1 处） |
| M3 | 状态应用路径 1 处（停滞判定调用） |
| M4 | tool 事件解析 1 处 + automation 模板（无代码） |
| M5 | `dispatch-completion.ts` 1 处（串行前置检查，不在事务内跑命令） + 新表迁移 |

**最高风险改点是 `onPtyExit`**：它是高 churn 的生命周期函数，含 authority / mobile surface /
liveness verdict / dispatch failure 多条顺序约束。因此接线必须是一个函数调用，参数在清理前一次性
收集，函数内部不得反查将被清掉的 map。

“重放时间”作为观察值记录（每个里程碑完成时实测一次），不作为开工前提。


## 15. 工程前提

1. worktree cone 需要 `orca/src`（约 72 MB 的目标子集：`src/main/runtime`、`agent-hooks`、
   `observability`、`sqlite`、`git`、`persistence`、`src/cli`、`src/shared`、`src/preload`、`orca/docs`、`orca/config`）。
2. vitest 需要 `node_modules`（约 1.7 GB）：在仓库根 `orca.yaml` 里声明
   `worktree.sharedDirectories: ["orca/node_modules"]` 共享一份安装，
   而不是每个 worktree 各装一遍（实现见 `src/main/git/worktree-shared-directories.ts`）。
   当前仓库只有 `orca/orca.yaml`，作用于 `orca/` 子目录，不覆盖仓库根的新 worktree。
3. 测试按 AGENTS 的批次纪律：`config/vitest.config.ts`、小批次、`--maxWorkers=2`。

## 16. 非目标与红线

- 不重放 `unknown` / `needs_reconcile`；incident 的产出不授予重试、重启、部署、合并权限。
- 不让写入点做判定；不让执行者给自己的验收签字。
- 不把 `unknown` 归一化为失败；不伪造 `confirmed`。
- 不在客户端记录远程宿主的事故；不在 renderer 侧做判定。
- evidence 不存正文、不过 redactor 不落盘。
- 未与 Run 归档对账的记录不得标 durable（沿用既有证据分级语义）。

## 17. 状态表（orca 侧）

| # | 能力 | 状态 | 依据 |
| --- | --- | --- | --- |
| 1 | PTY 退出原因分类 | 已实现 | `src/shared/terminal-exit-cause.ts` |
| 2 | PTY 退出汇聚点（含清理前取 paneKey） | 已实现 | `src/main/runtime/orca-runtime-on-pty-exit.ts` |
| 3 | 状态归一化单 ingress | 已实现 | `server-state.ts`（abstract + ingress 注释）、`server-status-update.ts`（实现） |
| 4 | 状态时间戳（停止窗口判定基础） | 已实现 | `server-status-application.ts` |
| 5 | 状态回收 | 已实现但**范围窄**（非通用 freshness tick） | `server-reaping.ts` |
| 6 | 转录轮询重试（**不是** readiness） | 已实现 | `server-status-retries.ts` |
| 7 | dispatch 结算/失败 | 已实现 | `db/dispatch-context/dispatch-completion.ts` |
| 8 | 升级分诊（仅 escalation 场景） | 已实现 | `orchestration/coordinator-escalation-triage.ts` |
| 9 | 不可变表触发器范式 | 已实现 | `db/schema/administrative-history-schema.ts` |
| 10 | NDJSON sink（**需显式 flush**） | 已实现 | `observability/local-file-sink.ts` |
| 11 | 脱敏（凭据/URL/env） | 已实现，**不含**路径/主机名 | `observability/redactor.ts` |
| 12 | 定期任务 | 已实现 | `automations`（`trigger: scheduled`） |
| 13 | 业务验收（acceptance） | **缺口** | orchestration 无字段/表 |
| 14 | 通用无进展判定器 + 等待声明 | **缺口** | 无 |
| 15 | incident store / 幂等键（含 epoch）/ 不可变触发器 / 容量上限 | **已实现（M1）** | §6、§11.5；提交 `916290df`+`4b92269c` |
| 16 | `onPtyExit` crash 写入（含 fallback epoch、owner-claim binding） | **已实现（M1）** | §7.1；提交 `640d285f`+`50124307` |
| 17 | shadow + 启动 reconcile（seq 水位、durable drop、有界可续、状态可见） | **已实现（M2）** | §11.2；提交 `d0004a4c`+`2e36f4a6`+`e1780f8f` |
| 18 | 停滞判定（语义事件时钟、等待声明、灰度写入） | **已实现（M3，默认不写）** | §7.2；提交 `ca786b41`+`88a3af71`+`a73dcccd`+`deae60ba` |
| 19 | tool_error 聚簇 | 设计中（M4） | §7.3 |
| 20 | 自报入口 `incident report`（含 evidence 上限、统一 sanitize、同键语义） | **已实现（M2）** | §7.5；提交 `65910ea8`+`7b96419c` |
| 21 | 最小 CLI（list/show/decide/prune，含容量双字段与 prune 可追溯 id） | **已实现（M1）** | §12；提交 `5a04946a`+`4b92269c` |
| 22 | 读模型/IPC/preload | **已实现（M2）** | §12；提交 `8a85931a` |
| 23 | 定期只读挖掘 + triage 候选 | 设计中（M6） | §10 |
| 24 | 远端 mirror / 多机聚合 | 缺口（M7） | §11.1 |
| 25 | 端到端 live 验收（真实崩溃 → incident → 关闭） | **缺口** | 无 |

`已实现` 只描述该能力在源码中存在，不表示已被本设计接通或经过 live 验收；v2 评审已纠正 3/4/5/6/10/11 的过高估计。

## 18. 上一轮评审意见的处置

| 评审意见 | v2 处置 |
| --- | --- |
| codex：`untriaged` / `no-qualified-judge` 是合法终态 | 采纳（§2.7、§5） |
| codex：incident 应是派生索引、不扩展事件源 | 采纳并加强：独立库 + 证据指针（§6） |
| codex：归档权威 + 指针 + 回读、`needs_archive` | 采纳（§16） |
| codex：单源 JSON + md 再生 | 采纳（§9，DB 为源、md 为视图） |
| codex：schema 脱敏、去"一故障类一 issue" | 采纳（§6.3、§9） |
| codex：T3 降权、字段去重 | 采纳（§5） |
| codex：归档保留期/删除权未决 | 保留为未决（§19） |
| trae：触发/确认/修复验收/关闭四权分离 | 采纳，落为 T1–T3 + R1/R2（§5） |
| trae：四层硬闸（触发/提案/审查/合并） | 采纳，修复侧只到"提案"，其余回到既有授权（§10） |
| trae：复合聚类指纹、单次高危直通 | 部分采纳：指纹列 + 索引，高危直通放 §7.1（crash 立即进候选） |
| trae：v1 精确指纹 | 采纳（唯一键 + 指纹聚类） |
| trae：归档一致性/单源写者 | 采纳并被 v2 简化：DB 单源、md 派生（§6、§9） |
| trae：「必须产出代码 guardrail」放宽 | 采纳（"不允许无声关闭"，§16、§19） |
| codex/trae：不要造费用账本 | 采纳（§10 只记挖掘轮的 token/耗时，不新建账本） |
| v1 的 Python 适配层实现顺序 | **作废**，由 §13 替换 |

## 18.1 v2 第二轮评审（TS 方向）的处置

| 评审意见（codex-ark / trae） | 处置 |
| --- | --- |
| 事实过高估计：`server-state.ts` 只是声明、retries 不是 readiness、reaping 范围窄、sink 是缓冲不是 WAL、redactor 不盖路径、CLI 不是一行 | **全部采纳**，§4 与 §17 逐行改写 |
| 幂等键缺 epoch（停滞二窗口被吞、acceptance 多规则互盖） | **采纳**，新增 §6.2.1 + 四行反例表 |
| acceptance 失败不改状态 = 静默悬挂 | **采纳**，改为必须停在可见停点 `acceptance_pending`（§8），且禁止在 lifecycle 事务内跑命令 |
| shadow 需每条 flush、只能算 best-effort | **采纳**（§11.2，含剩余丢失窗口清单） |
| M1 太大，应先做“本机 crash + 最小 CLI”垂直切片 | **采纳**，§13 重排为 M1–M7，M1 包含 CLI 与容量 |
| “改点 ≤5 / 重放 ≤20 分钟”不现实 | **采纳**，改为按里程碑的 patch 预算 + 实测重放时间（§14） |
| 阈值太激进（15 分钟 / 3 次 / 2 条） | **采纳**，改为 45 分钟 / 5 次每 10 分钟 / 7 天 3 条，并标为待拍板 |
| 无人看 = 等于没做；需要最小人机回路 | **采纳**，§12 增加 list/show/decide/prune 与每日摘要，M1 验收写明运维可用 |
| 容量/保留/删除权 | **采纳**，新增 §11.5 |
| 远端首版只做本机但必须显式标记覆盖缺口 | **采纳**（§11.1、§12） |
| 最高 rebase 风险是 `onPtyExit`，应做单调用 + 清理前取快照 | **采纳**（§7.1、§14） |
| trae：两周版砍掉 acceptance / no_progress / tool_error / mining / UI / 远端 | **采纳**为 M1 范围（§13） |
| codex：acceptance 不应改变“运行失败”语义但必须可见 | 采纳（§8 `acceptance_pending`） |

未采纳/降级：

- “不要把影子当唯一保证”不是反对做，而是降级表述——本文保留影子但明确它只提供 replay hints。
- 不需要“再冻结一份 exit cause 分类”：已有一等 union。

## 19. 决策与未决

### 19.1 已拍板（2026-11-12）

| 项 | 决定 |
| --- | --- |
| 阈值默认值 | 采纳 §7.2 / §7.3 / §10 的提议值：停滞 **45 分钟** 且跨 ≥2 个观测周期；工具错误 **5 次 / 10 分钟**，高危错误单次直通；聚类候选 **7 天 3 条且 ≥2 个 source_id** |
| `decide` 的 actor 可信性 | **不加身份校验**；`--actor` 由调用方自报，仅用于留痕，不当作权限。`confirmed` 仍要求显式传入 `--actor`（不默认填充） |
| 远程捕获范围 | **只做本机**；SSH/WSL 不写 incident，读模型固定输出 `remote_incident_capture: unsupported`；M7 暂不做 |

这三条确定后，M1（§13）可开工；不加身份校验意味着 incident 的"关闭"不具备审计强度，不得用于对外声称验收完成。

### 19.2 未决

1. R1 triage owner 的指定方式与配额（人 / 独立会话 / 轮值）；
2. 保留期与删除权：50k / 500MB / 90 天是否需要按宿主/团队区分；
3. acceptance 由主进程执行还是收 worker 回执 + 复跑（信任模型）；
4. “语义错但门禁全过”是否长期作为非目标；
5. `acceptance_pending` 停点的 owner 是谁，超时后如何升级。

## 19.3 M1 实施与评审记录（2026-11-13）

| 项 | 内容 |
| --- | --- |
| 提交 | `916290df`（store/key/render）、`640d285f`（onPtyExit）、`5a04946a`（CLI）、`50124307`（C1/C2）、`4b92269c`（C3/C4/C5） |
| 规模 | 31 文件 / +4927 / −1（`orca/` 内） |
| 评审 | codex-ark、trae 各两轮；最终共识文件 `issue-sedimentation.consensus-*.md`，两份均 `VERDICT: AGREE`，无反对项 |
| 合并必改（已完成） | C1 fallback epoch、C2 owner-claim binding、C3 容量双字段与众数、C4 只读旁文件安全、C5 prune 可追溯 id |
| 测试（外层复跑） | `src/main/incidents`：7 files / **80 tests**；CLI + runtime：4 files / **42 tests** |
| 评审发现的真实缺陷 | 普通只读打开 WAL 库会**创建** 0 字节 `-wal` 与 32KB `-shm`（`list` 在悄悄长文件）；已改为无 `-wal` 时用 `immutable=1` |
| 仍未验证 | 无 live 桌面/真实 killed PTY 验证；`skill-guide-cli-parity` 因 `orca/skill-guides` 不在 cone 未跑；cone 外 `tsc` 既有 error 未清 |

## 19.4 M2 实施与评审记录（2026-11-13）

| 项 | 内容 |
| --- | --- |
| 提交（首版） | `d0004a4c` shadow+replay、`65910ea8` report、`8a85931a` 读模型/IPC、`d77891b6` 指针结论 |
| 提交（评审修复） | `2e36f4a6` seq 水位 + durable drop + 有界 replay（C1/C3/C6）、`e1780f8f` replay 状态进覆盖缺口（C4）、`7b96419c` evidence 边界与同键语义（C2/C5） |
| 首轮评审结论 | **两份均 `BLOCK`**（理由一致：轮转水位漏放、replay 绕过 evidence 脱敏、容量拒收挡住后续 crash、replay 状态对运维不可见） |
| 共识轮 | codex-ark `AGREE-WITH-EDITS`、trae `AGREE`；C1 一致选“单调 seq 水位”而非文件身份指纹 |
| 修复要点 | shadow 体 `v: 2` 带 `seq`；水位 `lastSeq` 扫全族；容量拒收写 durable dropped 后继续；`shadowReplay` 进 CLI/IPC；evidence 统一 sanitize（含 `repro`）、单文件 64 MiB 上限；replay 有界可续 |
| 测试（外层复跑） | `src/main/incidents` + `src/main/startup`：85 files（83 passed / 2 skipped）/ **753 passed / 10 skipped**；CLI+IPC+preload：4 files / **43 passed** |
| 仍未验证 | 无 live 强杀→重启演练；shadow 轮转本身只做单测未做 10MB 实测；多进程写影子交错未压测；IPC 仅 mock `ipcMain`；renderer 白名单留到有 UI 时 |

## 19.5 M3 实施与评审记录（2026-11-13）

| 项 | 内容 |
| --- | --- |
| 提交（首版） | `ca786b41` 等待声明 + 判定、`88a3af71` 采样器/`stalls`/`wait`/灰度写入 |
| 提交（评审修复） | `a73dcccd` 语义事件时钟 + `buildIncidentKey` + coverage 错误可见、`deae60ba` `--clear` 互斥与灰度文案 |
| 首轮评审 | codex-ark **BLOCK**（要求改年龄口径）、trae **APPROVE-WITH-CHANGES**（允许先改文案）；共识轮两份 **AGREE**，一致把 M3-C1 升级为实现修复 |
| 分歧与收敛 | 分歧只在"改口径还是改标签"；我提出 PTY 字节不可作活动源（TUI spinner），最终三方统一为 `lastSemanticEventAt` |
| 修复要点 | 年龄改用语义事件时钟 + `state_fallback` 标记；reason 改 `no_event_for_threshold`；字段改 `wouldWriteIfEnabled`；`status_stall` 走 `buildIncidentKey`（非法 key 计 `stall_key_rejected`）；sampler errors 进 coverage；`--clear` 互斥且整 pane |
| 测试（外层复跑） | incidents + startup + CLI/IPC/preload：92 files（90 passed / 2 skipped）/ **833 passed / 10 skipped** |
| 仍未验证 | 真实 60s interval tick、DB busy/磁盘满注入未做；默认 off 的灰度在生产环境没有样本基线 |

## 20. 本轮验收口径（设计阶段）

- 本文进 `swarm/docs/design/`，方向变更、写入点、store、acceptance、硬问题、实施顺序、patch
  成本、工程前提齐备；§4/§17 的每条事实引用已经两轮评审逐项核对，剩余不一致只能由源码再核。
- 两轮评审的采纳/拒绝逐条记录在 §18 与 §18.1，未采纳项给出理由。
- §4 与 §17 的每条都标依据；`已实现` 不等于已接通或已验收。
- 未改动任何 `.py`/`.js`/`.ts`，未跑测试，未启动服务或 agent，未部署，未改任何既有 Run。
- cone 新增 `orca/src` 子集与 `swarm/tests` 等只读检出，不改变 Orca 的 sparse 绑定元数据。
