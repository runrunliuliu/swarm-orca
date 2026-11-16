# swarm-control-plane 产物

这是 `swarm/deploy/publish_control_plane.py` 发布的**不可变控制平面产物**，不是一个开发检出。
身份（来源 commit、`dirty`、`copyRuleVersion`）在 `.swarm-build.json`，逐文件摘要在 `MANIFEST.sha256`。
默认部署用 `current` 符号链接指向当前产物（本机是 `/opt/swarm/current`，产物根可配置）；产物只读、
可回滚：不要就地修改，重发是新建目录。

本文件的链接按**产物布局**书写（源码仓库里对应的文件在 `swarm-orca/` 下，路径少一层 `code/`）。

| 路径 | 内容 | 怎么用 |
| --- | --- | --- |
| `code/` | 启动器、协议、工具、文档、角色技能、安装与发布脚本（= 源码的 `swarm-orca/swarm/`） | 从 [code/AGENTS.md](code/AGENTS.md) 开始；能力与入口总表 [code/README.md](code/README.md)；文档 `code/docs/`；符号位置 `code/ORIENTATION.md`；技能 `code/skills/` |
| `code/deploy/` | `install.sh`（新主机唯一该记的命令）、`publish_control_plane.py` | 默认只读；`--apply` 才发布并切指针，属于单独授权的部署动作 |
| `private/` | 私有政策、`acceptance.md`、模型/runtime/Worker 白名单与台账政策 | 由部署方读取；不是公开示例，也不随公开代码发布 |
| `overlay/` | 私有技能入口材料 | 安装时按部署策略链接，不由本产物安装 |
| `workspace/` | 工作区级指引、索引与目录策略 | 复制到目标工作区后按**该工作区**的相对路径读取（其链接指向工作区的 `swarm/`、`swarm-orca/`） |
| `NOTICE.md`、`MIGRATION_STATUS.md` | 许可证边界与迁移状态 | 边界说明，不是运行状态 |

找不到的目录就是没有：产物里没有上游 `orca/` 快照、没有 `tests/`、没有源码私有目录 `swarm/`。
需要它们时回到源码检出，不要在本机其它路径或全盘 `find` 里找。

发布、切指针、部署与重启服务各自需要授权；产物存在不等于已部署、已验收，也不构成启动 Agent 的依据。
