# AGENTS.md — 控制平面 code/

本目录是控制平面产物的 `code/`，也是源码仓库里的 `swarm-orca/swarm/`：**同一份文件、同一套相对路径**。
下面是**按本目录书写**的路径，两种情况都成立，不要先到主机别处搜索。

## 先读什么

| 要解决什么 | 读哪 |
| --- | --- |
| 任务身份、工作区隔离、何时不召集 Agent、三条互斥执行路径 | [entry paths](docs/entry-paths.md) |
| strict 启动、握手、阶段与 owner、槽位 | [protocol](strict-bootstrap-protocol.md)、[strict start](coordinator-strict-start.md)、[operator prepare](operator-prepare.md)、[runbook](operator-runbook.md) |
| 符号在哪一行 | [ORIENTATION.md](ORIENTATION.md)：符号 → 文件 + 行区间，`generate_orientation.py --check` 与代码不一致即失败 |
| 能力与入口总表、边界 | [README.md](README.md) |
| 测试与验收口径 | [reliability](docs/testing/reliability.md)、[strategy](docs/testing/strategy.md) |

## 目录

- 本目录顶层 `*.py` 平铺同级，按裸模块名 import；相邻的 `*.json`（`worker-model-profiles.json`、
  `coordinator-model.json` 等）是运行时输入，不是示例。
- `docs/` 文档（`entry-paths.md`、`testing/`、`design/`、`measurement/`）；`skills/` 角色技能；
  `deploy/` 安装与发布；`supervisor/`、`swarm_ledger/`、`release_radar/`、`field-guide/` 是带 `__init__.py` 的子包。
- 不在本目录、也不在产物里的：上游 `orca/` 快照、`tests/`、私有政策 `swarm/`（产物里对应 `../private/`）。
  **找不到就是没有**，不要用 `find /` 兜底。
- 产物根的 `../private/`、`../overlay/`、`../workspace/`、`../MANIFEST.sha256`、`../.swarm-build.json`
  由部署方读取；源码检出里没有同名目录。

## 技能

| 任务 | 入口 |
| --- | --- |
| Orca worktree、终端、repo、handoff | `orca skills get orca-cli` |
| 原生消息、Task、Dispatch、生命周期 | `orca skills get orchestration` |
| 受监督 Swarm 准备、Coordinator 循环、恢复与记账 | [swarm-orchestration](skills/swarm-orchestration/SKILL.md) |
| strict software-development-v1 范围、进度与证据 | [software-development](skills/software-development/SKILL.md) |
| 审查、合并、可选部署与 worktree 清理 | [worktree-delivery](skills/worktree-delivery/SKILL.md) |

前两项由所选可执行文件按版本输出，本目录不复制其命令手册。访问被拒或连接失败就停止相关操作并报告原始错误：
不自动提权、不切换 runtime、不重启服务。

## 发布与部署

- `deploy/install.sh` 是新主机唯一该记的命令：默认只读，`3` 表示有待执行的变更，`--apply` 才发布并切指针。
  发布、切指针、重连技能、部署与重启服务各自是单独授权动作。
- `deploy/publish_control_plane.py` 只复制、哈希、记录，从不启动 Agent、Run、monitor 或服务。
- 本目录的文档按**产物布局**书写；发布工具会拒绝任何仍指向产物中不存在的 `orca/`、`swarm/` 顶层的文档
  （`source-layout-link`），所以不要写“到源码仓库根才有”的相对链接。

## 索引与搜索

`ORIENTATION.md` 是生成的（`python3 -B generate_orientation.py --write`，`--check` 拒绝漂移）：先用它回答
“在哪”，表里没有再去 grep，读到行区间后仍要打开源码确认。同一任务上，给了这条指针的会话比没有的少约
四成符号搜索、约四分之一的模型回合（口径见 [measurement](docs/measurement/orientation-pointer.md)）。

## 测试（仅源码检出）

`tests/` 只在源码检出里，产物不带测试。源码检出中：

```bash
tests/run_blast.sh --range HEAD~1    # 默认：本 diff 能影响的模块
tests/run_offline.sh --modules a.b   # 点名模块
tests/run_offline.sh                 # 全量（可选的整体信号，不是每次改动都跑）
```

如实报告跑了什么：定向跑是定向结果，只有真正跑完全量才能说 offline PASS。

## Claims

写明验证了什么、用什么命令、得到什么答案。helper 成功、文件存在、离线测试通过都不是实机验收结论；
被跳过、被阻断或未知的步骤要说出来，不要省略。
