VERDICT: BLOCK

结论：M2 当前不能进入 M3。`incident report`、IPC/preload、启动挂载整体方向可用，测试也通过；但 shadow replay 是 M2 的核心承诺，当前存在轮转水位漏放、replay 绕过 evidence 脱敏、容量拒绝阻塞后续 crash 的长期运行问题。先修这些，再谈 M3 的 no_progress。

## 核对与测试

- 读了 M2 brief、v2.3 设计 §7.5、§11.2、§12、§13 M2、§14、§19.1。
- 核对提交：`d0004a4c`、`65910ea8`、`8a85931a`、`d77891b6`。
- 必跑测试：
  - `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/incidents src/main/startup --maxWorkers=2`
  - 结果：82 passed / 2 skipped files；738 passed / 10 skipped tests。
- 补跑 M2 交付面：
  - `src/cli/handlers/incident.test.ts src/main/ipc/incidents.test.ts src/preload/incident-bridge.test.ts --maxWorkers=2`
  - 结果：3 files / 28 tests passed。

## Blocking Findings

1. shadow watermark 用 basename + offset，轮转后同名文件换内容会漏放。
   `reconcileIncidentShadow` 用 `basename(file) === watermark.file` 找起点；sink 轮转会把新 base 继续命名为 `shadow.ndjson`。若水位是 `shadow.ndjson@N`，之后发生轮转，新 base 增长到 `>=N`，下次 replay 会从新文件 offset N 开始，跳过新 base 的前 N 字节；同时旧 base 已变成 `.1`，会被当作“水位之前的旧文件”跳过。现有测试只覆盖 “watermark file missing”，没有覆盖“同名文件被复用”。这会造成真实漏行。

2. shadow replay 可把未经 redactor 的 evidence 写进 DB。
   replay 直接 `incidentRecordFromShadowLine` -> `store.insertIncident(record)`；store 只 redacts `summary` 和 decision reason，`JSON.stringify(record.evidence)` 原样入库。`incident-report.ts` 的 `repro` 也只是 `slice(0, 2000)`，没有 redaction，虽然类型注释说 redacted on write。外部编辑 shadow 或 report `--repro` 都可能把 secret 写入 evidence/repro。

3. capacity-limited replay 会让后续 crash 行无限卡在同一个低优先级行后面。
   replay 遇到 `insertIncident` 不是 `inserted|duplicate` 就 `store_refused` 并停止，且不推进水位。若 shadow 中先有 `self_report/tool_error/no_progress` 因容量拒绝，后面跟着 crash，后续每次启动都会停在同一噪声行，crash 永远 replay 不到。失败计数会累积，但运维读模型看不到该 failure counter。

4. shadow reconcile failure 对运维不可见。
   `shadow_reconcile_failures` / `shadow_reconcile_last_error` 只写 meta，当前 CLI/IPC coverage 没有输出；`incident list` 可能显示 “No incidents recorded” 或正常列表，同时 replay 已经停在坏行、容量拒绝或读错误。长期运行会误导值班人员。

## 强杀 3 次 / 启动 3 次推演

- 无轮转、完整行：三次强杀产生三条 shadow 行；第一次启动按顺序 replay，insert 或 duplicate；水位推进到 EOF。第二、三次启动 replay 0 行，不会重复 DB row，也不会水位倒退。
- 强杀在 shadow 后、DB 前：第一次启动补写；若强杀在 replay insert 后、水位前，下一次启动只产生 duplicate，DB 唯一键兜住。
- 强杀产生无 `\n` 尾行：不消费、不推进水位；后续补齐后可 replay。
- 需要补的证据：强制轮转后 basename 复用的水位测试；replay 中途 crash 的 watermark/idempotency 测试；capacity-refused 行后仍能处理后续 crash 的测试。

## 故障模式

