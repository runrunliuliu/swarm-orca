VERDICT: APPROVE-WITH-CHANGES

结论：M3 可以进入 M4，但前提是先补三个小口径/可见性修复；不要打开 `INCIDENT_STALL_WRITE=on` 给真实运维使用，直到灰度样本证明不会一片红。当前默认 off 的灰度链路和 CLI 可读面成立，测试通过。

## 核对与测试

- 读了 M3 brief、v2.4 设计 §7.2、§11.4、§13 M3、§14、§6.2.1。
- 核对提交：`ca786b41`（wait + predicate）、`88a3af71`（sampler/CLI/write switch）。
- 必跑测试：
  - `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/incidents src/main/startup src/cli/handlers/incident.test.ts src/cli/incident-format.test.ts --maxWorkers=2`
  - 结果：88 files passed / 2 skipped；815 tests passed / 10 skipped。

## Findings

1. `orca incident stalls` 会把健康长回合标成 `wouldStall=yes`。
   判定年龄来自 `now - max(stateStartedAt, turnStartedAt)`，持续 tool output / terminal output 不会推进这个口径。一个 45m+ 的单回合如果仍是 `working`，第二次采样后会显示 `stalled`。默认 off 避免了误写 incident，但值班看到表格可能理解成“真卡住”。需要改文案或字段名，把它说成 “state_age_exceeds_threshold / would_write_if_enabled”，不是事实上的 stuck。

2. sampler 错误计数写了 meta，但 coverage/CLI/IPC 不显示。
   timer catch 里 bump `STALL_SAMPLER_ERRORS_META` / `STALL_LAST_SAMPLER_ERROR_META`；`readStallSampleCoverage` 不读取它们，`formatStallSampleNote` 也不显示。DB 锁、磁盘满、sample 写入失败后，值班只能看到旧样本或无样本，可能误以为健康。

3. no_progress 写入手工拼 `source_id`，绕开 `buildIncidentKey`。
   `buildStallIncidentRecord` 使用 `${paneKey}:${stateStartedAt}`，没有复用 §6.2.1 的 key builder / pane key 校验。当前 paneKey 大概率来自稳定来源，但 M1 已经踩过“手工 epoch 字符串不被 key 接受”的坑；这里应收敛到同一 key helper。

4. `incident wait --clear` 与 `--reason/--until` 不互斥。
   代码中 `--clear` 分支先返回，附带的 reason/until 被静默忽略。不是数据损坏，但 CLI 语义不够硬，容易让操作者以为重新声明同时完成了。

## 值班会看到什么

- `orca incident stalls` 显示最后一次 sample：pane、state、age、threshold、wouldStall、reason、declaredWait，以及 “Writing incidents: off”。
- 健康长任务上会出现 `wouldStall=yes / reason=stalled`，尤其长构建、长训练、单回合多工具输出但状态未变的任务。
- 目前只能靠值班上下文区分：是否预期长跑、是否应先 `incident wait --reason ... --until ...`、是否有外部 job/log 活动。CLI 本身不显示 last output/tool activity。
- 这是灰度期可接受噪声，但必须改口径/文案；否则一打开写入就会把“长回合正常工作”误导成事故。

## 真实卡死路径

- T+0：agent 保持 `working`，无状态/turn epoch 变化。
- T+45m：达到 age 阈值；若这是该 epoch 的第 1 次独立 sample，reason 仍可能是 `insufficient_cycles`。
- T+46m 左右：第 2 次 sample 后 `wouldStall=true`。
- 默认 off：运维需运行 `orca incident stalls` 才能读到；不会自动生成 incident。
- 写入 on：同一次 sample 调 `writeStallIncident`，生成 `no_progress`，之后 `orca incident list/show` 可读。
- 最可能被忽略的一步：没人定期看 `stalls` 灰度面，或看到 `wouldStall=yes` 后没补 wait declaration / 没决定是否启用写入。

## 等待声明可用性

- 声明依赖人/agent 主动调用 `orca incident wait --terminal ... --reason ... [--until ...]`；系统无法自动知道“我正在正常等待”。
- declaration 绑定当前 sample 的 pane epoch，respawn 不会继承，这是对的。
- `--until` 过期后 `listActiveWaits` 忽略，sampler 会 prune；不会“以为还在等”。
- 无 deadline 的声明会一直有效直到 clear；这是运维便利，但也可能掩盖真卡死。文档/CLI 应建议长任务使用 `--until`。

## 采样成本与失败模式

- 成本：每 60s 一次，读取 hook snapshot，替换 `incident_stall_samples`，写若干 meta；O(panes)，默认不写 incidents。长期成本可接受。
- DB 锁/磁盘满/写 sample 失败：timer catch 不让进程崩，但错误目前不进入 coverage，可能静默陈旧。
- store 不可用：`sampleOnce` 返回 null，并每 5 分钟重试 open；不会打爆磁盘，但没有持久样本。
- 重复启动：`startStallSampler` idempotent，`unref()` 已调用；测试覆盖 start/stop。

## 灰度与批量写入

- 默认 off 有测试：判定 `stalled` 但 incident count 仍为 0。
- 打开后不会“写历史 DB 里的所有旧 pane”，只按当前 sample 写；但如果当时许多 pane 已 `wouldStall=true`，第二个周期后会批量写多条 no_progress。
- 因此 M4 前可以继续灰度，但不应在没有样本基线的环境里默认打开写入。

## 9 个风险面分类

- 必须改：1 文案/字段口径避免把健康长回合显示成真 stuck；4 sampler error 进入 coverage；5 stall source_id 复用 key helper；8 `--clear` 与声明 flags 互斥。
- 补测试：1 长回合 wouldStall 文案/JSON 形状；4 sampler DB write failure 后 coverage 显示 error；5 非规范 paneKey 不写或明确拒绝；8 `--clear --until` 拒绝。
- 可接受写文档：2 cycles 计数为进程内观测，重启后重新计数；3 无 deadline wait 需人工 clear；6 默认 off 灰度；7 写入复用 shadow/store；9 interval 测试用 fake/直接调用为主，未做真实 60s。

## 最小必改集（≤5）

1. 把 `stalls` 输出和 JSON 字段改成灰度口径：`would_write_if_enabled` / `state_age_exceeds_threshold`，并说明不等于语义卡死。
2. 将 stall sampler errors / last error 暴露到 CLI + IPC coverage。
3. `status_stall` 写入改走 `buildIncidentKey({kind:'status_stall', ...})` 或同一校验函数；非法 key 不写并计数。
4. CLI 拒绝 `incident wait --clear` 与 `--reason/--until/--actor` 混用。
5. 文档和 help 建议 wait declaration 默认带 `--until`，无 deadline 只用于人工明确的长等待。
