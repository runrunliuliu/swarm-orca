# 原生 Coordinator Worker 参数计划

`coordinator_launch.py worker-plan` 是原生自适应 Coordinator 的离线参数生成入口，
不是固定 DAG Supervisor。它不查询 runtime、不创建 Task/worktree、不启动 Worker、
不提供授权或自动重试。新生成的 Codex run、Trae run/recovery 和 strict-bootstrap
提示已接入此入口；旧计划/运行中的会话不会自动更新。已有 pin 不覆盖，需按原启动流程审查新计划。

## 模型选择与固定参数

新请求使用 **schema v2**：Coordinator 只选择实际 `model` ID，不再提供
`agent/effort/backend_variant`，即使填入相同值或 null 也拒绝。代码从 helper 同目录的
[worker-model-profiles.json](worker-model-profiles.json) 确定 Agent、effort 和 backend；
它是 [Worker 白名单](worker-model-candidates.md) 的机器可读参数源，与 Coordinator 配置分离。
任务、placement、写入范围和 timeout 仍按任务授权明确填写，不属于模型固定参数。

Operator 审查该配置并在交接中固定 `profiles_sha256`（文件原始字节 SHA256）。
Coordinator 原样引用该 hash，不自行修改配置或重新批准 hash；不允许请求指定另一配置路径。
配置丢失、hash 变化、未知模型或未完成适配的组合均在生成命令前拒绝，没有默认模型或降级。
允许归档经审查的一致 helper/config 副本，但不能只替换配置来扩充白名单。

| 模型 | 自动生成的固定参数 | 当前限制 |
| --- | --- | --- |
| `example-model` | `example-agent`、`high`、`standard` | placeholder only; private deployments must provide their own reviewed profile |

GPT-5.4 固定生成 `--backend-variant standard`，由原生 Trae catalog 映射为
`-c 'model_backend_variant="standard"'`，复用既有启动链路覆盖旧 Max 参数。
Trae 0.211.1 严格配置回读已确认 Standard 覆盖先前 Max；这不是推理或 Worker 生命周期验收。
底层 Worker API 直接请求 GPT-5.4 而不传 backend 时，在创建前拒绝并要求显式 Standard；
不会另建默认配置或省略 backend 让它继承 Max。旧 runtime 会拒绝不支持的 Standard，须先部署适配。
代码不修改全局默认值，不自动切换到另一个模型。计划的 `resolved_profile` 输出配置 pin
与解析值；首派发 intent/成功回执也保存它。它不是实际运行配置的证明。

旧 schema v1 请求返回 `legacy_worker_request_requires_fixed_profile_migration`，不静默改写
已有请求的含义，也不能作为自由参数后门。迁移时另存 v2 请求、引用审查过的配置 hash，
保留原请求和回执；有 intent/未知结果的旧尝试先对账，迁移不等于允许重试。
这是 Swarm helper 的代码约束，不是 Orca 原生 CLI/RPC 的全局策略，也不改动固定 DAG Supervisor。

## 已有工作区

Coordinator 在原授权归档目录保存请求，审查后固定文件的 SHA256：

```json
{
  "schema_version": 2,
  "cli": "/verified/absolute/orca-server-cli",
  "run": "run_example",
  "task": "task_example",
  "model": "gpt-5.5",
  "profiles_sha256": "<Operator-reviewed worker-model-profiles.json SHA256>",
  "placement": {
    "kind": "existing",
    "worktree": "id:exact-workspace-id-from-native-discovery"
  }
}
```

示例 ID/CLI 路径必须替换为当前已核验值；模型以原授权白名单为准，示例不新增白名单。
在已核验 helper 所在路径执行：

```text
python3 -B /absolute/swarm/coordinator_launch.py worker-plan \
  --request /absolute/archive/worker-request.json --request-sha256 <SHA256>
```

成功仅输出 JSON 计划，包含 `argv` 和 POSIX `command`；没有 `--execute` 模式。
核验授权、Run owner/generation、容量、阶段门、工作区写入所有权后，在同一真实
Coordinator 身份上下文执行审查过的 `argv` 一次，不追加参数、不改成临时拼接器。
保留原生回执；`outcome_unknown` 必须对账，不因重新生成计划而重发。
CLI 路径保留原样，不回退到另一 runtime，也不允许在请求中注入 `from` 身份。

### v2 启动门 Run 的第一个 Worker

首派请求必须在以上字段外加入：

```json
{
  "first_dispatch": {
    "contract": {"path": "/absolute/dispatch-contract.json", "sha256": "<reviewed hash>"},
    "operator_gate": {"path": "/absolute/operator-first-dispatch-02.json", "sha256": "<reviewed hash>"},
    "state_root": "/absolute/run-archive/first-dispatch"
  }
}
```

`state_root` 预先建立为 0700，位于契约已授权 roots 内；同 Run 固定使用这一目录。计划仍是
离线只读，但返回的 argv 改为 `coordinator_launch.py first-dispatch --request …
--request-sha256 … --execute`，**不再返回裸 worker-start 命令**。在原 Coordinator 的一个
工具调用中执行该 argv：复用现有门检查、生成并保存新的 Coordinator gate，紧接着派发一次。
此执行模式属于新入口，不改变 `worker-plan` 的只读性或旧请求的含义。
首派发执行前再次读取同一固定配置并核验 hash；门检查期间配置变化会在写 intent 前拒绝。

