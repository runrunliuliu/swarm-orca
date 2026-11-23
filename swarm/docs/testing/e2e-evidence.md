# E2E 证据与交付契约

本文约定**本仓 E2E 用例交付什么证据、按什么形状交**。它不改 E2E 的入口判据：`orca/tests/e2e`
只承接单测到不了的跨层行为（真指针/拖拽、IPC、PTY、持久化、多窗口），能写成 store-slice 单测的
不进 E2E。本文也不改 `orca/AGENTS.md` 与 `orca/tests/e2e/AGENTS.md`——那是上游快照，仓级约定写在这里。

配套：[orca test runs](orca-test-runs.md)（怎么在本机跑）、[reliability](reliability.md)（Swarm 验收口径）、
[AGENTS.md](../../AGENTS.md)（本层指南：测试与验收口径的入口；两套布局下都指向 `swarm/` 层这一份）。

**布局差异要分清**：blast radius、红测试不得回退共享检出、证据归档落盘这些规则在**仓根
`AGENTS.md`**（仅源码检出，产物里没有它；产物根只有 `code/AGENTS.md`，也就是本层的
`swarm/AGENTS.md`）。所以本文**不给仓根写相对链接**——那会在产物里成为断链，只在正文里点名章节。

Agent / 多 Agent 的自动操作、截图取证与独立验收 Agent 的实施路线见
[端到端验收框架开发计划](agent-e2e-development-plan.md)；计划不代表已实现。

## 0. 一句话

**断言负责拦回归，证据负责让人 30 秒内做判断。** 截图存在不等于通过；稳定环境下预先固定的
视觉断言可以参与判定，但不能替代行为与运行事实检查。

分层关系先钉住：本文的 A/B/C 是**触发方式与产物维度**，与 `reliability.md` 的 D/I/L
**不是一一对应**。截图或“真 agent 跑通一次”不等于 Swarm L 闭环，更不等于核心 suite PASS。

## 1. 三条 lane，三种产物

“选中 / 执行 / 阻塞合并”是三件事，先分开说清：

- **选中**：由源路由与文件自身变更决定（§6）。
- **执行**：workflow 决定跑哪些；本检出没有 `.github/workflows/`，因此**本次未核验**执行侧接线。
- **阻塞**：当前 E2E 对合并是 **advisory**，`orca/config/scripts/pr-e2e-gate-contract.test.mjs`
  用一条断言把这个选择固定为“有意为之”。本文**不升级**任何门禁。

| lane | 触发 | 产物 | 图的角色 |
| --- | --- | --- | --- |
| **A `gate`** | 由选测与实际执行入口决定；不由本文升级门禁 | 断言红绿 + 失败时 trace/screenshot（`orca/tests/playwright.config.ts` 现为 `only-on-failure`） | 单有图不算通过；可有固定视觉断言 |
| **B `evidence`** | `ORCA_CAPTURE_EVIDENCE=1`，交付/评审时由人触发 | `pr-evidence/<slug>/`：manifest + 命名图 | 图就是交付物 |
| **C `real`** | 用例实际支持的 opt-in 开关，例如 `ORCA_PI_REAL_AGENT=1`；可能花钱 | transcript / 边界事实落盘 + 边界声明 | 验收 UI 时与 B 组合，保留关键截图 |

A/B/C 不是互斥执行模式；真实多 Agent 的可视化验收可采用 B+C。
开关需由对应执行器实际实现，通用命名不是已有统一入口。

三条硬规矩：

1. **A lane 的通过条件必须事先固定。** 自动视觉断言和 Agent 的截图意见分开记录，不因“图好看”覆盖行为失败。
2. **B lane 不进 CI 阻塞。** 一旦“每个 PR 必须交图”，图的产量会超过真相的产量。
3. **C lane 不登记就不写。** 没人注册的用例在哪台机器上都绿，静默腐烂；本仓已有同类教训与
   守卫（Windows lane 的 registration contract），opt-in 用例按同样思路登记“谁跑、多久一次”。

