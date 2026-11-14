# Operator 启动前准备

> **部分弃用（2026-11-13）**：S0 materials / skill-read-evidence / registration 这一段属于
> [已弃用的 strict bootstrap 协议](strict-bootstrap-protocol.md)，由
> [start grant](docs/design/start-grant.md) 的 mint 取代——批准不再由"准备阶段产出的证据"承载，而是由
> 一个不执行它的进程签发。**保留**：本文其余的精确工作区、provider 核验与 native plan 段仍是今天可用的
> 实现（`operator_prepare.py` 与 `coordinator_launch.py strict-native-plan` 共用同一份 `native_plan`）。
> 新任务走 `orca orchestration start-grant-mint`，不要照 S0 那套准备证据。


`operator_prepare.py` 将机械准备集中到一个入口，复用已有实现，不创建 Agent、Run、
Worker 或报告仓库，不执行启动 argv，不发审计 gate，不解释或补齐用户授权。
它与处理已有 Run 的 `coordinator_operator.py` 无关。

顺序保持为：

```text
静态文件/基线准备 → Operator 身份输入固定 → 独立外层审计 → 已授权的独立会话启动
→ 原生 caller + 会话观察 + 最终 readiness
→ （旧：request-only strict-start-prepare → strict-config-review，**已删除**）
→ 现行的 start grant：`start-grant-mint` → `run-create --grant` → `worker-start`
```

> 2026-11-13：上面那行旧握手的两步与 [registration](strict-bootstrap-protocol.md) 采集入口都已删除；
> 静态准备、身份输入与 native plan 这三段仍是现行实现。

`ok:true` 只表示当前工具完成，所有入口均输出 `execution_authorized:false`。
静态阶段的唯一成功状态是 `awaiting_external_audit`。同 UID 的 0600/0700 与文件 hash
不是独立审计隔离、签名证明或运行时强制准入；不能凭准备成功启动任务。

