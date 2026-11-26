# 搜索纪律：只在当前 worktree 内递归，绝不向上

状态：**已实现（决策表 + 两个工具 + 文档 + 运行侧 hook），未做 live 验收**。本文不授权部署、不授权
启动 Agent，也不改变任何 gate、协议或证据要求；它只约束"怎么找上下文"这一件事。

## 1. 问题

Agent 把"我要找上下文"变成对**工作区根目录**的递归搜索：根上挂着二十多个 checkout，每个都有一份
`orca/`（带 `node_modules` 符号链接）和 `swarm/`，而一次递归遍历在 NFS4 挂载上等于逐条元数据走网络
（`acregmin/acregmax/acdirmax=30`）。

之前记录的真实案例（脱敏）：一个 Worker 为找自己的 dispatch 上下文执行了
`grep -rl "<dispatch-id>|<task-id>" ~/.local/state/orca-server <workspace-root>`，跑了 28 分钟没有结果，
token 几乎不动，最后只能 `worker-abandon`。它要的信息是 `worker-show --dispatch <id>` 一条原生查询。

**本机复核（2026-11-26，同一挂载、同一工作区，26 个 checkout）**：

| 做法 | 结果 |
| --- | --- |
| `grep -rl --include=*.py worker-show <workspace-root>` | 25 s 未返回（`timeout 25` 杀掉，exit 124） |
| `rg -l --max-depth 8 -g '!node_modules' worker-show <workspace-root>` | 20 s 未返回（exit 124，被杀前已输出 123 条） |
| `git grep -l worker-show -- '*.py'`（**单个** checkout） | 0.07 s |
| `rg -l --max-depth 6 -g '!node_modules' worker-show .`（**单个** checkout） | 0.26 s |

单个 checkout 的数字是热缓存下的，冷缓存接近之前记录的 3.3 s；差别不在工具，在"扫了几个 checkout ×
多少目录项"。结论是一句话：**在 worktree 内限深搜索可行，跨 checkout 递归不可行。**

## 2. 规则（只有一条）

> **递归搜索（`grep -r` / `rg` / `find` / `fd`）的目标必须全部落在当前 worktree 内。**
> 边界是 `cwd` 的 git 顶层；不在 checkout 里时就是 `cwd` 本身。

配套的三条快速形态（拒绝时也回这三条）：

| 要找什么 | 用什么 |
| --- | --- |
| 代码里的串 | `git grep -n <pattern> -- '<glob>'`：只读 tracked、有索引、天然 repo 内 |
| 想用 rg 的过滤能力 | `rg -n --max-depth 3 -g '!node_modules' -g '!.git' <pattern> <worktree 内路径>`，或 `fast_search.py <pattern>`（两个边界都带上，并把耗时打到 stderr） |
| dispatch / task / worker 状态 | `orca orchestration worker-show --dispatch <id>` / `task-list`：这是 RPC，不是文件 |
| 某个符号在哪一行 | [ORIENTATION.md](../../ORIENTATION.md)（生成物，`--check` 与代码不一致即失败） |

**这不是权限边界，是效率约定。** 判定失败一律放行（fail-open）：命令解析不了、模块找不到、超时，
都不拒绝调用。任何权限、写入范围与证据规则仍按各自入口原样生效。

## 3. 四层落点

| 层 | 落点 | 作用 |
| --- | --- | --- |
| 文档层 | 根 `AGENTS.md`「Search: inside this checkout, never above it」、[swarm/AGENTS.md](../../AGENTS.md)「索引与搜索」、[swarm-orchestration](../../skills/swarm-orchestration/SKILL.md) §4 与 brief 要求 | 首回合就读到；brief 里显式写规则，与 hook 是否在场无关 |
| 工具层（决策） | [search_guard.py](../../search_guard.py) | 纯函数 `evaluate(command, cwd, root)` + CLI；判定表就是代码，测试在 `tests/core/test_search_guard.py` |
| 工具层（拦截） | agent 运行侧 hook `~/.pi/agent/extensions/swarm-search-guard.ts`（**不进本仓**，见 §5） | 拦 `bash` 工具调用，把拒绝原因与三条改写回给模型 |
| 环境层 | 仓库根 `.ignore`（`node_modules/`、`.git/`、`orca/out/`、`orca/dist/`、`*.png`） | 让 `rg` 默认跳过，不必每次记 `-g` |
| 快的那条路 | [fast_search.py](../../fast_search.py) | 一条命令带上 scope + 排除 + 耗时，brief 可以只允许"它或 `git grep`" |

`grep -r`、`find` 不看 `.ignore`，所以环境层只能降低 `rg` 的成本，规则的执行仍靠工具层。

## 4. 判定表

`search_guard.evaluate()` 的答案（与 `tests/core/test_search_guard.py` 一一对应）：

