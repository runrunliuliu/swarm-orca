# 只读评审：issue #36 P4 taskRecords（codex-ark，2026-11-19）

这是 codex-ark 对**修复前**版本的**只读**评审原文（结论"需要返工"）。评审时的对象是本分支的第一个提交
`c7d77fbd`；这个 SHA 在修复 amend 之后已不在分支历史上，处理结果见设计文档 §8.10 的"评审回执"表。评审通过
`codex exec -s read-only -C <worktree>` 运行，`CODEX_HOME` 指向 Ark 的安装根
（`~/.codex-ark`），因此用的是 Ark 的 provider / model / catalog；沙箱为 read-only，
评审者没有修改仓库、提交、建分支、装依赖或启动应用。报告全文由提交者原样归档，未改写。

证据边界（评审者自己声明，未改动）：只做了 `git diff ebd59158..c7d77fbd`、`git diff --check`、
文件与设计文档静态阅读和文本搜索；没有执行 typecheck、vitest、全量测试、代码质量 / max-lines gate、
RPC catalog 验证、localization gate、Electron / 渲染 harness 或截图。

处理结果见设计文档 §8.10 的"评审回执"表：9 条必修中 8 条已按建议修改并补测试，第 9 条
（结算不做会话级去重）写成明确的边界而不是伪造去重；另 3 条建议分别记为已记录 / 已修（zh 文案）/
不改（preload 非 additive，桌面端同版本发布）。

---

需要返工：存在“写入成功、重载后整条历史被丢弃”的数据丢失路径，以及历史总量、任务身份和工作区存在性判断错误。

本次实际只进行了 Git 状态/提交核对、`git diff ebd59158..c7d77fbd`、`git diff --check`、文件与设计文档静态阅读及文本搜索。HEAD 符合指定提交，工作树干净，diff whitespace 检查无输出；未修改文件、提交、建分支、安装依赖、启动应用或运行测试。以下均为静态阅读结论。为缩短引用，除明确标注外，文件路径均相对于 `orca/src/`。

## 1. 数据语义

- [已确认] `main/task-records/task-records-worktree-usage.ts:171` — `unavailable` 分支没有 tokens、providers、金额等用量数字字段，只有状态、原因及采集时间/范围等元数据。Muse 的 `costUsd` 明确为 `null`（138），任一 provider 未定价会使总金额为 `null`（180）；没有把未定价当成零。全部工作区移除后的 agent 数和 wall time 也分别降为 `null`、`unknown`（`task-workbench-history-merge.ts:103`）；保留这些语义。

- [必修] `main/task-records/task-records-worktree-usage.ts:87` — **session 歧义保护没有覆盖结算路径。** renderer 的 session-total helper 遇到重复 sessionId 会返回未知，但 main 分别读取 provider rollup 与 session identities，结算不检查二者冲突；有 provider 行便形成 `known`，tokens 再由 `shared/task-records.ts:70` 相加。如果两个 provider 的 rollup 包含同一 session，这条路径仍会相加，不能宣称端到端避免重复归属。应对已知冲突返回 `ambiguous_session`；无法证明归属的聚合值应明确范围，不能猜测去重或直接声称完整总量。

- [必修] `renderer/src/lib/task-workbench/task-workbench-history-merge.ts:79` — **混合存活和已删除工作区时，总量范围错误。** 这里只汇总 removed bindings，却在 89 覆盖原 history.tokens；例如存活部分 100、删除部分 200，会显示 200，而页面标注仍是 `Total: every run`（`TaskWorkbenchHistory.tsx:276`）。与此同时，只要还有一个 live binding，agent 数/时间就沿用 live 部分，忽略删除部分的未知值。应分别展示明确范围的小计，或在完整聚合时传播未知；不能把部分结果标为所有运行的总量。

## 2. 失败关闭与降级

- [已确认] `main/persistence/loading-store/normalize-loaded-profile-state.ts:109` — **未知 `recordsVersion` 对象没有被空 domain 覆盖。** 加载保留前面的 `...parsed`；绑定、结算入口分别在 `task-records-persistence.ts:54`、98 early-return；selective write 在 `state-serialization-secret-handling.ts:87` 使用原值，full write 在 182 展开 `getDurableState()`。这里确认的是 JSON payload 内容保留，不是原始 JSON 文本的字节级保留，也不等于已完成旧 build round-trip 实测。

