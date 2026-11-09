# Strict bootstrap 协议、生产适配与生命周期交接

更新：2026-11-03。范围：新建 Trae TUI bootstrap attempt；不迁移历史 request、契约或 Run。

本文保留通用状态机、双侧工具交接及生产适配边界，不包含部署方的内部路径、真实身份
或历史验收报告。协议与同版代码共同维护；发布源码不表示已部署或通过 live 验收。
存储使用任务已批准的规范路径，按第 5 节核验文件系统能力，不仅凭 NFS 类型要求迁盘。


## 1. 协议定案

| 问题 | 固定选择 | 当前验证范围 |
| --- | --- | --- |
| STOP 与发布竞争 | 每个 attempt 单一控制责任者，进程内短时串行准入；预建固定 inode 的本地 `flock` 排除第二责任者 | 测试进程、真实文件、STOP-first / commit-first |
| 跨进程持久化确认 | `single-owner-memory-v1`；责任者完成 file + directory fsync 后才记录内存确认，消费者向该责任者查询 | link 后、fsync 错误、fsync 后确认前崩溃、代次切换 |
| S5 后责任 | 同一控制实例延续；v1 不做跨 owner 交接，也不在 request 成功后自动 disarm | 原 prepare/review/delivery/wait/publish/create 入口接入；native gate/API 为 mock |
| Operator 执行机会 | 精确原 Operator 的有界工具返回；固定 intent 对账，未知不重发 | 生产 RoleTool 双侧交还动作，模型审查/真实 provider 仍待 live 验证 |

不能将互斥、静态 pins 或内存确认当作活身份认证。三个 P1 的原语/接口在 Phase 1 固定，
原 builder 的离线闭环在 Phase 2 接通；Phase 4 开发及验证范围见第 12 节。

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
固定 intent 的 `payload.submission` 中另给唯一候选路径及提交方式，见第 12.2 节；
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

准入失败可以直接抛出明确错误；消费者不得将异常/超时转换成 confirmed。
仅 `query` 返回值不能当作稍后 `commit_new` 的许可，最终调用必须重新准入。

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

S5 及其它 mutation 的重试只覆盖“证明未写入”的回执。owner 以
`bootstrap_rpc_rejected:<code>` 返回，只有 `bootstrap_owner_busy_not_executed`、
`bootstrap_native_identity_timeout`、`bootstrap_identity_snapshot_expired` 属于该类：三者都发生在
`attempted[target]` 记录与 `publish_new` 之前，所以同一 intent 可在原地重试。commit 成功后的
确认查询另外进行，只用尽时返回 `bootstrap_commit_confirmation_pending_requires_reconciliation`；
它表示字节已准入、结果未知，只能对账原 pin，不能再次 commit、覆盖固定槽或生成新 bytes。

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
Phase 3 的同链并发/恢复矩阵见第 11 节；Phase 4 目标核验见第 12 节；Phase 5 才是真实 live 验收。

## 10. Phase 2 离线纵向闭环

实现入口为 Python 内部类 `bootstrap_driver.OfflineBootstrapDriver`，没有 execute CLI，
也没有接入 prompt、线上事件监听或历史 strict-start。构造时显式要求 offline fixture adapter；
该标记用于防止误用，不是生产认证或安全边界。

- `bootstrap_driver.py`：固定路径补查、独立 driver inode 锁、dirty-drain、两阶段有界 wait、
  四 marker 生产及原 Operator 生产/两次审查请求；通知只置脏，不递归执行模型。
- `bootstrap_admission.py`：复用只读 validator 的完整链验证与候选 marker 校验，逐项查询
  S0 之后的证据/审查/marker 确认；request 绑定原 S4、原输入与原 authorization refs。
  `CandidateReader` 仅为未提交的一个 marker 提供候选字节，CLI 仍只使用真实只读 reader。
- `coordinator_strict_request.build_request`：保留 prepare/live/pins/schema/output-dir 检查，
  新参数必须成对给出；仅最终发布委托给 authority，准入内再验全链。无参数时历史路径不变。
- `tests/bootstrap_control_fixture.py`、`bootstrap_flow_fixture.py`：分别提供测试责任者和
  确定性角色/runtime 适配器；适配器以独立内存账本核对结果来源，不信任自报 identity 字段。

`run(source)` 不需要外层逐轮提示：caller → 第一次 wait（observe、fields、contract review）
→ wait 返回 → Coordinator 实际执行夹具文件读取/证据生产 → 第二次 wait（readiness review）
→ 原 builder 发布 request v5。测试启动时四 marker 和所有后续固定产物都不存在；
不能用预先写好整链替代上述生产顺序。两侧适配器调用均在公共提交锁之外。

