# orca-server：runit 服务定义与安全重启

状态：**服务定义由 git 维护，主机值只在本机的 `/etc/orca-server.env`**。适用于用 runit 跑 headless
`orcad` 的 Linux 主机；Electron `--serve` 不在本目录范围内。

## 文件

| 文件 | 作用 |
| --- | --- |
| `run` | runit 的 `run` 脚本。**不含任何主机值**：读取 `$ORCA_SERVER_ENV_FILE`（默认 `/etc/orca-server.env`），解析产物目录，exec `bun-runtime orcad.js`。 |
| `restart` | 安全重启 helper。默认按 `status → term → 等 PID 退出 → 清 crash 窗口 → up → 等 readiness → 校验指针/CLI` 执行；`--check` 只读。 |
| `orca-server.env.example` | 主机值的模板（账号、路径、绑定地址、指针路径、bootstrap 产物）。 |

## 安装（每台主机一次）

```bash
# 1. 主机值：复制模板，填好，root-only
sudo install -d -m 755 /etc
sudo install -m 600 orca-server.env.example /etc/orca-server.env   # 然后编辑
sudo chown root:root /etc/orca-server.env

# 2. 服务定义：直接装 git 里这一份
sudo install -m 755 run /etc/sv/orca-server/run

# 3. 只读检查（不改服务状态）
sudo ./restart --check
```

`restart --check` 会报告：`sv status`、**安装的 run 与 git 里的是否逐字节相同**、env 文件是否可读、
指针与 `.orca-build.json` 是否一致、`orca --version --json` 是否与指针一致。它不需要服务已重启。

## 产物解析顺序（fail-closed）

1. `$ORCA_BUILD_POINTER_PATH`（默认 `/opt/orca/current`）存在 → 用它的真实路径（`readlink -f`）。
2. 否则用 `$ORCAD_ARTIFACT_DIR`（bootstrap：全新主机还没有"正在服务的构建"去发布指针）。
3. 两者都没有，或目录缺 `.version`/`orcad.js` → 打印原因并 **exit 78**（配置错误，不要重试）。

没有"随便找个旧目录"的第三条路：那正是这套机制要消灭的行为。

## 重启（以及为什么不能直接 `sv restart`）

```bash
sudo ./restart            # 安全重启 + 校验
sudo ./restart --check    # 只读
```

两个真实的坑：

- **SVDIR**：`sv` 在它自己的 SVDIR 里找服务。直接 `sv restart orca-server` 会回
  `unable to change to service directory: file does not exist`——看起来像"没生效"，实际是"没动"。
  runit 的 runsvdir 目录通常是 `/etc/runit/runsvdir/default`（helper 的默认值，可用 `SVDIR=` 覆盖）。
- **TERM 不转发**：run 进程是 `sudo -n -H -u <user> env …`，`sv restart` 的 TERM 停在 sudo 上，
  run 进程可能还活着；runsv 的 `finish` 把这次退出记进 **5 次/300 秒** 的 crash 窗口，够 5 次就
  `sv down`，服务会一直躺着。helper 改为 `term` → 等 PID 真正退出 → 清 `restart-window` → `up`，
  并且 `up` 后等 readiness（`finish` 在非主动退出后会 sleep 10 秒，run 进程会晚一点出现）。

## 回滚

回滚 = 让指针回到旧产物，再跑一次 helper（服务定义不用改）：

```bash
# 旧产物仍在 /opt/orca/<old-artifact>；把指针指回去，或写进 env 的 ORCAD_ARTIFACT_DIR 并删掉指针
sudo ln -sfn /opt/orca/<old-artifact> /opt/orca/current
sudo ./restart
```

生产部署习惯上把改动前的 `run` 留一份 `run.bak-<timestamp>`；本目录不再需要它承载主机值，但仍建议
保留最近的 `run.bak-*` 作为"服务定义出错时"的快速对照，而不是作为回滚开关。

## 排障

| 现象 | 判定 / 处理 |
| --- | --- |
| `run` 退出码 78 | 配置：env 缺失/缺变量、产物目录不合格、或存在全局 IPv4 且 `ORCAD_REFUSE_IPV4=1`。看日志首行文字。 |
| `sv status` 显示 `down … normally up` | 看 `finish` 的 crash 窗口与 `/etc/sv/<svc>/restart-window`；修好原因后 `sudo ./restart`。 |
| 服务起来但 `--version --json` 报 `source=local-package` | 指针缺失/损坏；用 `restart --check` 看 `pointer.state`。 |
| 服务跑的是 A、裸 `orca` 报 B | 指针与服务定义不一致：`restart --check` 同时打印两者，指回同一份产物。 |
| 日志里 `build pointer not published: EACCES` | 服务账号对指针父目录无写权限（见版本指针文档的"部署前提"）。 |

## 边界

- 本目录只放**形状**：不含主机名、账号、端口、配对地址或任何凭证；这些只在 `/etc/orca-server.env`。
- 它不是部署授权：装服务定义、重启服务、改指针都需要单独授权。
- 证据（每次部署的命令/输出/回滚引用）写进任务归档，不写进本仓库。
