# Swarm 启动与收尾保护

启动前核对实际审批策略与工作区调用要求是否兼容：`approval_policy=never` 与强制
逐次申请提权的要求冲突。默认在执行环境已有权限内调用；真实拒绝须停止并报告，
不能更换工具绕过。此说明不修改全局沙箱或授予提权权限。

`worker-start` 的传输层 `ok:true`、正确模型设置或 TUI 的 Full Access 标签均不能证明 Worker ready。


## 适用范围

- `supervisor/launch_guard.py` 是**离线兼容性检查**，不是运行时探测或权限授予。
  Supervisor 在新 Run 的任何原生调用前、派发 Worker 前和唤醒新 Coordinator 回合前使用它。
- 原生自适应编排不经过 Supervisor；操作者须在创建 Coordinator/Run/Worker **之前**显式使用以下检查。
  不能把本模块当作 Orca 1.4.219 内部实现已修复，也不能为取得预检证据先启动一个未授权 Worker。
- 本模块不实现原生 Worker preamble、heartbeat 或 nextCommands；真实链路仍须在获准环境验证。
- 不更改全局审批、不安装/覆盖技能、不通过 Python/其他工具包装 Orca 来绕过实际访问限制。
  只有目标角色另有明确、已核验的强制提权要求时，`never` 才与之冲突；本规则不新增此类授权。

## 启动前证据

初始 Coordinator 的模型、会话权限和规范路径通过[显式部署配置](configuration.md)准备；
Codex 与 Trae 使用各自适配器。公开默认配置不代表私有授权，也不改变 Worker 权限。

新配置的 `launch_contract` 默认 `null`，故即使填写了其他字段也不能直接启动。
操作者先核验当前运行时、Coordinator/Worker 启动器及工作区规则；不能将历史 Run 的策略或
本地合成测试值当成当前证据。`max_workers`、预算、时限、模型白名单和写入授权仍需分别确认。

证据格式为：

```json
{
  "schema_version": 2,
  "target_sha256": "<当前 runtime + agents 配置摘要>",
  "evidence_source": "<本轮核验记录路径及 SHA256，包含启动器版本和有效配置来源>",
  "roles": {
    "coordinator": {
      "approval_policy": "<实际有效策略，不能填 Full Access>",
      "sandbox_permissions": "use_default",
      "escalation_supported": false,
      "cli_entries": {
        "operator": "/absolute/approved/orca-server-cli",
        "heartbeat": "/absolute/approved/orca-server-cli",
        "recovery": "/absolute/approved/orca-server-cli"
      }
    }
  }
}
```

`roles` 必须覆盖配置中所有角色（包括 implementation/review/integration），上例故意不完整且不能通过。
各角色的 `sandbox_permissions` 省略时默认为 `use_default`，无需 `escalation_supported:true`，
也不要求工具提供升级参数。实际策略为 `never` 时可以通过；这不证明 CLI 在实际环境可访问。
允许识别 `never` / `on-request` / `on-failure` / `untrusted`，这里只保留兼容性识别，
不是要求启动器支持或配置所有这些值；未知策略和未知执行模式拒绝。
仅当目标角色另有明确且获准的强制提权要求时才填写 `sandbox_permissions:require_escalated`，
并须核验 `escalation_supported:true` 且策略不是 `never`；不自动将默认模式切换为提权模式。
所有 CLI 入口必须与 `runtime.cli` 的绝对路径逐字一致；裸 `orca`、`orca-ide` 或不同包装器均拒绝。
任务契约携带对应角色的固定 CLI、`required_sandbox_permissions` 与冲突即停的要求；
默认模式明确要求省略升级申请，不在权限拒绝后自动升级，不能借此覆盖更高优先级的执行策略。

从本子模块根目录执行以下**纯本地**命令：

```bash
python3 -c 'import json,sys; from supervisor.launch_guard import target; print(target(json.load(open(sys.argv[1]))))' CONFIG
python3 -m supervisor.safety preflight --config CONFIG
```

第一条只计算摘要，**不证明证据真实或未过期**；第二条也只验证所交付证据内部的一致性。
改变启动器、配置或运行环境后须重新核验，不复用旧证明。预检通过不是创建 Agent/Run 的授权。

`launch_contract` v1 表示旧的强制提权契约，不会静默改为默认执行；须重新核验后使用 v2。
这只升级 `launch_contract.schema_version`，不改变外层 Supervisor 配置的 `schema_version:1`。
已登记配置不可直接补字段或改状态库以绕过配置摘要保护。旧 Run 仍能原样 status、读取/结算、保全与回收；
缺少兼容证据会阻断新的派发和自动回合。需要恢复推进时按现有原生恢复规则人工处理，
不能通过换 Run 绕过累计费用/次数限制。新启动须另用获准、完整核验的新配置。

## 启动失败诊断

```bash
python3 -m supervisor.safety diagnose --receipt WORKER_START_JSON --evidence STDOUT_EVIDENCE_JSON
```

诊断校验 Run/Task/Dispatch 和 agent terminal 绑定，并将请求 call ID 与拒绝结果配对。
只有实际 `never` 上下文、显式提权请求与对应拒绝证据同时存在，才报告 `approval_policy_conflict`。
缺证据保持 `startup_not_ready`，不猜根因；矛盾证据不报告 ready。
命令退出码 0 表示诊断执行成功，**不是 Worker 启动成功**，应查看输出的 `ready` 与 `diagnosis`。
不输出工具正文，不执行 nextCommands，不自动重试/停止/释放。工具拒绝不证明进程已退出，
是否还需结算与回收必须以当前 Orca 原生状态为准。`native_state_recheck_required` 仅提示核对原生状态，
不表示历史 Run 尚未清理，更不要求重复结算已经释放的 Worker。

## 最终回执检查

操作者完成所有追加记账、观测和收尾回执后，再生成新的私有派生目录：

```bash
python3 -m supervisor.safety derive-receipts --source RESOLVED_ORIGINAL_RECEIPTS --destination NEW_ABSOLUTE_DIRECTORY
python3 -m supervisor.safety check-receipts --directory NEW_ABSOLUTE_DIRECTORY --sealed
```

- 输入目录必须是已解析的绝对路径；保留既有符号链接，不修改它们。
- 只处理 JSON 回执（也递归处理完整 JSON 字符串中的 preview），移除 preview/previewText/terminalPreview 值。
  非 JSON 文件不复制，作为 excluded 项保留原始哈希；它们仍需独立人工检查。
- 不覆写原件/已有目的目录，不跟随目录树中的符号链接；输出目录 0700、文件 0600。
  每项记录原始与派生 SHA256；源文件清单/内容在处理过程中改变则不写封存清单。
- `receipt-preview-manifest.json` 记录完整派生清单。最终 `--sealed` 回读会拒绝新增、删除、修改或再次引入 preview。
  若来源后来追加回执，须从最新完整来源**重新派生到另一个新目录**；不能只检查旧派生目录就宣称来源已无新增。
- 这是**terminal preview 专项脱敏**，不是通用密钥扫描、全 Run 归档器或公开发布许可。
  未覆盖任意自然语言/代码块中的敏感文本，不能将 `preview_check_passed` 等同于全量安全验收。
  原有封存 Run 保持只读；派生副本不替代原始证据或原生事实。

## 离线回归

```bash
python3 -m unittest discover -s tests -v
python3 -m compileall -q supervisor swarm_ledger tests
git diff --check
```

测试中的运行时与审批值均为合成数据，原生调用使用 FakeNative。
离线测试/旧日志回放不能代替真实 Worker ready → 工作 → worker_done → 原生结算/回收的验收。
