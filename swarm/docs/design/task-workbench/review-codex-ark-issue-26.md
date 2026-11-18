# 只读评审：issue #26 视觉返工（codex-ark，2026-11-18）

这是 `codex-ark` 终端对提交 `b98133fe`（§7.4.2 视觉返工）的**只读**评审原文，由评审者自己写入
`/tmp/codex-ark-review-26.md`，随后原样归档到这里。评审方式：只读 `git show` 与工作树文件，
不修改仓库、不 commit、不装依赖、不跑 harness。

证据边界（评审者自己声明，未改动）：本机没有 `orca/node_modules`，因此没有执行 TypeScript
type-check、vitest、Electron 渲染 harness 或截图；实际执行的是 `node --check run.mjs`、一次只在
内存里的 derive 探针，以及文件一致性检查。所以这份评审是**静态阅读结论**，不是渲染验收。

处理结果与两轮回执见设计文档 §7.4.3 / §7.4.4；第一轮四处必修与第二轮三处收尾分别落在
`f5988872` / `e24d3ba9`。下面保留原文（含结论"需要返工"的上下文，便于后来者判断它当时针对的是
哪个版本）。

---

# Issue #26 只读评审

评审对象：`b98133fe6564462358c826c82732bd8840ccc82c`。先读取了 `git show b98133fe --stat` 和 `git show b98133fe`，再静态检查相关组件、数据投影、join、测试和渲染 harness。检查时 HEAD 对应该提交，仓库工作树干净；没有修改仓库文件、安装依赖、创建分支或 commit。

验证边界：本机没有 `orca/node_modules`，未执行 TypeScript type-check、vitest、Electron 渲染 harness 或截图验证。`node --check orca/tests/tools/task-workbench-rendered/run.mjs` 通过；另对 harness 的派生源码做了仅在内存中的最小执行探针，复现了下文的 `tokenRows` 初始化顺序错误。这不是实际渲染验收。

## 1. 数据规则

结论：静态阅读没有发现 F8、未知 token 或三个空态的数据语义被此次视觉改动破坏，但需要保留针对这些规则的回归证据。

- `orca/src/renderer/src/components/task-workbench/TaskWorkbenchAgentRow.tsx:70`：Delivered / Failed / Cancelled 仍由 outcome 决定，没有把"停止运行"或缺失 outcome 推断成成功，F8 的关键语义保留。具体改法：不改当前判断；补整行渲染断言，覆盖有成功 outcome、有失败 outcome、无 outcome 的结束记录，防止后续改文案时重新混淆运行状态和交付结果。
- `orca/src/renderer/src/components/task-workbench/TaskWorkbenchAgentRow.tsx:122`：未知 token 时，数值和前面的分隔符一起不渲染；实测为零的 token 可以显示，和"未知不是 0"一致。`:128` 的数值现在缺少单位或可访问标签。具体改法：为已知数值加 token 含义的可访问标签或 tooltip，不要为未知值恢复一个空列或 `0`。
- `orca/src/renderer/src/components/task-workbench/TaskWorkbenchSpend.tsx:108`：`unavailable · disabled` 等内部原因组合已经退到 `title`，正文使用 `statusWord`，本次检查没有发现其他 JSX 正文继续直接输出这组内部 token。具体改法：保留正文友好状态词；如果 tooltip 面向普通用户，也应翻译原因，把原始 token 留给诊断信息。同步修正 `orca/src/renderer/src/lib/task-workbench/task-workbench-usage-status.ts:11` 等仍声称原因原样显示的旧注释。
- `orca/src/renderer/src/lib/task-workbench/task-workbench-join.ts:34`：归档工作区仍不参与活跃 agent 和 delivery 的聚合。`orca/src/renderer/src/lib/task-workbench/task-workbench-usage.ts:49`：禁用、远端和匹配歧义仍提前返回 unavailable；无匹配 provider session 走 `no_matching_session`，不是伪造用量零。具体改法：保留这些数据分支，补"0 工作区 / 仅归档 / 远端"三组组件断言，明确区分真实的工作区数量 0 和没有证据的 token、费用 0。当前只能给静态结论，不能称真实渲染已验收。

## 2. 结构风险

结论：当前嵌入 GitHub 对话框的路径基本能承接删掉 Header 后的信息，但"所有入口都已承接"说得过满；更需要优先处理实际窄列里的身份信息挤压。

