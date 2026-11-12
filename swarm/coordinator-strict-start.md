# strict 启动握手：先就绪，再发布，再连续校验/创建

这条本地工作流修复终端流淘汰、失败回执被覆盖、60 秒窗口内模型准备命令及 CLI
caller 回执封套不匹配的问题。新契约使用 schema v2 / 1800 秒上下文 / 180 秒 gate；
旧契约、回执和 pin 保留原时限，不自动迁移。契约 v2 不等于原生策略 strict-v2；
当前严格创建校验的 `coordinatorPolicy` 仍为 `strict-v1`。
不会部署服务、启动 Agent 或 Worker，也不提供崩溃接管；实际执行仍须已有任务授权。

目标文件系统验证：2026-10-30 实测记录（部署方私有历史材料，不随公开仓库分发） 显示当时 BN/NFS
挂载的独占目录提交探针返回 errno 22，旧 request-only prepare 未完成发布。新请求显式使用
下述 marker-commit 协议，复用独占文件发布，不再依赖目录 rename。旧失败记录不改写；
同挂载测试也不等于独立审查、真实启动或 11 项 live 验收通过。

## 顺序与证据

会话尚未启动时，可先用 [Operator 静态准备入口](operator-prepare.md) 冻结明确文件、
原始授权引用和基线证据，停在独立外层审计。它不替代本页要求已有会话及最终 readiness
的 `strict-start-prepare`。Operator 生成启动命令使用 `operator_prepare.py native-plan`
（与 `strict-native-plan` 同一实现），并传入已固定的材料清单和 Operator 身份输入；不手工拼
`--agent-args`。

1. 按原生 strict 计划启动独立 Coordinator，先执行 `strict-caller-check`。
   保存完整 CLI JSON（`ok/result/_meta.runtimeId`）的原始字节并固定 hash。
   旧的 result-only 回执仍可读取；失败 envelope、错 runtime、不完整 caller 会拒绝。
