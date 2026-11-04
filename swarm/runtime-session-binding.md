# Codex / Trae runtime 文件绑定（不读取 `/proc`）

用户明确选择 runtime 文件作为会话映射来源时，使用 `swarm_ledger.runtime_binding`。
它从运行时已维护的状态文件获取映射，不扫描进程、环境变量或 FD，不要求 root、ptrace、
额外 capabilities、宿主采集服务或签名密钥。Codex 路径使用已有 runtime 字段；
Trae 路径还需要下述 Orca hook / Worker 查询接口补丁。

**它提供状态文件级归属证据，不提供进程级证明。** 不能拿它替代要求宿主签名回执的验收，
也不会在 `host-receipt` 失败后自动切换。两种模式须显式选择；旧宿主采集器的拒绝/锁定状态不受影响。

## 读取哪些文件

1. 当前显式 profile 的 `orca-runtime.json`：仅保留 `runtimeId`、`pid`、`startedAt`，
   与同一 CLI 的只读 `status` 返回核对。文件中的 `authToken`、传输地址等不进入证据。
2. `agent-hooks/last-status.json`：以 `terminal show` 当前返回的 `tabId:leafId` 精确查找，
   读取 `providerSession.id` / `transcriptPath`、worktree/tab、provider 和 hook 时间戳。
   不使用 cwd、终端标题、preview、最新文件名猜测会话。
3. 映射所指的 Codex JSONL：从首行核对 `session_meta.id` 及 `source="cli"`，
   读取一个固定字节前缀，在操作者指定的 `(since, until]` 内计算 token。
   不保存日志正文、prompt、环境变量或命令行；只保留身份、文件 inode、摘要、时间及用量。

当前版本限定 **Orca 1.4.219、同机 local runtime、同 UID、Codex TUI 根会话**，
或安装本次补丁后显式启用的 **Trae 0.209.1 / 0.210.1 TUI 根 Worker**（见下节）。
不支持 SSH 投影、`--environment`、structured host、子会话或其他 provider。
文件必须是规范绝对路径下的普通文件；拒绝符号链接及 `/proc`、`/sys`、`/dev` 路径。
两个 runtime 状态文件还要求 owner-private 权限（通常 0600）。
状态文件与 JSONL 不设置固定字节上限；读取初始 EOF 的完整前缀，不截断后宣称完整。
现有身份、前缀摘要、文件权限和采集时限检查保持不变；快照仍需要与输入大小对应的内存。

## Trae Worker 接入前提

参见 [Orca Trae hook 接入与验收说明（私有部署）](configuration.md)
和 [Trae runtime binding 示例](examples/ledger-trae-runtime-binding.example.json)。
该入口不是已部署的后台采集器，不能只改 `provider` 就认为原来的运行时已支持。

- 执行主机必须使用打过补丁的 Orca、Trae 0.209.1 或 0.210.1，并通过 Trae 原生插件/信任流程显式启用 hook。
  **Trae 必须使用独立 `--no-daemon` 模式**；共享 daemon、`--remote` 不在支持范围。
  当前 `launch.effective` 不含 argv，采集器不能自行证明此启动条件，操作者须先核验。
- `SessionStart` / `UserPromptSubmit` / `Stop` 经既有 Orca hook 通道维护规范 session 映射；
  子 Agent hook 被拒绝，不能覆盖根 Worker。不会写第二套状态文件，也不将 Trae 设为可恢复会话。
- sync 额外要求 `worker-show.providerSession` 精确匹配 pane、incarnation、session、transcript 和观察时间，
  且由原生 selector 核验 launch token；回执 `launchTokenHash` 必须与 runtime 文件中的 SHA256 摘要一致。
  只保存摘要、不保存或导出启动凭据明文；缺失/异常摘要、旧版本、replay 或已释放绑定均拒绝入账。
- 日志首行核对 `session_meta.id`（thread）和 `session_id`（session tree）、provider、producer、版本。
  hook 的 `session_id == session_meta.id` 目前为 schema 推导，尚待真实 hook 端到端验证。
- 同一份已捕获字节交给 Trae JSONL 适配器；metadata 前缀固定归属，全量已读前缀 pin 检测历史改写。
  按请求去重，日志追加更新同一小计。原始计数单列；标准化 tokens 仍未知，不自动折算账单。
- Trae sync 只支持真实 Worker Dispatch，不支持 Coordinator。无 Run 的 preflight 仅检查文件映射，
  不证明 Worker 归属、hook 已启用或 daemon 模式正确，不能替代上述 sync 校验。
- 必须在原生绑定释放前采集；当前 runtime-state 的窗口不得超过台账 Agent 结束时间。
  `worker_done` 后的最终回复用量可能不在该窗口内，须保全日志和直接归属证据供外部采集者单独结算；
  不推迟正常释放、不重启模型补账、不宣称已全覆盖。

## 必须知道的可信度边界

`last-status.json` 是持久化缓存。1.4.219 写盘时不保留 live observation/terminal incarnation；
非 done 的恢复记录在运行时可能处于 unconfirmed。因此，即使文件、当前 terminal 和日志首行一致，
也**不能证明该缓存仍对应当前实际进程**。本模式：

- 采集前后均核对 runtime、terminal handle/worktree/host/provider、PTY、incarnation 与会话映射。
  有 Run 时还重复核对 Run/Dispatch/terminal/provider 关系；前后变化则拒绝整批落账。