- `orca/src/renderer/src/components/github-item-dialog/open-dialog/github-item-dialog-issue-header.tsx:141`、`:153`：issue 外层仍有标题、编号和已接线的打开工作区操作；`orca/src/renderer/src/components/task-workbench/TaskWorkbenchDelivery.tsx:147` 的 PR 摘要在折叠后仍保留，折叠的是正文。当前生产调用见 `orca/src/renderer/src/components/github-item-dialog/github-item-dialog-orca-tab.tsx:83`，没有发现独立的 local / no-tracker 面板生产入口。因此没必要恢复整套重复 Header。
- `orca/src/renderer/src/components/github-item-dialog/open-dialog/github-item-dialog-pr-header.tsx:107`：PR 外层提供的是从 PR 启动工作区，并不等价于打开已关联工作区。`orca/src/renderer/src/components/task-workbench/TaskWorkbenchPanel.tsx:65` 附近的新结构也不再独立呈现旧 Header 的 no-tracker identity 徽标。具体改法：收窄 Panel 注释及设计文档 §7.4.3 中关于"外层已经提供 identity / 主操作"的表述，明确当前成立的是嵌入 GitHub 的入口；未来如果增加独立入口，再由该入口补最小身份区，不要直接恢复重复标题。
- `orca/src/renderer/src/components/task-workbench/TaskWorkbenchPanel.tsx:92`：双列时 Agents 在左，Workspaces 和 Facts 在右；`:103` 单列时按 Workspaces → Agents → Facts 排列，Facts 内是 Usage → Delivery。`task-workbench-layout.ts` 的 `<1100` 单列、`<480` 紧凑及各 facts 降级阈值没有被此次修改。静态上没有发现这次重排倒置 §7.3.1 的主要牺牲顺序；不建议为了截图直接调整这些阈值。
- `orca/src/renderer/src/components/task-workbench/TaskWorkbenchWorkspaces.tsx:115`：工作区身份是 `min-w-0 flex-1 truncate`，而 `:123` 的整组 host / PR / status / default 元信息是 `shrink-0`，外层又有 `overflow-hidden`。长主机名、状态或多项元信息会先把身份挤没，尤其面板刚进入双列时，右侧列并不宽。具体改法：按实际列宽允许次要元信息换行或截断，给身份保留可读宽度，完整内容仍可查看；不要只按整个面板是否超过 1100 判断宽裕程度。
- `orca/src/renderer/src/components/task-workbench/TaskWorkbenchAgentRow.tsx:93`：名称可收缩，`:102` 的 badge 虽设 `max-w-[45%]`，仍继承 Badge 的 `shrink-0`；`:109` 的状态及 `:141` 的按钮也不收缩，整行不换行。具体改法：让次要 badge / 状态先让位或进入第二行，保证名称仍可辨认；用长 agent 名、长分支名及双列边界宽度做 fixture。这里目前是明确的布局风险，不是假称已经看过截图确认溢出。

## 3. 类型、React 与运行风险（按确定性及发生可能性排序）

1. **确定的 harness 运行错误。** `orca/tests/tools/task-workbench-rendered/run.mjs:191` 在 expectedTestIds 推导中读取 `tokenRows.length`，但 `tokenRows` 到 `:235` 才声明。对派生源码的内存探针直接得到 `ReferenceError: Cannot access 'tokenRows' before initialization`。具体改法：把 `tokenRows` 声明移到第一次使用之前。顺带修正 `:252` 的 `archivedVisibleCards`：compact 已显示归档行，预期却还只在 full 下计数，应从实际 visibleWorkspaceRows 推导；`:209` 的 secondary toggle 预期也应区分 compact 的 `+N` 文本与可点击展开控件，补 compact + 多工作区用例。`node --check` 通过仅表示语法可解析，不能发现这种执行顺序错误。
2. **确定的测试期望漂移。** `orca/src/renderer/src/lib/task-workbench/task-workbench-join.test.ts:235` 仍期待 `['feature/one', 'feature/two']`，`:254` 仍期待裸分支名；但 `task-workbench-join.ts:63` 已返回 `${repoName} · ${branchName ?? worktreeName}`，相关 fixture 的 repoName 为 `web-app`。具体改法：更新为带仓库名的期望，并补 branchName 优先、缺失时回退 worktreeName、不泄漏目录路径的用例。这里是静态确定的期望不一致，vitest 本机未运行。
3. **禁用操作的说明可能实际上不可发现。** `TaskWorkbenchAgentRow.tsx:134`、`TaskWorkbenchWorkspaces.tsx:173`、`TaskWorkbenchSpend.tsx:214`、`TaskWorkbenchDelivery.tsx:118`、`TaskWorkbenchPanel.tsx:65` 使用 disabled Button 的 title 解释未接线或不可用；而 `orca/src/renderer/src/components/ui/button.tsx:8` 包含 `disabled:pointer-events-none`，禁用按钮也不是正常键盘焦点目标。具体改法：继续保持按钮禁用，把说明挂在能接收 hover 的 wrapper / tooltip trigger 上，并提供可访问描述；必要时显示短说明。不能以"title 存在"作为用户能看到原因的证据。
4. **时间显示会固定成"刚刚"，主要是继承问题。** `orca/src/renderer/src/components/task-workbench/TaskWorkbenchAgentRow.tsx:65` 的 now 来自 finishedAt / startedAt，`:121` 又调用 `formatStartedAgo(now, now)`，有效时间戳总得到刚刚。旧实现也存在自锚定时间，不能全算成此次回归。具体改法：生产注入真实时钟、fixture 注入固定时钟；无时间证据时省略，不要把刚刚当作实际相对时间。

