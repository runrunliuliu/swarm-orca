# ORIENTATION（生成文件，不要手改）

由 `swarm/generate_orientation.py --write` 生成；`--check` 与代码不一致即 `exit 2`。
只放**位置**（路径 + 行区间），不放代码：代码只有一份，索引可以验证。

## 最短必读顺序

1. 本文件「入口 argv」——先知道这一步跑什么。
2. `strict-bootstrap-protocol.md` §1–§9：规范与准入（离线材料不在必读内）。
3. `operator-runbook.md`：阶段、owner、槽位。
4. 需要看实现时，用下面「符号索引」里的行区间直接读，**不要先 grep 名字**。

## 入口 argv

```bash
python3 -B <swarm>/coordinator_launch.py strict-bootstrap pull --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256> --execute
python3 -B <swarm>/coordinator_launch.py strict-bootstrap produce --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256> --execute
python3 -B <swarm>/coordinator_launch.py strict-bootstrap submit --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256> --execute
python3 -B <swarm>/coordinator_launch.py strict-bootstrap complete --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256> --execute
python3 -B <swarm>/coordinator_launch.py strict-bootstrap inspect-action --owner <owner.json> --owner-sha256 <owner-sha256> --actor <role> --intent <intent.json> --intent-sha256 <intent-sha256>
```

## 符号索引（124 个：协议文档点名的顶层定义与方法）

