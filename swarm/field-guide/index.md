# Swarm field guide

这是项目知识入口模板，不是已经验证的试点项目知识。部署后须替换为远端可读路径，并在每个 Task 的 references 中明确提供；禁止依赖 Mac 文件。

## 已验证的控制器命令

从 swarm 源码根运行 `tests/run_offline.sh`（等价于 `env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT
PYTHONPATH=.:tests python3 -m unittest discover -s tests -v`）。
默认用 `tests/run_blast.sh --range <rev>` 只跑 diff 影响到的模块（状态词 `TARGETED OK`）；
跨模块改动或发布前跑全量 `tests/run_offline.sh`，迭代时可用 `--fast`。
`--fast` 与定向跑都不是离线 PASS，只有跑完全部模块才能那样上报。
Python 3.10+，标准库，无联网测试，无真实 Agent 启动。
**必须清除 `SWARM_WORKER_PROFILES`。** 调用方如导出私有 Worker 策略，请求中的固定 pin 与
实际读取的文件不一致，同一命令会分别得到 `FAILED` 与 `OK`（拒绝码
`worker_profiles_pin_source_mismatch`）；`RSI_CHECKER_TEST_ROOT` 则决定 18 项 RSI 用例是
skip 还是执行。两者都不是被测逻辑的缺陷。
控制器运行方式见 ../README.md；原生技能以所选 CLI 当前指南为准。

## 试点构建与验收（待批准）

- 仓库完整 ID / 基线 SHA：待填。
- 模块 A/B 的 build、test 命令和前置条件：待核验。
- 独立 Review 的只读 diff 和测试材料化方法：待核验。
- 串行集成顺序、合并后完整验收命令：待核验。
- 源码/状态/脱敏产物/临时测试输出的远端位置：待确认。
- 共享接口及唯一决策负责人：待确认。

## 已知限制

- ready 是启动状态，不是任务验收；Task completed 也不等于业务通过。
- 实施、审查和集成是三个独立责任；不凭作者报告直接合并。
- timeout、静默、unverifiable 都不能证明死亡，不重新派发。
- 释放前保存 commit/patch、全部测试证据和 SHA256；报告不能只在终端上下文中。
- whole Delivery 都要处理，ack 可以返回下一批，不能丢弃。
- API 回执丢失不自动重放；不复制身份、不删除状态库、不推主分支。
- 预算为预留准入，不是供应商硬上限。未知账单不填零。
- Mac 离线自治、24小时驻留、Server/宿主故障恢复尚未实测。

## 知识变更

Worker 仅提交建议，含实际证据、适用基线、失败尝试与替代路径。
由独立审查/集成责任人统一合入；未把本文件列为 allowed_paths 的任务不得写入。
不得保存 API key、token、配对码、完整会话或敏感数据。
