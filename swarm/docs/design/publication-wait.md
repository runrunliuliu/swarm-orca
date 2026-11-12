# 发布等待：事件提前唤醒 + 常挂轮询兜底（已实现）

状态：**已实现、已过离线门禁与双评审（2026-11-12）**。同主机实测有收益，跨客户端丢事件率**未实测**，
按"最坏退回兜底"设计。本文只描述已实现行为与验收口径，**不构成**部署、重启、放宽 gate 或改变启动窗口的授权；
握手协议语义仍以 [strict 启动](../../coordinator-strict-start.md) 与
[strict bootstrap 协议](../../strict-bootstrap-protocol.md) 为准，冲突时以协议为准。

关联：实现 `swarm/publication_wait.py`；调用点 `swarm/coordinator_strict_start.py`
（`wait_and_create` 的 `gate-ready.json` 等待）与 `swarm/coordinator_strict_delivery.py`
（`wait_for_config` 的 `strict-config-ready.json` 等待）；测试 `tests/core/test_publication_wait.py`、
`tests/coordinator/test_coordinator_strict_{start,delivery}.py`、夹具
`tests/publication_wait_fixture.py`。

## 0. 一页结论

1. 两个严格启动等待原本 `time.sleep(0.25)` 轮询一个由**另一个角色**发布的文件。现在改为：目标文件出现时
   由 inotify 事件**提前唤醒**，同时轮询兜底常挂。
2. 铁律：**事件只能缩短等待，不能定义等待**。deadline、"重新检查目标"和 `lstat` 语义仍是判据；
   删掉轮询或让事件成为完成条件都是错的。
3. 实测（本机 NFSv4.1 挂载，同客户端）：发布→检出 **252 ms → 3.6 ms**，探测次数 **9 → 2**（发布晚 2 s 时）。
   每次等待省 ~100 ms（相位均匀时上限 250 ms）；一次严格启动有两个这种等待，端到端 **0.2–0.5 s 量级**，
   不是启动墙钟的大头。
4. 代价：**有 watcher 但事件丢失**时兜底 1.5 s/次，比旧 250 ms 慢；因此兜底周期必须进日志并由部署机观测。
   **inotify 打不开**时完全等于改动前（0.25 s 节奏、零回归、零收益）。
5. 未做：跨客户端丢事件率、端到端"旧/新"启动墙钟对比、部署机真实观测数据。

## 1. 不变量（改动或复核时先对照这里）

| # | 不变量 | 为什么 |
| --- | --- | --- |
| I1 | 事件只能缩短等待；循环仍以 `require(deadline)` + 重新 `lstat`/`file_ref` 为判据 | 跨客户端可能永不到事件；把完成权交给事件等于把无界等待引入启动路径 |
| I2 | 轮询兜底常挂；兜底周期 = 该情形下的最坏交付延迟，且写入启动日志 | 没被打印出来的最坏延迟不算已知常数 |
| I3 | `watch()` 返回 None 时等于改动前的节奏（250 ms/次），不得变慢 | "inotify 不可用"必须是降级，不是回归 |
| I4 | `lstat` 语义保留：悬空符号链接、不完整 JSON、拒绝访问**停止**等待，不换路径重扫 | 这些是"发布坏了"，不是"还没发布"，不能用兜底把失败变成慢 |
| I5 | 每个等待只创建一次 watcher，`try/finally` 里记录并关闭 | 每轮新建 = fd 泄漏 + 每轮丢事件窗口 |
| I6 | 诊断只输出 `kind`/`inotify`/`events`/`timeouts`/`fallback_seconds`，不放路径、不放载荷，也不改返回 JSON | 与 `observation_budget` 同一原则：诊断不是回执 |

## 2. 实现

- `publication_wait.Watcher`：一个目录+目标名 watch；`wait(seconds)` 在**总预算**内消费无关事件，
  只有目标名出现才返回 True，预算耗尽返回 False 并计 `timeouts`（不返回 "any event"，否则调用方会空转）。
- `watch(target)`：watch `Path(target).parent`；inotify 打不开返回 None（不抛）。
- `idle(watcher, seconds)`：有 watcher 走 `wait`；无 watcher 走 `time.sleep(min(seconds, POLL_SECONDS))`。
- 周期常量：`POLL_SECONDS = 0.25`（改动前节奏，仅用于无 watcher 的降级路径）；
  `FALLBACK_SECONDS = 1.5`（有 watcher 时的单次上界 = 事件丢失时的最坏交付延迟）。
- 调用点形态（两处一致）：

  ```text
  watcher = publication_wait.watch(target)          # 循环外一次
  try:
      while True:
          require(monotonic < stop and now() < deadline)   # 判据顺序不变
          try: <探测目标>
          except FileNotFoundError:
              publication_wait.idle(watcher, min(FALLBACK, max(0, stop - monotonic())))
              continue
          break
  finally:
      publication_wait.log(<kind>, watcher); watcher.close() if watcher
  ```