门过期时拒绝派发，Operator 在原 Run 重新检查并给出新 pin，不篡改或延长旧回执。
缺省 native timeout 为 60 秒，外加 15 秒传输余量，必须完整落在两个 gate 的有效期内；
显式 `timeout_ms` 也受同样约束。过大的 timeout 不能靠放宽 TTL 解决。
有 intent 或结果不明必须对账，不能换目录/请求绕过。完整规则和证据文件见
[受检首派发入口](coordinator-startup.md#受检首派发入口与过期刷新)。

确认首派成功后，后续 Worker 请求不带 `first_dispatch`，沿用原生派发实时检查。
旧请求/旧计划不会自动迁移；未带此字段的计划仍是原生 argv，不提供首派 TTL 保护。

`existing` 只接受 `kind/worktree`，Git 和 folder workspace ID 均原样传递。
`name/repo/base_branch/display_name/comment/setup` 即使为空或 null 也拒绝，不静默丢弃。
工作区名称不是 Worker/Task 名称：已有 Task 用 `task`；原子创建新 Task 使用
`spec` + 可选 `task_title/deps/parent`，不能同时传 `task`，不能把标题放进 `placement.name`。
已创建并登记信任的 worktree 也属于 `existing`，不能继续沿用创建参数。

### Worker 私有写工作区

Trae 的 `workspace-write` 会令会话 cwd 所在 workspace 可写，因此只从
`writable_roots` 删除源码路径并不能把源码工作区变成只读。需要审查源码、但只允许写报告时，
必须先准备并通过 Orca 登记一个独立的最小 Git 报告 workspace，让 Worker 从该 workspace/cwd
启动；源码 worktree 只能作为 workspace 外的显式只读输入。请求除上述字段外加入：

```json
{
  "writable_roots": ["/canonical/private/report/workspace"],
  "write_isolation": {
    "workspace_root": "/canonical/private/report/workspace",
    "read_only_roots": ["/canonical/source/worktree"]
  }
}
```

`write_isolation` 仅接受 fresh local Trae + exact existing workspace，拒绝 terminal 复用、
远端 placement 和新建 worktree。所有路径必须是已存在目录的绝对规范路径：symlink、包含
`..` 的别名、重复只读根，以及写根/只读根相互包含均拒绝。`writable_roots` 必须严格等于
只含 `workspace_root` 的单元素数组；`read_only_roots` 不会转成原生写权限参数。

首派发 helper 在 gate 前、gate 后且写入 intent 前各执行一次原生 `worktree show`，要求 exact
selector 返回的 ID 和路径始终等于已固定的私有 workspace。任何缺失、别名、路径变化或查询
异常都在原生派发前失败关闭；成功观察写入 `dispatch-intent.json`。这只是 placement 防线，
不替代 Worker 会话中的真实文件工具探针：Worker 必须在报告 workspace 完成写入、回读、改名、
再回读，并尝试修改源码路径且取得沙箱拒绝证据，之后才开始审查。

## 新建 worktree 与其他参数

新建 child 的 placement：

```json
{"kind": "new-child", "name": "worker-review", "base_branch": "approved-commit", "setup": "skip"}
```

新建 top-level 的 placement：

```json
{"kind": "new-top-level", "name": "worker-review", "repo": "id:verified-repo", "base_branch": "approved-commit", "setup": "skip"}
```

两种新建模式均要求 `name`，top-level 要求显式 `repo`；可选
`base_branch/display_name/comment/setup` 仅在此分支生成，省略 setup 时保留原生默认行为，
示例 skip 不是通用许可。显式 `on` 传给原生 worker server 选择器，禁止 remote new-child。
生成器不接受隐式 current 或名称选择器；使用原生发现得到的 `id:`。

新启动必填 `model/profiles_sha256`；`timeout_ms` 正整数、`retry_of`（需 task）可选。
复用模式只提供 `terminal`，仅接受 existing，不能带 `model/profiles_sha256` 或启动覆盖参数；
它不重配既有会话，也不证明复用就绪识别问题已解决。`writable_roots` 是 1–32 个绝对路径，仅 fresh Trae + existing 且无 on；
宿主是否本机 POSIX、SSH/WSL 限制、目录规范性/权限、提供方模型能力继续由原生验证。
生成器不是 runtime capability 检查器，计划成功不表示原生启动必定成功。

未知字段、非法组合、请求或配置 hash 改变均退出 2。规划只读请求和配置文件，不写状态或投递命令。
原生 CLI 另外在 RPC 前拒绝已有工作区上的创建参数；服务端既有拒绝校验保持不变。

## 离线验证

```text
ORCA_BACKGROUND_LAUNCH=1 PYTHONPATH=.:tests python3 -B -m unittest test_coordinator_worker_plan test_coordinator_first_dispatch test_coordinator_loop test_coordinator_launch test_coordinator_strict test_trae_coordinator
```

离线回归不等于部署或真实 Worker 验收，本次代码维护不更新既有 RSI Run。
