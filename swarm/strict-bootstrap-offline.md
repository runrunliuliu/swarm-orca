# Strict bootstrap 离线与历史验证（#10 – #13）

从 [strict-bootstrap-protocol.md](strict-bootstrap-protocol.md) 分出：开机必读是协议与
[operator-runbook.md](operator-runbook.md)；本文保留离线纵向闭环、失败/恢复实测、交付历史与
S5 生命周期交接。拆分只搬动字节，章节编号与内容未改。

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

`tests/bootstrap/test_bootstrap_failures.py` 新增 24 项测试，通过组合 Phase 2 fixture 复用
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
  `advance`（有界、默认 120s、上限 600s，`--until-stage 0..4`）把本角色的机械跳合并成
  一次调用：只自动完成 `caller-intent` / `observe-intent` 这两个工具自身produce 的动作，
  以及在**角色已写好全部 candidate** 时完成 submit/readiness；否则停并返回
  `needs_role_judgement` 与原 `candidate_path`。`reconciliation_required`、`pending` /
  阶段边界（`request_ready`/`s5_ready`）都立即退出，不重放、不代写、不跳级；每一步仍走
  同一 intent + owner commit + prerequisites + pin 校验，与手工 `complete` 字节等价。
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
registration schema v2 精确字段：`schema_version,attempt_binding,profile,log_root,roles`；
roles 恰含 operator/coordinator，各为 `{provider,process:{pid,start,boot,uid},session}`。
`provider` 是该角色真实 provider 的显式声明（不做大小写归一、不从 pane 标题或日志猜测）；
v1 登记缺 `provider`，不会被静默升级，按 `bootstrap_registration_invalid` 拒绝。
profile/log_root 为目标原 runtime 的规范绝对路径；process 是原 provider 根进程而不是 server PID。
不提供自动发现/绑定生成器，不把不知道的 process/session/provider 填成猜测值。
provider 能力表与拒绝码见 §5.1。

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