没有静态确认的新 TypeScript 编译错误：当前 AgentDotState switch 覆盖其枚举；JoinWorktree 从 TaskWorkbenchWorkspace 继承 branchName；Button 的 xs、Badge 的 hostContext、AgentIcon 的导入和用法均找到对应支持。但这不等于 type-check 已通过，也不能替代 React 实际渲染检查。

## 4. 文案与语言回退

结论：`New workspace / 新建工作区` 和 `Usage / 用量` 比原文案更贴近这里的动作和信息范围；状态与证据动作还有几处可以更准确。新 key 英文回退可作为明确记录的阶段性取舍，但既有翻译 key 不会随之自动更新。

- `orca/src/renderer/src/i18n/locales/en.json:17548`、`zh.json:17387` 附近的 `Spend.statusWord`：Not enabled / 未启用可以保留；Ambiguous 建议改为 Multiple matches / 匹配不唯一；No session 建议改为 No matching session / 未找到匹配会话，避免把"没有匹配到"说成"会话不存在"。
- 同处 `AgentRow.state.*`：Failed / Interrupted 及对应中文基本成立；"无最近更新"可改为"暂无最近更新"。如果 sessionBoundary 对应的是状态无法确认，应使用"状态待确认"之类措辞，不能把会话边界统一解释成仅仅更新陈旧。具体改法：让状态文案与投影中的原因一一对应，避免友好化时改变含义。
- 同处 `notWired`："尚未接线 / Not wired in this build yet"偏工程术语。建议"此版本暂不支持 / Not available in this version"；与第 3 点一起，让说明真正可发现。
- 同处 `Delivery.read` / `notRead`：Read 容易像普通阅读动作，建议"读取证据 / Load evidence"；notRead 建议"尚未读取 / Not loaded"，明确这是尚未加载证据，而不是没有交付证据。
- 同处 `Workspaces.create` / `Spend.heading`：保留"新建工作区 / New workspace"和"用量 / Usage"。`orca/src/renderer/src/i18n/locales/zh.json:17420` 的 PR open 状态仍是"打开"，建议改成"开放中"，或在业务语境准确时用"待合并"，避免和打开页面的动作混淆。
- `orca/src/renderer/src/i18n/i18n.ts:57` 配置了英文回退。英文 TaskWorkbench 正式 catalog 和运行时必需 catalog 逐叶比较无差异，新增 key 的回退机制有静态依据。es/fr/ja/ko 暂时不新增翻译可以接受，但应明确这是过渡方案。
- es/fr/ja/ko 的旧 key 仍存在：tokens 仍带 tokens / jetons / トークン / 토큰，count 仍带 en total / au total / 全…件 / 총…개，Spend heading 仍是 Gasto / Dépense / 費用 / 経費。这些不会触发英文回退，因此"纯数字、紧凑行、Usage"并没有同时覆盖六种语言。具体改法：优先同步这几个影响布局和语义的既有格式模板；至少在 §7.4.3 中明确当前视觉规范化主要覆盖 zh/en，不要把仅删除死 key 描述成其余语言也已完成适配。

## 5. 补真实渲染截图前最该修的三件事

1. **先把证据链修到可运行、预期一致。** `orca/tests/tools/task-workbench-rendered/run.mjs:191`、`:209`、`:252`：修 tokenRows 声明顺序及 compact 的展开 / 归档预期；`orca/src/renderer/src/lib/task-workbench/task-workbench-join.test.ts:235`、`:254`：更新 repo + branch 期望并增加回退、不泄漏路径的测试。否则即使装好依赖，首先遇到的也是工具自身错误或旧断言，而不是有效视觉结果。
2. **保护窄列中的身份信息。** `orca/src/renderer/src/components/task-workbench/TaskWorkbenchWorkspaces.tsx:115`、`:123` 和 `TaskWorkbenchAgentRow.tsx:93`、`:102`：先让次要元信息截断 / 换行，保留工作区名与 agent 名的可读性；fixture 增加长 host、长状态、长分支及刚进入双列的尺寸。不需要推倒布局方案或改整套阈值。
3. **让禁用原因真的能被看到。** `orca/src/renderer/src/components/ui/button.tsx:8` 及 `TaskWorkbenchAgentRow.tsx:134` 等调用点：不要依赖 disabled Button 自己的 title，改用可交互的说明承载元素和可访问描述，同时把 notWired 改成用户语言。这是实际操作解释缺失，不只是截图美观问题。

测试新增与执行分开说明：本次只读评审没有新增测试；实际执行的是 run.mjs 语法检查和内存派生源码探针，未执行 type-check、vitest、Electron harness、真实截图或全量测试。仓库检查前后均干净。评审采用 worktree-delivery 技能中的只读审查与证据区分要求，没有执行集成、部署或清理。

总体判断：**需要返工——不是重做视觉方案，而是先修确定的 harness / 测试问题及窄列、禁用说明缺陷，再补真实渲染证据后合并。**
