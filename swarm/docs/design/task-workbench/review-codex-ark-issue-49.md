# 只读评审：issue #49 交付后归档（codex-ark，2026-11-20）

这是 codex-ark 对 `c692b58d..a1dbb15b`（issue #49 实现提交）的**只读**评审原文，结论“通过，无必修项”。
评审通过一次 read-only 的 reviewer 运行（`codex exec -s read-only -C <worktree>`，评审配置见
`<reviewer-profile>`，`model_reasoning_effort=high`），沙箱为 read-only：评审者没有修改仓库、提交、
建分支、装依赖或启动应用。报告原文未改写，只把绝对工作区路径前缀换成仓库相对路径（`orca/src/...`），
并把本地的 reviewer profile 名称换成 `<reviewer-profile>`；其余包括评审者自带的 `:行号` 后缀
一并保留（行号指向 `a1dbb15b`）。

处理结果见 [README §7.12.3](README.md) 的“只读评审”段：4 条建议全部处理——`<self>` 替换规则写进指令、
`worktree-delivery` SKILL §5 增加 Task Workbench 限定、补 sidebar 勾选透传与启动 prompt 两条回归用例、
修正 README 的 A4/A6 编号与两处“最后一步”措辞。

证据边界（评审者自己声明，未改动）：只做了限定范围的 `git diff`/`git show`、源码与文档阅读、`rg`
残留检索和只读 Node JSON 校验；未运行 vitest、typecheck、localization validator 或渲染驱动，
未做真机交付与 PNG 视觉核验。

---

通过——限于 `c692b58d..a1dbb15b` 的代码评审，未发现需要阻断本次修改的确定性缺陷；这不等于 A1–A6 已完成真实环境验收。

## [必修]

无。下面几项是指令可靠性、回归覆盖和文档准确性的改进建议，不将尚未发生的 agent 行为推测列为缺陷。

## [建议]

1. **明确 `<self>` 的替换规则，避免把占位符当作 CLI 别名。**  
   [task-workbench-deliver-launch.ts:162](../../../../orca/src/renderer/src/lib/task-workbench/task-workbench-deliver-launch.ts:162) 新增的是 ``orca worktree archive --worktree <self> --json``；而 [selectors.ts:159](../../../../orca/src/cli/selectors.ts:159) 只对 `active/current` 作特殊解析，`self` 不是受支持的自身别名。  
   指令已有 `Workspace: ${workspace}`，第 7 步也早已使用同一占位惯例，因此不能据此断言 agent 一定执行失败。更稳的小改法是明确说明：将 `<self>` 替换为上方工作区的、正确引用的完整 `id:<repoId>::<path>`，不得照抄尖括号，也不要依赖执行过程中可能变化的 cwd。

2. **把“报告后归档”与必读 skill 的通用收尾顺序对齐。**  
   [SKILL.md:116](../../../skills/worktree-delivery/SKILL.md) 仍写着 “then archive … and report it as retained”；新指令则要求 “only after the report above”，失败后又要求 “say so in the report”。任务专用指令可以覆盖通用流程，所以不是确定性冲突，但建议在 skill 增加 Task Workbench 的限定说明：**先发送交付报告，继续执行一次归档；失败则补发提示，不改交付结论**。不要泛化修改所有交付场景。  
   同时，[launch.ts:150](../../../../orca/src/renderer/src/lib/task-workbench/task-workbench-deliver-launch.ts:150) 的 “This is the only place delivery writes state” 宜限定为“写入交付完成状态”，因为 archive 本身也写 `isArchived`。

3. **补一条 sidebar 勾选归档的回归测试。**  
   [WorktreeContextMenu.deliver-order.test.tsx:505](../../../../orca/src/renderer/src/components/sidebar/WorktreeContextMenu.deliver-order.test.tsx:505) 当前提交用例明确断言 `archiveAfter: false`。它证明 sidebar 调用了 launcher，但不能单独证明 checkbox 的 `true` 沿该入口传递。建议增加勾选后提交、断言 `archiveAfter: true` 的用例，并在 launcher 测试中核对实际交给 `launchAgentInNewTab` 的 prompt 含报告后的归档步骤。生产接线正确，缺口在回归覆盖。

4. **修正文档中的验收编号与“最后一步”残留。**  
   [README.md:1222](README.md) 写 “A4/A6 需真机”，但本 issue 的 A6 是四个反向 pin 改写及单测全绿，真机隐藏／恢复／PTY 属于 A4。建议明确区分 issue #49 与旧方案各自的 A 编号。  
   此外，[README.md:1112](README.md) 的“交付 agent 最后一步”以及 [delivery-completion-plan.md:116](delivery-completion-plan.md) 的“指令最后一步”仍指向 `worktree set`；勾选归档后已不准确，宜改为“交付完成状态写入步骤”。

