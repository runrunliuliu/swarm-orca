# 宿主机会话绑定采集器

用于 Codex Coordinator/Worker 的 `/proc` 绑定读取被 Agent 沙箱拒绝时。
实现：`swarm_ledger.binding_host`（Linux 宿主机服务）、`swarm_ledger.binding`（沙箱端验签客户端）。
这不是 Orca 新增的原生 API；是复用 1.4.219 只读 CLI 的独立 sidecar。
源码、离线测试与接入方式已提供；**没有自动部署服务、修改现有会话权限或完成离线自治验收**。

若用户明确选择不依赖宿主进程读取的方案，另见 [runtime 文件绑定](runtime-session-binding.md)。
该模式不读取 `/proc`，提供的只是运行时状态文件级归属证据，不能等同于本页签名/进程证明，
不自动回退、不解除本页采集器的失败锁定，也不放宽原有权限。

## 信任和执行边界

1. 宿主机操作者固定 runtime ID、实际 hostname、Agent UID、Orca CLI、可执行文件完整规范路径、
   JSONL 根目录、worktree ID，以及允许采集的 Run ID / preflight terminal handle。
   服务必须在真实执行主机运行；只支持 `executionHostId=local` 的 Codex CLI 根会话。
   SSH 投影、其他 provider、缺少 incarnation/host 字段、未知日志格式均拒绝，不猜测或自动切换实现。
2. 采集器使用**已经授权**的宿主机执行上下文。它不会提升权限、改 `/proc`、调整 ptrace/Yama、
   关闭沙箱、自动重试失败的原生命令或启动模型。宿主机自身也无读取权限时仍停止并记录错误。
3. Ed25519 私钥、采集器源码/配置/状态只能由受信操作者控制；Coordinator 只能访问 socket、
   只读的预置公钥和客户端源码，以及自己精确的可写台账/证据目录。
   **公钥不能从服务回执或可由 Agent 改写的绑定文件中临时采信。** 绑定文件和客户端执行入口也须保护。
4. 推荐使用具有所需原生 CLI 和 `/proc` 读取权限的独立受信服务身份。
   服务只会将自己新建的 socket 的所有权授予配置中的 Agent UID，并用 `SO_PEERCRED` 核对连接方；
   不会切换身份或自动授予宿主权限。服务身份必须事先有权创建该 socket/授予其所有权。
   socket 父目录及所有祖先须可遍历，父目录由服务身份所有且不可被其他身份写入；
   不要把 socket 放在不可遍历的私钥/状态目录里。
5. 若与 Agent 使用同 UID，`0600/0700` **不是**两者之间的安全边界。
   必须另有实测的沙箱读取拒绝来保护私钥，以及写入拒绝来保护服务源码、配置、状态和公钥。
   普通 `workspace-write` 一般仍可读取工作区外文件，不能单凭该模式宣称私钥隔离。
   缺少隔离时不得启用；`isolation_verified:true` 是操作者核验声明，不会创建或证明 OS 隔离。
6. 签名证明“受信采集器观察到的绑定/样本”，不是对恶意修改 provider 日志或受信宿主机失陷的防护，
   也不是最终账单、模型完全停止或整个 Agent 用量已经覆盖的证明。

## 请求和核验

客户端生成一次性 256-bit nonce，并发送精确 scope（runtime/Run/agent/terminal/worktree/host/provider）
和归属窗口。服务不接受文件路径、任意命令或原始 SQL。

- 原生 `status` 核对运行时与版本；`run-show` / `worker-show` 核对 Run、Dispatch、provider 和 terminal。
  `terminal show` 的 worktree、host、Agent、PTY 和 incarnation 必须完整匹配，采集前后各核验一次。
- 只检查配置 UID 的进程，执行文件必须精确在白名单内；仅提取 `ORCA_TERMINAL_HANDLE` 作匹配，
  不持久化或返回环境变量、命令行、对话正文、cwd、终端标题或 preview。