`control/` 中由测试 harness 预建 0700 目录与 0600 `owner.lock` / `driver.lock`；
driver 不删除或替换锁。`bootstrap_admission.control_paths()` 固定控制记录位置：

- `caller-intent.json`、`observe-intent.json`、`final-evidence-intent.json`；
- `fields-intent.json`、`contract-intent.json`、`readiness-intent.json`；
- `wait-contract.json`、`wait-readiness.json`、`downstream-intent.json`；
- `request-input.json`（原 input v4）、`request-admission.json`（第 7 节 schema）。

离线 intent schema 为 `schema_version:1, kind:strict_bootstrap_offline_intent, action,
attempt_binding,control_id,generation,actor,operator,prerequisites,payload,created_at,deadline,
execution_authorized:false`。payload 固定原请求/上游及所选路由；不是生产原生回执。
intent 已存在时只查询原适配器请求，未知/未接纳/执行中不重投。
字段与审查结果始终经同一 authority 持久提交；reject 不覆盖，approve 后还须验证完整关联与来源。

订阅后、等待前和有界 tick 都扫描固定槽。测试覆盖运行中置脏、并发进入睡眠窗口、
晚订阅、丢通知后补查、busy 延后/不支持 idle 安全点、未知投递后同 ID 对账，且生产调用只发生一次。
确认丢失不会由文件存在修补；已有 admission 但 request 不明时也不会生成新 bytes。
Phase 3 补齐同链异常窗口矩阵，并明确阻断无登记的换代；完整生产恢复登记及真实在途
原生动作 drain 仍须 Phase 4 适配，不能从测试责任者自动推导。

fake `downstream(request, callback)` 校验 request/S4/association 并在同一控制实例提交 intent；
STOP 拦截未准入回调，已准入回调仍属于在途，不声称可撤销。它不替代或调用真实 create/dispatch。
`strict-bootstrap-state --check` 的所有只读和 `ready:false` 语义保持不变。


## 11. Phase 3 同链失败、并发与恢复

`tests/test_bootstrap_failures.py` 新增 24 项测试，通过组合 Phase 2 fixture 复用
原始 `coordinator_strict_request.build_request` 与双侧角色适配器；没有另建演示 builder。
其中回复丢失矩阵覆盖 13 个发布槽，目录屏障失败矩阵覆盖 12 个发布槽，均从真实 S0 顺序运行到
原 request v5；另测 association-only 的恢复阻断，不能把它当已发布 request。

| 同链窗口 | 固定结果与禁止副作用 |
| --- | --- |
| caller/observation/fields/review/probe/manifest/marker/request 回复丢失 | 同一 owner 查询原 pin；生产、审查、builder 各一次；旧文件 bytes/mtime 不变 |
| 发布可见但 directory fsync 失败 | `durability_unverified`，owner 关闭；未经显式 reconcile + arm 不推进 |
| 原角色生产完成、结果提交回复未获知 | 原适配器从独立原结果账本对账；仅恢复原 request/raw 对应结果，不从文件自报身份推导来源 |
| association 已有但 request 缺失/未知（含 link 前失败） | `bootstrap_confirmation_unavailable`；不再进 builder，不刷新 request 时间、不换路径 |
| 字段/两次审查投递未知或尚未获接纳证明 | 固定 request ID 查询；不 resubmit，不另开 turn；原 deadline 内保持 pending |
| readiness reject、迟到结果、截止期到达 | 不发布 S4/request；STOP 后结果不准入；过期诊断 `blocked_deadline_exceeded`，恢复不能续期 |
| 重入、并发 drain、退出后通知、持续通知 | 单 drain owner；固定路径补查；每 tick 至多 16 次 advance，有界 wait 传递 monotonic 截止点 |
| driver 正在运行时 close / 已关闭后的 callback | 运行中拒绝释放锁；关闭后通知不能复活 owner；不启动第二 driver |
| request 真正 link 后、fsync 前与 STOP 竞争 | 查询只见 unverified；commit-first 最终保留确认、STOP ACK 后禁止 S5；不是撤回已准入动作 |
| STOP 持久化 ACK 失败 | driver/authority 均保持关闭；不能因未拿到 ACK re-arm |
| owner 关闭、旧 generation、锁 inode 替换 | 旧对象不能 arm/commit；关闭或锁失效的查询 unverified；未登记新 generation 不能接管 driver |
| S5 失联、回调失败/回复丢失 | 没有准入时不调用；已有 intent 只报告 `bootstrap_downstream_query_required`，不重复回调 |
| S5 intent 之后 STOP | 原在途 fake 动作可结算；禁止后续新动作，不宣称撤销已执行动作 |

实现补强：

