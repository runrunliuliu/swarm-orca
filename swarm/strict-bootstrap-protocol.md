# Strict bootstrap 协议、生产适配与生命周期交接

更新：2026-11-03。范围：新建 Trae TUI bootstrap attempt；不迁移历史 request、契约或 Run。

本文保留通用状态机、双侧工具交接及生产适配边界，不包含部署方的内部路径、真实身份
或历史验收报告。协议与同版代码共同维护；发布源码不表示已部署或通过 live 验收。

已知缺口（**非规范**）：退出结果到 {未生效, 已生效, 未知} 的映射尚不闭合，推进责任仍在模型回合，
门数与任务权限不相称。诊断、修复包 P0–P2 与验收判据见草案
[strict-bootstrap-liveness.md](docs/design/strict-bootstrap-liveness.md)；本文与它冲突时以本文为准。
存储使用任务已批准的规范路径，按第 5 节核验文件系统能力，不仅凭 NFS 类型要求迁盘。


## 1. 协议定案

| 问题 | 固定选择 | 当前验证范围 |
| --- | --- | --- |
| STOP 与发布竞争 | 每个 attempt 单一控制责任者，进程内短时串行准入；预建固定 inode 的本地 `flock` 排除第二责任者 | 测试进程、真实文件、STOP-first / commit-first |
| 跨进程持久化确认 | `single-owner-memory-v1`；责任者完成 file + directory fsync 后才记录内存确认，消费者向该责任者查询 | link 后、fsync 错误、fsync 后确认前崩溃、代次切换 |
| S5 后责任 | 同一控制实例延续；v1 不做跨 owner 交接，也不在 request 成功后自动 disarm | 原 prepare/review/delivery/wait/publish/create 入口接入；native gate/API 为 mock |
| Operator 执行机会 | 精确原 Operator 的有界工具返回；固定 intent 对账，未知不重发 | 生产 RoleTool 双侧交还动作，模型审查/真实 provider 仍待 live 验证 |

