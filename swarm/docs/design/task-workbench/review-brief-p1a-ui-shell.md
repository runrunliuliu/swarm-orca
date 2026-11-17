# 评审 brief：P1a 工作台 UI 静态壳计划

这是**只读**评审。你不修改仓库、不提交、不部署、不启动其他 Agent。可以多轮：先独立成稿；之后我只会就仍有
分歧的点追问，追问时只答被点名的项。

## 评审对象

`swarm/docs/design/task-workbench/p1a-ui-shell-plan.md`（P1a = P1 的第一小步：只做能看能评的壳）。

上下文（按需读，不要重读全部）：

- `README.md` §6.4（冻结/不冻结）、§7.2（分组规则）、§7.3（图 B）、§7.3.1（降级顺序）、§7.5（状态矩阵）、§7.9（T2 上下文）
- `discussion-record-task-workspace-ui.md`（前两轮结论：M1 先做、图 B 像素不冻结、Delivered = agent done）
- `task-workbench-ui.svg`（工作台示意图，含 0 工作区与降级两格）
- `orca/` 代码（只读）：`components/dashboard/`、`components/native-chat/`、`shared/dashboard-snapshot.ts`、
  `shared/agent-status-types.ts`、`components/ui/`、`renderer/src/components/settings/`（DEV 入口先例）

## 要回答的问题

1. **组件拆分**：9 个组件/模块的边界对吗？该合的、该拆的、漏的（空态 / 错误态 / loading 归属谁）？
   有没有已经在 `components/` 里能直接复用的东西被重复造了？
2. **输入形状**：`task-workbench-view.ts` 作为 P1a 的纯输入、P1b 由 selector 填充——这个形状会不会在接线时
   被迫大改（违反 R4"selector 可被 M2b 复用"）？请指出**最可能被推翻的 2–3 个字段**。
3. **布局决策**：`task-workbench-layout.ts` 用 `(width, height, counts) → 决策` 是否够？Orca 里有没有既有的
   尺寸/断点/容器查询通道应当复用（不要自造一套）？阈值（1100 / 480）有依据吗？
4. **fixture 矩阵**：F1–F9 是否覆盖 §7.5 状态矩阵与 §7.3.1 降级？缺哪几条（按严重度给 ≤5 条）？
   有没有 fixture 之间其实等价、可以删的？
5. **截图清单**：S1–S8 的尺寸与组合是否合理（过多 / 过少）？在 Orca 里做 CDP 截图的实际路径是什么
   （`ORCA_BACKGROUND_LAUNCH=1` 之外还要什么）？如果只能交 3 张，选哪 3 张？
6. **DEV 预览入口**：放 Settings → Advanced 是否合适？残留、tree-shake、截图代表性各有何风险？
   有没有更合适的已有机制（例如 DEV-only route / 部件挂在现有 devtools panel 里）？
7. **复用约束**：Agent 行沿用 `DashboardCard` 形状是否够（需要 workspace pill 与 duration/token）？
   如果不够，改动应落在 `shared/` 的 additive 字段，还是 renderer 的投影层？
8. **退出条件**：6 条是否可被第三方验证？有没有"fixture 自己验证自己"的循环？生产构建断言怎么做才不脆？
9. **工作量**：2–4 天（含 1a+1b 的一半）是否现实？最可能超时的是哪一块？
10. **白做风险**：P1a 的哪些产出在 P1b/P3/P4 会被推翻？请给"必然要改 / 可以沿用"两张清单。

## 输出

写到 `/tmp/p1a-review-r<N>-<你的 agent 名>.md`（先 `.tmp` 再 `mv`，一次原子写入）。固定顺序：

1. `decision`：接受 / 接受但需改 / 不接受换方案（一句话）
2. `answers`：逐条回答 1–10（每条结论一行 + 理由一行）
3. `must-fix`：进实现前必须改的（≤5，按严重度）
4. `nice-to-have`：可后置（≤5）
5. `end-state`：`decided` / `insufficient-evidence` / `escalate-value-choice`

## 约束

- 只读：不写仓库、不 commit、不装依赖、不联网抓资料。
- 不要相信文档里的行号/字段名；以实际读到的代码为准，给出路径。
- 不要复述计划；只写会改变实现决定的内容。
- 不要重新讨论 IA 或 Delivered 定义（已定），除非你发现它们与新计划直接冲突。
