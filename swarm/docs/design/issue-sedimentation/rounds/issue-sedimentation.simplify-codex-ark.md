# issue-sedimentation 精简审计（codex-ark）

结论：M7 前最划算的是“下沉过程材料 + 抽小公共件 + 轻拆 mine”，不是压缩事故语义；凡是来自 M1-M6 评审缺陷的显式字段/测试都应保留。

## A. 删除/合并清单（按性价比）

1. 目标：`swarm/docs/design/issue-sedimentation.*{brief,review,consensus}*.md` 36 个过程文件。
   动作：移入 `swarm/docs/design/issue-sedimentation/rounds/`，加 `INDEX.md`（轮次、结论、必改、采纳状态、原文链接）；正文 §19 只保留每轮 3-5 行摘要。
   节省：顶层噪声 -36 文件；正文可从 690 行减约 70-100 行；原始证据不删。
   风险/谁更难：若直接删 brief/review，后来追责“为什么这样设计”的人最难；下沉+索引风险低。
   验收：顶层只剩正文、example、simplify；索引能从 M1-M6 找到 brief、双方 review、consensus。

2. 目标：CLI `pad()` 六处复制（`incident-format.ts`、`incident-acceptance-format.ts`、`incident-digest-format.ts`、`incident-mine-format.ts`、`incident-stall-format.ts`、`incident-tool-error-format.ts`）。
   动作：抽 `orca/src/cli/incident-format-shared.ts`，只放 `pad()`、`formatWindowLabel()` 这类纯显示小函数；不要合并各 formatter。
   节省：约 25-45 行，少 1 个未来分叉点（表格截断/填充规则）。
   风险/谁更难：过度合并 formatter 会让值班文案维护者更难；只抽纯函数风险低。
   验收：formatter 测试仍覆盖各自的灰度/coverage 文案；无行为 diff。

3. 目标：meta 读写散在 `incident-store-capacity.ts` 与 `incident-shadow-coverage.ts`。
   动作：下沉为 `incident-store-meta.ts`：`readMeta`/`writeMeta`/`readMetaNumber`/`bumpMetaNumber`；容量与 shadow coverage 只 import。
   节省：约 30-50 行，少一处“meta 数字如何解析/损坏值如何处理”的分叉。
   风险/谁更难：若顺手改 key/schema，运维读覆盖状态会更难；只机械搬移可控。
   验收：capacity latch、shadow replay failures/dropped/lastRun 测试全绿；DB schema 无变更。

4. 目标：`incident-mine.ts` 1058 行。
   动作：值得拆，但只拆 3 块：`incident-mine-rules.ts`（阈值、stable source、rule 判定、low-info）、`incident-mine-build.ts`（SQL read/group/cluster/report）、`incident-mine-apply.ts`（apply guard、reason、outcome）；`incident-mine.ts` 只 re-export 公共 API。
   节省：行数不一定降（可能 +20 import），但减少“规则/读模型/写 decision”三种责任互相干扰；M6-C1/C2/C3 以后尤其值。
   风险/谁更难：拆太细会让新人跨文件追一个规则更难；所以不拆 DTO 常量到零碎文件，不拆 formatter。
   验收：`stableSourceIdentity`/`mineRulesFor` 纯测试不需 DB；`buildIncidentMine` DB 测试不关心 apply；`applyMineCandidates` race/guard 测试独立。

5. 目标：`orca/src/cli/handlers/incident.test.ts` 1106 行的大一统 CLI 集成测试。
   动作：保留每个命令 1-2 个端到端 smoke；把 mine/acceptance/report/prune 的引擎契约移回对应 main/formatter 测试，避免同一分支在 CLI 和 engine 各断一次。
   节省：约 150-250 行，更重要是减少“改一行文案坏一大片”。
   风险/谁更难：删掉只读不建库、host 拒绝、apply 必须显式 target 这类端到端路径会让发布者更难；这些必须留。
   验收：CLI 测试只断命令解析、store 打开策略、JSON/text 关键 marker；精确计数/状态机由 main 测试断。

6. 目标：formatter 文案测试（如 `incident-format.test.ts`、`incident-acceptance-format.test.ts`）。
   动作：删除重复的整段文字精确断言，改成 marker 断言：危险词“不出现”、owner action、coverage gap、截断提示必须出现。
   节省：约 50-100 行，降低文案微调成本。
   风险/谁更难：值班手册式输出若不测关键句会误导 operator；不可删“rejected stays unsettled”“override not product pass”“remote unsupported”等断言。
   验收：格式化测试不依赖列宽，仍锁住安全语义。

7. 目标：incident store singleton 的多处取用（writer、stall timer、tool-error observer、acceptance runtime、startup）。
   动作：不要合并为一个全局服务；只允许提一个很薄的 `incidentRuntime()` import barrel 或保持现状。
   节省：几乎不省行；主要避免错误精简。
   风险/谁更难：若把 CLI read-only open 与主进程 writer open 合并，triage 在桌面未运行/只读不建 WAL 的人最难。
   验收：M1 C4 “list/show 不建库、不建 wal/shm”、M5 C4 “无声明不建库”测试仍是端到端。

