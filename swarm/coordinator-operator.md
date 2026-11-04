# 提交端 Operator 执行器（本地实现，未部署）

`coordinator_operator.py` 在[既有显式交接协议](coordinator-driver.md#提交端-operator-的显式交接)
上提供可选自动执行与等待。它不是第二个研究 Coordinator：只消费原 driver 固定的请求，
调用操作者预先审查的适配器，将证据送回**同一个 Coordinator** 决定继续、转向或收尾。
不解析 checkpoint 里的文字为 Shell 命令，不消费原生 Inbox，不接管 Run。

当前已实现通用 JSON 适配协议和离线验收，**未提供经过核验的 fin_verl/Merlin 平台适配器**。
没有部署常驻服务，也没有完成提交端离线、真实训练或无人值守验收。

原生 strict Coordinator 的常驻观察与事实回传使用
[Operator monitor](operator-monitor.md)，复用本执行器的只读适配器，不需要旧 driver。
下文仍是旧 driver 的提交协议，不因新增 monitor 而获得 strict 自动提交能力。

## 外层 Operator 的任务工作区准备

新的独立修改任务默认由外层 Operator 在启动 Coordinator 或派发实施工作前，
从目标仓库已确认基线创建并核验专属 Orca worktree，固定到任务交接；不是仅切换 Git 分支。
同一任务续作、修正、重试和恢复沿用原 worktree；只读任务不强制新建，用户指定已有
worktree 时优先遵从并核验。完整流程及边界见
[任务 worktree 准备规则（部署方提供）](configuration.md#部署政策与历史材料)。

这是外层操作者的启动前职责，不是本执行器的新功能；下述执行与恢复循环消费既有
Run/workspace 绑定，不自动创建 worktree，也不迁移现有任务。

## 外层 Operator 的独立 Coordinator 启动门

新监督式 Run 由外层 Operator 按[两阶段启动门](coordinator-startup.md)执行：先独立核验
Coordinator 实际会话，再由该 Coordinator 创建 Run；首批派发前核验 owner/generation，
最后 Coordinator 从自身上下文复查。不能由 Operator 自建 Run、先派发研究 Worker 再补
“Coordinator 汇总”。本地 `coordinator_launch.py startup-gate` 提供只读 Trae 检查入口，
不是本执行器的既有 Run 轮询功能，也不是 Orca runtime 已部署的强制派发拦截器。

新启动契约统一用 `coordinator_launch.py startup-contract` 生成 v2，
默认固定配置记录最大年龄与短期回执有效期为 1800/180 秒；
旧 v1/v2 契约保留原 pin 与时限，不自动迁移。将不依赖 readiness 的准备工作前置，readiness 证据审查完成后
立即 gate，成功后在回执期限内交由原 Coordinator 创建 Run。超时不自动重启/唤醒；
错误码、时限公式与恢复边界见[启动时序](coordinator-startup.md#固定错误与启动时序)。

## 执行与恢复

```text
原 Coordinator → driver 固定请求 → Operator 唯一认领
  → probe（完整用量、预留和占用）→ 原授权/预算检查 → 持久提交意图
  → execute（一次）→ queued/running
      ├─ completion=terminal → query 至终态 → 报告 → 原 Coordinator 审查
      └─ completion=background → submitted 回执 → 原 Coordinator 推进独立研究
                                 └─ 只读 query → 状态事件 → 原 Coordinator 审查
```

- 沿用 `outer_operator.id`、原请求/认领/结果收据；一个 driver 只能绑定一个固定 Operator
  配置，`operator.lock` 排他。手工已认领的动作不会被自动执行器接管。
- 每次调用前复核配置、适配器 hash、原授权与固定请求；认领/前台操作复用 driver 当前
  checkpoint 和只读原生身份核验。后台 query 复核历史 request/Job 与实时 owner/generation，
  不读取正在更新的模型 session log，不要求 next_action 仍等于原提交。
  缺少路由、权限拒绝、身份变化或畸形响应停止，不猜命令。
- `execute` 前持久化意图。进程中断或提交超时后只按相同 `operation_key` 查询，绝不重新
  调用 execute；即使查询为 not_executed，也只回传 Coordinator，不在执行器内重提。
- `wait` 从第一次起只 query，不 probe、不 execute；没有可精确查询的已审查任务绑定时，
  适配器必须返回 unknown，不能创建任务来完成“等待”。等待仍检查操作映射的用户权限。
- 已知 Job ID 不允许改变；queued/running 必须有 Job ID。未知/超时查询按 `max_unknown_polls`
  有界停止；权限、调用失败、协议错误不会当作超时自动重试。
- 报告发布后即使进程中断，恢复时回传同一报告；结果收据已存在时不重复回传。
  非未知报告进入原 Coordinator 的审查回合，失败也可用于选择下一研究方向。
- 遵守 driver 的 STOP、outcome 和 `operator-stop.json`；pending 禁止新认领/执行，但允许
  对历史已确认 Job 的只读 query。停止不取消或释放已有 Job；
  不承诺结果未知时无残留资源。STOP 后需归档的迟到结果可走原显式回传命令。
- 认领收据已发布、但执行器未持久记录其引用的极窄中断窗口仍要求人工核对；不冒领手工动作。
  未知回传、持久停止和配置变更也不自动解除，不删除状态或改 action ID 来绕过。

这些是受信单账号下的防重与恢复规则，**不是平台 exactly-once 保证**。适配器必须支持以
操作键精确查询（包括提交返回前崩溃、最终一致性、同键多 Job 的歧义）；查不到不等于未提交。

### 长任务提交确认与独立查询

`completion:terminal` 保留等待终态后回传的短操作语义。`completion:background` 在首次
获得 queued/running + 精确 Job ID 后立即发布 submitted 报告，不等待训练结束。
原 Coordinator 审查提交确认、保持训练路径 waiting，并在原授权和文件隔离下推进独立研究。
报告刚发布但 snapshot 未更新的中断从该固定报告恢复 Job ID，不再次 execute。

后台扫描覆盖全部历史 submitted 请求，不局限当前 next_action；每次 tick 对各活动 Job
最多 query 一次，再处理当前前台请求，不因只扫描第一个 Job 导致其他任务饥饿。
每次 RPC 仍有独立 timeout；tick 总时长随活动 Job 数增长。循环由用户授权的进程驱动，
本实现不安装常驻服务。后台观察链及 driver 消费规则见
[后台 Job 与业务并行](coordinator-driver.md#后台-job-与业务并行)。

queued/running/unknown 继续占用路径和资源预留；succeeded/failed 在 Coordinator 审查前也
保守保留预留。再提交前使用真实全 Run probe，并将本地未结算 Job 的预留合计作为占用/
Token/费用预留的下界（与 provider 声明取 max，不把同一预留相加两次）。同一路径未决时，
换 action 名也拒绝提交。缺少本地预留记录的手工/仅 query Job 不按零处理，拒绝新提交并对账。
实际费用高于预估的部分仍依赖真实 probe，不能据此声称平台级硬限额。

submitted 之后只允许 queued/running/unknown/succeeded/failed，不能改报 not_executed；
终态不可回退。状态未变不重复唤醒模型，unknown/timeout 连续达到上限或预算时间到期后，
该 Job 记为 `background_stopped`，保留 unknown 和资源，不持久停止独立研究路径。
计数先持久化，查询/事件发布间崩溃不重置恢复额度；耗尽后不再 query。
权限、身份、配置及协议错误仍由 CLI 持久停止整个执行器，不能伪装为可重试 unknown。
提交确认前的未知结果仍使用原全局停止/对账协议，不用未知 Job 来放行并行执行。

## 配置与启动边界

从[关闭的示例](coordinator-operator.example.json)准备私有配置；示例额度和时间不是授权。
所有 path 使用已审查、绝对、无符号链接的规范路径，sha256 为文件原始字节 hash。

| 字段 | 约束 |
| --- | --- |
| `schema_version` | 本版为 2；新 driver schema 6 从启动契约读取 CLI，历史 driver schema 5 保留原环境变量入口；Journal schema 3，不自动迁移 |
| `driver_binding` | 精确 driver 配置及 pin，沿用其 Run、Coordinator、会话、原始授权和角色 skill |
| `adapters` | 名称到已审查 Python 适配器 `{path,sha256}` 的映射，不从模型输出选择任意程序 |
| `routes` | 固定权限目录 path ID → `{operation,adapter,kinds,completion}`；completion 为 terminal/background，同一动作的所有路径必须选中相同 adapter 和 completion |
| `evidence_root` | 已存在，位于 driver 的 progress_roots 内，不能放在控制文件/授权输入目录；由操作者保护访问权限 |
| `budget.run_started_at` | 从原 Run 证据独立核对并固定；不晚于初始 checkpoint，重启不重置；本地时间约束不能认证真正的 Run 起点 |
| `deadline_at/max_tokens/max_cost_micro_usd` | 时间带时区，Token/费用上限为正整数；费用单位为百万分之一美元。null 仅表示无此本地上限，不代表无限授权 |
| `poll_seconds/rpc_timeout_seconds` | 1–60 秒，单次调用有界；排队等待不唤醒模型 |
| `max_unknown_polls` | 正整数，仅限制未知状态/超时的连续恢复查询，不限制正常排队总时长 |

配置不能放宽原账本中 bounded 的 Token 或时长上限；费用、时间起点、其他预算与适配器范围
仍须操作者独立核对。未填预算不自动表示获准花费。适配器必须限制参数、代码/数据范围、
平台权限、模型及资源选型，不能把“操作已列入 routes”当任意提交授权。

默认只检查离线输入，不查询 Orca/平台、不认领、不创建状态目录：

```bash
python3 -B coordinator_operator.py --config /absolute/private/operator.json \
  --config-sha256 REVIEWED_RAW_OPERATOR_CONFIG_SHA256
```

只有在独立完成任务授权、平台适配审查、技能读取和部署条件后，才能同时启用两个配置的
`enabled:true` 并加 `--execute --confirm-skill-read`。`--once` 只执行一次有界观察/动作，
不保证整项工作完成；无此参数则按轮询周期运行。先由 driver 初始化其私有 Journal，再启动
Operator；Operator 不借用 `ORCA_TERMINAL_HANDLE`，driver 仍须在原 Coordinator PTY 中运行。
`--confirm-skill-read` 是操作者完整读取目标角色技能及必需引用后的声明，不是程序认证。

## 适配器 JSON 契约

程序通过 stdin/stdout 交换单个严格 JSON 对象，禁止在 stdout 混入日志。执行器使用隔离
Python 子进程执行已固定的源码字节，不经 Shell、不加载该脚本的磁盘 pyc。这**不是沙箱**：
适配器、其依赖和调用工具均属审查边界；外部依赖未由本实现递归固定。凭据不得写入配置、
报告或响应。原生错误不得伪装为 succeeded/unknown；权限拒绝应非零退出，触发持久停止。

每个请求包含：

```json
{
  "schema_version": 1,
  "method": "probe | execute | query",
  "operation_key": "SHA256_OF_DRIVER_PIN_AND_ACTION_HASH",
  "binding": {"runtime": "…", "run": "…", "generation": 1, "terminal": "…", "incarnation": "…", "workspace": "…", "session": "…"},
  "action": {"id": "…", "owner": "outer-operator", "kind": "…", "path_ids": ["…"]},
  "authority": {"ledger": "…", "source_root": "…", "scope_id": "…", "handoff": "…", "path_catalog": "…"},
  "budget": {"run_started_at": "…", "deadline_at": null, "max_tokens": null, "max_cost_micro_usd": null},
  "job": null
}
```

上面省略号仅表示沿用 driver 的完整对象，不能照抄为配置。`action` 是原 next_action 全量数据。
`job` 为 execute/query 已观察到的固定 Job ID；首次 wait 或丢失提交回执时为 null，适配器需从
预审任务映射或 operation_key 精确定位，不使用 latest、名称模糊匹配或猜测。

`probe` **只读**响应，字段必须完整；用量涵盖整个 Run 的 Coordinator、Worker、失败尝试与
待结算资源，不是当前动作局部用量，未知不得填 0：

```json
{
  "scope": "EXACT_RUN_ID",
  "observed_at": "2026-10-22T00:00:00+08:00",
  "complete": true,
  "used": {"tokens": 0, "cost_micro_usd": 0},
  "reserved": {"tokens": 0, "cost_micro_usd": 0},
  "estimate": {"tokens": 100, "cost_micro_usd": 1000},
  "active_training_trials": 0,
  "training_slots": 1
}
```

非负整数且观察不超过 60 秒。提交检查 used+reserved+estimate 和
active_training_trials+training_slots；排队/启动中/运行中及未决资源均计入占用。
training_slots 只能是 0/1。观测本身不锁定资源：必须有全局唯一提交者或平台原子准入/
预留，否则并发提交会越限。它也不拦截 Coordinator/Worker 绕过此执行器的请求，不是
全局预算硬截断或自动取消；真实平台限额仍需独立配置。

`execute` 是**唯一允许外部变更**的方法；`query` 必须只读，不能隐含重新提交、取消或释放。
二者使用相同响应：

```json
{
  "operation_key": "EXACT_REQUEST_KEY",
  "status": "queued | running | succeeded | failed | not_executed | unknown",
  "job": "EXACT_JOB_ID_OR_NULL",
  "evidence": {"provider_observation": "NONEMPTY_REVIEWABLE_EVIDENCE"}
}
```

前台 succeeded/failed/not_executed/unknown 分别回传 executed/failed/not_executed/unknown。
后台 queued/running 首次回传 submitted；后续 query 发布状态事件，不改原报告。
本地 evidence 归档为不可变 JSON；适配器应提供可独立回查的平台证据，状态文字不证明
Benchmark 提升、实验有效或目标完成。示例中 `job` 可实际为 JSON null，不是字符串 "null"。

## 验证与仍需补齐

`tests/test_coordinator_operator.py` 使用临时 fixture 平台、真实本地 Python 子进程和 fake
Orca 身份，覆盖自动认领/提交/等待/回传/同 Coordinator 审查、仅等待不提交、预算与授权门禁、
提交/报告中断、防重、未知有界查询、STOP 和错误持久化。这不等于真实平台联调。
`test_coordinator_background.py` 补充训练与两项研究/审查重叠、同一 Coordinator 串行回合、
状态去重、历史 Job 查询、pending/事件/结算崩溃窗口、未知不释放名额和事件 pin/回退测试。

上线前仍需已核验目标 worktree 的业务 skill 和 authority、真实平台适配器（精确查询、
权限错误、预算/占用完整性）、独立审查、进程与客户端断开验收、平台准入和费用硬边界。
Driver 的已准备结算恢复另见[故障处理](coordinator-driver.md#持久化与故障处理)。
