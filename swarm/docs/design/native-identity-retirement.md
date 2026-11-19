# Native identity 退休记录（strict 握手 gate-role 核验）

**状态：仅存档，无实现。** `bootstrap_identity.NativeIdentity` 已于 2026-11-19 删除；本文只记录它
编码过的设计意图，避免那段推理随代码一起消失。它不是待实现计划，也不授权任何部署、重启或门禁变更。

代码仍可从 git 历史取出：`git show 2ee9a5a2:swarm/bootstrap_identity.py`（删除前的最后一版）。

## 为什么删

旧握手（S0–S5）在 2026-11-13 删除后（见 [strategy](testing/strategy.md:263)），这个类没有任何调用方。
它占 `bootstrap_identity.py` 的 216/322 行，而该文件位于身份核验路径上：阅读者打开文件会以为
「原生身份核验正在生效」。这类残留比普通死代码危险——它不是「没用的代码」，是「看起来是控制的代码」。
同批删除的还有它独占的证据助手（`host_process`、`process`、`unchanged`、`descendant`、`peer`、
`identity_pair`）与只被它抛出的异常（`IdentitySnapshotExpired`、`BootstrapAdmissionClosed`、
`NativeIdentityChanged`）；留下它们只会让下一个阅读者再查一遍同样的问题。

保留下来的是 `IdentityVerificationPending` 与 `OperatorInputPending`：`operator_monitor.run` 仍用它们
区分「重新核验未完成」与「原 Operator 必须先处理输入」，两者的 `next_owner` 与退出路径不同。

## 它编码的设计（按主题，不是按函数）

**registration 是独立评审的 Ref，不由对端提供。** `registration` 与 `control.attempt_binding` 都按
pin 读取；每次 check 重新 `pinned()`，所以「同一路径换了字节」当场失败，而不是被当成同一份授权。

**provider 是被观测到的会话属性，不是读取器里的常量。** 每个角色在 registration 里声明自己的
provider，经 `provider_capability.require(...)` 解析，再对**实际观测**复核一次
（`role_capability(role, observed=...)`）。名字与证据通道任一不匹配就拒绝，且拒绝里带缺失的证据通道，
不静默回退到另一个 provider。

**roots 必须是 provider 原始进程，不是 runtime/server PID。** 构造时要求两个角色的 root 互相不在
对方的进程树内（`descendant` 双向检查），否则 `bootstrap_roles_not_independent`：两个角色共用一个祖先进程时，
「双人」只是 UI 上的两条终端。

**存活的 root 本身不够。** 每次 refresh 除了 `unchanged(anchor)`（`/proc/<pid>/stat` 的 start tick +
`boot_id` + uid），还要核验终端 incarnation、provider session、launch commitment
（`require_launch_commitment`）与 transcript 归属；三者任一漂移就带字段诊断失败。

**采集在 admission 外，判定在短租约内。** `refresh()` 做慢 I/O 并把结果连同过期时间一起存下；
`check()`/`check_runtime()` 只读快照。失败路径刻意让慢 I/O 不延长租约：先把 `expires` 置 0，
再跑本地不变量，最后才发外部查询；抛 `subprocess.TimeoutExpired` 时先重跑本地检查，不把「本地 pin
变了」藏在「原生超时」后面。永久约束总是先检查，租约最后检查。

**未知与死亡要分开。** `IdentityVerificationPending` 表示「没有新证据，既不接纳新人也不断言死亡」；
`IdentitySnapshotExpired` 是自然过期；`NativeIdentityChanged` 带 `identity_pair`（前后 8 字符前缀 +
是否相等）说明**哪个字段**漂移；`BootstrapAdmissionClosed` 只关闭启动动作，不影响已建立的运行时。

**Operator 输入不是角色变化。** mailbox `check --peek` 非空时抛 `OperatorInputPending`，让原 Operator
处理确切输入，而不是把它读成新的 role identity。

**环境变量只用于绑定，不用于打印。** 仅从原始 root 的 `/proc/<pid>/environ` 读
`ORCA_TERMINAL_HANDLE`、`ORCA_PANE_KEY` 与 `ORCA_AGENT_LAUNCH_TOKEN`（其 digest 必须等于观测到的
`launch_token_hash`），从不写入回执或日志。

**边界：同 UID 协作，不是防恶意对端。** 模块 docstring 当时就写明：同 UID 的进程可以读彼此内存与环境，
这层核验防误填与事故，不防冒充。若将来重新引入原生身份核验，这个边界必须一起重新声明，不能只说"核验原生身份"。

## 重新采用前必须先回答

1. 谁来提供 registration，且为什么它不能由被核验的一方提供？
2. 角色的 root 进程如何确定，双角色独立性怎么证明（不是断言）？
3. 租约长度与失败语义：过期是「待重验」还是「死亡」，谁能区分？
4. 哪些证据通道是本机能验证的，缺失时拒绝码是否仍带通道名？