- `directory_lock(create=False)` 除进入/退出检查外，可返回只读 inode 重验回调。
  driver/测试 authority 在每次本地检查/准入前调用；不声称能防恶意同 UID 替换竞争。
- driver close 显式封闭对象，晚到通知不复活；直接 producer/builder/wait/S5 callback 也计入
  在途操作，不能在 drain 之外提前 close 并释放锁。dirty-drain 有界让出，避免持续通知吞掉 wait 超时。
  适配器的同步调用本身仍须有界，本实现不能抢占挂死的 callback。
- 测试 authority close 串行封闭并释放 owner；arm/reconcile 在可能失败的检查之前关闭准入，
  防止检查失败留下旧的 armed 状态。STOP 后仍可查询已确认事实；close 后不再提供旧内存成功。
- 测试 Operator 独立保留 original request/result/raw 账本，query 可识别**已确认的原结果**；
  无对应生产账本或缺确认时不认领、不重新生产、不发布。该账本不是生产 native receipt。

恢复范围严格区分：本轮正向覆盖**同一存活 owner、同步原 writer 已返回**后的显式 exact-byte
fsync/reconcile + 独立 harness check + arm；保留全部 bytes、mtime、pins 和 attempt deadline。
Phase 1 的隔离进程崩溃/新代次关闭仍在回归中；Phase 3 同链证明旧 owner/未登记换代不能推进，
没有实现自动 takeover、生产跨代恢复登记或真实原生动作结算。缺确认不是重做生产的许可。


## 12. Phase 4 开发交付：生产工具与实际 S5 入口

原生 prompt delivery 的回执能力不等于 bootstrap 双侧安全点；Run 阶段 TUI continuation
不能直接用于尚无 Run 的 S0–S5。本实现采用原角色主动调用的有界工具返回，不新增 TUI 输入通道。

真实原角色会话映射、工具返回后的模型执行及审查仍需授权验证；开发完成不等于阶段 4
双会话验收通过，也不自动开放阶段 5 的 Run/Worker 启动。

### 12.1 实现及控制边界

- `bootstrap_identity.py`：Linux boot/PID/start/UID、SO_PEERCRED、原 provider 进程树和独立
  registration pin；两角色进程树不得嵌套。native terminal/incarnation/session、hook launch
  commitment、注册进程环境及 transcript 连续性共同核验，环境提示/token 本身不能证明身份。
  查询在短锁外执行，每轮 native 核验总预算 20s、单调用最多 5s；成功快照租期 30s，
  剩余不超过 5s 时提前重新核验。准入内重验本地 pins/进程/deadline，并在慢 I/O 后检查租期。
  自然过期或明确的 native 查询超时暂缓新准入，成功重验才续租；不因缓存心跳滑动续租。
  文件系统阻塞不具备硬实时保证。真实身份/pin 等核验失败关闭准入；身份恢复仍须原
  Operator 显式 arm，不能因后续心跳或刷新成功自动恢复业务提交。
- `bootstrap_control.py`：独立生产 owner 和 Unix socket 客户端，不导入测试 fixture。
  单次登记 `control/owner.json`，固定 owner.lock；服务从未 arm 的初始化态开始，重启不能复用 generation。
  只有从未 arm、未失效的本代初始化态可报告 `awaiting_arm`；失败/恢复后的关闭仍拒绝准入，
  不因收到心跳自动 re-arm，也不把恢复状态混作首次启动等待。
  角色/固定槽 allowlist、逐提交屏障、跨进程只读 exact-byte query、STOP 与同 owner 原字节对账。
  对账仅接受本 owner 已尝试且 writer 已返回的提交，完成后仍关闭，需再 arm。
  owner/socket 退出后不自动删除登记或 endpoint，不接管新代次。
- `bootstrap_transport.py`（2026-11-03）：客户端不再通过自身 `/proc` 核验宿主 owner。
  `owner.json` 使用 schema v2，新增 owner 生命周期内生成的 Ed25519 公钥；独立审查并
  固定整个登记的原始字节 SHA 后，客户端验证每次 RPC 的签名回复。回复绑定随机 256-bit
  nonce、完整请求摘要（含操作、参数及 control generation）、owner pin 和结果；拒绝
  篡改、跨请求重放、替换公钥、无签名回复及 schema v1 登记，不自动迁移旧 owner。
  宿主仍通过 SO_PEERCRED、UID、boot/start、原角色进程树和原生会话认证调用者，启动 owner
  时要求进程 PID 与 `/proc/self/stat` 的视图一致；没有关闭沙箱或放宽身份门。
  依赖双方可执行的 `/usr/bin/openssl`（本轮核验 3.0.20，须支持 Ed25519 pkeyutl rawin），
  单次子进程超时 5s。私钥只保存在 owner 内存并经 stdin 交给 OpenSSL，不写入文件、argv
  或回执；临时文件仅含公钥、消息摘要及签名。保持 cooperative same-UID 信任边界，
  不宣称能隔离可读取 owner 内存的恶意同 UID 进程。
