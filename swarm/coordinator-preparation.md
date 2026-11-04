# Coordinator 固定准备模板

`coordinator_launch.py` 的启动计划现在包含 `preparation`。它预生成当前规范目录、
固定准备命令和可直接交给 `functions.exec` 的 `functions_exec` 片段。
模型不必每轮重新编写探针代码、转义路径或组装证据结构。没有调整必读规则、模型、
权限、Worker 上限或 Worker 启动逻辑。v2 新增分层时效及显式准备尝试预算，见下文。
当前实现为 `codex-local`，不是所有 Agent 的通用启动器；Trae 选型不能直接调用它。

## 使用

1. 按原流程生成启动计划，并将计划和批准任务交给 Coordinator。原有 `prompt_fragment`
   也内嵌同一执行片段，沿用只交接 fragment 的调用方不会遗漏新入口。此操作仍是
   只读，不建目录、不启动进程、不创建 Run。操作者须交付以下同版文件：
   `coordinator_launch.py`、`coordinator_loop.py`、`coordinator_prepare.py`、`coordinator_prepare.js`，以及
   `native_preflight.py`、`evidence_policy.py`、`log_io.py` 和批准的配置。
   `log_io.py` 同样纳入探针 scope 的源码哈希，变更后不能复用旧 scope 的证据。
2. Coordinator 读取适用的必读规则后，按既有流程取得当前真实身份并填写原生
   preflight 契约。将它放在计划的 `preparation.contract_path`，默认是本 Run
   规范 `evidence/native-preflight-contract.json`。契约模板仍见
   [native-preflight.example.json](examples/native-preflight.example.json)；不猜 ID。
3. 所有计划目录必须已按授权存在，契约中的两个 evidence 输出必须使用尚不存在的
   文件名，其父目录必须是计划的一个精确目录。执行 `preparation.functions_exec`，
   不把展开后的生成器输出或 JS 代码重新打印给模型。此片段只能执行当前审核过的
   本地生成器返回的固定模板，不能用于外部数据或原生响应提供的任意代码。
4. 只在结果为 `ok:true / decision:run_native_preflight` 后，执行原有的 fresh
   `native-preflight`。模板成功不是派发许可；preflight、当前任务授权和生命周期
   约束全部保持。模板既不派发也不等待 Worker。

若不用启动计划提供的片段，也可检查只读生成入口：

```bash
python3 coordinator_launch.py prepare-tools \
  --model-config /absolute/private/approved-codex-model.json \
  --runtime-config /absolute/private/coordinator-runtime.json \
  --contract /absolute/run/evidence/native-preflight-contract.json \
  --cwd /absolute/coordinator-worktree \
  --archive-dir /absolute/run
```

额外精确目录使用 `--write-dir`；[配置选择](configuration.md)须与启动计划一致。它输出的是供执行器消费的
JSON 材料，不是“检查已通过”回执。不要单独生成一次又让片段重复生成一次。

## 固定顺序和证据

生成器只读核验 runtime/profile、明确 workspace、当前 Run 的原生调用者绑定、
terminal/incarnation、当前 hook 和精确会话日志设置。沿用原生 preflight 的适配器，
不读取 `/proc`，不扫描最新日志，不接受历史成功回执代替当前观察。

随后同一个 `functions.exec` 调用通过该 Coordinator 的真实工具依次执行：

1. 检查精确目录身份和目标文件不存在。
2. 一次 `apply_patch` 在所有目标目录创建带会话标识的微型探针。
3. 一次只读程序逐字节回读所有探针。
4. 一次 `apply_patch` 重命名全部探针并更新标记。
5. 再次回读新名字和内容，并核对旧名字不存在。
6. `apply_patch` 创建会话、文件工具和操作记录，回读并计算 SHA256。

Python 生成器和回读程序均不写文件；没有 Shell 代写探针路径。空的宿主
`apply_patch` 返回值不证明成功，后续逐字节回读仍是硬性条件。所有步骤在一个
固定执行流程中完成，不需要模型在每一步之间重新规划；内部工具调用仍保留。

模型只接收短结果：成功/停止、身份、目录数量、耗时、证据路径、SHA256。
完整已完成探针操作在 v1 保存为 `evidence/coordinator-preparation-operations.json`，
v2 则保存为含会话摘要和尝试编号的 `evidence/coordinator-preparation-<batch>-a<N>.json`；
其写入/最终回读由外层工具轨迹和短回执中的哈希证明。`generation_ms` 计入本轮
材料生成和会话核验，`tools_ms` 计入真实文件工具执行；规则读取和更早的启动准备
仍需通过端到端计时覆盖，不能只报告其中较短的一段。

