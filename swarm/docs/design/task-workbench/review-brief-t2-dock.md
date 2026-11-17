# 评审 brief：Tasks 列表页底部 dock 与任务草稿行（T2）

这是**只读评审**，不是实现任务。你不修改仓库、不提交、不部署、不启动其他 Agent。

## 读什么

工作区：本仓库 checkout（当前目录）。只读下列文件：

- 设计：`swarm/docs/design/task-workbench/README.md`
  - §6.2（决策记录 D7–D11）
  - §7.1（信息架构）、§7.2（图 A 列表）、§7.4（图 C 详情面板）
  - **§7.9 全节**（主评审对象：7.9.1–7.9.14）
- 计划：`swarm/docs/design/task-workbench/development-plan.md` 的 `### T2` 与 §4 工作包
- 需要核对代码时，读 `orca/` 下的实现（快照，只读）；关键位置在 §7.9.1 的表格里

## 背景（一句话）

用户在 Tasks **列表页**底部加一个 agent 输入框；说完一句话后，在左侧栏出现一个"任务草稿"行
（类似 `xx_issue`），agent 在其中运行，**唯一目的**是把任务写成 tracker issue（GitHub/Linear/Jira）。
它是 task 开发模式（sparse task workspace）的前置，不承载代码；任务建好后实施方可能是别人。
用户已定：dock 在列表卡片外（形态 A）、草稿行**要**在侧栏可见、语义按 `taskRecords` 定但一期先按
`FolderWorkspace{taskDraft}` 投影。

## 你要回答的问题

按重要性排序。每条给结论 + 理由 + 你认为的证据缺口；不要只说"建议再验证"。

1. **形态**：dock 放在列表卡片外（页面级）是否正确？和卡片内底部（分页条上方）相比，在高度预算、
   窄窗、键盘焦点、与 `＋ New issue` 表单的关系上，各有什么实际问题？是否还有第三种更好的位置？
2. **载体**：一期用 `FolderWorkspace` + `taskDraft` 标记投影，而不是先做 `taskRecords`——这个取舍
   在"用户明确要求侧栏可见"的前提下还成立吗？如果现在就做行类型，代价具体是什么（列出要改的模块）？
3. **会话宿主**：草稿目录放 userData scratch（不是仓库 checkout、不是 git worktree），agent 用
   `gh issue create --repo` / `orca linear create` 写 tracker。这个设计的漏洞在哪？（仓库上下文、
   `gh` 认证、远端宿主、多个 repo、agent 误改文件、凭据暴露）
4. **写 tracker 前必须人工确认**：dock 内预览卡片 + `[Create issue]`。这够吗？失败/部分成功后
   （issue 建了但 `linkedTask` 没写回）怎么处理？
5. **生命周期**：创建成功后保留折叠、30 天无活动且已关联 → 自动归档、一行一任务。这些默认值的
   反例是什么？"讨论场所"这个定位是否要求更强的持久化（跨机器、跨用户交接）？
6. **状态矩阵**：§7.9.7 的失败分支是否齐全？还缺哪些必须实现的状态（空态、未授权、加载、部分失败、
   远端、无 `gh`、provider 拒绝、用户取消）？
7. **演化**：§7.9.14 声称 M2b 时只换数据源、点击行为从"会话"扩到"任务工作台"。这个说法成立吗？
   会不会出现两套行语义、迁移时丢链接、或 UI 需要提前预留结构？
8. **命名**：草稿期用 `getWorkspaceIntentName`（指令前 5 词 / `<动词> <对象>`），落库后改名为
   `<provider>-<number>-<slug>`。这个规则在中文指令、多 repo、同名任务下的表现？是否该用 `xx_issue`
   这类显式后缀？
9. **与其他入口的分工**：`＋ New issue` 表单、`Use`/`Start workspace from issue`、Agent Dashboard
   三者与 dock 的边界是否清楚？会不会出现"同一个任务从两个入口创建两遍"？

## 输出（必须照做）

把评审写到 **`/tmp/t2-review-<你的 agent 名>.md`**：先写 `/tmp/t2-review-<你的 agent 名>.md.tmp`，
写完后 `mv` 成正式文件名（一次原子写入），不要在写入过程中逐段追加。文件写完后，只打印 3–5 行摘要
到终端。

文件内容按固定顺序：

1. `decision`：对这次设计给出的一句话结论（接受 / 接受但需改 / 不接受换方案）
2. `options`：你认为值得比较的替代方案（每条一句 + 支持证据）
3. `open`：你无法从仓库内确认的点
4. `conclusion`：逐条回答上面 9 个问题，每条一行结论 + 一行理由
5. `must-fix`：进入实现前**必须**改掉的（最多 5 条，按严重程度）
6. `nice-to-have`：可以后置的（最多 5 条）
7. `end-state`：`decided` / `insufficient-evidence` / `escalate-value-choice` 三选一

## 约束

- 只读：不写仓库文件、不 `git commit`、不装依赖、不联网抓取外部资料。
- 不要相信文档里的行号；以你实际读到的代码为准，并在结论里给出文件路径。
- 不要为了显得全面而罗列；只写会改变实现决定的内容。
- 你看不到另一个评审者的草稿，也不要去搜索它。