- `bootstrap_tool.py`：双侧独立 tool.lock；`pull` 默认 30s、上限 60s，返回 `action` / `pending`
  / `reconciliation_required` / `request_ready` / `s5_ready`。固定槽补查不依赖通知。
  每个动作一个不可覆盖 intent；超时、断连、intent 有而结果无只对账，不推断未执行或重发。
  RPC 超时不撤回服务端已准入提交；提交结果未知时必须 query 原 pin。单次请求 4 MiB 上限。
  只有机械只读的 heartbeat/check/query 等待域可将超时返回为 `pending`；该域禁止提交、
  arm、STOP、settle 和 reconcile。实际 step 在域外重新校验，不将写入结果未知吞成 pending。
  失败回执新增白名单脱敏 `reason`，区分进程不可见、proc 权限拒绝、宿主 PID 视图不一致
  与签名失败等；未知异常不回显私有路径或原始错误。签名/传输失败不能确认持久化，query
  返回 `durability_unverified`；协议签名也不替代原 file + directory fsync 确认。
  `bootstrap_confirmation_unavailable` 仍在 `reason` 中保持原代码（调用方按字符串比较），
  另在 `diagnostics` 里给出精确 `target`/`sha256`/查询 `status`：只用于定位是哪个固定槽
  未确认（已见调用方归错阶段），不授予权限，也不代表该槽可删可重写。
- `bootstrap_actions.py`：统一 S1–S4 的动作数据，生成计划、owner 槽和 intent 的固定契约。
  `complete` 分发原机械 producer 或校验/发布候选；`inspect-action` 独立只读，不取写锁，
  deadline/STOP 后只查询同 owner 的原提交，不恢复执行；细节见第 12.2 节。
- `produce` 在原角色运行原 strict-caller-check / `trae_tui.observe`；各自另有固定执行 intent，
  禁止用通用 submit 替代这两个机械生产者。字段与两次审查交回原 Operator，通过精确 intent
  和返回的 candidate 路径/原始字节 SHA 显式 submit；不能对这三个动作调用 produce，不能
  直写最终槽。工具不生成 approve。真实文件探针仍由原 Coordinator 执行。
- `bootstrap_s5.py`：显式 `--bootstrap-owner` 双 pin，通过作用域内 I/O guard 将原
  prepare/review/delivery/config-wait/publish/create 的最终文件交给同 owner；固定 S5 intent
  防重放，原 request v5、gate/live 校验和 NFS 兼容 commit-last 方案保留。
  登记 binding 存在（包括悬空链接）而缺 owner 时拒绝，不退回历史路径。
  `publication-intent` / `create-intent` 已准入的 native 调用在短锁外完成；STOP 后仅允许原
  `operator-gate.json` / `create-response.json` 结算，不能发布 gate-ready/created 或新 intent。

### 12.2 显式工具契约

S0 的 binding、授权、registration 必须独立审查并固定 SHA；不由待验证角色自报来反推身份。
registration schema v1 精确字段：`schema_version,attempt_binding,profile,log_root,roles`；
roles 恰含 operator/coordinator，各为 `{process:{pid,start,boot,uid},session}`。
profile/log_root 为目标原 runtime 的规范绝对路径；process 是原 provider 根进程而不是 server PID。
不提供自动发现/绑定生成器，不把不知道的 process/session 填成猜测值。

统一入口：`python3 -B swarm/coordinator_launch.py strict-bootstrap <mode>`。

| mode | 必需参数（均为绝对规范路径及原始字节 SHA） | 行为 |
| --- | --- | --- |
| provision | `--binding --binding-sha256 --execute` | 私有 S0 子目录及固定锁一次性建立，不覆盖旧状态 |
| serve | 上述 binding，`--registration --registration-sha256 --endpoint --execute` | 前台 attempt-local owner；输出 owner pin，不自动 arm |
| plan | `--owner --owner-sha256` | 只读返回双方完整阶段动作与 pull 命令 |
| arm / stop | owner 双 pin、`--execute` | 原 Operator arm；任一原角色 STOP |
| query | owner 双 pin、`--input --input-sha256` | 独立消费者查询精确提交，无写入/补确认 |
| heartbeat | owner 双 pin、`--actor`，不带 execute | 原角色按需查询带签名的 owner 初始化/就绪状态，无发布或恢复 |
| reconcile | query 参数加 `--execute` | 原 Operator 同存活 owner 原字节屏障对账，不重做生产 |
| pull | owner 双 pin、`--actor --timeout --execute` | 在原角色已有工具上下文内有界等待/交还动作 |
| produce | owner 双 pin、`--actor --intent --intent-sha256 --execute` | 原 caller / observe 机械生产 |
| submit | produce 参数加 input 双 pin | fields / 两次 review 的候选；input 必须为返回的 `submission.candidate_path`，不是最终 `result_path` |
| readiness | produce 参数加 input 双 pin | input 是返回的 `submission.outputs` 对应的候选 probe Ref 有序清单；提交 probes/manifest |
| complete | produce 参数 | 按固定 action 分发；从返回的候选路径读取实际字节 pin；不写候选、不生成证据或批准 |
| inspect-action | owner 双 pin、`--actor --intent --intent-sha256`，不带 execute | 只读查询原提交记录与精确输出；永远 `retry_allowed:false` |
| build | owner 双 pin、`--actor coordinator`、input 双 pin、`--execute` | 原审查 task input + 原 live builder，同域发布 request v5 |