## v2 分层证据与显式刷新

显式使用 schema v2，声明 `adapter:codex-local`、`freshness`、
`preparation.attempt/max_attempts` 和 `probe_roots`。详见
[预检契约](native-preflight.md#layered-evidence-policy-schema-v2)。
当前 model/runtime 配置必须列入 `config_files`，所有配置、规则和适配器保持同版。
探针名称含会话摘要及尝试号；同一尝试重复执行仍碰撞停止，不随机换名。

示例策略为会话观察 300 秒、文件探针无单独 TTL（必须每次重验身份与内容），
准备最多三次。它不是把 900 改成更大的统一常量，也不跳过当前原生状态检查。
完成新一批真实探针后，其文件和回执保留原位作为可重验材料。

若仅会话证据过期、原生身份和配置未变且没有未解决的拒绝/失败：

1. 保留第一份契约、探针、回执及操作记录；准备新契约，将 `attempt` 加一，
   保持原 `max_attempts`，两个 evidence 输出使用新的明确文件名。
2. 显式指向上一成功尝试的文件工具回执：

   ```text
   python3 coordinator_launch.py prepare-tools \
     --contract /absolute/run/evidence/native-preflight-contract-a2.json \
     --cwd /absolute/worktree --archive-dir /absolute/run \
     --model-config /absolute/approved/codex-model.json \
     --runtime-config /absolute/approved/codex-runtime.json \
     --reuse-file-tool /absolute/run/evidence/file-tool-a1.json
   ```

3. 生成器重新核验当前原生会话及旧探针；执行器再次回读原探针，只写新的会话、
   文件工具及操作回执。新回执保留原 `completed_at` 和原操作记录路径，另记
   `revalidated_at`、上一回执路径及 SHA256。它不声称又完成了探针写/重命名。
4. 执行完整 native preflight，通过后及时交接。缺少真正新 hook 观察时停止；
   不用读取旧文件、重写时间戳、调用模型或创建线程刷新“新鲜度”。

复用链要求相邻尝试、上限不变。也允许在已授权且已解决变化原因后显式准备新探针
批次（不传 reuse），旧批次仍保留。尝试上限是输入校验和命名约束，不是跨契约
持久计数器；操作者须在同一 Run 台账核对累计次数，不改编号/上限/Run 绕过。
仅生成后未调用任何工具的过期模板，可重新只读生成；部分失败现场不得直接重试。

Python 仍只读，JS 仍通过当前会话真实工具写回执。复用依据不证明新写权限，
不能检测所有 ACL/挂载/执行器变化，已知变化必须重新实测。全流程仍需单写入者。
schema v1 保持原 TTL 与命名；缺少 v2 证明的旧回执不能直接复用。

## 失败边界

- 模板不缓存实时状态，不降级模型，不改权限，不启动 Run/Worker。
- 目录必须是规范路径；额外目录去重；检查目录 inode/device、链接变化和精确回读。
  inode/device 以字符串传递，避免 NFS 大整数经过 JavaScript JSON 时丢失精度。
- v1 同一会话、v2 同一会话及尝试编号的探针名称固定。已有输出、部分遗留或过期会话导致停止；不自动换名、
  重试、删除或覆盖。它不是并发锁，仍须遵守单写入者所有权。
- 任一工具拒绝、未知失败、内容不符、重命名失败或证据过期都停止，不再生成通过
  回执。失败时原始工具轨迹是证据，不能假定 operations 文件已经成功写入。
- 输出材料、完整操作回执、输入和原生查询不再设置固定字节/字符上限；仍沿用
  preflight 的时限、路径、身份与完整性检查。路径/工具表面检查不是抵御恶意同 UID 并发写入的安全隔离。
- 只适配这里的 Linux 本地 Codex + `functions.exec`/`apply_patch`/`exec_command`
  工具表面。工具缺失或拒绝时停止，不换工具模拟通过。

## 验证

```bash
python3 -m unittest discover -s tests -p 'test_coordinator*.py' -v
python3 -m unittest discover -s tests -p test_native_preflight.py -v
```

测试覆盖真实临时文件的读写/重命名、离线 native fixture、旧身份/过期/权限拒绝、
链接/目录变化、无写入假回执和分段工具输出。`tests/fixtures/prepare-local-tool-smoke.py`
仅供独立空测试目录中的真实文件工具检查，它使用假的原生身份并明确标记为
`offline-native-fixture-real-file-tools`，不是真实 Coordinator 启动验收。
端到端首次派发改善仍需后续获准的同模型真实 Run 对照。
