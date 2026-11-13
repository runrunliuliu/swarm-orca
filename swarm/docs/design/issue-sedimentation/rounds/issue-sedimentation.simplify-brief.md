# M7 前的精简审计（评审输入，非设计正文）

目标：在不改变行为、不丢评审证据的前提下，找出可以删/合并/下沉的东西。**纯精简，不加功能。**

## 客观现状（外层实测）

| 项 | 数值 |
| --- | --- |
| `orca/src/main/incidents/` | 68 文件（44 源码 + 24 测试）；源码 **8,417** 行，测试 **5,561** 行 |
| 最大单文件 | `incident-mine.ts` **1,058** 行 |
| CLI 新增 | 24 文件 / **4,161** 行（`cli/specs/incident.ts` 263 行、`handlers/incident*.ts` 1,106+ 行） |
| 设计目录 | `swarm/docs/design/` **50 个条目**，其中 **36 个**是本项目的评审/共识/brief 过程文件 |
| 设计正文 | `issue-sedimentation.md` **690** 行 + `example.md` 196 行 |
| 提交 | 35 个（`fc011d66..HEAD`） |

## 已发现的重复（外层 grep）

1. `pad()` 在 CLI 里**重复 6 次**：`incident-format.ts:73`、`incident-acceptance-format.ts:13`、`incident-digest-format.ts:9`、`incident-mine-format.ts:10`、`incident-stall-format.ts:10`、`incident-tool-error-format.ts:14`。
2. meta 读写有两套：`incident-store-capacity.ts:29,34`（`readMeta`/`writeMeta`）与 `incident-shadow-coverage.ts:41,47`（`readMetaNumber`/`bumpMetaNumber`）。
3. incident store 单例被 5 个文件各自取用：`incident-writer.ts`、`incidents-stall-sampler-timer.ts`、`incident-tool-error-observer.ts`、`acceptance-runtime.ts`、`incidents-startup.ts`。
4. CLI 侧另有 `incident-store-access.ts` 自己 `openIncidentsDatabase`，与主进程 writer 的打开策略是两套。
5. 设计目录 36 个过程文件（6 个 brief + 14 个 review + 16 个 consensus）。

## 请给出三份清单

### A. 删除/合并清单（按性价比排序）

每条给：目标（文件/函数/文档段落）、动作（删 / 合并 / 下沉 / 拆）、预估节省行数、**风险**（会不会丢信息或改变行为）、验收方式。要求：

- 只列**真的划算**的：净收益必须是"少一个概念"或"少一处将来会分叉的实现"，不是"行数变少"。
- `incident-mine.ts` 1,058 行：给出你的判断——拆成 2-3 个模块（cluster/rule/apply）值得吗？拆的边界在哪、会不会反而增加跨文件跳转成本？
- 测试 5,561 行：哪些是过度指定（断言实现细节、重复覆盖同一分支）、哪些绝不能删（它们对应评审抓到的真实缺陷）。请点名具体测试。
- 文档：36 个过程文件怎么处理才既减噪又不丢可复现性（例如收进子目录 + 一个 index；brief 是否可直接删；每轮 review+consensus 是否可合成一篇"轮次记录"）。

### B. 不能动清单

列出看起来冗余但**必须保留**的东西，并说明它承载的教训。例如（供参考，不限于）：
- 手工 key 与 `buildIncidentKey` 的关系、fallback epoch 的哈希编码、`state_fallback` 标记、`requireFromStatus` 守卫、稳定来源键、扫描上限、override 留痕。

### C. 结构建议

- 目录/命名是否需要调整（例如 `incidents/` 下分成 `store/ shadow/ triggers/ acceptance/ mine/` 子目录，还是保持扁平）。
- 设计文档是否应拆分（正文 / 实现记录 §19.x / 轮次评审），拆了以后新人第一次读的顺序是什么。

## 纪律

- 只读评审，不改仓库；可跑测试、可写临时脚本到 /tmp。
- 结论先行；每条建议都要能回答"删了以后谁会更难"。
- 输出写入 `swarm/docs/design/issue-sedimentation.simplify-<agent>.md`（≤120 行）。
