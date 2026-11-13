# 端到端示例（v2，按已落地实现写）

- 配套：[../issue-sedimentation.md](../issue-sedimentation.md)、[README](README.md)
- 状态：**虚构示例**。所有 `inc_…` / `pane-…` / `disp-…` 均为虚构标识符，不含真实 Run/Task/Dispatch/
  终端 ID、主机名、私有路径或 session 原文。
- 标注：`[已实现]` 当前代码有该行为；`[灰度]` 实现存在但默认不写；`[缺口]` 尚未实现。

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

```console
$ orca incident list --status untriaged
Coverage: remote_incident_capture=unsupported  capacity_latch_set=false  currently_limited=false
          shadow: lastSeq=0 incomplete=false
14:02  crash  pi  issue-sediment  signaled(9)  untriaged  inc_example01

$ orca incident show inc_example01 --md
# inc_example01 · crash
退出原因  signaled(9)
unknown   未记录证据指针：PTY 拆除时拿不到 transcript 路径（§7.1 禁止反查被清理状态）
动作      watch / duplicate / invalid / needs_archive / confirmed（confirmed 需显式 actor+理由）
```

## 3. 人工分流 `[已实现]`

```console
$ orca incident decide inc_example01 --to watch --actor alice --reason "等同类复现再定"
```

决策是**追加**的：`incident_decisions` 多一行，`incidents` 行本身不变（触发器拒 UPDATE）。

## 4. 一周后聚类 `[已实现]`

```console
$ orca incident mine --since 7d
Candidates (scan 4,812 rows · 38ms)
 12  crash/signaled · 4 stable sources (3 panes / 2 worktrees)     [候选]
  8  tool_error/non_zero_exit · 2 sessions                          [候选·低信息]
  2  acceptance_failed · single_entity_recurrence                   [不作候选]
```

"来源"按**实体**数（pane / session / dispatch），不是按 `source_id` 的 epoch 数 —— 否则同一 pane
停顿三次就会被读成"跨源复现"。

## 5. 分流建议（默认 dry-run）`[已实现]`

```console
$ orca incident mine --since 7d --apply --target watch --actor miner
skipped_already_target  inc_example01
appended watch          inc_example02 · inc_example03
```

`--apply` 必须显式 `--target`，且**只能**从当前 `untriaged` 出发：候选生成之后如果有人先把它设成
`confirmed`，miner 会得到 `skipped_status_changed` 而不是覆盖人的判断。

## 6. 起草防复发项（本轮仍是人做）`[缺口]`

设计上每条已确认的故障类最终要产出一个 guardrail（测试/检查器/规则条目），目前 `mine` 只出候选，
不提草案、不开工单。这一步决定 M7 之后是否补。

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

- **本地缺口**（shadow replay incomplete / 容量闸 latch / 扫描截断）→ 实心琥珀；
- **远端缺口**（某台被监控的宿主 `not_probed` 或 `unsynced > 0`）→ 只有次级描边，数字与本地 tone 不变；
- **`untriaged = 0` 但存在缺口** → 仍显示标记，只是不显示数字（"0"会被读成"没事"）；
- **计数拉不到** → `unavailable`；超过 10 分钟未更新 → `stale`；两种都画 muted 标记，不与"无事故"同形。

远端 mirror 只做搬运，不做判定：三态 `unsupported` / `not_probed` / `mirrored`，游标只推进到已投递的
seq，origin 省略区间必须带 gap reason，否则 `unexplained_gap_*` 停下并保留游标。

## 9. 灰度中的两条判据（默认不写）`[灰度]`

```console
$ orca incident stalls          # 有语义事件就不再算停滞；ageBasis=state_fallback 时明示退化
$ orca incident tool-errors     # 结构化高危才单次直通；文本命中最多进 non_zero_exit/unknown
```

两者都默认 off（`INCIDENT_STALL_WRITE` / `INCIDENT_TOOL_ERROR_WRITE` 仅 `on` 生效），所以上面这些
观察**不会**自动变成 incident —— 打开写入前要先看这两张表在真实负载上的比例。

## 10. 这个示例**不**代表的事

- 不代表已经 live 验收：本项目至今没有"真实桌面进程被杀 → 重启 → 记录仍在"的端到端证据。
- 不代表远端可捕获：mirror 只做到 fake host；没有任何真实远端链路的证据，`list` 的 `remote_incident_capture` 仍可能读到 `unsupported`/`not_probed`。
- 不代表 evidence 完整：crash 记录当前 `pointers: []`（见 §7.1）。
- 不代表 UI 已验收：只有组件测试，没有真实窗口截图或 e2e。