| 命令（cwd 在 `/ws/checkout`） | 结论 | 原因 |
| --- | --- | --- |
| `ls -la`、`git status`、`git grep -rn x -- '*.ts'`、`rg --version` | allow | 不是递归搜索工具 |
| `grep -n pat file.md` | allow | 非递归（无 `-r`/`-R`） |
| `rg -n --max-depth 3 -g '!node_modules' -g '!.git' pat .` | allow | 目标 `.` 在 worktree 内 |
| `grep -rl pat swarm/docs`、`find . -name '*.py'`、`fd -e py pat src` | allow | 目标在 worktree 内 |
| `fd pat /tmp` | deny | 目标在 worktree 外 |
| `rg -l --max-depth 8 pat /ws`（workspace 根） | deny | 目标在 worktree 外（深度不豁免） |
| `grep -rl pat ~`、`rg -l pat $HOME`、`rg -l pat $UNSET` | deny | `$HOME` 展开后越界；变量无法解析时不猜 |
| `sudo -u root rg -l pat /ws`、`xargs -0 rg -l pat /ws`、`bash -lc 'rg -l pat /ws'` | deny | 包装词与内层 shell 会被拆开后再判 |
| `cd /tmp && rg -l pat` | deny | `cd` 之后边界跟着走，默认目标 `.` 变成 `/tmp` |
| `rg -l pat .`（cwd = 装着多个 checkout 的工作区根，边界=自身） | deny | 这一层不回答任何问题（见下） |
| `rg -l pat my-checkout`（同一 cwd，点名一个 checkout） | allow | 单棵树搜索 |

最后一条是这次事故的形状：**边界自身不是 checkout、却装着别的 checkout 时，搜索这一层也被拒绝**，
因为答案在某个 checkout 里，不在这层目录上。范围外的另一个 checkout（`rg -l pat ../other`）同样拒绝。

## 5. 运行侧 hook 的对应关系

与 [对端等待设计](pane-handoff-wait.md) §P6 的先例一致：拦截实现属 agent 运行侧
（`~/.pi/agent/extensions/`），**不进本仓**；本仓只保证"决策表 + 测试 + 文档"一致。

- hook 只做三件事：过滤 `bash` 调用里像递归搜索的命令、把命令文本交给
  `search_guard.py --cwd <cwd>`、把 `deny` 转成 `{block: true, reason}`。判定逻辑不在 hook 里，
  避免两份实现漂移。
- 模块解析顺序：`$SWARM_SEARCH_GUARD_MODULE` → `$SWARM_CONTROL_PLANE/code/search_guard.py` →
  `/opt/swarm/current/code/search_guard.py` → 从 `cwd` 向上 5 层找 `swarm/search_guard.py` 或
  `code/search_guard.py`。都没有就放行。
- 关闭开关：`SWARM_SEARCH_GUARD=0`（人用；不写进拒绝文本，避免模型自己关掉）。
- 成本：只有出现 `grep|rg|find|fd|ag|ack` 的命令才起进程；本机实测 `python3 -B search_guard.py`
  中位 36 ms（`cwd` 本身是 checkout 根时不额外起 `git rev-parse`）。

## 6. 不做

- 不改 NFS 挂载参数（属运维，不在仓库范围；`acdirmax` 是否可调小由主机策略决定）。
- 不改 agent 的模型或 effort 选择。
- 不动 `orchestration` 协议、gate 或 dispatch 语义。
- 不为"更快"放宽任何证据要求：搜索纪律是效率约定，不是权限边界。

## 7. 验收状态

| issue 的验收项 | 状态 |
| --- | --- |
| 1. 跨 worktree 递归搜索被拒绝/改写，单 worktree 的 `git grep` / 限深 `rg` 仍正常 | **离线已覆盖**：`tests/core/test_search_guard.py`（拒绝 + 改写三条 + 白名单不被拦）、`tests/core/test_fast_search.py`；hook 侧用真实 `search_guard.py` 跑过 9 个用例（放行 5 / 拒绝 4），未在真实 pane 里加载 |
| 2. 一次真实 Worker 任务：brief 带纪律 + hook 后首回合不再跨 checkout，总墙钟不高于改动前 | **未做**：需要另获授权的 live Run 与改动前对照，本文不给结论 |
| 3. `ORIENTATION.md` 的符号查找路径被至少一条 brief 显式引用 | **模板已带**：[swarm-orchestration](../../skills/swarm-orchestration/SKILL.md) §4 的 brief 要求与本节表格；真实 brief 文本可 grep 检查。已发出的历史 brief 未改 |
| 4. 文档规则与工具白名单不冲突 | **离线已覆盖**：判定表里 allow 的行就是文档推荐的三条形态，测试逐条断言不被拦 |

已知缺口（如实记录）：hook 在 `~/.pi/agent/extensions/`，不随本仓发布、不由 `install.sh` 安装；换宿主需要单独放置。
工作区根（本仓上一级）的 `.ignore` 属宿主状态，本次未改，内容按 §3 环境层那行照放即可。
