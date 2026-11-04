# 部署配置与公开代码的边界

本目录是通用代码、离线测试与协议的维护入口。相邻 JSON 是公开示例/测试基线，
不是任何部署的有效授权、模型白名单或已核验 runtime。公开代码不向父目录搜索私有配置。

## 显式读取部署配置

| 输入 | 读取方式 | 边界 |
| --- | --- | --- |
| Coordinator 模型 | `coordinator_launch.py --model-config /canonical/private/coordinator-model.json` | 启动操作者审核；不改变 Worker |
| Codex 权限 | `--runtime-config /canonical/private/coordinator-runtime.json` | 仅适用 Codex；必须与模型适配器匹配 |
| Trae exec / TUI 权限 | `--trae-runtime-config /canonical/private/approved-trae-runtime.json` | exec 与 TUI 使用各自 schema，不能互套 |
| Worker 固定参数 | 调用进程环境 `SWARM_WORKER_PROFILES=/canonical/private/worker-model-profiles.json` | Operator 选择路径，请求只传已审核的 `profiles_sha256` |
| Orca CLI | 各入口显式 `--cli` / 固定契约中的 CLI；driver/progress 使用 `ORCA_SERVER_CLI` | 核验 runtime 和真实身份，不自动发现或回退 |
| Supervisor / monitor / continuation | 对应入口的显式配置及协议规定的 pin | 不自动读取上述 Coordinator 配置或切换旧 Run |

`prepare-tools` 也须传相同的模型/runtime 参数；Operator materials 中的 `launch`
对象必须写入相同的显式配置路径。不传参数时仍按入口现有规则读取相邻文件，不能据此
认定加载了私有偏好。配置路径应先在实际执行主机解析为规范绝对路径，并审查实际文件。

### Worker 私有白名单

```bash
SWARM_WORKER_PROFILES=/canonical/private/worker-model-profiles.json \
  python3 -B /canonical/code/swarm/coordinator_launch.py worker-plan \
  --request /canonical/private/worker-request.json --request-sha256 REVIEWED_SHA256
```

这是只读计划。Worker 请求不能提供配置路径、环境变量或自由组合参数。环境变量是
受信任 Operator 的部署设置，不是 Worker/请求的权限入口；路径与原始字节 SHA 应一同
固定到交接。显式空值、不存在、相对/符号链接路径、hash 不符或不可用模型均拒绝，
不回退公开配置。仅在变量未设置时使用相邻 `worker-model-profiles.json`。

所有调用 Worker planner、first-dispatch、首派接受回执核验及生命周期链的进程，
必须使用同一已审查的路径/hash；首派会重新加载并比对 pin 和解析结果。
生成的 argv 不自动携带该环境设置，父 shell 的设置也不会自动传到远端或新 Agent。
启动操作者须在目标执行上下文明确交付并核验，不能仅在自己的终端 export 后假定完成。
无效配置应修正交接，不得换 hash/路径绕过历史 intent 或重试未知派发。

## 部署政策与历史材料

部署方单独维护授权、模型政策、目标仓库角色技能、runtime/工作区索引、台账、归档目录
及历史报告。经授权交付精确路径和内容 pins，由实际角色读取；不复制到公开代码目录。
目标 worktree 的 `AGENTS.md` 和角色技能仍须按角色读取，辅助脚本不是业务角色技能。

新代码不隐式读入历史报告或从历史成功推导当前状态。恢复已有 Run 时沿用其固定版本、
配置、源码/协议 pins 和生命周期证据；升级必须显式审查，不覆盖旧回执或自动热切换。
账本工具见 `swarm_ledger/`，以该目录上级为工作目录运行 `python3 -m swarm_ledger`，
通过命令的显式参数读取私有账本输入。未知用量不记为 0；失败尝试也记录，最终交付
统计覆盖/缺口、轨迹和归档回读证据。代码维护、配置选择不授权部署或启动 Agent。

## 离线测试

从公开仓库的 `swarm/` 目录执行：

```bash
env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
  PYTHONPATH=.:tests python3 -B -m unittest discover -s tests -q
```

不要把私有旧代码目录加入 `PYTHONPATH`。测试边界见[测试指南](docs/testing/reliability.md)；
离线 PASS 不替代目标文件系统、原生 runtime 或真实 Agent 验收。
