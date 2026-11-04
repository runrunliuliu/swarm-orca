# runit 模板（未安装、默认停用）

这是固定 DAG Supervisor 在独立 Server 所在 Linux 的部署源，不是 strict TUI monitor / scheduler 的服务模板，也不是安装脚本。模板存在不证明已安装、注册或启动。`run`/`finish`/`log/run` 的 `/REPLACE/...` 必须由操作者替换为批准的远端持久路径；不要把本机目录或临时目录当作部署目标。

## 安装前逐项确认

1. 完成 [Supervisor 手册](../docs/supervisor.md#配置与部署前置条件)的试点范围、预算、宿主驻留、模型认证和持久存储检查；从实时查询复制目标 ID。
2. 把源码安装到专用只供受信操作者维护的目录，其根目录直接包含 `supervisor/`；配置、状态、证据、日志分开放置。状态/证据/日志目录为 tiger 所有、0700，配置0600。不要授予 Worker 写入 Supervisor 源码、配置或状态的权限；同 UID 下这些隔离仍依赖可信 Agent 的契约，不是 OS 安全边界。
3. 核验 Python 3.10+（启用 Trae 精确目录自动信任则需 3.11+）、`sudo`、`sv`、`chpst`、`svlogd` 可用；模板与已有服务一样由服务管理器切到 tiger，`sudo -n -H -u tiger` 必须非交互可用。非 root 服务管理器的部署需另行审查身份切换方式，不直接原样注册。Trae 的主机/账号/配置位置和单写入者要求见 [启动前登记说明](../docs/supervisor.md#trae启动前自动登记精确工作目录)；仅安装 Sidecar 不会替本机或所有目录授予信任。
4. `run` 和 `finish` 中的源码/配置路径必须一致。独立 Server CLI 固定从配置读取；模板清除桌面路由、Agent 身份及 Python 路径覆盖，使用独立 Server profile。不要将任何终端的身份变量或凭据复制进服务模板。
5. 将 `log/config` 复制为实际 **日志目录** 内的 `config`，不是仅放在服务的 log 子目录；轮转为每份约1 MB、保留10份。日志私有，不配置网络转发。该值是模板默认值，可在审批时调整。
6. 仅对部署副本设置 `run`、`finish`、`log/run` 可执行；注册专用服务目录，保留 `down` 文件。runit 仍会启动附属 logger，因此先配置日志目录。不得改动现有 Orca Server、训练或巡检服务。
7. 先运行 `validate --live` 做[配置检查](../docs/supervisor.md#离线配置检查)；它不连接 runtime 或核验真实授权。由操作者在已核验的独立 Server 启动真实 Coordinator，完成一次 init/step/checkpoint，再经批准启动 Supervisor。服务本身不会启动初始 Coordinator。

不要把以上清单当作已批准的安装命令。实际路径、服务名称、初始 Agent、认证以及 A1 时间窗口须在具体部署中确认。

## 重启与停止

`run` 只运行 Python Sidecar。`finish` 调用 `supervisor.service_finish`，在私有状态库中累计异常退出，与原生读取失败共用失败计数；退避10/20/40/80/160/300秒并封顶，达到配置 max_failures 后熔断。成功 tick、进程重启或新 goal 不重置失败数。辅助程序等待状态锁至多300秒；不能安全记账就停止重启。

正常退出0、冲突退出3、安全退出78以及已暂停状态不自动重启。状态库损坏、配置变化或权限错误同样停住，不删除数据库自愈。`finish` 必须从服务目录执行 `sv down .`，所以辅助程序的 cd 位于子 shell；仅让 finish 非零退出并不能阻止 runsv 重启。参考 [runit 官方 runsv 文档](https://smarden.org/runit/runsv.8)。

完成目标时 Sidecar 保持低成本待机；策略暂停时也可保持进程在线，status 才是判断是否允许新派发的入口。停止 Sidecar 不取消 Worker；不要误把停止服务当成释放资源。人工维护先执行 [Supervisor 手册的 pause](../docs/supervisor.md#提问证据与暂停)，然后按已批准的服务路径停止；恢复只解除 operator 暂停，不清安全熔断或预算。

`down` 文件保留时，新启动的 runsv 不会自动启动本服务；当前 runsv 可由明确 `sv up <已批准服务目录>` 启动。开机自动启动须在 A1/A2 和宿主条件核验后另行启用，不能把源模板的存在当成常驻已经部署。

此模板只恢复 Sidecar 进程。同一 Coordinator PTY 的正常回合续接由 Watchdog 处理；Coordinator/Server 身份变化或丢失回执进入人工恢复，不创建替代 Coordinator、不重放未知操作。
