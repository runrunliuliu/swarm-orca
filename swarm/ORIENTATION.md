# ORIENTATION（生成文件，不要手改）

由 `swarm/generate_orientation.py --write` 生成；`--check` 与代码不一致即 `exit 2`。
只放**位置**（路径 + 行区间），不放代码：代码只有一份，索引可以验证。

## 最短必读顺序

1. 本文件「目录布局」与「入口 argv」——先知道文件在哪、这一步跑什么。
2. `docs/design/start-grant.md`：现行启动凭据设计；实现状态只见该文 §4。
3. 旧握手的阶段/槽位正文已移出本仓：`strict-bootstrap-protocol.md` 与 `coordinator-strict-start.md` 只保留归档提示，`operator-runbook.md` 已删除，不再是必读入口。
4. 需要看实现时，用下面「符号索引」里的行区间直接读，**不要先 grep 名字**。

## 目录布局（文件在哪）

本目录是产物的 `code/`，也是源码仓库的 `swarm-orca/swarm/`：同一份文件、同一套相对路径，
两处都成立。下面的路径都相对本目录，**不要到主机别处或全盘 `find` 里找**。

| 要查什么 | 位置 |
| --- | --- |
| 入口选择、测试与验收、设计、度量 | `docs/`（`entry-paths.md`、`testing/`、`design/`、`measurement/`） |
| 协议与历史入口 | 现行启动授权是 `docs/design/start-grant.md`；本目录顶层的 `strict-bootstrap-protocol.md`、`coordinator-strict-start.md` 只保留归档提示，`operator-runbook.md` 已删除 |
| 启动器与工具 | 本目录顶层 `*.py`（平铺同级，按裸模块名 import） |
| 运行时输入（模型、runtime、白名单） | 同级的 `*.json`（`worker-model-profiles.json`、`coordinator-model.json`） |
| 角色技能 | 项目技能在 `skills/`（`swarm-orchestration`、`software-development`、`worktree-delivery`）；`orca-cli`、`orchestration` 由所选 `orca` 可执行文件通过 `orca skills get ...` 提供，本仓不复制正文 |
| 安装、发布、下位服务 | `deploy/`（`install.sh`、`publish_control_plane.py`）；`supervisor/`、`swarm_ledger/`、`release_radar/`、`field-guide/` |
| 符号在哪一行 | 本文件「符号索引」 |

不在本目录的：上游 `orca/` 快照、`tests/`（只在源码检出里，产物不带）、私有政策 `swarm/`
（产物里是同级 `../private/`）。产物根还有 `../overlay/`、`../workspace/`、`../MANIFEST.sha256`、
`../.swarm-build.json`，由部署方读取。

## 入口 argv

```bash
python3 -B <swarm>/coordinator_launch.py start-grant-mint --record-file <path> --from <handle> --json
python3 -B <swarm>/coordinator_launch.py start-grant-state --grant <grant_id> --json
```

## 符号索引（47 个：协议文档点名的顶层定义与方法）

