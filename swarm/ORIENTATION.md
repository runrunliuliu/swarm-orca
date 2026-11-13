# ORIENTATION（生成文件，不要手改）

由 `swarm/generate_orientation.py --write` 生成；`--check` 与代码不一致即 `exit 2`。
只放**位置**（路径 + 行区间），不放代码：代码只有一份，索引可以验证。

## 最短必读顺序

1. 本文件「入口 argv」——先知道这一步跑什么。
2. `docs/design/start-grant.md`：现行启动凭据设计（旧的 `strict-bootstrap-protocol.md` 已弃用，仍可读作历史）。
3. `operator-runbook.md`：旧握手的阶段/槽位，**已冻结**，只用于读历史 attempt。
4. 需要看实现时，用下面「符号索引」里的行区间直接读，**不要先 grep 名字**。

## 入口 argv

```bash
python3 -B <swarm>/coordinator_launch.py strict-bootstrap-state --bootstrap <BOOTSTRAP> --expect-attempt <attempt-id> --attempt-binding-sha256 <64 hex> --check
python3 -B <swarm>/coordinator_launch.py start-grant-state --grant <grant_id> --json
```

## 符号索引（99 个：协议文档点名的顶层定义与方法）

| 符号 | 位置 | 锚点 |
| --- | --- | --- |
| `CommitAuthority` | `bootstrap_protocol.py:121-140` | `def CommitAuthority` / `class CommitAuthority` |
| `Confirmation` | `bootstrap_protocol.py:78-84` | `def Confirmation` / `class Confirmation` |
| `ControlBinding` | `bootstrap_protocol.py:58-64` | `def ControlBinding` / `class ControlBinding` |
| `OperatorDelivery` | `bootstrap_protocol.py:99-105` | `def OperatorDelivery` / `class OperatorDelivery` |
| `OperatorScheduler` | `bootstrap_protocol.py:108-118` | `def OperatorScheduler` / `class OperatorScheduler` |
| `RequestAdmission` | `bootstrap_protocol.py:87-96` | `def RequestAdmission` / `class RequestAdmission` |
| `_baseline_check` | `native_preflight.py:436-482` | `def _baseline_check` / `class _baseline_check` |
| `acceptance` | `startup_runtime.py:92-106` | `def acceptance` / `class acceptance` |
| `admission` | `coordinator_operator.py:116-143` | `def admission` / `class admission` |
| `archive` | `evidence_archive.py:40-134` | `def archive` / `class archive` |
| `binding` | `bootstrap_events.py:177-232` | `def binding` / `class binding` |
| `build_plan` | `coordinator_launch.py:88-210` | `def build_plan` / `class build_plan` |
| `build_plan` | `coordinator_worker_plan.py:94-200` | `def build_plan` / `class build_plan` |
| `build_session_contract` | `coordinator_startup.py:35-39` | `def build_session_contract` / `class build_session_contract` |
| `build_trae_plan` | `trae_coordinator.py:114-236` | `def build_trae_plan` / `class build_trae_plan` |
| `caller_result` | `coordinator_strict.py:74-92` | `def caller_result` / `class caller_result` |
| `canonical` | `coordinator_io.py:28-30` | `def canonical` / `class canonical` |
| `canonical` | `coordinator_loop.py:284-287` | `def canonical` / `class canonical` |
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
| `commit_new` | `bootstrap_protocol.py:133-135` | `def commit_new` / `class commit_new` |
| `completed` | `coordinator_tui_scheduler.py:39-65` | `def completed` / `class completed` |
| `continuation` | `operator_readiness.py:37-67` | `def continuation` / `class continuation` |
| `contract_fields` | `bootstrap_events.py:235-244` | `def contract_fields` / `class contract_fields` |
| `coordinator` | `progress_watch.py:367-370` | `def coordinator` / `class coordinator` |
| `created` | `operator_startup.py:178-219` | `def created` / `class created` |
| `current` | `coordinator_operator.py:101-113` | `def current` / `class current` |
| `current` | `operator_monitor_upgrade.py:41-65` | `def current` / `class current` |
| `digest` | `coordinator_input.py:13-14` | `def digest` / `class digest` |
| `digest` | `coordinator_io.py:33-34` | `def digest` / `class digest` |
| `digest` | `progress_watch.py:89-90` | `def digest` / `class digest` |
| `dispatch` | `coordinator_first_dispatch.py:351-359` | `def dispatch` / `class dispatch` |
| `events` | `coordinator_background.py:157-158` | `def events` / `class events` |
| `exact` | `coordinator_worker_plan.py:27-31` | `def exact` / `class exact` |
| `exclusive` | `trae_exec_capture.py:27-28` | `def exclusive` / `class exclusive` |
| `execute` | `coordinator_driver.py:777-791` | `def execute` / `class execute` |
| `fence` | `coordinator_tui_continue.py:719-721` | `def fence` / `class fence` |
| `fence` | `operator_monitor.py:136-150` | `def fence` / `class fence` |
| `file_ref` | `coordinator_io.py:233-234` | `def file_ref` / `class file_ref` |
| `fingerprint` | `wait_for_file.py:55-66` | `def fingerprint` / `class fingerprint` |
| `freshness` | `coordinator_tui_continue.py:40-64` | `def freshness` / `class freshness` |
| `identity` | `coordinator_startup.py:55-70` | `def identity` / `class identity` |
| `idle` | `publication_wait.py:118-127` | `def idle` / `class idle` |
| `invocation` | `coordinator_prepare.py:26-48` | `def invocation` / `class invocation` |
| `layout` | `bootstrap_protocol.py:32-33` | `def layout` / `class layout` |
| `live` | `operator_sender_correct.py:40-55` | `def live` / `class live` |
| `log` | `publication_wait.py:139-149` | `def log` / `class log` |
| `mint` | `start_grant.py:152-168` | `def mint` / `class mint` |
| `mutation` | `coordinator_tui_workflow.py:44-64` | `def mutation` / `class mutation` |
| `native` | `operator_monitor.py:107-128` | `def native` / `class native` |
| `native` | `trae_coordinator.py:349-361` | `def native` / `class native` |
| `native_plan` | `coordinator_strict.py:367-433` | `def native_plan` / `class native_plan` |
| `observe` | `coordinator_background.py:42-95` | `def observe` / `class observe` |
| `observe` | `coordinator_handoff.py:117-150` | `def observe` / `class observe` |
| `observe` | `operator_session.py:237-300` | `def observe` / `class observe` |
| `observe` | `pi_tui.py:173-180` | `def observe` / `class observe` |
| `observe` | `trae_coordinator.py:364-453` | `def observe` / `class observe` |
| `observe` | `trae_tui.py:184-193` | `def observe` / `class observe` |
| `observe_identity` | `operator_session.py:66-95` | `def observe_identity` / `class observe_identity` |
| `observe_write_roots` | `coordinator_write_roots.py:15-28` | `def observe_write_roots` / `class observe_write_roots` |
| `observed` | `blocking_io.py:94-101` | `def observed` / `class observed` |
| `observed` | `observation_budget.py:113-120` | `def observed` / `class observed` |
| `observed_coordinator` | `bootstrap_events.py:67-105` | `def observed_coordinator` / `class observed_coordinator` |
| `original` | `operator_continuity_deployment.py:15-23` | `def original` / `class original` |
| `original` | `operator_sender_correct.py:21-37` | `def original` / `class original` |
| `path` | `coordinator_io.py:51-56` | `def path` / `class path` |
| `peer` | `bootstrap_identity.py:99-104` | `def peer` / `class peer` |
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
| `process` | `bootstrap_identity.py:62-74` | `def process` / `class process` |
| `prompt` | `coordinator_driver.py:441-532` | `def prompt` / `class prompt` |
| `provider` | `tui_adapter.py:35-37` | `def provider` / `class provider` |
| `publish` | `coordinator_background.py:106-127` | `def publish` / `class publish` |
| `publish` | `coordinator_snapshots.py:17-28` | `def publish` / `class publish` |
| `publish_new` | `coordinator_io.py:264-276` | `def publish_new` / `class publish_new` |
| `query` | `bootstrap_protocol.py:118-118` | `def query` / `class query` |
| `query` | `bootstrap_protocol.py:131-131` | `def query` / `class query` |
| `query` | `progress_watch.py:109-151` | `def query` / `class query` |
| `read` | `bootstrap_events.py:146-153` | `def read` / `class read` |
| `read` | `pi_policy.py:61-68` | `def read` / `class read` |
| `read` | `pi_transcript.py:37-80` | `def read` / `class read` |
| `read` | `trae_tui.py:31-32` | `def read` / `class read` |
| `reader` | `tui_adapter.py:49-57` | `def reader` / `class reader` |
| `receipt` | `operator_monitor.py:223-231` | `def receipt` / `class receipt` |
| `recheck` | `bootstrap_events.py:155-157` | `def recheck` / `class recheck` |
| `recheck` | `coordinator_snapshots.py:31-34` | `def recheck` / `class recheck` |
| `reconcile` | `bootstrap_protocol.py:139-140` | `def reconcile` / `class reconcile` |
| `reconcile` | `operator_authority.py:168-180` | `def reconcile` / `class reconcile` |
| `report` | `control_plane_readiness.py:323-360` | `def report` / `class report` |
| `require_operator_context` | `coordinator_startup.py:158-162` | `def require_operator_context` / `class require_operator_context` |
| `resolve` | `coordinator_worker_profiles.py:77-136` | `def resolve` / `class resolve` |
| `resolve` | `startup_cli.py:43-57` | `def resolve` / `class resolve` |
| `review` | `bootstrap_events.py:247-279` | `def review` / `class review` |
| `review_route` | `bootstrap_protocol.py:143-172` | `def review_route` / `class review_route` |
| `reviewed` | `coordinator_worker_profiles.py:54-64` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_authority.py:35-81` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_materials.py:182-214` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_monitor_upgrade.py:96-105` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_prepare.py:62-132` | `def reviewed` / `class reviewed` |
| `run` | `blocking_io.py:104-140` | `def run` / `class run` |
| `run` | `operator_monitor.py:383-458` | `def run` / `class run` |
| `run` | `operator_monitor_cross_runtime.py:70-72` | `def run` / `class run` |
| `run` | `operator_monitor_deploy.py:171-228` | `def run` / `class run` |
| `run` | `trae_exec_capture.py:157-222` | `def run` / `class run` |
| `run` | `wait_pane.py:242-243` | `def run` / `class run` |
| `run_preflight` | `native_preflight.py:566-766` | `def run_preflight` / `class run_preflight` |
| `runtime` | `operator_continuity_route.py:77-84` | `def runtime` / `class runtime` |
| `scope` | `observation_budget.py:123-136` | `def scope` / `class scope` |
| `scope` | `operator_continuity_route.py:57-74` | `def scope` / `class scope` |
| `scope` | `startup_cli.py:20-31` | `def scope` / `class scope` |
| `session_id` | `pi_transcript.py:31-34` | `def session_id` / `class session_id` |
| `sha` | `software_development.py:39-40` | `def sha` / `class sha` |
| `sha256` | `control_plane_readiness.py:168-174` | `def sha256` / `class sha256` |
| `snapshot` | `blocking_io.py:52-57` | `def snapshot` / `class snapshot` |
| `snapshot` | `operator_monitor_recovery.py:42-96` | `def snapshot` / `class snapshot` |
| `snapshot` | `software_development.py:225-246` | `def snapshot` / `class snapshot` |
| `source` | `coordinator_worker_profiles.py:49-51` | `def source` / `class source` |
| `source_contract` | `bootstrap_events.py:45-47` | `def source_contract` / `class source_contract` |
| `sources` | `operator_monitor_deploy.py:26-28` | `def sources` / `class sources` |
| `stage` | `blocking_io.py:75-91` | `def stage` / `class stage` |
| `stage` | `observation_budget.py:90-110` | `def stage` / `class stage` |
| `state` | `start_grant.py:188-217` | `def state` / `class state` |
| `status` | `coordinator_tui_scheduler.py:33-36` | `def status` / `class status` |
| `status` | `trae_exec_capture.py:225-235` | `def status` / `class status` |
| `stop` | `bootstrap_protocol.py:137-137` | `def stop` / `class stop` |
| `stop` | `coordinator_state.py:100-104` | `def stop` / `class stop` |
| `strict_plan` | `coordinator_strict.py:230-340` | `def strict_plan` / `class strict_plan` |
| `submit` | `bootstrap_protocol.py:116-116` | `def submit` / `class submit` |
| `submit` | `coordinator_tui_workflow.py:369-374` | `def submit` / `class submit` |
| `submitted` | `coordinator_background.py:35-39` | `def submitted` / `class submitted` |
| `text` | `bootstrap_events.py:123-124` | `def text` / `class text` |
| `text` | `coordinator_worker_plan.py:21-24` | `def text` / `class text` |
| `text` | `pi_policy.py:25-27` | `def text` / `class text` |
| `text` | `software_development.py:35-36` | `def text` / `class text` |
| `timeout` | `observation_budget.py:66-74` | `def timeout` / `class timeout` |
| `timestamp` | `coordinator_io.py:237-240` | `def timestamp` / `class timestamp` |
| `unavailable` | `operator_readiness.py:28-34` | `def unavailable` / `class unavailable` |
| `update` | `trae_exec_capture.py:62-63` | `def update` / `class update` |
| `verify_prepared` | `operator_prepare.py:247-291` | `def verify_prepared` / `class verify_prepared` |
| `version` | `bootstrap_events.py:127-131` | `def version` / `class version` |
| `wait` | `publication_wait.py:66-99` | `def wait` / `class wait` |
| `wait` | `wait_for_file.py:83-109` | `def wait` / `class wait` |

## 不要这样做

- 先 grep 名字再逐回合找：本表就是那次搜索的结果。
- 复制本表的行区间到别处：`--check` 会因区间漂移拒绝，说明代码变了，重读对应区间。