## [已确认]

- **A1/A2/A3：指令层面成立。**  
  [launch.ts:153](../../../../orca/src/renderer/src/lib/task-workbench/task-workbench-deliver-launch.ts:153) 先要求三段报告，第 162 行才追加第 8 步，且明确写 “only after the report above”。未勾选分支保留 “Do not archive, remove, stop terminals or delete anything”，不加入归档命令。勾选分支明确要求 “do not retry it” 和 “do not treat the delivery as unfinished”。全局失败停条件没有授权失败后继续写入；末尾归档失败的具体条款也没有要求把交付判失败。**这些是 prompt 约束，不是实际执行保证。**

- **A4：既有接口契约支持，但真实行为未验收。**  
  [worktree-archive.ts:30](../../../../orca/src/cli/handlers/worktree-archive.ts:30) 的 archive handler 调用 `worktree.set` 写入 `isArchived: true`；unarchive 写 `false`，没有调用 `worktree.rm`、`scripts.archive` 或停止终端。此次 diff 未改这些接口。它支持“保留 checkout/PTY、可恢复”的静态判断，但不能替代行消失、恢复及 PTY 存活的真实验证。

- **A5：两个入口共享执行路径，sidebar 参数没有丢失。**  
  [worktree-context-menu-deliver.ts:391](../../../../orca/src/renderer/src/components/sidebar/worktree-context-menu-deliver.ts:391) 将 `archiveAfter: value.archiveAfter` 传给共享 launcher；[launch.ts:285](../../../../orca/src/renderer/src/lib/task-workbench/task-workbench-deliver-launch.ts:285) 把 `buildTaskWorkbenchDeliverInstruction(input)` 作为启动 prompt。因此新方案不再依赖 issue 弹窗上的消费者。

- **A6：四个反向 pin 已改写，不只是单纯反转断言；本次未独立确认单测全绿。**  
  [launch.test.ts:148](../../../../orca/src/renderer/src/lib/task-workbench/task-workbench-deliver-launch.test.ts:148) 增加报告／命令顺序及非致命失败措辞检查；第 236 行覆盖三个布尔值的八种组合，检查未勾选无命令、勾选后命令在报告之后。旧行号 101／147／220 对应的三处测试，以及 [plan.md:278](delivery-completion-plan.md) 的文档 pin 均已更新。它们仍不能证明 agent 实际报告顺序或归档失败处理。

- **删除与改动边界完整。**  
  [Orca tab:126](../../../../orca/src/renderer/src/components/github-item-dialog/open-dialog/github-item-dialog-orca-tab.tsx:126)、[import-boundary.test.ts:78](../../../../orca/src/renderer/src/components/task-workbench/task-workbench-import-boundary.test.ts:78) 与 launcher 已去掉旧挂载／依赖／record。检索未发现代码、测试、渲染驱动中的有效残留引用；文档命中均标为历史机制或已删除。README 规则 1–7、PR／主检出限制、一个写者逻辑、完成投影均未被改动。未发现 `orca/` 层重排、改名或无关修改。

- **i18n 本次增量自洽，但不代表所有目录原本完全同键。**  
  [confirm.tsx:371](../../../../orca/src/renderer/src/components/task-workbench/task-workbench-deliver-confirm.tsx:371) 的 fallback 与七个 JSON 中的新 hint 完全一致，均为 “The delivery agent archives this workspace after it reports; find it again under Show archived.”；七处 `archiveFailed` 均已删除。逐文件对父提交的内存校验通过：整个 JSON 除这两项外无变化。`zh.json` 的 hint 仍是英文，但父提交也已是英文，不能算本次新引入的翻译退化。

## 证据边界

实际执行了限定范围的 `git diff`／`git show`、源码及指定文档阅读、`rg` 残留检索，以及只读 Node JSON 校验。

- `git diff --check c692b58d..a1dbb15b`：退出 0。
- 根目录及 `orca/` 下 `git status --porcelain`：均为空。
- 七个 JSON 对父提交的增量校验：7/7 通过。全子树同键检查曾发现如 es 缺少 `notRead/notWired/read`；父提交对照确认这些不是此次增量。
- 使用了 `worktree-delivery` skill 核对报告、归档与验收边界，没有执行交付动作。

**未运行 vitest、typecheck、官方 localization validator 或渲染驱动**；文档所载“21 文件／380 用例全绿”不是本次独立复验结果。未启动应用、运行真实 agent、注入归档失败，或验证隐藏／恢复／PTY 行为。PNG 查看工具不支持当前会话，故只审了对应 HTML，未完成图片视觉核验。

全程未修改文件、提交、建分支、安装依赖或改变运行状态。