- 要求 hook 的 evidence 时间不早于当前 runtime 启动、未超过 `receivedAt`、未明显超前；
  `max_hook_age_seconds` 默认 86400（24 小时），可以调小，不能调大。这是缓存年龄限制，
  **不是 24 小时心跳、更不是进程存活证明**。空闲太久可能被拒绝；不自动唤醒模型刷新 hook。
- 将首次成功的 runtime+terminal 身份与日志前缀持久固定到专用私有台账目录。
  preflight、后续 sync、台账进程重启共用 pin；允许追加，拒绝换会话/换 incarnation、
  inode 替换、历史缩短/改写以及 hook 时间倒退。不通过删状态、新建台账来规避身份变化。
- 采集期间重新读取并核对前缀摘要，单次文件/terminal 采集超过 50 秒拒绝。
  原生只读查询不是跨文件原子快照，短暂变化后恢复也无法全部识别。
- 同 UID 的文件权限和 SHA256 **不防同 UID 恶意 Agent 篡改**。适用于受信运行时与受信日志，
  不是密码学签名、宿主进程 attestation 或账单审计边界。

证据固定标注 `trust: runtime-state-not-process-attested`。
导入样本总是 `complete:false`，带 `runtime_state_not_process_attested` 告警，禁止 `final:true`。
Codex 已知 token 可计入已知小计；Trae 仅进入独立 raw 小计，保留 `counter_semantics_unverified`。
完整总量保持未确认。未知不填 0，不根据缓存推断 Agent 退出或任务完成。

## 调用方式

先按 `orca-cli` / `orchestration` 技能核验所选 CLI 的版本匹配指南、当前 runtime 和目标 worktree，
重新 `terminal list` 得到当前 handle。不要从历史索引复用旧 handle。
绑定配置本身是操作者的输入，不是证明；程序每次都读取上述 runtime 文件及原生只读接口。

以 [preflight 示例](examples/runtime-binding.example.json) 创建本任务的受信私有配置，替换所有
`REPLACE` 字段。`profile`、`log_root`、台账/证据目录需使用真实规范路径（有 symlink 时先解析）。
hostname 是运行采集器的实际主机名，不是 Orca SSH host alias。
从含 `swarm_ledger/` 的源码目录执行：

```text
python3 -m swarm_ledger --state LEDGER_STATE runtime-preflight \
  --runtime-id RUNTIME --cli VERIFIED_CLI --binding PRIVATE_BINDING
```

preflight 不需要 Run，不启动模型，不导入 token，不改变任何原生状态。
它在专用台账目录保存身份 pin 和脱敏证据，并输出 `usage_imported:false`、`lifecycle_verified:false`。
保存输出作本次检查证据；该历史输出不能重放为下一次实时核验。

在已授权的现有 Run 检查点，以 [sync 示例](examples/ledger-runtime-binding.example.json) 接入：

```text
python3 -m swarm_ledger --state LEDGER_STATE sync \
  --runtime-id RUNTIME --run RUN --cli VERIFIED_CLI \
  --bindings TRUSTED_BINDINGS --output EVIDENCE_OUTPUT
```

继续使用 preflight 的同一个 `LEDGER_STATE`。`agent_id` 为 `coordinator` 或真实 Dispatch ID；
`terminal_handle` 须与原生 Run/Dispatch 当前关系一致。Worker 必须为 local、明确的 Codex 或 Trae provider。
`since` 由操作者确认业务归属，不早于 Run/Agent 开始；已结束 Agent 的 `until` 不得晚于其结束。
运行中可以省略 `until`，程序使用本次采集时刻；不应把会话全部历史累计算给本 Run。
独立会话/subagent、最后回复后的用量与无法映射的窗口仍需单独结算，不能声称自动全覆盖。

整批原生快照、身份 pin、脱敏证据与用量一起提交；任一绑定失败则整批回滚。
导出的每轮 `runtime-bindings.json` 包含 Run 级证据，其 key 为证据 SHA256，
对应 Codex 的 `runtime-state:sha256:…` 来源。Trae 样本保留 `trae-jsonl:sha256:…` 的字节摘要，
由回执中的 sample/source 与 raw binding 中的 `runtime-state-identity:sha256:…` 关联。
无 Run 的 preflight 证据不混入 Run 导出，
应另外保存 preflight 输出。归档后读回校验，禁止覆写已封存的历史证据。

## 出错和启用边界

遇到不可读文件、权限拒绝、身份冲突、陈旧记录或不支持的格式，立即停止本次采集，保留旧账与缺口。
CLI 没有自动重试、提权、其他工具回退、换 runtime 或改原生生命周期的逻辑。
本模式没有宿主服务的持久失败锁；调用者也不得配置自动重试权限错误。
先保存本次错误并查明原因，后续人工重试/真实会话替换应在用户授权范围内进行，保留原 pin 和证据。

Codex 路径此前提供源码、离线回归及当前执行环境只读 preflight；Trae 扩展目前仅为源码与离线回归，
尚未部署或完成真实 hook→Worker→台账验收。没有安装后台服务、更新运行中的 Coordinator
指令、改变已安装技能或修改原生 runtime 文件。真实 Coordinator 沙箱能否读取这些精确文件并写入台账，
仍需在获准的运行流程中实测；当前执行环境可读不等于所有 Agent 沙箱均可读。
不据此宣称远端常驻、Mac 离线自治或整个 Swarm 端到端验收通过。