endpoint 父目录须 0700，可使用本机 `/tmp` 下唯一私有目录作为 IPC；它不是证据存储迁移。
binding、registration、owner.json 和全部业务产物保留在指定证据存储。`serve` 不是全局 daemon
部署，启动仍要满足当前任务权限；离线测试不构成部署许可。

双方须在原 model turn 中调用 `plan` 并持续按返回动作继续；pending 可以在原 deadline 内再次
pull，未知不能重做。空闲且没有在途工具调用的 TUI 无自动唤醒能力。prompt 已区分登记路径与
历史直接 request 路径，不允许先走历史发布再补 bootstrap。S5 的计划传播 owner pins；
bootstrap `strict-config-wait` 因写入固定 intent 需 `--execute`，历史无 binding 路径不变。

#### Operator 候选与 owner 最终发布（2026-11-03）

本轮扩展为双方统一的机械交接协议：`bootstrap_actions.py` 是 S1–S4 六个动作的唯一表，
共享 actor、target、mode、允许的 marker 数和 input schema。工具的 intent、分发、plan
动作列表/阶段说明和 owner 动作槽从此表生成；不建立第二个业务调度器，S5 继续走原入口。

所有动作固定 `payload.operation` v1；三个 Operator 动作及 Coordinator 的
`final-evidence-intent` 还返回 `submission`，与固定 intent 的 `payload.submission`
逐项相等。当前为 schema v2：`schema_version,action,actor,mode,input_schema,final_path,
final_writer:"commit_owner",outputs`，其中 outputs 是有序的 `{candidate_path,final_path}`。
三个 Operator 动作另有便于直接使用的顶层 `candidate_path`；Coordinator 的 outputs
严格对应 binding 的 `file_tool_evidence_paths`，顶层 final_path 则是最终 readiness manifest。
候选路径由工具确定，不要求模型选路径，不预写候选内容；可变说明文字不进入固定契约。
`result_path == submission.final_path` 仍表示最终输出，绝不表示文件工具写入许可。

以下路径均相对本 attempt 根目录；实际返回为规范绝对路径：

| action | Operator 文件工具唯一候选路径 | owner 唯一最终发布路径 |
| --- | --- | --- |
| `fields-intent` | `operator/new-contract-fields.candidate.json` | `operator/new-contract-fields.json` |
| `contract-intent` | `operator/contract-fields-review.candidate.json` | `operator/contract-fields-review.json` |
| `readiness-intent` | `operator/final-readiness-review.candidate.json` | `operator/final-readiness-review.json` |

Coordinator probe 同样使用候选，例如 `coordinator/file-tool-probe.candidate.json` →
`coordinator/file-tool-probe.json`；以返回的 outputs 为准，不手工推导文件名。
多个 probe 的候选同名（如两个 final 仅扩展名不同）、或候选碰撞任意 owner 槽时，动作拒绝创建。

原角色的操作顺序：

1. `pull` 返回新 action 后，读取精确 request、固定输入和证据。字段动作的
   `payload.candidate_template` 已绑定固定 fields、原观察和 registration 的 profile/log_root；
   审查模板仅填固定 request/subject/evidence/operator，`decision/notes/reviewed_at` 留 null，
   必须由原 Operator 独立审查后填写，模板本身不构成批准。
2. 用文件工具只写 `submission.candidate_path` 或 `outputs[].candidate_path`；
   Coordinator 必须实际完成 probe。不要覆盖已有候选或写任何最终槽，模板不证明实际读取。
3. 同一原会话执行新 action 返回的 `complete_argv`（argv 数组，保持参数边界，不用 eval 拼接）。
   它已固定 owner、actor、原 intent 双 pin，根据候选当前原字节计算 SHA 并分发。
   低层 `submit/readiness` 仍可传显式候选 pin；`produce` 仅接受 caller/observe。