## 2. B lane 的产物形状

```text
pr-evidence/<slug>/
  manifest.json
  01-before-bulk-open.png   02-after-bulk-open.png      # 修缺陷：两个版本各一次 run
  03-scenario-bulk-open.png 04-scenario-long-name.png  # 场景表驱动的多场景
```

文件名 `<两位序号>-<before|after|scenario>-<场景 id>.png`，枚举与示例一致（没有 `empty`、
`with-data` 这类第四种前缀）。不要 `screenshot-<时间戳>.png`——名字里没有场景，图就只剩审美价值。

`manifest.json` 至少包含：

| 字段 | 为什么要 |
| --- | --- |
| `repoSha` + `dirty`（可还原补丁与未跟踪输入**两项都按实际记录**，无则显式为空，各附逐文件哈希并进归档索引） | 同一个 SHA 不能表示不同被测字节；两类输入同时存在时只记其一仍可丢字节 |
| `build`（产物路径 + 逐文件内容哈希，或不可变构建 pin；并记录它所绑定的源码快照） | 旧构建或非 `--mode e2e` 构建会让整轮结果失效；可变路径与构建时间都不是构建身份 |
| `command`、`lane`、`project`、`cwd` | 报告要可复制复跑，且能对上实际跑的那一层 |
| `platform`（OS / shell / viewport） | 跨平台图不并排比较：字体、分隔符、argv quoting 都不同 |
| `specs[]`、逐用例 `result`、`skipped[]` 与原因 | “跑过通过 / 跑过失败 / 未跑”不许并成一句 |
| 执行器 `retries`、attempt 序号/触发原因、spec 内部重跑清单（无则为空） | 不把隐式重试后的绿当首次通过；每次尝试均保留 |
| 每张图 `sha256` | 交付后能读回比对 |
| `notCaptured[]` | 图不能表达“没做”，用文字补上；写 `[]` 前先确认真的没有漏洞 |

规则：

- `notCaptured` 必填，且要能解释（例如“无权限入口未覆盖：需要第二个账号”）。
- 稳定性：`animations: 'disabled'`、固定 viewport。像素断言只在“图里是否真有东西”这类主张上使用
  （现有样例：`orca/tests/e2e/helpers/terminal-inline-image-proof.ts`），不要铺开成 flake 工厂。
- **落盘分两种**：只采测试所需的 env 白名单字段与 argv/stdin，采集时即排除凭据，私有原件按私有政策处理。
  真实会话/ID/截图等运行证据不进入公开仓；公开仓只放合成 fixture 与模板。对外分享脱敏摘要或图仍需授权。
  截图同样按敏感性处理（它会把界面上的路径、
  issue 标题一起带出去）。“当前没看到泄露”不构成公开原始运行证据的授权。
- **工作目录不是归档**：私有原件与脱敏报告都按私有政策归档，写清解析后的归档路径、实际承载文件系统
  （`findmnt -T`，不要用跟随软链的 `df`）、逐文件索引与读回哈希。规则见仓根 `AGENTS.md` 的
  Directory and artifact landing 与 `reliability.md` 的报告头要求。

## 3. fixture / stub 协议（“不需要服务端配合”的机制）

原理要写清楚，否则下一个人会把被测的东西也假掉：**假的是对端，不是被验证的那段代码。**
真渲染进程、真 IPC、真 PTY 照旧跑；只把“对外一跳”换成本地固定字节。

| 件 | 约定 |
| --- | --- |
| 假对端 | 一个 `PATH` 前置的可执行（或 `agentCmdOverrides` 覆盖），返回固定字节；保留 `.cmd`/POSIX 双形态与引号差异 |
| 观测通道 | 落盘 **env 快照 + argv + cwd + stdin 字节数/内容**；变量名不按 agent 特化；env 按白名单取字段并脱敏 |
| 场景表 | `SCENARIOS = [{ id, seed, payload, platforms }]`，`test.describe` 循环出用例；**在 B lane 的取证运行里，每个计划场景要么有图，要么进 `notCaptured`**（不向 A/C 扩张截图义务） |