| 符号 | 位置 | 锚点 |
| --- | --- | --- |
| `_baseline_check` | `native_preflight.py:436-482` | `def _baseline_check` / `class _baseline_check` |
| `acceptance` | `startup_runtime.py:85-99` | `def acceptance` / `class acceptance` |
| `archive` | `evidence_archive.py:40-134` | `def archive` / `class archive` |
| `build_plan` | `coordinator_launch.py:88-210` | `def build_plan` / `class build_plan` |
| `build_plan` | `coordinator_worker_plan.py:94-200` | `def build_plan` / `class build_plan` |
| `build_trae_plan` | `trae_coordinator.py:114-236` | `def build_trae_plan` / `class build_trae_plan` |
| `canonical` | `coordinator_io.py:28-30` | `def canonical` / `class canonical` |
| `canonical` | `coordinator_loop.py:269-272` | `def canonical` / `class canonical` |
| `check` | `blocking_io.py:60-63` | `def check` / `class check` |
| `check` | `bootstrap_identity.py:265-271` | `def check` / `class check` |
| `check` | `coordinator_tui_continue.py:746-748` | `def check` / `class check` |
| `check` | `observation_budget.py:60-63` | `def check` / `class check` |
| `check` | `operator_authority.py:106-165` | `def check` / `class check` |
| `check` | `operator_readiness.py:70-119` | `def check` / `class check` |
| `check` | `software_development.py:249-447` | `def check` / `class check` |
| `checkpoint` | `operator_monitor_upgrade.py:215-269` | `def checkpoint` / `class checkpoint` |
| `cli` | `operator_monitor_cross_runtime.py:152-161` | `def cli` / `class cli` |
| `cli` | `operator_monitor_recovery.py:397-406` | `def cli` / `class cli` |
| `cli` | `operator_planned_restart.py:77-83` | `def cli` / `class cli` |
| `completed` | `coordinator_tui_scheduler.py:39-65` | `def completed` / `class completed` |
| `continuation` | `operator_readiness.py:37-67` | `def continuation` / `class continuation` |
| `coordinator` | `progress_watch.py:367-370` | `def coordinator` / `class coordinator` |
| `digest` | `coordinator_input.py:13-14` | `def digest` / `class digest` |
| `digest` | `coordinator_io.py:33-34` | `def digest` / `class digest` |
| `digest` | `progress_watch.py:89-90` | `def digest` / `class digest` |
| `exact` | `coordinator_worker_plan.py:27-31` | `def exact` / `class exact` |
| `execute` | `coordinator_driver.py:777-791` | `def execute` / `class execute` |
| `fingerprint` | `wait_for_file.py:55-66` | `def fingerprint` / `class fingerprint` |
| `identity` | `coordinator_startup.py:55-70` | `def identity` / `class identity` |
| `invocation` | `coordinator_prepare.py:26-48` | `def invocation` / `class invocation` |
| `log` | `publication_wait.py:139-149` | `def log` / `class log` |
| `mint` | `start_grant.py:152-168` | `def mint` / `class mint` |
| `native` | `operator_monitor.py:107-128` | `def native` / `class native` |
| `native` | `trae_coordinator.py:349-361` | `def native` / `class native` |
| `native_plan` | `coordinator_strict.py:320-386` | `def native_plan` / `class native_plan` |
| `observe` | `coordinator_background.py:42-95` | `def observe` / `class observe` |
| `observe` | `coordinator_handoff.py:117-150` | `def observe` / `class observe` |
| `observe` | `operator_session.py:237-300` | `def observe` / `class observe` |
| `observe` | `pi_tui.py:173-180` | `def observe` / `class observe` |
| `observe` | `trae_coordinator.py:364-453` | `def observe` / `class observe` |
| `observe` | `trae_tui.py:184-193` | `def observe` / `class observe` |
| `original` | `operator_continuity_deployment.py:15-23` | `def original` / `class original` |
| `original` | `operator_sender_correct.py:21-37` | `def original` / `class original` |
| `path` | `coordinator_io.py:51-56` | `def path` / `class path` |
| `policy` | `startup_execution.py:39-56` | `def policy` / `class policy` |
| `policy` | `tui_adapter.py:60-76` | `def policy` / `class policy` |
| `prepare` | `coordinator_handoff.py:63-84` | `def prepare` / `class prepare` |
| `prepare` | `coordinator_tui_prepare.py:71-177` | `def prepare` / `class prepare` |
| `prepare` | `operator_archive.py:21-93` | `def prepare` / `class prepare` |
| `prepare` | `operator_monitor_cross_runtime.py:31-35` | `def prepare` / `class prepare` |
| `prepare` | `operator_monitor_deploy.py:39-91` | `def prepare` / `class prepare` |
| `prepare` | `operator_monitor_recovery.py:99-138` | `def prepare` / `class prepare` |
| `prepare` | `operator_monitor_upgrade.py:272-297` | `def prepare` / `class prepare` |
| `prepare` | `operator_prepare.py:135-211` | `def prepare` / `class prepare` |
| `prepare` | `operator_sender_correct.py:81-128` | `def prepare` / `class prepare` |
| `prompt` | `coordinator_driver.py:441-532` | `def prompt` / `class prompt` |
| `provider` | `tui_adapter.py:35-37` | `def provider` / `class provider` |
| `receipt` | `operator_monitor.py:223-231` | `def receipt` / `class receipt` |
| `reconcile` | `operator_authority.py:168-180` | `def reconcile` / `class reconcile` |
| `report` | `control_plane_readiness.py:323-360` | `def report` / `class report` |
| `resolve` | `coordinator_worker_profiles.py:77-136` | `def resolve` / `class resolve` |
| `resolve` | `startup_cli.py:43-57` | `def resolve` / `class resolve` |
| `reviewed` | `coordinator_worker_profiles.py:54-64` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_authority.py:35-81` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_materials.py:182-214` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_monitor_upgrade.py:96-105` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_prepare.py:62-132` | `def reviewed` / `class reviewed` |
| `run_preflight` | `native_preflight.py:566-766` | `def run_preflight` / `class run_preflight` |
| `runtime` | `operator_continuity_route.py:77-84` | `def runtime` / `class runtime` |
| `scope` | `observation_budget.py:123-136` | `def scope` / `class scope` |
| `scope` | `operator_continuity_route.py:57-74` | `def scope` / `class scope` |
| `scope` | `startup_cli.py:20-31` | `def scope` / `class scope` |
| `session_id` | `pi_transcript.py:31-34` | `def session_id` / `class session_id` |
| `sha256` | `control_plane_readiness.py:168-174` | `def sha256` / `class sha256` |
| `snapshot` | `blocking_io.py:52-57` | `def snapshot` / `class snapshot` |
| `snapshot` | `operator_monitor_recovery.py:42-96` | `def snapshot` / `class snapshot` |
| `snapshot` | `software_development.py:225-246` | `def snapshot` / `class snapshot` |
| `source` | `coordinator_worker_profiles.py:49-51` | `def source` / `class source` |
| `sources` | `operator_monitor_deploy.py:26-28` | `def sources` / `class sources` |
| `state` | `start_grant.py:188-217` | `def state` / `class state` |
| `status` | `coordinator_tui_scheduler.py:33-36` | `def status` / `class status` |
| `status` | `trae_exec_capture.py:225-235` | `def status` / `class status` |
| `strict_plan` | `coordinator_strict.py:193-293` | `def strict_plan` / `class strict_plan` |
| `text` | `coordinator_worker_plan.py:21-24` | `def text` / `class text` |
| `text` | `pi_policy.py:25-27` | `def text` / `class text` |
| `text` | `software_development.py:35-36` | `def text` / `class text` |
| `verify_prepared` | `operator_prepare.py:247-291` | `def verify_prepared` / `class verify_prepared` |

## 不要这样做

- 先 grep 名字再逐回合找：本表就是那次搜索的结果。
- 复制本表的行区间到别处：`--check` 会因区间漂移拒绝，说明代码变了，重读对应区间。
