# issue-sedimentation 精简审计（trae）

结论：现在不该大删行为代码；应做两类精简：一是把“重复口径实现”收成共享 helper，二是把 36 个过程文档归档成可索引证据。删错的代价很高，因为多数复杂度都来自评审抓到的真实事故。

## A. 删除/合并清单

1. 目标：CLI formatter 里的 6 份 `pad()`。
   动作：合并到 `src/cli/incident-format-shared.ts`，只导出 `pad/table/bytes/iso` 这类纯格式工具。
   节省：约 25-40 行，少一个未来分叉点。
   风险：低；格式输出可能有空格快照变化。
   验收：现有 `incident-*-format.test.ts` 全过，文本输出仅空白等价或按快照更新。

2. 目标：meta helper 两套口径：`readMeta/writeMeta` 与 `readMetaNumber/bumpMetaNumber`。
   动作：合并为 `incident-store-meta.ts`，capacity/shadow/stall/tool/mine 只从这里 import。
   节省：约 20 行；更重要是减少 meta 表写入第二套 API。
   风险：中；meta 是 coverage 入口，错了会让值班看不到失败。
   验收：shadow/stall/tool/capacity coverage 测试全过，手工 grep 不再有第二套 meta helper。

3. 目标：`incident-mine.ts` 1058 行。
   动作：拆 3 个模块：`incident-mine-source.ts`（stable source/parser/rules）、`incident-mine-build.ts`（readRows/buildCluster/buildIncidentMine）、`incident-mine-apply.ts`（apply/reason）。
   节省：行数不一定少，收益是概念边界清楚。
   风险：中；跨文件跳转增加，类型导出可能膨胀。
   验收：`incident-mine.test.ts` 按 source/build/apply 三组移动；public exports 仅保留 CLI/测试实际用到的。

4. 目标：CLI handler 面的“一个巨型 `incident.ts` + 多个子 handler”双入口。
   动作：保留 `handlers/incident.ts` 只做 command map；把 list/show/decide/prune 也下沉到 `incident-basic.ts`，与 report/stall/mine/acceptance 对称。
   节省：不多，少一个“为什么这四个在中心文件”的心智分支。
   风险：低；命令 key 不变。
   验收：`handler-group-manifest` keys 不变；`handlers/incident.test.ts` 全过。

5. 目标：CLI 命令是否过多。
   判断：对子命令数量不宜减少；它们对应不同权限/副作用面。值班日常只需要 `list/show/decide/digest/mine`，其余是诊断或配置。
   动作：不删命令；在 `cli/specs/incident.ts` 里分组标注 Daily / Diagnostic / Config / Maintenance，并把 `tool-errors`、`stalls`、`wait`、`acceptance declare/resolve`、`prune --apply` 从日常 examples 降为“诊断/维护”。
   节省：0 行，降低误用。
   风险：低；帮助文案变化。
   验收：`orca incident --help` 中日常路径先出现；不改变任何 command path。

6. 目标：`incident-format.test.ts` 与 `handlers/incident.test.ts` 的重复格式断言。
   动作：格式测试保留每种 formatter 的一条代表性快照；handler e2e 只断言关键字段/副作用，不重复完整文本。
   节省：约 80-150 行。
   风险：中；过度删会放过误导性文案。
   验收：必须保留 capacity latch/current、shadow incomplete、stall grayscale、acceptance rejected、mine truncation 这几条文案断言。

7. 目标：36 个过程文件。
   动作：移动到 `swarm/docs/design/issue-sedimentation-history/`，新增 `README.md` 索引表：轮次、verdict、必改项、最终处置、相关 commit。brief/review/consensus 原文保留但离开 design 根目录。
   节省：根目录降噪 36 个文件；信息不丢。
   风险：低；旧链接可能断。
   验收：正文 §19.x 链接改到 history README；`rg issue-sedimentation.review` 仍能定位原文。