不能将互斥、静态 pins 或内存确认当作活身份认证。三个 P1 的原语/接口在 Phase 1 固定，
原 builder 的离线闭环在 Phase 2 接通；Phase 4 开发及验证范围见
[离线与历史验证 §12](strict-bootstrap-offline.md#12-phase-4-开发交付生产工具与实际-s5-入口)。

## 2. 固定路径、S0 与公共类型

`bootstrap_protocol.layout(BOOTSTRAP)` 是布局的代码定义。所有路径为唯一绝对规范路径；
不扫描目录、不选 latest、不跟随软链接、不替换旧文件。

```text
BOOTSTRAP/
  attempt-binding.json
  initial-caller.json
  strict-config-request.json
  events/0001-caller-ready.json
  events/0002-observation-ready.json
  events/0003-contract-fields-ready.json
  events/0004-readiness-evidence-ready.json
  coordinator/skill-read-evidence.json
  coordinator/final-readiness-evidence.json
  operator/coordinator-session-observation.json
  operator/contract-fields-production-request.json
  operator/new-contract-fields.json
  operator/contract-fields-review-request.json
  operator/contract-fields-review.json
  operator/final-readiness-review-request.json
  operator/final-readiness-review.json
  control/                              # Phase 2 的控制记录，不是 ready 文件
```

公共类型：

- `Ref` 严格为 `{path,sha256}`；sha256 为原始文件字节的 64 位小写十六进制摘要。
  `kind` / `role` 不能混入 Ref。引用内容的 kind 另从已 pin 的字节中读取。
- JSON 对象拒绝重复键、非有限数、未知字段；版本/sequence 为整数，布尔字段不能用 0/1 替代。
  时间为带时区 ISO 8601；各时间非递减且不越过原 deadline，不因通知/恢复续期。
- `execution_authorized:false` 表示记录不授予权限，不代表否决原用户授权。
- 下列新增 schema v1 的字段为精确集合；已有 caller/observation/contract 字节继续使用其原有解析器，
  不给历史 schema 加限制或字段。原型数据不是可信生产证据。

`attempt-binding.json`：`schema_version:1, kind:"strict_bootstrap_binding"` 加以下字段。

| 字段 | 固定内容 |
| --- | --- |
| `attempt_id`, `runtime` | 外部固定的非空标识；CLI 必须另传 expected attempt 和 binding hash |
| `workspace` | `{id,path}`，已存在规范目录 |
| `coordinator` | `{terminal,incarnation,process_incarnation,pane_key,agent:"trae"}` |
| `operator` | `{terminal,incarnation,provider,session}`；与 Coordinator 不同 terminal/session |
| `paths` | 完整 `layout(BOOTSTRAP)` 映射，不允许重映射槽位 |
| `created_at`, `deadline` | attempt 时间边界；`created_at < deadline` |
| `context_max_age_seconds` | 新契约固定 1800，与现有 schema v2 builder 一致；gate TTL 仍为 180 |
| `fixed_inputs` | 恰含 `cli,runtime_config,role_skill,handoff,skill_read_evidence` 五个 Ref |
| `authorization_refs` | 非空、有序、无重复 Ref 清单；是来源证据，不由 validator 推导授权范围 |
| `file_tool_evidence_paths` | 预先确定的有序、唯一 `BOOTSTRAP/coordinator/` 下探针路径；不得占用其他固定槽 |
| `control` | `{backend:"single-owner-memory-v1",control_id,generation}`；初始代次，不是认证凭证 |
| `execution_authorized` | `false` |

S0 是 Coordinator 已获原授权启动、已在自己上下文读完技能后的固定输入检查点，
不是启动 Agent 前要求它先产出证据。skill-read evidence 在 S0 pin，随后才发布 caller-ready。
binding 的 `created_at` 不得晚于初始 caller 的 `checkedAt`。本阶段不提供 S0 生成器。
Coordinator 的 provider session 在 S0 不强行猜测：S2 从精确 caller 对应的 observation 派生；
不能拿 paneKey 当 session，不能把完整 `pty:incarnation` 当 incarnation 后缀。

文件工具结果、最终 readiness、request 在 S0 不要求存在。原授权、基线和恢复/预算限制须在
固定 handoff / authorization refs 中可追溯；validator 不代替现有授权核验器。

## 3. 四个 marker 与证据关联

公共字段精确为：`schema_version:1, kind:"strict_bootstrap_event", event, attempt_id, sequence,
attempt_binding:Ref, created_at, producer, execution_authorized:false`。
S2–S4 还必须有 `consumes:{event,path,sha256}`，与上一个固定 marker 的实际字节完全一致。
`consumes` 是事件关联对象，不是 Ref。

| 槽位 | 附加字段 | 语义 |
| --- | --- | --- |
| S1 / caller-ready / Coordinator | `runtime,workspace,coordinator,caller_receipt,context` | coordinator 为 `{terminal,incarnation,agent}`；context 为 `{context_max_age_seconds:1800,requires_live_caller_check:true}` |
| S2 / observation-ready / Operator | `runtime,workspace,coordinator,caller_receipt,session_observation,trust_boundary,requires_live_caller_check` | coordinator 为派生的 `{terminal,incarnation,session}`；observation pin 不带 kind；trust 为 `runtime-state-and-log-not-live-process-attested`，live check 为 true |
| S3 / contract-fields-ready / Operator | `contract_fields,review_receipt,must_match` | must_match 恰为 `{runtime,workspace_id,coordinator_terminal}`；fields 与 S0 五个输入、原 Operator、caller/observation pins 完全一致 |
| S4 / readiness-evidence-ready / Operator | `readiness_evidence,evidence_roles,required_refs` | 保留有序纯 Ref，角色说明单独存放，不扩展 request v5 |

caller 经原 `caller_result` 校验 envelope/result-only 兼容性，并核对 terminal、完整 process
incarnation、pane、local host。`checkedAt` 在 binding 创建后、S1 之前，检查时仍在 1800 秒窗口内。
observation 仅接纳 `trae_tui_startup_anchor` / `trae_tui_session_observation`，复用原
`observed_coordinator` 校验 runtime/workspace/provider session/caller/terminal 绑定；
其 `observed_at` 是原 turn context 时间，可早于 caller，但不得在未来或过期。
新 marker 不能刷新旧 context。

S3 复用 `source_contract` 和 `build_session_contract`，拒绝手工塞入 schema_version/freshness、
Run binding、邻库角色 skill 等不兼容字段。此时只需 S0 skill pin，不依赖尚未生产的最终 readiness。

S4 `readiness_evidence` 顺序固定为：

1. S0 skill-read evidence；
2. `file_tool_evidence_paths` 中各探针的实际 Ref，保持原顺序；
3. final-readiness manifest；
4. 原 Operator readiness review 结果。

manifest 精确为 `schema_version:1, kind:"strict_bootstrap_readiness", attempt_binding,
contract_fields, evidence, created_at, execution_authorized:false`。
`evidence` 只含上述 1–2 项，不含 manifest 自身或审查结果，避免循环 hash。
`evidence_roles` 为 `{ref,role}` 清单，ref 必须属于 readiness 清单且不可重复映射；role 为非空说明，
不授予角色权限。`required_refs` 恰为 `skill_read_evidence_present:true` 及
`file_tool_probe_evidence_present:<S0 是否约定探针>`；不能把必需证据从清单删掉仅留下 true。

无文件工具探针的 S0 只说明该清单没有约定探针，不自动免除原任务的真实探针要求。
文件 hash 正确只证明字节一致；工具结果语义、真实读取与审查质量仍由原角色和既有 gates 验证。

## 4. 原 Operator 字段生产与审查接口

字段生产请求的固定槽为 `operator/contract-fields-production-request.json`；Phase 2 生成并交付：

```text
schema_version: 1
kind: strict_bootstrap_fields_production_request
request_id: <attempt_id>:fields
attempt_binding: Ref
upstream: Ref                         # S2 marker
fixed_inputs:                        # 原 binding 的完整五项映射
evidence_refs: [caller, observation]  # 有序 Ref
operator:                            # 原 binding 精确身份
result_path:                         # owner 唯一最终输出 new-contract-fields.json，不是候选写入路径
created_at:
deadline:                            # 原 binding deadline
execution_authorized: false
```

它把已固定的字段源、最终结果路径和动作交还原 Operator，不能让模型找路径或凭摘要补字段。
`result_path` 只约定最终槽，不能直接用文件工具写入。生产 RoleTool 在 `pull` 返回值和
固定 intent 的 `payload.submission` 中另给唯一候选路径及提交方式，见
[离线文档 §12.2](strict-bootstrap-offline.md#122-显式工具契约)；
不能仅凭本 request 的 `result_path` 推导模型的写入目标。
fields 提交后生成 contract 审查请求；字段与独立审查均通过校验后才发布 S3，生产完成不是批准。
Phase 2 driver 生成此请求，由离线 Operator 适配器消费并生产字段；只读 marker 检查
不声称验证交付来源，生产身份/授权不能从 JSON 的角色声明推导。

两次审查的 request schema：`schema_version:1, kind:"strict_bootstrap_review_request"`，加
`request_id,attempt_binding,stage,upstream,subject_refs,evidence_refs,operator,result_path,
created_at,deadline,execution_authorized:false`。

| stage / request_id | upstream | subject_refs | evidence_refs |
| --- | --- | --- | --- |
| `contract` / `<attempt_id>:contract` | S2 Ref | `[contract_fields]` | `[caller,observation,skill]` |
| `readiness` / `<attempt_id>:readiness` | S3 Ref | `[manifest]` | `[skill,*file_tool_probes]` |

结果 schema：`schema_version:1, kind:"strict_bootstrap_review_result"`，加
`request:Ref,subject_refs,evidence_refs,operator,decision,notes,reviewed_at,
identity_verified:false,execution_authorized:false`。
request/result 路径固定；subject/evidence 清单和原 Operator 必须逐项相等；notes 非空且不超过
16 KiB；结果不能引用自身；`upstream时间 <= request时间 <= review时间 <= marker时间 < deadline`。
`approve` 才允许继续校验，`reject` 阻断，不能换 ID/覆盖审查结果。
`identity_verified:false` 明示它是身份声明，实际来源证明必须由适配器独立提供。

`bootstrap_protocol.OperatorScheduler.submit/query(control, request:Ref)` 返回
`OperatorDelivery(request, status, native_receipt:Ref|None)`。
submit 前必须在同域准入内固定 intent（原请求 pin、原 Operator、代次、deadline），并在接纳安全点
重验身份、竞争输入和 STOP。原生调用在短锁之外；拿到 intent 就属于在途动作，STOP 后只对账。

`review_route()` 冻结以下路由，不执行任何投递或审批：

- 新请求 + tool_wait：结束有界工具等待，把精确请求交还原 Operator；不能继续等它尚未写出的结果。
- 新请求 + busy：保留待交付 intent，到受支持安全点处理。
- 新请求 + idle：仅在适配器具备能力时请求安全点；否则明确 `blocked_operator_resume_unsupported`。
- submitted/input_accepted/unknown：查询原请求，不因无输出重发；turn_started 只等结果。
- completed：取得并校验结果；approve 仅路由到 `validate_review`，不是自动批准、身份核验或发布。
- STOP 优先；晚到结果只作证据。状态未知或缺少执行机会，不另开 Operator、不做 TUI 键盘注入。

字段生产使用同样的投递状态区分，但 completed 指字段就位，不含 approve。
Phase 2 用确定性夹具验证调用顺序；真实原 Operator 的认证和安全点能力须 Phase 4 独立验证。
Phase 4 选择已有 model turn 内主动工具返回，不调用跨回合 prompt 投递；因此不会伪造
`input_accepted` / `turn_started` 回执。持久 intent 仅表示已准入的动作，不表示模型收到返回；
原角色后续认证 submit 的精确结果才表示该动作有结果。意图存在、响应丢失时只对账，
真实工具返回/模型接续证据仍留到双会话验证采集。

## 5. 确认责任者与故障模型

选择 attempt-local 单一责任者，不新增常驻全局服务。Operator driver 与控制责任者可以在同一
宿主进程，但业务生产者和只读消费者通过独立接口访问；责任者只是提交字节，不代替 Coordinator
生产 caller、证据或 request，也不代替 Operator 审查。

适用假设：参与者位于单 host，目标挂载支持并经核验 hard-link exclusive publication /
file fsync / directory fsync；OS 和挂载正常提供 advisory flock；同一受信用户下的参与者均遵守协议。
恶意同 UID 进程、可替换的锁 inode、跨主机排他/网络分区及通用多客户端缓存一致性均不在已验证保证内。
硬件或文件系统谎报 fsync 不可由 Python 原型解决；本次没有模拟断电/磁盘掉电。

生产适配器必须核验宿主 boot ID、责任者 PID + process-start identity、固定锁 inode、原 runtime
及双方 session，绑定专属本地连接端点。建议受保护的 Unix-domain 连接，核验 peer credentials
并映射到已核验原会话；UID/token 字符串或文件内 `producer` 自报不能代替角色认证。
运行时若不能证明这些条件，返回能力缺口，不自动切换存储或获得部署权限。
隔离原型使用父进程持有的专用 Pipe 和测试角色表；Phase 4 改用生产 Unix socket/peer 身份
接口，但测试中的原生映射仍为 mock，**不证明目标 provider 认证已 live 验收**。

生命周期与线性化：

1. S0 预建私有 `control/`（0700）和固定 owner.lock（0600）；责任者生命周期内持有该 inode 的
   非阻塞独占 flock。锁不能 unlink/replace；取得锁只排除合作写入者，不证明旧原生操作已结束。
2. 所有新责任者都从 CLOSED 启动；原代次显式 arm 也需授权/pins/身份/存储/STOP 核验。
   运行时重复启动同一代次禁止；不能将“文件存在”推成“已 arm”。
3. 同责任者内部用短时串行 mutex 对 marker、审查结果、request 和新动作 intent 的准入与 STOP 排序。
   observe、模型审查、安全点等待、原生查询不能在锁内进行。锁内只做本地 pin、已有活身份核验结果的
   时效/代次检查、STOP 检查及文件提交；外部身份无法被此锁冻结，实际 gate 仍需原生重验。
4. 发布调用必须绑定 `ControlBinding(attempt_binding:Ref, control_id, generation)`、认证后的 actor、
   唯一路径、固定 bytes、有序 prerequisites 和本地 recheck。先重验所有前序确认和 pins，再
   `publish_new`（临时文件 fsync → 独占 link → 目录 fsync），成功返回后才插入内存确认。
   同路径不同内容不覆盖；重复同事实在 driver 对账层处理，底层发布仍拒绝已存在路径。
5. STOP 在相同 mutex 内先关闭新准入，再持久发布 STOP 记录；成功 ACK 必须等待屏障完成。
   持久化失败/回复丢失即结果未知，但当前责任者保持关闭。commit-first 保留事实，STOP-first
   禁止新提交；STOP ACK 前已准入的原生动作属于在途，先对账，不声称已撤回。
6. 查询只读内存确认和 exact bytes，不能写确认文件、获取/创建锁、执行 fsync 或补 marker。
   内存确认可以在 STOP 后仍显示 confirmed，它仅代表持久化事实，不代表当前可执行准入。

接口定义见 `bootstrap_protocol.CommitAuthority`：

```text
query(control, target: Ref) -> Confirmation
commit_new(control, actor, target: path, raw: bytes, prerequisites: list[Ref], recheck) -> Confirmation
stop(control) -> None                 # 仅在 durable STOP 完成后正常返回
reconcile(control, target: Ref, recheck) -> Confirmation  # 显式 execute 操作
```

Confirmation 绑定同一 control 和 exact target；状态含义如下：

| 观察 | 返回 |
| --- | --- |
| 同一存活责任者已完成规定屏障、pin 仍一致 | `confirmed` |
| 可查询该责任者，检查时目标不存在 | `not_committed`（瞬时诊断，不是永不提交的保证） |
| 已可见但未完成确认、fsync 失败、原确认者不可达/已崩溃、代次不匹配、hash 不同 | `durability_unverified` |

Confirmation 另带 `state`（`not_admitted` / `committed` / `needs_reconcile` / `unknown`），
由责任者在本代次内存记录上判定；它是分类，不是许可，也不替代确认查询：

| state | 判定条件 | `may_replay` |
| --- | --- | --- |
| `not_admitted` | 未取锁、未进入 dispatch、未记录 `attempted[target]`，且目标不存在 | true（同一 intent 可原地重试） |
| `committed` | 本代次已记录 `attempted` 且发布并确认 | false |
| `needs_reconcile` | 已记录 `attempted`，但没有完成的发布记录（可见文件不是确认） | false，只能对账原 pin |
| `unknown` | 记录存在但意图/字节不一致、发布结果无法判定、回复丢失、或目标存在而本代次从未写过 | false，只能对账 |

`attempted[target]` 记录先于 `publish_new`，因此“已记录但未发布”是一个可查类别，而不是从
`publish_new` 抛错反推。记录的意图优先于任何后续拒绝：已 disarm 的责任者对同一 target 的
再次提交必须报告 `needs_reconcile`，不得退化成“未 arm 可重试”。同一存活责任者之外的代次
不会被 arm 到前任文件上，所以 `not_admitted` 只覆盖“本代次没有写过且目标不存在”。

准入失败可以直接抛出明确错误；消费者不得将异常/超时转换成 confirmed。异常与回执同样携带
`state`/`may_replay`（`bootstrap_control.stated`），S5 在 `may_replay` 为 false 时绝不重试。
仅 `query` 返回值不能当作稍后 `commit_new` 的许可，最终调用必须重新准入。

### 5.1 provider 能力与拒绝码

两个 gate 角色的 provider 是**被声明的、被核验的属性**，不是读取器里的常量：它在已审查并固定
SHA 的 registration（每个 role 自带的 `provider`）或 Operator 身份输入里声明，再由
`swarm_ledger.runtime_binding` 对照 native 证据核验（pane 的 `source`/`agentType`、provider
`session`、transcript 根 `session_meta`）。`swarm/provider_capability.py` 是唯一的
provider → （证据格式、必须字段、transcript 记录、TUI adapter）映射表；两个角色入口和 S2 观察
都走它，因此不存在“另一处默认 trae”的旁路。

规则：

1. 只接受表里显式列出的 provider 名，逐字匹配（不折叠大小写、不去空格、不做别名）。未知名字
   按 unsupported 拒绝，**不**视为 trae，也不换 log_root 或 format。
2. 表中已知但本版本无法读取其证据的 provider 按 unavailable 拒绝，并在诊断里逐条列出缺失通道
   （`agent_hooks_pane_status`、`terminal`、`session_id`、`transcript_path`、`launch_token_hash`、
   `session_meta`、`turn_context`、`tui_adapter`），而不是只报一个笼统的 unverifiable。
3. 表里的能力是声明，不是证明：capture 返回的 observation 还必须实际带有声明要求的字段，否则
   同样按 unavailable 拒绝（不允许“provider 名对就算过”）。
4. 身份/进程/incarnation/launch-token/独立性/STOP/pin 门一律不变；能力检查只决定“这个 provider
   在本版本能不能核验”，不替代任何既有门，也不因为 provider 名字而放宽任何断言。

当前表有两项可核验 provider：

- `trae`：`runtime-state` + hook `launchTokenHash` + transcript 根 `session_meta` + 每轮
  `turn_context`，TUI adapter `trae-tui-runtime-v1`，`runtime_config` 是 Trae execution 配置。
- `pi`：`runtime-state` + hook `launchTokenHash`（Orca 的托管 pi 状态扩展把
  `session_id`/`session_file`/`launchToken` POST 到 `/hook/pi`）+ transcript 根
  `{"type":"session","id":<uuid>,"cwd":…}` + assistant 消息的 `model`/`provider`/`thinkingLevel`
  （`pi_transcript.py` 同时校验 `id`/`parentId` 链与时间不减），TUI adapter
  `pi-tui-runtime-v1`，`runtime_config` 是 **pi runtime policy** 记录。
  三个细节是硬要求，不是实现选择：transcript 必须是**单条线性链**（root `session` 记录之外
  只有一个 `parentId: null` 起点，其后每条都指向紧邻前一条），否则
  `pi_session_chain_broken`；freshness 以**被采纳的 assistant 设置记录**的时间戳为准
  （追加一条新的非 assistant 记录不能让陈旧设置变“新鲜”）；policy 以**已 pin 的 Ref** 传入，
  读取前后与观察结束后各重验一次，anchor 记录该 Ref，换文件或换字节即拒绝。
  滚到这里的行还必须是**在跑的归属**：单独的 `session_start` 快照按 resume 身份落盘
  （`providerSessionOnly`），读取器拒绝；面板所在宿主的投递也可能根本没到（见
  [operator-prepare.md「Pi Operator 的核验通道」](operator-prepare.md#agent--adapter-支持范围) 的两种成因与只读诊断
  `pi_hook_preflight.py`）。两者都只影响“能不能拿到行”，不放宽任何身份/commitment 门。

pi runtime policy（schema v1，精确字段 `schema_version,scope,provider,model,thinking_level`，
`provider` 固定 `pi`，`model` 为 `{provider,id}`，示例见
[examples/pi-runtime-policy.example.json](examples/pi-runtime-policy.example.json)）是 Trae
execution 配置在 pi 侧的对应物：审查并 pin 进契约的 `runtime_config`，由
`pi_tui.observe` 与 transcript 最新 assistant 轮次的 `provider`/`model`/`thinkingLevel` 精确比对。

已支持范围：`trae` 与 `pi` 都可作为 Operator 与 Coordinator（S2 观察 + S5 契约 + 启动门）。
Pi 与 Trae 的差异必须在契约里显式承担，不假装等价：

- `expected_effective` 只允许 `PI_SETTINGS`（`model`、`model_provider`、`thinking_level`、`cwd`），
  其余键按 `operator_session_expected_effective_provider_unsupported` 拒绝；不做跨 provider 别名。
- pi 没有 sandbox/approval/network 面，所以 `observation.roots` 是**审查过的声明输入**，
  观察器不声称已核实其生效（Trae 侧由 `turn_context.sandbox_policy` + `observe_write_roots` 核验）。
- pi 的 anchor 要求同一 runtime id（不做 Trae 的 epoch rebind）；换 runtime 即重新建立 anchor。

**仍未支持**：`coordinator_tui_scheduler.py` 的 completed-turn 读取
（`from trae_tui import observe` + `completed_turn=True`）仍是 Trae-only，pi 自动调度不能做；
operator materials 的 launch-plan 生成器（`coordinator_launch.py` / `trae_coordinator.build_trae_plan`）
也仍按 Trae 路径写。`coordinator_tui_continue.py` 的 adapter fence 已接通两个 TUI adapter（见下），
但只有单元覆盖、没有 live 证据。pi Coordinator
的 S0–S5 已可核验，但这些后续组件要单独迁移。S5 之后、Run 已建立时，
`coordinator_tui_continue.py` 现在通过 `tui_adapter` 的适配器接缝选择 reader：Trae 与 Pi 的 TUI 契约
都走各自的 `observe`/policy 输入，未知 adapters 仍以 `tui_continuation_adapter_unsupported` 明确拒绝
（此前非 Trae 一律拒绝）。**注意**：pi 的 continuation 代码路径已接好并有单元覆盖，但尚未在真实链条上
取得证据——attempt25 的 continuation 停在更早的 domain 输入（缺 `domain_binding`），没走到 adapter 校验；
在拿到真实 Run 的 turn-end 证据之前，不得声称 pi continuation 已验证。

同一类边界：`operator_session.py` 的 `observe()`（CLI 别名 `operator_prepare observe-coordinator`
/ `observe-session`）是**遗留的 Trae-only 观察入口**，它的输入 schema 没有 provider 字段，且两侧的
`runtime_config` 都是同一个 Ref 形状，所以它无法“按声明拒绝”而只能被声明为 Trae-only；pi 侧的对应
入口是 `bootstrap_identity` / `operator_session.observe_identity`（先经 `provider_capability` 解析
声明 provider，再决定读取器）。不要把 `observe()` 当成 pi 的替代入口。

| 入口 | 缺失/未知声明 | 已知但证据不可读 |
| --- | --- | --- |
| `bootstrap_identity.py`（两个 gate role） | `bootstrap_registration_provider_required`；未知名 `bootstrap_registration_provider_unsupported` | `bootstrap_operator_provider_evidence_unavailable` / `bootstrap_coordinator_provider_evidence_unavailable`，带 `missing_evidence` |
| `operator_session.py` | `operator_session_provider_required`；未知名 `operator_session_provider_unsupported` | `operator_session_<provider>_operator_unverifiable`（如 `operator_session_pi_operator_unverifiable`），带 `missing_evidence` |
| `bootstrap_tool.py`（S2 观察 / S5 TUI 契约） | `bootstrap_registration_provider_required`；未知名 `bootstrap_coordinator_provider_unsupported` | `bootstrap_coordinator_provider_evidence_unavailable`，带 `missing_evidence` |

拒绝发生在原生查询之前：不产生观察文件、不占输出目录、不发 gate、不 arm owner。
`missing_evidence` 是路由诊断，不是权限，也不表示可以改用另一 provider。
新增 provider 需同时提供可核验证据通道、对应 adapter 和离线回归，不能只加名字。

## 6. 显式恢复：不继承内存成功、不重跑生产

首版无自动 takeover/re-arm。责任者断连、死亡或代次变化，旧确认不能由文件/锁重建为历史成功。
新代次必须在原授权允许恢复的范围内，由操作者独立核验旧责任者已终止、所有原写入/原生操作已结清，
并重验原 runtime、Coordinator/Operator 活身份、原 pins、deadline、STOP 和存储。
核验不全或存在显式 STOP/disarm，保持关闭；用户另行决定恢复边界，不能删除 STOP 自动续跑。

受支持恢复登记采用新的不可复用 generation，绑定原 attempt-binding、旧/新责任者身份、终止/结清证据
及新连接端点，形成不可覆盖记录；binding 中的初始 generation 不回写，旧 token 永不再准入。
这是跨代恢复的后续契约，Phase 4 不提供该模式，仅支持同一存活 owner 的显式原字节对账。
仅 flock 可取得、PID 不存在或无输出不够。跨代登记和外部结清核验仍未实现；
原型用 harness 显式指定新代次并确认测试子进程退出，不伪造生产回执。

对每个已可见目标按依赖顺序 execute 对账：在关闭新业务准入时，核验完整目标与全部上游原 pins、
授权/角色/身份、原 writer 已结束；对同一文件执行 fsync，然后父目录 fsync，再读回原 pin；
成功后只为**新代次当前持久性**记录确认。失败继续 unverified，不改 bytes、不改 timestamp、不另换槽、
不重做 observe/审查。完成全链和控制记录对账后还需要显式 arm；`reconcile` 本身不 arm。
未观察到 durable STOP 也不能推导旧责任者从未接收 STOP；恢复核验无法排除未决取消时禁止 arm。

`tests/bootstrap_control_fixture.py` 的 `AuthorityFixture` 仅实现这些原语的隔离模型，
本地回调代表独立核验输入，不是认证或全链恢复器；无可部署 CLI。Phase 2 继续复用该责任者，
为每次提交（含原 builder 的直接提交）增加 harness 提供的本地 identity/authorization snapshot
检查钩子。原型未实现生产控制登记服务；新 driver 也仅用于离线链，不自动恢复或 re-arm。

## 7. 最终 request 准入及 S5 延续

Phase 2 已在原 `build_request(ref, *, require_live=False)` 上新增可选
`bootstrap_admission:RequestAdmission` 和 `authority:CommitAuthority`，两者必须同时提供。
非 bootstrap 历史调用不变；受支持 bootstrap 路径缺任何一项即拒绝，不能退回无控制发布。
`RequestAdmission(control, readiness_marker:Ref)` 不写入 request v5。

原 `prepare_request`、live caller、pin 重验、`validate_request` 和 output directory 检查保留。
只有最后 `publish_new` 委托给 authority；recheck 在短时准入内重验外部 pin、S1–S4 完整链和
confirmation、固定输入、代次/STOP、活核验结果时效及未变的目标，不能只是 wrapper 先跑 state。
真实 native query 在短锁之外，不能宣称 mutex 锁住 Agent 身份。

为了审计而不改 request v5，责任者须在提交前独占持久保存 `control/request-admission.json`：
`schema_version:1, kind:"strict_bootstrap_request_admission", attempt_binding, control_id, generation,
readiness_marker, request:Ref, actor:"coordinator", created_at, execution_authorized:false`。
记录预期 request bytes 的 pin，与同域准入一起确认；有 admission 记录无 request 只是 intent，
两者都确认才到 S5。未知结果只对账原 pin；不能生成新 request bytes/新时间重试。
Phase 2 的 `bootstrap_admission.commit_request` 已生成并确认此关联记录，随后同域提交
原 builder 生成的精确 request bytes；关联后发生 STOP 时保留 intent，但不发布 request。
关联存在而 request 缺失/未确认时阻断，不重跑 builder、不刷新 handshake 时间。

S5 及其它 mutation 的重试只覆盖 `not_admitted`（`may_replay` 为 true）的回执。owner 以
`bootstrap_rpc_rejected:<code>` 返回，历史实现里只有 `bootstrap_owner_busy_not_executed`、
`bootstrap_native_identity_timeout`、`bootstrap_identity_snapshot_expired` 属于该类：三者都发生在
`attempted[target]` 记录与 `publish_new` 之前，所以同一 intent 可在原地重试。判定以回执的
`state` 为准，错误码只作为责任人自报的细节；重试预算用尽时返回
`bootstrap_commit_unknown_requires_reconciliation`，不再回抛可重试的 busy 码。commit 成功后的
确认查询另外进行，只用尽时返回 `bootstrap_commit_confirmation_pending_requires_reconciliation`；
两者都表示“结果未知，只能对账原 pin”，不能再次 commit、覆盖固定槽或生成新 bytes。
`needs_reconcile` / `unknown` 在客户端统一映射为
`bootstrap_commit_requires_reconciliation` / `bootstrap_commit_unknown_requires_reconciliation`，
不保留原始错误码，以免调用方把未知结果当成分类型的失败去猜。

S5 后继续传递**同一控制实例和 request/S4 绑定**，禁止自动 disarm 或新 owner 无回执接管。
后续受支持 prepare / review-result publish / config publish / wait-return / gate / create 必须分别
接入准入或 intent：文件提交仍在同域；不可撤销的原生调用先固定 intent、退出短锁执行、原 ID 对账。
STOP 后不准入新动作，已准入动作 drain 并报告真实结果；不能宣称 STOP 撤销了已创建的 Run。
控制失联即阻断。Phase 4 已将下述实际 strict-start 入口接入这些规则；这是显式登记路径的
合作进程契约，不是 runtime 全局强制或对恶意同 UID 的安全隔离。

## 8. 只读 CLI 与状态含义

```sh
python3 -B swarm/coordinator_launch.py strict-bootstrap-state \
  --bootstrap /absolute/BOOTSTRAP \
  --expect-attempt attempt-id \
  --attempt-binding-sha256 <independently-fixed-sha256> \
  --check
```

也可直接执行 `swarm/bootstrap_events.py`。没有 execute、wait、repair、arm 或默认路径模式。
CLI 不做 native 查询、不执行脚本/模型、不加锁、不发布任何文件。使用 `-B` 避免解释器写 pycache；
读取可能更新文件系统 atime，不声称具有无痕取证语义。

- 合法前缀缺下一 marker：`pending_<stage>`，给出 `pending_stage,missing,producer`；
  若后面固定槽已有 marker，则是序列缺口，不 pending。
- 非法 schema/缺失已引用文件：`blocked_invalid_marker`；pin/身份/旧 context 不匹配：
  `blocked_stale_or_mismatch`；上游/重复 pin 冲突：`blocked_marker_conflict`。
- 显式 reject：`blocked_review_rejected`；过期：`blocked_deadline_exceeded`；读权限失败：
  `blocked_permission_denied`。多个错误同时存在时不保证唯一优先级。
- 完整合法链：`state:"durability_unverified", evidence_chain_complete:true`；
  返回纯 Ref 的 `request_input_preview`，不是完整 builder input，不发布 request。
- 所有输出固定 `diagnostic_only:true, ready:false, execution_authorized:false, identity_verified:false,
  last_committed_stage:null`；`last_validated_stage` 只表示已检查的文件前缀。
- `capability_gaps` 明示未连接 confirmation/live admission 和 review provenance；只读命令不能证明
  当前 STOP、arm、owner 或真实审查来源有效，不能据此驱动执行。
- **退出码 0 / ok:true 仅表示文件诊断成功**，包括 pending/unverified；错误为 2。
  永不返回 `ready_for_strict_config_request`，自动化不得把 exit 0 当作启动门成功。

调用者须独立固定 binding pin。检查会读其中约定的 CLI/授权/技能等文件（CLI 仅 hash，不执行），
不能将未经审查的 binding 当作任意路径读取代理。

## 9. 验证与后续边界

复现命令（`swarm/` 下运行，Python 离线测试，无 Agent）：

```sh
python3 -B -m unittest discover -s tests -p 'test_bootstrap*.py' -v
python3 -B -m unittest discover -s tests -p 'test_coordinator*.py'
```

新测试覆盖固定路径/逐阶段 pending、外部 binding hash、caller/observation freshness、身份错配、
上游冲突、纯 pins/元数据、布尔类型、重复 JSON key、缺引用、symlink/FIFO、审查 reject/错人/错材料、
pin drift、CLI 不支持 execute、检查无发布/进程调用，以及 Operator 调度纯路由。
原语使用真实独占 link、fsync、flock、独立测试责任者进程和跨进程查询，覆盖屏障前可见、
fsync 报错、屏障后确认前崩溃、owner 退出释放锁但不恢复确认、新代次默认关闭、旧代次拒绝、
STOP 两种顺序、持久 STOP 失败、禁止覆盖、精确字节恢复和 S5 同实例继续负责取消。


本地测试不证明目标存储断电耐久、生产认证、
真实审查质量、双侧模型执行机会或历史 strict-start 已支持 STOP。
Phase 3 的同链并发/恢复矩阵见[离线文档 §11](strict-bootstrap-offline.md)，Phase 4 目标核验见 §12，
Phase 5 才是真实 live 验收。

## 定位

要按符号找实现时先看 [ORIENTATION.md](ORIENTATION.md)（生成，`--check` 守着行区间）：
表里有条目就直接读它给的那段行区间，**只有表里没有条目时才用 grep 从名字反推位置**。
索引只回答“去哪读”，不回答“什么是真的”：围着它读完源码之前不得据它下结论。

## 后续章节

#10 – #13（离线纵向闭环、同链失败/收尾、开发交付与 S5 生命周期交接）已移到
[strict-bootstrap-offline.md](strict-bootstrap-offline.md)。这些章节是历史实测与离线验证，
不是 S0–S5 的唯一依据；开机读取应先读本文与 [operator-runbook.md](operator-runbook.md)。