- 从匹配进程的**打开的 FD**读取 JSONL。用 boot ID + PID + `/proc/PID/stat` starttime 防 PID 重用；
  校验 UID、可执行文件、FD、文件 device/inode、首行 session metadata 摘要及会话 ID。
- 仅将明确 `session_meta.source="cli"` 的唯一根会话作为结果；明确 `subagent` 会话不混入根会话。
  多个根会话/进程、只有子会话、缺少/未知 source 均拒绝。子 Agent 用量仍须另行入账，不能当作 0。
- 已读前缀按字节数和 SHA256 固定。允许追加，不允许改写/缩短之前已观察的内容；
  采集期间再次核对前缀和进程/FD 绑定。`max_log_bytes` 缺省或为 `null` 时无固定大小上限，
  示例使用 `null`；显式正整数仍作为操作者的资源限制生效，不再有 256 MiB 实现上限。
  不自动截断历史，也不自动修改既有服务配置；配置变更仍须遵循原有核验/重启流程。
- runtime+terminal 的首次成功身份存入私有 SQLite；从 preflight 到 Run，以及服务重启后仍保留。
  incarnation、PID starttime、会话、inode 或历史前缀变化都不能静默重新绑定。
- 签名覆盖 nonce、scope、完整身份、前缀摘要、用量样本及时间。观察时刻从采集开始计，
  采集超 50 秒拒绝；回执最长 60 秒有效，客户端容许最多 5 秒时钟偏差。不接受旧 nonce 的回执。
- 同步采集是运行中快照，永远不能使用 `final:true`。未知仍为 null；单次样本完整不代表 Agent 完整。

当前对配置 UID 的进程发现采取保守策略：相关 `/proc` 读取权限拒绝或无法完成唯一性检查即拒绝采集，
不会跳过不可见候选然后宣称其余候选唯一。进程消失/不可读不等于原生退出。

## 配置与启动（操作者步骤，不是自动授权）

依赖 Python 3.10+、Linux `/proc` / Unix socket / `SO_PEERCRED`、OpenSSL 3 的 Ed25519，
以及版本匹配的 Orca 1.4.219 CLI。Python 本身无新增第三方包。
先按 `orca-cli` / `orchestration` 技能读取所选二进制的版本匹配指南并只读核验目标。

使用 [停用配置示例](examples/session-binding-host.example.json) 生成私有配置。
将示例的所有 `REPLACE`、UID、hostname、路径和 ID 替换为当前核验值；`isolation_verified` 默认 false，
完成上述隔离验收后才能改为 true。不要复用历史 PID/terminal，不能将服务私有目录加入 Agent 可写根。
Run 创建前可只登记已授权的 Coordinator terminal，`run_ids` 留空；新 Run 返回真实 ID 后，
由宿主操作者更新配置中的 `run_ids`。仅 `run_ids` 和 `preflight_terminals` 可以在服务运行时更新，
其他配置改变会拒绝请求，须按获批维护流程停止/重启服务。
这不是自动 Run 发现或自动授权新 Run；登记不启动 Run，也不替代 `max_workers`/预算授权。

私钥由宿主操作者生成并保存在上述隔离位置；将对应公钥和指纹通过可信部署渠道交给客户端。
以下仅展示操作形状，必须替换精确路径后在已授权上下文执行：

```text
/usr/bin/openssl genpkey -algorithm ED25519 -out PRIVATE_KEY
/usr/bin/openssl pkey -in PRIVATE_KEY -pubout -out PUBLIC_KEY
python3 -m swarm_ledger.binding_host serve --config PRIVATE_CONFIG
```

从包含 `swarm_ledger/` 的受信源码目录执行；服务不能继承 Agent 身份或覆盖 runtime 的路由变量。
该命令以前台形式持续接受按需检查点请求，可交给获批的宿主服务管理器管理；本次没有注册服务。
不要配置对安全退出的无限重启。正常停止会清理自己创建的 socket；非正常死亡残留的 socket
会阻止再次启动，操作者核对进程/服务已经结束并保全证据后，才可处理这个**精确端点**。
不得删除锁文件或数据库来“自愈”。