8. 目标：brief 文件。
   动作：不立即删除；先在 history README 中提取“风险面/约束/测试命令”。两轮后若无人引用，再把 brief 合并进每轮 record，删除 standalone brief。
   节省：约 200 行和 6 个文件，二阶段做。
   风险：中；brief 记录了当时评审输入，删早了会丢复现上下文。
   验收：每个被删 brief 的风险面都在 history README 有摘要与链接到最终 review。

9. 目标：设计正文 §18、§19.x 实施/评审记录。
   动作：正文只保留每个里程碑最终状态和未决；详细评审过程下沉 history README。
   节省：约 80-120 行。
   风险：中；正文读者可能失去“为什么这样”的短证据。
   验收：每条“教训型不变量”仍在正文对应章节出现，例如 stable source、override 证据、shadow seq。

## 测试精简判断

可压缩：纯 formatter 重复断言、CLI handler 中同一空库/coverage 文案的多处重复、`incident-mine.test.ts` 中为同一 cap 语义重复造库的样板。

不能删：`incident-key.test.ts`（fallback epoch/key 教训）、`incident-shadow-reconcile.test.ts`（seq 水位/容量跳过 crash）、`incident-sanitize.test.ts`（shadow replay 脱敏）、`incident-tool-error-classifier/window/observer.test.ts`（自由文本高危、turn key、provider 覆盖）、`incidents-stall-sampler.test.ts`（语义事件年龄、默认 off）、`acceptance-gate.test.ts`（fail-closed、unread）、`incident-mine.test.ts`（stable source、human decision guard）。

## B. 不能动清单

- `buildIncidentKey` 与所有写入方的关系不能弱化。多次评审都抓到手工 key 旁路，保留集中校验和反例测试。
- fallback epoch 的哈希编码、`state_fallback`/unknown boundary 不能删。它解释了缺 incarnation 时的幂等代价。
- `sanitizeIncidentRecord` 统一层不能拆回各写点。shadow replay 曾是脱敏旁路。
- shadow seq 水位、dropped/deferred、replay coverage 不能简化成 file+offset。轮转复用已证明会漏行。
- capacity `capacityLatchSet` 与 `currentlyLimited` 不能合并。过去式和现在式混淆会误导值班。
- `requireFromStatus` / miner human-decision guard 不能删。它防止自动 miner 覆盖 confirmed/watch。
- acceptance override 留痕不能删。人工恢复可以 override，但必须留下 actor/reason/rules。
- `INCIDENT_*_WRITE` 默认 off 不能改。no_progress/tool_error 都先靠灰度面校准噪声。
- `incidentRuntimeStoreIfPresent` 和 CLI read-only open 的 no-create 行为不能合并到普通 writer open；无声明/只读路径必须零副作用。

## C. 新人最短阅读路径

1. 先读 `issue-sedimentation.md` 的 §2、§5、§11、§12、§13、§19.3-§19.8，只看最终状态与红线。
2. 再读 `issue-sedimentation-history/README.md`（建议新增），了解每轮为什么留下这些不变量；不要先读全部 review 原文。
3. 代码先读 `incident-types.ts`、`incidents-database.ts`、`incident-store.ts`、`incident-key.ts`、`incident-sanitize.ts`。
4. 再按数据流读：crash `incident-writer/pty-exit`；shadow `incident-shadow*`；CLI `handlers/incident.ts` + `incident-store-access.ts`。
5. 最后按功能包读：stall、tool-error、acceptance、mine。每包先读测试中对应“评审缺陷”用例，再读实现。
6. 值班人员只读 CLI help + `issue-sedimentation.md` §12 + history README 的“Daily operations”表；不要读源码。

目录建议：主代码可暂保持扁平，避免 M7 前大搬家；只先拆 `incident-mine.ts`。等 M7 后再考虑 `store/ shadow/ triggers/ acceptance/ mine/` 子目录，否则 import churn 会盖过收益。