- [必修] `shared/task-records-updates.ts:119` — **写入和加载的大小限制不一致，可导致重启丢历史。** `grown()` 只检查 domain 的 8 MiB，不检查单记录 8 KiB；session 合并和结算走 `replaceBinding()`（248），连 domain 字节限制也绕过。加载却在 `task-records-normalize.ts:130` 丢弃超过 8 KiB 的整条记录。因此正常累积 bindings/sessions 就能写入一个下次加载会消失的任务。应让所有增长路径统一校验完整 record/domain，超限拒绝并报告；32 个 session 之后的静默 `continue`（190）也应改为可观察的拒绝。单条损坏确实不会判死整个 domain，但 `dropped` 在加载调用方未被消费，应补计数诊断。

- [必修] `main/persistence/loading-store/normalize-loaded-profile-state.ts:47` — **旧账本损坏可能阻断整个 profile 加载。** 迁移先接收未经规范化的 `parsed.taskRunHistory`，112 才调用旧 normalizer。迁移函数在 `task-records-legacy-migration.ts:25` 直接访问 `ledger.records.length`，29 直接遍历并读取成员；`{}` 或 `{records:[null]}` 都存在抛错路径。异常会进入 profile 加载的失败处理，而非只丢坏行，因而可能连带影响工作区列表和 agent 状态。应先规范化旧账本，再迁移有效记录，并补实际加载入口的损坏数据测试。

## 3. 一份真相

- [已确认] `main/persistence/loading-store/normalize-loaded-profile-state.ts:48` — 未发现新旧账本并行业务写入：只有 `taskRecords === undefined` 才迁移；已有空 domain 或未知版本 domain 都不会再播种，成功迁移会标记保存。deleted 行在 `task-records-legacy-migration.ts:50` 使用 `lastVerifiedAt: null`，没有把迁移时间伪装成核验时间。需准确描述“旧 key 只读”：旧 key 仍会在每次加载时被 normalize，并随全量保存带出；正确说法是“不再更新旧账本业务事实”，不是“旧 key 此后绝不读写”。

- [必修] `shared/task-records-normalize.ts:287` — **当前已知字段也会在重载时丢失。** link writer 在 `task-records-worktree-links.ts:78` 写入 `origin.providerIdentity`，但 `normalizeOrigin()` 重建 origin 时漏掉它；record 外层的 preserved-fields 机制救不回 origin 内部字段。此外，76 重建 domain 时也丢弃当前版本的未知顶层字段。应保留并校验 `providerIdentity`，按兼容契约保留未知扩展字段；补 domain、origin、intent 的写入—加载—保存往返测试，而不只测 record 根部扩展字段。

## 4. 写入时机

- [已确认] `main/persistence/loading-store/metadata-lineage-operations.ts:135` — 结算调用确实位于 `removeWorktreeMeta` 删除元数据行之前。已有 binding 的 path/archive 状态不变且已有核验时间时，`task-records-updates.ts:90` 返回 `changed:false`，`persistTaskRecords()` 不安排 domain 写入；评论/pin/排序等无关更新不会持续刷新历史。初次补建记录属于例外且符合目的。同 provider 的重复链接由 `task-records-worktree-links.ts:62` 去重；taskId 包含 itemType，issue #31 与 PR #31 能区分。保留这些行为。

- [必修] `shared/task-records.ts:21` — **多 provider 输入与持久化身份键不一致。** links 使用 `provider:itemType:number` 区分来源，最终 taskId/index 却只有 `repoId:itemType:number`。同一 repo 的 Linear issue #31 与 GitHub issue #31 会生成两个 link，却写进同一任务；相同 binding 还会触发 unchanged，保留第一个 origin。现有 links 测试恰好构造了这组输入，但没有走到 persistence。应把 provider 及必要的项目/团队身份纳入稳定键和查询，或将本切片明确限制为支持的 GitHub 来源；不能接收四 provider 后再丢弃身份维度。

## 5. 层与契约

- [已确认] `main/task-records/task-records-worktree-usage.ts:67` — 未发现 main 依赖 renderer 的问题；用量来源是 main 的既有 store。renderer 则并非“所有数据只来自应用 store”：`renderer/src/hooks/use-task-records.ts:33` 通过只读 preload IPC 取记录，但没有直接读文件或扫描用量库。此次接口未进入 runtime RPC wire/catalog，静态上未发现需要更新 RPC params catalog 的新增方法；未执行其验证命令。上游目录改动主要围绕该功能，未见大面积风格改写，仅有少量可省略的换行调整。

