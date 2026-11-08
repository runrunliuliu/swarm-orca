# Sparse 任务工作区：M3 启动就绪门禁（最小版）

状态：M3 最小版实现契约。基于 M1/M2（创建期校验）、M4 最小止血（失败不删、只读对账）、
M5 最小绑定（`WorktreeMeta.sparseTaskBinding`）。它只做"未就绪不得被启动"，不含会话迁移、
不写工作区、不自动修复。

## 1. 为什么不能沿用创建时的判定

创建时判定（M2）要求 `HEAD == pinnedSha`。启动时该等式必然会被打破：Agent 会在工作区里提交，
这正是任务在推进。因此 M3 把判定拆成两套口径：

| 阶段 | 判定 | 目的 |
| --- | --- | --- |
| 创建（M2，已实现） | cone 在 pinned tree 成立、创建后 `HEAD == pinnedSha`、cone 生效、必需路径可读 | 能否发布成功 |
| 启动（M3，本契约） | **pinnedSha 是 HEAD 的祖先**、cone 仍覆盖请求、必需路径仍可读、binding 摘要有效 | 能否继续使用 |

"祖先"而不是"相等"：允许在工作区里提交、允许 rebase 到同一基线之后的分支；不允许 HEAD
脱离基线（换成无关历史、reset 到别处、检出别的分支）。

## 2. 强制点

门禁是 `assertTaskWorkspaceLaunchableFor({ store, workspace })`，在"解析出工作区之后、真正
spawn 之前"调用。当前接入：

| 调用点 | 覆盖的启动 |
| --- | --- |
| `orca-runtime-create-terminal.ts`（后台分支） | 创建期 startup/setup/defaultTabs 终端、CLI 终端、worker 启动等所有走 runtime 的终端 |
| `orca-runtime-create-terminal-desktop.ts` | 渲染进程负责 spawn 的桌面终端 |
| `orca-runtime-create-agent-session.ts` | Agent 会话创建/恢复（会新 spawn 的路径） |
| `orca-runtime-run-create-mobile-session-terminal.ts` | 移动端会话创建（直接请求渲染进程建标签页） |
| `orca-runtime-split-pty-backed-terminal.ts` | 终端分屏（直接 `ptyController.spawn`） |

不放在 `resolveTerminalWorkspaceLaunchScope` 内部：该方法也被只读解析复用，裸拦会误伤不产生
进程的查询。创建期 `spawnLocalStartupAndSetupTerminals` 通过 `runtime.createTerminal` 间接覆盖；
runtime-owned 移动端会话走 `this.createTerminal`，同样覆盖。

接入点按"会不会新 spawn 进程"逐个核对，而不是只看调用链名字：只要绕过 `createTerminal` 直接
spawn 或直接请求渲染进程建标签页，就必须单独接门禁。

## 3. 判定顺序与失败语义

1. 读 `WorktreeMeta.sparseTaskBinding`：**没有该字段 → 直接放行**（legacy 全量、legacy sparse、
   外部创建的工作区都没有，拦它们等于破坏既有会话）。
2. 有字段但读不出来（键集不符、digest 不符、schema 未知）→ 拒绝，`reason=binding_invalid`。
3. 远端工作区（`connectionId` 存在）→ v1 跳过：探针必须跑在工作区所在主机上。
4. HEAD 读取失败 → `unverified`；`merge-base --is-ancestor` 退出码 1 → `not_ready`，
   其它错误 → `unverified`。
5. cone 读取失败 → `unverified`；请求的目录未被覆盖 → `not_ready`。
6. 必需路径：缺失 → `not_ready`；无法确认（权限/IO）→ `unverified`。

统一错误码 `sparse_task_start_gate_failed:<reason>`，三种 `reason` 分别对应"记录被改/工作区漂移/
无法证明"，因为它们导向不同的处置动作。**不降级为普通 shell**：可启动的判定失败即拒绝，
否则一个坏工作区仍能继续被提交。

## 4. 成本与范围

- 每次启动：1 次 `rev-parse HEAD`、1 次 `merge-base --is-ancestor`、1 次 `sparse-checkout list`、
  最多 N 次 `stat`（N=声明的必需路径数，上限 256）。无缓存：cone 与文件可在 HEAD 不变时变化，
  只按 worktree+HEAD 缓存会给出错误答案。
