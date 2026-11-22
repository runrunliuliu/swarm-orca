# 发布说明（生成式）

本目录的文件由 `swarm/generate_release_notes.py` 从 `git log --first-parent --merges` 生成，
**不手写**。一个文件对应一个 git 区间（通常是一次部署所基于的范围），一个 PR 一条记录。

```bash
cd swarm
python3 -B generate_release_notes.py --range <from>..<to>            # 只看，不写
python3 -B generate_release_notes.py --range <from>..<to> --write    # 写 docs/release-notes/<date>-<sha>.md
python3 -B generate_release_notes.py --check                         # 全部已提交文件与历史一致？
```

`--check` 会从文件里的 `- range:` / `- date:` 行重新生成一遍并逐字节比较，不一致退出 2。
它由 `tests/core/test_generate_release_notes.py` 覆盖，所以漂移在离线回归里就会失败，
不依赖谁记得更新。

## 为什么是生成而不是手写

同一批事实已经存在三处：提交正文（动机、边界、`Refs #issue`）、设计文档自己的状态段、
部署方的私有部署记录（真正知道线上是哪一份构件）。手写清单只会是第四份副本，
而且是唯一没人重新推导的那份，所以它最先过期。

## 本文件不声明什么

- **不声明 `deployed` / `verified`**。线上是哪一份构建取决于构建与重启，git 看不到。
  每条记录的状态只有 `merged`；`deployed <buildId>` 与验收结论留在部署方的私有记录里，
  用构建 id 回链。
- **不声明是否进了服务构件**。`orcad` 服务端 bundle 与 renderer 是同一个仓库的两个产物：
  2026-11-20 实测一个只动 renderer 的 PR（`942f41d9`）重建出**逐字节相同**的服务构件。
  因此任何动了 `orca/` 非 renderer 路径的 PR 都记为 `需构建比对`，
  只有完全没有这类改动时才写 `不进`。
- **不声明 PR 标题**。GitHub 的合并提交只记录编号与分支，不记录标题；标题取该 PR 最早那条
  提交的 subject（通常是分支的主改动），其余提交原样列在明细里。

## 起点与不回溯

目录从 2026-11-22 开始记录，首个文件覆盖 `c692b58d..ba78a850`——即第一次确认部署并核验过的
构件所对应的源码范围。更早的 PR 不回溯补写：`git log --first-parent --merges` 是它们的事实来源，
补写只会制造一份无法校验的二手清单。