- [建议] `preload/api-types.ts:84` — **接口变更不是严格 additive。** 新 `taskRecords` 替换了旧 `taskRunHistory` API/bridge/注册点，而不是仅新增。如果支持不同版本 preload 或旧调用方，应保留读取同一 `taskRecords` 的兼容适配器，不能恢复第二个写者；若只支持桌面组件同步升级，应明确这项契约。新增 i18n key 在 en/zh catalog 中均有对应项，但 zh 的 `unavailable · scan_failed` 仍是英文，建议本地化；catalog/extraction/runtime gate 本次未运行。

## 6. 代码质量风险

- [必修] `renderer/src/hooks/use-task-records.ts:32` — **记录只在查询身份变化时读取，没有更新失效机制。** effect 仅依赖 repoId/itemType/number；同一任务页面保持挂载时，删除工作区后的结算、session 引用或归档变化不会触发重新读取。store 列表已更新而 taskRecord 仍旧，可能显示缺失结算或错误状态，直到重挂载。应增加 domain 变更通知或相关 metadata revision 失效机制，并处理异步查询竞态。

- [必修] `renderer/src/hooks/use-task-workbench-view.ts:284` — **把“当前任务匹配集合”误当成“工作区存在集合”。** 传入的是经过任务来源过滤的 joinedWorktrees；merge 在 `task-workbench-history-merge.ts:41` 将不在集合中的 binding 一律视为 removed。工作区从 issue #31 改绑到 #32 后，仍存在的工作区会在 #31 历史里被标成 Removed；列表尚未加载完成也存在同类误判。session 随之显示“无法继续：工作区已删除”，并非文案本身能解决。应使用完整、权威且带加载完成状态的工作区集合；来源匹配与存在性必须分开，未确定时显示 unknown/unresolved。

- [建议] `renderer/src/components/task-workbench/TaskWorkbenchHistory.tsx:320` — React key 不含 provider，而 session 存储有意保留不同 provider 对同一 `key:id` 的声明（`task-records-updates.ts:183`），因此同一 worktree 内可产生重复 key。应使用完整 claim identity。静态检查未见新增 domain 代码用 `as unknown as` 或非空断言掩盖可空值；结算异常在赋值前返回，也不会偷偷更新 `updatedAt`（`task-records-persistence.ts:140`）。数组相关下游已有 primitive memo key，不能仅凭每次创建数组认定性能缺陷；max-lines gate 本次未执行。

## 7. 测试有效性与范围

- [必修] `shared/task-records-updates.test.ts:94` — 大小限制测试只证明“第 65 个 binding 被拒绝”，并要求前 64 个全部成功，却不验证成功结果能否通过加载端 8 KiB 检查；它漏掉了最重要的数据丢失路径。`task-records-worktree-links.test.ts:24` 只断言产生两个来源，没有检查最终是否变成同一 taskId。应补成功写入后 normalize/reopen、session/settlement 增长越界、跨 provider 身份隔离测试。

- [建议] `main/persistence/loading-store/profile-state-settings-writes.test.ts:313` — 该测试走真实 Store/reopen，确实比纯 mock 更有价值，但没有配置 usage source，不能证明“先结算、后删除”的内容持久化。现有纯函数和 IPC 测试也并非把全部被测逻辑 mock 掉，不过没有覆盖上述混合总量、页面保持挂载后的刷新、列表未就绪/重新绑定、原始坏账本迁移、未知版本经过实际加载及两种保存路径。应按这些边界补测试，避免把 helper 成功等同于完整生命周期成功。

- [已确认] `swarm/docs/design/task-workbench/README.md:1112` — 未发现所声明排除的动作层、启动对账、别名解析或 M2a round-trip 被偷偷实现成另一套半成品流程；存在性投影也没有写回核验时间。不过它自身的误判需要按第 6 节修复。“明确未做”只说明范围透明，不构成完整 M2b 验收，也不能替代 development-plan 中原有的 M2a 前置判决。

## 未验证项与最大风险

没有执行 typecheck、vitest、任何全量测试、代码质量/max-lines gate、RPC catalog 验证、localization gates、Electron/renderer harness 或截图；没有验证真实删除操作、运行中的 IPC/界面刷新、远端工作区、性能或指定旧 build 的往返兼容。

你声明完成的 node/web `tsc --noEmit`、21 个测试文件 / 273 个用例及各项质量、本地化检查，我作为提交者提供的结果接受，**不计为本次亲自验证的证据**。

最可能造成线上事故的风险是：**任务随着 bindings/sessions 增长超过 8 KiB，当前进程仍报告写入成功，重启加载却丢掉整条任务记录，后续保存再固化缺失状态。** 它直接破坏本提交“删除工作区后仍保留历史”的核心承诺，应优先修复。