4. 内容检查通过后，owner 先发布 `control/<action 去掉 -intent>-submission.json`：记录原
   intent、精确 inputs/outputs（readiness 含 manifest pin），再按该记录发布最终文件并确认。
   候选不具备 owner confirmation；必须核对最终 pin，不能以候选 pin 或记录存在代替最终确认。

提交在**任何提交记录/最终文件写入前**及每次写入重查时，校验原角色/阶段/动作/请求、唯一
候选路径、原字节 pin、规范非软链接路径与单硬链接。fields 使用与 S3 相同的契约构建校验，
含固定输入、观察绑定、禁止已有 Run/schema/freshness；review 使用与 marker 相同的 schema、
请求/subject/evidence/operator 精确绑定及时间、decision 检查。合法 reject 可保存为已确认审查
证据，但 marker 必须 approve 才能推进。前置校验不证明审查真实性，不代替独立审查。

readiness 在第一笔提交前检查**整批**候选数量、顺序、路径、pin 和全部最终槽为空；
逐笔发布时重新核对整批输入。整批不是跨文件原子事务，部分完成即保留原记录转对账；
不采纳已有 probe 最终文件，不自动补发剩余 probe 或重新生成 manifest 时间。

误将最终路径作为 input 返回 `bootstrap_candidate_is_owner_output`；其他路径返回
`bootstrap_candidate_path_mismatch`；在正确候选之外发现无确认的最终文件返回
`bootstrap_owner_output_unconfirmed`。对字段/审查调用 produce 返回
`bootstrap_operator_action_requires_candidate_submit`。这些本地拒绝不发起 commit/reconcile，
不删除、覆盖或收编错误文件，也不因路径校验失败而关闭 owner；这不表示污染的 attempt
可以继续推进。底层身份、STOP、pin、owner 失效仍按原有拒绝规则处理。

重复 `pull` 保持原 intent、候选路径、时间和字节，返回 `reconciliation_required`，
`complete_argv:null`；仅新 action 给出 complete 命令。原新动作的首次完成仍受提交检查约束，
重复 pull 不发新的许可。所有返回均附 `inspect_argv`，只读报告原提交记录的确认状态及
精确输出的 owner query；只有原记录和全部预期输出均 confirmed 才报告 confirmed。
它永远不授予 retry、不 re-arm、不 reconcile、不重做生产；记录/文件缺失也不证明未准入。
只读入口不取得 role 写锁、不要求执行态新鲜，deadline/STOP 后仍可查询同一存活 owner；
此时 confirmed 仅证明历史持久化，不表示产物仍新鲜可用或允许恢复执行。owner 不可达时
仍不能补造确认，原 binding/intent pin 不匹配也不能绕过。
已存在提交记录时拒绝 complete，未知输出须保全并对账，不能重放；无 mutation 已发生的
本地候选格式错误可在明确确认后修正候选并使用原 intent，不可由“未看到文件”推断这一前提。
只有同一存活 owner 自己登记过的原提交才能显式 reconcile；手写最终文件不满足该条件。
“owner 确认”指持久化提交回执，不是补一次人工批准，也不能靠延长心跳获得。

这里的 owner-only 是工具协议/确认门，不是同 UID 的 OS 写入隔离；仍有直接文件访问能力的
角色可能绕开工具写错路径，系统会拒绝推进而不会把文件收编为合法 owner 输出。

这是生产 tool action/intent 的显式约定，不给冻结的 fields/review request v1 或 request v5
加字段。旧 intent 缺 operation v1、或仍固定旧 submission v1 时，新的执行入口拒绝
（`bootstrap_action_contract_mismatch` / `bootstrap_submission_contract_mismatch`）；只读查询
不把它升级为可执行动作。重新 pull 不覆盖旧 intent，不静默迁移已有 attempt，不修改旧 live
证据或自动重启验收；后续新 attempt 须交接一致版本代码/计划。

#### 初始化等待、慢处理与心跳（2026-11-03）

`owner.json` 仅表示登记已发布，不能当作已 arm。外层审查固定 owner pin 后，由原 Operator
显式 arm；原 Coordinator 首次 pull 可收到 `pending` / `reason:awaiting_arm`，在原 turn 和
原 deadline 内继续有界 pull，不能自行 arm、另开角色或把首次等待当作恢复失败。

每轮 pull 先走同一 owner RPC 的按需 `heartbeat`，经 peer/原角色身份重验及签名、nonce、
owner pin 校验，返回 `awaiting_arm` 或 `ready`。等待结果包含 `last_verified_heartbeat`
（无记录则 null）：owner pin、actor、state、客户端 `received_at`、`round_trip_seconds`、
`evidence:signed_request_bound_reply` 和 `execution_authorized:false`。ready 只表示该次检查时
owner 已 arm；不是业务进展、产物持久化、Agent 活跃推理或启动授权证明。