8. 目标：`issue-sedimentation.example.md`。
   动作：保留，但从正文导航链接；不要并入 690 行正文。
   节省：顶层可下沉 1 文件；读者路径更清楚。
   风险/谁更难：删示例会让新人理解 S0→S5 最难；下沉不丢。
   验收：正文“新人阅读顺序”能指到 example。

## A-测试取舍：过度指定 vs 绝不能删

可收缩：`handlers/incident.test.ts` 中同时断 JSON 全形状、文本全文、DB 计数的重复用例；formatter 里纯列宽/空格对齐断言；mine CLI 对 scan/candidate 截断的精确数字可由 `incident-mine.test.ts` 覆盖，CLI 只保留 marker。

绝不能删：`incident-key.test.ts`（separator/fallback epoch/手工 key 教训）、`incidents-database.test.ts`（只读/WAL/trigger/prune marker）、`incident-shadow-reconcile.test.ts`（seq 水位、轮转、容量 skip、redaction）、`incident-stall-decision.test.ts` 与 sampler 测试（lastSemanticEventAt、默认 off、key rejected）、`incident-tool-error-classifier.test.ts` 与 window 测试（结构化高危、turn 入窗口）、acceptance 的 cwd/fail-closed/no-store/no-side-effect/rule digest/override 测试、`incident-mine.test.ts` 中 stable source、single-entity recurrence、scan cap、human-decided guard、无默认 target。

## B. 不能动清单

- `buildIncidentKey`/`incident-key.ts` 的 separator 校验与 epoch 编码：M1 证明手工 source_id 会落不了库；删掉会伤到 crash/stall/tool_error 写入者。
- `capacityLatchSet` 与 `currentlyLimited` 两字段：M1 证明“曾经限流”不能打印成“正在拒收”；合并会伤到值班判断。
- CLI `incident-store-access.ts` 的 `requireExisting/readOnly/createIfMissing` 分叉：承载 list/show 零写入、report 才建库；合并会伤到离线 triage。
- Shadow `seq` 水位与 replay coverage（`incident-shadow-seq.ts`、`incident-shadow-reconcile.ts`、`incident-shadow-coverage.ts`）：M2 证明 basename+offset 会漏放；压成普通 tail 会伤到崩溃恢复。
- `sanitizeText`/redactor 在 normal write、DB insert、shadow replay、report repro 的共用路径：M2 证明 replay 也会带恶意 evidence；删“重复 sanitize”会伤到公开仓安全。
- Stall `lastSemanticEventAt`、`ageBasis=state_fallback`、`wouldWriteIfEnabled` 文案：M3 证明 PTY 字节不是活动信号；简化成 age 会伤到 no_progress 判定。
- Tool-error “结构化高危”与 per-turn window key：M4 证明自由文本/跨 turn 会误报；看似啰嗦但必须保留。
- Acceptance 的 worker_report 必过 gate、operator override 留 `acceptance_overridden` 可见证据、store unavailable fail-closed：M5 的恢复/可信完成边界，不能用“统一完成”抹掉。
- Miner stable source key、`singleEntityRecurrence`、scan cap、`requireFromStatus`/human-decided guard、无默认 `--target`：M6 证明 source_id 含 epoch 且 miner 不能覆盖人。
- Coverage gap 文案（remote unsupported、shadow incomplete、sampler/tool-error errors、scan truncated）：空列表不能读成“没事故”；删了会伤到值班和审计。

## C. 结构建议

1. `orca/src/main/incidents/`：短期保持扁平，先做 mine 三分和 meta 小抽取；不要一次性搬成 `store/shadow/triggers/acceptance/mine`，否则 44 源码文件的 import churn 大于收益。
2. 若 M7 后继续增长，再按“写入域”分目录：`store/`（database/store/key/capacity/prune/meta）、`shadow/`、`triggers/`（pty/stall/tool-error/report）、`acceptance/`、`mine/`；公共 `incident-types.ts` 与 `incident-sanitize.ts` 留顶层。
3. CLI 保持 `handlers/incident-*.ts` + `incident-*-format.ts` 的双层；只加 `incident-format-shared.ts`，不要建总 formatter。
4. 设计正文拆法：`issue-sedimentation.md` 保留目标/架构/当前行为；§19 实施记录下沉到 `issue-sedimentation/rounds/INDEX.md`；`example.md` 下沉到同目录或 `examples/`。
5. 新人阅读顺序：正文 §1-§3 → §6 store → 对应触发 §7/§8/§10 → §11/§12 运维面 → rounds INDEX 看“为什么这样” → example 看端到端。
6. 文档归档原则：brief 不直接删；review+consensus 可合成每轮 record，但必须保留原文或 hash/链接。删了以后最难的是未来评审者复现“谁反对过什么”。