2. **在大段规则输出前**，Operator 运行 `trae_coordinator.py` 的 exec 原生观察器，传准确
   terminal/incarnation/workspace/cursor/runtime/执行配置等原有参数，并增加
   `--save-startup-anchor /absolute/attempt/startup-anchor.json`。此文件原子独占保存。
   不可从已淘汰的 stream 补造；失败就停，不按“最新日志”猜 UUID。
   TUI 则使用 [operator_prepare.py observe-session](operator-prepare.md#3-已有会话后一次读取并保存观察)
   或原有 `trae_tui.py`，复用精确 hook/caller/log 映射，不使用 exec stream 或手工 jq 猜结构。
3. Operator 审查并固定 anchor 的原始 SHA256；新 v2 契约的 `observation` 可增加
   `startup_anchor: {path,sha256}`。后续不重放旧 stream，仍重新检查 native 状态、
   terminal/incarnation/worktree、精确日志、实际模型/权限、新鲜度及 anchor 的历史
   日志前缀/文件身份。anchor 不是心跳、caller proof 或完整读规则的证据。
   该 pin 纳入两个阶段的 identity，不能在首派发契约换掉或删除。旧 v1 不支持此字段。
4. Coordinator 完整读规则、核验任务授权和实际文件工具后，保存工具记录。
   Operator 独立审查其完整性和自身 provider/session 与 terminal 的真实关联。
   普通 shell 占位符不证明外层 Operator 身份，观察器 JSON 不替代 skill-read。
   技能正文用 `orca skills get <name>` 获取（版本匹配、由可执行文件输出）；本 checkout 不含
   `orca/skills/`，所以“该路径不存在”既不能当作已读证据，也不能当作不可读的 blocker。
   **等 Coordinator 写出最终 readiness 后**再审查并 pin；不能在它仍写入
   `readiness-current.json` 时生成契约，也不能在发现漂移后直接重新取 hash。
5. Coordinator 用固定生成器将最终清单和契约字段 pin 纳入 request。Operator 使用下述
   `strict-start-prepare`，只传 request pin，代码确定性生成快照、v2 契约和配置，最后提交完整标记。
   Operator 独立审查生成物并执行 `strict-config-review` approve/reject，**此时还不发 gate**。
   新注册 bootstrap attempt 的 approve 后，原 Operator 必须先按
   [生命周期 v2](operator-startup.md) 固定执行模式、sender、目录和原 owner，执行
   `operator_startup.py prepare`，再按下述交付协议执行 `strict-config-publish`。原配置与
   review 不变，由 schema4 activation 包装；新 delivery 返回 activation 的 plan。同一个
   live Coordinator 在 `strict-config-wait` 收到配置、映射和只读 `strict-start-plan`
   结果后独立审查，再执行 plan 输出的完整绝对路径 `wait_command`。
6. waiter 再查 live caller、确认自身没有绑定 Run，独占发布 `ready.json` 并有界等待。
   Operator 读回审查这份 ready 及引用的证据，固定 ready SHA256 后执行
   `strict-start-publish --execute`。发布器这时才运行 Operator session gate。
7. gate 完成后原子发布 `operator-gate.json` 和最终 `gate-ready.json`（包含准确 pin）；
   waiter 只读这个约定路径，不 glob、不选择最新回执。然后同一次工具调用中执行
   strict-session-check、live caller、strict Run 创建和 run-show/run-current 读回。
   无需模型再次推理、查 `--help` 或组织命令。创建后仍禁止 Worker，直到原有两道
   first-dispatch gate 和其他任务检查全部通过。新生命周期的 created 返回固定
   `lifecycle` 与角色动作 argv，`runtime_ready=false`；立即按 materials → 原 Operator
   review → Coordinator dispatch → continuation 推进，不在创建后或首派后长时间等 Worker。
8. 固定非 Agent sender 执行 lifecycle 前台观察/部署入口；只读观察可在首派前开始，
   continuation 发布后才激活原 monitor/scheduler。模式化当前 readiness 通过才形成
   运行能力证据，不把 created 或 monitor 心跳当作业务验收通过。

## Operator provider

strict 的 Operator 角色接受可核验的 **Trae TUI 或 Pi TUI 会话**。`provider` 是 Operator 身份
输入的显式声明，经 `provider_capability.py` 的能力表解析后再由 native 证据核验：`trae` 用
hook 行 + `session_meta`/`turn_context`，`pi` 用 hook 行 + transcript 根
`{"type":"session","id":<uuid>,"cwd":…}` + assistant 的 `model`/`provider`/`thinkingLevel`。
未知 provider 名（如 `codex`）是 `operator_session_provider_unsupported`；缺证据按 provider 给
`operator_session_<provider>_operator_unverifiable` 并附 `missing_evidence`，不猜 log_root、
不回退另一个 provider，能力表与全部拒绝码见
[协议 §5.1](strict-bootstrap-protocol.md#51-provider-能力与拒绝码)。

**Pi Operator 的前提**是 pi 会话由 Orca 启动（托管状态扩展会写 `source=pi` 的 hook 行）。
Pi 没有 approval/sandbox 面，Operator 的 `expected_effective` 只能要求
`model`/`model_provider`/`thinking_level`/`cwd`；要求其余键会以
`operator_session_expected_effective_provider_unsupported` 停止。
**Pi Coordinator** 使用 `pi-tui-runtime-v1`：S2/S5 读取同一 hook/transcript 证据，并把契约
`runtime_config` 作为审查过的 pi runtime policy（`provider`/`model`/`thinking_level`）与 transcript
最新 assistant 轮次精确比对。没有 sandbox/approval 面，`observation.roots` 只作为审查输入，
不当成已核实。Run 之后的 continuation/scheduler 仍是 Trae 路径（已知边界）。
用 pi 会话当 Operator 时，错误在 gate 前出现，不产生观察文件、不占目录、不发 gate。
挂 bootstrap registration 的两个 gate role 同样各自声明 `provider`
（[schema v2](strict-bootstrap-offline.md#122-显式工具契约)），非法/不可核验声明在启动 owner
前停止（`bootstrap_<role>_provider_evidence_unavailable` 等）。两个 role 的 provider 可以不同
（例如 Pi Operator + Trae Coordinator），各自按自己的证据核验。

用 Trae 会话当 Operator 的完整清单（每步都在**该 Operator 自己的 pane** 内执行）：

1. 在目标 worktree 用 `terminal create --agent trae` 起一个**独立** Operator 会话，
   不与 Coordinator 同 terminal、不同 provider session；记录它的 `handle`、`incarnationId`、
   真实 provider session（不是 `paneKey`、不是 `ptyId` 后段）及 `worktreeId`。
2. 在跑任何 gate 命令的 shell 中确认 `ORCA_TERMINAL_HANDLE` 就是该 Operator terminal。
   `require_operator_context` 要求它等于契约 `operator.terminal`；**不要**设置或清除身份环境、
   不要把普通 shell 标成 Operator，也不要由其他会话代跑 publish。
3. 先固定 Operator 自身身份输入（`cli`/`runtime`/`workspace`/`profile`/`log_root`/
   `expected_effective`/`output`），把它与原始 SHA256 交给 `observe-operator --execute`；
   观察结束后再固定观察文件 SHA256。`context_max_age_seconds` 从已审查契约继承。
4. 契约的 `operator` 字段必须逐字取该观察的 `session`（provider=trae、terminal、incarnation、
   session、workspace），不得从 pi 会话或其他 pane 反推；请求、config、review 里同一个
   Operator 身份必须一致。
5. `strict-config-review` 与 `strict-config-publish --execute` 只在上述 Operator pane 的
   `ORCA_TERMINAL_HANDLE` 下执行；session gate 会在同一 pane 复核 runtime/terminal/
   incarnation/精确 hook 与日志前缀，gate 回执 TTL 默认 180 秒，过期只能按原授权重做，
   不续期、不换目录。
6. 没有 Trae Operator 会话时，strict 链路停在这里是**预期**结果：不要改用 pi、exec 流或
   手工 JSON 续跑；先按现有任务授权准备该会话，或改用无 Operator gate 的非 strict 路径。

## 固定配置与命令

这是单次已授权 attempt 的配置，不是新的用户授权文件；占位符必须从独立核验来源填写。
`readiness_evidence` 非空且必须包含契约的 `skill_read_evidence` pin，还应包含任务要求的
真实文件工具核验等证据。程序核对文件未变和顺序，不认证自然语言理解或授权真实性。
`max_workers` 必须继承用户已确认正整数；本启动器不派发 Worker，也不替代运行期并发检查。

### 先准备快照与契约

`strict-start-prepare` 只接受 **request v5 的路径及原始字节 SHA256**，不接受 `--input`
或手填证据、目标目录、deadline、request_id。request 是唯一事实源，已经固定
`contract_fields: {path,sha256}`：新契约字段 JSON（即 `startup-contract --input` 的输入，
不含 `schema_version` / `freshness`，`run` 省略或为 null）。不要拿失败 attempt 的旧契约作输入。
request、字段文件及原始 readiness 放在输出目录之外，分别固定原始字节 SHA256。

```text
python3 -B /absolute/swarm/coordinator_launch.py strict-start-prepare --request /absolute/attempt/strict-config-request.json --request-sha256 REVIEWED_REQUEST_FILE_SHA256 --execute
```

准备器只做本地文件操作，不调用原生服务或认证身份：

- `directory` 必须为固定的 `BOOTSTRAP/strict-start` 且**尚不存在**；bootstrap 必须已存在、
  归当前 UID 所有、规范且私有（0700），并位于已授权 roots 内。不 chmod、不清理旧 attempt。
- 先校验全部输入和已审查 pin；若当前原生终端提示与契约 Operator 不符，写入前
  以 `operator_native_context_mismatch` 拒绝。没有终端提示仍为
  `operator_identity_verified:false`，**不表示 Operator 身份通过**。
- 按 request 的原顺序、精确原始字节保存 `readiness-NNN.snapshot`；重复 pin 拒绝，
  不排序、不追加、不删减、不展开内嵌 probe。契约 `skill_read_evidence` 和配置统一引用快照。
  输入校验后先在同级 `.strict-start-storage-probe-*` 探测 mkdir、独占文件发布、fsync 和读回；
  探针保留，不证明授权或未来存储健康。随后在同级私有 staging 写入全部产物并重验。
  独占 mkdir 领取最终目录，逐文件使用 `publish_new` 发布完整字节，连已存在的空目录也不覆盖。
  最后再次检查源 pin、上下文、deadline 及全部已发布文件，才原子独占发布 `prepared-commit.json`。
- **目录存在不代表 ready**。提交标记 v1 绑定 request pin 和有序完整成员清单：readiness 快照、
  `session-contract.json`、`prepared-inputs.json`、`start.json`，不包含自身。所有启动读取入口
  重验标记和文件 pin；标记缺失、不完整或不匹配即拒绝。后续 gate/runtime 文件不纳入初始清单。
- `prepared-inputs.json` v3 保留 request/契约字段 pin 和完整源→快照映射；config v3 绑定 request。
  成功输出给出 config/contract/preparation/commit/storage_probe 的 pin；新注册 attempt 的
  plan 此时为 `awaiting_lifecycle`，完成上述 v2 prepare 后才可交付执行计划。Operator 仍须审查
  生成物，Coordinator 仍须独立读取、审查并运行 `strict-start-plan`。
- 快照完成后的源文件更新不改变已准备契约；快照自身改写仍会被 gate/waiter 拒绝。
  只复制列出的 readiness 文件，不递归冻结其内容提到的其他路径，也不刷新 caller、
  anchor、授权或会话时效。不得用快照挪用旧会话证据。
- 首派发契约保留相同的快照 pin；不要又换回可变的 `readiness-current.json`。
  提交前崩溃可能留下 staging 和无标记的最终目录；它们仅为诊断证据，不能继续发布或复用。
  CLI 失败诊断保留 stage、errno、系统时间及已知 request/目标/probe/staging/member 路径，不输出原始私密异常。
  权限/存储拒绝立即停止，不 chmod、不改用 rename、不换工具重试。标记已 link 后 fsync 失败
  属于结果未知，须读回对账，不能把异常当作“未提交”或重放许可。
  新 attempt 仍需满足原授权与重试限制；旧失败目录不清理、不覆盖。
- Operator 只产出独立审查回执，固定为 `BOOTSTRAP/strict-config-review.json`：绑定
  request/config/preparation，记录 approve/reject、说明、系统时间和 Operator 身份声明。
  不接收证据清单。回执不可覆盖，reject 不可用另一路径的 approve 代替；修改 request 后旧回执不可复用。
  `identity_verified:false / execution_authorized:false` 明确不是身份认证或执行许可。

同一 request 的 config、契约和 snapshot 内容是字节级确定的；prepared/review/publication
回执的系统时间反映实际操作时间，不为追求“同 hash”而伪造。冻结时钟的回归测试覆盖整链可重复性。

这不替代 Operator provider/session→terminal/incarnation 的独立关联核验。不得
由 Coordinator 代执行 publish，不得把普通 shell 标成 `external-operator` 充当证明，
也不得清除/注入身份环境以通过检查。两种上下文提示的结果都明确
`operator_identity_verified:false`；真实 session gate 仍会重新核验，新契约默认 1800/180 秒。

### 交给连续存活的 Coordinator

新 strict 计划的 `startup_delivery` 固定为 `continuous-native-file-v1`，在最初的
启动输入里就给出以下固定路径（`BOOTSTRAP` 为该 attempt 独立的 bootstrap 目录）：

- `BOOTSTRAP/strict-config-request.json`：Coordinator 自己固定的期望请求。
- `BOOTSTRAP/strict-config-ready.json`：Operator 原子独占发布的配置清单。
- `BOOTSTRAP/strict-start/`：准备前保持不存在；只有完整 `prepared-commit.json` 校验通过才已提交。
- `BOOTSTRAP/strict-config-review.json`：Operator 的独立 approve/reject 回执。
- 新注册 attempt 另有 `BOOTSTRAP/lifecycle/{spec,activation,lifecycle}.json`，由原
  Operator 准备、同一 owner 确认。delivery schema3 保留原 config/review pins 并交付
  activation/lifecycle；历史 delivery schema1/2 不静默升级。

bootstrap 本身必须在该任务已授权的 write roots 内。工具不自动生成新
attempt、不清理旧文件；request 与契约字段放在 `strict-start/` 外。
该约定只用于新计划，不改变历史手工 start 配置和已固定计划。

Coordinator 写完最终 readiness 后，使用 `strict-config-request` 生成不可变请求，
不再临时编写脚本填 `coordinator` 或计算 deadline。期望值来自已核验的启动交接、自己的
真实 caller/会话和原授权，**不能从后来收到的发布清单反推**。原始 readiness pin
必须按 Coordinator 固定的顺序逐项继承；重复相同 pin 拒绝，不能用任意同 hash 路径替代。

#### 新请求：固定生成器

先审查并 pin 以下输入；`session_observation` 是准确的 TUI/exec 原生观察器输出或
startup anchor（不可用摘要、屏幕文本或“最新日志”代替），必须由 Operator 独立核验。

```json
{
  "schema_version": 4,
  "cli": {"path": "/absolute/orca-server-cli", "sha256": "VERIFIED_CLI_SHA256"},
  "runtime": "VERIFIED_RUNTIME_ID",
  "workspace": {"id": "VERIFIED_WORKSPACE_ID", "path": "/canonical/worktree"},
  "caller_receipt": {"path": "/absolute/attempt/initial-caller.json", "sha256": "VERIFIED_CALLER_SHA256"},
  "session_observation": {"path": "/absolute/attempt/startup-anchor.json", "sha256": "VERIFIED_OBSERVATION_SHA256"},
  "contract_fields": {"path": "/absolute/attempt/new-contract-fields.json", "sha256": "REVIEWED_FIELDS_FILE_SHA256"},
  "readiness_evidence": [
    {"path": "/absolute/attempt/final-readiness.json", "sha256": "FINAL_READINESS_SHA256"}
  ],
  "directory": "/absolute/attempt/strict-start",
  "task_source": {"path": "/absolute/reviewed/business-task.json", "sha256": "REVIEWED_TASK_FILE_SHA256"},
  "recovery_note": null,
  "max_workers": 2,
  "task_deadline": "2026-10-28T04:10:00Z",
  "request_id": "11111111-2222-4333-8444-555555555555"
}
```

```text
python3 -B /absolute/swarm/coordinator_launch.py strict-config-request --input /absolute/attempt/request-input.json --input-sha256 REVIEWED_INPUT_SHA256 --check
python3 -B /absolute/swarm/coordinator_launch.py strict-config-request --input /absolute/attempt/request-input.json --input-sha256 REVIEWED_INPUT_SHA256 --execute
```

- `--check` 只做同一套输入校验，预览 request path/deadline，不写文件、不占路径，
  也不固定正式握手时间。
- `--execute` 在写入前复用 live Coordinator caller 校验；只有当前真实 caller 与请求里的
  Coordinator 一致才写计划中精确的 `request_path`（0600、原子独占）。不建目录、不发
  配置/gate、不创建 Run、不重试。输出 request pin，须审查后交给 plan/wait。
- 新 builder 仅接受 **input schema v4**，生成 **request schema v5**，保留 `continuous-native-file-v1` 交付模式；与启动契约
  schema v2、原生 `strict-v1` 是不同版本维度。生成物增加 `session_observation` pin
  和 `startup_window`，以及 `task_source` / `recovery_note` / `contract_fields`。
  准备器不再接受第二份输入，直接生成 config v3 / prepared receipt v3 / commit v1。
  旧 request v1–v4、config v1/v2、prepared receipt v1/v2 按原语义兼容读取，不升级、不重写；
  已有 request v4 的完整目录仍可审查/交付，但不能用新 prepare 重做。旧目录提交 helper 保留。
  config v1/v2 与新版 commit 或同级 request v5 混用会拒绝，不能删标记后降级 config 绕过。
  旧 builder input v1–v3 和手填 prepare 输入不再用于新命令，必须显式准备新 attempt。
- `contract_fields` 的 cli/runtime/workspace/coordinator 必须与 request 一致，skill pin 必须在
  request 的清单中。字段和所有固定依赖仍需独立审查，pin 不替代原始授权判断。
- `task_source` 必须是启动/恢复前独立审查并固定的业务任务文件，格式如下。生成器逐字
  取其中的 `objective`，并重验 workspace 和全部授权文件 pin；plan/wait/publish 同样重验。
  `recovery_note` 可为 null 或恢复步骤说明，永不用于 Run objective。任务文件不是授权证明，
  其中的原始来源、目标语义、预算与限制仍须外层独立审查；不得从恢复报告反推原始目标。
- `coordinator.session` 从观察记录的 `thread_id/session_id` 提取；TUI 还必须等于
  `binding.session_id`。校验 runtime/worktree/cwd、terminal、paneKey、incarnation 和
  TUI caller pin 一致。`paneKey=tabId:leafId` 不是 provider session，
  `processIncarnation=ptyId:incarnationId` 也不是单独的 `incarnationId`。
- 握手默认 **900 秒**。没有用户授权的整轮截止时间时显式使用 `task_deadline: null`，
  最终 deadline 为 `完成输入准备的时间+900秒`；有明确截止时间时取其与该值的较小值。
  不得虚构整体验收时间或远期日期；缺失、空串或非法值均不视为无限。
  已固定的历史请求仍按原 deadline 执行，不修改或续期。
  可显式设置独立的 `handshake_timeout_seconds`（整数 1–900）；缺省不得从其他 timeout
  推导。Worker 的 `timeout_ms=90000` 是 **90 秒 Worker 启动等待**；30 分钟上下文和
  180 秒 gate TTL 也都与握手不同。保留窗口来源，plan/wait/publish 重验且不续期。
- 初检失败不写请求；已存在请求/发布/准备产物（包括悬空链接）拒绝，绝不覆盖。
  失败恢复须先对账，按原授权使用新 attempt/input/request_id，不自动换目录或续期。
- 这里只核对已审查文件的一致性，`identity_verified:false`。不把静态 observation
  当作实时身份、权限、skill-read 或新鲜度证明；原有 live caller 与 session gate 均保留。

业务任务文件示例（原始授权文件及该文件均须保存在稳定的已审查输入位置）：

```json
{
  "schema_version": 1,
  "kind": "strict_business_task",
  "workspace": {"id": "VERIFIED_WORKSPACE_ID", "path": "/canonical/worktree"},
  "objective": "原授权中的完整业务目标；不是修复握手、等待门等恢复子步骤",
  "authorization_refs": [
    {"path": "/absolute/reviewed/original-user-task.md", "sha256": "REVIEWED_AUTHORIZATION_FILE_SHA256"}
  ]
}
```

#### 历史手工请求（只读兼容，不用作新请求模板）

历史 schema v1 请求仍按原字段和已固定 deadline 读取，不静默加字段或重新 pin。
早期检查也会拒绝非 UUID 的 provider session 和错误 incarnation，但 v1 没有
observation pin，完整绑定仍由后续 gate 验证。新请求使用上面的生成器。

```json
{
  "schema_version": 1,
  "mode": "continuous-native-file-v1",
  "cli": {"path": "/absolute/orca-server-cli", "sha256": "VERIFIED_CLI_SHA256"},
  "runtime": "VERIFIED_RUNTIME_ID",
  "workspace": {"id": "VERIFIED_WORKSPACE_ID", "path": "/canonical/worktree"},
  "coordinator": {"terminal": "VERIFIED_TERMINAL", "incarnation": "VERIFIED_INCARNATION", "session": "VERIFIED_SESSION"},
  "caller_receipt": {"path": "/absolute/attempt/initial-caller.json", "sha256": "VERIFIED_CALLER_SHA256"},
  "readiness_evidence": [
    {"path": "/absolute/attempt/final-readiness.json", "sha256": "FINAL_READINESS_SHA256"}
  ],
  "directory": "/absolute/attempt/strict-start",
  "objective": "原授权中的精确目标",
  "max_workers": 2,
  "deadline": "2026-10-26T15:00:00+08:00",
  "request_id": "11111111-2222-4333-8444-555555555555"
}
```

在同一个 native exec 进程的工具上下文中调用只读规划，再运行其精确 `wait_command`：

```text
python3 -B /absolute/swarm/coordinator_launch.py strict-config-plan --request /absolute/attempt/strict-config-request.json --request-sha256 COORDINATOR_PINNED_REQUEST_SHA256
```

`strict-config-wait` 不需要 `--execute`：只等待准确 `strict-config-ready.json`，不写
ready/gate、不创建 Run、不执行发布文件中的文本。等待受原绝对 deadline 与 monotonic
上界约束，入口剩余窗口为 `(0,900]` 秒；deadline 不因准备或交付刷新。
等待由目标文件的 inotify 事件**提前唤醒**，但事件只允许缩短等待、不允许定义等待：轮询兜底
始终挂着。inotify 打不开（`watch()` 返回 None）时保持原来的 250 ms 轮询节奏，与改动前完全
一致；inotify 可用但事件丢失时按 1.5 秒兜底，这 1.5 秒就是该情形下的最坏交付延迟。
每次等待在 stderr 打印一行 `publication_wait` 诊断（`kind`、`inotify`、`events`、`timeouts`、
`fallback_seconds`）；`events` 近 0 而 `timeouts` 增长即说明该挂载上事件没到，
`fallback_seconds` 是真实延迟。
它在等待前及返回前核对 live caller。请求文件改变、准确发布路径出现不完整 JSON、
悬空链接、拒绝访问、错误 pin/绑定或过期都停止，不换路径继续扫描。

Operator 独立审查最终 readiness 和请求，使用 `strict-start-prepare` 后，再审查
生成的 start 配置及 prepared-inputs，记录独立决定，然后带完整 pin 发布：

```text
python3 -B /absolute/swarm/coordinator_launch.py strict-config-review --request /absolute/attempt/strict-config-request.json --request-sha256 REVIEWED_REQUEST_FILE_SHA256 --decision approve --notes "独立审查说明" --execute
```

拒绝时使用 `--decision reject` 并停止。生成回执不是自动批准，不能由 prepare 代做审查。

```text
python3 -B /absolute/swarm/coordinator_launch.py strict-config-publish --request /absolute/attempt/strict-config-request.json --request-sha256 REVIEWED_REQUEST_FILE_SHA256 --config /absolute/attempt/strict-start/start.json --config-sha256 REVIEWED_CONFIG_SHA256 --preparation /absolute/attempt/strict-start/prepared-inputs.json --preparation-sha256 REVIEWED_PREPARATION_SHA256 --review /absolute/attempt/strict-config-review.json --review-sha256 REVIEWED_RECEIPT_FILE_SHA256 --execute
```

发布器只做本地校验与原子独占文件发布；v2 清单包含 request/config/preparation/review 的准确
path+hash 和发布时间，不含可执行命令。接收器重新独立核对：

- 原请求与当前 runtime、workspace、Coordinator 会话/caller、attempt 目录、request ID、
  objective、max_workers、deadline 的一致性。
- `prepared-inputs.json` 对准备输入/契约字段的 pin，以及完整 source→snapshot 映射；
  快照的精确路径、hash 和 start 配置引用必须一致，重建契约只允许原定的 skill 快照替换。
- caller/prepared/review/publication 的时间顺序、未启动的 attempt 标记及最终 live caller。
- 审查决定必须 approve，绑定确切 request 与生成物；发布前及接收器最终 live check 后再次核验。
  新 config 直接调用 `strict-start-wait/publish` 也要求审查回执，不能绕过 review。

**不要求原文件路径等于快照路径，也不重新 pin 已变动的原文件。** 快照完成后源文件
更新不使合法配置“消失”；快照变动或错误来源映射仍拒绝。成功仅返回待审查 config 和
现有 `strict-start-plan`，Coordinator 仍须独立审查后才运行其 `strict-start-wait`；
Operator 仍等真正的 `ready.json` 才发 session gate。清单/hash 不是签名、身份认证或
用户授权，不能取代任何已有 gate。重复 publish 不覆盖；重复只读接收不赋予重启权限。

不要让模型自写 glob/latest 扫描器，也不要向运行中的 `trae exec --json` 终端注入
“下一条命令”来交付配置。**保持同一个 exec 进程存活，不结束回合交还 shell**。
`--strict-coordinator --single-turn` 现在直接拒绝；自然语言交接若要求退出后等输入，
须在启动前改正并重新审查。结构化 flag 检查并不证明任意正文没有冲突指令。

### 已准备的 start 配置与 gate waiter

以下是准备器生成的 `start.json` 结构；不要手工拼装。历史 config v1 不含 request，
保持原版读取，不作为新数据模板。

```json
{
  "schema_version": 3,
  "request": {"path": "/absolute/attempt/strict-config-request.json", "sha256": "REVIEWED_REQUEST_FILE_SHA256"},
  "contract": {"path": "/absolute/attempt/strict-start/session-contract.json", "sha256": "REVIEWED_SHA256"},
  "caller_receipt": {"path": "/absolute/attempt/initial-caller.json", "sha256": "REVIEWED_SHA256"},
  "readiness_evidence": [
    {"path": "/absolute/attempt/strict-start/readiness-000.snapshot", "sha256": "REVIEWED_SHA256"}
  ],
  "directory": "/absolute/attempt/strict-start",
  "objective": "原授权中的精确目标",
  "max_workers": 2,
  "deadline": "2026-10-25T15:00:00+08:00",
  "request_id": "11111111-2222-4333-8444-555555555555"
}
```

plan/wait 使用的 `directory` 必须是准备器已经提交的规范目录，位于已授权 write roots 中。
deadline 是获准启动的绝对截止时间，与 context 最大年龄、gate TTL 分开。
prepare/plan/publish/wait 入口要求剩余时间 **大于 0 且不超过 900 秒**，prepare 提交前再查；
过期报 `strict_start_deadline_expired`，只有过长才报
`strict_start_wait_must_be_bounded_to_900_seconds`。prepare 初检失败不写文件，提交前复查发现
到期则保留中间证据、不发布提交标记；即使已有 start 文件也不可消费。
plan/wait 仍独立检查，不把准备成功当作时效保证。
wall-clock 与 monotonic 同时限制等待；`gate-ready.json` 的等待同样由 inotify 事件提前唤醒，
轮询兜底常挂：inotify 不可用时保持 250 ms 节奏（与改动前一致），事件丢失时按 1.5 秒兜底；
两种周期都由 stderr 的 `publication_wait` 诊断行给出。
每次 attempt 的 request_id 必须唯一 UUID，不能复用；不得改写旧 deadline/pin 使失败重试。

```text
python3 -B /absolute/swarm/coordinator_launch.py strict-start-plan --config /absolute/attempt/strict-start/start.json --config-sha256 REVIEWED_SHA256
```

此命令只读生成完整 `wait_argv` / `wait_command` 与 Operator 发布 argv，不作 native 调用。
交接直接携带该输出中的 `operator_publish_contract`（契约路径/hash）、
`operator_publish_identity`（预期 Operator 身份）、`operator_check_argv`、
`operator_publish_argv` 和 `operator_publish_expected_bundle`（回执路径）。
外层执行器只准备、核验并交接，不能代跑 gate publish，也没有普通 Shell 回退。
契约绑定的 Operator 接手后、Coordinator 启动 waiter 前，在自身原生会话执行
`operator_check_argv`，即同一配置的 `strict-start-plan --check-operator-context`。
该检查不依赖 ready、不写文件、不占用 attempt，不修改 deadline；
`operator_context_checked:true` 仅表示当前原生终端上下文匹配，不是完整身份核验、授权或 gate。
缺少上下文或不匹配时报告具体错误并停止，不手工设置/借用 `ORCA_TERMINAL_HANDLE`。
实际执行分别需要显式 `strict-start-wait --execute` 和 `strict-start-publish --execute`；
后者的 `--ready-sha256` 必须由 Operator 审查真实 ready 后填写，不事先虚构。
不要在已有 gate 的短期 TTL 内才规划本配置和命令，即使新契约窗口已增至 180 秒。

### 三条命令的取值对象不同

名称相近但参数不能互换，混用会分别报 `strict_lifecycle_activation_required`、
`strict_config_prepared_request_mismatch` 或 `strict_start_attempt_already_started`：

| 命令 | 关键参数取值 | 说明 |
| --- | --- | --- |
| `strict-config-review` | `--request` + `--request-sha256`、`--decision`、`--notes` | 没有 `--config` 参数；只产出审查回执 |
| `strict-config-publish`（配置发布） | `--config` = **`strict-start/start.json`** | 另需 `--request`/`--preparation`/`--review` 各自 pin；activation 存在时由实现自动绑定 |
| `strict-start-publish`（gate 发布） | `--config` = **`lifecycle/activation.json`** | 另需 `--ready` + `--ready-sha256`（必须是 Operator 亲自审查的真实 ready） |

### 时序预算（不含固定延迟常数）

握手 deadline、gate TTL 与 context 最大年龄是三个独立时限，任一到期各自 fail closed。
Operator 必须按**当前环境实测**判断可用余量，不得假设某个固定唤醒/投递延迟：

- gate TTL 很短（新契约默认 180 秒），从 gate 完成时刻起算；Coordinator 的复查、Owner
  归属核对与首个派发动作都必须落在该窗口内。
- 交互式 TUI 的空闲投递不是即时唤醒；实测可能显著长于 gate TTL。因此应当在**同一回合内**
  完成必要动作，而不是依赖“先发消息、等它醒来再发 gate”的两趟往返；两次 attempt 已各自
  因此耗尽 900 秒握手窗口。
- 若环境实测延迟接近或超过 TTL，应缩小动作范围或改用同一原生调用内的连续执行，而不是
  放宽 TTL、改时间戳或延长旧 request 的 deadline。

该预算是操作约束，不是代码保证；实现不强制拦截，仍以原生回执为准。

`strict-start-plan` 同时输出 `phase_waits`、`operator_publish_ready_path` 和
`operator_publish_expected_bundle`，交接必须按这些文件事件推进：

1. Coordinator 在自身连续存活的 native 工具上下文运行 `wait_argv`，发布并等待
   `ready.json`；Operator 只在读回并独立审查该文件后继续。**该调用必须一次跑完**：
   waiter 自己消费 `gate-ready.json` 并在同一次调用内创建 Run。不得在 ready 边界中断、
   终止或重启 waiter，再把 gate 留到下一次模型回合；中断即视为该 attempt 未进入创建阶段，
   只能先对账，不得重跑 waiter 或重发 create。
2. 契约绑定的 Operator **在自身原生会话中**原样使用 `operator_publish_argv`，把已审查的 `ready.json` pin 带入
   `strict-start-publish --execute`，发布 `operator-gate.json` 和最终 `gate-ready.json`。
3. Coordinator waiter 只消费同一 attempt 下的 `gate-ready.json`，不读取粘贴到 TUI 的文本、
   不 glob “最新” receipt，也不把模型 idle 当成 gate 完成。

`terminal wait --for tui-idle` 只能证明终端暂时可交互，适用于启动后发送初始交接等 UI
边界；它不是 strict-start 的通用阶段门。进入 strict-start 后，以 `ready.json` 和
`gate-ready.json` 的原子独占文件为准；若文件缺失、pin 不符或 deadline 已过，按本节失败
规则停止并对账，不通过再次等待 idle 或向 TUI 粘贴 receipt 补救。

## 失败、重复与一致性边界

- publish 在读取 ready 和占用 `publication-intent.json` 前复用必需的 Operator 上下文检查；
  上下文缺失/不匹配不写发布文件。正式 gate 仍执行原有身份、邮箱、契约 pin 和时效复查，
  已进入发布阶段的失败仍保留不可覆盖的失败回执。提前检查通过不保证稍后的发布成功，
  失败不自动换 attempt，也不能把没有新发布文件当作启动/重试授权。
- `ready.json`、`publication-intent.json`、`operator-gate.json`、`gate-ready.json`、
  `create-intent.json`、`create-response.json`、`created.json` 都是原子独占文件，不覆盖。
  同一 attempt 不可重复使用；保留旧 attempt 与失败，不靠换编号绕过授权/重试限制。
- plan/wait 在检查 deadline 或调用 native 前，先只读检查以上精确 attempt 标记。
  有 create-intent/response/created 时返回 `strict_start_create_requires_reconciliation`；
  否则有 ready/publication/gate 标记时返回 `strict_start_attempt_already_started`。
  即使旧 deadline 已过期或 Run 已释放也不重跑 waiter。标记存在不证明 Run 创建成功或失败；
  须核对原进程、固定 request ID 与 native 状态。拒绝访问或悬空符号链接不会被当成“没有标记”。
  独占写仍用于拦截检查后的竞争；只读 plan 通过不是可重复启动的许可。
- 首批 gate 是一次性阶段边界，不是每个 wave 都重走的流程。已有 Worker（即使已完成/释放）
  仍触发 `first_dispatch_inventory_not_empty_or_incomplete`，不能靠刷新 TTL 放行。
  原有效连续进程内的后续波次遵循实时身份/owner/generation、进度和预算检查。
  strict-v1 进程退出后仍不支持 shell resume、替代或 takeover，须保全证据并报告恢复缺口。
- gate 失败时发布 `ok:false` 的终态 `gate-ready.json`，waiter 立即 fail closed。
  不把之后的成功覆盖在同一文件；若 publisher 在发布终态前崩溃，waiter 到期停止。
  时间过期、身份变化、pin 变化、现有 Run、路径权限错误均停止，不自动刷新或恢复。
  waiter 的 `strict_start_publication_mismatch` 是外层拒绝；应检查准确 attempt 的
  `gate-ready.json.error`（例如 `operator_native_context_mismatch`），不能将其归咎于
  readiness hash 后重写 gate。同一 Git 仓库有多个 Orca 注册时，`path:` 查询可能命中
  不同注册；使用已核验的完整 `id:<repo-id>::<worktree-path>`，不据此迁移或换 runtime。
- 创建前保存 request ID/输入 pin/校验结果，调用原生 `--strict-coordinator` 和
  `--retry-request <fixed UUID>` **一次**；后者绑定 mutation receipt，不代表本工具重试。
  结果不明、创建时间越过 gate/deadline、owner/generation 不符或读回失败，统一要求
  `strict_start_create_requires_reconciliation`。先查固定 request ID 的 `request-show`
  与当前 Run/终端，不重发 create、不删 Run、不宣称“没有 Run”。
- runtime 创建时仍校验真实 live caller，不接受本地文件作为 native 凭据。调用仍从
  Coordinator 原生工具上下文继承；不注入 token/`ORCA_TERMINAL_HANDLE`，不借 `--from`。
- **本地 gate + 原生创建不是原子事务**：gate TTL 仍是工作流约束。客户端在创建前
  查有效期，创建后核对服务端 created_at 和本地响应时间；迟建 Run 会留待对账且禁止派发。要做到
  runtime 在提交时原子验证独立 Operator gate，需要另行实现并验收原生协议。
- 原生终端流锚点是受信 Operator 固定的文件证据，不是签名证明。它必须来自真实
  初次 stream 观察；同 UID 的可写文件/hash 不形成安全隔离。Operator 会话关联与
  完整技能读取仍须独立审查，不能仅凭本工具成功宣称已认证。

### 原生秒级时间戳与严格截止边界

当前原生 SQLite Run `created_at` 输出为秒级 UTC（例如 `12:11:59Z`），不能把它当作
微秒级提交时刻。校验器将其解释为 `[12:11:59, 12:12:00)` 的时间区间；未来带小数的
回包按所报精度处理，缺时区、未知格式或超过微秒精度会拒绝，不补造精度。

- waiter 等到 session gate 完成时间向上取整的秒边界才继续实时校验并创建，额外等待
  小于一秒，仍受原 wall-clock/monotonic deadline 约束，不回写 gate 时间。
- 创建前必须留有一个完整原生秒位于 gate/deadline 内；没有安全窗口就停止，不创建。
- 创建后，整个 `created_at` 区间必须位于 gate 完成与 gate/deadline 截止之间，且
  响应到达不得超过截止时间或 monotonic 期限。响应过晚、时间回退或区间跨界都只保留
  create-response 并要求对账，不写成功回执、不自动重试。
- Operator 首派发门使用相同区间规则。旧 attempt 若只证明“与 gate 同秒”或落在
  TTL 最后的不完整一秒，证据不足仍拒绝；不靠容差放行或追补修改历史时间。

这是对原生低精度回包的保守兼容，不更改数据库、RPC、契约已固定的时限或严格身份边界。
与现有本机适配器相同，要求 gate 与 runtime 使用一致时钟；不是跨主机时钟同步证明。

离线测试使用真实文件发布/日志读取/gate 代码和模拟 native 服务；不证明远端已部署，
也不证明真实模型工具调用链中 live proof 一定可用。远端完整启动验收须另获授权执行。

本次变更属于 Python 启动辅助脚本，不修改 Server 服务包，无需重启 Orca 服务。
只有后续调用更新后的脚本、生成并审查的新契约/计划采用新默认及阶段提示；旧契约和运行中
进程不热更新。阶段提示参与启动计划 hash，旧计划不可用新提示重签后冒充原计划；
本修复不会同步远端副本、恢复既有 Run 或自动开启新 attempt。

## 等待的唯一形式

等待另一个 Agent 只允许一种形式：`orca orchestration check --wait --types … --timeout-ms 300000 --json`
（或用 `swarm/wait_for_events.py` 同一契约的封装）。`sleep N`（N≥60）、反复轮询 inbox、循环重读同一个文件都
不是等待策略。三条硬约束：返回的是整批 FIFO Delivery（`--types` 只是唤醒条件，不过滤返回行，唤醒后按类型分发
并复核 settle）；stderr 每 15 s 一条 `_keepalive` 是 CLI 存活提示，不是消息也不是进度；单片 ≤300 s，被唤醒后
重新进片。空返回或超时只允许「枚举 + 再等」，不授权 start/release/abandon/retry。
完整规则与退出码语义见 [swarm-orchestration skill](skills/swarm-orchestration/SKILL.md) 的
“Waiting: one blocking call, never a blind sleep”。

### 等另一个 pane：一次回合边界，且必须先有回合证据

上面的 mailbox 规则不变。对端 pane 的**回合**是另一条通道，它也有一次性形式，不是「sleep 一段时间再读屏幕」：

```bash
# 保存提交回执：这是「这一回合已经开始」的唯一证据。
orca terminal send --terminal <peer> --text "…" --enter --wait-submit 30 --json > send.json
# 然后只等一次；只有超时（124）才重新进片。
python3 swarm/wait_pane.py --terminal <peer> --turn-evidence send.json --idle-timeout 300
```

- 单片 `--idle-timeout` ≤300 s（与 mailbox 同一策略）。返回 0 只表示**这次回执启动的那一回合**到达了边界，
  不等于「活干完了」：仍要复核产物；唤醒不是回执。
- `tui-idle` 本身永远不是完成判据：pane 在开始工作**之前**就是空闲的。等待必须绑定同一次提交的
  `turn_started` 阶段与同一个 terminal 进程 incarnation；拿不到就退出 4 `unverifiable`，**不**回退去盯屏幕。
  该 provider 回 `provider: "unsupported"` 时永远没有 `turn_started`，这类交接要换通道或转人工。
- 退出 5 `interaction_required` 表示该 pane 卡在 trust/approval/update 提示上：那是人工决策，不是把窗口拉长。
- 读对端屏幕只是诊断，不是判定：不写 `terminal read` 轮询、不 `sleep`、不用「看起来结束了」。

### 等文件发布：inotify 提前唤醒，deadline 说了算

```bash
python3 swarm/wait_for_file.py --path <published.json> --timeout-ms 300000 --json
python3 swarm/wait_for_file.py --path <log.jsonl> --mode change --timeout-ms 120000
```

事件只能缩短等待，deadline 决定结果。退出 0 = 路径已出现或 `st_mtime_ns`+`st_size` 已变；124 = 超时；
4 = 父目录不可达（立即返回，不会退化成轮询到超时）；2 = 用法/传输失败。返回 0 后仍须用 `file_ref` 与 schema
复核字节：非原子写入在写完前就可见，`--mode change` 也看不见「同尺寸同时间戳」的改写。

以上两条是唯一新增的形态。本仓**不**采用 `--for output-change`（PTY 输出是 token 级噪声，不是决策点），
三条通道也**都不**覆盖人工决策、外部长任务、gate 阶段门与本地进程退出。设计、不变量与各通道不证明什么，见
[对端等待设计](docs/design/pane-handoff-wait.md)。