- 只覆盖本地创建工作区；SSH/WSL 未接入（与 M2 的能力名边界一致）。
- 不拦：纯 reattach、只读解析、没有绑定的工作区。

## 5. 只读状态（同一个判定的第二种输出）

门禁抛出异常只适合"要不要继续启动"；人需要的是"现在到底怎么了"。因此同一套探针还有一个
不抛错的形态：

```text
orca worktree show --worktree <selector> --json
  → taskWorkspace: { state, reasons[], pinnedSha?, head?, checkedAt }
```

| state | 含义 | 来源 |
| --- | --- | --- |
| `unbound` | 该工作区没有绑定（legacy 全量/legacy sparse/外部创建） | 无 `sparseTaskBinding` |
| `ready` | 绑定可读，HEAD 含基线，cone 覆盖请求，必需路径可读 | 三项探针全部通过 |
| `drifted` | 有已证明的漂移（脱离基线 / cone 不覆盖 / 声明路径缺失） | 任一探针给出确定失败 |
| `unverified` | 无法证明（HEAD/cone/路径读不出、目录不在） | 任一探针不可读 |
| `not_probed` | 有绑定，但本机无法探测（远端工作区） | 按范围决定跳过，不代表失败 |

规则：**已证明的失败优先于不可读**——`drifted` 不会被另一个盲探针降级为 `unverified`；
而目录根本不存在时判 `unverified`（可能是未挂载，不是被改写），且不再把"所有声明路径都缺失"
当成漂移。`unbound` 不是任务工作区的状态，而是"任务契约从未适用"的答案，客户端据此可以完全不显示。

放行规则必须与报告一致：门禁放行 `ready`、`unbound`、`not_probed`，拒绝 `drifted`、`unverified`、
`binding_invalid`。这四类不能混用——`not_probed` 表示"没测"（远端按范围决定跳过），
`unverified` 表示"测了但证明不了"，后者属于拒绝。

实现落在 runtime 的 `inspectTaskWorkspaceReadiness(selector)`，由 `worktree.show` 附带返回；
只读、不写、不修复，取 `checkedAt` 为本次探测时间。人类可读输出由 `orca worktree show` 末尾一行
`taskWorkspace: <state>` 展示，`--json` 给完整 `reasons`。

## 6. 与其它阶段的关系

- 绑定由 M5 在**创建成功时**写入；失败创建（`needs_reconciliation`）没有绑定，因此不会被门禁
  当成任务工作区，仍需按[对账手册](sparse-task-workspace-reconciliation.md)人工处理。
- 门禁不写、不修、不扩 cone、不回退全量；它只回答"现在能不能启动"。
- 完整 M3 仍缺：把判定结果暴露给 UI/CLI（可读的状态而不是异常栈）、缓存与失效策略、
  跨宿主探针、"启动被拒"后的恢复指引。

## 7. 已知缺口

- 只有本地主机；远端工作区被跳过而不是被验证。
  **范围决定（2026-11-08）：短期不做跨宿主。** 探针必须跑在工作区所在主机上，而当前只有本机
  git/stat 能力；在需要之前，远端工作区保持"跳过门禁"而不是"用本机探针假装验证过"。
  WSL 同理按 fail-closed 处理。
- 未做 live Agent 闭环验收：门禁在真实创建→启动链路上的行为只有单元级证据。

## 8. 本轮测试证据

- `orca/src/main/ipc/sparse-task-start-gate.test.ts`：15 passed（含只读状态的 unbound/ready/
  drifted/binding_invalid/远端 unverified/目录不在判 unverified/已证明失败优先）（真实 Git：放行无绑定、拒绝坏绑定、
  放行基线祖先、Agent 提交后仍放行、拒绝脱离基线/cone 不符/必需路径缺失、不可读记 unverified、
  远端跳过）。
- 相关面合计 31 文件 / 331 tests passed；只读状态接入后 CLI + RPC 面 249 文件 / 2477 tests
  （仅 2 个既有 SQLite/orchestration 失败，基线同样失败）。
- 全 `src/main/runtime` 批跑出现 57 个失败，均在 orchestration/SQLite 域；
  抽样 3 个文件在未含本改动的基线上同样失败，属既有环境问题（node 22 vs engines 24、实验性 SQLite）。
- 未跑：Electron/E2E、真实 Agent 闭环。
