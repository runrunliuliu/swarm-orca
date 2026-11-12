VERDICT: APPROVE-WITH-CHANGES

结论：M1 可以继续推进到 M2，但不能宣称“运维可完整闭环”。本机 agent crash -> incident -> CLI list/show/decide/prune 的主链路成立；必须先修容量 latch 表达、prune 审计可追溯、远端/SSH 口径三处，否则运维会被空白或错误提示误导。

## 已核对范围

- 读了 M1 brief、v2.2 设计 §6、§7.1、§12、§13、§14、§19.1。
- 核对提交：`916290df` store/key/render，`640d285f` `onPtyExit` 接线，`5a04946a` CLI。
- 测试：
  - `cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/incidents --maxWorkers=2`
  - 结果：7 files / 70 tests passed。
  - 追加窄测：`src/main/runtime/on-pty-exit-incident-write.test.ts --maxWorkers=2`
  - 结果：1 file / 7 tests passed。

## Findings

1. 容量 latch 会把“曾经限流”和“当前仍拒收”混成一个 `store_capacity_limited=true`。
   `incident-store-capacity.ts` 用 latch OR current limit 输出同一布尔；`incident-format.ts` 随即打印“new non-crash incidents are being refused”。如果 prune 后 rows/bytes 已低于上限，这句话仍会出现，运维会以为系统还在拒收。需要拆成 `capacity_latch_set` 与 `currently_limited`，或改文案/JSON。

2. prune 后保留的 decision 行没有受支持追溯面。
   不加 FK 可以接受，但 prune 删除 incident 后，CLI `list/show` 都无法发现 orphan decisions；`prune --dry-run` 也只给数量不给候选 id。审计“保留”目前等于“只能手写 SQL”。至少要让 `prune --json` 输出候选 id，或提供 `incident audit <id>` / prune report。

3. 远端捕获口径自相矛盾，容易误导。
   §19.1 写 SSH/WSL 不写 incident，M1 实现会对 SSH unconfirmed + agent binding 写 `crash/unknown`；CLI 又固定输出 `remote_incident_capture=unsupported`。代码行为可以接受为“记录本地 relay/PTY 事实，不记录远端宿主事实”，但文档与 CLI 文案必须这样说。

4. 只读打开基本避开迁移，但 WAL/shm 零污染未被测试证明。
   `list/show` 走 `openIncidentsDatabase(... readOnly)`，不跑 schema/pragma；不存在 DB 时 list 返回 empty coverage，不建库。现有测试只证明能读和主 DB size 不变，没有断言 `-wal/-shm` 不被创建/修改。建议补一个 sidecar/mtime 断言。

5. store open 失败会被 runtime 缓存为不可用，修复目录后本进程不会自动恢复。
   `incident-writer.ts` 将打开失败缓存为 `null`，避免每次 exit 打爆文件系统，这是合理取舍；但 diagnostics 只有内存，不在 CLI 可见。运维要么重启 app，要么等 M2 shadow/reconcile；M1 文档需写清。

## 运维今天能做成的三件事

- `orca incident list --status untriaged --class crash --limit 20`
  查看本机 crash incidents，并看到 `remote_incident_capture` 与容量状态。
- `orca incident show <id> --md`
  读取退出原因、unknown boundaries、证据指针缺口和 markdown 派生视图。
- `orca incident decide <id> --to watch --reason "..."`，或 `--to confirmed --actor <name> --reason "..."`
  追加 triage decision；也可以 `orca incident prune --dry-run --keep-days 90` 看清理候选数量。

## 运维今天做不成的三件事

- `orca incident report --class ... --code ...`
  自报入口还没做，M1 只能被动记录本机 PTY exit。
- `orca incident list --host <other>`
  非本机 selector 被拒绝；远端宿主事故不会被本机 CLI 代查。
- `orca incident show <id>` 后追 transcript 证据。
  M1 crash 记录 `pointers: []`，只能看到“未记录证据指针”的 unknown boundary。