## Coordinator 接入

启动前，用当前 Coordinator 的真实沙箱执行：

```text
python3 -m swarm_ledger.binding_host preflight \
  --socket SOCKET --public-key PINNED_PUBLIC_KEY --runtime-id RUNTIME \
  --terminal-handle TERMINAL --worktree-id WORKTREE --host HOSTNAME
```

preflight 不创建 Run，返回签名的身份回执，不导入用量。保存其输出到本任务获准的证据目录。
客户端路径不读取 `/proc`；该模块中宿主逻辑只在 `serve` 分支调用。
实际沙箱必须能连接精确 socket、读取受信公钥/客户端源码并写入自己的证据目录。
这需要真实验收；离线 socket 测试不证明 Coordinator 沙箱已有这些权限。

Run 创建后，在现有 `sync --bindings` 中使用
[host-receipt 绑定示例](examples/ledger-host-binding.example.json)，不再交给 Coordinator 原始 JSONL 路径：

```text
python3 -m swarm_ledger --state LEDGER_STATE sync \
  --runtime-id RUNTIME --run RUN --cli VERIFIED_CLI \
  --bindings TRUSTED_BINDINGS --output EVIDENCE_OUTPUT
```

每个条目固定 `agent_id`、真实 host/worktree、公钥、socket 和归属 `since`；运行中可不写 `until`。
Worker 的 terminal 从当前原生台账读取，不按最新文件或 cwd 猜测。
操作者负责选择精确归属时间窗；签名不会把错误的归属窗口变成正确的业务计量。
旧的 `scan-codex` /显式 JSONL 绑定保留为操作者已独立核验身份后的导入方式，**不是失败自动回退**。

整批 sync 的原生快照、身份 pin、签名回执和用量一起提交，任一条失败整批回滚。
每个成功回执在宿主状态保存；客户端也保存收到的回执。
导出时每轮的 `host-bindings.json` 包含已接收的签名证据，key 为规范化回执 SHA256，
与台账 `host-binding:sha256:…` 来源对应；按既有归档规则校验并保存公钥指纹/只读公钥副本。
过期回执仍是历史证据，但不能作为新的实时 preflight 或重放导入依据。

## 错误、恢复和验收

权限拒绝记录 `binding_permission_denied`；未认证的错误回复只作诊断，不作身份/退出依据。
相关目标会持久锁定为 unverifiable，旧成功回执不会替代新请求，重启服务也不解除锁定。
保留旧账并报告采集缺口，不将缺失记为 0，不自动重派 Worker。

操作者可查看私有状态，命令不读取 `/proc` 或唤醒模型：

```text
python3 -m swarm_ledger.binding_host status --config PRIVATE_CONFIG
```

权限/配置问题由用户决定处理方式。问题解决并获准重试后，正常停止采集服务，再执行：

```text
python3 -m swarm_ledger.binding_host resume --config PRIVATE_CONFIG \
  --terminal-handle EXACT_TERMINAL --reason-code operator_verified_access
```

resume 要求服务锁空闲，记录原始失败和恢复 reason code，保留此前成功的全部身份/前缀 pin。
因此它不能绕过 incarnation/session 变化；真实会话替换须走原生安全交接和独立归属登记。
初次采集从未成功时，显式 resume 允许重新尝试初始核验。恢复不会自动启动服务或执行采集。

发布验收至少包含：宿主读取获准、私钥隔离、原生 scope 与实际 PID/session 一致、
真实 Coordinator 沙箱连接/验签成功、权限拒绝后无重试、检查点与结束前外部采集，
以及独立的 Mac 断开/宿主自治实测。服务存活或本地测试通过都不能替代这些证据。
本实现不自动采集已经退出进程的最终日志；释放前保全及最后回复后的外部用量结算仍需执行。