新 strict 请求使用 [固定业务目标输入](coordinator-strict-start.md#新请求固定生成器)：
input v4 → request v5，固定 `contract_fields`，从已审查的 `task_source` 读取业务 objective，恢复步骤单列
`recovery_note`。不要把“修复启动握手”作为后续 Run 的业务目标。TUI 发门还会
[重新核验 Operator 自身会话及未读消息](coordinator-startup.md#契约与调用)，
复用现有 runtime/log 读取器，未处理消息不会被准备脚本自动消费。

## Agent / adapter 支持范围

Operator strict gate 只接受已实现并显式选择的本地 runtime-state 适配器。Operator 侧
Agent 不是可自由替换的配置项，也不能用 Worker 侧 profile 表达。

| 位置 | 当前实现 | 边界 |
| --- | --- | --- |
| Coordinator exec | Trae（`trae_coordinator.py`） | 既有路径 |
| Coordinator TUI / strict | Trae（`trae_tui.py`） | 既有路径，`strict_plan` 固定 `--agent trae` |
| Coordinator Codex | `native-preflight` 的 `codex-local` adapter（schema v2） | 仅用于已有 Codex Coordinator 的只读预检；不是 Operator 适配器，也没有 Pi 等价物 |
| Operator（外层 gate 角色） | Trae TUI / Pi TUI | `provider` 是 Operator 身份输入里的显式声明，经 `provider_capability.py` 解析后再由 native 证据核验。`trae` 与 `pi` 都有可核验证据（见下），未知名仍是 `operator_session_provider_unsupported`（不声称具体证据通道），缺证据按 provider 给出 `operator_session_<provider>_operator_unverifiable` + `missing_evidence`。两者都不回退另一个 provider |
| Worker | 由固定 [Worker 白名单](worker-model-candidates.md) 决定（Trae / Pi / codex-ark） | 与 Coordinator、Operator 配置分离 |

bootstrap（S0–S5）阶段的两个 gate role 另有**自己的** `provider` 声明
（[registration schema v2](strict-bootstrap-offline.md#122-显式工具契约)），不继承上表也不从 pane
推断：`bootstrap_identity.py` 按同一能力表解析它，未知/不可核验就停止。S2 观察与 S5 TUI 契约
按该 role 的 provider 选择 adapter：`trae-tui-runtime-v1` 或 `pi-tui-runtime-v1`；两个 role 的
provider 可以不同。Pi Coordinator 的 `runtime_config` 必须是
[pi runtime policy](strict-bootstrap-protocol.md#51-provider-能力与拒绝码) 记录。

**Pi Operator 的核验通道**（2026-11-10 复核 Orca 1.4.219 快照与本机 pi 日志格式后确认）：

- Orca 会给经它启动的 pi pane 装托管状态扩展（`orca/src/main/pi/agent-status-extension-source.ts`），
  该扩展把 pi 的 `session_id`、`session_file`（transcript 路径）、`model` 和 pi 进程 env 里的
  `ORCA_AGENT_LAUNCH_TOKEN` POST 到 `/hook/pi`；服务端把 `launchTokenHash`、`evidenceObservedAt`
  与 `providerSession{key:'session_id',id,transcriptPath}` 写进 `agent-hooks/last-status.json`
  （`server-persistence.ts:50`、`server-status-application.ts:165`、`shared/agent-session-resume.ts:243`）。
- Pi 的 transcript 根记录是 `{"type":"session","id":<uuid>,"cwd":…,"version":3}`，每条记录带
  `id`/`parentId` 链与 ISO `timestamp`，assistant 消息带 `model`/`provider`/`thinkingLevel`。
  `pi_transcript.py` 逐条核验这些形状、根 id 与 hook 的 `session_id` 一致、链不断裂、时间不减。
- Pi Coordinator 用 `pi-tui-runtime-v1`：同样的 hook/transcript 证据 + 审查过的 pi runtime policy
  （provider/model/thinking_level），没有 sandbox 面，故 `observation.roots` 只作为审查输入。
- 因此 Pi Operator 的 `expected_effective` 只能要求 `PI_SETTINGS`
  （`model`、`model_provider`、`thinking_level`、`cwd`）；pi 没有 approval/sandbox 概念，
  要求 `effort`/`approval_policy`/`sandbox_policy`/`approvals_reviewer`/`writable_roots` 会以
  `operator_session_expected_effective_provider_unsupported` 明确拒绝，不做跨 provider 映射。

2026-11-09 记录的现象（`last-status.json` 只有 `source=trae`、活跃 pi pane 无记录）在
2026-11-11 被重新归因：**它不等于「那些 pane 不是 Orca 起的」**。一次 `terminal create --agent pi`
的 pane 可以活着、`agentIdentity=pi`、托管扩展确实加载，却仍然一条 `source=pi` 行都没有。已核实的
两种成因都不是 provider 能力缺口，也都不是读取器可以放宽的理由：

1. **投递被宿主代理吞掉。** 托管扩展用运行时全局 `fetch` 发 loopback POST；pi 运行时给全局
   `fetch` 装了环境代理 dispatcher，而它的 no-proxy 匹配只认精确主机、`.后缀` 和 `*`，**不认 CIDR**。
   于是只写 `127.0.0.0/8` 的 no-proxy 列表会让 `127.0.0.1` 被送进代理，投递失败；pi 侧没有 curl
   兜底，错误被扩展按设计吞掉，pane 静默无行。同一宿主上其它 agent 家族的 hook 由会绕过代理的
   shell 客户端发送，所以它们的行存在（`source=trae` 行就是这样来的）。
2. **只到了 resume 身份。** 单独的 `session_start` 快照按 `providerSessionOnly` 落盘，是 resume
   身份而不是在跑的归属，严格读取器会拒绝；gate 需要至少一个 turn 事件落的行。

诊断（只读、不授权）：[pi_hook_preflight.py](pi_hook_preflight.py) 读 pane 的 env 与 hook 行，
回答“通道看起来能不能投递”，并给出 `pi_hook_transport_proxied_loopback` /
`pi_hook_row_provider_session_only` / `pi_hook_row_missing` 之一：

```text
python3 -B /absolute/swarm/pi_hook_preflight.py --pane-env /proc/<pid>/environ \
  --hook-store /absolute/orca-user-data/agent-hooks/last-status.json \
  --pane-key <tabId:leafId> --worktree-id <worktreeId> --tab-id <tabId> --json
```

它**不是证据**：`execution_authorized` 恒为 false，`channel_plausible` 只说明可能投递，任何 gate 都
不能据此放行。没有 hook 行时读取器给出的仍然是 `runtime_state_missing_pane`（经
`operator_session_runtime_state_unverifiable` 归一），不是静默回退，也不换 provider。

能力表与拒绝码见 [strict-bootstrap-protocol.md §5.1](strict-bootstrap-protocol.md#51-provider-能力与拒绝码)。
未知名（如 `codex`）仍是 `operator_session_provider_unsupported`，在原生查询前停止。
Worker 侧 `agent=pi` 仍是单独配置，不受此限制影响，也不能自动当作 Operator 适配器。

## 1. 启动会话前冻结明确的输入

外层先在原授权范围内准备好目标 worktree、报告仓库、基线、原始授权引用及一个空的
0700 输出目录。脚本不 mkdir/chmod、不 git init/add/commit、不注册仓库，也不探测 `.git`
写入。若需要 Git 提交或 Agent 内真实文件工具写入，仍须独立核验相应能力；外层可写
不证明 Agent 沙箱可写。遇到 EROFS/EACCES 停止，不能通过换工具或改权限重试。

固定输入 JSON 的**原始字节 SHA256**，不是重新序列化后的 JSON hash。schema v1：

```json
{
  "schema_version": 1,
  "preparation_id": "task-a-attempt-1",
  "directory": "/absolute/private/preparation-attempt",
  "read_roots": ["/absolute/reviewed-inputs", "/absolute/task-worktree", "/absolute/report-repo"],
  "write_roots": ["/absolute/private/preparation-attempt"],
  "baselines": [
    {"name": "code", "path": "/absolute/task-worktree", "head": "FULL_REVIEWED_COMMIT_SHA", "clean": true},
    {"name": "reports", "path": "/absolute/report-repo", "head": "FULL_REVIEWED_REPORT_COMMIT_SHA", "clean": true}
  ],
  "sources": [
    {"name": "handoff", "format": "bytes", "ref": {"path": "/absolute/reviewed-inputs/handoff.md", "sha256": "RAW_SHA256"}},
    {"name": "runtime-config", "format": "json", "ref": {"path": "/absolute/reviewed-inputs/runtime.json", "sha256": "RAW_SHA256"}}
  ],
  "authority_refs": [{"path": "/absolute/reviewed-inputs/original-authorization.md", "sha256": "RAW_SHA256"}]
}
```

占位符故意不可直接执行。`sources`、`authority_refs`、`baselines` 均非空；name/ID
使用字母数字开头的字母数字、点、横线或下划线（不超过 128 字符）。同种 name 不重复。
路径必须绝对、现存、规范且不经过符号链接；保留原有链接本身，输入填写其已核验目标。

- 输入 JSON 本身、sources、authority_refs 必须在 `read_roots` 内、输出目录之外。
  根声明只是操作者交付的 scope，不证明原始用户允许读取；外层独立审计必须核对映射。
- `directory` 必须位于 `write_roots` 内、属于当前用户且权限为 0700、完全为空，
  与全部 Git 基线目录不重叠；已存在的失败/成功 attempt 都拒绝复用，不自动换名。
- 每个 baseline 必须为准确 Git 顶层目录，完整 40/64 位 HEAD 与 clean 状态匹配。
  复用 `native_preflight._baseline_check` 的只读 Git 检查：HEAD、tracked/index diff、
  非忽略 untracked 文件摘要及目录身份在准备前后比较。只复用此独立原语，**不调用**
  要求已有 Run 的 `run_preflight`，也不借用 `codex-local` 的会话适配。
  ignored 文件不在此基线检查范围，代码仓库本身不会被完整备份。
- sources 的 `format:json` 使用共享严格解析器，拒绝重复键、非有限数及坏 JSON；
  `bytes` 保留任意已审查原始字节。authorization 内容保持原样，不由程序作语义判定。

```text
python3 -B /absolute/swarm/operator_prepare.py prepare --input /absolute/reviewed-inputs/prepare.json --input-sha256 REVIEWED_RAW_SHA256 --execute
```

`--execute` 只授权本次本地证据发布，缺失时不写文件。写入顺序：

1. 校验显式来源的 scope、pin、格式与基线；不递归扫描目录。
2. 独占发布 `prepare-intent.json`，按 `(path, sha256)` 去重保存 `source-NNN.snapshot`。
   输入 JSON 自身及原始授权也有快照，字节完全不变；不改写 JSON 内嵌的其他路径。
3. 再次核验基线、原始来源和快照，漂移即停，不能自动取新 hash 当成已审查内容。
4. **最后**原子独占发布 `prepared.json`，包含来源→快照映射、证据索引、基线结果与计时。
   它不把自己纳入输入清单。只有这个明确文件是完成交接点，intent 或零散快照不是成功。

输出 stdout 只含计数、时间、状态、清单 pin；正文保留在私有文件。下游必须按精确 pin
回读，不按“最新目录”发现。静态输入可以用快照消除重复读取，但 JSON 中引用的其他资源
不会自动冻结；应全部显式列出，并由审计检查闭包。快照不替代按角色完整读规则的证据。

源漂移、权限拒绝、输出碰撞和中断会留下已完成的中间证据，不生成最终清单（中断发生在
原子最终发布之后时，磁盘清单可能已经完整，须对账，不能盲重试）。没有恢复/自动重试、
自动补授权或 exactly-once 启动承诺：这里根本不启动。新 attempt 仍需沿用任务限制，
不得靠改名清零预算或未决操作。

对**已登记的 strict attempt**，`prepared.json` 现在是启动计划的一部分：`build_plan` /
CLI 用 `--reviewed-inputs` + `--reviewed-inputs-sha256` pin 它，`strict_plan()` 调
`verify_prepared()` 重验 kind/status、全部冻结 Ref（input/sources/authority/task 快照）以及每条 baseline 的
HEAD/cleanliness 与摘要（快照或基线漂移即停），并在 registered 模式下
缺这个 pin 时直接报 `strict_reviewed_inputs_required`。短 prompt 会引用该清单，让 Coordinator
从 pin 读输入而不是从仓库重新推导；该 pin 是输入，不是授权，Operator 仍自行复核每条 pin 并拥有
binding/registration/owner 发布权。

## 2. Operator 复用已有启动 argv

先按现有 [Coordinator 启动说明（私有部署）](configuration.md) 生成 strict launch plan，并用
`assemble-materials` 固定材料清单。`native-plan` 直接消费该清单中的
`artifacts.bound_launch_plan`，且必须等于本次 `--plan`；清单里的业务 workspace id/path
也必须与本次 native 目标和计划 cwd 一致。另先固定 Operator 自身身份输入，由同一个
`observe-operator` 校验逻辑做只读核验。Operator 不再手工拼接 `terminal create`：

```text
python3 -B /absolute/swarm/operator_prepare.py native-plan \
  --plan /absolute/materials/bound-launch-plan.json --plan-sha256 REVIEWED_PLAN_SHA256 \
  --materials /absolute/materials/final-checklist.json --materials-sha256 REVIEWED_MATERIALS_SHA256 \
  --operator-input /absolute/operator/operator-identity-input.json --operator-input-sha256 REVIEWED_OPERATOR_INPUT_SHA256 \
  --cli /absolute/verified/orca-server-cli --runtime VERIFIED_RUNTIME --workspace VERIFIED_FULL_WORKTREE_ID
```

这是 `coordinator_strict.native_plan` / `strict-native-plan` 的同一入口，仍重建完整计划、
核验 prompt pin、Operator 材料、Operator 身份、runtime strict 能力及准确工作区；
除 Operator runtime-state 观察外，只发 status/worktree show 只读查询。材料或身份不匹配时，
在查询 native runtime/workspace 前停止。
它返回 argv **数组**，前导 `--` 的 agent args 仍按 `--agent-args=...` 传递，保留原有
UTF-8 16 KiB / NUL 校验及 exec 兼容。不要把数组自行拼成 Shell 字符串或删除验收步骤。
真实执行由已有授权启动流程负责，未知创建结果仍须对账；这个入口没有 `--execute`。

本入口服务于 Operator **启动 Coordinator 的计划**，不将 Coordinator 的模型、权限或
角色政策套给 Operator 自身会话，也不复用整套 Coordinator 启动/接管流程。

## 3. 已有会话后，一次读取并保存观察

仅支持现有 `trae-tui-runtime-v1`（Orca 1.4.219 / Trae 0.211.1）。Coordinator 先在
自身原生上下文取得真实 `strict-caller-check` 回执，Operator 独立固定 pin。输入 schema：

```json
{
  "schema_version": 1,
  "cli": "/absolute/verified/orca-server-cli",
  "runtime": "VERIFIED_RUNTIME",
  "terminal": "VERIFIED_TERMINAL",
  "incarnation": "VERIFIED_INCARNATION",
  "workspace": "VERIFIED_FULL_WORKTREE_ID",
  "cwd": "/absolute/task-worktree",
  "profile": "/absolute/verified/runtime-profile",
  "caller_receipt": {"path": "/absolute/private/caller.json", "sha256": "RAW_SHA256"},
  "log_root": "/absolute/verified/trae-sessions",
  "roots": ["/absolute/approved/bootstrap"],
  "runtime_config": {"path": "/absolute/reviewed-inputs/trae-tui-runtime.json", "sha256": "RAW_SHA256"},
  "context_max_age_seconds": 1800,
  "expected_thread": null,
  "startup_anchor": null,
  "output": "/absolute/private/observations/startup-anchor.json"
}
```

```text
python3 -B /absolute/swarm/operator_prepare.py observe-session --input /absolute/private/observe.json --input-sha256 REVIEWED_RAW_SHA256 --execute
```

薄封装直接调用 `trae_tui.observe`，后者复用 `runtime_binding.observe` 的
`terminal → tab:leaf → entries[pane]`。保留 caller fingerprint、前后身份、hook 时间、
日志前缀与实际模型/effort/Max/approval/write roots 核验；没有自建 JSON 猜测路径或
exec/其他 provider 回退。重复 output 在原生查询前拒绝；输入、caller、配置、anchor
pin 前后都检查，观察结束后再查上下文年龄，读取旧记录不刷新时间。

`output` 的父目录需当前用户私有 0700，完整观察按原格式独占保存为 0600。stdout 只给
pin、必要会话 ID、有效设置摘要和信任边界，不输出 hook 原文、凭据或会话正文。
保存文件可直接作为现有 startup anchor / session_observation 消费，无需模型重新整理。
再次观察时填固定 `startup_anchor` pin 与 `expected_thread`，选择明确的新 output；
这不是权限失败后的自动换名重试。

时效必须从已审查契约继承，范围沿用 startup schema v2 的 1–3600 秒；新契约默认
1800 秒，旧契约不因包装入口自动延长。没有“读取成功就有效”的续期逻辑。
输出始终是 `runtime-state-and-log-not-live-process-attested`，且
`requires_live_caller_check:true`。它不是 Operator 身份证明、实时 caller 校验或执行许可。
会话准备完成后不再走 `strict-start-prepare`（已删除）；授权由
[start grant](docs/design/start-grant.md) 的 `start-grant-mint` 签发，审计门随代码消失，
只保留 `strict-caller-check` 这一道活身份门。

### 3.1 bootstrap registration（已随旧握手删除）

`strict-bootstrap-registration` 采集入口与 `bootstrap_registration.py` 已删除：现行启动授权是一次
[start grant](design/start-grant.md) 的 mint，不再有 attempt 级 registration 文件。
仍保留的是**运行时证据的解析方式**（`bootstrap_identity.py`，供 Operator 观察与 session 绑定使用）：
它按 `agent-hooks/last-status.json` 里 `tabId:leafId` 的 `providerSession{key:'session_id',id,transcriptPath}`
与 `launchTokenHash`，叠加 `/proc` 的 `pid`/`start`/`boot`/`uid` 做校验，从不看 transcript 文件名，
也不从 pane 推断 provider。那张表是本机**所有 pane 共用**的有界映射（实测只剩最近 6 条），条目会被
后来的 pane 覆盖或挤掉，所以观测要新鲜，且角色 provider 仍由调用方显式声明。

## 4. 启动前接入任务归档目录

Trae strict TUI 启动后不能靠外层 mkdir 改变其已生效沙箱。新启动前，外层在原授权范围内
准备**任务专属**的规范 0700 归档父目录及独立空输出目录，用 `archive-plan` 复用原
`strict_plan(build_trae_plan(...))` 加入 `--add-dir`。不授予整个共享归档目录，不重建角色
或启动逻辑，不修改旧计划/会话/Run；本命令不创建目录或 Git 仓库、不改权限。

固定输入的原始文件 SHA，schema v1：

```json
{
  "schema_version": 1,
  "directory": "/absolute/task/operator/archive-plan-attempt",
  "read_roots": ["/absolute/task/inputs"],
  "write_roots": ["/absolute/task/operator/archive-plan-attempt", "/absolute/task/archive"],
  "launch_plan": {"path": "/absolute/task/inputs/strict-plan.json", "sha256": "REVIEWED_RAW_SHA256"},
  "archive_parent": "/absolute/task/archive"
}
```

`read_roots` 必须覆盖输入、计划、prompt 和 runtime config。输出中的 `prepared.json`
是最后发布的交接清单，包含新 `launch_plan` pin、完整 `required_session_write_roots`，
状态仍为 `awaiting_external_audit`。将**新计划**交独立审查，再交原 `native-plan`；旧计划
不会自动失效或被替换，操作者不能误用旧 pin。完整重建会再次检查最终 agent args 大小。

```text
python3 -B /absolute/swarm/operator_prepare.py archive-plan --input /absolute/task/inputs/archive.json --input-sha256 REVIEWED_RAW_SHA256 --execute
```

会话观察的 `roots` 必须继承新计划的完整 roots，而不是只填 bootstrap。Run 创建后按
原生回执中的实际 ID 创建 `archive_parent/<actual-native-run-id>/`；不要预造 Run ID。
后续观察继续核验启动时的父目录 root（观察器要求精确匹配，不冒充已显式配置子目录）。
交接、checkpoint、ledger 与 Worker 子目录均绑定实际 Run 路径，外层独立核验归属。
派发前仍由真实 Agent 用所需文件工具完成该 Run 目录内的写/读/重命名/再读，并留存原生
工具轨迹。`file_tool_probe_verified:false` 不会因规划、外层写入或观察通过而变为 true。
目录权限错误即停，不靠追加更宽父目录、换工具或重启重试来绕过拒绝。

## 5. 自动计算 canonical digest 并安全发布 RSI 回执

`check-authority` 使用固定源码加载器（与 Driver 共用 `coordinator_checker.py`）执行
目标仓库**原有 RSI CLI**。支持 `resolve-authority-handoff`、`check-authority-handoff`
与 `check-authorized-progress`，
不实现另一套授权解释器。独立审查先固定整个输入 JSON 的原始 hash，以及其中每个文件
的原始 pin；程序只把这些已审查字节转换为 canonical digest，不从待验交接反推授权、
不接收模型随手复制的 context digest、源漂移时不自动更新 pin。

新任务材料优先使用下文的**生成链协议**。以下 schema v1 检查接口保留给旧配置、
历史回执及诊断，不自动具有生成链保证；不得在新协议检查失败后降级使用。

旧检查输入 schema v1：

```json
{
  "schema_version": 1,
  "mode": "check-authorized-progress",
  "directory": "/absolute/task/operator/check-attempt",
  "read_roots": ["/absolute/task/inputs", "/absolute/verified/target-checkout"],
  "write_roots": ["/absolute/task/operator/check-attempt"],
  "checker": {"root": "/absolute/verified/target-checkout", "files": {"rsi/__init__.py": "RAW_SHA256", "rsi/progress.py": "RAW_SHA256", "rsi/authority.py": "RAW_SHA256", "rsi/__main__.py": "RAW_SHA256"}},
  "source_root": "/absolute/task/inputs",
  "run_id": "ACTUAL_RUN_ID",
  "scope_id": "REVIEWED_SCOPE",
  "inputs": {
    "authority": {"path": "/absolute/task/inputs/authority.json", "sha256": "RAW_SHA256"},
    "handoff": {"path": "/absolute/task/inputs/handoff.json", "sha256": "RAW_SHA256"},
    "contract": {"path": "/absolute/task/inputs/contract.json", "sha256": "RAW_SHA256"},
    "context": {"path": "/absolute/task/inputs/context.json", "sha256": "RAW_SHA256"},
    "checkpoint": {"path": "/absolute/task/inputs/checkpoint.json", "sha256": "RAW_SHA256"},
    "gates": {"path": "/absolute/task/inputs/gates.json", "sha256": "RAW_SHA256"}
  }
}
```

示例的 checker files 只是展示结构，实际必须列出目标 `rsi/` 下**全部** `.py` 文件，
缺失/新增/漂移均拒绝。handoff 模式的 `inputs` 仅含 `authority` 和 `handoff`。
输入、JSON 文档、ledger 引用的原始授权文件以及 checker 源码保存去重字节快照；scope
先检查再读取正文。原始 source 的相对路径仍由 RSI 自己安全读取并校验，执行后再次核对
固定源和快照。程序不会解释授权正文，必须保留原始来源的身份、完整性及权限映射审查。

```text
python3 -B /absolute/swarm/operator_prepare.py check-authority --input /absolute/task/inputs/check.json --input-sha256 REVIEWED_RAW_SHA256 --execute
```

- `invocation.json` 明确区分 `digests.context.file_sha256`（文件原始字节）与
  `digests.context.canonical_sha256`（解析、排序、紧凑序列化）。contract/authority 等相同。
  生成的 argv 只把 canonical 值交原有 `--context-sha256` / `--contract-sha256` 参数；
  legacy CLI 字段、历史文件和 TUI adapter 接口不改名、不静默升级。
- 独占 `check-intent.json` 后才执行，成功时先保存 stdout/stderr、计时和 digest 清单，
  最后原子独占发布 **`receipt.json`**，保留原 RSI 成功 envelope，可直接交现有 checkpoint
  adapter。`check-completed.json` 是附属元数据，单独存在不能当成功回执。
- 非零退出、坏 JSON、源码/输入漂移、错误绑定等不发布 `receipt.json`；保留
  `checker-stderr.txt` / `checker-stdout.txt` 和 `failure.json`（可写时）。命令失败不会
  预建一个 0 字节的“成功”文件。子进程异常/中断或存储故障可能只有部分证据，不能自动重试。
- 输出目录必须新建、私有且为空。重复执行、并发争用、已有成功/失败 attempt 均不覆盖；
  只返回状态、pins 和摘要，不在 stdout 倾倒授权正文。检查通过不签发启动/派发 gate，
  不替代实时 caller、真实 Run 绑定和外层独立审计。

### 新生成链：从 ledger 到已检查 handoff

仍调用同一个 `operator_prepare.py check-authority` 入口，不需要 shell/JQ 提取 JSON。
生成输入沿用上述固定字段，只改：

```json
{
  "schema_version": 1,
  "mode": "resolve-authority-handoff",
  "inputs": {
    "authority": {"path": "/absolute/task/inputs/authority.json", "sha256": "REVIEWED_RAW_SHA256"}
  }
}
```

这是字段差异示例，不能单独运行；还须填写 directory/read_roots/write_roots/checker/
source_root/run_id/scope_id。directory 是独立新建的 0700 空目录。固定输入 pin 后使用：

```text
python3 -B /absolute/swarm/operator_prepare.py check-authority --input /absolute/task/inputs/generate.json --input-sha256 REVIEWED_RAW_SHA256 --execute
```

程序从固定源码执行原 `resolve-authority`，严格校验 envelope 的 `result.handoff`，
包括版本、Run/scope/canonical authority digest、fields/origins 键集合；合法的 origin
值可以是 null。随后用**同一份 handoff 字节**调用原 `check-authority-handoff`，重验
原始输入、来源、完整 checker 文件集合及快照。字段含义和增量继承仍只由 RSI 解释。

成功结果返回 `handoff`、`receipt`、`completion` pins：

- `handoff-authority.json`：完整 handoff；`handoff-candidate.json` 保留精确被检查字节。
- `resolver-stdout.txt` / `checker-stdout.txt` 及对应 stderr、invocation：原 envelope、argv、
  checker pins、退出码、调用起止时间的证据；不伪造原 checker 没有的绑定字段。
- **`completed.json`**：唯一 commit point，绑定输入 pin、归档快照、raw/canonical digests、
  两次调用、handoff 和 receipt。`execution_authorized=false` 只表示工具不授予权限。

文件逐个原子发布，**不是多文件事务**。完成标记之前可能已有完整中间文件；没有有效
completion pin 就不可消费。任何失败都不重用 attempt；`failure.json` 仅在可写时尽力保存，
SIGKILL/存储故障可能只留下 intent 或部分文件。并发失败者不写入获胜者目录。

提交返回丢失、`publication_unknown` 或中断时，只读核对**原输入 pin、原 attempt**：

```text
python3 -B /absolute/swarm/operator_prepare.py check-authority --input /absolute/task/inputs/generate.json --input-sha256 REVIEWED_RAW_SHA256 --reconcile
```

`committed` 表示当前能读到并完整核验提交标记；它不补做 fsync、不保证故障存储已修复。
`incomplete` 表示当前没有 completion，保留材料审查，不自动重执行。恢复/新尝试是否需要
额外授权由原授权与实际状态决定，不因一次材料错误一概重建 Run。

### 绑定进度检查与 continuation（显式启用）

新进度检查使用 **schema_version=2、mode=check-authorized-progress**，六个 inputs
仍为 authority/handoff/contract/context/checkpoint/gates，另加顶层 `generation`，值为
上述生成 `completion` pin。handoff 必须使用生成结果的精确 pin，authority/source_root/
checker/Run/scope 必须相同。独立审查 context 中操作到权限的映射并固定输入 pin。
输出同样以 `completed.json` 提交，不以 `receipt.json` 单独存在判成功。

`coordinator_tui_prepare.py` 输入增加如下两个字段：

```json
{
  "authority_binding": {
    "protocol": "generated-authority-v1",
    "generation": {"path": "/absolute/task/generate/completed.json", "sha256": "RAW_SHA256"},
    "scope_id": "REVIEWED_SCOPE",
    "context": {"path": "/absolute/task/inputs/context.json", "sha256": "REVIEWED_RAW_SHA256"},
    "contract": {"path": "/absolute/task/inputs/acceptance-contract.json", "sha256": "REVIEWED_RAW_SHA256"}
  },
  "completion": {"path": "/absolute/task/progress/completed.json", "sha256": "RAW_SHA256"}
}
```

原有 `source` 为该进度检查的 checkpoint pin，`receipt` 为该进度检查返回的原始 receipt pin。
`authority_binding.contract` 是 RSI 验收合同，不是外层会话启动 contract；其 requirements
须与 continuation 原始 acceptance 一致。所有被消费的 bundle、归档快照、context 与
contract 均须在会话 contract 的 observation roots 中；不为此扩大 roots 或复制伪造回执。

prepare 将 authority_binding 固定到 schema2 config，projection 使用
`rsi-authorized-progress-v2`，domain_check 增加该 checkpoint 的 `completion` pin。
共享 config/record 校验供 scheduler、workflow 和直接 runtime 入口使用；后续每个
checkpoint 都要有同一 generation/context/contract 下的新进度检查 completion。缺失、
错配、改用 v1 adapter、未知版本均拒绝。路径/权限映射或真实用户授权变化必须独立审查，
通过既有显式纠错/交接流程重新固定版本；不原地改已绑定 config 或通过降级绕过。

该协议与 `turn_protocol: workflow-v2` **独立**，两者可同时启用。未配置 authority_binding
的历史配置仍按 v1 读取，不声称已覆盖生成链，也不静默迁移既有 Run。部署、恢复工具及
线上版本支持须另外核验；workflow-v2 的现有恢复限制并未因本改动解除。

生产交接不要使用 `jq '.handoff'` 或手工投影发布 handoff。RSI 原 CLI 保留为底层检查器和
诊断接口。相同 UID 能改代码、文件和 pins，生成链不是生产者认证或授权服务；独立来源、
scope 和权限映射审查不可省略。本 worktree 不修改相邻 fin_verl checkout 的 `rsi/authority.md`，
目标仓库说明的同步需另在其授权工作区维护。

## 6. 已授权的精确 Trae 工作区自动信任

新会话启动前，外层调用 `trust-workspace`，复用 `supervisor.orca.Orca` 的只读原生/Git
核验、`supervisor.trae_trust.register` 与原子回执。支持 Operator、Coordinator、Reviewer、
Worker，不伪装 `orchestration` 来源，不修改 Server，不执行启动或发送 TUI 按键。
静态 prepare 不会自动调用这个配置写入入口。

```text
python3 -B /absolute/swarm/operator_prepare.py trust-workspace --input /absolute/trust-input.json --input-sha256 REVIEWED_FILE_SHA256 --execute
```

严格 schema v1，全部字段必填：

```json
{
  "schema_version": 1,
  "runtime": {"cli": "/absolute/verified/orca-server-cli", "runtime_id": "VERIFIED_RUNTIME", "version": "1.4.219", "repo_id": "VERIFIED_REPO"},
  "workspace": "VERIFIED_REPO::/absolute/exact/workspace",
  "head": "FULL_REVIEWED_GIT_HEAD",
  "agent": "trae",
  "role": "reviewer",
  "policy": {"enabled": true, "hostname": "VERIFIED_HOST", "username": "VERIFIED_USER", "trae_home": "/absolute/private/trae-home", "launch_context_confirmed": true},
  "authority_refs": [{"path": "/absolute/user-authorization.md", "sha256": "FILE_SHA256"}],
  "content_review_refs": [{"path": "/absolute/project-content-review.md", "sha256": "FILE_SHA256"}],
  "directory": "/absolute/new-private-trust-attempt"
}
```

操作者先核对原始授权、项目配置/hooks/exec policies、ignored 文件和默认终端配置；并确认
实际 Agent 与登记进程的 host/账号/HOME/TRAE_HOME 一致、配置文件无其他写入者。refs 不是
机器认证的授权签名，Git clean 不证明内容安全。Python 文件锁不覆盖 Trae、编辑器或 TS
原生写入者，不能并发运行它们。不得仅填 true 当作已完成这些核验。

输入/证据在输出目录外；输出目录现存、0700、不与工作区或 Trae 配置目录重叠。登记前后
复查原生 runtime/版本/repo/worktree/local host、准确 HEAD、clean Git 根及 pins。底层继续
要求配置所有者、0600、规范路径、禁止宽目录及不覆盖明确不信任。GIT_ 环境覆盖拒绝。
该适配器暂不支持非 Git folder workspace，不改变原生 folder workspace 能力。
原生查询结束后、登记前再次核验 pins；前后检查不是跨 Git/配置/证据的全局事务，
仍要求准备窗口内冻结已审查内容，不能声称消除了所有并发写入竞争。

最后独占发布 `trusted.json`，状态 `trusted_not_started`，仍 `execution_authorized:false`。
同一成功 attempt 重跑重新核验状态和可信条目，不写配置或覆盖回执；撤销后拒绝复用。
失败仅有 intent 时先对账，不自动重试：配置可能已写入而回执尚未落盘，不回滚整份配置。
回执不含配置正文或凭据；条目持久存在，撤销需明确处理对应精确条目。

后续启动必须匹配输入的 runtime/workspace/agent，再通过 ready、会话配置、文件工具和
独立审查门。不存在全局自动确认、不改沙箱、不自动批准新/变更 hook。已有 TUI 信任页
不能假设配置热加载，须在授权并重查 terminal/incarnation 和当前提示后处理；不盲发 Yes，
不创建重复会话。

回归：`PYTHONPATH=.:tests python3 -B -m unittest test_operator_trust test_trae_trust`。

## 计时与验证口径

静态清单以 `preparation_id` 关联启动前阶段，尚无 Run 时 `run_id:null`。记录系统 UTC
`prepare_started_at`、`checks_completed_at` 及交接到 `awaiting_external_audit` 的时间；
单调时钟测量 `checks_wall_seconds` 和顺序 Git 查询的耗时/次数。
检查耗时不包含最终 manifest 发布及之后的消费者等待；不等同整个 Operator 启动耗时。
`awaiting_external_audit_at` 是本工具提交待审材料的时点，不表示独立审计服务已收到/通过。

外层 Operator 开始、模型轮次、实际审计等待、Coordinator 启动、Run 创建、首个 Worker
工具尚无观察来源时均为 null。后续应由真实事件回执追加关联，不修改旧清单，不用
wall-clock 减工具耗时推算模型时间，也不宣称本次覆盖了全部 pre-Run 计时。

本地回归入口：

```text
PYTHONPATH=.:tests python3 -B -m unittest test_operator_prepare test_operator_session test_coordinator_strict test_trae_tui -q
PYTHONPATH=.:tests RSI_CHECKER_TEST_ROOT=/absolute/verified/target-checkout python3 -B -m unittest test_operator_authority test_operator_archive test_tui_rsi_integration -q
```

包含真实临时 Git 仓库与离线 native/hook/log fixture，验证参数完整性、JSON、pin/基线
漂移、并发发布、防覆盖、权限即停和观察器兼容（`test_coordinator_strict_prepare` 已随旧握手删除）。
不启动模型，不证明远端性能、实际 Agent 文件工具权限或独立外层审计已通过；提速需同类真实任务的授权验收。

## fields/final-evidence 的模板提交（**已随旧握手删除**）

`bootstrap_tool.py`（含 `submit --from-template` 与 `materialize_template`）及其
`bootstrap_from_template_not_allowed` / `bootstrap_template_drift` 拒绝码已随旧握手一起删除；
现行写入面只有 start grant 的不可变 mint 记录（同 id 同字节幂等、异字节冲突）。本节只作历史记录，
不再有可执行入口。
