# 端到端示例（v3，按已落地实现写）

- 配套：[../issue-sedimentation.md](../issue-sedimentation.md)、[README](README.md)
- 状态：**虚构示例**。所有 `inc_…` / `pane-…` / `disp-…` 均为虚构标识符，不含真实 Run/Task/Dispatch/
  终端 ID、主机名、私有路径或 session 原文。
- 标注：`[已实现]` 当前代码有该行为；`[缺口]` 尚未实现（M8 删掉了默认不写的灰度写入，不再有 `[灰度]`）。

## 场景

一个 pi worker 在实施任务时被 OOM killer 杀掉；同一周内又有两个 turn 出现了同码的工具错误。
下面的每一步都是当前代码真实会做的事。

## 1. 进程死亡 → 一条 crash 记录 `[已实现]`

`onPtyExit` 在清理 PTY 状态**之前**收集快照，然后调一次 `recordPtyExitIncident(...)`：

```ts
recordPtyExitIncident({
  ptyId, incarnationId, paneKey, worktreeId,
  agentSessionId: null,                 // 退出时 PTY 记录里没有 session id，只有 claim digest
  agentIdentityDigest,
  exitCode: 137, exitCause: { kind: 'signaled', signal: 9 },
  hostExitConfirmed: true, providerExitObserved: true, surface: 'local',
  hasAgentBinding: true                 // 有 launch/foreground/paneKey/owner claim 任一
})
```

产生的行（示意）：

```json
{
  "id": "inc_example01",
  "source_kind": "pty_exit", "source_id": "inc-e8f1…", "facet": "exit",
  "class": "crash", "status": "untriaged",
  "exit_cause": "{\"kind\":\"signaled\",\"signal\":9}",
  "evidence": { "pointers": [], "unknownBoundaries": ["no transcript pointer at PTY teardown"] }
}
```

要点：`operator_close` 不写；`unknown` 只在 pane 曾有 agent 绑定时写；同一 incarnation 重复回调
只落一条（`UNIQUE(source_kind, source_id, facet)`）。

## 2. 运维看见它 `[已实现]`

`orca incident list` 是**人类视图**（`src/cli/incident-format.ts` 的 `formatIncidentList`）：列为
`ID / CLASS / STATUS / CREATED / CAUSE / WORKTREE`，有摘要就多一行缩进摘要，然后空行 + 三行覆盖信息
（`formatIncidentCoverage` / `formatShadowReplay` / `formatPaneClockNote`）。下面所有值虚构：

```console
$ orca incident list --status untriaged
Incidents (1 shown / 1 total, this host only):
ID                             CLASS           STATUS       CREATED               CAUSE                      WORKTREE
inc_example01                  crash           untriaged    2026-11-12T06:00:00.0 signaled(9)                wt-example
  OOM killer 杀掉 pi worker（虚构摘要）

Coverage: remote_incident_capture=unsupported  capacity_latch_set=false  currently_limited=false  rows=1/50000  bytes=48.0KB/500.0MB
Shadow replay: complete  last_seq=0  dropped=0  failures=0
Pane clock: last_sample=2026-11-12T06:00:00.000Z  panes=1  declared_waits=0
```

两处细节免得把它当成机器接缝：`CREATED` 列被 `pad(…, 21)` 截到 21 字符（所以上面是
`…T06:00:00.0`，不是完整 ISO）；而 `orca incident export --json` 的 NDJSON 行是**另一套**形状
（`meta` / `incident` / … 见 §4/§5），不是这个表格。

`orca incident show <id> --md` 是另一份派生渲染（`src/main/incidents/incident-render.ts`）：标题以
``# Incident `` 加反引号包住的 id 开头，接着是 class / status / created / host / source / fingerprint /
worktree / run-task-dispatch / agent session / pty incarnation 的逐行头部，然后 §1 摘要、§2 背景与预期、
§3 时间线、§4 机制分析、§5 未知边界、§6 证据与 pin、§7 防复发项、决策记录；未填的段落写“未填写”而不是猜。

## 3. 人工分流 `[已实现]`

```console
$ orca incident decide inc_example01 --to watch --actor alice --reason "等同类复现再定"
```

决策是**追加**的：`incident_decisions` 多一行，`incidents` 行本身不变（触发器拒 UPDATE）。

## 4. 一周后交给 agent 侧 triage `[已实现]`

聚类不在主进程里了：`incident mine` / `incident digest` 连同 `--apply` / `--target` 在 `7be087bc`（M8-1）
直接删除（没有别名，旧命令报"未知命令"）。机器接缝是一次只读 NDJSON export：

```console
$ orca incident export --since 7d --json > incidents.ndjson   # 只读，一行一条记录
$ head -1 incidents.ndjson    # meta：view=incident_triage_rows / exportVersion / coverage / toolProviders / mirror
$ tail -1 incidents.ndjson    # end：counts / total / truncated / dropped
```

记录只有五种：`meta` / `incident` / `pane_clock` / `tool_failure` / `end`；`--limit` 只截断流，
截断在 `end.truncated` 里显式声明（截断过的窗口不是总数）。把这份流交给
`swarm/skills/incident-triage/`（SKILL.md + contract.example.json + report-template.md），
由它按**稳定实体**聚类：

