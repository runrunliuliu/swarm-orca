# M2 代码评审说明（评审者用，非设计正文）

- 分支：`issue-sediment`；基线 `2d52461d`（M1 + 文档）
- 被评提交：`d0004a4c`（shadow NDJSON + 启动 replay）→ `65910ea8`（`incident report`）→ `8a85931a`（读模型/IPC/preload）→ `d77891b6`（crash 指针结论）
- 规模：34 文件，+2605/−101；`orca/src/main/incidents/`、`orca/src/main/ipc/incidents*`、`orca/src/shared/incident-api-types.ts`、`orca/src/preload/*`、`orca/src/cli/*`、`orca/src/main/startup/main-process-ready-foundation.ts`
- 设计依据：`swarm/docs/design/issue-sedimentation.md` v2.3（§7.5 自报、§11.2 shadow/reconcile、§12 交付面、§13 M2 范围、§14 patch 预算、§19.1 决策）

## 实现者自报要点

1. 写入顺序 **shadow 先、DB 后**；每条 `push` 后显式 `flush()`，`flushBufferThreshold: 1`。
2. 影子文件族 `<userData>/incidents/`，10MB × 10 轮转，行带 `v: 1` 版本。
3. reconcile：老→新遍历，`insertIncident` 的 UNIQUE 让重复成为 no-op；水位存 `incident_store_meta`（`shadow_replayed_file` 文件名 + `shadow_replayed_offset` 偏移）。
4. 无 `\n` 的截断尾行不消费；完整但不可解析的行 / 未知版本 / store 拒绝 → 停在上一个 good offset，不修文件。
5. 失败可见：一行 `console.warn` + 持久计数 `shadow_reconcile_failures` / `shadow_reconcile_last_error`。
6. 挂载点仅 1 处：`initializeReadyFoundation` 调 `scheduleIncidentShadowReconcile(canonicalUserDataPath)`，`setImmediate` 延后、每进程一次；同时重置 M1 缓存的 store 打开失败。
7. `incident report`：`--source-id` 幂等、class+code 必填、summary 过 redactor、evidence 只存 `path+sha256+bytes`，上限 8 条；写命令允许建库（`list` 不建）。
8. crash 指针结论：`onPtyExit` 拿不到 transcript 路径（`RuntimePtyWorktreeRecord` 无该字段；`claim` 只有 `identityDigest`；唯一路径在 hook 状态行上，而那正是本次调用在回收的对象），因此保持 `pointers: []` 并写明原因，不加反查。
9. IPC：只读 snapshot + decide；decide 的 actor 缺省由 IPC 层补 `unspecified`（store 仍拒绝空 actor）；未加 renderer channel 白名单（M2 无 UI）。

## 请重点核对（按风险排序）

1. **轮转 × 水位**：水位记的是**文件名**（如 `...ndjson.1`）+ 偏移，而 sink 轮转会把 `...ndjson` 改名成 `...ndjson.1`。轮转发生时，同名文件的内容换了一批，水位是否会指向错误位置、导致漏放或重放到别人的行？给出可复现的反例或证明安全。
2. **并发写/读**：runtime 持 O_APPEND fd 持续追加，CLI 另起进程每行一次 `write()`，同时 reconcile 在读。读到的"最后一行"可能正被写入：截断判定 + 水位推进是否有竞态？水位会不会越过一条尚未完整可见的行？
3. **replay 绕过脱敏**：DB 里 `summary` 来自 shadow 行。若影子文件被外部改写（它就在 userData 下），replay 是否会把未经 redactor 的内容写进 DB？请给出结论与证据。
4. **容量 latch × replay**：store 被 latch 后，replay 的低优先级噪声是否会被拒 → 水位不推进 → 每次启动重试并累积失败？是否有界、是否可见、是否会把 crash 行也一起卡住？
5. **report 幂等键语义**：同一 `--source-id` 但不同 `--class`/`--evidence` 时第二次被静默去重，是否正确？`source_id` 命名空间与 pty incarnation 是否可能撞车？证据指针的 `sha256` 对符号链接/大文件/不可读文件的处理，路径本身是否有隐私风险。
6. **启动副作用**：`setImmediate` 是否真不 gate 窗口；在无 userData（headless/CI）、store 损坏、磁盘满时是否只记日志不阻断；重置 M1 缓存失败后是否会引发每次退出都重开库。
7. **读模型一致性**：IPC/preload 暴露的字段与 CLI 输出、与 `IncidentCoverage` 是否一致；`decide` 在 IPC 层补 `unspecified` 是否削弱了 §19.1 的"confirmed 必须显式 actor"；renderer 未加白名单的风险边界。
8. **测试真实性**：新增测试是否在真实 SQLite 文件 + 真实影子文件上跑；有没有把被测逻辑替换成 stub 而实际没覆盖（尤其 reconcile 与轮转）。

## 纪律

- 只读评审：不改源码，只写自己的评审文件；可跑测试、可写临时脚本到 /tmp。
- 跑测试：`cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <path> --maxWorkers=2`（`orca/node_modules` 是指向共享依赖树的符号链接）。
- 输出第一行必须是 `VERDICT: APPROVE | APPROVE-WITH-CHANGES | BLOCK`。