- **未接线**：`wait_and_create` 的第二个循环（创建整秒对齐）仍是 `time.sleep(min(0.25, ...))`。
  它等的是"本地时钟跨过整秒"，不是发布，事件无从缩短，属同族的另一个优化项。

## 3. 部署机怎么读这一行

每次等待在 stderr 打印一行（stdout 的 JSON 结果与 `created.json` **不变**）：

```json
{"event": "publication_wait", "kind": "start_gate", "inotify": true, "events": 3, "timeouts": 0, "fallback_seconds": 1.5}
```

| 读到的 | 含义 | 结论 |
| --- | --- | --- |
| `inotify: false`，`fallback_seconds: 0.25` | 该主机打不开 inotify，等待等同改动前 | 功能无回归；排查挂载/权限，不必回滚 |
| `inotify: true`，`events ≥ 1`，`timeouts: 0` | 事件生效，检出在毫秒级 | 收益成立 |
| `inotify: true`，`timeouts` 持续增长而 `events` 不涨 | 事件没到（跨客户端或文件系统） | 真实最坏延迟 = `fallback_seconds`（1.5 s） |
| `timeouts: 0` 且 `events: 0` | 等待前目标已存在，一次也没等 | 正常，启动很快 |

`kind` 取值：`start_gate`（`gate-ready.json`）、`config_publication`（`strict-config-ready.json`）。

## 4. 实测（2026-11-12，本机 NFSv4.1 挂载，同客户端）

| 探针 | 结果 |
| --- | --- |
| 原语往返，40 次发布 | 40/40 检出，发布开始→唤醒 **1.50–2.13 ms**（中位 1.63），漏检 0 |
| 发布晚 2 s，新旧循环各 5 次 | 旧：检出 **252.2 ms**、**9 次探测**；新：**3.6 ms**、**2 次探测** |
| 均匀相位配对 40 组（相位 5–245 ms） | 每次等待节省 mean **99 ms** / median 95 ms / max 240 ms |
| 一次严格启动 | 两个这种等待 → 端到端 0.2–0.5 s 量级（**外推，未测**） |

探测次数的意义不只是时间：每次探测都是一次 NAS 上的 open+读+hash，走 Coordinator 启动的关键路径。
等 30 s 的门在旧实现下约 121 次探测，新实现 2 次。

## 5. 风险与已接受的代价

- **R1 事件丢失比改动前慢**。有 watcher 但事件不来时，单次上界 1.5 s，是旧 250 ms 的 6 倍。接受理由：兜底若
  仍取 250 ms，则事件生效时的收益（250 ms → 毫秒）在"每次等待至少 250 ms"的前提下被抵消，等于不做；
  而丢事件率目前无实测数据。判定方式改由部署机日志（§3）承担。
- **R2 跨客户端未实测**。三条测量路径在开发机被挡住（无第二 NFS 客户端/无 mount 权限），记录在计划材料里。
- **R3 夹具会骗人（给后来者的警告）**。这两个等待的测试夹具原本把"到点发布"挂在**被 patch 的 `time.sleep`**
  上。真实等待不再调用 `sleep` 后，夹具的发布者根本不运行，症状是 `events=0`、每轮只走兜底、模块挂到超时——
  很容易被误判成"watch 挂错路径"。现在的做法：`tests/publication_wait_fixture.PollingWatcher` 让每次等待
  花掉**一个旧 250 ms 周期**并报告"无事件"，因此夹具时钟推进与断言关系完全不变；真实 watcher 仍由
  `core.test_publication_wait` 和每个严格模块的**一个**事件测试端到端覆盖。
- **R4 诊断行是 stderr**。若日志采集只收 stdout，这一行会丢；与 `observation_budget` 相同通道、相同取舍。

## 6. 门禁与已执行证据

```bash
sh tests/run_offline.sh --modules core.test_publication_wait \
    coordinator.test_coordinator_strict_start coordinator.test_coordinator_strict_delivery \
    core.test_offline_baseline      # 4/4 modules, jobs 4, 117 tests, TARGETED OK
sh tests/run_blast.sh --range <pin> --jobs 4   # 整项 diff：105/105 modules, 2689 tests, 118.7 s, TARGETED OK
python3 -B generate_orientation.py --check     # exit 0（改了 .py 行号后必须重生成）
python3 -B generate_runbook.py --check         # exit 0
```

新增测试覆盖的正是上面的不变量：无 inotify 时的节奏（I3）、日志字段与"当前生效周期"一致（I2/I6）、
兜底周期范围（1–2 s）、真实 watcher 端到端唤醒（探测次数 + `timeouts == 0` + fd 已关）、
`watch -> None` 的降级路径。反向验证（mutation，未提交）：把 watch 指到错误路径 → 只有事件测试红，其余全绿；
把 watch 强制 None → 该模块 43/44 通过、0.54 s（只有事件测试按预期红）。

## 7. 非目标

不改 deadline/启动窗口/gate 语义；不删轮询；不把事件当完成条件；不动创建整秒对齐循环；
不做跨主机丢事件率测量；不承诺端到端启动墙钟的大幅改善——**这是单次等待的延迟与探测成本优化**。