| sourceKind | 稳定键（先剥掉 epoch） |
| --- | --- |
| `status_stall` | `paneKey` |
| `tool_error` | `sessionId` + `toolName` +（`errorKind` / `exitCode`） |
| `acceptance` | `dispatchId` + 规则 id |
| `pty_exit` | agent session，退化到 worktree / run |

"来源"按**实体**数，不是按 `source_id` 里的 epoch 数——否则同一 pane 停顿三次就会被读成"跨源复现"。
报告必须写明 `view` / `exportVersion` / `since` / `coverage`、`end.truncated` 与 `rowsUsed`；
缺一项（或 `coverage` 显示 shadow replay 不完整 / 容量 latch）就不可当成完整窗口读。

## 5. 报告给建议，`decide` 仍由 R1 执行 `[已实现]`

M8 之后没有自动 apply：`--apply` / `--target` 随 `mine` 一起去掉，skill 只产出报告与命令建议。
报告里 "Proposed decisions" 一节每行的形式是
``<inc_id> | <to> | <why> | orca incident decide <inc_id> --to <to> --actor '<r1>' --reason '<why>'``，
R1 自己执行：

```console
$ orca incident decide inc_example02 --to watch --actor alice --reason "triage: crash/signaled, 3 rows / 2 entities in 7d"
```

`decide` 只追加一条 `incident_decisions`，`incidents` 行依旧不可改；`--to confirmed` 必须显式
`--actor`（自报，不校验），而 skill **从不**产出 `confirmed`，也不会自动写 `watch` / `duplicate`。
报告里 `durable=false` 或 `pointers=0` 的记录不能当成"证据已归档"引用。

## 6. 起草防复发项（本轮仍是人做）`[缺口]`

设计上每条已确认的故障类最终要产出一个 guardrail（测试/检查器/规则条目），目前 triage 只出报告与
`decide` 命令建议，不提草案、不开工单。这一步是否补仍未定。

## 7. 验收门（另一条独立路径）`[已实现，默认无声明]`

若该 dispatch 声明了 acceptance：

```console
$ orca incident acceptance declare --dispatch disp-example07a --rule tests \
    --worktree-root /path/to/worktree --cwd /path/to/worktree \
    --command npm --command test --expect-exit 0
```

结算前主进程在**事务之外**用 argv 跑这条命令（无 shell）；不满足 → 写 incident + `acceptance_pending`
停点，dispatch 保持 `dispatched`、worker_done 保持未读，`resolve --accept` 后由下一 tick 重新结算。
operator 若要绕过，必须显式 `--override-acceptance` 并留下 `acceptance_overridden` 证据。

## 8. 面包屑与远端视野（M7）`[已实现]`

活动栏的 `Incidents` 角标只消费主进程算好的数字与缺口判定：

- **本地缺口**（shadow replay incomplete / 容量闸 latch / 此刻正在拒收）→ 实心琥珀；
- **远端缺口**（某台被监控的宿主 `not_probed` 或 `unsynced > 0`）→ 只有次级描边，数字与本地 tone 不变；
- **`untriaged = 0` 但存在缺口** → 仍显示标记，只是不显示数字（"0"会被读成"没事"）；
- **计数拉不到** → `unavailable`；超过 10 分钟未更新 → `stale`；两种都画 muted 标记，不与"无事故"同形。

远端 mirror 只做搬运，不做判定：三态 `unsupported` / `not_probed` / `mirrored`，游标只推进到已投递的
seq，origin 省略区间必须带 gap reason，否则 `unexplained_gap_*` 停下并保留游标。

## 9. 两张事实视图（只读，不判定）`[已实现]`

```console
$ orca incident pane-clocks                  # 每个 pane 一行事实，无阈值、无 wouldWriteIfEnabled
$ orca incident tool-failures --since 7d     # provider 原样的 errorKind / exitCode，无码表、无窗口
```

两条都只读、都不写 incident：`pane-clocks` 打 `state / ageMs / ageBasis / observedAt / 声明`，
`ageBasis=state_fallback` 明示"这台宿主没报过语义事件时钟，年龄退回 `stateStartedAt`"；
`tool-failures` 没有 `INCIDENT_TOOL_ERROR_WRITE` 这类写开关，只有 provider 覆盖声明
（`Coverage: covered=…` 与 `Coverage gap: …`）和 `dropped` 计数——两者都在说"这里的数字是下限"。
所以**安静不等于没事故**：判据在 triage 那边；真认为是一条事故时，用
`orca incident report --class <class> --code <code>` 自报一条。

## 10. 这个示例**不**代表的事

- 不代表已经 live 验收：本项目至今没有"真实桌面进程被杀 → 重启 → 记录仍在"的端到端证据。
- 不代表远端可捕获：mirror 只做到 fake host；没有任何真实远端链路的证据，`list` 的 `remote_incident_capture` 仍可能读到 `unsupported`/`not_probed`。
- 不代表 evidence 完整：crash 记录当前 `pointers: []`（见 §7.1）。
- 不代表 UI 已验收：只有组件测试，没有真实窗口截图或 e2e。