| 符号 | 位置 | 锚点 |
| --- | --- | --- |
| `CommitAuthority` | `bootstrap_protocol.py:121-140` | `def CommitAuthority` / `class CommitAuthority` |
| `Confirmation` | `bootstrap_protocol.py:78-84` | `def Confirmation` / `class Confirmation` |
| `ControlBinding` | `bootstrap_protocol.py:58-64` | `def ControlBinding` / `class ControlBinding` |
| `OperatorDelivery` | `bootstrap_protocol.py:99-105` | `def OperatorDelivery` / `class OperatorDelivery` |
| `OperatorScheduler` | `bootstrap_protocol.py:108-118` | `def OperatorScheduler` / `class OperatorScheduler` |
| `RequestAdmission` | `bootstrap_protocol.py:87-96` | `def RequestAdmission` / `class RequestAdmission` |
| `RoleTool` | `bootstrap_tool.py:189-815` | `def RoleTool` / `class RoleTool` |
| `_baseline_check` | `native_preflight.py:436-482` | `def _baseline_check` / `class _baseline_check` |
| `acceptance` | `startup_runtime.py:87-101` | `def acceptance` / `class acceptance` |
| `admission` | `coordinator_operator.py:116-143` | `def admission` / `class admission` |
| `admission` | `startup_handoff.py:433-473` | `def admission` / `class admission` |
| `archive` | `evidence_archive.py:40-134` | `def archive` / `class archive` |
| `arm` | `bootstrap_control.py:231-243` | `def arm` / `class arm` |
| `authority` | `startup_handoff.py:47-49` | `def authority` / `class authority` |
| `binding` | `bootstrap_events.py:93-148` | `def binding` / `class binding` |
| `bound` | `bootstrap_control.py:97-100` | `def bound` / `class bound` |
| `build_plan` | `coordinator_launch.py:88-210` | `def build_plan` / `class build_plan` |
| `build_plan` | `coordinator_worker_plan.py:94-200` | `def build_plan` / `class build_plan` |
| `build_request` | `coordinator_strict_request.py:156-188` | `def build_request` / `class build_request` |
| `build_session_contract` | `coordinator_startup.py:35-39` | `def build_session_contract` / `class build_session_contract` |
| `build_trae_plan` | `trae_coordinator.py:114-236` | `def build_trae_plan` / `class build_trae_plan` |
| `caller_result` | `coordinator_strict.py:66-84` | `def caller_result` / `class caller_result` |
| `candidate_template` | `startup_handoff.py:156-178` | `def candidate_template` / `class candidate_template` |
| `canonical` | `coordinator_io.py:28-30` | `def canonical` / `class canonical` |
| `canonical` | `coordinator_loop.py:280-283` | `def canonical` / `class canonical` |
| `check` | `blocking_io.py:60-63` | `def check` / `class check` |
| `check` | `bootstrap_identity.py:229-235` | `def check` / `class check` |
| `check` | `bootstrap_s5.py:169-173` | `def check` / `class check` |
| `check` | `coordinator_tui_continue.py:746-748` | `def check` / `class check` |
| `check` | `observation_budget.py:60-63` | `def check` / `class check` |
| `check` | `operator_authority.py:106-165` | `def check` / `class check` |
| `check` | `operator_readiness.py:70-119` | `def check` / `class check` |
| `check` | `software_development.py:249-447` | `def check` / `class check` |
| `checkpoint` | `bootstrap_s5.py:208-211` | `def checkpoint` / `class checkpoint` |
| `checkpoint` | `operator_monitor_upgrade.py:215-269` | `def checkpoint` / `class checkpoint` |
| `cli` | `operator_monitor_cross_runtime.py:152-161` | `def cli` / `class cli` |
| `cli` | `operator_monitor_recovery.py:397-406` | `def cli` / `class cli` |
| `cli` | `operator_planned_restart.py:77-83` | `def cli` / `class cli` |
| `commit_new` | `bootstrap_control.py:365-401` | `def commit_new` / `class commit_new` |
| `commit_new` | `bootstrap_control.py:901-908` | `def commit_new` / `class commit_new` |
| `commit_new` | `bootstrap_protocol.py:133-135` | `def commit_new` / `class commit_new` |
| `commit_request` | `bootstrap_admission.py:94-142` | `def commit_request` / `class commit_request` |
| `completed` | `coordinator_tui_scheduler.py:39-65` | `def completed` / `class completed` |
| `confirmation` | `bootstrap_s5.py:94-109` | `def confirmation` / `class confirmation` |
| `confirmed` | `bootstrap_admission.py:39-46` | `def confirmed` / `class confirmed` |
| `confirmed` | `bootstrap_s5.py:112-114` | `def confirmed` / `class confirmed` |
| `confirmed` | `startup_handoff.py:68-80` | `def confirmed` / `class confirmed` |
| `context` | `startup_handoff.py:83-120` | `def context` / `class context` |
| `continuation` | `operator_readiness.py:37-67` | `def continuation` / `class continuation` |
| `contract_fields` | `bootstrap_events.py:151-160` | `def contract_fields` / `class contract_fields` |
| `coordinator` | `progress_watch.py:367-370` | `def coordinator` / `class coordinator` |
| `created` | `operator_startup.py:186-227` | `def created` / `class created` |
| `current` | `coordinator_operator.py:101-113` | `def current` / `class current` |
| `current` | `operator_monitor_upgrade.py:41-65` | `def current` / `class current` |
| `digest` | `coordinator_input.py:13-14` | `def digest` / `class digest` |
| `digest` | `coordinator_io.py:33-34` | `def digest` / `class digest` |
| `digest` | `progress_watch.py:89-90` | `def digest` / `class digest` |
| `dispatch` | `bootstrap_control.py:586-673` | `def dispatch` / `class dispatch` |
| `dispatch` | `coordinator_first_dispatch.py:351-359` | `def dispatch` / `class dispatch` |
| `drain` | `bootstrap_driver.py:336-369` | `def drain` / `class drain` |
| `envelope` | `bootstrap_handoff.py:224-256` | `def envelope` / `class envelope` |
| `events` | `coordinator_background.py:157-158` | `def events` / `class events` |
| `exact` | `coordinator_worker_plan.py:27-31` | `def exact` / `class exact` |
| `exclusive` | `trae_exec_capture.py:27-28` | `def exclusive` / `class exclusive` |
| `execute` | `coordinator_driver.py:777-791` | `def execute` / `class execute` |
| `fence` | `coordinator_tui_continue.py:719-721` | `def fence` / `class fence` |
| `fence` | `operator_monitor.py:136-150` | `def fence` / `class fence` |
| `file_ref` | `coordinator_io.py:237-238` | `def file_ref` / `class file_ref` |
| `fingerprint` | `wait_for_file.py:55-66` | `def fingerprint` / `class fingerprint` |
| `freshness` | `coordinator_tui_continue.py:40-64` | `def freshness` / `class freshness` |
| `identity` | `coordinator_startup.py:55-70` | `def identity` / `class identity` |
| `idle` | `publication_wait.py:118-127` | `def idle` / `class idle` |
| `intent` | `bootstrap_driver.py:170-184` | `def intent` / `class intent` |
| `invocation` | `coordinator_prepare.py:26-48` | `def invocation` / `class invocation` |
| `layout` | `bootstrap_protocol.py:32-33` | `def layout` / `class layout` |
| `layout` | `coordinator_strict_delivery.py:29-34` | `def layout` / `class layout` |
| `live` | `coordinator_strict_start.py:194-201` | `def live` / `class live` |
| `live` | `operator_sender_correct.py:40-55` | `def live` / `class live` |
| `log` | `publication_wait.py:139-149` | `def log` / `class log` |
| `marker` | `bootstrap_driver.py:186-201` | `def marker` / `class marker` |
| `materialize_template` | `bootstrap_tool.py:561-583` | `def materialize_template` / `class materialize_template` |
| `may_replay` | `bootstrap_handoff.py:109-111` | `def may_replay` / `class may_replay` |
| `may_replay` | `bootstrap_handoff.py:131-133` | `def may_replay` / `class may_replay` |
| `mutation` | `coordinator_tui_workflow.py:44-64` | `def mutation` / `class mutation` |
| `native` | `operator_monitor.py:107-128` | `def native` / `class native` |
| `native` | `trae_coordinator.py:349-361` | `def native` / `class native` |
| `native_plan` | `coordinator_strict.py:354-420` | `def native_plan` / `class native_plan` |
| `observe` | `bootstrap_control.py:933-939` | `def observe` / `class observe` |
| `observe` | `coordinator_background.py:42-95` | `def observe` / `class observe` |
| `observe` | `coordinator_handoff.py:117-150` | `def observe` / `class observe` |
| `observe` | `operator_session.py:237-300` | `def observe` / `class observe` |
| `observe` | `pi_tui.py:173-180` | `def observe` / `class observe` |
| `observe` | `trae_coordinator.py:364-453` | `def observe` / `class observe` |
| `observe` | `trae_tui.py:184-193` | `def observe` / `class observe` |
| `observe_identity` | `operator_session.py:66-95` | `def observe_identity` / `class observe_identity` |
| `observe_write_roots` | `coordinator_write_roots.py:15-28` | `def observe_write_roots` / `class observe_write_roots` |
| `observed_coordinator` | `coordinator_strict_request.py:39-77` | `def observed_coordinator` / `class observed_coordinator` |
| `original` | `operator_continuity_deployment.py:15-23` | `def original` / `class original` |
| `original` | `operator_sender_correct.py:21-37` | `def original` / `class original` |
| `path` | `coordinator_io.py:51-56` | `def path` / `class path` |
| `peer` | `bootstrap_identity.py:77-82` | `def peer` / `class peer` |
| `plan` | `coordinator_strict_start.py:204-272` | `def plan` / `class plan` |
| `policy` | `startup_execution.py:34-51` | `def policy` / `class policy` |
| `policy` | `tui_adapter.py:60-76` | `def policy` / `class policy` |
| `prepare` | `coordinator_handoff.py:63-84` | `def prepare` / `class prepare` |
| `prepare` | `coordinator_strict_prepare.py:43-82` | `def prepare` / `class prepare` |
| `prepare` | `coordinator_tui_prepare.py:71-177` | `def prepare` / `class prepare` |
| `prepare` | `operator_archive.py:21-93` | `def prepare` / `class prepare` |
| `prepare` | `operator_monitor_cross_runtime.py:31-35` | `def prepare` / `class prepare` |
| `prepare` | `operator_monitor_deploy.py:39-91` | `def prepare` / `class prepare` |
| `prepare` | `operator_monitor_recovery.py:99-138` | `def prepare` / `class prepare` |
| `prepare` | `operator_monitor_upgrade.py:272-297` | `def prepare` / `class prepare` |
| `prepare` | `operator_prepare.py:135-211` | `def prepare` / `class prepare` |
| `prepare` | `operator_sender_correct.py:81-128` | `def prepare` / `class prepare` |
| `prepare` | `operator_startup.py:114-150` | `def prepare` / `class prepare` |
| `prepare_request` | `coordinator_request_prepare.py:104-113` | `def prepare_request` / `class prepare_request` |
| `prepare_request` | `coordinator_strict_request.py:98-143` | `def prepare_request` / `class prepare_request` |
| `prepared` | `coordinator_strict_delivery.py:139-190` | `def prepared` / `class prepared` |
| `process` | `bootstrap_identity.py:40-52` | `def process` / `class process` |
| `prompt` | `coordinator_driver.py:441-532` | `def prompt` / `class prompt` |
| `provider` | `tui_adapter.py:35-37` | `def provider` / `class provider` |
| `publication` | `bootstrap_s5.py:187-205` | `def publication` / `class publication` |
| `publication` | `operator_startup.py:230-251` | `def publication` / `class publication` |
| `publish` | `bootstrap_s5.py:182-185` | `def publish` / `class publish` |
| `publish` | `coordinator_background.py:106-127` | `def publish` / `class publish` |
| `publish` | `coordinator_snapshots.py:17-28` | `def publish` / `class publish` |
| `publish` | `coordinator_strict_start.py:287-342` | `def publish` / `class publish` |
| `publish` | `startup_handoff.py:52-65` | `def publish` / `class publish` |
| `publish_new` | `coordinator_io.py:268-286` | `def publish_new` / `class publish_new` |
| `query` | `bootstrap_control.py:292-308` | `def query` / `class query` |
| `query` | `bootstrap_control.py:887-899` | `def query` / `class query` |
| `query` | `bootstrap_protocol.py:118-118` | `def query` / `class query` |
| `query` | `bootstrap_protocol.py:131-131` | `def query` / `class query` |
| `query` | `progress_watch.py:109-151` | `def query` / `class query` |
| `read` | `bootstrap_admission.py:63-67` | `def read` / `class read` |
| `read` | `bootstrap_events.py:62-69` | `def read` / `class read` |
| `read` | `pi_policy.py:61-68` | `def read` / `class read` |
| `read` | `pi_transcript.py:37-80` | `def read` / `class read` |
| `read` | `trae_tui.py:31-32` | `def read` / `class read` |
| `reader` | `tui_adapter.py:49-57` | `def reader` / `class reader` |
| `receipt` | `operator_monitor.py:223-231` | `def receipt` / `class receipt` |
| `recheck` | `bootstrap_events.py:71-73` | `def recheck` / `class recheck` |
| `recheck` | `bootstrap_tool.py:91-93` | `def recheck` / `class recheck` |
| `recheck` | `coordinator_snapshots.py:31-34` | `def recheck` / `class recheck` |
| `reconcile` | `bootstrap_control.py:434-476` | `def reconcile` / `class reconcile` |
| `reconcile` | `bootstrap_protocol.py:139-140` | `def reconcile` / `class reconcile` |
| `reconcile` | `operator_authority.py:168-180` | `def reconcile` / `class reconcile` |
| `request` | `coordinator_strict_delivery.py:48-50` | `def request` / `class request` |
| `require_operator_context` | `coordinator_startup.py:158-162` | `def require_operator_context` / `class require_operator_context` |
| `resolve` | `coordinator_worker_profiles.py:77-136` | `def resolve` / `class resolve` |
| `resolve` | `startup_cli.py:43-57` | `def resolve` / `class resolve` |
| `review` | `bootstrap_events.py:163-195` | `def review` / `class review` |
| `review_route` | `bootstrap_protocol.py:143-172` | `def review_route` / `class review_route` |
| `reviewed` | `coordinator_strict_prepare.py:28-40` | `def reviewed` / `class reviewed` |
| `reviewed` | `coordinator_worker_profiles.py:54-64` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_authority.py:35-81` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_materials.py:182-214` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_monitor_upgrade.py:96-105` | `def reviewed` / `class reviewed` |
| `reviewed` | `operator_prepare.py:62-132` | `def reviewed` / `class reviewed` |
| `run` | `blocking_io.py:104-140` | `def run` / `class run` |
| `run` | `bootstrap_driver.py:468-474` | `def run` / `class run` |
| `run` | `operator_monitor.py:383-458` | `def run` / `class run` |
| `run` | `operator_monitor_cross_runtime.py:70-72` | `def run` / `class run` |
| `run` | `operator_monitor_deploy.py:171-228` | `def run` / `class run` |
| `run` | `operator_startup.py:315-440` | `def run` / `class run` |
| `run` | `trae_exec_capture.py:157-222` | `def run` / `class run` |
| `run` | `wait_pane.py:203-204` | `def run` / `class run` |
| `run_preflight` | `native_preflight.py:566-766` | `def run_preflight` / `class run_preflight` |
| `runtime` | `operator_continuity_route.py:77-84` | `def runtime` / `class runtime` |
| `scope` | `observation_budget.py:123-136` | `def scope` / `class scope` |
| `scope` | `operator_continuity_route.py:57-74` | `def scope` / `class scope` |
| `scope` | `startup_cli.py:20-31` | `def scope` / `class scope` |
| `send` | `bootstrap_control.py:543-547` | `def send` / `class send` |
| `session_id` | `pi_transcript.py:31-34` | `def session_id` / `class session_id` |
| `settle` | `bootstrap_control.py:478-510` | `def settle` / `class settle` |
| `sha` | `software_development.py:39-40` | `def sha` / `class sha` |
| `snapshot` | `blocking_io.py:52-57` | `def snapshot` / `class snapshot` |
| `snapshot` | `operator_monitor_recovery.py:42-96` | `def snapshot` / `class snapshot` |
| `snapshot` | `software_development.py:225-246` | `def snapshot` / `class snapshot` |
| `source` | `coordinator_worker_profiles.py:49-51` | `def source` / `class source` |
| `source_contract` | `coordinator_request_prepare.py:52-54` | `def source_contract` / `class source_contract` |
| `sources` | `operator_monitor_deploy.py:26-28` | `def sources` / `class sources` |
| `stage` | `blocking_io.py:75-91` | `def stage` / `class stage` |
| `stage` | `observation_budget.py:90-110` | `def stage` / `class stage` |
| `stated` | `bootstrap_control.py:30-38` | `def stated` / `class stated` |
| `status` | `coordinator_tui_scheduler.py:33-36` | `def status` / `class status` |
| `status` | `operator_startup.py:282-312` | `def status` / `class status` |
| `status` | `trae_exec_capture.py:225-235` | `def status` / `class status` |
| `stop` | `bootstrap_control.py:426-432` | `def stop` / `class stop` |
| `stop` | `bootstrap_control.py:925-927` | `def stop` / `class stop` |
| `stop` | `bootstrap_driver.py:91-95` | `def stop` / `class stop` |
| `stop` | `bootstrap_protocol.py:137-137` | `def stop` / `class stop` |
| `stop` | `coordinator_state.py:100-104` | `def stop` / `class stop` |
| `strict_plan` | `coordinator_strict.py:222-327` | `def strict_plan` / `class strict_plan` |
| `submission` | `bootstrap_actions.py:39-54` | `def submission` / `class submission` |
| `submission` | `bootstrap_tool.py:195-196` | `def submission` / `class submission` |
| `submit` | `bootstrap_protocol.py:116-116` | `def submit` / `class submit` |
| `submit` | `bootstrap_tool.py:585-616` | `def submit` / `class submit` |
| `submit` | `coordinator_tui_workflow.py:369-374` | `def submit` / `class submit` |
| `submitted` | `coordinator_background.py:35-39` | `def submitted` / `class submitted` |
| `task` | `startup_handoff.py:268-280` | `def task` / `class task` |
| `template` | `bootstrap_tool.py:254-267` | `def template` / `class template` |
| `text` | `bootstrap_events.py:39-40` | `def text` / `class text` |
| `text` | `coordinator_worker_plan.py:21-24` | `def text` / `class text` |
| `text` | `pi_policy.py:25-27` | `def text` / `class text` |
| `text` | `software_development.py:35-36` | `def text` / `class text` |
| `timeout` | `observation_budget.py:66-74` | `def timeout` / `class timeout` |
| `timestamp` | `coordinator_io.py:241-244` | `def timestamp` / `class timestamp` |
| `unavailable` | `operator_readiness.py:28-34` | `def unavailable` / `class unavailable` |
| `unknown` | `bootstrap_s5.py:50-54` | `def unknown` / `class unknown` |
| `update` | `trae_exec_capture.py:62-63` | `def update` / `class update` |
| `validate_candidate` | `bootstrap_tool.py:657-695` | `def validate_candidate` / `class validate_candidate` |
| `validate_request` | `coordinator_strict_delivery.py:53-122` | `def validate_request` / `class validate_request` |
| `verify_prepared` | `coordinator_request_prepare.py:192-217` | `def verify_prepared` / `class verify_prepared` |
| `verify_prepared` | `operator_prepare.py:247-291` | `def verify_prepared` / `class verify_prepared` |
| `version` | `bootstrap_events.py:43-47` | `def version` / `class version` |
| `wait` | `publication_wait.py:66-99` | `def wait` / `class wait` |
| `wait` | `wait_for_file.py:83-109` | `def wait` / `class wait` |

## 不要这样做

- 先 grep 名字再逐回合找：本表就是那次搜索的结果。
- 复制本表的行区间到别处：`--check` 会因区间漂移拒绝，说明代码变了，重读对应区间。