## 误报 / 漏报

- `hasAgentBinding` 门槛会漏：没有 hook/status/launchAgent 的真实 agent unknown exit、早期启动未绑定即崩、恢复态 authority 丢失的 ambiguous zero、某些自定义 agent shell wrapper。
- `unknown_without_agent_binding` 跳过会漏：裸 shell 里实际跑 agent 但 Orca 没有 agent 绑定的 crash；这是降噪换漏报，M1 可接受，但必须写进 coverage gap。
- `operator_close` 不写会漏：运维手动 close/stop 一个卡死 agent 的事实；如果需要沉淀“人工止血”，只能靠 M2 self-report 或未来 operator-close audit。
- 会误记：agent 正常用非零码表达业务失败、宿主重启/relay 断线导致的 signaled/unknown、SSH relay unconfirmed。它们都保持 `untriaged/unknown`，误报成本可控。

## 容量 / 清理

- 发现：`incident list/show` 的 coverage 会显示 `store_capacity_limited=true`。
- 解除：当前没有受支持解除 latch 的 CLI；prune 只降低 rows/bytes，不清 latch。这应明确为“曾发生限流”，否则就是误导。
- prune 误删风险低但不是零：只删 effective status 为 `closed|invalid|duplicate` 且 older-than 窗口的行，dry-run 默认；但 `--apply --keep-days 0` 会立即删掉已终态行。
- 审计追溯：decision 行保留但无 FK、无 CLI discovery；没有 incident id 清单就很难找。需要补审计查询或 prune 候选/结果 id 输出。

## 只读安全

- `list` 在 DB 不存在时不建库；`show` 要求已有库。
- 只读打开不执行 migration、不设置 WAL pragma、不写 decision/prune。
- WAL/shm sidecar 零写入未被测试覆盖；补测试后再把“只读不污染”写成验收结论。

## 失败模式

- 库文件损坏：CLI open/read 会失败，runtime writer 捕获为 `incident_store_open_failed:*` 并跳过；M1 没有持久告警。
- userData 不可解析：CLI 报 runtime/userData 路径错误；runtime writer 返回 store unavailable skip。
- 磁盘满：insert/latch 可能失败；writer 不抛进 PTY teardown，但 incident 丢失且只能靠内存 diagnostics。
- 两个 CLI 并发：SQLite WAL + 5s busy timeout；`decide/prune --apply` 串行，超时会失败；重复 insert 由唯一键去重。

## 10 处偏差判定

- 1 无 FK：接受，但必须补审计追溯面或文档说明“保留但 CLI 不可发现”。
- 2 prune marker 删除：接受；事务内 marker 回滚语义合理。
- 3 `tool_error` source_kind：必须回写文档。
- 4 `closed` status：必须回写文档。
- 5 unknown 仅 agent binding 写：接受，但必须回写 coverage gap。
- 6 `agentSessionId=null`：接受；digest 放 evidence 比伪造 id 好。
- 7 M1 `pointers: []`：接受；M2 前不能把它说成证据完整。
- 8 CLI 直连 SQLite：接受；补只读 sidecar 测试。
- 9 capacity latch 表：代码需改表达，或文案/JSON 分离 latch 与 current。
- 10 `synchronous=NORMAL`：接受；文档需写“incident 非 durability receipt”。

## 是否允许进入 M2

允许进入 M2，但要求 M1 在运维启用前完成最小必改集：

1. 拆分容量 current limit 与 historical latch，或改 CLI/JSON 文案避免误报“仍在拒收”。
2. 给 prune 审计补可追溯面：至少 `--json` 输出候选/删除 id，或新增 audit 查询。
3. 回写 SSH/remote 口径：M1 记录本地 relay/PTY unknown，不记录远端宿主事实。
4. 补只读打开 sidecar/mtime 测试，确认 `list/show` 不迁移、不建库、不写 WAL/shm。
5. 文档化 store open failure 缓存：修复 userData/DB 后需重启或等后续 reconcile。
