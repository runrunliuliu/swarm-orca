# MVP 策略与权限边界

## 事实与职责

原生 Run/Task/Dispatch 是唯一生命周期事实。Supervisor 的 SQLite 仅存策略、不可变契约指纹、操作意图/回执、费用、证据索引和暂停；不是另一套任务完成状态。终端 title、静默、心跳、超时、UI 可见性都不证明任务完成或进程死亡。

Supervisor 只读取原生状态、同身份唤醒 Coordinator；所有 Task/Worker/Inbox 变更由真正的 Coordinator 发起。Coordinator 不替 Worker 改代码。实施 Worker 只修改契约 allowed_paths，禁止改 do_not_touch；并行任务所有权不重叠，即使各有 worktree。现有工作区的其他写入者必须在启动前排除。

Review 必须 fresh Agent、只读；报告/测试输出可写入批准的 artifact_dir。需要实际运行另一提交时，预先批准在独立 scratch 中只读材料化待审版本的方法；不能在审核时私自 cherry-pick 到共享分支或改源码。集成必须位于已批准的 exact 工作区，在独立审查通过后串行进行；设计冲突退回人工/Coordinator，不擅自改变接口。

## 固定 DAG 和生命周期

报告与回执归档遵循 [产物归档规则（私有部署）](configuration.md)：默认远端根目录为 `/mnt/hdfs/user_dir/`，本地为可选副本。MVP 的 `artifact_dir` 须在首次初始化前明确配置并核验；已有配置不变，不将状态数据库迁入产物归档目录。

实施并发最多2，总并发显式配置，Review/Integration 也计数；Integration 与其他 Worker 不并行。最终 Integration 必须传递依赖所有任务。任务契约按拓扑序固化，native Task 延迟到上游验收通过才创建，不用 Orca 的 completed 直接放行业务验收。

Worker 按 live preamble 发一次带明确 outcome 的 worker_done，然后 idle。完整处理 Delivery；reply/ack/release 都写操作日志。结算后先保全 SHA、patch、测试、Review 证据，再释放精确 Dispatch，最后 ack。release_pending/unknown 不等于释放成功，禁止用 terminal close 替代。

未知/缺失 fleet、不明身份或 unverified liveness 不触发补发。原生错误回执保存 failedStage/residualResources，人工按版本匹配的恢复命令处理。MVP 不自动 retry、retain、stop、abandon 或生成返工 Task；返工需要另行批准的计划和控制器扩展，不能偷偷重置失败任务。

## 不可自动扩大范围

禁止训练、生产部署、修改现有巡检/定时任务、外部通知、发布公开产物、主分支推送、安装补丁/重启 Server，以及新 Coordinator 身份接管。配置授权布尔值是操作者确认记录，不代替运行时审批或操作系统权限。

任务范围内可作决策的问题由 Coordinator 回复；需人类批准的持久记录 human 状态，只阻止依赖它的工作。任何人工答复也不能通过 within_scope 标签把新范围塞入旧不可变目标。要扩展任务，先保全并结算现有工作，再走单独授权流程。

## 预算与恢复

所有启动/唤醒先预留，未知实际费用持续计入。单次 Run 与服务累计限额、周期窗口、时长和失败次数持久保存。服务失败退避10/20/40/80/160/300秒封顶；成功不清零失败计数。达到 max_failures 熔断；重启也不能绕过人工暂停或服务熔断。

预留限额是 admission control，不是 provider 硬账单/每请求 token 限额。实际超预留时全服务暂停新派发；不会自动中止正在运行的模型。源码与运行状态必须分离，凭据不入仓库/清单/日志，导出分享必须人工脱敏。

只允许恢复同一 Run、handle、PTY incarnation、consumer generation 和同一已批准配置。已收原生回执只用于修复本地索引；无回执的 intent 不重放。进程崩溃不意味着操作没执行，新身份不能继承旧权限。安全暂停没有快捷 reset；禁止直接改 SQLite 或创建新状态目录规避限制。