只读等待用尽预算返回 `pending` / `reason:read_only_poll_expired`，正常等待下一阶段为
`reason:waiting_stage`；均保留原 attempt deadline，`current_liveness:unverified`。
最近心跳是历史观察，未收到新心跳可能是慢处理或通信问题，不证明进程已死，也不能证明
当前仍健康。仅当需要继续观察时，在原预算与 deadline 内重拉；不因心跳自动延长截止期。
一次 CLI 调用只携带本次客户端已验证的最近心跳，不从未认证的文件补造历史健康状态。

身份快照自然过期不等于身份变化。30s 租期由一次成功的完整原生身份重验更新；缓存内的
有效签名心跳只更新 `last_verified_heartbeat.received_at`，不会延长身份租期。请求遇到
剩余租期不超过 5s 或快照到期时先重验；如果后续 heartbeat/check 或写入前只读检查再次
耗尽租期，最多再重验一次并重做该段只读检查，仍过期则退出。每次重验各自受上述 20s/5s
预算限制；没有无限循环，也没有后台续租线程。

临时原生查询超时或有界重验后仍自然过期，只有带精确类型/原因的签名拒绝才能在机械
只读 polling 域返回 `pending` / `reason:identity_reverification_pending`；最近心跳仍是
历史记录，`current_liveness` 仍为 unverified。保留原 arm/初始化状态，但失效租期阻止新
写入；后续成功重验后可继续原状态，不自动 arm 初始或已关闭 owner。普通错误文本含
timeout 不足以触发此分支，权限/原生非零退出/身份变化等仍拒绝。成功刷新与心跳均不
延长 bootstrap/任务 deadline、授权/gate TTL 或预算；首派 TTL 仍按原门链合法刷新。

写入前自然过期的重验发生在短锁外；重新进入锁后再次检查前置确认和原 caller。该重试
不包含 `attempted` 登记、文件发布、机械 producer 或原生动作；登记/发布开始后的任何
异常均不重放。实际 mutation RPC 的超时/拒绝不吞成 pending，未知结果仍对账原 pin。

这不是独立常驻心跳线程：心跳与实际请求共享串行处理路径，若 native 身份读取、文件 I/O
或签名处理阻塞，新心跳也可能延迟；它不能定位具体慢点或证明处理中的业务持续前进。
文件系统与加密操作仍有各自执行边界，pull 不是硬实时抢占机制。明确收到的 STOP、身份、
签名、pin 或 owner/generation 错误不降级为普通 pending；对账关闭态不报 awaiting_arm。
实际提交在途或回复丢失仍属于结果未知，先对账原 intent/result，不重发、不以心跳代替确认。


### 12.3 验证与限制

完整测试使用 `tests/run_bootstrap_validation.py --parent <existing-canonical-directory>`；
保留两个测试日志、mount 类型/选项、源码 pins、耗时及读回 report。新增生产测试覆盖真实
socket/peer/独立只读消费者、角色/路径/owner 拒绝、身份失效不自动 re-arm、fsync 缺口对账、
双侧工具返回、原 builder 与实际 S5 全链、STOP-before-create、STOP 后仅结果结算、机械生产
未知不重放及 binding 缺 owner 的 fail-closed。原生身份和 gate/Run API 为 mock。

## 13. S5 后生命周期交接（2026-11-03）

新建生命周期只接受 schema v2，显式固定 `execution`、`workers`、原 `bootstrap_owner`，
以及内嵌 `runtime:{schema_version:1,deadline,authority:[Ref,...]}`。历史无 runtime 的 v2
按原规则读取，新 prepare/owner spec 提交不能省略该政策；不静默迁移。
新注册 attempt 在 prepare/review 后、strict-config-publish 前完成生命周期准备；不能只
创建 Run 就结束交接。完整字段、命令、角色模板及限制见 [Operator 启动生命周期](operator-startup.md)。

新增版本是外围激活契约，不修改 request v5、原配置 v3、prepared commit 或两阶段门禁：