- 磁盘满：shadow write 失败返回 `shadow=failed` 或 writer diagnostics；DB insert/latch 也可能失败。PTY path 不抛，CLI report 可能失败；运维目前只能看命令输出/日志，list 不显示 shadow/write failure。
- userData 只读：runtime store open 失败或 insert 失败，startup reset 后仍会失败；`incident report` 会报 runtime/store error。不会阻断启动，但事故会丢。
- 影子文件外部编辑：不可解析/未知版本会停在坏行；可解析但恶意内容会 replay，且 evidence 未脱敏。
- 影子文件删除/外部轮转：删除导致可补记录丢失；轮转复用会触发上面的水位漏行；当前不会报警为覆盖缺口。
- DB 被删而 shadow 还在：新 DB 无水位，会从现有 shadow 族重放；仍在轮转窗口内的行可恢复，已被轮掉的行不可恢复。

## `incident report` 滥用面

- 重复上报：默认 source-id 带随机尾巴，能无限产生新行；固定 `--source-id` 才幂等。这是 T3 自报特性，但需要运维配合。
- evidence 数量：8 条上限合理，能挡 shell glob 爆炸。
- evidence 大小：没有单文件 size cap；会流式 hash，但可让 CLI 长时间读大文件。建议至少文档化，最好加默认大小软上限或确认 prompt。
- 路径泄露：pointer 存原始 path；body 不复制但路径本身可能含敏感项目名。应写进文档，或后续提供 path redaction/relative display。
- `repro`：当前未 redacted，是必须改代码的问题。

## 启动副作用

- `setImmediate` 不 gate ready foundation，同步 replay 不阻塞 `initializeReadyFoundation` 返回。
- 但 replay 自身在主线程同步读/parse 最多约 100MB shadow；冷启动后第一轮事件可能 jank。M2 应记录耗时或输出 summary，至少测试大 shadow 上界。
- headless/CI 无 userData 时返回 `no_user_data_path`，不抛；本次 required startup tests 通过。
- 多 profile：挂载使用 canonical userData path，各 profile 分库，方向正确。

## M2 后每日运维三件事

- `orca incident list --status untriaged --json`：看新增未处理事故与 coverage。
- `orca incident show <id> --md`：读 unknown boundary / evidence pointers / decisions。
- `orca incident decide <id> --to watch|needs_archive|invalid --reason "..."`
  或 `orca incident prune --dry-run --json`：处理状态或检查可清理项。

仍会误导的命令：`orca incident list`。它不显示 shadow reconcile failures；当 replay 卡住或影子被删时，输出可能让人误以为“没有事故”。

## 8 个风险面分类

- 必须改：1 轮转×水位；3 replay/evidence 脱敏；4 容量拒绝阻塞后续 crash；6/可见性部分：shadow reconcile failure 必须进入 coverage/CLI。
- 补测试：2 并发写读与尾行竞态；8 轮转复用、capacity-refused 后 crash、external edited shadow、repro redaction。
- 可接受并写文档：5 `--source-id` 幂等覆盖不同内容、evidence 路径隐私与大文件 hash 成本；6 启动 setImmediate 不 gate 但可能 jank；7 IPC actor `unspecified` 与无 renderer 白名单（M2 无 UI，通道窄）。

## 最小必改集（M2 内，M3 前）

1. 修 shadow watermark：绑定文件 identity（inode/dev/creation token）或改用每行 monotonic seq，补“同名文件轮转复用”回归。
2. 对 `IncidentEvidence` 做统一 sanitize/redact 后再入 DB/shadow/replay，至少覆盖 `repro` 与外部 shadow evidence。
3. replay 遇到 capacity-limited 低优先级行时不得永久挡住后续 crash；设计一个可审计的 skip/defer 策略并补测试。
4. 把 `shadow_reconcile_failures` / last error 暴露到 CLI/IPC coverage，使 `list` 能显示 replay 卡住/失败。
5. 补 M2 关键测试：轮转复用、水位不倒退、capacity-refused 后 crash、外部编辑 shadow、report repro secret。