- **文件报告是跨层补充证据，不是断言替代。** 最终 `expect()` 仍要面向用户可见的 DOM：
  不用 store 自证，也不用“报告里字段对”代替“界面确实这样”。这条是上游 `tests/e2e/AGENTS.md`
  的既有纪律，本文不放宽它。
- 观测通道要通用：不在 fixture 里硬编码某个 agent 的环境变量名，断言留在 spec 里。
  产品侧的投递通道本身按 kind 分派，夹具跟着分派就没有第二条通道能复用。
- 场景表驱动是为了强制难看场景在位：空列表、超长名、无权限、批量 500 条。手挑三张必然都好看。
- 采集了必须断言。只写 `<report>.stdin` 却不读它，等于“看起来有证据”。
- 新增一格是加一行表项，不是加一个 spec 文件。

## 4. 前/后对比与红绿证明

- 要区分两件事：**版本前后**（修复前/后两个提交）必须两次 run，两个 `repoSha` 都在 manifest 里；
  **同一版本内的操作前后**（点开前/点开后）可以在同一个 run 里截，那是状态变化，不是“伪前”。
- 只有把“同 run 两个提交的状态”当成修复对比才算伪前：那时修复已经在代码里了。
- 本仓禁止为拿红测试回退活跃共享检出（仓根 `AGENTS.md` 的 Tests 章节，仅源码检出：red test 要在隔离
  fixture/checkout 里做）。红证明的做法是在废弃 worktree 或临时 checkout 里对基线提交跑同一 lane B。
- 更强的证据是**“去掉那行修复即红”**：一次的因果，比两张图短，也比两张图硬。

## 5. 负向断言必写，但要先证明它有观察力

凡主张“没有重复投递 / 没有二次粘贴 / 没有多开一个 tab”，必须有负向断言，并**写在 spec 头注释里**：
这类事实在截图上完全不可见，而故障状态往往表现为一个**正常界面**（空输入框既可能是“还没开始
输入”，也可能是“brief 已经被丢了”）。

但负向断言本身可能空心，写的时候要交代三件事：

1. **观察窗口**：从何时到何时在收，窗口内被测路径确实被执行过。
2. **可达性**：这条通道真的能到达观测点。已知反例——假 agent 以 `node` 身份运行，而“粘贴前先
   确认前台是 pi”的门会在到达夹具前就拦掉，于是“stdin 零字节”永远成立、永远不能证伪。
3. **正向对照**：同一夹具在故障注入下能观测到非零（否则零字节只说明没观察）。

无法建立观察力时，**声明缺口**并指向承接它的单测，而不是写一条恒真的断言。

## 6. 可见性与注册

- **一条 spec 要声明它的“权威源”**：哪些源文件改坏了它应该红。该声明由
  `orca/config/scripts/pr-e2e-source-routing.mjs` 的 `PR_E2E_SOURCE_ROUTES` 消费；不登记就等于
  “只在有人手改这个 spec 文件时才会被选中”。
- 改这张表要同步 `orca/config/scripts/pr-e2e-gate-contract.test.mjs` 的路由回归（正例与反例），
  否则改表本身没有守卫。
- **opt-in 用例进 lane 表**（第 1 节规矩 3），哪怕只登记“谁跑、多久一次”。只能写“本检出内未见
  登记”，不能据检出推断外部调度。
- 分片按发现自动进行（`orca/config/scripts/ci-e2e-shard-plan.mjs`），新 spec 不需要手工入表；
  没有 timing 基线的文件按中位数估算（`ci-shard-assignment.mjs`），排程精度会偏，属可接受偏差。

## 7. 交付 checklist（按 lane 取用）

A（gate）：命令 + 断言清单（含负向断言名）+ 选中与未选中的范围及补验理由 + 实际耗时与 worker 数。

B（evidence）：命令 + manifest（§2 全部字段）+ 图 + `notCaptured` 的解释 + 归档读回哈希。