| 固定产物 | 发布/确认角色 | 引用方向与作用 |
| --- | --- | --- |
| `BOOTSTRAP/lifecycle/spec.json` | 原 Operator → 同一 owner 确认 | 固定模式、sender、目录、deadline 和未来 lifecycle 路径；不反向引用下游 hash |
| `BOOTSTRAP/lifecycle/activation.json`，schema4 | 原 Operator → 同一 owner 确认 | 引用已审查的 base config 和 spec，不重写 base config |
| `BOOTSTRAP/lifecycle/lifecycle.json`，schema2 | 原 Operator → 同一 owner 确认 | 引用 activation/spec，固定解释器与源码 pins |
| delivery schema3 | 原 Operator → 同一 owner 确认 | 保留原 request/preparation/review，同时交付 activation/lifecycle；waiter 返回新 plan |
| `state_root/binding.json` | 原 Coordinator → 同一 owner 确认 | 引用上述 pins、created 回执和精确 Run/owner/generation |
| 各动作 task/accepted/executing/complete 与结果 | 注册表规定的原角色 → 同一 owner 确认 | 明确发布、接收、执行、完成，引用原业务证据，不复制 outbox |

角色动作由 `startup_handoff.ACTIONS` 注册并生成入口：Coordinator materials → Operator
review → Coordinator dispatch → Coordinator continuation。前两步固定候选、独立审查
和最终契约；dispatch 必须核验原生接受证据，不能只凭 gate 进入 continuation。
无 Worker 的显式不适用决定经两角色真实 run-readiness 检查，不伪造首派。
TTL 刷新只允许原 Operator、原契约、原 session receipt、且尚无派发执行/原生 intent；
不可变刷新链不覆盖旧 gate，不能以刷新作为未知派发的重放许可。

生命周期观察层复用原 monitor prepare/run/verify 和 scheduler，不再写一个业务轮询器。
`run_created`、所选模式的 `runtime_ready`、业务 `acceptance_complete` 分开；历史 milestone
不证明当前健康。监测到未完成交接却已 idle 时明确阻塞，但 helper 不能强迫模型保持活跃。
缺少受支持且已授权的恢复通路时不自动唤醒或换角色。

模式覆盖 continuation、monitor、scheduler、turn-end 及最终发送边界。autonomous 要求
当前执行器/scheduler readiness；native-event/manual 仅观察、不自动发送，窗口过期也
不自动改模式。native-event 额外要求原 Operator 固定指定触发源的独立预检；预检不是
实际 idle/唤醒/业务验收。未知在途发送阻断隔离前提，排队 outbox 也必须检查模式/STOP。

owner 的只读、签名且请求绑定的 `observe`（历史链）与 `runtime-observe`（新链）中，
同 UID sender 只能取得当前健康状态，
不取得原角色的审查/arm/commit 权限。发送前同时核验历史确认和当前 owner 健康；
原 owner 关闭、STOP 或身份失效不能用历史 confirmed 绕过。

运行期准入要求原 owner 确认在启动 deadline 前建立的完整 Run/admission/continuation
链，以及当前精确 Run/generation、原角色进程/会话、pins、STOP、独立固定的 runtime
期限和动作条件。原 attempt deadline 和 Operator 无竞争输入要求继续约束启动动作，
但不撤销此前合法建立且仍有效的 runtime 路径。调用方不能传 scope 自选检查集合。
runtime deadline 可经独立审查显式 null，不是自动延期；continuation 必须完全匹配。

执行器在原 monitor 锁内、首 tick 前把精确配置接收写入已有不可变 launch receipt，
绑定 Run/generation、lifecycle/continuation/deployment、sender、运行政策及原 owner。
verify 同时核验原 receipt 和当前健康；历史接收不证明当前 ready，不转移 owner/业务/审查权。

后续 Operator 输入使用具名 `runtime-review-input`；目前只接纳精确请求、来源、Run、
原生邮箱快照、pins 和逐条处理回执的 `no-authority-change` 审查。原 owner 选择内容寻址
的唯一目标独占发布；不消费/ACK、不自动扩大授权，不自动处理任意业务输入。
`runtime-attest-trigger` 复用既有触发源预检入口，保留隔离模式零额外发送。
字段与命令见 [运行期输入协议](operator-startup.md#运行期输入与暂时性复核)。

经签名、精确类型/错误码匹配的只读复核 timeout/lease-expiry 或输入待审可返回 typed
pending，monitor 原循环最多连续复核 3 次、期间不发送/准入，成功再继续；耗尽退出码 3。
一般权限/连接失败不降级 pending，未知 mutation 只对账，STOP 不清除；慢 native 查询
不持有 owner 准入锁，返回后及发布前复查期限/STOP/身份/pins。

保留边界：原 owner 不在 created/runtime_ready 时自动退出，不支持跨 owner takeover、
授权变更自动接纳或 pending 耗尽后的自动恢复，不以此次本地接通宣称无限期自治。
部分/未知 action 只提供 inspect
与原操作对账，不自动补 complete；新模式的旧 continuity 恢复入口失败关闭。
历史 schema 可读取不等于可以绕过源码 pins 在新版本下恢复执行。