C（real）：命令与门禁变量 + transcript 路径 + 实际请求/尝试与用量的边界（花了什么、没做什么、未知项）；
不预设只会产生一次模型请求。

三条共用一句结论：做了什么、看到什么；缺“没做什么”的交付按“只看到它好了”处理，不按“修好了”处理。

## 8. 现状观察（2026-11-23，本仓快照 `main@779d0d32`；数字随合并变动，以命令输出为准）

复核命令（在 `orca/` 下）：

```bash
rg --files tests/e2e -g '*.spec.ts' | wc -l                       # 426
rg -l 'ORCA_CAPTURE_EVIDENCE' tests/e2e | wc -l                   # 2
rg -l 'test.skip\(!process\.env' tests/e2e -g '*.spec.ts' | wc -l # 1
node -e "import('./config/scripts/pr-e2e-source-routing.mjs').then(m=>console.log(m.PR_E2E_SOURCE_ROUTES.length))"  # 20
printf '%s\n' src/main/pi/prefill-extension-source.ts src/renderer/src/lib/swarm-launch-prompt.ts \
  src/renderer/src/lib/swarm-launch-prompt-delivery.ts \
  | node config/scripts/pr-e2e-source-routing.mjs                # []
```

- `tests/e2e` 426 个 spec；截图默认 `only-on-failure`。
- `ORCA_CAPTURE_EVIDENCE` 有 **2 处运行时判断**（`worktree-lineage.spec.ts`、
  `worktree-lineage-agent-expansion.spec.ts`），落盘目录写死 `pr-evidence/`，无 manifest。
- stub 三种形态：`helpers/golden-stub-agent.ts`（`agentCmdOverrides`，同时前置 PATH）、
  `github-created-issue-start-prefill.spec.ts`（内联 `installFakeCli` + stdout argv，含 Windows `.cmd` 分支）、
  `fixtures/pi-prefill-stub`（PATH 目录 + 报告目录）。三者是形态实例，不是互斥机制。
- `PR_E2E_SOURCE_ROUTES` 20 条；改 pi prefill 与 swarm 首条 brief 的权威源时选中为空数组，
  `--reusable-workflow` 为 `false`。workflow 执行侧未核验（本检出无 `.github/workflows/`）。
- `test.skip(!process.env…)` 形态只命中 **1 个 spec 文件**（`new-workspace-swarm-pi-real-agent.spec.ts`）；
  这不是全部 opt-in 用例数。

这些是“机制已有雏形、缺统一契约”的证据，不是缺陷清单。

## 9. 后续提案（均需单独授权，不是本文的现行要求）

1. **helpers**：`evidence.ts`（截图落盘、manifest、sha256、读回比对）、`fake-binary.ts`、
   `fake-binary-report.ts`（报告目录协议，按 cwd 关联到被创建的工作区）。
   收敛现有三套 stub **不是顺手改**：先列三者的可复用差异（PATH 前缀方式、Windows `.cmd`、argv 引号、
   报告格式），再定试点范围；改到 `orca/` 属于上游快照，按 narrow + tested fix 处理。
2. **接进触发链**：补一条 route + 同步 `pr-e2e-gate-contract.test.mjs` 的路由回归。
   本检出缺 workflow，因此“改了会真的跑起来”无法在此验证，只能验证选中函数。
3. **示范场景表**：一个 `agent × 投递通道 × 平台` 矩阵（列 OS/shell、支持与 skip 原因），
   每格一条用例、一张图或一条缺口。
4. **像素断言**只保留在必要处。

## 10. 边界

- 本文是约定，**不是**已实现：helpers 未抽取，manifest 未生成，`notCaptured` 尚无消费方。
- 不授权启动 Agent、写截图、改 CI workflow 或改 `orca/` 快照；也不把 E2E 从 advisory 升成阻塞。
- B lane 的运行预算（时长、机器）随场景表增长，是单独决策，不从本文推定。
